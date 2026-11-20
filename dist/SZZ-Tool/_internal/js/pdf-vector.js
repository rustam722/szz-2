// ═══════════════════════════════════════════════════════════════════════════
//  Векторный экспорт листа в PDF
//  ---------------------------------------------------------------------------
//  Растровым остаётся только то, что растром и является: тайлы подложки и
//  вставленные картинки. Всё остальное — полигоны, выноски, подписи, масштаб,
//  стрелка севера, фигуры редактора — рисуется примитивами jsPDF, поэтому на
//  А3 и А1 линии и текст остаются резкими при любом увеличении.
//
//  Геометрию берём не из DOM, а из данных: слои проекта проецируются через
//  ту же карту редактора (latLngToContainerPoint), объекты листа — из своих
//  полей. Так результат совпадает с тем, что видно на экране, и не зависит от
//  того, как Leaflet разложил SVG по панелям.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const MM_PER_PT = 0.352777778;   // 1 пункт в миллиметрах

  // Карта редактора объявлена через let в другом скрипте, поэтому в window
  // её нет — обращаемся по имени, а не через window.pdfMap
  const _map = () => (typeof pdfMap !== 'undefined' ? pdfMap : null);

  // ── Цвета ────────────────────────────────────────────────────────────────
  // jsPDF принимает только компоненты, поэтому любой CSS-цвет приводим к RGB
  // и отдельно достаём альфу: прозрачность идёт через GState.
  function _rgba(css, fallbackAlpha) {
    const s = String(css || '').trim();
    if (!s || s === 'transparent' || s === 'none') return null;
    let m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) {
      const h = m[1];
      return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16),
               a: fallbackAlpha == null ? 1 : fallbackAlpha };
    }
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const h = m[1];
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
               a: fallbackAlpha == null ? 1 : fallbackAlpha };
    }
    m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map(v => parseFloat(v));
      if (p.length >= 3 && p.every(v => isFinite(v))) {
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : (fallbackAlpha == null ? 1 : fallbackAlpha) };
      }
    }
    return null;
  }

  // ── Обёртка над документом: миллиметры, прозрачность, шрифт ──────────────
  function _ctx(doc, k) {
    // У заливки и обводки разная прозрачность (например fillOpacity 0.15 у
    // полигона СЗЗ при непрозрачной линии контура), а GState в PDF общая на
    // оба канала сразу. Поэтому держим оба значения отдельно и пересобираем
    // GState только когда что-то из них реально поменялось — иначе fill(),
    // а следом stroke() с другой альфой, затирали прозрачность заливки, и
    // полигон на экспорте выходил сплошным вместо полупрозрачного.
    let curFillA = 1, curStrokeA = 1;
    const applyAlpha = (fillA, strokeA) => {
      const vf = Math.max(0, Math.min(1, fillA == null ? curFillA : fillA));
      const vs = Math.max(0, Math.min(1, strokeA == null ? curStrokeA : strokeA));
      if (Math.abs(vf - curFillA) < 0.001 && Math.abs(vs - curStrokeA) < 0.001) return;
      curFillA = vf; curStrokeA = vs;
      try { doc.setGState(new doc.GState({ opacity: vf, 'stroke-opacity': vs })); } catch (e) {}
    };
    return {
      doc,
      k,                                  // px листа → мм страницы
      mm: (px) => px * k,
      pt: (px) => (px * k) / MM_PER_PT,   // размер шрифта в пунктах
      alpha: (a) => applyAlpha(a, a),
      fill(css, defAlpha) {
        const c = _rgba(css, defAlpha);
        if (!c) return false;
        doc.setFillColor(c.r, c.g, c.b);
        applyAlpha(c.a, null);
        return true;
      },
      stroke(css, widthPx, defAlpha) {
        const c = _rgba(css, defAlpha);
        if (!c || !(widthPx > 0)) return false;
        doc.setDrawColor(c.r, c.g, c.b);
        doc.setLineWidth(Math.max(0.05, widthPx * k));
        applyAlpha(null, c.a);
        return true;
      },
      text(css) {
        const c = _rgba(css) || { r: 17, g: 24, b: 39, a: 1 };
        doc.setTextColor(c.r, c.g, c.b);
        applyAlpha(c.a, null);
      },
      font(sizePx, bold) {
        doc.setFont('DejaVu', bold ? 'bold' : 'normal');
        doc.setFontSize(Math.max(1, (sizePx * k) / MM_PER_PT));
      },
      // dashArray — строка в формате Leaflet ("8,5"), в px листа. Без аргумента
      // или с пустым значением возвращает линию к сплошной: иначе пунктир
      // одного слоя утекал бы в обводку следующего объекта.
      lineDash(dashArrayStr) {
        if (!dashArrayStr) { try { doc.setLineDash([]); } catch (e) {} return; }
        const parts = String(dashArrayStr).split(/[,\s]+/).map(Number).filter(v => isFinite(v) && v >= 0);
        if (!parts.length) { try { doc.setLineDash([]); } catch (e) {} return; }
        try { doc.setLineDash(parts.map(v => Math.max(0.05, v * k))); } catch (e) {}
      },
      reset() { applyAlpha(1, 1); this.lineDash(null); },
    };
  }

  // ── Слои проекта: полигоны с дырками ────────────────────────────────────
  // Раньше список «что рисовать» вектор пересчитывал сам (фильтр по mapLayers),
  // параллельно тому, что уже решает редактор листа для растровой карты
  // (_pdfGeoLayers в js/pdf-editor.js). Эти два решения расходились при любой
  // новой настройке видимости. Теперь вектор берёт готовый список слоёв прямо
  // с pdfMap — ровно те же, что попадают в растровый PDF/PNG.
  function _drawGeoLayers(c) {
    if (typeof _pdfGeoLayers === 'undefined' || !_map()) return 0;
    const M = _map();
    const proj = (lat, lon) => {
      const p = M.latLngToContainerPoint(L.latLng(lat, lon));
      return [c.mm(p.x), c.mm(p.y)];
    };
    // _pdfGeoLayers отсортирован как mapLayers (верх панели — первый элемент),
    // рисуем в обратном порядке, чтобы верхний слой панели лёг поверх остальных
    let n = 0;
    for (let i = _pdfGeoLayers.length - 1; i >= 0; i--) {
      const rec = _pdfGeoLayers[i];
      const l = (typeof mapLayers !== 'undefined') ? mapLayers.find(x => x.id === rec.id) : null;
      if (!l || !rec.gl) continue;
      const st = l._psStyle || { color: l.color, fillColor: l.color, fillOpacity: 0.15, weight: 2 };
      let rings = [];
      try {
        const geo = rec.gl.toGeoJSON();
        const feats = geo.type === 'FeatureCollection' ? geo.features : [geo];
        feats.forEach(f => {
          const g = f.type === 'Feature' ? f.geometry : f;
          if (g.type === 'Polygon') rings.push(g.coordinates);
          else if (g.type === 'MultiPolygon') rings.push(...g.coordinates);
        });
      } catch (e) { continue; }
      // «Прозрачность слоя» — отдельный множитель поверх fillOpacity/opacity,
      // настраивается ползунком в редакторе листа. На экране это CSS-opacity
      // всего слоя целиком, векторный рисовальщик о нём не знал и всегда
      // рисовал слой так, будто ползунок стоит на 100%.
      const layerOp = (st.layerOpacity != null && isFinite(st.layerOpacity))
        ? Math.max(0, Math.min(1, st.layerOpacity)) : 1;
      const fillAlpha   = (st.fillOpacity != null ? st.fillOpacity : 0.15) * layerOp;
      const strokeAlpha = (st.opacity != null ? st.opacity : 1) * layerOp;
      const pattern = st.fillPattern && st.fillPattern !== 'solid' ? st.fillPattern : null;

      rings.forEach(poly => {
        const ringsPx = poly
          .filter(ring => ring && ring.length >= 3)
          .map(ring => ring.map(pt => proj(pt[1], pt[0])));
        if (!ringsPx.length) return;
        // Штриховка (hatch-l/hatch-r/grid) заменяет собой сплошную заливку —
        // ровно как в редакторе, где path получает fill:url(#pattern) вместо
        // сплошного цвета. Сперва штриховка, потом контур поверх нёё.
        if (pattern) _hatchFill(c, ringsPx, st.fillColor || l.color, fillAlpha, pattern);
        // Дырка — это второе и последующие кольца. Заливаем весь контур одним
        // путём по правилу even-odd: вырез остаётся прозрачным и сквозь него
        // видно подложку. Раньше дырка закрашивалась белым, и на спутниковом
        // снимке вместо карты получалось белое пятно.
        const hasFill = !pattern && c.fill(st.fillColor || l.color, fillAlpha);
        c.lineDash(st.dashArray);
        const hasLine = c.stroke(st.color || l.color, st.weight || 2, strokeAlpha);
        _pathRings(c, ringsPx, hasFill, hasLine);
        n += ringsPx.length;
      });
    }
    c.reset();
    return n;
  }

  // Штриховка полигона примитивами PDF: клип по контуру (even-odd, с учётом
  // дырок), поверх — семейство линий с тем же шагом 8px и той же геометрией,
  // что и SVG-паттерн редактора (js/sources.js:_ensureSvgPattern).
  function _hatchFill(c, ringsPx, colorCss, alpha, patternType) {
    if (!ringsPx.length) return;
    const col = _rgba(colorCss, 1);
    if (!col) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ringsPx.forEach(pts => pts.forEach(([x, y]) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }));
    if (!isFinite(minX) || !isFinite(minY)) return;
    const step = 8 * c.k;      // тот же шаг тайла 8px, что в SVG-паттерне
    if (!(step > 0)) return;
    const lw = Math.max(0.05, 1.5 * c.k);
    const pad = step;          // запас за край bbox, чтобы углы были закрыты
    const doc = c.doc;
    try {
      doc.saveGraphicsState();
      const ops = [];
      ringsPx.forEach(pts => {
        ops.push({ op: 'm', c: [pts[0][0], pts[0][1]] });
        for (let i = 1; i < pts.length; i++) ops.push({ op: 'l', c: [pts[i][0], pts[i][1]] });
        ops.push({ op: 'h' });
      });
      doc.path(ops);
      doc.clip('evenodd');
      doc.discardPath();

      doc.setDrawColor(col.r, col.g, col.b);
      doc.setLineWidth(lw);
      try { doc.setGState(new doc.GState({ 'stroke-opacity': Math.max(0, Math.min(1, alpha == null ? 1 : alpha)) })); } catch (e) {}
      try { doc.setLineDash([]); } catch (e) {}

      if (patternType === 'grid') {
        for (let x = minX - pad; x <= maxX + pad; x += step) doc.line(x, minY - pad, x, maxY + pad);
        for (let y = minY - pad; y <= maxY + pad; y += step) doc.line(minX - pad, y, maxX + pad, y);
      } else {
        // hatch-l «\»: семейство y = x + c; hatch-r «/»: семейство y = -x + c.
        // Шаг по c равен шагу тайла — ровно как повтор диагонали в 8×8 паттерне.
        const x1 = minX - pad, x2 = maxX + pad;
        if (patternType === 'hatch-r') {
          for (let cst = (minX + minY) - pad * 2; cst <= (maxX + maxY) + pad * 2; cst += step) {
            doc.line(x1, cst - x1, x2, cst - x2);
          }
        } else {
          for (let cst = (minY - maxX) - pad * 2; cst <= (maxY - minX) + pad * 2; cst += step) {
            doc.line(x1, x1 + cst, x2, x2 + cst);
          }
        }
      }
    } catch (e) {
      // Не удалось — хотя бы сплошная заливка тем же цветом, лучше, чем пусто.
      // Красим напрямую через doc, а не через c.fill(): мы ещё внутри
      // saveGraphicsState(), и обёртка иначе закэшировала бы альфу, которую
      // restoreGraphicsState() в finally отменит, а следующий слой мог бы
      // из-за этого недополучить нужное обновление прозрачности.
      try {
        doc.setFillColor(col.r, col.g, col.b);
        doc.setGState(new doc.GState({ opacity: Math.max(0, Math.min(1, alpha == null ? 1 : alpha)) }));
        _pathRings(c, ringsPx, true, false);
      } catch (e2) {}
    } finally {
      try { doc.restoreGraphicsState(); } catch (e) {}
    }
  }

  // Контур с дырками одним путём. path() принимает абсолютные координаты,
  // fillStrokeEvenOdd/fillEvenOdd закрывают путь по правилу even-odd.
  function _pathRings(c, rings, fill, stroke) {
    if (!rings.length || (!fill && !stroke)) return;
    const ops = [];
    rings.forEach(pts => {
      ops.push({ op: 'm', c: [pts[0][0], pts[0][1]] });
      for (let i = 1; i < pts.length; i++) ops.push({ op: 'l', c: [pts[i][0], pts[i][1]] });
      ops.push({ op: 'h' });
    });
    try {
      c.doc.path(ops);
      if (fill && stroke && c.doc.fillStrokeEvenOdd) c.doc.fillStrokeEvenOdd();
      else if (fill && c.doc.fillEvenOdd)            c.doc.fillEvenOdd();
      else if (stroke && c.doc.stroke)               c.doc.stroke();
      else if (c.doc.discardPath)                    c.doc.discardPath();
    } catch (e) {
      // Старая сборка jsPDF без path(): рисуем кольца по отдельности,
      // дырку хотя бы обводим, чтобы вырез был виден
      rings.forEach((pts, ri) => _path(c, pts, true, ri === 0 && fill, stroke));
    }
  }

  // Общая отрисовка ломаной; jsPDF рисует пути относительными сегментами
  function _path(c, pts, closed, fill, stroke) {
    if (!pts.length || (!fill && !stroke)) return;
    const segs = [];
    for (let i = 1; i < pts.length; i++) segs.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    const style = fill && stroke ? 'FD' : fill ? 'F' : 'S';
    try { c.doc.lines(segs, pts[0][0], pts[0][1], [1, 1], style, !!closed); } catch (e) {}
  }

  // ── Источники и РТ ───────────────────────────────────────────────────────
  // В векторном режиме подложку-тайлы снимают с картой без оверлеев
  // (_hideForTiles в pdf-editor.js прячет leaflet-overlay-pane перед снимком),
  // а сами значки источников и РТ рисовались только в растровом PDF — здесь
  // их не рисовал никто, и в векторном экспорте они просто пропадали.
  function _pxRadiusForMeters(M, lat, lon, meters, c) {
    if (!(meters > 0)) return 0;
    const p0 = M.latLngToContainerPoint(L.latLng(lat, lon));
    const p1 = M.latLngToContainerPoint(L.latLng(lat + meters / 111320, lon));
    return c.mm(Math.hypot(p1.x - p0.x, p1.y - p0.y));
  }

  // Источники берём не из сырых данных _sources (буферизация линии в turf
  // заново, в обход того, что уже посчитано для растра), а прямо с pdfMap —
  // из _pdfSourceLayers, которые строит _addSourcesToPdfMap в pdf-editor.js.
  // Это те же самые Leaflet-фигуры (круг/полигон/буфер линии), что видит
  // растровый PDF, один в один, а не отдельный пересчёт со своими огрехами
  // (мелкие источники — короткие буферизованные линии — выходили то крупнее,
  // то мельче и неровнее, чем на самом деле).
  function _drawSources(c) {
    if (typeof _pdfSourceLayers === 'undefined' || !_map()) return 0;
    const M = _map();
    const proj = (lat, lon) => { const p = M.latLngToContainerPoint(L.latLng(lat, lon)); return [c.mm(p.x), c.mm(p.y)]; };
    let n = 0;
    _pdfSourceLayers.forEach(layer => {
      if (layer instanceof L.Circle) {
        const center = layer.getLatLng();
        const r = _pxRadiusForMeters(M, center.lat, center.lng, layer.getRadius(), c);
        if (!(r > 0)) return;
        const [cx, cy] = proj(center.lat, center.lng);
        const opt = layer.options || {};
        const hasFill = c.fill(opt.fillColor || opt.color, opt.fillOpacity);
        const hasLine = c.stroke(opt.color, opt.weight);
        if (hasFill || hasLine) c.doc.circle(cx, cy, r, hasFill && hasLine ? 'FD' : hasFill ? 'F' : 'S');
        n++;
        return;
      }
      if (!(layer instanceof L.Polygon) && !(layer instanceof L.GeoJSON)) return;   // не геометрия источника — пропускаем (выноска и т.п.)
      let geo;
      try { geo = layer.toGeoJSON(); } catch (e) { return; }
      const feats = geo.type === 'FeatureCollection' ? geo.features : [geo];
      // Стиль: у L.Polygon — свои options, у L.geoJSON(...) — на первом дочернем слое
      const opt = (layer.options && layer.options.color) ? layer.options
                : (layer.getLayers && layer.getLayers()[0] && layer.getLayers()[0].options) || {};
      feats.forEach(f => {
        const g = f.type === 'Feature' ? f.geometry : f;
        let rings = [];
        if (g.type === 'Polygon') rings = [g.coordinates];
        else if (g.type === 'MultiPolygon') rings = g.coordinates;
        rings.forEach(poly => {
          const ringsPx = poly.filter(r => r && r.length >= 3).map(ring => ring.map(pt => proj(pt[1], pt[0])));
          if (!ringsPx.length) return;
          const hasFill = c.fill(opt.fillColor || opt.color, opt.fillOpacity);
          const hasLine = c.stroke(opt.color, opt.weight);
          _pathRings(c, ringsPx, hasFill, hasLine);
          n++;
        });
      });
    });
    c.reset();
    return n;
  }

  function _mpVisible(pt) {
    return (typeof window._mpVisiblePublic === 'function') ? window._mpVisiblePublic(pt) : pt.hidden !== true;
  }

  function _drawMonPoints(c) {
    if (typeof _monPoints === 'undefined' || !_map()) return 0;
    const M = _map();
    let n = 0;
    _monPoints.forEach(pt => {
      if (!_mpVisible(pt) || !isFinite(pt.lat) || !isFinite(pt.lon)) return;
      const p = M.latLngToContainerPoint(L.latLng(pt.lat, pt.lon));
      const cx = c.mm(p.x), cy = c.mm(p.y);
      const r = c.mm(7);           // тот же фиксированный радиус 7px, что и у circleMarker в _addMonPointsToPdfMap
      const pst = pt._psStyle || {};
      const color = pt.color || '#3b82f6';
      const hasFill = c.fill(color, pst.fillOpacity != null ? pst.fillOpacity : 0.85);
      const hasLine = c.stroke(color, pst.weight != null ? pst.weight : 2, pst.opacity != null ? pst.opacity : 1);
      if (hasFill || hasLine) c.doc.circle(cx, cy, r, hasFill && hasLine ? 'FD' : hasFill ? 'F' : 'S');
      n++;
    });
    c.reset();
    return n;
  }

  // ── Выноски: линия, полка, текст ────────────────────────────────────────
  // Берём те же поля, что рисует ShelfLeader на экране.
  function _calloutList() {
    const out = [];
    const add = (o, anchor) => {
      if (!o || !isFinite(o.calloutLat) || !isFinite(o.calloutLon)) return;
      out.push({ o, anchor });
    };
    // Видимость группы «Выноски» — тот же чип в панели редактора, что и у
    // растровой карты (_addSourcesToPdfMap/_addMonPointsToPdfMap). Векторный
    // путь его не спрашивал и печатал подписи источников и РТ даже после
    // того, как пользователь выключал чип «Выноски».
    const _vis = (t) => (typeof window._layerTypeVisible === 'function') ? window._layerTypeVisible(t) : true;
    if (typeof _sources !== 'undefined') {
      _sources.forEach(s => {
        if (s.showLabel && _vis(`src-${s.type || 'emission'}`) && _vis(`src-callouts-${s.type || 'emission'}`)) add(s, null);
      });
    }
    if (typeof _monPoints !== 'undefined' && _vis('mp-callouts')) {
      _monPoints.forEach(p => {
        if (p.showLabel && _mpVisible(p)) add(p, [p.lat, p.lon]);
      });
    }
    if (typeof mapLayers !== 'undefined') {
      mapLayers.forEach(l => {
        if (l.callout && l.callout.on && l.visible !== false) add(l.callout, null);
      });
    }
    return out;
  }

  function _drawCallouts(c) {
    const M = _map();
    if (!M) return 0;
    const list = _calloutList();

    // Сначала считаем геометрию всех выносок, и только потом рисуем: сперва
    // все линии, затем все подписи. Рисовать выноску целиком за раз нельзя —
    // линия следующей ложилась поверх уже напечатанного названия предыдущей
    // и перечёркивала его. В PDF порядок вывода и есть порядок наложения.
    const plan = [];
    list.forEach(({ o, anchor }) => {
      const a = anchor || (typeof window._srcAnchorPublic === 'function' ? window._srcAnchorPublic(o) : null);
      if (!a || !isFinite(a[0]) || !isFinite(a[1])) return;
      const name = String(o.name == null ? '' : o.name);
      if (!name) return;
      const p1 = M.latLngToContainerPoint(L.latLng(a[0], a[1]));
      const p2 = M.latLngToContainerPoint(L.latLng(o.calloutLat, o.calloutLon));

      const fs      = o.calloutFontSize || 12;
      const color   = o.calloutColor || '#111827';
      const lw      = o.calloutLineWidth || 1.5;
      const tColor  = o.calloutTextColor || color;
      const strokeW = o.calloutStrokeWidth == null ? 2 : o.calloutStrokeWidth;
      const strokeC = o.calloutStrokeColor || '#ffffff';
      const dir     = (o.calloutDir === 1 || o.calloutDir === -1) ? o.calloutDir : (p2.x >= p1.x ? 1 : -1);

      // Ширину меряем тем же кеглем, каким потом печатаем
      c.font(fs, true);
      const textW = c.doc.getTextWidth(name) / c.k;       // ширина в px листа
      const shelfW = Math.max(textW + 8, 10);

      plan.push({
        name, fs, color, lw, tColor, strokeW, strokeC, textW,
        p1, p2, p3x: p2.x + dir * shelfW,
        line: o.showLeaderLine !== false,
        tx: dir > 0 ? p2.x + 4 : p2.x - 4 - textW,
        ty: p2.y - 4,
      });
    });

    // Ярус 1 — линии и полки
    plan.forEach(t => {
      if (!t.line) return;
      if (!c.stroke(t.color, t.lw)) return;
      c.doc.line(c.mm(t.p1.x), c.mm(t.p1.y), c.mm(t.p2.x), c.mm(t.p2.y));
      c.doc.line(c.mm(t.p2.x), c.mm(t.p2.y), c.mm(t.p3x),  c.mm(t.p2.y));
    });

    // Ярус 2 — подписи. На экране это SVG <text> с paint-order:stroke и
    // stroke/stroke-width на самих буквах — обводка глифов рисуется ПЕРВОЙ,
    // а заливка поверх неё, поэтому в центре буквы всегда виден сплошной
    // цвет текста, а белая обводка остаётся только по контуру (halo).
    // PDF-режим 'fillThenStroke' красит в обратном порядке (заливка, потом
    // обводка ПОВЕРХ неё) — при обводке толще самих штрихов буквы это просто
    // закрашивало всю букву белым. Поэтому рисуем текст дважды: сперва
    // только обводкой (подложка-контур), потом только заливкой поверх.
    if (plan.length) { try { c.doc.setLineJoin('round'); } catch (e) {} }
    plan.forEach(t => {
      c.font(t.fs, true);
      if (t.strokeW > 0 && c.stroke(t.strokeC, t.strokeW * 2)) {
        c.doc.text(t.name, c.mm(t.tx), c.mm(t.ty - t.fs * 0.15), {
          baseline: 'alphabetic', renderingMode: 'stroke',
        });
      }
      c.text(t.tColor);
      c.doc.text(t.name, c.mm(t.tx), c.mm(t.ty - t.fs * 0.15), {
        baseline: 'alphabetic', renderingMode: 'fill',
      });
    });
    if (plan.length) { try { c.doc.setLineJoin('miter'); } catch (e) {} }

    c.reset();
    return plan.length;
  }

  // ── Объекты листа ───────────────────────────────────────────────────────
  function _objText(c, d, text) {
    if (!text) return;
    const lines = String(text).split('\n');
    const fs = d.fontSize || 14;
    c.font(fs, String(d.fontWeight || '400') >= '600' || d.fontWeight === 'bold');
    c.text(d.color);
    const lh = fs * 1.25;
    // Текст вписан в коробку объекта: считаем от её верха с той же выключкой
    const startY = d.y + (d.h - lines.length * lh) / 2 + fs * 0.9;
    lines.forEach((ln, i) => {
      const w = c.doc.getTextWidth(ln) / c.k;
      let x = d.x + 6;
      if (d.textAlign === 'center') x = d.x + (d.w - w) / 2;
      if (d.textAlign === 'right')  x = d.x + d.w - w - 6;
      c.doc.text(ln, c.mm(x), c.mm(startY + i * lh));
    });
  }

  function _objBox(c, d) {
    const hasFill = c.fill(d.bg);
    const hasLine = c.stroke(d.strokeColor, d.strokeW);
    if (!hasFill && !hasLine) return;
    const style = hasFill && hasLine ? 'FD' : hasFill ? 'F' : 'S';
    const r = Math.min(d.radius || 0, Math.min(d.w, d.h) / 2);
    if (r > 0.5) c.doc.roundedRect(c.mm(d.x), c.mm(d.y), c.mm(d.w), c.mm(d.h), c.mm(r), c.mm(r), style);
    else         c.doc.rect(c.mm(d.x), c.mm(d.y), c.mm(d.w), c.mm(d.h), style);
  }

  // Снимок DOM-объекта растром, вставленный в PDF как картинка на месте
  // объекта. Используется там, где честно пересобрать примитивами жалко
  // смысла — легенда (8 разных HTML/CSS-раскладок), картинка, лупа.
  async function _drawRasterObj(c, d, obj, rasterFallback) {
    if (!rasterFallback) return;
    let snap = null;
    try { snap = await rasterFallback(obj); } catch (e) {}
    if (!snap || !snap.data) return;
    try { c.doc.addImage(snap.data, snap.fmt || 'PNG', c.mm(d.x), c.mm(d.y), c.mm(d.w), c.mm(d.h), undefined, 'FAST'); }
    catch (e) {}
  }

  async function _drawObj(c, obj, rasterFallback) {
    const d = obj.data || {};
    if (obj.visible === false) return;
    const t = obj.type;

    if (t === 'rect' || t === 'text') { _objBox(c, d); _objText(c, d, d.content); return; }

    if (t === 'ellipse') {
      const hasFill = c.fill(d.bg);
      const hasLine = c.stroke(d.strokeColor, d.strokeW);
      const style = hasFill && hasLine ? 'FD' : hasFill ? 'F' : 'S';
      if (hasFill || hasLine) {
        c.doc.ellipse(c.mm(d.x + d.w / 2), c.mm(d.y + d.h / 2), c.mm(d.w / 2), c.mm(d.h / 2), style);
      }
      _objText(c, d, d.content);
      return;
    }

    if (t === 'line') {
      if (!c.stroke(d.strokeColor, d.strokeW)) return;
      const a = (d.rotation || 0) * Math.PI / 180;
      const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
      const dx = Math.cos(a) * d.w / 2, dy = Math.sin(a) * d.w / 2;
      c.doc.line(c.mm(cx - dx), c.mm(cy - dy), c.mm(cx + dx), c.mm(cy + dy));
      return;
    }

    if (t === 'arrow') {
      const p = (typeof _arrowPtsPublic === 'function') ? _arrowPtsPublic(d)
              : { x1: d.ax1, y1: d.ay1, x2: d.ax2, y2: d.ay2 };
      if (!isFinite(p.x1)) return;
      if (!c.stroke(d.strokeColor, d.strokeW)) return;
      c.doc.line(c.mm(p.x1), c.mm(p.y1), c.mm(p.x2), c.mm(p.y2));
      // Наконечник — залитый треугольник у конца
      const ang = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
      const hl = Math.max(8, (d.strokeW || 3) * 3.2);
      const hw = hl * 0.55;
      const bx = p.x2 - Math.cos(ang) * hl, by = p.y2 - Math.sin(ang) * hl;
      const nx = -Math.sin(ang), ny = Math.cos(ang);
      if (c.fill(d.strokeColor)) {
        _path(c, [[c.mm(p.x2), c.mm(p.y2)],
                  [c.mm(bx + nx * hw / 2), c.mm(by + ny * hw / 2)],
                  [c.mm(bx - nx * hw / 2), c.mm(by - ny * hw / 2)]], true, true, false);
      }
      return;
    }

    if (t === 'path' || t === 'bezier') {
      const pts = (d.pts || []).filter(p => p && isFinite(p.x) && isFinite(p.y));
      if (pts.length < 2) return;
      const hasFill = d.closed && c.fill(d.bg);
      const hasLine = c.stroke(d.strokeColor, d.strokeW);
      _path(c, pts.map(p => [c.mm(p.x), c.mm(p.y)]), !!d.closed, hasFill, hasLine);
      return;
    }

    if (t === 'callout' || t === 'leader' || t === 'src-leader') {
      // Линия к острию (у полочки источника есть промежуточный излом)
      if (c.stroke(d.strokeColor, d.strokeW || 1.5)) {
        const bx = d.x + d.w / 2, by = d.y + d.h;
        if (t === 'src-leader' && isFinite(d.kneeX)) {
          c.doc.line(c.mm(d.x), c.mm(d.y + d.h), c.mm(d.kneeX), c.mm(d.kneeY));
          c.doc.line(c.mm(d.kneeX), c.mm(d.kneeY), c.mm(d.tailX), c.mm(d.tailY));
        } else if (isFinite(d.tailX)) {
          c.doc.line(c.mm(bx), c.mm(by), c.mm(d.tailX), c.mm(d.tailY));
        }
      }
      if (t === 'callout') _objBox(c, d);
      else if (c.stroke(d.strokeColor, d.strokeW || 1.5)) {
        // Полочка под текстом
        c.doc.line(c.mm(d.x), c.mm(d.y + d.h), c.mm(d.x + d.w), c.mm(d.y + d.h));
      }
      _objText(c, d, d.content);
      return;
    }

    if (t === 'legend') {
      // У легенды 8 раскладок (колонки, таблица, карточки с рамкой…), задаются
      // HTML/CSS в редакторе (_legendHtml в pdf-editor.js). Переписывать каждую
      // координатами jsPDF — значит держать два описания одной раскладки
      // синхронными вручную; раньше так и было, и однострочный вектор обрезал
      // ровно те пункты (РТ, границу), что в двухколоночном HTML помещались.
      // Вместо этого фотографируем реальный DOM-блок — раскладка гарантированно
      // та же, что видит пользователь на экране.
      await _drawRasterObj(c, d, obj, rasterFallback);
      return;
    }

    if (t === 'scale') {
      _objBox(c, d);
      const m = (typeof _scaleMetricsPublic === 'function') ? _scaleMetricsPublic(d, _map()) : null;
      if (!m) return;
      const fs = d.fontSize || 12;
      const x0 = d.x + 6, y0 = d.y + d.h - fs - 10, barH = 7;
      const half = m.barPx / 2;
      // Две клетки: залитая и пустая — обычная линейка масштаба
      if (c.fill(d.color)) c.doc.rect(c.mm(x0), c.mm(y0), c.mm(half), c.mm(barH), 'F');
      if (c.stroke(d.color, 1)) {
        c.doc.rect(c.mm(x0), c.mm(y0), c.mm(m.barPx), c.mm(barH), 'S');
        c.doc.line(c.mm(x0 + half), c.mm(y0), c.mm(x0 + half), c.mm(y0 + barH));
      }
      c.font(fs * 0.85, false);
      c.text(d.color);
      c.doc.text('0', c.mm(x0), c.mm(y0 - 3));
      c.doc.text(String(m.halfLabel), c.mm(x0 + half - 4), c.mm(y0 - 3));
      c.doc.text(String(m.label), c.mm(x0 + m.barPx - 10), c.mm(y0 - 3));
      c.font(fs, true);
      c.doc.text('1 : ' + Number(m.ratio).toLocaleString('ru'), c.mm(x0), c.mm(y0 + barH + fs + 2));
      return;
    }

    if (t === 'north') {
      const cx = d.x + d.w / 2;
      const top = d.y + 4, bottom = d.y + d.h - (d.fontSize || 10) - 4;
      if (c.fill(d.color)) {
        _path(c, [[c.mm(cx), c.mm(top)],
                  [c.mm(cx + d.w * 0.22), c.mm(bottom)],
                  [c.mm(cx), c.mm(bottom - d.h * 0.18)],
                  [c.mm(cx - d.w * 0.22), c.mm(bottom)]], true, true, false);
      }
      c.font(d.fontSize || 10, true);
      c.text(d.color);
      const w = c.doc.getTextWidth('С') / c.k;
      c.doc.text('С', c.mm(cx - w / 2), c.mm(d.y + d.h - 2));
      return;
    }

    // Картинки и лупа остаются растровыми — это и есть растр. Раньше здесь
    // звали rasterFallback(obj) без await и результат никуда не девали —
    // колбэк никто не передавал, и объект просто пропадал из PDF.
    if (t === 'image' || t === 'inset') { await _drawRasterObj(c, d, obj, rasterFallback); return; }
  }

  // ── Главная функция ──────────────────────────────────────────────────────
  window.renderPdfVectorSheet = async function (doc, opts) {
    const o = opts || {};
    const canvas = document.getElementById('pdf-canvas');
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    const land = (typeof pdfOrientation !== 'undefined' ? pdfOrientation : 'portrait') === 'landscape';
    const pageW = land ? 297 : 210;
    const k = pageW / W;

    const c = _ctx(doc, k);

    // 1. Подложка — единственное, что остаётся растром
    if (o.tiles) doc.addImage(o.tiles.data, o.tiles.fmt, 0, 0, pageW, land ? 210 : 297, undefined, 'FAST');

    // 2. Геометрия проекта, источники и РТ поверх неё, затем выноски поверх всего
    const nLayers = _drawGeoLayers(c);
    const nSrc    = _drawSources(c);
    const nMp     = _drawMonPoints(c);
    const nCall   = _drawCallouts(c);

    // 3. Объекты листа — снизу вверх, как на экране. _drawObj асинхронный
    // (легенда/картинка/лупа идут через html2canvas), поэтому ждём по очереди,
    // а не forEach — тот не дождался бы ни одного await внутри.
    let nObj = 0;
    const list = (typeof pdfObjects !== 'undefined' ? pdfObjects : []).slice().reverse();
    for (const obj of list) {
      try { await _drawObj(c, obj, o.rasterObj); nObj++; } catch (e) { /* один объект не должен рушить экспорт */ }
    }
    c.reset();
    return { layers: nLayers, sources: nSrc, monpoints: nMp, callouts: nCall, objects: nObj, mmPerPx: k };
  };

  // Наружу — для отладки и тестов
  window._pdfVecColor = _rgba;
})();
