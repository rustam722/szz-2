#!/usr/bin/env python3
"""
СЗЗ Прокси — НСПД edition
Запуск: python proxy.py
Порт:  8767
"""
import json
import os
import re
import sqlite3
import datetime
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode

import httpx
from pynspd import Nspd
from pynspd.schemas import (Layer36048Feature, Layer36049Feature, Layer36071Feature,
                             Layer37294Feature,
                             Layer875831Feature, Layer875838Feature, Layer879243Feature,
                             Layer37577Feature, Layer37578Feature, Layer37579Feature,
                             Layer37580Feature, Layer37581Feature)
from hishel import SQLiteStorage
import shapely.geometry
from shapely.geometry import Point as ShapelyPoint

PORT     = int(os.environ.get('PORT', 8767))
HOST     = os.environ.get('HOST', '127.0.0.1')
CACHE_DB = os.environ.get('NSPD_CACHE_DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nspd_cache.db'))

_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(CACHE_DB)), 'SZZ-Tool.log')

def _log(msg: str):
    ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f'{ts} [proxy] {msg}\n'
    print(line, end='')
    try:
        with open(_LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line)
    except Exception:
        pass

# Один общий клиент НСПД (создаётся при старте, не закрывается между запросами)
_nspd = Nspd(
    client_timeout=30,
    cache_storage=SQLiteStorage(
        connection=sqlite3.connect(CACHE_DB, check_same_thread=False),
        ttl=86400,
    ),
)

# Пул потоков для параллельных запросов к НСПД (клики, point-fallback)
_pool = ThreadPoolExecutor(max_workers=8)

# ── HTTP-клиенты с keep-alive (вместо urllib: без нового TLS на каждый тайл) ──
_http_nspd = httpx.Client(
    verify=False, timeout=15,
    limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
    headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://nspd.gov.ru/map?theme_id=1&is_copy_url=true&active_layers=&baseLayerId=',
    },
)
_http_gis = httpx.Client(
    timeout=10,
    limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
    headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://2gis.ru/',
        'Accept': 'image/webp,image/png,*/*',
    },
)

# ── Дисковый кэш тайлов (WMS НСПД + 2ГИС) ────────────────────────────────────
_TILE_DB = os.path.join(os.path.dirname(os.path.abspath(CACHE_DB)), 'tiles_cache.db')
_tile_conn = sqlite3.connect(_TILE_DB, check_same_thread=False)
_tile_conn.execute('PRAGMA journal_mode=WAL')
_tile_conn.execute('CREATE TABLE IF NOT EXISTS tiles '
                   '(key TEXT PRIMARY KEY, ct TEXT, data BLOB, ts INTEGER)')
# Автоочистка: записи старше 30 дней удаляются при старте
_tile_conn.execute('DELETE FROM tiles WHERE ts < ?', (int(time.time()) - 30*24*3600,))
_tile_conn.commit()
_tile_lock = threading.Lock()

TILE_TTL_NSPD = 6 * 3600        # 6 ч — кадастровые слои меняются
TILE_TTL_GIS  = 7 * 24 * 3600   # 7 дней — подложка стабильна

def _tile_get(key, max_age):
    """Возвращает (ct, data, fresh) или None. fresh=False — запись устарела."""
    with _tile_lock:
        row = _tile_conn.execute(
            'SELECT ct, data, ts FROM tiles WHERE key=?', (key,)).fetchone()
    if not row:
        return None
    return row[0], row[1], (time.time() - row[2] < max_age)

def _tile_put(key, ct, data):
    try:
        with _tile_lock:
            _tile_conn.execute('INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)',
                               (key, ct, data, int(time.time())))
            _tile_conn.commit()
    except Exception as e:
        _log(f'tile-cache put error: {e}')

# Доп. слои НСПД для импорта по контуру (кроме ЗУ — у него свой /pkk).
# Классы сверены напрямую через pynspd.NspdFeature.by_title(...) на реальных
# title'ах НСПД — для ЗОУИТ это 5 отдельных подслоёв сразу.
NSPD_LAYERS = {
    'kvartal':    [Layer36071Feature],
    'oks':        [Layer36049Feature],
    'pzz':        [Layer875838Feature],
    'red_line':   [Layer879243Feature],
    'settlement': [Layer875831Feature],
    'zouit':      [Layer37577Feature, Layer37578Feature, Layer37579Feature,
                   Layer37580Feature, Layer37581Feature],
}

# Маппинг статуса НСПД -> код для search.js (STATECD)
STATUS_MAP = {
    'Временный':      '1',
    'Учтённый':       '2',
    'Ранее учтённый': '3',
    'Архивный':       '4',
    'Снятый с учёта': '5',
}

def cors(handler):
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    handler.send_header('Access-Control-Allow-Headers', '*')
    handler.send_header('Access-Control-Allow-Private-Network', 'true')

def opts_to_attrs(opts):
    """Конвертирует pynspd Options в dict, совместимый с search.js"""
    d = opts.model_dump() if hasattr(opts, 'model_dump') else {}

    status_text = str(d.get('status') or '')
    statecd     = STATUS_MAP.get(status_text, '')

    area = d.get('specified_area') or d.get('area') or d.get('declared_area')

    date_raw = d.get('land_record_reg_date')
    if isinstance(date_raw, (datetime.datetime, datetime.date)):
        date_str = date_raw.strftime('%Y-%m-%d')
    elif date_raw:
        date_str = str(date_raw)[:10]
    else:
        date_str = ''

    return {
        'cn':                  d.get('cad_num') or '',
        'address':             d.get('readable_address') or '',
        'area_value':          area,
        'area_unit':           'кв. м',
        'statecd':             statecd,
        'ownership_form':      d.get('ownership_type') or '',
        'cad_cost':            d.get('cost_value'),
        'kpzu':                d.get('cost_index'),
        'date_create':         date_str,
        'category_type':       d.get('land_record_category_type') or '',
        'util_by_doc':         d.get('permitted_use_established_by_document') or '',
        'kvartal':             d.get('quarter_cad_number') or '',
        'land_record_subtype': d.get('land_record_subtype') or '',
    }

def generic_attrs(feat, layer_key):
    """Атрибуты для доп. слоёв НСПД (кварталы/ОКС/ЗОУИТ/зоны/красные линии) —
    в отличие от ЗУ, у каждого свой набор полей, поэтому не opts_to_attrs,
    а общий сбор того, что реально пришло."""
    try:
        opts = feat.properties.options.model_dump() if hasattr(feat.properties.options, 'model_dump') else {}
    except Exception:
        opts = {}
    try:
        raw = feat.properties.model_dump()
    except Exception:
        raw = {}
    merged = {**raw, **opts}
    name = (merged.get('name') or merged.get('readable_address') or merged.get('label')
            or merged.get('descr') or merged.get('cad_num') or merged.get('quarter_cad_number') or '')
    clean = {k: v for k, v in merged.items()
             if v not in (None, '', [], {}) and isinstance(v, (str, int, float, bool))}
    clean['layer'] = layer_key
    return clean, str(name)


def _normalize_coords(node):
    """НСПД изредка отдаёт точку как строку 'lon lat' вместо [lon, lat]
    (поймано на слое кварталов — разовый сбой, не воспроизвёлся повторно,
    но раз источник внешний и ненадёжный — подстраховка дешевле, чем
    сломанная геометрия на фронте). Рекурсивно проходит координаты любой
    вложенности (Point/Polygon/MultiPolygon) и чинит такие точки на лету."""
    if isinstance(node, str):
        parts = node.strip().split()
        if len(parts) == 2:
            try:
                return [float(parts[0]), float(parts[1])]
            except ValueError:
                return node
        return node
    if isinstance(node, (list, tuple)):
        return [_normalize_coords(x) for x in node]
    return node


def to_geojson(feat):
    # Сначала берём сырые координаты из pydantic — shapely может терять части MultiPolygon
    try:
        raw = feat.geometry.model_dump()
        if raw.get('type') and raw.get('coordinates') is not None:
            raw['coordinates'] = _normalize_coords(raw['coordinates'])
            return raw
    except Exception:
        pass
    try:
        return shapely.geometry.mapping(feat.geometry.to_shape())
    except Exception:
        return {}

def to_center(feat):
    try:
        c = feat.geometry.to_shape().centroid
        return {'x': c.x, 'y': c.y}
    except Exception:
        # Резервный вариант: вычислить центр из сырых координат
        try:
            raw = feat.geometry.model_dump()
            gtype  = raw.get('type', '')
            coords = raw.get('coordinates')
            if not coords:
                return {}
            if gtype == 'Point':
                return {'x': coords[0], 'y': coords[1]}
            if gtype == 'Polygon':
                ring = coords[0]
            elif gtype == 'MultiPolygon':
                ring = coords[0][0]
            else:
                return {}
            if ring:
                x = sum(p[0] for p in ring) / len(ring)
                y = sum(p[1] for p in ring) / len(ring)
                return {'x': x, 'y': y}
        except Exception:
            pass
        return {}

def _get_cn(feat):
    try:
        return feat.properties.options.model_dump().get('cad_num') or ''
    except Exception:
        return ''


def _cn_key(cn):
    """Кадастровый номер к сравнимому виду.

    НСПД пишет кварталы то с ведущими нулями, то без: 89:07:101010:5 и
    89:07:0101010:5 — один и тот же участок. Сравнивать строки напрямую нельзя,
    поэтому числовые части приводим к int.
    """
    parts = re.split(r'[:\s]+', str(cn or '').strip())
    if len(parts) < 4 or not all(p.isdigit() for p in parts[:4]):
        return str(cn or '').strip().lower()
    return ':'.join(str(int(p)) for p in parts[:4])

def _point_fallback(outer_ring, seen_cn, n_sample=8):
    """
    Поиск крупных участков через точечные запросы по периметру СЗЗ.
    Ловит участки, которые СОДЕРЖАТ границу СЗЗ (лесные фонды, землепользования).
    """
    coords = list(outer_ring.coords)
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords = coords[:-1]
    if not coords:
        return []

    # Равномерно распределённые точки вдоль внешнего кольца
    n = min(n_sample, len(coords))
    indices = [int(i * len(coords) / n) for i in range(n)]

    # Также добавляем центроид кольца — для участков, полностью охватывающих СЗЗ
    cx = sum(p[0] for p in coords) / len(coords)
    cy = sum(p[1] for p in coords) / len(coords)
    sample_pts = [(coords[i][0], coords[i][1]) for i in indices]
    sample_pts.append((cx, cy))

    def _probe(pt):
        lon, lat = pt
        try:
            return (lat, lon), (_nspd.search_at_coords(lat, lon, Layer36048Feature) or [])
        except Exception as e:
            print(f'    [point-fallback] ошибка в точке ({lat:.5f},{lon:.5f}): {type(e).__name__}: {e}')
            return (lat, lon), []

    new_feats = []
    checked_cn = set()
    # Точки опрашиваются параллельно (раньше — последовательно, ~9 круговых задержек)
    for (lat, lon), results in _pool.map(_probe, sample_pts):
        for f in results:
            cn = _get_cn(f)
            if cn and cn not in seen_cn and cn not in checked_cn:
                checked_cn.add(cn)
                new_feats.append(f)
                print(f'    [point-fallback] новый ЗУ cn={cn} в точке ({lat:.5f},{lon:.5f})')

    return new_feats


def _metric_buffer(poly_latlon, dist_m):
    """Точный буфер в метрах: WGS84 → азимутальная равнопромежуточная проекция
    (центр — центроид участка) → shapely.buffer → WGS84.
    Точность сантиметровая против ~0.3% завышения у turf на сфере."""
    from pyproj import CRS, Transformer
    from shapely.ops import transform as shp_transform

    ring = [(float(p[1]), float(p[0])) for p in poly_latlon]   # (lon, lat)
    src = shapely.geometry.Polygon(ring)
    c = src.centroid
    aeqd = CRS.from_proj4(
        f'+proj=aeqd +lat_0={c.y} +lon_0={c.x} +datum=WGS84 +units=m +no_defs')
    fwd = Transformer.from_crs('EPSG:4326', aeqd, always_xy=True)
    inv = Transformer.from_crs(aeqd, 'EPSG:4326', always_xy=True)
    src_m = shp_transform(fwd.transform, src)
    buf_m = src_m.buffer(float(dist_m), quad_segs=64)
    area  = buf_m.area
    buf   = shp_transform(inv.transform, buf_m)
    if buf.geom_type == 'MultiPolygon':
        buf = max(buf.geoms, key=lambda g: g.area)
    pts = [[y, x] for x, y in buf.exterior.coords]
    return {'poly': pts, 'area_m2': round(area, 1), 'engine': 'shapely-aeqd'}


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(fmt % args)

    def do_OPTIONS(self):
        self.send_response(204)
        cors(self)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)

        # ── /buffer  {poly:[[lat,lon],...], dist: м} ───────────────────────
        if parsed.path == '/buffer':
            try:
                length = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(length).decode('utf-8'))
                poly = body.get('poly') or []
                dist = float(body.get('dist') or 0)
                if len(poly) < 3 or dist <= 0:
                    self._json(400, {'error': 'нужны poly (>=3 точек) и dist > 0'})
                    return
                self._json(200, _metric_buffer(poly, dist))
            except Exception as e:
                _log(f'/buffer error: {e}')
                self._json(500, {'error': str(e)})
            return

        self._json(404, {'error': 'not found'})

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path

        # ── /ping ──────────────────────────────────────────────────────────
        if path == '/ping':
            self._json(200, {'ok': True, 'proxy': 'nspd'})
            return

        # ── /pkk/detail?cn=XX:XX:XXXXXXX:XX ───────────────────────────────
        if path == '/pkk/detail':
            qs = parse_qs(parsed.query)
            cn = qs.get('cn', [None])[0]
            if not cn:
                self._json(400, {'error': 'missing cn'})
                return
            try:
                feat = _nspd.find_landplot(cn)
                if not feat:
                    self._json(404, {'error': 'not found'})
                    return
                # НСПД — это поиск, а не точный запрос: на несуществующий номер
                # он спокойно отдаёт похожий или родительский объект. Раньше
                # такой ответ уходил в проект под запрошенным номером, и на
                # карте появлялись участки, которых не существует.
                got = _get_cn(feat)
                if _cn_key(got) != _cn_key(cn):
                    _log(f'detail [{cn}]: НСПД вернул другой номер {got!r} — считаем не найденным')
                    self._json(404, {'error': 'not found', 'requested': cn, 'got': got})
                    return
                attrs = opts_to_attrs(feat.properties.options)
                try:
                    vri_list = _nspd.tab_permission_type(feat) or []
                except Exception:
                    vri_list = []
                geom   = to_geojson(feat)
                center = to_center(feat)

                # Функциональная зона (Генплан) по координатам центроида
                zone = ''
                try:
                    if center.get('y') and center.get('x'):
                        tz_list = _nspd.search_at_coords(
                            center['y'], center['x'], Layer37294Feature
                        ) or []
                        if tz_list:
                            tz   = tz_list[0]
                            opts = (tz.properties.options.model_dump()
                                    if hasattr(tz.properties.options, 'model_dump') else {})
                            zone = (opts.get('name_zone') or opts.get('type_zone')
                                    or opts.get('zone_proya') or opts.get('process_ty_title')
                                    or getattr(tz.properties, 'label', None)
                                    or getattr(tz.properties, 'descr', None) or '')
                except Exception as ez:
                    _log(f'zone [{cn}] error: {type(ez).__name__}: {ez}')

                _log(f'detail [{cn}]: statecd={attrs["statecd"]} '
                     f'cost={attrs["cad_cost"]} vri={len(vri_list)} zone={zone!r}')
                self._json(200, {'attrs': attrs, 'vri_list': vri_list,
                                 'geometry': geom, 'center': center, 'zone': zone})
            except Exception as e:
                print(f'  /pkk/detail error: {type(e).__name__}: {e}')
                self._json(500, {'error': str(e)})
            return

        # ── /pkk?sq=<GeoJSON polygon> ──────────────────────────────────────
        if path == '/pkk':
            qs  = parse_qs(parsed.query)
            sq  = qs.get('sq', [None])[0]
            if not sq:
                self._json(400, {'error': 'missing sq'})
                return
            try:
                polygon = shapely.geometry.shape(json.loads(sq))

                # Шаг 1: контурный поиск по фактическому полигону + минимальный буфер
                outer = (shapely.geometry.Polygon(polygon.exterior.coords)
                         if hasattr(polygon, 'exterior') else polygon)
                bbox_poly = outer.buffer(0.001)  # ~100 м — только для граничных ЗУ
                all_feats = list(_nspd.search_in_contour_iter(
                    bbox_poly, Layer36048Feature, only_intersects=True
                ))
                print(f'  /pkk pynspd вернул {len(all_feats)} объектов (до фильтрации)')

                # Шаг 2: ручная фильтрация по исходному полигону (с дыркой!)
                # + допуск ~100 м на внешнем кольце для граничных участков НСПД.
                if hasattr(polygon, 'exterior'):
                    outer_tol = shapely.geometry.Polygon(
                        polygon.exterior.coords
                    ).buffer(0.001)
                    holes = [list(i.coords) for i in polygon.interiors]
                    filter_poly = (shapely.geometry.Polygon(
                        outer_tol.exterior.coords, holes
                    ) if holes else outer_tol)
                else:
                    filter_poly = polygon.buffer(0.001)

                seen_cn = set()
                feats = []
                skipped_no_intersect = 0
                bad_geom_cns = []
                for f in all_feats:
                    cn = _get_cn(f)
                    if cn and cn in seen_cn:
                        continue
                    passed_filter = False
                    try:
                        shape = f.geometry.to_shape()
                        c = shape.centroid
                        # Проверяем: координаты похожи на WGS84 (градусы)?
                        if not (-180 <= c.x <= 180 and -90 <= c.y <= 90):
                            bad_geom_cns.append(f'{cn}(centroid={c.x:.0f},{c.y:.0f})')
                        if filter_poly.intersects(shape):
                            passed_filter = True
                        else:
                            skipped_no_intersect += 1
                            continue
                    except Exception:
                        passed_filter = True  # геометрия не разобрана — включаем
                    seen_cn.add(cn)
                    feats.append(f)

                print(f'  /pkk после контурного фильтра: {len(feats)} ЗУ '
                      f'(отброшено {skipped_no_intersect} вне СЗЗ)')
                if bad_geom_cns:
                    print(f'  /pkk ВНИМАНИЕ — неправильные координаты (не WGS84): '
                          f'{", ".join(bad_geom_cns[:10])}')
                # Первые к/н для диагностики
                all_cns_sorted = sorted(seen_cn)
                shown = ', '.join(all_cns_sorted[:30])
                tail  = f' ... (ещё {len(all_cns_sorted)-30})' if len(all_cns_sorted) > 30 else ''
                print(f'  /pkk найденные к/н: {shown}{tail}')

                # Шаг 3: точечный fallback — ловим крупные участки (лесной фонд,
                # землепользования), которые ОХВАТЫВАЮТ СЗЗ и могут не попасть
                # в контурный поиск из-за особенностей API НСПД.
                fb_ring = outer.exterior if hasattr(outer, 'exterior') else None
                if fb_ring is not None:
                    fb_feats = _point_fallback(fb_ring, seen_cn, n_sample=8)
                    # Проверяем, пересекают ли fallback-участки filter_poly
                    added = 0
                    for f in fb_feats:
                        cn = _get_cn(f)
                        try:
                            if not filter_poly.intersects(f.geometry.to_shape()):
                                continue
                        except Exception:
                            pass
                        seen_cn.add(cn)
                        feats.append(f)
                        added += 1
                    if added:
                        print(f'  /pkk point-fallback добавил {added} новых ЗУ')

                out = []
                empty_geom_cns = []
                for f in feats:
                    g = to_geojson(f)
                    c = to_center(f)
                    cn = _get_cn(f)
                    if not g.get('type') or not c.get('x'):
                        empty_geom_cns.append(cn)
                    out.append({'attrs': opts_to_attrs(f.properties.options),
                                'geometry': g, 'center': c})
                if empty_geom_cns:
                    print(f'  /pkk ВНИМАНИЕ — пустая геометрия/центр у: '
                          f'{", ".join(empty_geom_cns[:10])}')
                print(f'  /pkk -> итого features={len(out)}')
                self._json(200, {'features': out})
            except Exception as e:
                print(f'  /pkk error: {type(e).__name__}: {e}')
                self._json(500, {'error': str(e)})
            return

        # ── /settlements?sq=<GeoJSON polygon> ─────────────────────────────
        if path == '/settlements':
            qs  = parse_qs(parsed.query)
            sq  = qs.get('sq', [None])[0]
            if not sq:
                self._json(400, {'error': 'missing sq'})
                return
            try:
                polygon = shapely.geometry.shape(json.loads(sq))
                # Буфер ~1000 м — ловим граничащие НП
                search_poly = polygon.buffer(0.009)
                feats = list(_nspd.search_in_contour_iter(
                    search_poly, Layer875831Feature, only_intersects=True
                ))
                _log(f'/settlements pynspd вернул {len(feats)} НП')
                out = []
                seen = set()
                for f in feats:
                    try:
                        label   = getattr(f.properties, 'label', None) or ''
                        descr   = getattr(f.properties, 'descr', None) or ''
                        brd_nmb = ''
                        try:
                            opts    = f.properties.options.model_dump()
                            brd_nmb = opts.get('brd_nmb') or ''
                        except Exception:
                            pass
                        name = label or descr or brd_nmb or 'Населённый пункт'
                        c = to_center(f)
                        # Дедупликация по имени + округлённым координатам (~10 км точность).
                        # Два одноимённых НП в 60 км будут разными ключами.
                        dedup_key = (name, round(c.get('y', 0), 1), round(c.get('x', 0), 1))
                        if dedup_key in seen:
                            continue
                        seen.add(dedup_key)
                        g = to_geojson(f)
                        out.append({'name': name, 'brd_nmb': brd_nmb, 'geometry': g, 'center': c})
                    except Exception as e:
                        _log(f'/settlements item error: {type(e).__name__}: {e}')
                _log(f'/settlements -> {len(out)} уникальных НП')
                self._json(200, {'features': out})
            except Exception as e:
                _log(f'/settlements error: {type(e).__name__}: {e}')
                self._json(500, {'error': str(e)})
            return

        # ── /nspd-layer?sq=<GeoJSON>&layer=kvartal|oks|zouit|pzz|red_line|settlement ──
        # Импорт доп. слоёв НСПД по контуру — тот же общий клиент/кэш _nspd,
        # что и у /pkk, просто другой класс(ы) схемы pynspd на выходе.
        if path == '/nspd-layer':
            qs = parse_qs(parsed.query)
            sq = qs.get('sq', [None])[0]
            layer_key = (qs.get('layer', [''])[0] or '').strip()
            if not sq:
                self._json(400, {'error': 'missing sq'}); return
            classes = NSPD_LAYERS.get(layer_key)
            if not classes:
                self._json(400, {'error': f'unknown layer: {layer_key}'}); return
            try:
                polygon = shapely.geometry.shape(json.loads(sq))
                search_poly = polygon.buffer(0.001)  # тот же допуск ~100 м, что у /pkk
                seen = set()
                out = []
                for cls in classes:
                    try:
                        feats = list(_nspd.search_in_contour_iter(
                            search_poly, cls, only_intersects=True))
                    except Exception as e:
                        _log(f'/nspd-layer({layer_key}) {cls.__name__} error: {type(e).__name__}: {e}')
                        continue
                    for f in feats:
                        g = to_geojson(f)
                        if not g.get('type'):
                            continue
                        c = to_center(f)
                        attrs, name = generic_attrs(f, layer_key)
                        key = (name, round(c.get('x', 0), 6), round(c.get('y', 0), 6))
                        if key in seen:
                            continue
                        seen.add(key)
                        out.append({'name': name or layer_key, 'attrs': attrs,
                                     'geometry': g, 'center': c})
                _log(f'/nspd-layer layer={layer_key} -> {len(out)} объектов')
                self._json(200, {'features': out})
            except Exception as e:
                _log(f'/nspd-layer error: {type(e).__name__}: {e}')
                self._json(500, {'error': str(e)})
            return

        # ── /nspd-click?lids=&lat=&lon= — универсальный клик по слоям ──────────
        # lids — список слоёв через запятую (опрашиваются ПАРАЛЛЕЛЬНО,
        # возвращается первый найденный по порядку приоритета).
        # Старый параметр lid= поддерживается для совместимости.
        if path == '/nspd-click':
            _NSPD_CLS = {
                '36048':  Layer36048Feature,
                '36049':  Layer36049Feature,
                '36071':  Layer36071Feature,
                '37294':  Layer37294Feature,
                '875831': Layer875831Feature,
                '875838': Layer875838Feature,
                '879243': Layer879243Feature,
                '37577':  Layer37577Feature,
                '37578':  Layer37578Feature,
                '37579':  Layer37579Feature,
                '37580':  Layer37580Feature,
                '37581':  Layer37581Feature,
            }
            qs = parse_qs(parsed.query)
            try:
                lat = float(qs['lat'][0]); lon = float(qs['lon'][0])
                lids_raw = qs.get('lids', qs.get('lid', ['36048']))[0]
                lids = [l.strip() for l in lids_raw.split(',') if l.strip() in _NSPD_CLS]
            except Exception:
                self._json(400, {'error': 'bad params'}); return
            if not lids:
                self._json(200, {'found': False}); return

            def _click_layer(lid):
                try:
                    return _nspd.search_at_coords(lat, lon, _NSPD_CLS[lid]) or []
                except Exception as e:
                    _log(f'/nspd-click({lid}) error: {type(e).__name__}: {e}')
                    return []

            lid = lids[0]
            try:
                t0 = time.time()
                all_results = list(_pool.map(_click_layer, lids))
                lid, results = next(
                    ((l, r) for l, r in zip(lids, all_results) if r), (lids[0], []))
                _log(f'/nspd-click lids={",".join(lids)} -> {lid if results else "не найдено"} '
                     f'за {time.time()-t0:.2f}с')
                if not results:
                    self._json(200, {'found': False}); return
                f    = results[0]
                geom = to_geojson(f)
                # Для ЗУ используем готовый форматтер
                if lid == '36048':
                    attrs = opts_to_attrs(f.properties.options)
                    cn    = _get_cn(f)
                    self._json(200, {'found': True, 'lid': lid, 'cn': cn, 'attrs': attrs, 'geometry': geom}); return
                # Для остальных — generic model_dump
                try:
                    raw = f.properties.model_dump()
                except Exception:
                    raw = {}
                try:
                    opts = f.properties.options.model_dump() if hasattr(f.properties, 'options') else {}
                except Exception:
                    opts = {}
                merged = {**raw, **opts}
                clean  = {k: v for k, v in merged.items()
                          if v not in (None, '', [], {}) and isinstance(v, (str, int, float, bool))}
                # Функциональные зоны (37294): name_zone — главное поле
                name_zone = merged.get('name_zone') or ''
                utiliz    = merged.get('utilization') or ''
                if name_zone:
                    clean['name_zone'] = name_zone
                if utiliz:
                    clean['utilization'] = utiliz
                name   = (name_zone or clean.pop('name', '') or clean.pop('zone_name', '') or
                          clean.pop('full_name', '') or clean.pop('obj_name', '') or
                          clean.pop('label', '') or clean.pop('descr', '') or '')
                label  = merged.get('label') or ''
                descr  = merged.get('descr') or ''
                if label and label not in name:
                    clean['zone_code']  = label
                if descr and descr not in name:
                    clean['zone_descr'] = descr
                cat_name = merged.get('category_name') or ''
                if cat_name:
                    clean['category_name'] = cat_name
                self._json(200, {'found': True, 'lid': lid, 'name': name or label or descr, 'attrs': clean, 'geometry': geom})
            except Exception as e:
                _log(f'/nspd-click({lid}) error: {type(e).__name__}: {e}')
                self._json(500, {'error': str(e)})
            return

        # ── /cad-click?lat=&lon= — информация об участке по координатам ─────────
        if path == '/cad-click':
            qs = parse_qs(parsed.query)
            try:
                lat = float(qs['lat'][0]); lon = float(qs['lon'][0])
            except Exception:
                self._json(400, {'error': 'bad coords'}); return
            try:
                results = _nspd.search_at_coords(lat, lon, Layer36048Feature)
                if not results:
                    self._json(200, {'found': False}); return
                f    = results[0]
                cn   = _get_cn(f)
                geom = to_geojson(f)
                attrs = opts_to_attrs(f.properties.options)
                self._json(200, {'found': True, 'cn': cn, 'attrs': attrs, 'geometry': geom})
            except Exception as e:
                _log(f'/cad-click error: {type(e).__name__}: {e}')
                self._json(500, {'error': str(e)})
            return

        # ── /gis2/{z}/{x}/{y} — прокси тайлов 2ГИС гибрид ──────────────────────
        if path.startswith('/gis2/'):
            parts = path.strip('/').split('/')  # ['gis2', z, x, y]
            if len(parts) == 4:
                _, z, x, y = parts
                sub = str(int(x) % 4)
                # layerType=hybrid больше не поддерживается 2ГИС (API отвечает 400,
                # «supported only layerTypes 'normal' and 'nc'») — используем normal
                tile_url = (f'https://tile{sub}.maps.2gis.com/tiles'
                            f'?x={x}&y={y}&z={z}&v=1.5&layerType=normal&lang=ru')
                self._serve_tile(f'gis2:{z}/{x}/{y}', tile_url,
                                 _http_gis, TILE_TTL_GIS)
            else:
                self.send_response(400); self.end_headers()
            return

        # ── /nspd-wms и /cad-wms* — универсальный WMS-прокси НСПД ─────────────
        if path in ('/nspd-wms', '/cad-wms', '/cad-wms-fi'):
            qs_params = parse_qs(parsed.query)
            if path in ('/cad-wms', '/cad-wms-fi'):
                lid = '36048'
            else:
                lid = (qs_params.get('LAYERS') or qs_params.get('layers') or ['36048'])[0]
            nspd_url = f'https://nspd.gov.ru/api/aeggis/v3/{lid}/wms?{parsed.query}'
            # Ключ кэша — lid + нормализованные (отсортированные) параметры запроса
            norm = urlencode(sorted((k.lower(), v[0]) for k, v in qs_params.items()))
            self._serve_tile(f'wms:{lid}:{norm}', nspd_url,
                             _http_nspd, TILE_TTL_NSPD)
            return

        # ── /cad-viewport?south=&west=&north=&east= ────────────────────────────
        if path == '/cad-viewport':
            qs = parse_qs(parsed.query)
            try:
                south = float(qs['south'][0]); west  = float(qs['west'][0])
                north = float(qs['north'][0]); east  = float(qs['east'][0])
            except Exception:
                self._json(400, {'error': 'bad bbox'}); return
            # Слишком большая область — не запрашиваем
            if (north - south) > 0.04 or (east - west) > 0.06:
                self._json(200, {'type': 'FeatureCollection', 'features': [], 'tooLarge': True})
                return
            try:
                viewport_poly = shapely.geometry.box(west, south, east, north)
                feats = list(_nspd.search_in_contour_iter(
                    viewport_poly, Layer36048Feature, only_intersects=True
                ))
                features = []
                for f in feats:
                    try:
                        g  = to_geojson(f)
                        cn = _get_cn(f)
                        if g.get('type'):
                            features.append({'type': 'Feature', 'geometry': g,
                                             'properties': {'cn': cn}})
                    except Exception:
                        pass
                _log(f'/cad-viewport bbox={south:.4f},{west:.4f},{north:.4f},{east:.4f} -> {len(features)} ЗУ')
                self._json(200, {'type': 'FeatureCollection', 'features': features})
            except Exception as e:
                _log(f'/cad-viewport error: {type(e).__name__}: {e}')
                self._json(500, {'error': str(e)})
            return

        self._json(404, {'error': 'not found'})

    def _serve_tile(self, key, url, client, ttl):
        """Отдаёт тайл: свежий кэш → сеть (с сохранением) → устаревший кэш → 204."""
        cached = _tile_get(key, ttl)
        if cached and cached[2]:                      # свежий кэш — мгновенно
            self._tile_response(cached[0], cached[1], from_cache=True)
            return
        try:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.content
            ct   = resp.headers.get('Content-Type', 'image/png')
            # Не кэшируем XML-ошибки WMS (ServiceException приходит с кодом 200)
            if data and 'xml' not in ct.lower():
                _tile_put(key, ct, data)
            self._tile_response(ct, data)
            return
        except Exception as e:
            _log(f'tile error [{key.split(":")[0]}]: {type(e).__name__}: {e}')
        if cached:                                    # сеть упала — отдаём устаревший
            self._tile_response(cached[0], cached[1], from_cache=True)
        else:
            self.send_response(204)
            self.end_headers()

    def _tile_response(self, ct, data, from_cache=False):
        try:
            self.send_response(200)
            self.send_header('Content-Type', ct)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=21600')
            self.send_header('X-Tile-Cache', 'hit' if from_cache else 'miss')
            self.end_headers()
            self.wfile.write(data)
        except (ConnectionAbortedError, BrokenPipeError):
            pass  # клиент ушёл с карты — тайл больше не нужен

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False, default=str).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        cors(self)
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    server = ThreadingHTTPServer((HOST, PORT), ProxyHandler)
    print(f'СЗЗ Прокси (НСПД) запущен: http://{HOST}:{PORT}')
    print(f'Кэш SQLite: {CACHE_DB}')
    print('Ctrl+C для остановки')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nОстановлен.')
        server.shutdown()
