// ═══════════════════════════════════════════════
// SOURCES.JS — Источники выбросов и шума
// Стиль Интеграл / Эколог-ГИС
// ═══════════════════════════════════════════════
'use strict';

// ── Состояние ────────────────────────────────────────────────────────────────
let _sources = [];
let _srcLayerGroup     = null;   // для временных элементов рисования линии
const _srcLayerGroups  = { emission: null, noise: null, other: null };
const _calloutLayerGroups = { emission: null, noise: null, other: null }; // выноски по типу
let _srcEditId     = null;     // id редактируемого источника (null = новый)
let _srcCounter    = 0;        // счётчик автонумерации

// Режим выбора точки с карты
let _pickCallback  = null;

// Режим рисования линии на карте
let _lineDrawActive   = false;
let _lineDrawPts      = [];    // [[lat,lon],...]
let _lineDrawMarkers  = [];
let _lineDrawPolyline = null;

// Точки линейного источника в форме
let _formLinePoints = [[0,0],[0,0]];

// ── Константы ────────────────────────────────────────────────────────────────
const SRC_COLORS = { emission: '#ef4444', noise: '#f59e0b', other: '#6b7280' };
const SRC_TYPE_ICON = { emission: '◉', noise: '◎', other: '○' };

// ── Инициализация / сохранение ────────────────────────────────────────────────
function _srcGroupOf(s) {
  const t = s.type || 'emission';
  return _srcLayerGroups[t] || _srcLayerGroups.emission;
}

function _initSources() {
  if (!_srcLayerGroup)              _srcLayerGroup              = L.layerGroup().addTo(map);
  if (!_srcLayerGroups.emission)    _srcLayerGroups.emission    = L.layerGroup().addTo(map);
  if (!_srcLayerGroups.noise)       _srcLayerGroups.noise       = L.layerGroup().addTo(map);
  if (!_srcLayerGroups.other)       _srcLayerGroups.other       = L.layerGroup().addTo(map);
  if (!_calloutLayerGroups.emission) _calloutLayerGroups.emission = L.layerGroup().addTo(map);
  if (!_calloutLayerGroups.noise)    _calloutLayerGroups.noise    = L.layerGroup().addTo(map);
  if (!_calloutLayerGroups.other)    _calloutLayerGroups.other    = L.layerGroup().addTo(map);
}

// Миграция старого формата (lat2/lon2/lat3/lon3) → points[] + callout style defaults
function _migrateSource(s) {
  // Перенос старых полей стиля выноски в новые callout-специфичные
  // Тёмный текст с белой обводкой читается и на схеме, и на спутнике;
  // белый по умолчанию был не виден на светлой подложке
  if (!s.calloutColor)       s.calloutColor       = s.labelColor || '#111827';
  if (!s.calloutFontSize)    s.calloutFontSize     = s.labelSize  || 12;
  if (!s.calloutLineWidth)   s.calloutLineWidth    = s.labelLineWidth || 1.5;
  if (!s.calloutStrokeColor) s.calloutStrokeColor  = '#ffffff';
  if (s.calloutStrokeWidth == null) s.calloutStrokeWidth = 2;
  if (!s.fillPattern) s.fillPattern = 'solid';

  if (s.geomType === 'area') {
    // Всегда пересчитываем полигон из lat/lon/radius, чтобы не тащить устаревшие координаты из localStorage
    if (s.lat != null && s.lon != null && s.radius != null) {
      const MIN_HW = 0.5;          // минимум 1×1 м — не перекрываются близкие источники
      const hw   = Math.max(s.radius / 2, MIN_HW);
      const dlat = hw / 111320;
      const dlon = hw / (111320 * Math.cos(s.lat * Math.PI / 180));
      s.polygon = [
        [s.lat - dlat, s.lon - dlon],
        [s.lat - dlat, s.lon + dlon],
        [s.lat + dlat, s.lon + dlon],
        [s.lat + dlat, s.lon - dlon],
      ];
    }
    return s;
  }
  if (s.points) return s;
  const pts = [[s.lat, s.lon]];
  if (s.lat2 != null && s.lon2 != null) pts.push([s.lat2, s.lon2]);
  if (s.lat3 != null && s.lon3 != null) pts.push([s.lat3, s.lon3]);
  return {
    id: s.id,
    num: s.num || 0,
    name: s.name,
    type: s.type || 'emission',
    geomType: pts.length > 1 ? 'line' : 'point',
    lat: s.lat, lon: s.lon,
    points: pts,
    radius: s.radius || 0,
    color: s.color || SRC_COLORS[s.type] || '#6b7280',
    showLabel: s.showLabel || false,
    calloutColor:       s.calloutColor       || s.labelColor || '#ffffff',
    calloutFontSize:    s.calloutFontSize     || s.labelSize  || 12,
    calloutLineWidth:   s.calloutLineWidth    || s.labelLineWidth || 1.5,
    calloutStrokeColor: s.calloutStrokeColor  || '#ffffff',
    calloutStrokeWidth: s.calloutStrokeWidth  != null ? s.calloutStrokeWidth : 2,
    fillPattern:        s.fillPattern         || 'solid',
  };
}

// Источники хранятся в проекте/автосохранении (_srcGetData). Копия в
// localStorage нигде не читалась, а писалась синхронно — 1,4 МБ JSON на
// каждый сдвиг или переключение выноски в большом проекте.
function _saveSources() {
  if (typeof markDirty === 'function') markDirty();
}
try { localStorage.removeItem('szztool_sources'); } catch (e) {}

// ── Геометрия: плоский буфер вдоль ломаной ────────────────────────────────────
// coords: [[lon,lat],...] — в порядке turf
function _flatBuffer(coords, halfWidthKm) {
  const n = coords.length;
  if (n < 2) return null;
  const leftPts = [], rightPts = [];
  for (let i = 0; i < n; i++) {
    let leftDir;
    if (i === 0) {
      leftDir = (turf.bearing(coords[0], coords[1]) + 90 + 360) % 360;
    } else if (i === n - 1) {
      leftDir = (turf.bearing(coords[n-2], coords[n-1]) + 90 + 360) % 360;
    } else {
      const l1 = (turf.bearing(coords[i-1], coords[i]) + 90 + 360) % 360;
      const l2 = (turf.bearing(coords[i],   coords[i+1]) + 90 + 360) % 360;
      let diff = l2 - l1;
      if (diff >  180) diff -= 360;
      if (diff < -180) diff += 360;
      leftDir = (l1 + diff / 2 + 360) % 360;
    }
    const rightDir = (leftDir + 180) % 360;
    leftPts.push(turf.destination(coords[i], halfWidthKm, leftDir,  { units: 'kilometers' }).geometry.coordinates);
    rightPts.push(turf.destination(coords[i], halfWidthKm, rightDir, { units: 'kilometers' }).geometry.coordinates);
  }
  return turf.polygon([[...leftPts, ...rightPts.reverse(), leftPts[0]]]);
}

// ── Иконки ────────────────────────────────────────────────────────────────────
function _makeNumberedIcon(num, color) {
  const bg = color || '#6b7280';
  return L.divIcon({
    html: `<div style="width:24px;height:24px;border-radius:50%;background:${bg};border:2.5px solid rgba(255,255,255,.95);box-shadow:0 2px 6px rgba(0,0,0,.65);cursor:pointer"></div>`,
    className: '', iconSize: [24, 24], iconAnchor: [12, 12],
  });
}

function _makeSmallHandle(color) {
  return L.divIcon({
    html: `<div style="width:10px;height:10px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:grab"></div>`,
    className: '', iconSize: [10, 10], iconAnchor: [5, 5],
  });
}

// ── SVG-паттерны заливки ──────────────────────────────────────────────────────
function _ensureSvgPattern(svgEl, color, patternType) {
  const safeColor = color.replace('#', '');
  const id = `szz-pat-${patternType}-${safeColor}`;
  if (svgEl.querySelector(`[id="${id}"]`)) return id;
  let defs = svgEl.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svgEl.insertBefore(defs, svgEl.firstChild);
  }
  const ns = 'http://www.w3.org/2000/svg';
  const pat = document.createElementNS(ns, 'pattern');
  pat.setAttribute('id', id);
  pat.setAttribute('patternUnits', 'userSpaceOnUse');
  pat.setAttribute('width', '8');
  pat.setAttribute('height', '8');
  const mkLine = (x1, y1, x2, y2) => {
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', color);
    l.setAttribute('stroke-width', '1.5');
    l.setAttribute('stroke-linecap', 'square');
    pat.appendChild(l);
  };
  if (patternType === 'hatch-l') {
    mkLine(0, 0, 8, 8);   // \ диагональ — тайлится автоматически
  } else if (patternType === 'hatch-r') {
    mkLine(8, 0, 0, 8);   // / диагональ — тайлится автоматически
  } else if (patternType === 'grid') {
    mkLine(0, 4, 8, 4);   // горизонталь
    mkLine(4, 0, 4, 8);   // вертикаль
  }
  defs.appendChild(pat);
  return id;
}

function _applyFillPattern(leafletLayer, color, fillPattern) {
  if (!fillPattern || fillPattern === 'solid') return;
  const applyToPath = (path) => {
    if (!path) return;
    const svgEl = path.ownerSVGElement;
    if (!svgEl) return;
    const patId = _ensureSvgPattern(svgEl, color, fillPattern);
    path.setAttribute('fill', `url(#${patId})`);
  };
  const apply = () => {
    if (leafletLayer._path) {
      applyToPath(leafletLayer._path);
    } else if (typeof leafletLayer.getLayers === 'function') {
      leafletLayer.getLayers().forEach(sub => { if (sub._path) applyToPath(sub._path); });
    }
  };
  apply();
  requestAnimationFrame(apply);
}

window.srcSetFillPattern = (pattern) => {
  const el = document.getElementById('src-fill-pattern');
  if (el) el.value = pattern;
  ['solid', 'hatch-l', 'hatch-r', 'grid'].forEach(p => {
    const btn = document.getElementById('src-fpat-' + p);
    if (!btn) return;
    btn.style.borderColor = '';
    btn.style.color       = '';
    btn.style.background  = '';
    btn.classList.toggle('active', p === pattern);
  });
};
window._ensureSvgPattern = _ensureSvgPattern;
window._applyFillPattern = _applyFillPattern;

// ── Отрисовка источника ────────────────────────────────────────────────────────
function _drawSource(s) {
  if (s.hidden) return;             // скрыт через ПКМ-меню выделения — не рисуем вовсе
  const _grp = _srcGroupOf(s);
  if (!_grp) return;
  const color = s.color || SRC_COLORS[s.type] || '#6b7280';
  const layers = [];
  const fillPattern = s.fillPattern || 'solid';
  const defaultFillOp = fillPattern === 'solid' ? 0.15 : 0.65;
  const fillOp = (s.fillOpacity != null) ? s.fillOpacity : defaultFillOp;
  const weight = s.weight ?? 2;
  const bSt = { color, fillColor: color, fillOpacity: fillOp, weight };

  const _openEdit = e => { L.DomEvent.stop(e); _srcEditId = s.id; openSourcesModal(); };

  const _openCtx = e => { L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e); srcContextMenu(e.originalEvent, s.id); };

  if (s.geomType === 'line' && s.points && s.points.length >= 2) {
    // turfCoords: [[lon,lat],...]
    const turfCoords = s.points.map(p => [p[1], p[0]]);
    // Буфер по формуле Эколог-ГИС: buffer(line, Width/2, flat, miter)
    // halfWidth = Width/2; минимум 2 м полуширины для видимости при Width=0
    const MIN_LINE_HW = 2;
    const lineHw = Math.max(s.radius / 2, MIN_LINE_HW);
    try {
      const buf = L.geoJSON(_flatBuffer(turfCoords, lineHw / 1000), { style: bSt }).addTo(_grp).on('click', _openEdit).on('contextmenu', _openCtx);
      _applyFillPattern(buf, color, fillPattern);
      layers.push(buf);
    } catch(e) {
      layers.push(L.polyline(s.points, { color, weight: 2, opacity: 0.85 }).addTo(_grp).on('click', _openEdit).on('contextmenu', _openCtx));
    }
  } else if (s.geomType === 'area' && s.polygon && s.polygon.length >= 3) {
    // Площадной (квадратный) источник
    const pl = L.polygon(s.polygon, bSt).addTo(_grp).on('click', _openEdit).on('contextmenu', _openCtx);
    _applyFillPattern(pl, color, fillPattern);
    layers.push(pl);
  } else {
    if (s.radius > 0) {
      const cl = L.circle([s.lat, s.lon], {
        radius: s.radius, color, fillColor: color, fillOpacity: fillOp, weight: 2,
      }).addTo(_grp).on('click', _openEdit).on('contextmenu', _openCtx);
      _applyFillPattern(cl, color, fillPattern);
      layers.push(cl);
    }
  }

  if (s.showLabel) {
    layers.push(..._makeCalloutLayers(s, _calloutLayerGroups[s.type || 'emission'] || _calloutLayerGroups.emission, true));
  }
  s.layers = layers;
}

function _addDragHandle(s, latlng, ptIdx) {
  const color = s.color || '#6b7280';
  const icon = ptIdx === 0
    ? _makeNumberedIcon(s.num || '?', color)
    : _makeSmallHandle(color);

  const handle = L.marker(latlng, { draggable: true, zIndexOffset: 900, icon });

  handle.on('dragend', e => {
    const ll = e.target.getLatLng();
    if (s.geomType === 'line' && s.points) {
      s.points[ptIdx] = [ll.lat, ll.lng];
    }
    if (ptIdx === 0) { s.lat = ll.lat; s.lon = ll.lng; }
    _clearSourceLayers(s);
    _drawSource(s);
    _saveSources();
  });

  // Клик на главный маркер → открыть редактирование
  handle.on('click', e => {
    L.DomEvent.stop(e);
    _srcEditId = s.id;
    openSourcesModal();
  });

  handle.addTo(_srcLayerGroup);
  return handle;
}

// ── Якорная точка источника (для выноски) ─────────────────────────────────────
function _srcAnchor(s) {
  if (s.geomType === 'line' && s.points && s.points.length >= 2) {
    const n = s.points.length;
    const mid = Math.floor((n - 1) / 2);
    const p1 = s.points[mid], p2 = s.points[Math.min(mid + 1, n - 1)];
    return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  }
  if (s.geomType === 'area' && s.polygon && s.polygon.length >= 3) {
    return [
      s.polygon.reduce((a, p) => a + p[0], 0) / s.polygon.length,
      s.polygon.reduce((a, p) => a + p[1], 0) / s.polygon.length,
    ];
  }
  return [s.lat, s.lon];
}

// Инициализировать позицию выноски если не задана
function _initCalloutPos(s) {
  if (isFinite(s.calloutLat) && isFinite(s.calloutLon)) return;
  const a = _srcAnchor(s) || [];
  const alat = a[0], alon = a[1];
  // Без внятного якоря позицию не выдумываем: пусть лучше выноски не будет,
  // чем Leaflet свалится на NaN и оставит куски разметки висеть на карте
  if (!isFinite(alat) || !isFinite(alon)) { s.calloutLat = null; s.calloutLon = null; return; }
  // Золотой угол (137.508°) — равномерно распределяет направления выносок
  // без кластеризации, что резко снижает начальные перекрытия
  const angle = ((s.num || 0) * 137.508) % 360;
  const dist  = 0.0008;
  s.calloutLat = alat + dist * Math.cos(angle * Math.PI / 180);
  s.calloutLon = alon + dist * Math.sin(angle * Math.PI / 180);
}

// ── Общий SVG-контейнер и единый обработчик событий карты ───────────────────
// Вместо N отдельных SVG (по одному на выноску) — 1 SVG на контейнер карты
// и 1 слушатель событий вместо N. Критично для 100+ выносок: без этого
// каждый zoom/move вызывает N×_draw синхронно через Leaflet event-bus.
const _svgStore = new WeakMap(); // containerEl → SVGSVGElement
const _svgRefs  = new WeakMap(); // containerEl → refCount
const _evtStore = new WeakMap(); // L.Map       → { fns: Set, handler }

function _acquireSvg(map) {
  const el = map.getContainer();
  if (!_svgStore.has(el)) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:450';
    // Два яруса на весь контейнер: сначала ВСЕ линии, потом ВСЕ подписи.
    // Раньше элементы каждой выноски добавлялись подряд (линия, полка, текст),
    // поэтому линия выноски, созданной позже, ложилась поверх текста созданной
    // раньше и перечёркивала название. Теперь линии физически ниже текста.
    svg.__gLines = svg.appendChild(document.createElementNS(NS, 'g'));
    svg.__gText  = svg.appendChild(document.createElementNS(NS, 'g'));
    el.appendChild(svg);
    _svgStore.set(el, svg);
    _svgRefs.set(el, 0);
  }
  _svgRefs.set(el, _svgRefs.get(el) + 1);
  return _svgStore.get(el);
}

function _releaseSvg(map) {
  const el = map.getContainer();
  const n = Math.max(0, (_svgRefs.get(el) || 1) - 1);
  _svgRefs.set(el, n);
  if (n === 0) {
    const svg = _svgStore.get(el);
    if (svg) svg.remove();
    _svgStore.delete(el);
    _svgRefs.delete(el);
  }
}

// Масштаб CSS-отображения карты (во время pinch/resize контейнер может
// отрисовываться крупнее/мельче своих offsetWidth/offsetHeight) — раньше
// каждая выноска читала его САМА внутри своего _draw() через
// getBoundingClientRect(), а это принудительный синхронный пересчёт layout.
// При сотнях-тысячах подписей это чтение перемежалось с записью SVG-атрибутов
// соседних выносок на каждый кадр — классический layout thrashing (тысяча
// вынужденных пересчётов раскладки вместо одного). Теперь считается один раз
// на кадр пакетной перерисовки и кэшируется на время этого кадра.
const _frameScale = new WeakMap();   // L.Map → масштаб, живёт только внутри текущего кадра
function _mapScale(map) {
  if (_frameScale.has(map)) return _frameScale.get(map);
  const cont = map.getContainer();
  const bcrW = cont.getBoundingClientRect().width;
  const sc = bcrW > 0 ? bcrW / cont.offsetWidth : 1;
  // Вне кадра (открытие проекта, массовое создание выносок) запоминаем до
  // конца текущей задачи: иначе каждая из тысяч новых выносок заново
  // форсировала пересчёт раскладки. Масштаб контейнера внутри одной
  // синхронной задачи не меняется.
  _frameScale.set(map, sc);
  setTimeout(() => _frameScale.delete(map), 0);
  return sc;
}

function _regDraw(map, fn) {
  if (!_evtStore.has(map)) {
    const fns = new Set();
    // События move/zoom сыплются чаще кадра. Раньше на каждое из них
    // перерисовывались ВСЕ выноски — при сотнях подписей карта залипала.
    // Склеиваем всё, что пришло за кадр, в одну перерисовку.
    let pending = false;
    const handler = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const cont = map.getContainer();
        const bcrW = cont.getBoundingClientRect().width;
        _frameScale.set(map, bcrW > 0 ? bcrW / cont.offsetWidth : 1);
        fns.forEach(f => f());
        _frameScale.delete(map);
      });
    };
    map.on('zoom move zoomend moveend resize viewreset', handler);
    _evtStore.set(map, { fns, handler });
  }
  _evtStore.get(map).fns.add(fn);
}

function _unregDraw(map, fn) {
  const r = _evtStore.get(map);
  if (r) r.fns.delete(fn);
}

// Запись атрибута только при изменении: перерисовка выносок — это тысячи
// setAttribute за кадр, а меняются из них обычно только координаты
function _sa(el, name, val) {
  if (!el) return;
  const c = el.__a || (el.__a = {});
  const v = String(val);
  if (c[name] === v) return;
  c[name] = v;
  el.setAttribute(name, v);
}
function _ra(el, name) {
  if (!el) return;
  const c = el.__a || (el.__a = {});
  if (c[name] === undefined) return;
  delete c[name];
  el.removeAttribute(name);
}

// ── Выноска: стрелка → полка → текст (SVG-слой, пиксельно точный) ────────────
// Класс объявлен один раз на модуль: раньше L.Layer.extend вызывался на каждую
// выноску (сотни классов при 100+ источниках, и заново при каждой перерисовке
// карты редактора). Экземпляр хранит своё состояние в this._s / this._drag.
const ShelfLeader = L.Layer.extend({
  initialize(src, drag) {
    this._s   = src;
    this._drag = drag;
  },
  onAdd(map) {
    this._map = map;
    const svg = _acquireSvg(map);

    // Линии — в нижний ярус, текст и ручка — в верхний: тогда ни одна линия
    // не может перечеркнуть чужую подпись, в каком порядке бы выноски ни
    // создавались и ни пересоздавались
    const mk = (tag, host) => (host || svg)
      .appendChild(document.createElementNS('http://www.w3.org/2000/svg', tag));
    const gL = svg.__gLines || svg;
    const gT = svg.__gText  || svg;
    this._leader = mk('line',    gL);
    this._shelf  = mk('line',    gL);
    this._arrow  = mk('polygon', gL);
    this._txt    = mk('text',    gT);

    if (this._drag) {
      this._txt.style.pointerEvents = 'all';
      this._txt.style.cursor = 'grab';
      this._initDrag(this._txt);

      const h = this._handle = mk('circle', gT);
      h.setAttribute('class', 'callout-handle');
      h.style.pointerEvents = 'all';
      h.style.cursor = 'grab';
      this._initDrag(h);
    }

    this._drawBound = () => this._draw();
    _regDraw(map, this._drawBound);
    this._draw();
  },
  onRemove(map) {
    _unregDraw(map, this._drawBound);
    [this._leader, this._shelf, this._arrow, this._txt, this._handle].forEach(el => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    _releaseSvg(map);
  },
  _draw() {
    const map = this._map, s = this._s;
    // Стиль выноски — собственные поля, НЕ зависят от цвета/стиля источника
    // Тёмный по умолчанию: белый текст терялся на светлой схеме
    const color       = s.calloutColor       || '#111827';
    const fs          = (s.calloutFontSize    || 12) + 'px';
    const lw          = s.calloutLineWidth    || 1.5;
    const strokeColor = s.calloutStrokeColor  || '#ffffff';
    // Белая обводка текста по умолчанию — читается и на спутнике, и на схеме
    const strokeW     = s.calloutStrokeWidth ?? 2;
    const name        = s.name || '';

    const p1  = map.latLngToContainerPoint(_srcAnchor(s));
    const p2  = map.latLngToContainerPoint([s.calloutLat, s.calloutLon]);

    // Выноска целиком за пределами окна — рисовать нечего. На большом листе
    // это снимает основную часть работы: видно обычно десяток из сотен.
    const sz  = map.getSize();
    const M   = 220;   // запас на длину полки и текста
    const off = (p) => p.x < -M || p.y < -M || p.x > sz.x + M || p.y > sz.y + M;
    if (off(p1) && off(p2)) {
      if (!this._culled) {
        this._culled = true;
        [this._leader, this._shelf, this._arrow, this._txt, this._handle]
          .forEach(el => _sa(el, 'display', 'none'));
      }
      return;
    }
    if (this._culled) {
      this._culled = false;
      [this._leader, this._shelf, this._txt, this._handle].forEach(el => _ra(el, 'display'));
    }
    // calloutDir задаётся авторасстановкой: иначе сторона полки считается
    // на лету и подписи разворачиваются друг на друга при сдвиге карты
    const dir = (s.calloutDir === 1 || s.calloutDir === -1)
              ? s.calloutDir
              : (p2.x >= p1.x ? 1 : -1);

    const textColor  = s.calloutTextColor  || color;
    const fontFamily = s.calloutFontFamily || 'Arial,sans-serif';

    // Сначала задаём текст и измеряем его ширину
    const t = this._txt;
    _sa(t, 'font-size',   fs);
    _sa(t, 'font-family', fontFamily);
    _sa(t, 'font-weight', '700');
    if (t.textContent !== name) t.textContent = name;
    // Ширина — через canvas, а не getComputedTextLength: тот на каждой новой
    // выноске заставлял браузер пересчитать раскладку, и при открытии проекта
    // с тысячами источников это давало секунды layout thrashing.
    // Расхождение с SVG — сотые доли пикселя.
    const key = name + '|' + fs + '|' + fontFamily;
    if (this._lenKey !== key || this._textLen == null) {
      this._lenKey  = key;
      this._textLen = _measureCalloutW(name, fs, fontFamily);
    }
    const textLen = this._textLen;
    const shelfW  = Math.max(textLen + 8, 10);

    const p3x = p2.x + dir * shelfW, p3y = p2.y;

    const setLine = (el, x1, y1, x2, y2) => {
      _sa(el, 'x1', x1); _sa(el, 'y1', y1);
      _sa(el, 'x2', x2); _sa(el, 'y2', y2);
      _sa(el, 'stroke', color);
      _sa(el, 'stroke-width', lw);
    };
    const hideLeader = s.showLeaderLine === false;
    if (hideLeader) {
      _sa(this._leader, 'display', 'none');
      _sa(this._shelf,  'display', 'none');
    } else {
      setLine(this._leader, p1.x, p1.y, p2.x, p2.y);
      setLine(this._shelf,  p2.x, p2.y, p3x,  p3y);
      _ra(this._leader, 'display');
      _ra(this._shelf,  'display');
    }

    // Треугольник у источника убран
    _sa(this._arrow, 'display', 'none');

    // Текст НАД полочкой (позиция от начала полочки, а не от конца)
    _sa(t, 'x',            (dir > 0 ? p2.x + 4 : p2.x - 4).toFixed(1));
    _sa(t, 'y',            (p3y - 4).toFixed(1));
    _sa(t, 'fill',         textColor);
    _sa(t, 'text-anchor',  dir > 0 ? 'start' : 'end');
    _sa(t, 'paint-order',  'stroke');
    _sa(t, 'stroke',       strokeW > 0 ? strokeColor : 'none');
    _sa(t, 'stroke-width', strokeW > 0 ? strokeW * 2 : 0);
    _sa(t, 'stroke-linejoin', 'round');

    if (this._handle) {
      const scale = _mapScale(map);
      const hr    = (8 / scale).toFixed(1);   // always 8 visual px radius
      _sa(this._handle, 'r',  hr);
      _sa(this._handle, 'cx', p2.x);
      _sa(this._handle, 'cy', p2.y);
      _sa(this._handle, 'fill', 'rgba(15,15,15,0.82)');
      _sa(this._handle, 'stroke', color);
      _sa(this._handle, 'stroke-width', (2 / scale).toFixed(1));
      if (s.showCalloutCircle === false) _sa(this._handle, 'display', 'none');
      else                               _ra(this._handle, 'display');
    }
  },
  _initDrag(h) {
    let active = false;
    let _wasDragging = false;
    let _startLat = 0, _startLon = 0, _origLat = 0, _origLon = 0;
    const _toLL = e => {
      const cont = this._map.getContainer();
      const r    = cont.getBoundingClientRect();
      const scX  = cont.offsetWidth  / r.width;
      const scY  = cont.offsetHeight / r.height;
      return this._map.containerPointToLatLng([
        (e.clientX - r.left) * scX,
        (e.clientY - r.top)  * scY,
      ]);
    };
    h.addEventListener('pointerdown', e => {
      active = true;
      _wasDragging = this._map.dragging._enabled !== false;
      h.style.cursor = 'grabbing';
      h.setPointerCapture(e.pointerId);
      this._map.dragging.disable();
      // Фиксируем начальное смещение курсора от позиции выноски
      const ll  = _toLL(e);
      _startLat = ll.lat; _startLon = ll.lng;
      _origLat  = this._s.calloutLat; _origLon = this._s.calloutLon;
      e.preventDefault(); e.stopPropagation();
    });
    h.addEventListener('pointermove', e => {
      if (!active) return;
      const ll = _toLL(e);
      // Двигаем на дельту, а не перепрыгиваем к курсору
      this._s.calloutLat = _origLat + (ll.lat - _startLat);
      this._s.calloutLon = _origLon + (ll.lng - _startLon);
      delete this._s.calloutDir;      // перетащили вручную — сторона снова свободная
      this._draw();
      e.preventDefault();
    });
    h.addEventListener('pointerup', () => {
      if (!active) return;
      active = false;
      h.style.cursor = 'grab';
      if (_wasDragging) this._map.dragging.enable();
      // Используем кастомный коллбэк сохранения если он задан (для РТ и других модулей)
      if (typeof this._s._onSave === 'function') this._s._onSave(); else _saveSources();
    });
  },
});

function _makeCalloutLayers(s, container, enableDrag) {
  _initCalloutPos(s);
  if (!isFinite(s.calloutLat) || !isFinite(s.calloutLon)) return [];
  const layer = new ShelfLeader(s, !!enableDrag);
  layer.addTo(container);
  return [layer];
}

// Публичный доступ к фабрике выносок для других модулей (РТ и т.д.)
window._makeCalloutLayersGlobal = _makeCalloutLayers;
// Якорь выноски нужен векторному экспорту: он считает геометрию сам, по данным
window._srcAnchorPublic = (s) => _srcAnchor(s);

function _clearSourceLayers(s) {
  const grp = _srcGroupOf(s);
  (s.layers || []).forEach(l => {
    if (grp) try { grp.removeLayer(l); } catch(e) {}
    // Пробуем все группы на случай изменения типа
    Object.values(_srcLayerGroups).forEach(g => { if (g && g !== grp) try { g.removeLayer(l); } catch(e) {} });
    Object.values(_calloutLayerGroups).forEach(g => { if (g) try { g.removeLayer(l); } catch(e) {} });
  });
  s.layers = [];
}

// ── Модальное окно ─────────────────────────────────────────────────────────────
window.openSourcesModal = () => {
  _initSources();
  _buildImportCrsSelect();
  document.getElementById('sources-modal').style.display = 'flex';
  if (_srcEditId) {
    srcTab('add');
    _populateEditForm(_srcEditId);
  } else {
    srcTab('add');
    _resetAddForm();
  }
};

window.closeSourcesModal = () => {
  document.getElementById('sources-modal').style.display = 'none';
  _cancelMapPick();
  _srcEditId = null;
};

// ── Вкладки ───────────────────────────────────────────────────────────────────
window.srcTab = (tab) => {
  ['add','list','import'].forEach(t => {
    document.getElementById('src-panel-' + t).style.display = t === tab ? 'block' : 'none';
    const btn = document.getElementById('src-tab-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'list') _renderSourcesList();
};

// ── Переключатель типа геометрии ───────────────────────────────────────────────
window.srcSetGeomType = (gt) => {
  // 'area' использует те же поля что и 'point' (показываем точечную панель)
  const uiGt = (gt === 'area') ? 'point' : gt;
  ['point','line'].forEach(t => {
    const panel = document.getElementById('src-geom-' + t);
    const btn   = document.getElementById('src-gtype-' + t);
    if (panel) panel.style.display = t === uiGt ? 'block' : 'none';
    if (btn) {
      btn.style.background  = '';
      btn.style.borderColor = '';
      btn.style.color       = '';
      btn.classList.toggle('active', t === uiGt);
    }
  });
  document.getElementById('src-active-geomtype').value = gt;
};

// ── Точки линейного источника (в форме) ──────────────────────────────────────
function _renderFormLinePoints() {
  const cont = document.getElementById('src-line-pts');
  if (!cont) return;
  const canRemove = _formLinePoints.length > 2;
  cont.innerHTML = _formLinePoints.map((pt, i) => `
    <div style="display:flex;align-items:center;gap:4px;margin-bottom:5px">
      <span style="font-size:var(--fs-1);color:var(--tx2);width:18px;text-align:right;flex-shrink:0">${i+1}</span>
      <input type="number" class="modal-input src-linept-lat" data-idx="${i}" style="flex:1;font-size:var(--fs-1)"
        value="${pt[0] || ''}" step="0.000001" placeholder="Широта"
        oninput="_srcUpdateLinePt(${i},0,this.value)">
      <input type="number" class="modal-input src-linept-lon" data-idx="${i}" style="flex:1;font-size:var(--fs-1)"
        value="${pt[1] || ''}" step="0.000001" placeholder="Долгота"
        oninput="_srcUpdateLinePt(${i},1,this.value)">
      <button class="btn" style="padding:0 7px;height:30px;min-height:0;font-size:var(--fs-1);flex-shrink:0"
        onclick="srcPickLinePt(${i})" title="С карты"><svg class="icon icon-sm"><use href="#ico-pin"/></svg></button>
      ${canRemove ? `<button onclick="_srcRemoveLinePt(${i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:var(--fs-2);padding:0 3px;flex-shrink:0" title="Удалить точку">✕</button>` : `<span style="width:20px;flex-shrink:0"></span>`}
    </div>`).join('');
}

window._srcUpdateLinePt = (idx, coord, val) => {
  if (!_formLinePoints[idx]) return;
  _formLinePoints[idx][coord] = parseFloat(val) || 0;
};

window._srcRemoveLinePt = (idx) => {
  _formLinePoints.splice(idx, 1);
  _renderFormLinePoints();
};

window.srcAddLinePt = () => {
  _formLinePoints.push([0, 0]);
  _renderFormLinePoints();
  // Прокрутить вниз
  const cont = document.getElementById('src-line-pts');
  if (cont) cont.scrollTop = cont.scrollHeight;
};

// ── Выбор точки с карты ────────────────────────────────────────────────────────
function _showMapHint(text) {
  let h = document.getElementById('src-map-hint');
  if (!h) {
    h = document.createElement('div');
    h.id = 'src-map-hint';
    h.style.cssText = [
      'position:fixed;top:56px;left:50%;transform:translateX(-50%)',
      'z-index:9999;background:rgba(11,11,11,.92);color:#f0f0f2',
      'padding:7px 18px;border-radius:8px;font-size:13px;font-family:-apple-system,system-ui,sans-serif',
      'border:1px solid rgba(255,255,255,.12);pointer-events:none;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.5)',
    ].join(';');
    document.body.appendChild(h);
  }
  h.textContent = text;
  h.style.display = 'block';
}
function _hideMapHint() {
  const h = document.getElementById('src-map-hint');
  if (h) h.style.display = 'none';
}

function _cancelMapPick() {
  if (_pickCallback) {
    map.off('click', _mapPickOneShot);
    _pickCallback = null;
    _hideMapHint();
    document.getElementById('map').style.cursor = '';
  }
}

function _mapPickOneShot(e) {
  const cb = _pickCallback;
  _pickCallback = null;
  map.off('click', _mapPickOneShot);
  _hideMapHint();
  document.getElementById('map').style.cursor = '';
  if (cb) cb(e.latlng);
}

// Взять одну точку с карты (для точечного источника)
window.srcPickPoint = () => {
  document.getElementById('sources-modal').style.display = 'none';
  _pickCallback = ll => {
    document.getElementById('src-lat').value = ll.lat.toFixed(6);
    document.getElementById('src-lon').value = ll.lng.toFixed(6);
    document.getElementById('sources-modal').style.display = 'flex';
  };
  map.on('click', _mapPickOneShot);
  document.getElementById('map').style.cursor = 'crosshair';
  _showMapHint('Кликни на карту — ESC для отмены');
};

// Глобальный хелпер — позволяет другим модулям запустить режим пика точки
window._startMapPick = (onPick) => {
  _pickCallback = onPick;
  map.on('click', _mapPickOneShot);
  document.getElementById('map').style.cursor = 'crosshair';
  _showMapHint('Кликни на карту — ESC для отмены');
};
window._cancelMapPick = () => {
  _pickCallback = null;
  map.off('click', _mapPickOneShot);
  _hideMapHint();
  document.getElementById('map').style.cursor = '';
};

// Взять точку с карты для i-й точки линейного источника
window.srcPickLinePt = (idx) => {
  document.getElementById('sources-modal').style.display = 'none';
  _pickCallback = ll => {
    _formLinePoints[idx] = [ll.lat, ll.lng];
    _renderFormLinePoints();
    document.getElementById('sources-modal').style.display = 'flex';
  };
  map.on('click', _mapPickOneShot);
  document.getElementById('map').style.cursor = 'crosshair';
  _showMapHint(`Кликни точку ${idx+1} — ESC для отмены`);
};

// ── Рисование линии на карте ──────────────────────────────────────────────────
window.srcDrawLineOnMap = () => {
  document.getElementById('sources-modal').style.display = 'none';
  _lineDrawActive   = true;
  _lineDrawPts      = [];
  _lineDrawMarkers  = [];
  _lineDrawPolyline = null;
  document.getElementById('map').style.cursor = 'crosshair';
  map.doubleClickZoom.disable();
  _showMapHint('Добавляй точки кликом. Двойной клик — завершить. ESC — отмена.');
  map.on('click',    _lineDrawClick);
  map.on('dblclick', _lineDrawDblClick);
};

function _lineDrawClick(e) {
  L.DomEvent.stop(e);
  _lineDrawPts.push([e.latlng.lat, e.latlng.lng]);
  const m = L.circleMarker([e.latlng.lat, e.latlng.lng], {
    radius: 5, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 1, weight: 2,
  }).addTo(_srcLayerGroup);
  _lineDrawMarkers.push(m);
  if (_lineDrawPolyline) _srcLayerGroup.removeLayer(_lineDrawPolyline);
  if (_lineDrawPts.length >= 2) {
    _lineDrawPolyline = L.polyline(_lineDrawPts, { color: '#f59e0b', weight: 2.5, dashArray: '5,4' }).addTo(_srcLayerGroup);
  }
  _showMapHint(`Добавлено ${_lineDrawPts.length} точек. Двойной клик — завершить.`);
}

function _lineDrawDblClick(e) {
  L.DomEvent.stop(e);
  // Двойной клик добавил лишнюю точку через click — убрать её
  if (_lineDrawPts.length > 1) {
    _lineDrawPts.pop();
    const last = _lineDrawMarkers.pop();
    if (last) _srcLayerGroup.removeLayer(last);
  }
  _finishLineDraw(true);
}

function _finishLineDraw(accept) {
  map.off('click',    _lineDrawClick);
  map.off('dblclick', _lineDrawDblClick);
  map.doubleClickZoom.enable();
  _lineDrawActive = false;
  document.getElementById('map').style.cursor = '';
  _hideMapHint();
  _lineDrawMarkers.forEach(m => { try { _srcLayerGroup.removeLayer(m); } catch(e) {} });
  if (_lineDrawPolyline) { try { _srcLayerGroup.removeLayer(_lineDrawPolyline); } catch(e) {} }
  _lineDrawMarkers  = [];
  _lineDrawPolyline = null;
  if (accept && _lineDrawPts.length >= 2) {
    _formLinePoints = _lineDrawPts.slice();
    _renderFormLinePoints();
  }
  document.getElementById('sources-modal').style.display = 'flex';
}

// ESC — отмена любого режима карты
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (_pickCallback) {
    _cancelMapPick();
    document.getElementById('sources-modal').style.display = 'flex';
  }
  if (_lineDrawActive) {
    _finishLineDraw(false);
  }
});

// ── Переключатель полочки ─────────────────────────────────────────────────────
window.srcToggleLabelControls = () => {
  const show = document.getElementById('src-show-label').checked;
  document.getElementById('src-label-controls').style.display = show ? 'block' : 'none';
};

// ── Сброс/заполнение формы ────────────────────────────────────────────────────
function _resetAddForm() {
  _srcEditId = null;
  document.getElementById('src-name').value         = '';
  document.getElementById('src-type').value         = 'emission';
  document.getElementById('src-color').value        = SRC_COLORS.emission;
  document.getElementById('src-lat').value          = '';
  document.getElementById('src-lon').value          = '';
  document.getElementById('src-radius').value       = '';
  document.getElementById('src-line-width').value   = '';
  document.getElementById('src-show-label').checked = true;
  document.getElementById('src-label-controls').style.display = '';
  document.getElementById('src-callout-color').value        = '#ffffff';
  document.getElementById('src-callout-fontsize').value     = '12';
  document.getElementById('src-callout-linewidth').value    = '1.5';
  document.getElementById('src-callout-stroke-color').value = '#ffffff';
  document.getElementById('src-callout-stroke-width').value = '1';
  _formLinePoints = [[0,0],[0,0]];
  _renderFormLinePoints();
  srcSetGeomType('point');
  srcSetFillPattern('solid');
  document.getElementById('src-form-submit').innerHTML = '<svg class="icon icon-sm"><use href="#ico-plus"/></svg>Добавить на карту';
  document.getElementById('src-form-cancel').style.display = 'none';
}

function _populateEditForm(id) {
  const s = _sources.find(x => x.id === id);
  if (!s) { _srcEditId = null; return; }
  document.getElementById('src-name').value         = s.name  || '';
  document.getElementById('src-type').value         = s.type  || 'emission';
  document.getElementById('src-color').value        = s.color || '#ef4444';
  document.getElementById('src-show-label').checked = !!s.showLabel;
  document.getElementById('src-label-controls').style.display = s.showLabel ? 'block' : 'none';
  document.getElementById('src-callout-color').value        = s.calloutColor       || '#ffffff';
  document.getElementById('src-callout-fontsize').value     = s.calloutFontSize    || 12;
  document.getElementById('src-callout-linewidth').value    = s.calloutLineWidth   || 1.5;
  document.getElementById('src-callout-stroke-color').value = s.calloutStrokeColor || '#ffffff';
  document.getElementById('src-callout-stroke-width').value = s.calloutStrokeWidth != null ? s.calloutStrokeWidth : 0;
  srcSetFillPattern(s.fillPattern || 'solid');
  document.getElementById('src-form-submit').innerHTML = '<svg class="icon icon-sm"><use href="#ico-check"/></svg>Сохранить';
  document.getElementById('src-form-cancel').style.display = 'inline-flex';

  if (s.geomType === 'line' && s.points && s.points.length >= 2) {
    srcSetGeomType('line');
    _formLinePoints = s.points.map(p => [p[0], p[1]]);
    _renderFormLinePoints();
    document.getElementById('src-line-width').value = s.radius || '';
  } else if (s.geomType === 'area') {
    srcSetGeomType('area');
    document.getElementById('src-lat').value    = s.lat    || '';
    document.getElementById('src-lon').value    = s.lon    || '';
    document.getElementById('src-radius').value = s.radius || '';
  } else {
    srcSetGeomType('point');
    document.getElementById('src-lat').value    = s.lat    || '';
    document.getElementById('src-lon').value    = s.lon    || '';
    document.getElementById('src-radius').value = s.radius || '';
  }
}

window.srcEditSource = (id) => {
  _srcEditId = id;
  const modal = document.getElementById('sources-modal');
  if (modal.style.display !== 'flex') openSourcesModal();
  srcTab('add');
  _populateEditForm(id);
};

window.srcCancelEdit = () => {
  _resetAddForm();
};

// ── Добавление / обновление источника ────────────────────────────────────────
window.addSource = () => {
  const geomType   = document.getElementById('src-active-geomtype').value;
  const name       = document.getElementById('src-name').value.trim() || ('Источник ' + (_sources.length + 1));
  const type       = document.getElementById('src-type').value;
  const color      = document.getElementById('src-color').value;
  const showLabel      = document.getElementById('src-show-label').checked;
  const calloutColor       = document.getElementById('src-callout-color').value;
  const calloutFontSize    = parseInt(document.getElementById('src-callout-fontsize').value) || 12;
  const calloutLineWidth   = parseFloat(document.getElementById('src-callout-linewidth').value) || 1.5;
  const calloutStrokeColor = document.getElementById('src-callout-stroke-color').value;
  const calloutStrokeWidth = parseFloat(document.getElementById('src-callout-stroke-width').value) || 0;
  const fillPattern        = document.getElementById('src-fill-pattern').value || 'solid';

  let s;

  if (geomType === 'area') {
    // Площадной источник — сохраняем только стилевые свойства, геометрия неизменна
    if (!_srcEditId) return;
    s = _sources.find(x => x.id === _srcEditId);
    if (!s) return;
    _clearSourceLayers(s);
    Object.assign(s, { name, type, color, showLabel,
      calloutColor, calloutFontSize, calloutLineWidth, calloutStrokeColor, calloutStrokeWidth, fillPattern });

  } else if (geomType === 'line') {
    const pts = _formLinePoints.filter(p => p[0] && p[1]);
    if (pts.length < 2) { askNotice('Линейный источник требует минимум 2 точки с координатами'); return; }
    const radius = parseFloat(document.getElementById('src-line-width').value) || 0;

    if (_srcEditId) {
      s = _sources.find(x => x.id === _srcEditId);
      if (!s) return;
      _clearSourceLayers(s);
      Object.assign(s, { name, type, color, showLabel,
        calloutColor, calloutFontSize, calloutLineWidth, calloutStrokeColor, calloutStrokeWidth, fillPattern,
        geomType: 'line', points: pts.map(p => [...p]),
        lat: pts[0][0], lon: pts[0][1], radius });
    } else {
      _srcCounter++;
      s = { id: 'src_'+Date.now(), num: _srcCounter, name, type, color,
        geomType: 'line', points: pts.map(p => [...p]),
        lat: pts[0][0], lon: pts[0][1], radius, showLabel, fillPattern,
        calloutColor, calloutFontSize, calloutLineWidth, calloutStrokeColor, calloutStrokeWidth,
        calloutLat: null, calloutLon: null };
      _sources.push(s);
    }
    map.panTo([s.lat, s.lon]);

  } else {
    const lat    = parseFloat(document.getElementById('src-lat').value);
    const lon    = parseFloat(document.getElementById('src-lon').value);
    const radius = parseFloat(document.getElementById('src-radius').value) || 0;
    if (isNaN(lat) || isNaN(lon)) { askNotice('Введите координаты точки (Широта, Долгота)'); return; }

    if (_srcEditId) {
      s = _sources.find(x => x.id === _srcEditId);
      if (!s) return;
      const origGeomType = s.geomType;
      _clearSourceLayers(s);
      if (origGeomType === 'area') {
        // Пересчитываем полигон из нового lat/lon/radius, форму сохраняем
        const MIN_HW = 0.5;
        const hw = Math.max(radius / 2, MIN_HW);
        const dlat = hw / 111320;
        const dlon = hw / (111320 * Math.cos(lat * Math.PI / 180));
        Object.assign(s, { name, type, color, showLabel,
          calloutColor, calloutFontSize, calloutLineWidth, calloutStrokeColor, calloutStrokeWidth, fillPattern,
          geomType: 'area',
          polygon: [[lat-dlat,lon-dlon],[lat-dlat,lon+dlon],[lat+dlat,lon+dlon],[lat+dlat,lon-dlon]],
          points: [[lat, lon]], lat, lon, radius });
      } else {
        Object.assign(s, { name, type, color, showLabel,
          calloutColor, calloutFontSize, calloutLineWidth, calloutStrokeColor, calloutStrokeWidth, fillPattern,
          geomType: 'point', points: [[lat, lon]], lat, lon, radius });
      }
    } else {
      _srcCounter++;
      s = { id: 'src_'+Date.now(), num: _srcCounter, name, type, color,
        geomType: 'point', points: [[lat, lon]], lat, lon, radius, showLabel, fillPattern,
        calloutColor, calloutFontSize, calloutLineWidth, calloutStrokeColor, calloutStrokeWidth,
        calloutLat: null, calloutLon: null };
      _sources.push(s);
    }
    map.panTo([lat, lon]);
  }

  _drawSource(s);
  _saveSources();
  _syncSourcesLayer();
  setSt((_srcEditId ? `Источник «${s.name}» обновлён` : `Источник «${s.name}» добавлен`), 'ok');
  _resetAddForm();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
};

// ── Множественный выбор источников (Shift/Ctrl+клик по строке) ─────────────
let _selSrcIds = new Set();
let _lastPickedSrcId = null;
let _srcRenderOrder = [];   // порядок строк как отрисован (для Shift-диапазона)

window.getSrcSelection = () => [..._selSrcIds];

// На проектах с сотнями-тысячами источников полная пересборка списка
// (innerHTML всех строк) на каждый клик — это заметное подвисание (сотни мс
// на 1000+ источников). Для простого выбора меняется только подсветка —
// обновляем её точечно, без пересборки (см. _plSyncSrcListSelection ниже,
// та же идея, что и у srcSelClick в pdf-editor.js).
function _plSyncSrcListSelection() {
  const body = document.getElementById('src-list-body');
  if (!body) return false;
  const rows = body.querySelectorAll('.src-item[data-src-id]');
  if (!rows.length) return _selSrcIds.size === 0;
  const multi = _selSrcIds.size > 1;
  rows.forEach(el => { el.classList.toggle('sel', multi && _selSrcIds.has(el.dataset.srcId)); });
  return true;
}

window.srcItemClick = function(e, id) {
  // Клик по кнопке/свотчу цвета внутри строки — не выделение, а их
  // собственное действие (так же, как у обычных слоёв)
  if (e.target.closest('button,input,label')) return;
  const ids = _srcRenderOrder;
  if (e.shiftKey && _lastPickedSrcId !== null) {
    const a = ids.indexOf(_lastPickedSrcId), b = ids.indexOf(id);
    if (a > -1 && b > -1) _selSrcIds = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (e.ctrlKey || e.metaKey) {
    if (_selSrcIds.has(id)) _selSrcIds.delete(id); else _selSrcIds.add(id);
    _lastPickedSrcId = id;
  } else {
    _selSrcIds = (_selSrcIds.size === 1 && _selSrcIds.has(id)) ? new Set() : new Set([id]);
    _lastPickedSrcId = id;
  }
  if (!_plSyncSrcListSelection()) _renderSourcesList();
};

// ── Список источников ─────────────────────────────────────────────────────────
function _renderSourcesList() {
  // Окно закрыто или открыта не вкладка «Список» — строить нечего: при
  // открытии списка srcTab('list') всё равно перестроит его заново. Раньше
  // каждое скрытие/показ выносок пересобирало 2000 строк невидимого списка.
  const modal = document.getElementById('sources-modal');
  const panel = document.getElementById('src-panel-list');
  if (!modal || modal.style.display === 'none' || !panel || panel.style.display === 'none') return;
  const body = document.getElementById('src-list-body');
  _srcRenderOrder = [];
  if (!_sources.length) {
    body.innerHTML = '<div style="text-align:center;color:var(--tx2);padding:24px 0">Нет источников</div>';
    return;
  }
  const _inp = document.getElementById('src-search');
  if (_inp && _inp.value !== _srcQuery) _inp.value = _srcQuery;

  const renderItem = s => {
    const icon = SRC_TYPE_ICON[s.type] || '○';
    const geomInfo = s.geomType === 'line'
      ? `${(s.points||[]).length} точек${s.radius ? ' · Δ=' + s.radius : ''}`
      : s.geomType === 'area'
      ? `Площадной · а=${s.radius}`
      : `${(+s.lat).toFixed(5)}, ${(+s.lon).toFixed(5)}${s.radius ? ' · r=' + s.radius : ''}`;
    const pdfObj = (typeof pdfObjects !== 'undefined') ? pdfObjects.find(o => o.type === 'src-leader' && o.data.srcId === s.id) : null;
    const calloutOn  = pdfObj && pdfObj.visible !== false;
    const calloutOff = pdfObj && pdfObj.visible === false;
    const calloutBtn = `<button class="src-action-btn" onclick="srcToggleCallout('${s.id}')"
      title="${pdfObj ? (calloutOn ? 'Скрыть выноску в PDF' : 'Показать выноску в PDF') : 'Добавить выноску в PDF'}"
      style="opacity:${pdfObj?1:0.45};color:${calloutOn?'var(--acc2)':calloutOff?'var(--tx2)':'var(--tx2)'}"><svg class="icon icon-sm"><use href="#ico-pushpin"/></svg></button>`;
    const lineOn     = s.showLabel && s.showLeaderLine !== false;
    const leaderBtn  = s.showLabel
      ? `<button class="src-action-btn" onclick="srcToggleLeader('${s.id}')"
          title="${lineOn ? 'Скрыть линию выноски' : 'Показать линию выноски'}"
          style="opacity:${lineOn ? 1 : 0.45}"><svg class="icon icon-sm"><use href="#ico-leader"/></svg></button>`
      : '';
    const circleOn  = s.showLabel && s.showCalloutCircle !== false;
    const circleBtn = s.showLabel
      ? `<button class="src-action-btn" onclick="srcToggleCalloutCircle('${s.id}')"
          title="${circleOn ? 'Скрыть кружок выноски' : 'Показать кружок выноски'}"
          style="opacity:${circleOn ? 1 : 0.45}"><svg class="icon icon-sm"><use href="#ico-circle"/></svg></button>`
      : '';
    _srcRenderOrder.push(s.id);
    const _sel = _selSrcIds.has(s.id) && _selSrcIds.size > 1;
    return `<div class="src-item ${_sel ? 'sel' : ''}" data-src-id="${s.id}" onclick="srcItemClick(event,'${s.id}')"
      ondblclick="srcEditSource('${s.id}')" oncontextmenu="srcContextMenu(event,'${s.id}');return false"
      style="cursor:pointer${s.hidden ? ';opacity:.5' : ''}">
  <label style="position:relative;cursor:pointer;flex-shrink:0" title="Изменить цвет">
    <div class="src-num-badge" style="background:${s.color || 'var(--tx2)'}">${s.num || '?'}</div>
    <input type="color" value="${s.color || '#6b7280'}" onchange="srcSetColor('${s.id}',this.value)"
      style="position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;border:none;padding:0">
  </label>
  <div style="flex:1;min-width:0">
    <div class="src-item-name">${s.hidden ? '🚫 ' : ''}${icon} ${escapeHtml(s.name)}</div>
    <div class="src-item-meta">${geomInfo}</div>
  </div>
  ${leaderBtn}
  ${circleBtn}
  ${calloutBtn}
  <button class="src-action-btn" onclick="srcZoom('${s.id}')" title="Перейти на карте"><svg class="icon icon-sm"><use href="#ico-target"/></svg></button>
  <button class="src-action-btn" onclick="srcDuplicate('${s.id}')" title="Дублировать источник">⧉</button>
  <button class="src-action-btn src-action-edit" onclick="srcEditSource('${s.id}')" title="Редактировать">✎</button>
  <button class="src-action-btn src-action-del" onclick="deleteSource('${s.id}')" title="Удалить">✕</button>
</div>`;
  };

  const TYPE_DEFS = [
    { type: 'emission', icon: '◎', name: 'Выбросы',  color: SRC_COLORS.emission },
    { type: 'noise',    icon: '◉', name: 'Шум',      color: SRC_COLORS.noise },
    { type: 'other',    icon: '○', name: 'Прочее',   color: SRC_COLORS.other },
  ];

  let html = '';
  TYPE_DEFS.forEach(({ type, icon, name, color }) => {
    const group = _sources.filter(s => (s.type || 'emission') === type && _srcMatch(s));
    if (!group.length) return;
    html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0 3px;border-bottom:1px solid ${color}40;margin-bottom:3px">
      <span style="font-size:var(--fs-1);font-weight:600;color:${color}">${icon} ${name} (${group.length})</span>
      <button onclick="deleteSourcesByType('${type}')" title="Удалить все ${name.toLowerCase()}" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:var(--fs-1);padding:0 4px;opacity:0.65" title="Удалить тип">✕ все</button>
    </div>`;
    html += group.map(renderItem).join('');
    html += '<div style="height:6px"></div>';
  });
  body.innerHTML = html;
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
}
window._renderSourcesList = _renderSourcesList;

// ── Быстрое изменение цвета источника прямо из списка ─────────────────────────
window.srcSetColor = (id, color) => {
  const s = _sources.find(x => x.id === id);
  if (!s) return;
  s.color = color;
  _clearSourceLayers(s);
  _drawSource(s);
  _saveSources();
  _syncSourcesLayer();
  _renderSourcesList();
};

// ── Переключить выноску (src-leader) для источника в редакторе PDF ─────────────
window.srcToggleCallout = (srcId) => {
  const s = _sources.find(x => x.id === srcId);
  if (!s) return;

  if (typeof pdfObjects === 'undefined') {
    setSt('Сначала откройте редактор PDF (кнопка «PDF»)', 'err');
    return;
  }

  const existing = pdfObjects.find(o => o.type === 'src-leader' && o.data.srcId === srcId);
  if (existing) {
    // Переключить видимость
    existing.visible = existing.visible === false ? true : false;
    const el = document.getElementById(existing.id);
    if (el) el.style.display = existing.visible ? 'flex' : 'none';
    if (typeof _saveState === 'function') _saveState();
    if (typeof _renderLayersList === 'function') _renderLayersList();
  } else {
    // Создать новый src-leader для этого источника
    if (typeof createPdfObj !== 'function') {
      setSt('Сначала откройте редактор PDF (кнопка «PDF»)', 'err');
      return;
    }
    createPdfObj('src-leader', {
      srcId: srcId,
      content: s.name || `Источник ${s.num || ''}`,
      name: s.name || `Источник ${s.num || ''}`,
    });
    setTimeout(() => {
      if (typeof _updateAllSrcLeaderTails === 'function') _updateAllSrcLeaderTails();
    }, 150);
  }
  _renderSourcesList();
};

window.srcZoom = (id) => {
  const s = _sources.find(x => x.id === id);
  if (!s) return;
  if (s.geomType === 'line' && s.points && s.points.length >= 2) {
    map.fitBounds(L.latLngBounds(s.points), { padding: [60, 60] });
  } else if (s.geomType === 'area' && s.polygon && s.polygon.length >= 3) {
    map.fitBounds(L.latLngBounds(s.polygon), { padding: [60, 60] });
  } else {
    map.setView([s.lat, s.lon], 16);
  }
};

function _notifyPdfDeleted(ids) {
  if (typeof window._pdfOnSourcesDeleted === 'function') window._pdfOnSourcesDeleted(ids);
}

window.deleteSource = (id) => {
  const s = _sources.find(x => x.id === id);
  if (s) _clearSourceLayers(s);
  _sources = _sources.filter(x => x.id !== id);
  _notifyPdfDeleted([id]);
  _saveSources();
  _syncSourcesLayer();
  _renderSourcesList();
};

// ── Перемещение источника на карте (drag-маркер) ──────────────────────────────
window.srcActivateMoveMode = (id) => {
  const s = _sources.find(x => x.id === id);
  if (!s) return;
  // Убрать предыдущий handle если есть
  if (window._srcMoveHandle) { try { window._srcMoveHandle.remove(); } catch(e){} window._srcMoveHandle = null; }
  const color = s.color || '#6b7280';
  const icon = L.divIcon({
    html: `<div style="width:34px;height:34px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 3px ${color},0 3px 10px rgba(0,0,0,.6);cursor:grab;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:13px;user-select:none">${s.num||'?'}</div>`,
    iconSize:[34,34], iconAnchor:[17,17], className:''
  });
  const center = _srcAnchor(s);
  const marker = L.marker(center, { draggable: true, zIndexOffset: 2000, icon });
  let origLat = center[0], origLon = center[1];
  let origPoints  = s.points  ? s.points.map(p => [...p])  : null;
  let origPolygon = s.polygon ? s.polygon.map(p => [...p]) : null;
  const _applyPos = ll => {
    const dLat = ll.lat - origLat, dLon = ll.lng - origLon;
    if (s.geomType === 'line' && origPoints) {
      s.points = origPoints.map(p => [p[0]+dLat, p[1]+dLon]);
      if (s.points.length) { s.lat = s.points[0][0]; s.lon = s.points[0][1]; }
    } else if (s.geomType === 'area') {
      if (s.radius != null) {
        s.lat = ll.lat; s.lon = ll.lng;
        const hw = Math.max(s.radius/2, 0.5);
        const dlat = hw/111320, dlon = hw/(111320*Math.cos(s.lat*Math.PI/180));
        s.polygon = [[s.lat-dlat,s.lon-dlon],[s.lat-dlat,s.lon+dlon],[s.lat+dlat,s.lon+dlon],[s.lat+dlat,s.lon-dlon]];
      } else if (origPolygon) {
        s.polygon = origPolygon.map(p => [p[0]+dLat, p[1]+dLon]);
        s.lat = ll.lat; s.lon = ll.lng;
      }
    } else {
      s.lat = ll.lat; s.lon = ll.lng;
    }
    _clearSourceLayers(s); _drawSource(s);
  };
  marker.on('dragstart', () => {
    const anch = _srcAnchor(s);
    origLat = anch[0]; origLon = anch[1];
    origPoints  = s.points  ? s.points.map(p => [...p])  : null;
    origPolygon = s.polygon ? s.polygon.map(p => [...p]) : null;
  });
  marker.on('drag',    e => _applyPos(e.target.getLatLng()));
  marker.on('dragend', e => {
    _applyPos(e.target.getLatLng());
    _saveSources(); _renderSourcesList();
    setSt(`Источник «${s.name}» перемещён`, 'ok');
    marker.remove(); window._srcMoveHandle = null;
  });
  marker.addTo(_srcLayerGroup);
  window._srcMoveHandle = marker;
  map.panTo(center);
  setSt(`Перетащите маркер чтобы переместить «${s.name}»`, 'info');
};

// ── Групповые действия над выделением источников ────────────────────────────
// Та же идея, что у _targetLayers/_groupMenuHtml в map.js: если ПКМ по строке
// внутри текущего многострочного выделения — команды применяются ко всему
// выделению, иначе — только к строке под курсором.
function _targetSrcs(id) {
  if (_selSrcIds.size > 1 && _selSrcIds.has(id)) return [..._selSrcIds];
  return [id];
}

// Имя срЛистSelAction — не srcSelAction: та же команда под этим именем уже
// занята в pdf-editor.js (там своё выделение _srcSel для панели «Слои»
// редактора PDF) — совпадение имён тихо перетирало бы одно другим.
window.srcListSelAction = (action, arg) => {
  const ids = [..._selSrcIds];
  const list = _sources.filter(s => ids.includes(s.id));
  if (!list.length) return;
  if (action === 'labels-on' || action === 'labels-off') {
    const on = action === 'labels-on';
    list.forEach(s => { s.showLabel = on; });
    _sources.forEach(s => { _clearSourceLayers(s); _drawSource(s); });
    _saveSources(); _syncSourcesLayer(); _renderSourcesList();
    setSt(`${on ? 'Показаны' : 'Скрыты'} подписи: ${list.length}`, 'ok');
  } else if (action === 'hide-on' || action === 'hide-off') {
    const hide = action === 'hide-on';
    list.forEach(s => { s.hidden = hide; });
    _sources.forEach(s => { _clearSourceLayers(s); _drawSource(s); });
    _saveSources(); _syncSourcesLayer(); _renderSourcesList();
    setSt(`${hide ? 'Скрыто' : 'Показано'} источников: ${list.length}`, 'ok');
  } else if (action === 'type') {
    const typeName = arg === 'emission' ? 'выбросы' : arg === 'noise' ? 'шум' : 'прочее';
    list.forEach(s => { s.type = arg; });
    _sources.forEach(s => { _clearSourceLayers(s); _drawSource(s); });
    _saveSources(); _syncSourcesLayer(); _renderSourcesList();
    if (typeof _updateTopSelects === 'function') _updateTopSelects();
    setSt(`Перенесено в «${typeName}»: ${list.length}`, 'ok');
  } else if (action === 'color') {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = list[0].color || '#6b7280';
    inp.style.cssText = 'position:fixed;left:-100px;top:-100px';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      const col = inp.value;
      list.forEach(s => { s.color = col; });
      _sources.forEach(s => { _clearSourceLayers(s); _drawSource(s); });
      _saveSources(); _syncSourcesLayer(); _renderSourcesList();
      inp.remove();
    });
    inp.addEventListener('blur', () => setTimeout(() => inp.remove(), 200));
    inp.click();
  } else if (action === 'delete') {
    askConfirm(`Удалить выделенные источники?`, `Будет удалено: ${list.length}. Отменить это нельзя.`, () => {
      list.forEach(s => _clearSourceLayers(s));
      _notifyPdfDeleted(list.map(s => s.id));
      const delSet = new Set(list.map(s => s.id));
      _sources = _sources.filter(s => !delSet.has(s.id));
      _selSrcIds.clear();
      _saveSources(); _syncSourcesLayer(); _renderSourcesList();
      setSt(`Удалено источников: ${list.length}`, 'ok');
    });
  }
};

// ── Контекстное меню источника (ПКМ) ──────────────────────────────────────────
window.srcContextMenu = (e, id) => {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('src-ctx-menu')?.remove();
  const close = "document.getElementById('src-ctx-menu')?.remove()";
  const sel = _targetSrcs(id);
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu';
  menu.className = 'src-ctx-menu';

  let groupHtml = '';
  if (sel.length > 1) {
    const selSrcs = _sources.filter(s => sel.includes(s.id));
    const anyLabel = selSrcs.some(s => s.showLabel);
    const anyHidden = selSrcs.some(s => s.hidden);
    groupHtml = `<div class="src-ctx-hdr">Выделено источников: ${sel.length}</div>
      <button onclick="srcListSelAction('${anyLabel ? 'labels-off' : 'labels-on'}');${close}">
        <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
        ${anyLabel ? 'Скрыть' : 'Показать'} подписи у выделенных</button>
      <button onclick="srcListSelAction('${anyHidden ? 'hide-off' : 'hide-on'}');${close}">${anyHidden ? 'Показать' : 'Скрыть'} выделенные на карте</button>
      <button onclick="srcListSelAction('color');${close}">Цвет выделенным…</button>
      <div class="src-ctx-sep"></div>
      <button onclick="srcListSelAction('type','emission');${close}">→ В группу «Выбросы»</button>
      <button onclick="srcListSelAction('type','noise');${close}">→ В группу «Шум»</button>
      <button onclick="srcListSelAction('type','other');${close}">→ В группу «Прочее»</button>
      <div class="src-ctx-sep"></div>
      <button class="src-ctx-del" onclick="srcListSelAction('delete');${close}">✕ Удалить выделенные (${sel.length})</button>
      <div class="src-ctx-sep"></div>`;
  }

  menu.innerHTML = groupHtml + `
    <button onclick="srcEditSource('${id}');${close}">✎ Настройки</button>
    <button onclick="srcActivateMoveMode('${id}');${close}">✥ Переместить</button>
    <button onclick="(()=>{const s=_sources.find(x=>x.id==='${id}');if(!s)return;let rings;if(s.geomType==='line'&&s.points?.length)rings=[s.points];else if(s.geomType==='area'&&s.polygon?.length)rings=[s.polygon];else rings=[[[s.lat,s.lon]]];showCoordsModal(s.name||'Источник',rings,s.name);})();${close}"><svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-copy"/></svg>Экспорт координат</button>
    <div class="src-ctx-sep"></div>
    <button class="src-ctx-del" onclick="deleteSource('${id}');${close}">✕ Удалить</button>
  `;
  placeCtxMenu(menu, e);   // подрезка и раскрытие вверх — в utils.js
  const closeFn = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closeFn); } };
  setTimeout(() => document.addEventListener('mousedown', closeFn), 0);
};

window.deleteSourcesByType = (type) => {
  const typeName = type === 'emission' ? 'выбросы' : type === 'noise' ? 'шум' : 'прочее';
  const _cnt = _sources.filter(s => (s.type || 'emission') === type).length;
  askConfirm(`Удалить все источники: ${typeName}?`, `Будет удалено: ${_cnt}. Отменить это нельзя.`, () => {
    const toDelete = _sources.filter(s => (s.type || 'emission') === type);
    toDelete.forEach(s => _clearSourceLayers(s));
    _notifyPdfDeleted(toDelete.map(s => s.id));
    _sources = _sources.filter(s => (s.type || 'emission') !== type);
    _saveSources();
    _syncSourcesLayer();
    _renderSourcesList();
  });
};


// Перенумеровать источники подряд (по типам, как в проектах: отдельно
// выбросы, отдельно шум) — после импорта номера часто идут вразнобой
window.srcRenumber = () => {
  if (!_sources.length) return;
  askConfirm('Перенумеровать источники',
    `Номера будут переставлены подряд по типам: сначала выбросы, затем шум, затем прочие. Всего: ${_sources.length}.`,
    () => _srcRenumberDo(), { ok: 'Перенумеровать', danger: false });
};

function _srcRenumberDo() {
  let n = 0;
  ['emission', 'noise', 'other'].forEach(t => {
    _sources.filter(s => (s.type || 'emission') === t).forEach(s => {
      const oldAuto = 'Ист.' + s.num;
      s.num = ++n;
      if (!s.name || s.name === oldAuto) s.name = 'Ист.' + s.num;
    });
  });
  _srcCounter = n;
  _sources.forEach(s => { _clearSourceLayers(s); _drawSource(s); });
  _saveSources(); _syncSourcesLayer(); _renderSourcesList();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
  setSt(`Источники перенумерованы (${n})`, 'ok');
};

// Дублировать источник со смещением — быстрее, чем вводить всё заново
window.srcDuplicate = (id) => {
  const s0 = _sources.find(x => x.id === id);
  if (!s0) return;
  const d = 0.0002;                       // ~20 м к северо-востоку
  const copy = JSON.parse(JSON.stringify({ ...s0, layers: undefined }));
  copy.id = 'src_' + Date.now();
  copy.num = ++_srcCounter;
  copy.name = (s0.name || 'Ист.') + ' (копия)';
  if (copy.lat != null) { copy.lat += d; copy.lon += d; }
  if (copy.points) copy.points = copy.points.map(p => [p[0] + d, p[1] + d]);
  if (copy.polygon) copy.polygon = copy.polygon.map(p => [p[0] + d, p[1] + d]);
  if (copy.calloutLat != null) { copy.calloutLat += d; copy.calloutLon += d; }
  delete copy.layers;
  _sources.push(copy);
  _drawSource(copy);
  _saveSources(); _syncSourcesLayer(); _syncCalloutLayer(); _renderSourcesList();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
  setSt(`Источник продублирован: ${copy.name}`, 'ok');
};

// Поиск в списке источников
let _srcQuery = '';
window.srcSearch = (v) => { _srcQuery = (v || '').trim().toLowerCase(); _renderSourcesList(); };
window._srcMatch = (s) => !_srcQuery
  || String(s.name || '').toLowerCase().includes(_srcQuery)
  || String('№' + (s.num || '')).toLowerCase().includes(_srcQuery);

window.clearAllSources = () => {
  if (!_sources.length) return;
  askConfirm('Удалить все источники?', `Будет удалено: ${_sources.length}. Отменить это нельзя.`, () => {
    _notifyPdfDeleted(_sources.map(s => s.id));
    _sources.forEach(s => _clearSourceLayers(s));
    _sources = [];
    _srcCounter = 0;
    _saveSources();
    _syncSourcesLayer();
    _syncCalloutLayer();
    _renderSourcesList();
    if (typeof _updateTopSelects === 'function') _updateTopSelects();
  });
};

// Удалить источники одного типа (удаление слоя типа в панели слоёв)
window.clearSourcesOfType = (type) => {
  const list = _sources.filter(s => (s.type || 'emission') === type);
  if (!list.length) return;
  const label = { emission: 'выбросов', noise: 'шума', other: 'прочих' }[type] || '';
  askConfirm(`Удалить все источники ${label}?`, `Будет удалено: ${list.length}. Отменить это нельзя.`, () => {
  const ids = list.map(s => s.id);
  _notifyPdfDeleted(ids);
  list.forEach(s => _clearSourceLayers(s));
  _sources = _sources.filter(s => (s.type || 'emission') !== type);
  _saveSources();
  _syncSourcesLayer();
  _syncCalloutLayer();
  _renderSourcesList();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
  setSt(`Источники ${label} удалены (${ids.length})`, 'ok');
  });
};

// Выключить выноски у источников одного типа (или у всех, если type не задан).
// Удаление слоя выносок не должно удалять сами источники.
// Показать/убрать только подпись источника. Раньше ради неё источник
// стирался и рисовался заново целиком — полигон, круг, буфер линии, — и
// скрытие выносок у двух тысяч источников перестраивало всю их геометрию.
function _setSrcCallout(s, on) {
  s.showLabel = !!on;
  if (s.hidden || !_srcGroupOf(s)) return;   // такой источник не нарисован вовсе
  const isCallout = l => l instanceof ShelfLeader;
  const cur = (s.layers || []).filter(isCallout);
  if (on) {
    if (!cur.length) {
      const cg = _calloutLayerGroups[s.type || 'emission'] || _calloutLayerGroups.emission;
      s.layers = (s.layers || []).concat(_makeCalloutLayers(s, cg, true));
    }
  } else if (cur.length) {
    cur.forEach(l => Object.values(_calloutLayerGroups).forEach(g => { if (g) try { g.removeLayer(l); } catch(e) {} }));
    s.layers = s.layers.filter(l => !isCallout(l));
  }
}

window.hideSourceCalloutsOfType = (type) => {
  const list = type ? _sources.filter(s => (s.type || 'emission') === type && s.showLabel)
                    : _sources.filter(s => s.showLabel);
  if (!list.length) return;
  _primeMapScale();
  list.forEach(s => _setSrcCallout(s, false));
  _saveSources();
  _syncCalloutLayer();
  _renderSourcesList();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  setSt(`Выноски источников скрыты (${list.length})`, 'ok');
};

// ── Экспорт / импорт данных (для вкладок проектов) ───────────────────────────
window._srcGetData = function() {
  return _sources.map(({ layers, ...rest }) => rest);
};
window._srcLoadData = function(data) {
  // При смене проекта удаляем PDF-выноски старых источников, которых нет в новых данных
  const newIds = new Set((data || []).map(s => s.id));
  _notifyPdfDeleted(_sources.filter(s => !newIds.has(s.id)).map(s => s.id));
  _sources.forEach(s => _clearSourceLayers(s));
  _sources = (data || []).map(_migrateSource);
  _srcCounter = _sources.reduce((m, s) => Math.max(m, s.num || 0), 0);
  _sources.forEach(s => _drawSource(s));
  _syncSourcesLayer();
  _syncCalloutLayer();
  // Re-add layer groups to map (clearAll() removes them) — с учётом видимости слоя,
  // чтобы скрытые источники/выноски не появлялись после загрузки проекта
  if (typeof map !== 'undefined') {
    const _vis = t => (typeof window._layerTypeVisible === 'function') ? window._layerTypeVisible(t) : true;
    const _apply = (g, t) => {
      if (!g) return;
      if (_vis(t) && !map.hasLayer(g)) map.addLayer(g);
      if (!_vis(t) && map.hasLayer(g)) map.removeLayer(g);
    };
    Object.entries(_srcLayerGroups).forEach(([k, g]) => _apply(g, 'src-' + k));
    Object.entries(_calloutLayerGroups).forEach(([k, g]) => _apply(g, 'src-callouts-' + k));
  }
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
};

window.srcToggleLeader = (id) => {
  const s = _sources.find(x => x.id === id);
  if (!s || !s.showLabel) return;
  s.showLeaderLine = s.showLeaderLine === false ? true : false;
  (s.layers || []).forEach(l => { if (l._draw) l._draw(); });
  _saveSources();
  _renderSourcesList();
};

window.srcToggleCalloutCircle = (id) => {
  const s = _sources.find(x => x.id === id);
  if (!s || !s.showLabel) return;
  s.showCalloutCircle = s.showCalloutCircle === false ? true : false;
  (s.layers || []).forEach(l => { if (l._draw) l._draw(); });
  _saveSources();
  _renderSourcesList();
};

window.srcToggleAllCalloutCircles = () => {
  const withCallouts = _sources.filter(s => s.showLabel);
  if (!withCallouts.length) { setSt('Нет активных выносок', 'err'); return; }
  const anyCircle = withCallouts.some(s => s.showCalloutCircle !== false);
  withCallouts.forEach(s => {
    s.showCalloutCircle = !anyCircle;
    (s.layers || []).forEach(l => { if (l._draw) l._draw(); });
  });
  _saveSources();
  _renderSourcesList();
  setSt(anyCircle ? 'Кружки выносок скрыты' : 'Кружки выносок показаны', 'ok');
};

// Регистрирует/обновляет слои источников в панели слоёв (по типу)
const _SRC_TYPE_DEFS = [
  { type: 'src-emission', key: 'emission', name: 'Источники выбросов', color: '#ef4444', id_off: 10 },
  { type: 'src-noise',    key: 'noise',    name: 'Источники шума',     color: '#f59e0b', id_off: 11 },
  { type: 'src-other',    key: 'other',    name: 'Прочие источники',   color: '#6b7280', id_off: 12 },
];
// Запись слоя с учётом ранее запомненных настроек (видимость/цвет/стиль):
// слои источников пересоздаются при загрузке проекта, иначе настройки терялись
function _srcNewEntry(id, type, name, grp, defColor) {
  const pref = (typeof window._autoLayerPref === 'function' && window._autoLayerPref(type)) || null;
  return { id, type, name, poly: null, layer: grp,
    visible: pref ? pref.visible !== false : true,
    color: (pref && pref.color) || defColor,
    _psStyle: (pref && pref._psStyle) ? { ...pref._psStyle } : {} };
}
function _srcForget(entry) {
  if (entry && typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(entry);
}
function _srcReconcile(type) {
  const l = mapLayers.find(x => x.type === type);
  if (l && typeof window._reconcileLayerVis === 'function') window._reconcileLayerVis(l);
}

function _syncSourcesLayer() {
  if (typeof mapLayers === 'undefined' || typeof renderLayers !== 'function') return;
  let changed = false;
  _SRC_TYPE_DEFS.forEach(td => {
    const grp = _srcLayerGroups[td.key];
    const cnt = _sources.filter(s => (s.type || 'emission') === td.key).length;
    const existing = mapLayers.find(l => l.type === td.type);
    if (cnt === 0) {
      if (existing) { _srcForget(existing); mapLayers.splice(mapLayers.findIndex(l => l.type === td.type), 1); changed = true; }
    } else {
      const label = `${td.name} (${cnt})`;
      if (!existing) {
        mapLayers.push(_srcNewEntry((typeof _newLayerId === 'function' ? _newLayerId() : Date.now() + td.id_off), td.type, label, grp, td.color));
        changed = true;
      } else { existing.name = label; existing.layer = grp; changed = true; }
      _srcReconcile(td.type);
    }
  });
  if (changed) renderLayers();
  _syncCalloutLayer();
}

// Регистрирует/обновляет слои выносок в панели слоёв (по типу источника)
const _CALLOUT_TYPE_DEFS = [
  { type: 'src-callouts-emission', key: 'emission', name: 'Выноски выбросов', color: '#ef4444', id_off: 20 },
  { type: 'src-callouts-noise',    key: 'noise',    name: 'Выноски шума',     color: '#f59e0b', id_off: 21 },
  { type: 'src-callouts-other',    key: 'other',    name: 'Выноски прочих',   color: '#6b7280', id_off: 22 },
];
function _syncCalloutLayer() {
  if (typeof mapLayers === 'undefined' || typeof renderLayers !== 'function') return;
  // Удаляем старый единый слой если остался после обновления
  const legacyIdx = mapLayers.findIndex(l => l.type === 'src-callouts');
  if (legacyIdx > -1) mapLayers.splice(legacyIdx, 1);
  let changed = false;
  _CALLOUT_TYPE_DEFS.forEach(cd => {
    const grp = _calloutLayerGroups[cd.key];
    const hasCallouts = _sources.some(s => s.showLabel && (s.type || 'emission') === cd.key);
    const existing = mapLayers.find(l => l.type === cd.type);
    if (!hasCallouts) {
      if (existing) { _srcForget(existing); mapLayers.splice(mapLayers.findIndex(l => l.type === cd.type), 1); changed = true; }
    } else {
      if (!existing) {
        mapLayers.push(_srcNewEntry((typeof _newLayerId === 'function' ? _newLayerId() : Date.now() + cd.id_off), cd.type, cd.name, grp, cd.color));
        changed = true;
      } else { existing.layer = grp; changed = true; }
      _srcReconcile(cd.type);
    }
  });
  if (changed) renderLayers();
}

// ── Применить стиль выносок из панели слоёв ──────────────────────────────────
window._applyCalloutStyle = function({ color, lineWidth, textColor, textStrokeColor, textStrokeWidth, fontFamily, fontSize, sourceType } = {}) {
  // sourceType: 'emission'|'noise'|'other'|null(все)
  const targets = sourceType
    ? _sources.filter(s => (s.type || 'emission') === sourceType)
    : _sources;
  targets.forEach(s => {
    if (color           !== undefined) s.calloutColor       = color;
    if (lineWidth       !== undefined) s.calloutLineWidth   = lineWidth;
    if (textColor       !== undefined) s.calloutTextColor   = textColor;
    if (textStrokeColor !== undefined) s.calloutStrokeColor = textStrokeColor;
    if (textStrokeWidth !== undefined) s.calloutStrokeWidth = textStrokeWidth;
    if (fontFamily      !== undefined) s.calloutFontFamily  = fontFamily;
    if (fontSize        !== undefined) s.calloutFontSize    = fontSize;
  });
  targets.forEach(s => {
    (s.layers || []).forEach(l => { if (l._draw && l._s) l._draw(); });
  });
  _saveSources();
};

window._getCalloutColor = function() {
  return (_sources[0] && _sources[0].calloutColor) || '#ffffff';
};

// ── Выноски: показать/скрыть для источников одного типа ──────────────────────
window.srcToggleTypeCallouts = (type) => {
  const group = _sources.filter(s => (s.type || 'emission') === type);
  if (!group.length) { setSt('Нет источников этого типа', 'err'); return; }
  const anyVisible = group.some(s => s.showLabel);
  group.forEach(s => {
    s.showLabel = !anyVisible;
    _clearSourceLayers(s);
    _drawSource(s);
  });
  _saveSources();
  _syncCalloutLayer();
  const nm = type === 'noise' ? 'шума' : type === 'emission' ? 'выбросов' : 'прочих';
  setSt(anyVisible ? `Выноски ${nm} скрыты` : `Выноски ${nm} добавлены`, 'ok');
};

// Подписи у перечисленных источников. srcToggleCallout — это про выноску
// НА ЛИСТЕ (объект src-leader), а здесь речь про подпись на карте (showLabel).
window.srcSetLabels = function(ids, on) {
  const list = _sources.filter(s => ids.includes(s.id));
  if (!list.length) return 0;
  list.forEach(s => {
    if (!!s.showLabel === !!on) return;
    s.showLabel = !!on;
    _clearSourceLayers(s);
    _drawSource(s);
  });
  _saveSources();
  _syncCalloutLayer();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  return list.length;
};

// ── Выноски: показать/скрыть для всех источников ─────────────────────────────
window.srcToggleAllCallouts = () => {
  if (!_sources.length) { setSt('Нет источников', 'err'); return; }
  _primeMapScale();
  const anyVisible = _sources.some(s => s.showLabel);
  _sources.forEach(s => _setSrcCallout(s, !anyVisible));
  _saveSources();
  _syncCalloutLayer();
  setSt(anyVisible ? 'Выноски скрыты' : `Выноски добавлены для ${_sources.length} источников`, 'ok');
};

// ── Авторасстановка выносок ──────────────────────────────────────────────────
// Единая модель: один растр занятости на весь кадр, в который запечены
// реальные контуры (СЗЗ/Участок/площадные источники) и элементы листа PDF
// ещё до расстановки, и один алгоритм поиска места — кольцевой обход клеток
// от якоря наружу для КАЖДОЙ подписи без разделения на «компактно» и
// «колонками по краям». Подробности и обоснование — в комментарии над
// _buildObstacleGrid/_placeAllLabels ниже.
//
// opts:
//   targets   — { emission, noise, other, mp, zu }: какие выноски расставлять
//   minOffset — минимальная длина выноски (отступ от самого объекта), px
//   gap       — минимальный зазор между выносками, px
//   colGap    — зазор между соседними колонками выносок (решётка остатка), px
const CALLOUT_ARRANGE_DEFAULTS = { minOffset: 45, gap: 6, colGap: 10 };

// Все объекты с выносками: источники + расчётные точки (единый список,
// логика показа/скрытия/расстановки для них одна и та же)
function _calloutItems(targets) {
  const t = targets || { emission: true, noise: true, other: true, mp: true, zu: true };
  const out = [];
  _sources.forEach(s => {
    if (!s.showLabel || s.hidden) return;
    const k = s.type || 'emission';
    if (t[k]) out.push({ obj: s, kind: k, save: _saveSources });
  });
  if (t.mp && typeof _monPoints !== 'undefined') {
    _monPoints.forEach(p => {
      if (p.hidden) return;            // скрытая группа РТ в раскладке не участвует
      if (p.showLabel) out.push({ obj: p, kind: 'mp',
        save: (typeof _saveMonPoints === 'function' ? _saveMonPoints : null) });
    });
  }
  // Выноски слоёв (ЗУ, СЗЗ): сами полки лежат в l._calloutLayers,
  // а описатель с координатами — в l.callout
  if (t.zu && typeof mapLayers !== 'undefined') {
    mapLayers.forEach(l => {
      if (!l.callout || !l.callout.on || l.visible === false) return;
      if (!l.poly || l.poly.length < 3) return;
      // Выноска могла ещё не рисоваться — без подготовки у неё нет контура,
      // и расстановка падала на пустом якоре
      if (typeof window._layerCalloutPrep === 'function') window._layerCalloutPrep(l);
      out.push({ obj: l.callout, kind: 'zu', layers: l._calloutLayers,
                 save: (typeof markDirty === 'function' ? markDirty : null) });
    });
  }
  return out;
}

// Карта, на которой сейчас работает пользователь: редактор PDF или основная
function _calloutMap() {
  const ed = document.getElementById('pdf-editor');
  const inPdf = ed && ed.style.display !== 'none';
  return (inPdf && typeof pdfMap !== 'undefined' && pdfMap) ? pdfMap : map;
}

// ── Настоящая ширина подписи ────────────────────────────────────────────────
// Раскладка раньше прикидывала ширину как «длина строки × 0.62 × кегль».
// Для «1, 2, 3» это вдвое больше правды, для «Шламонакопитель» — заметно
// меньше, поэтому колонки выходили рваными, а часть подписей всё равно
// садилась друг на друга. Мерим тем же шрифтом, каким рисует ShelfLeader.
const _mtCache = new Map();
let _mtCtx = null;
function _measureCalloutW(name, fs, family) {
  const key = fs + '|' + family + '|' + name;
  const hit = _mtCache.get(key);
  if (hit !== undefined) return hit;
  if (!_mtCtx) {
    try { _mtCtx = document.createElement('canvas').getContext('2d'); } catch (e) { _mtCtx = null; }
  }
  let w;
  if (_mtCtx) {
    _mtCtx.font = `700 ${fs}px ${family}`;
    w = _mtCtx.measureText(String(name)).width;
  }
  if (!isFinite(w) || w <= 0) w = String(name).length * fs * 0.62;
  if (_mtCache.size > 4000) _mtCache.clear();
  _mtCache.set(key, w);
  return w;
}

// ── Занятые места на листе ──────────────────────────────────────────────────
// В редакторе PDF на карте лежат элементы листа: штамп, легенда, масштабная
// плашка, врезки-лупы, картинки, текстовые блоки. Подпись, попавшая под них,
// на печати просто не видна, поэтому такие прямоугольники раскладка обходит.
// Считаем по экранным рамкам элементов — это работает для всех типов сразу
// и учитывает масштаб листа, поворот и прокрутку без разбора их данных.
function _pdfSheetBlockers(tMap) {
  if (typeof pdfObjects === 'undefined' || !Array.isArray(pdfObjects) || !pdfObjects.length) return [];
  const ed = document.getElementById('pdf-editor');
  if (!ed || ed.style.display === 'none') return [];      // вне редактора листа нет
  const cont = tMap.getContainer();
  const cr = cont.getBoundingClientRect();
  if (!cr.width || !cr.height) return [];
  const sx = cont.offsetWidth  / cr.width;               // лист масштабируется через transform
  const sy = cont.offsetHeight / cr.height;
  const area = Math.max(1, cont.offsetWidth * cont.offsetHeight);
  const out = [];
  pdfObjects.forEach(o => {
    if (!o || o.visible === false) return;
    const el = document.getElementById(o.id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const b = {
      x: (r.left - cr.left) * sx, y: (r.top - cr.top) * sy,
      w: r.width * sx, h: r.height * sy,
    };
    // Рамка листа или подложка во всю карту заблокировали бы вообще всё —
    // такие элементы препятствием не считаем
    if (b.w * b.h > area * 0.45) return;
    // Целиком за пределами карты — не мешает
    if (b.x + b.w < 0 || b.y + b.h < 0 || b.x > cont.offsetWidth || b.y > cont.offsetHeight) return;
    out.push(b);
  });
  return out;
}
window._pdfSheetBlockersPublic = _pdfSheetBlockers;

// Контуры, которые подписи должны обходить: Участок/СЗЗ и площадные
// источники. Берём ПИКСЕЛЬНЫЕ контуры на нужной карте — тогда не важно,
// какая сейчас проекция, масштаб листа или его поворот.
function _obstaclePolygonRings(tMap) {
  const out = [];
  if (typeof mapLayers !== 'undefined') {
    mapLayers.forEach(l => {
      if (!l.poly || l.poly.length < 3 || l.visible === false) return;
      try { out.push(l.poly.map(pt => tMap.latLngToContainerPoint(L.latLng(pt[0], pt[1])))); }
      catch (e) {}
    });
  }
  if (typeof _sources !== 'undefined') {
    _sources.forEach(s => {
      if (s.geomType !== 'area' || !s.polygon || s.polygon.length < 3) return;
      try { out.push(s.polygon.map(pt => tMap.latLngToContainerPoint(L.latLng(pt[0], pt[1])))); }
      catch (e) {}
    });
  }
  return out;
}



// ── Подписи номерами ────────────────────────────────────────────────────────
// Полное название вроде «Разведочная скважина № 351р» занимает на листе
// ~165×20 px. Триста таких подписей требуют почти вдвое больше площади, чем
// есть у листа, — они не поместятся никогда. Чертёжный выход: на карте номер,
// расшифровка отдельным списком. Номер занимает ~36 px, и всё встаёт.
window.numberCalloutItems = function(items, anchors) {
  const order = items.map((_, i) => i)
    .sort((a, b) => (anchors[a].y - anchors[b].y) || (anchors[a].x - anchors[b].x));
  const index = [];
  order.forEach((idx, k) => {
    const o = items[idx].obj;
    if (o.calloutFullName == null) o.calloutFullName = o.name || '';
    o.name = String(k + 1);
    index.push({ n: k + 1, name: o.calloutFullName, itemIdx: idx });
  });
  return index;
};

// Вернуть полные названия вместо номеров
window.restoreCalloutNames = function() {
  let n = 0;
  const back = (o) => {
    if (o && o.calloutFullName != null) { o.name = o.calloutFullName; delete o.calloutFullName; n++; }
  };
  (typeof _sources !== 'undefined' ? _sources : []).forEach(back);
  (typeof _monPoints !== 'undefined' ? _monPoints : []).forEach(back);
  (typeof mapLayers !== 'undefined' ? mapLayers : []).forEach(l => { if (l.callout) back(l.callout); });
  // Перерисовываем всё, что есть
  (typeof _sources !== 'undefined' ? _sources : []).forEach(x => (x.layers || []).forEach(l => l._draw && l._draw()));
  (typeof _monPoints !== 'undefined' ? _monPoints : []).forEach(x => (x._calloutLayers || []).forEach(l => l._draw && l._draw()));
  if (typeof refreshLayerCallouts === 'function') refreshLayerCallouts();
  if (typeof _pdfRemoveIndexBlocks === 'function') _pdfRemoveIndexBlocks();
  if (typeof _saveSources === 'function') _saveSources();
  setSt(n ? `Названия возвращены: ${n}` : 'Нумерованных подписей нет', n ? 'ok' : 'err');
};

// ── Геометрия блоков расшифровки номеров ────────────────────────────────────
// Общая с _pdfBuildIndexBlocks (pdf-editor.js) раскладка колонок. Раньше
// расшифровка строилась ПОСЛЕ расстановки подписей, её площадь (а на 1000+
// объектах это легко половина листа) нигде не резервировалась — блоки
// расшифровки просто вставали поверх уже расставленных подписей, перекрывая
// часть из них. Теперь при нумерованных подписях эта раскладка считается
// заранее и подаётся в расстановку как обычные препятствия.
window._indexBlockLayout = function(index, W, H) {
  const fs = 8, lh = fs + 2.5;
  const maxChars = index.reduce((m, it) => Math.max(m, (it.n + ' — ' + it.name).length), 0);
  const colW = Math.min(Math.round(maxChars * fs * 0.55 + 14), Math.round(W * 0.48));
  const usableH = Math.round(H * 0.88);
  const perCol  = Math.max(10, Math.floor(usableH / lh));
  const cols    = Math.ceil(index.length / perCol);
  const colH    = Math.min(index.length, perCol) * lh + 10;
  const totalW  = cols * (colW + 6) - 6;
  const rects = [];
  for (let c = 0; c < cols; c++) {
    const part = index.slice(c * perCol, (c + 1) * perCol);
    if (!part.length) continue;
    rects.push({ x: 10 + c * (colW + 6), y: Math.max(8, H - colH - 10), w: colW, h: part.length * lh + 10 });
  }
  return { fs, lh, perCol, cols, colH, totalW, rects };
};

// ── Кольцевой порядок обхода клеток растра ──────────────────────────────────
const _ofsCache = { gw: 0, gh: 0, dx: null, dy: null, d: null };
function _ringOffsets(gw, gh) {
  if (_ofsCache.gw === gw && _ofsCache.gh === gh) return _ofsCache;
  const n = (2 * gw + 1) * (2 * gh + 1);
  const dx = new Int16Array(n), dy = new Int16Array(n), d2 = new Float64Array(n);
  let k = 0;
  for (let y = -gh; y <= gh; y++) for (let x = -gw; x <= gw; x++) {
    dx[k] = x; dy[k] = y; d2[k] = x * x + y * y; k++;
  }
  const ord = new Uint32Array(n);
  for (let i = 0; i < n; i++) ord[i] = i;
  ord.sort((a, b) => d2[a] - d2[b]);
  const sdx = new Int16Array(n), sdy = new Int16Array(n), sd = new Float32Array(n);
  for (let i = 0; i < n; i++) { const j = ord[i]; sdx[i] = dx[j]; sdy[i] = dy[j]; sd[i] = Math.sqrt(d2[j]); }
  Object.assign(_ofsCache, { gw, gh, dx: sdx, dy: sdy, d: sd });
  return _ofsCache;
}

// ── Растр препятствий на весь кадр ───────────────────────────────────────────
// Старая версия знала только о точках-якорях и элементах листа PDF —
// реальные контуры (СЗЗ/Участок/площадные источники) в занятость не попадали,
// и подпись спокойно садилась прямо на полигон. Теперь контуры запекаются
// в тот же растр, что и всё остальное, ДО начала расстановки: occ — занято
// хоть чем-то (контур/лист/якорь/подпись), lab — занято именно подписью
// (штраф за пересечение чужой линии выноски — хуже), poly — занято контуром
// или элементом листа (штраф за пересечение — терпимее: другого пути иногда
// правда нет, объект часто и сам стоит внутри своего контура).
function _buildObstacleGrid(tMap, blockers, polyRings) {
  const sz = tMap.getSize();
  const W = sz.x, H = sz.y;
  // Размер клетки: не больше ~90 тыс. клеток на лист, но не крупнее 6 px
  const C  = Math.max(2, Math.min(6, Math.ceil(Math.sqrt(W * H / 90000))));
  const GW = Math.max(1, Math.ceil(W / C)), GH = Math.max(1, Math.ceil(H / C));
  const occ  = new Uint8Array(GW * GH);
  const lab  = new Uint8Array(GW * GH);
  const poly = new Uint8Array(GW * GH);
  const S    = new Int32Array((GW + 1) * (GH + 1));   // префиксные суммы occ
  const SW   = GW + 1;
  let minDirty = GH;

  const rebuild = (fromRow) => {
    const r0 = Math.max(0, fromRow | 0);
    for (let y = r0; y < GH; y++) {
      let run = 0;
      const ro = y * GW, so = (y + 1) * SW, sp = y * SW;
      for (let x = 0; x < GW; x++) { run += occ[ro + x]; S[so + x + 1] = S[sp + x + 1] + run; }
    }
  };
  const cellRect = (r) => {
    let x0 = Math.floor(r.x / C), y0 = Math.floor(r.y / C);
    let x1 = Math.ceil((r.x + r.w) / C) - 1, y1 = Math.ceil((r.y + r.h) / C) - 1;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 >= GW) x1 = GW - 1; if (y1 >= GH) y1 = GH - 1;
    return [x0, y0, x1, y1];
  };
  const sumCells = (x0, y0, x1, y1) => {
    if (x1 < x0 || y1 < y0) return 0;
    return S[(y1 + 1) * SW + x1 + 1] - S[y0 * SW + x1 + 1] - S[(y1 + 1) * SW + x0] + S[y0 * SW + x0];
  };
  const markRect = (r, isLabel, isPolyLike) => {
    const [x0, y0, x1, y1] = cellRect(r);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const id = y * GW + x;
      occ[id] = 1;
      if (isLabel) lab[id] = 1;
      if (isPolyLike) poly[id] = 1;
    }
    if (y0 < minDirty) minDirty = y0;
  };
  // Только линия контура — для крупных зон (см. markPolygon)
  const markOutline = (pts) => {
    const n = pts.length, step = C / 2;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      // Ребро целиком за листом с одной стороны — пропускаем
      if ((a.x < 0 && b.x < 0) || (a.y < 0 && b.y < 0) || (a.x > W && b.x > W) || (a.y > H && b.y > H)) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const k = Math.min(Math.ceil(len / step), 200000);
      for (let j = 0; j <= k; j++) {
        const t = k ? j / k : 0;
        const gx = Math.floor((a.x + (b.x - a.x) * t) / C), gy = Math.floor((a.y + (b.y - a.y) * t) / C);
        if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue;
        const id = gy * GW + gx; occ[id] = 1; poly[id] = 1;
        if (gy < minDirty) minDirty = gy;
      }
    }
  };
  // Заливка контура по строкам клеток (чётно-нечётное правило) — скорость
  // зависит от габаритов контура в клетках, а не от числа его вершин.
  // Крупная зона (СЗЗ при приближении к участку обычно накрывает весь кадр)
  // заливкой съедала всё свободное место — «Расставлено 0 из N» на пустой
  // карте. Подпись внутри такой зоны — норма, мешать ей должна только
  // граница, поэтому у контуров больше 20% листа запекаем лишь линию.
  const markPolygon = (pts) => {
    if (!pts || pts.length < 3) return;
    let area2 = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      area2 += a.x * b.y - b.x * a.y;
    }
    if (Math.abs(area2) / 2 > W * H * 0.2) { markOutline(pts); return; }
    let ymin = Infinity, ymax = -Infinity;
    for (const p of pts) { if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y; }
    const gy0 = Math.max(0, Math.floor(ymin / C)), gy1 = Math.min(GH - 1, Math.ceil(ymax / C));
    const n = pts.length;
    for (let gy = gy0; gy <= gy1; gy++) {
      const yc = (gy + 0.5) * C;
      const xs = [];
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
          xs.push(a.x + (yc - a.y) / (b.y - a.y) * (b.x - a.x));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const gx0 = Math.max(0, Math.floor(xs[i] / C)), gx1 = Math.min(GW - 1, Math.ceil(xs[i + 1] / C) - 1);
        for (let gx = gx0; gx <= gx1; gx++) { const id = gy * GW + gx; occ[id] = 1; poly[id] = 1; }
      }
      if (gy < minDirty) minDirty = gy;
    }
  };
  const flush = () => { if (minDirty < GH) { rebuild(minDirty); minDirty = GH; } };
  const occCount = (r) => { const [x0, y0, x1, y1] = cellRect(r); return sumCells(x0, y0, x1, y1); };
  const inSheet = (r, PAD) => r.x >= PAD && r.y >= PAD && r.x + r.w <= W - PAD && r.y + r.h <= H - PAD;

  (blockers || []).forEach(b => markRect(b, false, true));
  (polyRings || []).forEach(ring => markPolygon(ring));
  flush();

  return { C, GW, GH, W, H, occ, lab, poly, markRect, flush, occCount, inSheet };
}

// ── Единый поиск места — один алгоритм для ВСЕХ подписей ───────────────────
// Раньше было два разных алгоритма («компактно рядом с объектом» и
// «колонками по краям листа») с ручной передачей остатка между ними и
// жёстким потолком числа колонок/рядов. При большом числе подписей лист с
// местом не заканчивался, а всё, что не влезло в 3-4 колонки, просто
// сваливалось в кучу у центра скопления объектов — то есть, как правило,
// прямо на полигон.
//
// Теперь для каждой подписи — один и тот же кольцевой обход клеток растра
// от якоря наружу, без искусственного обрыва на первой подвернувшейся
// находке (раньше поиск останавливался почти сразу: как только находилось
// хоть одно свободное место, дальность ограничивалась множителем 1.3 от
// него же — более свободные и более удачные по пересечениям места чуть
// дальше просто не проверялись). Теперь поиск продолжается, пока цена
// продолжает улучшаться, и останавливается только после patience клеток
// подряд без улучшения — поэтому лишние подписи расходятся по всему
// свободному месту на листе, а не упираются в придуманный потолок колонок.
// Полигоны уже запечены в occ, поэтому поиск не посадит подпись на контур,
// если где-то рядом есть настоящее свободное место.
//
// Кому места рядом с объектом всё-таки не хватило (объектов больше, чем
// лист может вместить аккуратно), раньше каждому отдельно подбиралось «где
// перекрытие минимальное» — результат выглядел как хаотичный веер линий во
// все стороны. Такой остаток раскладывается ОДНИМ проходом по общей решётке
// (_gridPackAll): ровными колонками, одна подпись строго под другой.
//
// Но органический поиск ниже — честно ИСЧЕРПЫВАЮЩИЙ: если для подписи не
// нашлось места, значит прямоугольника такого размера нет вообще нигде на
// листе — той же карте занятости, по которой потом искала бы и решётка.
// Поэтому при реальной перегрузке (объектов физически больше, чем лист
// способен вместить) органика, обрабатывая подписи одну за другой, успевает
// ИЗРЕЗАТЬ свободное место на мелкие, непригодные лоскутки ДО того, как
// отказ случится — и решётке для остатка уже физически нечего предложить.
// Поэтому плотность оценивается ЗАРАНЕЕ: если суммарная площадь подписей
// составляет заметную долю свободного места, весь пакет сразу идёт в
// решётку (без фрагментации), а не только то, что не влезло органически.
function _placeAllLabels(items, anchors, boxes, tMap, o, grid) {
  const PAD = 4;
  const gap = Math.max(0, o.gap ?? CALLOUT_ARRANGE_DEFAULTS.gap);
  const colGap = Math.max(0, o.colGap ?? gap);
  // Раньше здесь стоял жёсткий пол Math.max(10, gap+8, ...) — значение
  // пользователя из настроек ниже 10 px физически не могло применится,
  // сколько бы он ни убавлял. Теперь длина выноски — ровно то, что задано.
  const minR = Math.max(0, o.minOffset ?? CALLOUT_ARRANGE_DEFAULTS.minOffset);
  const C = grid.C, GW = grid.GW, GH = grid.GH;

  // Сами объекты тоже занимают место: подпись не садится на свою точку
  anchors.forEach(a => grid.markRect({ x: a.x - 5, y: a.y - 5, w: 10, h: 10 }, false, true));
  grid.flush();

  // Центр скопления — направление «наружу» и порядок обработки (от краёв
  // к центру: у краевых меньше свободных направлений, проще их заклинить,
  // если оставить напоследок)
  let cx = 0, cy = 0;
  anchors.forEach(a => { cx += a.x; cy += a.y; });
  cx /= anchors.length || 1; cy /= anchors.length || 1;
  const dist = i => Math.hypot(anchors[i].x - cx, anchors[i].y - cy);
  const order = items.map((_, i) => i).sort((a, b) => dist(b) - dist(a));

  // Решётка не фрагментирует место, поэтому реально вмещает намного больше,
  // чем органический поиск — порог занижен (не 90-100%, а ~55%), чтобы
  // переключаться ДО того, как органика начнёт резать свободные клочки
  let freeCells = 0;
  for (let k = 0; k < grid.occ.length; k++) if (!grid.occ[k]) freeCells++;
  const freeArea  = freeCells * C * C;
  const totalNeed = items.reduce((s, _, i) => s + (boxes[i].w + gap) * (boxes[i].h + gap), 0);
  if (freeArea > 0 && totalNeed / freeArea > 0.55) {
    const all = items.map((_, i) => i);
    const { placed: gridded, left } = _gridPackAll(all, items, anchors, boxes, tMap, grid, gap, colGap, cx, cy);
    return { left, crowded: gridded };
  }

  const ofs = _ringOffsets(GW, GH);
  const N   = ofs.d.length;
  // Сколько клеток подряд без улучшения терпим, прежде чем взять лучшее
  // найденное. Масштабируется с разрешением листа: на крупном холсте
  // разумно смотреть дальше, но без риска зависания на тысячах подписей.
  const patience = Math.max(200, Math.min(2000, Math.round(Math.sqrt(GW * GH))));

  const leaderCost = (ax, ay, px, py) => {
    const len = Math.hypot(px - ax, py - ay);
    const n = Math.max(1, Math.ceil(len / C));
    let hitLab = 0, hitPoly = 0, prev = -1;
    for (let k = 1; k < n; k++) {
      const x = Math.floor((ax + (px - ax) * k / n) / C);
      const y = Math.floor((ay + (py - ay) * k / n) / C);
      if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
      const id = y * GW + x;
      if (id !== prev) {
        if (grid.lab[id]) hitLab++;
        else if (grid.poly[id]) hitPoly++;
      }
      prev = id;
    }
    return hitLab * 6 * C + hitPoly * 2 * C;
  };

  const rectFor = (px, py, dir, b) => ({ x: dir > 0 ? px : px - b.w, y: py - b.h, w: b.w, h: b.h });

  // Если подпись размера w×h нигде не встала, любая не меньшая тоже не встанет
  const failed = [];
  const surelyFails = (b) => failed.some(f => b.w >= f.w && b.h >= f.h);
  const overflow = [];    // рядом с объектом места не нашлось — уйдёт в сетку

  order.forEach(i => {
    const b = boxes[i], a = anchors[i];
    const ax = Math.min(Math.max(a.x, 0), grid.W - 1), ay = Math.min(Math.max(a.y, 0), grid.H - 1);
    const gx = Math.floor(ax / C), gy = Math.floor(ay / C);
    const awayX = a.x - cx;

    let best = null;
    if (!surelyFails(b)) {
      let noImprove = 0;
      for (let k = 0; k < N; k++) {
        const dd = ofs.d[k] * C;
        if (dd < minR) continue;
        if (best && noImprove > patience) break;
        const cxl = gx + ofs.dx[k], cyl = gy + ofs.dy[k];
        if (cxl < 0 || cyl < 0 || cxl >= GW || cyl >= GH) continue;
        const px = cxl * C, py = cyl * C;
        // Сначала сторона «от объекта», потом обратная
        const pref = (px - a.x) > 0.5 ? 1 : (px - a.x) < -0.5 ? -1 : (awayX >= 0 ? 1 : -1);
        let improved = false;
        for (let t = 0; t < 2; t++) {
          const dir = t === 0 ? pref : -pref;
          const r = rectFor(px, py, dir, b);
          if (!grid.inSheet(r, PAD)) continue;
          if (grid.occCount(r) > 0) continue;
          // Бонус за «прилегание» к уже занятому: подписи ложатся плотно,
          // без щелей, в которые потом никто не помещается
          const ring = grid.occCount({ x: r.x - C, y: r.y - C, w: r.w + 2 * C, h: r.h + 2 * C });
          const cost = dd + leaderCost(a.x, a.y, px, py) + (t ? 10 : 0) - ring * C * 1.2;
          if (!best || cost < best.cost) { best = { r, px, py, dir, cost }; improved = true; }
        }
        noImprove = improved ? 0 : noImprove + 1;
      }
      if (!best) failed.push({ w: b.w, h: b.h });
    }

    if (!best) { overflow.push(i); return; }   // уйдёт в сетку остатка ниже

    grid.markRect({ x: best.r.x - gap / 2, y: best.r.y - gap / 2, w: best.r.w + gap, h: best.r.h + gap }, true, false);
    grid.flush();
    const ll = tMap.containerPointToLatLng(L.point(best.px, best.py));
    items[i].obj.calloutLat = ll.lat;
    items[i].obj.calloutLon = ll.lng;
    items[i].obj.calloutDir = best.dir;
  });

  const { placed: gridded, left } = _gridPackAll(overflow, items, anchors, boxes, tMap, grid, gap, colGap, cx, cy);

  return { left, crowded: gridded };
}

// ── Плотная упаковка решёткой — либо для остатка, либо для всего пакета ────
// Раньше тому, кому не досталось органического места, отдельно подбиралось
// «где перекрытие минимальное» — результат расползался хаотичным веером
// линий во все стороны листа. Здесь список idx раскладывается ОДНИМ
// проходом по общей решётке: колонки слева направо (ближайшие к скоплению
// объектов — первыми), внутри колонки — сверху вниз. Ячейка решётки одна на
// всех — по размеру самой крупной подписи из idx, поэтому ряды не ломаются
// и подписи стоят ровно одна под другой. Решётка строится по уже занятой
// карте (контуры/лист/то, что уже расставлено), поэтому ни с чем не
// пересекается — а лист либо вмещает весь набор, либо честно показывает,
// сколько не влезло.
function _gridPackAll(idx, items, anchors, boxes, tMap, grid, gap, colGap, cx, cy) {
  if (!idx.length) return { placed: [], left: [] };
  const PAD = 4;
  // Высота ряда — общая для всех (один шрифт на весь пакет), а вот ширина
  // колонки раньше тоже бралась ОДНА на все 1000+ подписей разом (максимум
  // по самому длинному имени) — редкая длинная подпись раздувала буквально
  // КАЖДУЮ колонку, и короткие номера вроде «138»/«6001» сидели в колонках
  // вдвое шире нужного, а на листе явно оставалось место ещё на 1-2 колонки.
  // Теперь ширина — по факту подписей именно в этой колонке.
  const cellH = Math.max(...idx.map(i => boxes[i].h)) + gap;
  const rows  = Math.max(1, Math.floor((grid.H - 2 * PAD) / cellH));

  // На свою сторону (где физически стоит объект)
  const bySide = (want) => idx.filter(i => (anchors[i].x < cx ? -1 : 1) === want);
  const leftIdx = bySide(-1), rightIdx = bySide(1);

  const placed = [];
  const place = (i, gx, gy, colW, dir) => {
    const inner = { x: gx + gap / 2, y: gy + gap / 2, w: colW - gap, h: cellH - gap };
    if (inner.w <= 0 || inner.h <= 0 || grid.occCount(inner) > 0) return false;
    grid.markRect(inner, true, false);
    const px = dir > 0 ? gx : gx + colW;
    const py = gy + cellH;
    const ll = tMap.containerPointToLatLng(L.point(px, py));
    items[i].obj.calloutLat = ll.lat;
    items[i].obj.calloutLon = ll.lng;
    items[i].obj.calloutDir = dir;
    placed.push(i);
    return true;
  };

  // Колонки растим от скопления (x0) наружу, к краю листа; ширина каждой —
  // по самой длинной подписи ИМЕННО в ней (dir=-1 — влево, dir=1 — вправо).
  // colGap — зазор МЕЖДУ соседними колонками (отдельная настройка от gap,
  // который держит воздух между строками/краем подписи внутри самой ячейки).
  //
  // В колонку берём не следующий кусок по порядку списка, а именно ближайшие
  // по X объекты к текущей границе роста — раньше кусок нарезался по Y без
  // оглядки на X, и объект рядом с центром скопления мог уехать в дальнюю
  // колонку только потому, что по Y оказался соседом с теми, кто туда уже
  // попал. Из-за этого расстояние до объекта переставало зависеть от
  // настройки — порядок в списке решал всё.
  const packSide = (order0, dir, x0) => {
    let remaining = order0.slice();
    let x = x0;
    const fails = [];
    while (remaining.length) {
      remaining.sort((a, b) => Math.abs(anchors[a].x - x) - Math.abs(anchors[b].x - x));
      const chunk = remaining.slice(0, rows);
      const colW = Math.max(...chunk.map(i => boxes[i].w)) + gap;
      const gx = dir > 0 ? x : x - colW;
      if (gx < PAD || gx + colW > grid.W - PAD) break;
      // Внутри колонки — по Y, и блок рядов ставим напротив реального Y этих
      // объектов, а не всегда от верха листа (иначе колонка из нижней части
      // скопления всё равно начиналась с верхнего ряда)
      chunk.sort((a, b) => anchors[a].y - anchors[b].y);
      const avgY = chunk.reduce((s, i) => s + anchors[i].y, 0) / chunk.length;
      const blockH = chunk.length * cellH;
      let gy0 = avgY - blockH / 2;
      gy0 = Math.max(PAD, Math.min(gy0, grid.H - PAD - blockH));
      chunk.forEach((i, r) => { if (!place(i, gx, gy0 + r * cellH, colW, dir)) fails.push(i); });
      const chunkSet = new Set(chunk);
      remaining = remaining.filter(i => !chunkSet.has(i));
      x += dir * (colW + colGap);
    }
    return { x, rest: [...fails, ...remaining] };
  };

  const Lp = packSide(leftIdx,  -1, cx);
  const Rp = packSide(rightIdx,  1, cx);
  // Остаток перегруженной стороны — в свободное место другой стороны (после
  // её собственных колонок). Честное исключение при явном перекосе
  // скопления, а не правило по умолчанию — выноска в первую очередь всегда
  // растёт от своего объекта, а не летит через весь лист
  const Lp2 = packSide(Rp.rest, -1, Lp.x);
  const Rp2 = packSide(Lp.rest,  1, Rp.x);

  grid.flush();
  return { placed, left: [...Lp2.rest, ...Rp2.rest] };
}

window.autoArrangeCallouts = function(opts) {
  const o = { ...CALLOUT_ARRANGE_DEFAULTS, ...(opts || {}) };
  const items = _calloutItems(o.targets);
  if (!items.length) { setSt('Нет активных выносок для расстановки', 'err'); return; }

  const tMap  = _calloutMap();
  const mapSz = tMap.getSize();

  // Якоря объектов в пикселях
  const anchors = items.map(it => {
    try {
      const a = _srcAnchor(it.obj);
      if (!a || !isFinite(a[0]) || !isFinite(a[1])) return null;
      const p = tMap.latLngToContainerPoint(L.latLng(a[0], a[1]));
      return { x: p.x, y: p.y };
    } catch (e) { return null; }
  });
  // Объект без внятных координат выкидываем, а не роняем всю расстановку
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (!anchors[i]) { anchors.splice(i, 1); items.splice(i, 1); }
  }
  if (!items.length) { setSt('У выносок нет координат для расстановки', 'err'); return; }

  // Объекты за пределами листа: их значок на печать не попадает, а подпись,
  // поставленная на лист, только отнимает место у видимых. Убираем такие
  // подписи за край (к самому объекту) и в расстановке не учитываем.
  let _offSheet = 0;
  {
    const M = 2;
    for (let i = anchors.length - 1; i >= 0; i--) {
      const a = anchors[i];
      if (a.x >= -M && a.y >= -M && a.x <= mapSz.x + M && a.y <= mapSz.y + M) continue;
      if (items[i].kind === 'zu') {          // у слоя якорь — центр, контур может быть на листе
        a.x = Math.min(Math.max(a.x, 0), mapSz.x); a.y = Math.min(Math.max(a.y, 0), mapSz.y);
        continue;
      }
      const ob = items[i].obj;
      const dx = a.x < 0 ? -30 : a.x > mapSz.x ? 30 : 0;
      const dy = a.y < 0 ? -30 : a.y > mapSz.y ? 30 : 0;
      const ll = tMap.containerPointToLatLng(L.point(a.x + dx, a.y + dy));
      ob.calloutLat = ll.lat; ob.calloutLon = ll.lng; ob.calloutDir = dx >= 0 ? 1 : -1;
      (items[i].layers || ob.layers || ob._calloutLayers || []).forEach(l => { if (l._draw && l._s) l._draw(); });
      anchors.splice(i, 1); items.splice(i, 1); _offSheet++;
    }
  }
  if (!items.length) { setSt(`Все ${_offSheet} объектов с выносками — за пределами листа`, 'err'); return { total: 0, left: 0, placed: 0 }; }

  // Нумерация до расчёта габаритов: коробки должны считаться уже по номерам
  let _numIndex = null;
  if (o.numbered) _numIndex = window.numberCalloutItems(items, anchors);

  // Габариты полочки: ширина текста + высота строки.
  // +8 — та же полка, что рисует ShelfLeader (shelfW = textLen + 8),
  // +6 — воздух, чтобы соседние подписи не касались вплотную
  const boxes = items.map(it => {
    const fs = it.obj.calloutFontSize || 12;
    const fam = it.obj.calloutFontFamily || 'Arial,sans-serif';
    const nm = it.obj.name || (it.kind === 'mp' ? `РТ-${it.obj.num}` : `№${it.obj.num || ''}`);
    return { w: Math.max(_measureCalloutW(nm, fs, fam) + 14, 30), h: fs + 8 };
  });

  // Препятствия: элементы листа PDF (штамп, легенда, врезки) + реальные
  // контуры (СЗЗ/Участок/площадные источники) — подписи обходят и то, и то.
  // Расшифровку номеров сюда заранее не резервируем: её площадь посчитана по
  // ВСЕМ подписям, хотя реально влезет не факт что все — на плотных наборах
  // (сотни-тысячи объектов) такой резерв отъедал весь лист ещё до расстановки
  // и топил результат куда сильнее, чем помогал. Вместо этого после
  // расстановки в расшифровку попадают только реально поместившиеся подписи
  // (см. ниже), а не весь список.
  const blockers = _pdfSheetBlockers(tMap);
  const polyRings = _obstaclePolygonRings(tMap);
  const grid = _buildObstacleGrid(tMap, blockers, polyRings);

  const { left, crowded } = _placeAllLabels(items, anchors, boxes, tMap, o, grid);

  // Перерисовываем выноски на обеих картах
  items.forEach(it => {
    (it.layers || it.obj.layers || it.obj._calloutLayers || []).forEach(l => { if (l._draw && l._s) l._draw(); });
  });
  if (typeof pdfMap !== 'undefined' && pdfMap && typeof _refreshPdfMapLayers === 'function') _refreshPdfMapLayers();
  _saveSources();
  if (typeof _saveMonPoints === 'function') _saveMonPoints();
  if (items.some(it => it.kind === 'zu') && typeof markDirty === 'function') markDirty();

  const byKind = items.reduce((m, it) => { m[it.kind] = (m[it.kind] || 0) + 1; return m; }, {});
  const parts = [];
  if (byKind.emission) parts.push(`выбросы ${byKind.emission}`);
  if (byKind.noise)    parts.push(`шум ${byKind.noise}`);
  if (byKind.other)    parts.push(`прочие ${byKind.other}`);
  if (byKind.mp)       parts.push(`РТ ${byKind.mp}`);
  if (byKind.zu)       parts.push(`слои ${byKind.zu}`);
  // Расшифровка номеров — отдельными текстовыми блоками на листе. Только для
  // реально поместившихся подписей: у тех, кто попал в left, на листе нет
  // никакого номера — строка «523 — Название» без самого тега 523 на карте
  // только путает.
  if (_numIndex && typeof _pdfBuildIndexBlocks === 'function') {
    const leftSet = new Set(left);
    const placedIndex = _numIndex.filter(e => !leftSet.has(e.itemIdx));
    try { _pdfBuildIndexBlocks(placedIndex); } catch(e) {}
  }

  const _result = { total: items.length, left: left.length, placed: items.length - left.length,
                    crowded: crowded.length, blockers: blockers.length };
  // Подсказка про элементы листа: иначе непонятно, почему подписей меньше,
  // чем свободного места на глаз
  const _obst = (blockers.length
    ? ` Элементов листа в обход: ${blockers.length}.`
    : '') + (_offSheet ? ` Вне листа (не подписаны): ${_offSheet}.` : '');
  if (left.length > 0) {
    // Столько подписей физически не помещается на листе — молча сваливать
    // их за границу нельзя, поэтому говорим прямо
    if (!o.quiet) setSt(`Расставлено ${_result.placed} из ${items.length}. ` +
          `Не поместилось: ${left.length}.${_obst} Подписи такой длины занимают больше места, чем есть на листе — ` +
          `включите «подписи номерами» или уменьшите шрифт`, 'err');
  } else if (crowded.length > 0) {
    // Рядом с объектом места не хватило — эта часть расставлена ровной
    // сеткой в стороне (без перекрытий, но и не рядом со своим объектом)
    if (!o.quiet) setSt(`Выноски расставлены: ${items.length} (${parts.join(', ')}). ` +
          `Из них сеткой в стороне (не хватило места рядом с объектом): ${crowded.length} — ` +
          `уменьшите шрифт или зазор, либо включите «подписи номерами».${_obst}`, 'ok');
  } else if (!o.quiet) {
    setSt(`Выноски расставлены: ${items.length} (${parts.join(', ')}).${_obst}`, 'ok');
  }
  return _result;
};


// ── Подбор под лист ─────────────────────────────────────────────────────────
// Считает по тому листу, который сейчас открыт, и сам доводит раскладку до
// состояния «всё поместилось»: сначала пробует как есть, потом ужимает шрифт.
// На номера с отдельной расшифровкой-списком САМ не переключает — раньше это
// происходило молча, и на плотных наборах лист зарастал блоками
// «Экспликация N» непонятно откуда. Это осознанный выбор пользователя
// (чекбокс «Подписи номерами» в настройках расстановки), не то, что должно
// подставляться автоматически.
window.autoArrangeFit = function(opts) {
  const base = { ...CALLOUT_ARRANGE_DEFAULTS, ...(opts || {}), quiet: true };
  const items0 = _calloutItems(base.targets);
  if (!items0.length) { setSt('Нет активных выносок для расстановки', 'err'); return; }

  // Исходные размеры шрифта — чтобы вернуть, если ужимать не понадобится
  const saved = items0.map(it => ({ o: it.obj, fs: it.obj.calloutFontSize }));

  const fitsClean = (res) => res && res.left === 0 && res.crowded === 0;

  let r = autoArrangeCallouts({ ...base });
  if (fitsClean(r)) {
    setSt(`Подобрано под лист: ${r.total} выносок, всё поместилось`, 'ok');
    return r;
  }

  // Ступени шрифта: мельче 7 px на печати уже не читается
  let fsUsed = null;
  for (const fs of [10, 9, 8, 7]) {
    saved.forEach(x => { x.o.calloutFontSize = fs; });
    r = autoArrangeCallouts({ ...base });
    fsUsed = fs;
    if (fitsClean(r)) {
      setSt(`Подобрано под лист: ${r.total} выносок, шрифт ${fs} px`, 'ok');
      return r;
    }
  }

  // Даже мелкий шрифт не спас — оставляем лучший достигнутый результат
  // (шрифт 7 px) и честно говорим, сколько не влезло
  if (r && r.crowded > 0 && r.left === 0) {
    setSt(`Подобрано под лист: ${r.total} выносок (шрифт ${fsUsed} px), но ${r.crowded} — сеткой в стороне от объекта`, 'ok');
  } else {
    setSt(`Даже мелким шрифтом (${fsUsed} px) помещается не всё: ${r ? r.placed : 0} из ${r ? r.total : items0.length}. ` +
          `Не поместилось: ${r ? r.left : items0.length}. Нужен лист крупнее, меньше объектов на листе, ` +
          `либо «Подписи номерами» вручную в настройках расстановки (⚙ рядом с кнопкой)`, 'err');
  }
  return r;
};

// ── Диалог настроек авторасстановки ─────────────────────────────────────────
// Есть ли сейчас подписи, заменённые номерами
function _hasNumberedCallouts() {
  const any = (o) => o && o.calloutFullName != null;
  if ((typeof _sources !== 'undefined' ? _sources : []).some(any)) return true;
  if ((typeof _monPoints !== 'undefined' ? _monPoints : []).some(any)) return true;
  return (typeof mapLayers !== 'undefined' ? mapLayers : []).some(l => any(l.callout));
}

window.openCalloutArrangeDialog = function() {
  const prev = document.getElementById('ca-dialog');
  if (prev) prev.remove();

  const cnt = { emission: 0, noise: 0, other: 0, mp: 0, zu: 0 };
  _sources.forEach(s => { if (s.showLabel) cnt[s.type || 'emission']++; });
  if (typeof _monPoints !== 'undefined') _monPoints.forEach(p => { if (p.showLabel && !p.hidden) cnt.mp++; });
  if (typeof mapLayers !== 'undefined')
    mapLayers.forEach(l => { if (l.callout && l.callout.on && l.visible !== false && l.poly) cnt.zu++; });
  if (!cnt.emission && !cnt.noise && !cnt.other && !cnt.mp && !cnt.zu) {
    setSt('Нет активных выносок — включите их у источников, РТ или слоёв', 'err');
    return;
  }

  const saved = (typeof Store !== 'undefined' ? Store.get('calloutArrange', null) : null)
             || CALLOUT_ARRANGE_DEFAULTS;

  const chk = (key, label, n) => n === 0 ? '' : `
    <label class="ca-row"><input type="checkbox" id="ca-${key}" checked>
      <span>${label}</span><span class="ca-num">${n}</span></label>`;

  const d = document.createElement('div');
  d.id = 'ca-dialog';
  d.className = 'app-dialog';
  d.innerHTML = `
    <div class="modal" style="width:420px">
      <div class="modal-hdr"><h2>Авторасстановка выносок</h2>
        <button class="modal-close" onclick="document.getElementById('ca-dialog').remove()" title="Отмена"><svg class="icon"><use href="#ico-x"/></svg></button></div>
      <div class="modal-body">
        <div class="ca-label">Что расставлять</div>
        ${chk('emission', 'Источники выбросов', cnt.emission)}
        ${chk('noise',    'Источники шума',     cnt.noise)}
        ${chk('other',    'Прочие источники',   cnt.other)}
        ${chk('mp',       'Расчётные точки',    cnt.mp)}
        ${chk('zu',       'Выноски слоёв (ЗУ)', cnt.zu)}

        <div class="ca-label">Минимальная длина выноски, px</div>
        <div class="ca-inline">
          <input type="range" id="ca-offset" min="0" max="200" step="1" value="${saved.minOffset}">
          <input type="number" id="ca-offset-n" min="0" max="400" value="${saved.minOffset}">
        </div>

        <div class="ca-label">Зазор между выносками, px</div>
        <div class="ca-inline">
          <input type="range" id="ca-gap" min="0" max="40" step="1" value="${saved.gap}">
          <input type="number" id="ca-gap-n" min="0" max="80" value="${saved.gap}">
        </div>

        <div class="ca-label">Расстояние между столбиками выносок, px</div>
        <div class="ca-inline">
          <input type="range" id="ca-colgap" min="0" max="80" step="1" value="${saved.colGap ?? CALLOUT_ARRANGE_DEFAULTS.colGap}">
          <input type="number" id="ca-colgap-n" min="0" max="200" value="${saved.colGap ?? CALLOUT_ARRANGE_DEFAULTS.colGap}">
        </div>

        <label class="ca-row" style="margin-bottom:2px"><input type="checkbox" id="ca-numbered" ${_hasNumberedCallouts() ? 'checked' : ''}>
          <span>Подписи номерами, расшифровка списком</span></label>
        ${_hasNumberedCallouts() ? `<button class="btn" style="width:100%;margin:2px 0 6px"
            onclick="restoreCalloutNames();document.getElementById('ca-dialog').remove()">
            Вернуть полные названия</button>` : ''}
        <div style="font-size:var(--fs-1);color:var(--tx2);opacity:.75;margin:-2px 0 6px 2px">
          Нужно, когда объектов много: длинные названия на лист не помещаются
        </div>
      </div>
      <div class="ask-actions ask-actions-wrap">
        <button class="btn" onclick="_caReset()" title="Вернуть зазоры по умолчанию и шрифт выносок — помогает, если «Подобрать под лист» перед этим ужал шрифт и новые настройки как будто не действуют">↺ Сбросить</button>
        <button class="btn" onclick="document.getElementById('ca-dialog').remove()">Отмена</button>
        <button class="btn" onclick="_caFit()" title="Сам подберёт шрифт или номера, чтобы всё поместилось">Подобрать под лист</button>
        <button class="btn pri" onclick="_caApply()">Расставить</button>
      </div>
    </div>`;
  document.body.appendChild(d);
  d.addEventListener('click', e => { if (e.target === d) d.remove(); });

  const link = (a, b) => {
    const ea = document.getElementById(a), eb = document.getElementById(b);
    ea.addEventListener('input', () => { eb.value = ea.value; });
    eb.addEventListener('input', () => { ea.value = eb.value; });
  };
  link('ca-offset', 'ca-offset-n');
  link('ca-gap', 'ca-gap-n');
  link('ca-colgap', 'ca-colgap-n');
};

// «Подобрать под лист» при нехватке места ужимает шрифт выносок ступенями
// вплоть до 7px и, если даже это не помогает уместить всё, оставляет его
// таким — это лучший из достигнутых результатов. Но при повторных запусках
// на плотном проекте это тихо копится: следующий подбор стартует уже с
// урезанного шрифта как с «исходного», и кажется, будто новые зазор/отступ
// ни на что не влияют. Сброс явно возвращает шрифт по умолчанию у всех
// активных выносок и настройки диалога — к заводским.
window._caReset = function() {
  const items = _calloutItems({ emission: true, noise: true, other: true, mp: true, zu: true });
  let n = 0;
  items.forEach(it => { if (it.obj.calloutFontSize != null) { delete it.obj.calloutFontSize; n++; } });
  if (n) {
    items.forEach(it => (it.layers || it.obj.layers || it.obj._calloutLayers || []).forEach(l => { if (l._draw && l._s) l._draw(); }));
    _saveSources();
    if (typeof _saveMonPoints === 'function') _saveMonPoints();
  }
  if (typeof Store !== 'undefined') Store.del('calloutArrange');
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('ca-offset', CALLOUT_ARRANGE_DEFAULTS.minOffset);
  setVal('ca-offset-n', CALLOUT_ARRANGE_DEFAULTS.minOffset);
  setVal('ca-gap', CALLOUT_ARRANGE_DEFAULTS.gap);
  setVal('ca-gap-n', CALLOUT_ARRANGE_DEFAULTS.gap);
  setVal('ca-colgap', CALLOUT_ARRANGE_DEFAULTS.colGap);
  setVal('ca-colgap-n', CALLOUT_ARRANGE_DEFAULTS.colGap);
  setSt(n ? `Настройки сброшены, шрифт выносок возвращён у ${n}` : 'Настройки сброшены', 'ok');
};

// parseInt(...) || default трактует явный 0 как «пусто» и подставляет
// значение по умолчанию — так пользовательский 0 px незаметно превращался
// в 45. NaN — единственный случай, когда поле действительно пустое/битое.
const _caNum = (id, def) => { const v = parseInt((document.getElementById(id) || {}).value, 10); return isNaN(v) ? def : v; };

window._caFit = function() {
  const on = id => { const el = document.getElementById(id); return !!(el && el.checked); };
  const opts = {
    targets: { emission: on('ca-emission'), noise: on('ca-noise'), other: on('ca-other'),
               mp: on('ca-mp'), zu: on('ca-zu') },
    minOffset: _caNum('ca-offset-n', CALLOUT_ARRANGE_DEFAULTS.minOffset),
    gap:       _caNum('ca-gap-n', CALLOUT_ARRANGE_DEFAULTS.gap),
    colGap:    _caNum('ca-colgap-n', CALLOUT_ARRANGE_DEFAULTS.colGap),
  };
  document.getElementById('ca-dialog').remove();
  window.autoArrangeFit(opts);
};

window._caApply = function() {
  const on = id => { const el = document.getElementById(id); return !!(el && el.checked); };
  const opts = {
    targets: { emission: on('ca-emission'), noise: on('ca-noise'), other: on('ca-other'),
               mp: on('ca-mp'), zu: on('ca-zu') },
    minOffset: _caNum('ca-offset-n', CALLOUT_ARRANGE_DEFAULTS.minOffset),
    gap:       _caNum('ca-gap-n', CALLOUT_ARRANGE_DEFAULTS.gap),
    colGap:    _caNum('ca-colgap-n', CALLOUT_ARRANGE_DEFAULTS.colGap),
    numbered:  !!(document.getElementById('ca-numbered') || {}).checked,
  };
  if (typeof Store !== 'undefined')
    Store.set('calloutArrange', { minOffset: opts.minOffset, gap: opts.gap, colGap: opts.colGap });
  document.getElementById('ca-dialog').remove();
  autoArrangeCallouts(opts);
};

// ── Показать/скрыть все выноски (источники + РТ вместе) ─────────────────────
// Замерить масштаб карт ДО массовых правок DOM: после них чтение размеров
// форсирует пересчёт раскладки всей страницы (сотни мс при тысячах выносок).
// Дальше в этой же задаче _mapScale берёт значение из кэша.
function _primeMapScale() {
  if (typeof map !== 'undefined' && map) _mapScale(map);
  if (typeof pdfMap !== 'undefined' && pdfMap) _mapScale(pdfMap);
}
window._primeMapScale = _primeMapScale;

window.toggleAllCalloutsUnified = function() {
  _primeMapScale();
  const srcWith = _sources.filter(s => s.showLabel);
  const mps     = (typeof _monPoints !== 'undefined') ? _monPoints : [];
  const mpWith  = mps.filter(p => p.showLabel);
  const anyOn   = srcWith.length > 0 || mpWith.length > 0;

  if (anyOn) {
    if (typeof hideSourceCalloutsOfType === 'function') hideSourceCalloutsOfType(null);
    if (typeof mpHideAllCallouts === 'function') mpHideAllCallouts();
    setSt('Все выноски скрыты', 'ok');
  } else {
    _sources.forEach(s => _setSrcCallout(s, true));
    _saveSources(); _syncCalloutLayer(); _renderSourcesList();
    if (typeof mpShowAllCallouts === 'function') mpShowAllCallouts();
    if (typeof pdfMap !== 'undefined' && pdfMap && typeof _refreshPdfMapLayers === 'function') _refreshPdfMapLayers();
    setSt('Все выноски показаны', 'ok');
  }
};
window.fitSourcesBounds = () => {
  if (!_sources.length) return;
  const pts = _sources.flatMap(s =>
    (s.geomType === 'line' && s.points) ? s.points : [[s.lat, s.lon]]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
};

// ── Импорт CSV ────────────────────────────────────────────────────────────────
window.importSourcesCSV = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('src-csv-text').value = ev.target.result;
    _autoDetectImportCrs(ev.target.result);
  };
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
};


// ── Разбор строки CSV с координатами ────────────────────────────────────────
// Выгрузки из расчётных программ приходят с двумя болячками сразу:
//   1) разделитель «;», а запятая внутри чисел — десятичная (0,1 / 1253800,98);
//      если резать и по запятой, строка разваливается и импорт молча пустеет;
//   2) в части строк пропадает один «;», и два столбца слипаются:
//      «Y_startX_end» → 44945961248559 (это 4494596 и 1248559).
// Поэтому режем только по «;» и табу, а слипшийся столбец разбираем по длине
// координаты.

// Делитель строки: точка с запятой и таб — приоритетнее запятой
function _csvSplit(line) {
  if (line.indexOf(';') >= 0) return line.split(';').map(c => c.trim());
  if (line.indexOf('\t') >= 0) return line.split('\t').map(c => c.trim());
  return line.split(',').map(c => c.trim());
}

// Число с десятичной запятой или точкой
function _csvNum(v) {
  if (v == null) return NaN;
  const t = String(v).trim().replace(/\s+/g, '').replace(',', '.');
  return t === '' ? NaN : parseFloat(t);
}

// Попытка разделить слипшийся столбец на две координаты.
// intLen — сколько цифр в целой части координаты (для МСК это 7).
// Перебираем точки разреза и берём ту, где обе половины выглядят координатами.
function _csvUnglue(token, intLen) {
  const t = String(token).trim();
  if (!/^\d/.test(t)) return null;
  const okFirst  = new RegExp('^\\d{' + intLen + '}([.,]\\d+)?$');
  const okSecond = new RegExp('^(\\d{' + intLen + '}([.,]\\d+)?|0([.,]0+)?)$');
  for (let i = intLen; i < t.length; i++) {
    const a = t.slice(0, i), b = t.slice(i);
    if (okFirst.test(a) && okSecond.test(b)) return [a, b];
  }
  return null;
}

// Привести строку к нужному числу столбцов, разобрав слипшиеся координаты
function _csvFixRow(cols, want, intLen) {
  if (cols.length >= want) return cols;
  const out = cols.slice();
  for (let pass = 0; pass < 3 && out.length < want; pass++) {
    let done = false;
    for (let i = 0; i < out.length && !done; i++) {
      const parts = _csvUnglue(out[i], intLen);
      if (parts) { out.splice(i, 1, parts[0], parts[1]); done = true; }
    }
    if (!done) break;
  }
  return out;
}

// Сколько цифр в целой части координат — берём по первому внятному числу
function _csvIntLen(lines) {
  for (const line of lines) {
    const cols = _csvSplit(line);
    for (const c of cols.slice(1)) {
      const m = String(c).match(/^(\d+)([.,]\d+)?$/);
      if (m && m[1].length >= 6 && m[1].length <= 8) return m[1].length;
    }
  }
  return 7;   // МСК: X и Y семизначные
}

// Определяем: это формат Integral? (заголовок X_start/Y_start, X1/Y1 или 6 столбцов с большими числами)
function _isIntegralFormat(lines) {
  const h = (lines[0] || '').toLowerCase().replace(/\s+/g, '');
  if (h.includes('x_start') || h.includes('xstart') || h.includes('y_start')) return true;
  if (h.includes('x1') || h.includes('y1') || h.includes('x2') || h.includes('y2')) return true;
  // Проверяем первую строку данных: ≥5 колонок, координаты > 1000
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^[a-zа-яё]/i.test(t)) continue;  // пропустить заголовки
    const cols = _csvSplit(t);
    if (cols.length >= 4) {
      const v1 = _csvNum(cols[1]);
      const v2 = _csvNum(cols[2]);
      if (isFinite(v1) && isFinite(v2) && Math.abs(v1) > 1000 && Math.abs(v2) > 1000) return true;
    }
    break;
  }
  return false;
}

// Текст с починенными строками: определение зоны должно смотреть на реальные
// X и Y, а не на номер из названия («№0001» давал ложную зону 1) и не на
// слипшийся столбец
function _csvNormalizeText(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return text;
  const data = lines.filter(l => /\d{5}/.test(l));
  const intLen = _csvIntLen(data);
  return data.map(l => {
    let cols = _csvSplit(l);
    if (cols.length < 6) cols = _csvFixRow(cols, 6, intLen);
    // Название убираем: оно не координата
    return cols.slice(1).join(';');
  }).join('\n');
}

// Автоматически определяем СК по данным и выбираем в селекторе
function _autoDetectImportCrs(text) {
  if (typeof detectProjectedMSK !== 'function') return;
  const result = detectProjectedMSK(_csvNormalizeText(text));
  if (!result || !result.candidates.length) return;
  const sel = document.getElementById('src-import-crs');
  if (!sel) return;
  // Выбрать первого кандидата
  const best = result.candidates[0];
  if (best) {
    sel.value = best.id;
    if (!sel.value) sel.value = ''; // если нет такого option — сбрасываем
    // По координатам видна только зона: систем с такой зоной десятки, и они
    // дают точки за сотни километров друг от друга. Поэтому не делаем вид,
    // что определили СК точно.
    const n = result.candidates.length;
    setSt(n > 1
      ? `Зона ${result.zone}: подходит систем — ${n}. Поставлена первая «${best.name}» — проверьте, ваша ли это СК`
      : `СК определена автоматически: ${best.name}`, n > 1 ? 'err' : 'ok');
  }
}

// Далеко ли импортированное от того, с чем уже работаем
function _srcFarFromProject(list) {
  if (!list.length || typeof geodDist !== 'function') return 0;
  let ref = null;
  const al = (typeof getActiveLayer === 'function') ? getActiveLayer() : null;
  if (al && al.poly && al.poly.length) {
    ref = L.latLng(al.poly[0][0], al.poly[0][1]);
  } else if (typeof mapLayers !== 'undefined') {
    const g = mapLayers.find(l => l.poly && l.poly.length);
    if (g) ref = L.latLng(g.poly[0][0], g.poly[0][1]);
  }
  if (!ref) return 0;          // сравнивать не с чем — молчим
  const p = list[0];
  try { return geodDist(ref, L.latLng(p.lat, p.lon)) / 1000; } catch (e) { return 0; }
}

window.srcAutoDetectCrs = () => {
  const text = document.getElementById('src-csv-text').value;
  if (!text.trim()) { askNotice('Сначала вставьте данные'); return; }
  _autoDetectImportCrs(text);
};

// Строим <select> для импортного CRS-селектора (только проекционные, без WGS84)
window._buildImportCrsSelect = () => {
  const sel = document.getElementById('src-import-crs');
  if (!sel || typeof CRS_DB === 'undefined') return;
  let html = '<option value="">WGS-84 (координаты уже в градусах)</option>';
  let lastGroup = null;
  for (const c of CRS_DB) {
    if (!c.p4 || c.p4 === 'custom') continue;
    if (c.group !== lastGroup) {
      if (lastGroup !== null) html += '</optgroup>';
      html += `<optgroup label="${c.group}">`;
      lastGroup = c.group;
    }
    html += `<option value="${c.id}">${c.name}</option>`;
  }
  if (lastGroup !== null) html += '</optgroup>';
  sel.innerHTML = html;
};

// Импорт формата Integral: Name;X_start;Y_start;X_end;Y_end;Width  ИЛИ  Name;X1;Y1;X2;Y2;Width
function _importIntegralCSV(lines, crs, defaultType) {
  // Пропустить строку заголовка если есть
  const h = (lines[0] || '').toLowerCase();
  const dataLines = (h.includes('name') || h.includes('x_start') || h.includes('x1') || !/^\d/.test(h.trim()))
    ? lines.slice(1) : lines;

  let added = 0;
  const intLen = _csvIntLen(dataLines);
  let repaired = 0;
  dataLines.forEach(line => {
    let cols = _csvSplit(line);
    if (cols.length < 3) return;
    // Строка короче заголовка — значит, где-то потерялся разделитель
    if (cols.length < 6) {
      const fixed = _csvFixRow(cols, 6, intLen);
      if (fixed.length > cols.length) { repaired++; cols = fixed; }
    }

    const name   = cols[0] || ('Источник ' + (_sources.length + 1));
    const xStart = _csvNum(cols[1]);      // X (northing в российской нотации)
    const yStart = _csvNum(cols[2]);      // Y (easting)
    const xEnd   = cols.length >= 5 ? _csvNum(cols[3]) : 0;
    const yEnd   = cols.length >= 5 ? _csvNum(cols[4]) : 0;
    const width  = cols.length >= 6 ? (_csvNum(cols[5]) || 0) : 0;

    if (isNaN(xStart) || isNaN(yStart)) return;

    // Трансформация в WGS84
    const toWgs = (x, y) => {
      if (crs && crs.p4) return transformToWGS84(x, y, crs);
      if (Math.abs(x) <= 90 && Math.abs(y) <= 180) return [x, y];
      return null;
    };

    const startWgs = toWgs(xStart, yStart);
    if (!startWgs) return;

    const type  = defaultType || 'emission';
    const color = SRC_COLORS[type] || SRC_COLORS.other;
    _srcCounter++;

    const hasEnd = xEnd && yEnd && (Math.abs(xEnd) > 0.001 || Math.abs(yEnd) > 0.001);

    if (hasEnd) {
      // Линейный источник
      const endWgs = toWgs(xEnd, yEnd);
      if (!endWgs) return;
      const s = {
        id: 'src_' + Date.now() + '_' + added, num: _srcCounter, name, type, color,
        geomType: 'line', points: [startWgs, endWgs],
        lat: startWgs[0], lon: startWgs[1], radius: width,
      };
      _sources.push(s); _drawSource(s);
    } else if (width > 0) {
      // Площадной (квадратный) источник
      // Строим 4 угла прямо в WGS84-градусах от центра.
      // hw — полуразмер стороны в метрах; минимум MIN_HW для видимости на карте.
      const MIN_HW = 0.5;                     // минимум 1×1 м — не перекрываются близкие источники
      const hw     = Math.max(width / 2, MIN_HW);
      const dlat   = hw / 111320;             // градусов по широте
      const dlon   = hw / (111320 * Math.cos(startWgs[0] * Math.PI / 180));
      const polygon = [
        [startWgs[0] - dlat, startWgs[1] - dlon],  // SW
        [startWgs[0] - dlat, startWgs[1] + dlon],  // SE
        [startWgs[0] + dlat, startWgs[1] + dlon],  // NE
        [startWgs[0] + dlat, startWgs[1] - dlon],  // NW
      ];
      const s = {
        id: 'src_' + Date.now() + '_' + added, num: _srcCounter, name, type, color,
        geomType: 'area', polygon,
        lat: startWgs[0], lon: startWgs[1], radius: width,   // radius хранит реальный Width (м)
      };
      _sources.push(s); _drawSource(s);
    } else {
      // Точечный источник без размера
      const s = {
        id: 'src_' + Date.now() + '_' + added, num: _srcCounter, name, type, color,
        geomType: 'point', points: [startWgs],
        lat: startWgs[0], lon: startWgs[1], radius: 0,
      };
      _sources.push(s); _drawSource(s);
    }
    added++;
  });
  if (repaired) {
    // Молчать об этом нельзя: пользователь должен знать, что файл кривой
    setSt(`Импортировано: ${added}. В ${repaired} строк(ах) не хватало разделителя — координаты разобраны по длине`, 'ok');
  }
  return added;
}

window.importSourcesText = () => {
  const text = document.getElementById('src-csv-text').value.trim();
  if (!text) { askNotice('Вставьте данные CSV'); return; }
  const lines = text.split('\n').filter(l => l.trim());

  // Если выбрано "Заменить все" — очистить старые источники перед импортом
  if (document.getElementById('src-import-replace')?.checked) {
    Object.values(_srcLayerGroups).forEach(g => g && g.clearLayers());
    _sources = [];
    _srcCounter = 0;
  }

  const crsId = document.getElementById('src-import-crs')?.value || '';
  const crs   = (typeof CRS_DB !== 'undefined') ? CRS_DB.find(c => c.id === crsId) : null;

  // Определяем тип воздействия по умолчанию для Integral-импорта
  const defTypeEl = document.getElementById('src-import-deftype');
  const defaultType = defTypeEl ? defTypeEl.value : 'emission';

  let added = 0;

  if (_isIntegralFormat(lines)) {
    // ── Формат Integral ──────────────────────────────────────────────────
    if (crsId && !crs) { askNotice('Выбранная СК не найдена в базе'); return; }
    added = _importIntegralCSV(lines, crs || null, defaultType);
    if (added > 0) {
      _saveSources(); fitSourcesBounds();
      _syncSourcesLayer();
      // Если импортированное оказалось за сотни километров от участка —
      // почти наверняка выбрана не та система координат
      const far = _srcFarFromProject(_sources.slice(-added));
      if (far > 100) {
        setSt(`Импортировано ${added}, но они в ${Math.round(far)} км от участка — похоже, выбрана не та СК`, 'err');
      } else {
        setSt(`Integral: импортировано ${added} источников`, 'ok');
      }
      srcTab('list');
    } else {
      askNotice('Не удалось импортировать. Проверьте систему координат — координаты не попали в Россию.');
    }
    return;
  }

  // ── Стандартный формат: название; тип; lat; lon; радиус ─────────────────
  lines.forEach(line => {
    const cols = line.split(/[;,\t]/).map(c => c.trim());
    if (cols.length < 4) return;
    const name    = cols[0] || ('Источник ' + (_sources.length + 1));
    const rawType = (cols[1] || 'other').toLowerCase();
    const typeMap = { выброс:'emission', emission:'emission', noise:'noise', шум:'noise' };
    const type    = typeMap[rawType] || 'other';
    const lat     = parseFloat(cols[2]);
    const lon     = parseFloat(cols[3]);
    if (isNaN(lat) || isNaN(lon)) return;
    const radius = cols.length >= 5 ? (parseFloat(cols[4]) || 0) : 0;
    const color  = SRC_COLORS[type] || SRC_COLORS.other;
    _srcCounter++;
    const s = {
      id: 'src_' + Date.now() + '_' + added,
      num: _srcCounter, name, type, color,
      geomType: 'point', points: [[lat, lon]], lat, lon, radius,
    };
    _sources.push(s); _drawSource(s);
    added++;
  });
  _saveSources();
  if (added > 0) {
    fitSourcesBounds();
    _syncSourcesLayer();
    setSt(`Импортировано ${added} источников`, 'ok');
    srcTab('list');
  } else {
    askNotice('Не удалось распознать источники. Проверьте формат CSV.');
  }
};

// ── Топ-бар: каскадное hover-меню источников и РТ ───────────────────────────
window._updateTopSelects = function() {
  const srcList  = document.getElementById('top-src-list');
  const srcCount = document.getElementById('top-src-count');
  if (srcList) {
    srcList.innerHTML = _sources.length
      ? _sources.map(s => {
          const icoId = s.type === 'noise' ? 'ico-speaker' : s.type === 'other' ? 'ico-pin' : 'ico-wind';
          return `<button class="rb-chip" onclick="_jumpToSource('${s.id}')"><svg class="icon icon-sm" style="margin-right:3px;vertical-align:middle"><use href="#${icoId}"/></svg>№${s.num} ${escapeHtml(s.name)}</button>`;
        }).join('')
      : '<span style="font-size:var(--fs-1);color:var(--tx3);padding:0 6px">Нет источников</span>';
  }
  if (srcCount) srcCount.textContent = _sources.length ? ` (${_sources.length})` : '';

  const mpList  = document.getElementById('top-mp-list');
  const mpCount = document.getElementById('top-mp-count');
  if (mpList && typeof _monPoints !== 'undefined') {
    mpList.innerHTML = _monPoints.length
      ? _monPoints.map(pt =>
          `<button class="rb-chip" onclick="_jumpToMonPoint('${pt.id}')">РТ-${pt.num} ${escapeHtml(pt.name)}</button>`
        ).join('')
      : '<span style="font-size:var(--fs-1);color:var(--tx3);padding:0 6px">Нет расчётных точек</span>';
  }
  if (mpCount) mpCount.textContent = (typeof _monPoints !== 'undefined' && _monPoints.length) ? ` (${_monPoints.length})` : '';
};

window._jumpToSource = function(id) {
  const s = _sources.find(x => x.id === id);
  if (!s) return;
  const lat = s.lat ?? (s.points && s.points[0] ? s.points[0][0] : null);
  const lon = s.lon ?? (s.points && s.points[0] ? s.points[0][1] : null);
  if (lat != null && lon != null && typeof map !== 'undefined')
    map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: true });
};

window._jumpToMonPoint = function(id) {
  const pt = (typeof _monPoints !== 'undefined') ? _monPoints.find(x => x.id === id) : null;
  if (!pt) return;
  if (typeof map !== 'undefined') map.setView([pt.lat, pt.lon], Math.max(map.getZoom(), 15), { animate: true });
};

// ── Отрисовка на PDF-карте ────────────────────────────────────────────────────
window._addSourcesToPdfMap = function(targetMap) {
  const layers = [];
  // SVG, а не canvas: html2canvas снимает canvas-слой как растр экранного
  // разрешения, и при экспорте в 3-4× источники получались мыльными
  const cr = L.svg({ padding: 0.5 });
  const _vis = t => (typeof window._layerTypeVisible === 'function') ? window._layerTypeVisible(t) : true;
  _sources.forEach(s => {
    const defColor = s.color || SRC_COLORS[s.type] || '#6b7280';
    // Стиль из панели слоёв для соответствующего типа
    const typeLayerKey = `src-${s.type || 'emission'}`;
    const srcLayerEntry = (typeof mapLayers !== 'undefined') ? mapLayers.find(l => l.type === typeLayerKey) : null;
    if (!_vis(typeLayerKey)) return; // слой скрыт — не рисуем в PDF
    const layerStyle = srcLayerEntry && srcLayerEntry._psStyle && Object.keys(srcLayerEntry._psStyle).length ? srcLayerEntry._psStyle : null;
    const color      = layerStyle ? layerStyle.color      : defColor;
    const fillColor  = layerStyle ? layerStyle.fillColor  : defColor;
    const fillOpacity= layerStyle ? layerStyle.fillOpacity : 0.15;
    const weight     = layerStyle ? layerStyle.weight     : 2;
    const bSt   = { color, fillColor, fillOpacity, weight, renderer: cr };

    if (s.geomType === 'line' && s.points && s.points.length >= 2) {
      const turfCoords = s.points.map(p => [p[1], p[0]]);
      const lineHw = Math.max(s.radius / 2, 2);
      try {
        const buf = _flatBuffer(turfCoords, lineHw / 1000);
        layers.push(L.geoJSON(buf, { style: bSt }).addTo(targetMap));
      } catch(e) {
        layers.push(L.polyline(s.points, { color, weight: 2, opacity: 0.85 }).addTo(targetMap));
      }
    } else if (s.geomType === 'area' && s.polygon && s.polygon.length >= 3) {
      layers.push(L.polygon(s.polygon, bSt).addTo(targetMap));
    } else {
      if (s.radius > 0) {
        // Стиль как у слоя источников, а не зашитые 0.15/2 px
        layers.push(L.circle([s.lat, s.lon], {
          radius: s.radius, color, fillColor, fillOpacity, weight, renderer: cr,
        }).addTo(targetMap));
      }
    }

    // Выноски рисуем только если соответствующий слой выносок не скрыт
    if (s.showLabel && _vis(`src-callouts-${s.type || 'emission'}`)) {
      layers.push(..._makeCalloutLayers(s, targetMap, true));
    }
  });
  return layers;
};
