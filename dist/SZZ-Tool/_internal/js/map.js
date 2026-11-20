// ═══════════════════════════════════════════════
// MAP.JS — карта, рисование, управление слоями
// ═══════════════════════════════════════════════

'use strict';

// Адрес прокси приходит из app-config.js (динамический порт); 8767 — запуск из исходников
const _NSPD_PROXY = (window.APP_CONFIG && window.APP_CONFIG.proxy) || 'http://127.0.0.1:8767';

let map, cad;
let currentBasemap = 'osm';
let BASEMAPS = {};
let zouitLayers = [];

// Конфиг оверлейных слоёв НСПД
const OV = {
  cad:      { lid:'36048',  label:'ЗУ (участки)',          group:'cadastre', clickable:true,  canAdd:true,  layer:null, on:false },
  kvartal:  { lid:'36071',  label:'Кадастровые кварталы',  group:'cadastre', clickable:true,  canAdd:true,  layer:null, on:false },
  oks:      { lid:'36049',  label:'Здания (ОКС)',           group:'cadastre', clickable:true,  canAdd:true,  layer:null, on:false },
  zouit:    { lid:null,     lids:['37577','37578','37579','37580','37581'],
              label:'ЗОУИТ',                  group:'zones',    clickable:true,  canAdd:true,  layer:null, on:false },
  pzz:      { lid:'875838', label:'Терр. зоны (ПЗЗ)',      group:'zones',    clickable:true,  canAdd:true,  layer:null, on:false },
  redlines: { lid:'879243', label:'Красные линии',          group:'zones',    clickable:true,  canAdd:false, layer:null, on:false },
  np:       { lid:'875831', label:'Населённые пункты',      group:'territory',clickable:true,  canAdd:true,  layer:null, on:false },
};
let tool     = null;
let polyPts  = [];
let polyLine = null;
let polyMkrs = [];
let mapLayers    = [];
let activeLayerId = null;
let draggedLayerIdx = null;
let useSat   = false;
let parcelMkrs = [];
let foundParcels = [];
let zoomRectActive = false, zoomRectDrawing = false, zoomRectStart = {};
let selectedParcelCn  = null;
let selectedParcelCns = new Set(); // мультивыделение (Shift+клик)
const _MULTI_STYLE = { color: '#7c3aed', fillColor: '#a78bfa', fillOpacity: 0.35, weight: 2.5, dashArray: '5 4' };
let _excludedLayerId = null;
let _excludedLayerOrigStyle = null;
let _donutPreviewLayer = null;
let _layerSubExpanded = {}; // { layerId: bool } — развёрнутые подсписки источников/РТ
let _copiedLayer = null;   // буфер копирования слоя

// ── Настройки авто-слоёв (источники, РТ, выноски) ──────────────────────────
// Эти слои не имеют собственной геометрии (poly === null) и пересоздаются при
// каждой загрузке проекта из _srcLoadData/_mpLoadData. Раньше они всегда
// возвращались видимыми со сброшенным стилем — из-за этого «РТ появлялись»
// после переключения слоя и терялись настройки при смене проекта.
// Здесь храним последние настройки по типу слоя; они же уходят в состояние вкладки.
let _autoLayerPrefs = {};  // { [type]: { visible, color, _psStyle } }

// Расчётные точки — обычные слои, но их у одного типа много, поэтому ключ
// для настроек и порядка берём по самой точке, а не по типу слоя
const _layerKey = l => (l.mpId ? 'mp:' + l.mpId : l.poly ? 'id:' + l.id : 'type:' + l.type);
// Тот же ключ нужен легенде: id авто-слоёв пересоздаются при каждой загрузке
// проекта, и настройки легенды, привязанные к ним, переставали совпадать
window.layerStableKey = _layerKey;

// Настройки авто-слоя данного типа (или null)
window._autoLayerPref = function(type) { return _autoLayerPrefs[type] || null; };

// Запомнить настройки авто-слоя (видимость/цвет/стиль)
window._rememberAutoLayer = function(l) {
  if (!l || l.poly) return;
  if (l.mpId) return;      // у слоя-точки своё состояние, оно живёт в самой РТ
  _autoLayerPrefs[l.type] = {
    visible: l.visible !== false,
    color:   l.color,
    _psStyle: l._psStyle ? { ...l._psStyle } : {},
  };
};

// Привести фактическое присутствие группы на карте в соответствие с флагом visible
window._reconcileLayerVis = function(l) {
  if (!l || !l.layer || typeof map === 'undefined' || !map) return;
  const on = map.hasLayer(l.layer);
  if (l.visible !== false && !on) {
    map.addLayer(l.layer);
    if (typeof window._reapplyLayerStyle === 'function') window._reapplyLayerStyle(l);
  }
  if (l.visible === false && on)  map.removeLayer(l.layer);
  // Выноска слоя живёт вместе со слоем: скрыли группу — ушли и подписи
  if (l.callout && l.callout.on) { if (l.visible === false) _clearLayerCallout(l); else _drawLayerCallout(l); }
};

// Виден ли слой данного типа (для отрисовки в PDF-редакторе). Если открыт
// редактор листа — видимость может быть переопределена для ТЕКУЩЕГО листа
// (pdfSheets[i].layerVis, см. _pdfSheetVisiblePublic в pdf-editor.js); если
// переопределения нет — используется общий флаг, как и раньше.
window._layerTypeVisible = function(type, def = true) {
  // Слои-точки пропускаем: они одного типа с «РТ», но отвечают каждый за себя
  const l = mapLayers.find(x => x.type === type && !x.mpId);
  let base;
  if (l) base = l.visible !== false;
  else { const p = _autoLayerPrefs[type]; base = p ? p.visible !== false : def; }
  // Переопределение по листу действует только пока открыт сам редактор PDF —
  // иначе видимость, заданная для листа, протекала бы на основную карту.
  const pdfEditorEl = document.getElementById('pdf-editor');
  if (pdfEditorEl && pdfEditorEl.style.display !== 'none' && typeof window._pdfSheetVisiblePublic === 'function') {
    return window._pdfSheetVisiblePublic(l || { type, visible: base });
  }
  return base;
};

// Снимок настроек авто-слоёв + порядок панели — для состояния проекта
window._captureLayerPrefs = function() {
  const auto = {};
  Object.entries(_autoLayerPrefs).forEach(([t, p]) => { auto[t] = { ...p }; });
  mapLayers.filter(l => !l.poly && !l.mpId).forEach(l => {
    auto[l.type] = { visible: l.visible !== false, color: l.color,
                     _psStyle: l._psStyle ? { ...l._psStyle } : {} };
  });
  return { auto, order: mapLayers.map(_layerKey) };
};

// Подставить настройки ДО пересоздания авто-слоёв (вызывать перед _srcLoadData/_mpLoadData)
window._setLayerPrefs = function(prefs) {
  _autoLayerPrefs = {};
  const auto = (prefs && prefs.auto) || null;
  if (!auto) return;
  Object.entries(auto).forEach(([t, p]) => {
    if (!p) return;
    _autoLayerPrefs[t] = { visible: p.visible !== false, color: p.color,
                           _psStyle: p._psStyle ? { ...p._psStyle } : {} };
  });
};

// Применить настройки и порядок ПОСЛЕ того как все слои созданы
window._applyLayerPrefs = function(prefs) {
  const auto = (prefs && prefs.auto) || {};
  Object.entries(auto).forEach(([type, p]) => {
    const l = mapLayers.find(x => x.type === type && !x.mpId);
    if (!l || !p) return;
    l.visible = p.visible !== false;
    if (p.color) l.color = p.color;
    if (p._psStyle && Object.keys(p._psStyle).length) l._psStyle = { ...p._psStyle };
    window._reconcileLayerVis(l);
  });
  const order = (prefs && prefs.order) || null;
  if (order && order.length) {
    const rank = new Map(order.map((k, i) => [k, i]));
    mapLayers = mapLayers
      .map((l, i) => ({ l, i }))
      .sort((a, b) => {
        const ra = rank.has(_layerKey(a.l)) ? rank.get(_layerKey(a.l)) : order.length + a.i;
        const rb = rank.has(_layerKey(b.l)) ? rank.get(_layerKey(b.l)) : order.length + b.i;
        return ra - rb || a.i - b.i;
      })
      .map(x => x.l);
  }
  _syncLayerOrder();
  renderLayers();
};

// ── Перемещение полигона ───────────────────────────────────────────────────
let _polyMoveLayerId = null;
let _polyMoveMarker  = null;

// ── Редактирование вершин ──────────────────────────────────────────────────
let _editLayerId  = null;
let _editVerts    = [];      // [[lat,lon], ...] рабочая копия
let _editMkrs     = [];      // vertex markers
let _editMidMkrs  = [];      // midpoint markers
let _editPreview  = null;    // preview polyline
let _editToolbar  = null;    // floating toolbar DOM el

const CATEGORIES = {
  '003001000000': 'Земли сельскохозяйственного назначения',
  '003002000000': 'Земли населённых пунктов',
  '003003000000': 'Земли промышленности, энергетики, транспорта, связи, радиовещания, телевидения, информатики, земли для обеспечения космической деятельности, земли обороны, безопасности и земли иного специального назначения',
  '003004000000': 'Земли особо охраняемых территорий и объектов',
  '003005000000': 'Земли лесного фонда',
  '003006000000': 'Земли водного фонда',
  '003007000000': 'Земли запаса',
  '1': 'Земли сельскохозяйственного назначения',
  '2': 'Земли населённых пунктов',
  '3': 'Земли промышленности, энергетики, транспорта, связи, радиовещания, телевидения, информатики, земли для обеспечения космической деятельности, земли обороны, безопасности и земли иного специального назначения',
  '4': 'Земли особо охраняемых территорий и объектов',
  '5': 'Земли лесного фонда',
  '6': 'Земли водного фонда',
  '7': 'Земли запаса',
};

// Инициализация селектора СК проекта
window._initProjectCrsSelect = function() {
  const sel = document.getElementById('project-crs-select');
  if (!sel) return;
  let html = '<option value="wgs84">WGS-84 (геодезические °)</option>';
  let lastGroup = null;
  CRS_DB.forEach(c => {
    if (!c.p4) return;
    if (c.group !== lastGroup) {
      if (lastGroup !== null) html += '</optgroup>';
      html += `<optgroup label="${c.group}">`;
      lastGroup = c.group;
    }
    html += `<option value="${c.id}">${c.name}</option>`;
  });
  if (lastGroup !== null) html += '</optgroup>';
  sel.innerHTML = html;
  // Восстанавливаем последнее значение
  const saved = localStorage.getItem('szztool_crs') || 'wgs84';
  sel.value = saved;
  // Синхронизируем вкладку «Координаты»
  const coordSel = document.getElementById('crs-select');
  if (coordSel && saved !== 'wgs84') coordSel.value = saved;
};

function initMap() {
  map = L.map('map', {
    center: [62.0, 74.0],
    zoom: 10,
    zoomControl: true,
    attributionControl: false,
    wheelPxPerZoomLevel: 80,
    zoomSnap: 0.1,
    zoomDelta: 0.5,
  });

  document.getElementById('map').addEventListener('wheel', e => {
    if (!e.altKey && !e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    map.setZoom(map.getZoom() + delta, { animate: true });
  }, { passive: false, capture: true });

  BASEMAPS = {
    osm:    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19, keepBuffer: 4 }),
    sat:    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: '© Esri', maxZoom: 19, keepBuffer: 4 }),
  };
  BASEMAPS.osm.addTo(map);

  const _wms = (lid, opacity, zIndex) => L.tileLayer.wms(_NSPD_PROXY + '/nspd-wms', {
    layers: String(lid), format: 'image/png', transparent: true,
    version: '1.3.0', opacity, attribution: '© НСПД', zIndex,
    // keepBuffer: тайлы вокруг экрана не выбрасываются — панорамирование без «дыр».
    // updateWhenZooming:false — не дёргаем НСПД на промежуточных зумах анимации.
    keepBuffer: 4, updateWhenIdle: true, updateWhenZooming: false,
  });

  OV.cad.layer     = _wms('36048',  0.85, 500);
  OV.kvartal.layer = _wms('36071',  0.80, 483);
  OV.oks.layer     = _wms('36049',  0.90, 495);
  OV.pzz.layer     = _wms('875838', 0.70, 485);
  OV.redlines.layer= _wms('879243', 0.90, 488);
  OV.np.layer      = _wms('875831', 0.60, 484);

  // ЗОУИТ: 5 отдельных слоёв
  zouitLayers = [37578, 37580, 37577, 37579, 37581].map(id => _wms(id, 0.75, 490));
  OV.zouit.layer = zouitLayers; // массив — обрабатывается в toggleOverlay отдельно

  // compat alias (старые функции в коде могут ещё использоваться)
  cad = OV.cad.layer;


  map.on('click', e => {
    if (document.getElementById('pdf-editor').style.display !== 'none') return;
    if (zoomRectActive) return;
    // Ctrl перехватывает клик раньше всего: полигон мог не получить событие,
    // если сверху лежит другой слой или клик пришёлся на заливку без обводки.
    const _nat = e.originalEvent;
    if (_nat && (_nat.ctrlKey || _nat.metaKey)) { window._ctrlPickAt(e.latlng); return; }
    // Идёт выделение области поиска — точки собирает search.js
    if (typeof _saIsActive === 'function' && _saIsActive()) return;
    if (typeof _mpIsAdding === 'function' && _mpIsAdding()) return;
    if (_msMode) { _msAddPt(e.latlng); return; }
    if (tool === 'poly') addPolyPt(e.latlng.lat, e.latlng.lng);
    else _nspdMapClick(e);
  });

  map.on('dblclick', e => {
    if (document.getElementById('pdf-editor').style.display !== 'none') return;
    if (_msMode && _msPts.length >= (_msMode === 'area' ? 3 : 2)) {
      L.DomEvent.stopPropagation(e);
      _msFinish();
      return;
    }
    if (tool === 'poly' && polyPts.length >= 3) {
      L.DomEvent.stopPropagation(e);
      closePoly();
    }
  });

  L.control.scale({ imperial: false }).addTo(map);

  const coordsDiv = document.createElement('div');
  coordsDiv.id = 'map-coords';
  document.getElementById('map-wrapper').appendChild(coordsDiv);
  map.on('mousemove', e => {
    coordsDiv.textContent = `${e.latlng.lat.toFixed(6)}°  ${e.latlng.lng.toFixed(6)}°`;
    if (_msMode && _msPts.length && !_msDone) _msUpdate(e.latlng);
  });
  map.on('mouseout', () => { coordsDiv.textContent = ''; });

  initZoomRect();
  buildCrsSelect();
  const _savedCrs = localStorage.getItem('szztool_crs');
  if (_savedCrs) {
    const _sel = document.getElementById('crs-select');
    if ([..._sel.options].some(o => o.value === _savedCrs)) {
      _sel.value = _savedCrs;
      onCrsChange();
    }
  }
}

function setTool(t, force) {
  const wasActive = !force && tool === t;
  tool = wasActive ? null : (t === null ? null : t);
  ['poly', 'coords'].forEach(x => {
    const btn = document.getElementById('t-' + x);
    const active = x === tool;
    if (btn) btn.classList.toggle('active', active);
  });
  if (tool !== 'poly') finishPolyDraw();
  if (tool !== null) cancelPolyEdit();
}

function addPolyPt(lat, lon) {
  polyPts.push([lat, lon]);
  const m = L.circleMarker([lat, lon], {
    radius: 5, color: '#3b82f6',
    fillColor: '#0e1117', fillOpacity: 1, weight: 2,
  }).addTo(map);
  polyMkrs.push(m);

  if (polyLine) map.removeLayer(polyLine);
  if (polyPts.length > 1) {
    polyLine = L.polyline([...polyPts, polyPts[0]], {
      color: '#3b82f6', weight: 1.5, dashArray: '4,4',
    }).addTo(map);
  }

  document.getElementById('btn-close-poly').disabled = polyPts.length < 3;
  setSt(`Рисование: ${polyPts.length} вершин (двойной клик — завершить)`);
}

function closePoly() {
  if (polyPts.length < 3) return;
  const pts = [...polyPts];
  finishPolyDraw();

  const cfg = getStyleCfg();
  const ll  = pts.map(p => L.latLng(p[0], p[1]));
  const layer = L.polygon(ll, {
    color: '#f59e0b', weight: cfg.parcelW,
    fillColor: '#f59e0b', fillOpacity: 0.15,
    dashArray: dashByType(cfg.lineType),
  }).addTo(map);

  addMapLayer('parcel', `Участок ${mapLayers.filter(l => l.type === 'parcel').length + 1}`, pts, layer);
  map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  setSt('Участок построен. Теперь постройте СЗЗ.', 'ok');
}

function finishPolyDraw() {
  polyPts = [];
  polyMkrs.forEach(m => map.removeLayer(m));
  polyMkrs = [];
  if (polyLine) { map.removeLayer(polyLine); polyLine = null; }
  document.getElementById('btn-close-poly').disabled = true;
}

function undoPolyPt() {
  if (!polyPts.length) return;
  polyPts.pop();
  const m = polyMkrs.pop();
  if (m) map.removeLayer(m);
  if (polyLine) map.removeLayer(polyLine);
  if (polyPts.length > 1) {
    polyLine = L.polyline([...polyPts, polyPts[0]], {
      color: '#3b82f6', weight: 1.5, dashArray: '4,4',
    }).addTo(map);
  } else { polyLine = null; }
  document.getElementById('btn-close-poly').disabled = polyPts.length < 3;
  setSt(`Рисование: ${polyPts.length} вершин`);
}

// ── Измерения: линейка (расстояние) и площадь ────────────────────────────────
let _msMode = null;          // 'dist' | 'area' | null
let _msPts = [], _msMkrs = [], _msLine = null, _msFill = null, _msTip = null;
let _msDone = false;

// Во время измерения полигоны ЗУ, источники и метки не должны перехватывать
// клики: раньше клик по участку открывал его карточку вместо постановки точки.
function _msSetPassThrough(on) {
  const c = map && map.getContainer && map.getContainer();
  if (c) c.classList.toggle('ms-passthrough', !!on);
}

window.toggleMeasure = function(mode) {
  const turnOff = _msMode === mode;
  _msClear();
  _msMode = turnOff ? null : mode;
  _msBtns();
  if (turnOff) {
    map.doubleClickZoom.enable();
    _msSetPassThrough(false);
    setSt('Измерение выключено');
    return;
  }
  map.doubleClickZoom.disable();
  _msSetPassThrough(true);
  setTool(null, true);
  setSt(mode === 'dist'
    ? 'Линейка: клик — точка, двойной клик — завершить, Esc — выход'
    : 'Площадь: клик — вершина, двойной клик — завершить, Esc — выход');
};

function _msBtns() {
  const bD = document.getElementById('rb-btn-ms-dist');
  const bA = document.getElementById('rb-btn-ms-area');
  if (bD) bD.classList.toggle('active', _msMode === 'dist');
  if (bA) bA.classList.toggle('active', _msMode === 'area');
}

function _msClear() {
  if (!_msMode) _msSetPassThrough(false);
  _msPts = []; _msDone = false;
  _msMkrs.forEach(m => map.removeLayer(m)); _msMkrs = [];
  if (_msLine) { map.removeLayer(_msLine); _msLine = null; }
  if (_msFill) { map.removeLayer(_msFill); _msFill = null; }
  if (_msTip)  { map.removeLayer(_msTip);  _msTip = null; }
}

function _fmtDist(m) {
  return m < 1000 ? m.toFixed(1) + ' м' : (m / 1000).toFixed(3) + ' км';
}
function _fmtArea(m2) {
  if (m2 < 10000) return m2.toFixed(1) + ' м²';
  if (m2 < 1e7)   return (m2 / 10000).toFixed(3) + ' га';
  return (m2 / 1e6).toFixed(3) + ' км²';
}

// Геодезическое расстояние по эллипсоиду WGS-84 (обратная задача Винсенти), м.
// Leaflet/turf меряют по сфере R=6371 км — на 62° с.ш. это ‑0.3% (997 м вместо 1000)
function geodDist(p1, p2) {
  const a = 6378137, b = 6356752.314245, f = 1 / 298.257223563;
  const rad = Math.PI / 180;
  const L = (p2.lng - p1.lng) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(p1.lat * rad));
  const U2 = Math.atan((1 - f) * Math.tan(p2.lat * rad));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lam = L, lamP, iter = 100;
  let sinSig, cosSig, sig, cos2Alpha, cos2SigM;
  do {
    const sinLam = Math.sin(lam), cosLam = Math.cos(lam);
    sinSig = Math.sqrt((cosU2 * sinLam) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLam) ** 2);
    if (sinSig === 0) return 0;
    cosSig = sinU1 * sinU2 + cosU1 * cosU2 * cosLam;
    sig = Math.atan2(sinSig, cosSig);
    const sinAlpha = cosU1 * cosU2 * sinLam / sinSig;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigM = cos2Alpha ? cosSig - 2 * sinU1 * sinU2 / cos2Alpha : 0;
    const C = f / 16 * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    lamP = lam;
    lam = L + (1 - C) * f * sinAlpha *
      (sig + C * sinSig * (cos2SigM + C * cosSig * (-1 + 2 * cos2SigM * cos2SigM)));
  } while (Math.abs(lam - lamP) > 1e-12 && --iter);
  const u2 = cos2Alpha * (a * a - b * b) / (b * b);
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSig = B * sinSig * (cos2SigM + B / 4 * (cosSig * (-1 + 2 * cos2SigM * cos2SigM) -
    B / 6 * cos2SigM * (-3 + 4 * sinSig * sinSig) * (-3 + 4 * cos2SigM * cos2SigM)));
  return b * A * (sig - dSig);
}

function _msTotal(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += geodDist(pts[i - 1], pts[i]);
  return s;
}

function _msAreaVal(pts) {
  // Площадь в локальной метрической проекции на эллипсоиде WGS-84
  // (радиусы кривизны M и N на средней широте) — точнее сферического turf.area
  if (pts.length < 3) return 0;
  const rad = Math.PI / 180, a = 6378137, e2 = 0.00669437999014;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length * rad;
  const lon0 = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
  const s0 = Math.sin(lat0), w = Math.sqrt(1 - e2 * s0 * s0);
  const N = a / w;                       // радиус кривизны первого вертикала
  const M = a * (1 - e2) / (w * w * w);  // меридианный радиус кривизны
  const xy = pts.map(p => [
    (p.lng - lon0) * rad * N * Math.cos(p.lat * rad),
    (p.lat * rad - lat0) * M,
  ]);
  let s = 0;
  for (let i = 0; i < xy.length; i++) {
    const j = (i + 1) % xy.length;
    s += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1];
  }
  return Math.abs(s) / 2;
}

function _msUpdate(cursor) {
  const pts = (cursor && !_msDone) ? [..._msPts, cursor] : [..._msPts];
  if (_msLine) { map.removeLayer(_msLine); _msLine = null; }
  if (_msFill) { map.removeLayer(_msFill); _msFill = null; }
  if (pts.length < 2) return;
  const closed = _msMode === 'area';
  _msLine = L.polyline(closed && pts.length >= 3 ? [...pts, pts[0]] : pts,
    { color: '#f43f5e', weight: 2, dashArray: '6,4', interactive: false }).addTo(map);
  if (closed && pts.length >= 3) {
    _msFill = L.polygon(pts, { stroke: false, fillColor: '#f43f5e', fillOpacity: 0.08, interactive: false }).addTo(map);
  }
  const text = (_msMode === 'dist' || pts.length < 3)
    ? _fmtDist(_msTotal(pts))
    : _fmtArea(_msAreaVal(pts));
  const anchor = pts[pts.length - 1];
  if (!_msTip) {
    _msTip = L.tooltip({ permanent: true, direction: 'right', offset: [12, 0], className: 'ms-tip' })
      .setLatLng(anchor).setContent(text).addTo(map);
  } else {
    _msTip.setLatLng(anchor).setContent(text);
  }
}

function _msAddPt(latlng) {
  if (_msDone) _msClear();   // клик после завершённого замера начинает новый
  _msPts.push(latlng);
  const m = L.circleMarker(latlng, {
    radius: 4, color: '#f43f5e', fillColor: '#fff', fillOpacity: 1, weight: 2, interactive: false,
  }).addTo(map);
  _msMkrs.push(m);
  _msUpdate(null);
}

function _msFinish() {
  _msDone = true;
  _msUpdate(null);
  const res = _msMode === 'dist' ? _fmtDist(_msTotal(_msPts)) : _fmtArea(_msAreaVal(_msPts));
  setSt((_msMode === 'dist' ? 'Расстояние: ' : 'Площадь: ') + res + '  (клик — новый замер, Esc — выход)', 'ok');
}

// ── Горячие клавиши карты (у PDF-редактора свои) ─────────────────────────────
document.addEventListener('keydown', e => {
  const pdfEl = document.getElementById('pdf-editor');
  if (pdfEl && pdfEl.style.display !== 'none') return;
  const t = e.target;
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;

  if (e.key === 'Escape') {
    // Режимы выбора точки/линии источников обрабатывают Esc сами (sources.js)
    if (typeof _pickCallback !== 'undefined' && _pickCallback) return;
    if (typeof _lineDrawActive !== 'undefined' && _lineDrawActive) return;
    if (typeof _mpIsAdding === 'function' && _mpIsAdding()) { mpStopAddByClick(); return; }
    if (typeof _saIsActive === 'function' && _saIsActive()) { cancelSearchArea(); return; }
    if (_msMode) { toggleMeasure(_msMode); return; }
    if (_editLayerId) { cancelPolyEdit(); return; }
    if (tool === 'poly' && polyPts.length) { finishPolyDraw(); setSt('Рисование отменено'); return; }
    if (tool) {
      const home = document.querySelector('.mb-tab[data-tab="home"]');
      if (home && typeof _tabSwitch === 'function') _tabSwitch(home);
      else setTool(null, true);
    }
    return;
  }
  if (e.key === 'Enter' && tool === 'poly' && polyPts.length >= 3) {
    e.preventDefault();
    closePoly();
    return;
  }
  // e.code — работает и в русской раскладке (Ctrl+Я)
  // Ctrl+S — сохранить в тот же файл, Ctrl+Shift+S — сохранить как
  // Ctrl+Z / Ctrl+Y — отмена и повтор действий на карте
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey && tool !== 'poly') {
    e.preventDefault(); mapUndo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || (e.shiftKey && e.code === 'KeyZ'))) {
    e.preventDefault(); mapRedo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
    e.preventDefault();
    if (e.shiftKey) { if (typeof saveProjectAs === 'function') saveProjectAs(); }
    else            { if (typeof saveProject   === 'function') saveProject(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && tool === 'poly' && polyPts.length) {
    e.preventDefault();
    undoPolyPt();
  }
});

// Перестройка полигона слоя по rawCoords в новой СК; возвращает true при успехе
function _reprojectLayer(al, newCrsId) {
  if (!al || !al.rawCoords) return false;
  const crs = CRS_DB.find(c => c.id === newCrsId);
  if (!crs && newCrsId !== 'wgs84') return false;
  const pts = [];
  const isGeo = !crs || !crs.p4;
  for (const line of al.rawCoords.split('\n')) {
    if (!line.trim()) continue;
    if (isGeo) {
      const pt = parseCoordLine(line);
      if (pt) pts.push(pt);
    } else {
      const nums = line.match(/-?\d+(?:[.,]\d+)?/g);
      if (!nums || nums.length < 2) continue;
      const a = parseFloat(nums[0].replace(',', '.')), b = parseFloat(nums[1].replace(',', '.'));
      if (!isFinite(a) || !isFinite(b)) continue;
      const pt = transformToWGS84(a, b, crs);
      if (pt) pts.push(pt);
    }
  }
  if (pts.length < 3) return false;
  al.crsId = newCrsId;
  al.poly = pts;
  try {
    const ll = pts.map(p => L.latLng(p[0], p[1]));
    al.layer.setLatLngs(ll);
  } catch(e) {}
  return true;
}

function onLayerCrsChange() {
  const al = getActiveLayer();
  if (!al || !['parcel', 'szz'].includes(al.type)) return;
  const newCrsId = document.getElementById('lp-crs').value;
  al.crsId = newCrsId;
  if (!al.rawCoords) {
    setSt('Система координат сохранена', 'ok');
    return;
  }
  if (_reprojectLayer(al, newCrsId)) {
    map.fitBounds(al.layer.getBounds(), { padding: [40, 40] });
    const crs = CRS_DB.find(c => c.id === newCrsId);
    setSt(`СК слоя изменена на ${crs ? crs.name : 'WGS-84'}`, 'ok');
  } else {
    setSt('Недостаточно точек для выбранной СК', 'err');
  }
}

// Смена СК всего проекта — перестраивает все слои с rawCoords
window.onProjectCrsChange = function() {
  const sel = document.getElementById('project-crs-select');
  if (!sel) return;
  const crsId = sel.value;
  // Синхронизируем со вкладкой «Координаты»
  const coordSel = document.getElementById('crs-select');
  if (coordSel) coordSel.value = crsId;
  localStorage.setItem('szztool_crs', crsId);
  // Перестраиваем все слои с rawCoords
  let count = 0;
  mapLayers.forEach(l => {
    if (!l.rawCoords || !['parcel', 'szz'].includes(l.type)) return;
    if (_reprojectLayer(l, crsId)) count++;
  });
  // Синхронизируем отображение СК в панели стиля
  if (activeLayerId) {
    const al = mapLayers.find(l => l.id === activeLayerId);
    const lpCrs = document.getElementById('lp-crs');
    if (al && lpCrs && ['parcel', 'szz'].includes(al.type)) lpCrs.value = al.crsId || crsId;
  }
  if (count > 0) {
    const allBounds = mapLayers.filter(l => l.poly && l.layer && l.layer.getBounds)
      .map(l => { try { return l.layer.getBounds(); } catch(e) { return null; } })
      .filter(Boolean);
    if (allBounds.length) map.fitBounds(allBounds.reduce((a, b) => a.extend(b)), { padding: [30, 30] });
    setSt(`СК проекта изменена, перестроено слоёв: ${count}`, 'ok');
  } else {
    setSt('СК проекта обновлена', 'ok');
  }
};

function onCrsChange() {
  const val = document.getElementById('crs-select').value;
  document.getElementById('crs-custom-row').style.display = val === 'custom' ? 'block' : 'none';
  document.getElementById('crs-auto-msg').style.display = 'none';
  localStorage.setItem('szztool_crs', val);
}

let _crsDetectTimer = null;
function onCoordsInput() {
  clearTimeout(_crsDetectTimer);
  _crsDetectTimer = setTimeout(() => {
    const raw = document.getElementById('coords-input').value;
    const det = detectProjectedMSK(raw);
    const msg = document.getElementById('crs-auto-msg');
    const sel = document.getElementById('crs-select');
    if (!det || !det.candidates.length) { msg.style.display = 'none'; return; }
    if (sel.value === 'wgs84') {
      const names = [...new Set(det.candidates.slice(0, 5).map(c => c.group))].join(', ');
      msg.style.display = 'block';
      msg.innerHTML = `⚠ Проекционные координаты (зона ${det.zone ?? '?'}).<br>Выберите СК: ${names}`;
    } else {
      msg.style.display = 'none';
    }
  }, 400);
}

function buildFromCoords() {
  const raw = document.getElementById('coords-input').value.trim();
  if (!raw) return;

  const crsId = document.getElementById('crs-select').value;
  const crs = crsId === 'custom'
    ? { id: 'custom', p4: document.getElementById('crs-custom-p4').value.trim(), x0: null }
    : CRS_DB.find(c => c.id === crsId);
  const isGeo = !crs || !crs.p4;

  const pts = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (isGeo) {
      const pt = parseCoordLine(line);
      if (pt) pts.push(pt); else skipped++;
    } else {
      const nums = line.match(/-?\d+(?:[.,]\d+)?/g);
      if (!nums || nums.length < 2) { skipped++; continue; }
      const a = parseFloat(nums[0].replace(',', '.')), b = parseFloat(nums[1].replace(',', '.'));
      if (!isFinite(a) || !isFinite(b)) { skipped++; continue; }
      const pt = transformToWGS84(a, b, crs);
      if (pt) pts.push(pt); else skipped++;
    }
  }

  if (pts.length < 3) {
    setSt(`Нужно минимум 3 точки${skipped ? ` (строк не распознано: ${skipped})` : ''}`, 'err');
    return;
  }

  const cfg = getStyleCfg();
  const ll  = pts.map(p => L.latLng(p[0], p[1]));
  const layer = L.polygon(ll, {
    color: '#f59e0b', weight: cfg.parcelW,
    fillColor: '#f59e0b', fillOpacity: 0.15,
  }).addTo(map);

  const _ml = addMapLayer('parcel', `Участок ${mapLayers.filter(l => l.type === 'parcel').length + 1}`, pts, layer);
  _ml.crsId = crsId;
  _ml.rawCoords = raw;
  map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  document.getElementById('coords-input').value = '';
  document.getElementById('crs-auto-msg').style.display = 'none';
  setSt(`Построен участок из ${pts.length} точек${skipped ? `, пропущено: ${skipped}` : ''}`, 'ok');
}

async function generateSzz() {
  const al = getActiveLayer();
  if (!al || al.type !== 'parcel') { setSt('Выбери слой ЗУ', 'err'); return; }

  const cfg = getStyleCfg();

  // Точный метрический буфер на Python (shapely + pyproj, ошибка — сантиметры).
  let bufPts = null;
  let exact = false;
  try {
    const resp = await fetch(_NSPD_PROXY + '/buffer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poly: al.poly, dist: cfg.buffer }),
    });
    if (resp.ok) {
      const d = await resp.json();
      if (d.poly && d.poly.length >= 4) { bufPts = d.poly; exact = true; }
    }
  } catch (e) {}

  // Запасной путь — turf в браузере (сфера, завышает ~0.3%)
  if (!bufPts) {
    const ring = al.poly.map(p => [p[1], p[0]]);
    ring.push(ring[0]);
    const poly = turf.polygon([ring]);
    const buf  = turf.buffer(poly, cfg.buffer / 1000, { units: 'kilometers', steps: 64 });
    // buffer может вернуть MultiPolygon — берём внешнее кольцо самой большой части
    const g = buf.geometry;
    let outerRing;
    if (g.type === 'MultiPolygon') {
      let best = g.coordinates[0], bestA = -1;
      for (const part of g.coordinates) {
        const a = turf.area(turf.polygon(part));
        if (a > bestA) { bestA = a; best = part; }
      }
      outerRing = best[0];
    } else {
      outerRing = g.coordinates[0];
    }
    bufPts = outerRing.map(c => [c[1], c[0]]);
  }

  const layer = L.polygon(bufPts.map(p => L.latLng(p[0], p[1])), {
    color: '#c084fc', weight: cfg.szzW,
    fillColor: '#c084fc', fillOpacity: 0.1,
    dashArray: dashByType(cfg.lineType),
  }).addTo(map);

  const szzLayer = addMapLayer('szz', `СЗЗ ${cfg.buffer}м`, bufPts, layer, al.id);
  szzLayer.bufferM = cfg.buffer; // для формулы выноски — {buffer}
  setSt(`СЗЗ ${cfg.buffer}м построена` + (exact ? ' (точный расчёт)' : ' (приближённый расчёт)'), 'ok');
}

// Какие слои накрывают точку клика. Нужен перебор: СЗЗ всегда лежит поверх
// своего ЗУ, и без него до участка щелчком не добраться.
function _layersAtLatLng(latlng) {
  const pt = [latlng.lng, latlng.lat];
  return mapLayers.filter(l => {
    if (!l.visible || !l.poly || l.poly.length < 3) return false;
    try {
      const ring = l.poly.map(p => [p[1], p[0]]);
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
      return turf.booleanPointInPolygon(turf.point(pt), turf.polygon([ring]));
    } catch (e) { return false; }
  });
}

let _ctrlPickLast = null;   // точка прошлого Ctrl-клика и выбранный на ней слой

// Ctrl + ЛКМ — выбрать объект на карте: подсветить в списке, показать свойства.
// Без Ctrl обычный клик занят запросом к Росреестру и рисованием, его не трогаем.
window._ctrlPickAt = function (latlng, preferId) {
  const under = _layersAtLatLng(latlng);
  if (!under.length) return false;
  // Повторный клик в ту же точку — уходим на слой ниже
  const same = _ctrlPickLast && map.distance(latlng, _ctrlPickLast.latlng) < 5;
  let next = under[0];
  if (same) {
    const i = under.findIndex(l => l.id === _ctrlPickLast.id);
    next = under[(i + 1) % under.length];
  } else if (preferId != null) {
    next = under.find(l => l.id === preferId) || under[0];
  }
  _ctrlPickLast = { latlng, id: next.id };
  selectLayer(next.id);
  if (under.length > 1) setSt(`${next.name} · ещё ${under.length - 1} под курсором, Ctrl+клик — следующий`, 'ok');
  return true;
};

function _bindPolyCtx(id, leafletLayer) {
  if (!leafletLayer || typeof leafletLayer.on !== 'function') return;
  leafletLayer.on('click', e => {
    const native = (e && e.originalEvent) ? e.originalEvent : e;
    if (!native || !(native.ctrlKey || native.metaKey)) return;   // без Ctrl — обычное поведение
    L.DomEvent.stopPropagation(e);
    if (native.preventDefault) native.preventDefault();
    window._ctrlPickAt(e.latlng, id);
  });
  leafletLayer.on('contextmenu', e => {
    const native = (e && e.originalEvent) ? e.originalEvent : e;
    if (native && native.preventDefault)   native.preventDefault();
    if (native && native.stopPropagation)  native.stopPropagation();
    selectLayer(id);          // подсветить слой в списке
    layerContextMenu(native, id);
  });
}

// Уникальный id слоя: Date.now() давал одинаковые номера слоям, созданным
// в одну миллисекунду (импорт, восстановление проекта), и они путались
// в панели, легенде и настройках
let _layerIdLast = 0;
window._newLayerId = function() {
  const t = Date.now();
  _layerIdLast = t > _layerIdLast ? t : _layerIdLast + 1;
  return _layerIdLast;
};

function addMapLayer(type, name, poly, leafletLayer, parentId = null) {
  if (typeof mapUndoPush === 'function') mapUndoPush('добавление слоя');
  const id = _newLayerId();
  const colors = { parcel: '#f59e0b', szz: '#c084fc',
    kvartal: '#22d3ee', oks: '#f472b6', pzz: '#a3e635',
    red_line: '#ef4444', settlement: '#60a5fa', zouit: '#fb923c' };
  const defColor = colors[type] || '#3b82f6';
  const lo = leafletLayer.options || {};
  const _psStyle = {
    fillColor:   lo.fillColor   ?? defColor,
    color:       lo.color       ?? defColor,
    fillOpacity: lo.fillOpacity ?? (type === 'szz' ? 0.10 : 0.15),
    opacity:     lo.opacity     ?? 1,
    weight:      lo.weight      ?? 2,
    dashArray:   lo.dashArray   ?? null,
  };
  const defZoneType = type === 'szz' ? 'szz' : type === 'parcel' ? 'zu' : null;
  const layer = { id, type, name, poly, layer: leafletLayer, visible: true, parentId,
                  color: lo.color ?? defColor, _psStyle, zoneType: defZoneType };
  mapLayers.unshift(layer);
  activeLayerId = id;
  _bindPolyCtx(id, leafletLayer);
  renderLayers();
  updateButtons();
  updatePdfOverlays();
  if (window.Workspace) showLayerProps(layer);
  return layer;
}

function getActiveLayer() {
  return mapLayers.find(l => l.id === activeLayerId);
}

function getStyleCfg() {
  return {
    buffer:  parseFloat(document.getElementById('szz-buffer-m').value) || 1000,
    szzW:    parseFloat(document.getElementById('szz-line-width').value) || 3,
    parcelW: parseFloat(document.getElementById('parcel-line-width').value) || 2,
    lineType: document.getElementById('szz-line-type').value,
  };
}

function dashByType(t) {
  return t === 'dashed' ? '8,5' : t === 'dotted' ? '2,6' : null;
}

// Фильтр панели слоёв: строка поиска + тип
function _layerMatchesFilter(l) {
  const q = (document.getElementById('layer-search') || {}).value || '';
  const t = (document.getElementById('layer-type-filter') || {}).value || '';
  if (q.trim()) {
    const s = (l.name || '') + ' ' + (l.type || '');
    if (!s.toLowerCase().includes(q.trim().toLowerCase())) return false;
  }
  if (t) {
    const ty = l.type || '';
    if (t === 'src'      && !(ty.startsWith('src-') && !ty.startsWith('src-callouts')) && ty !== 'sources') return false;
    if (t === 'mp'       && ty !== 'monpoints') return false;
    if (t === 'callouts' && !ty.includes('callouts')) return false;
    if (['parcel','szz','search-area'].includes(t) && ty !== t) return false;
  }
  return true;
}

function renderLayers() {
  const box = document.getElementById('layer-box');
  if (!mapLayers.length) {
    box.innerHTML = '<div class="empty">Нет слоёв. Нарисуй участок.</div>';
    showLayerProps(null);
    return;
  }

  const parts = [];
  let _shown = 0;
  const _renderedGroups = new Set();
  mapLayers.forEach((l, idx) => {
    if (!_layerMatchesFilter(l)) return;
    // Заголовки групп цепочки (с учётом вложенности) — перед первым слоем.
    // Вернёт true, если строку показывать не надо: свёрнут кто-то из предков.
    if (window._uxEmitGroupHeaders && window._uxEmitGroupHeaders(parts, l.groupId, _renderedGroups)) return;
    _shown++;
    const isSrc    = l.type === 'sources' || l.type === 'src-emission' || l.type === 'src-noise' || l.type === 'src-other' || l.type === 'src-callouts' || l.type === 'src-callouts-emission' || l.type === 'src-callouts-noise' || l.type === 'src-callouts-other';
    const isMonPt  = l.type === 'monpoints';
    const isMpCall = l.type === 'mp-callouts';
    const isCalloutLayer = l.type === 'src-callouts-emission' || l.type === 'src-callouts-noise' || l.type === 'src-callouts-other' || l.type === 'src-callouts' || l.type === 'mp-callouts';
    // Миниатюра рисуется ровно тем стилем, каким слой отрисован на карте:
    // раньше бралась обводка вместо заливки и «пунктир» ставился всем СЗЗ,
    // из-за чего в списке был один стиль, а на карте другой
    const style    = l._psStyle || {};
    const fillOp   = Math.round((style.fillOpacity ?? (l.type === 'szz' ? 0.10 : 0.15)) * 100);
    const fillCol  = style.fillColor || l.color;
    const strokeCol= style.color     || l.color;
    const thumbBg  = (isSrc || isMpCall) ? 'transparent'
                   : isMonPt            ? hexToRgba(fillCol, 0.85)
                   : hexToRgba(fillCol, fillOp / 100);
    const dash     = style.dashArray;
    const borderSt = !dash ? 'solid' : /^2\s*,/.test(String(dash)) ? 'dotted' : 'dashed';
    const borderW  = Math.max(1, Math.min(3, Math.round(style.weight ?? 2)));
    // Штриховка в миниатюре — как на карте
    const pat = style.fillPattern && style.fillPattern !== 'solid' ? style.fillPattern : null;
    const patBg = !pat ? '' :
      pat === 'grid'
        ? `background-image:repeating-linear-gradient(0deg,${fillCol} 0 1px,transparent 1px 5px),repeating-linear-gradient(90deg,${fillCol} 0 1px,transparent 1px 5px);`
        : `background-image:repeating-linear-gradient(${pat === 'hatch-r' ? '-45deg' : '45deg'},${fillCol} 0 1px,transparent 1px 4px);`;
    const BADGE_MAP = { 'src-emission':'ИСТ атм', 'src-noise':'ИСТ шум', 'src-other':'ИСТ', 'sources':'ИСТ',
      'src-callouts':'ИСТ вын', 'src-callouts-emission':'ВЫН атм', 'src-callouts-noise':'ВЫН шум', 'src-callouts-other':'ВЫН',
      'mp-callouts':'РТ вын', 'monpoints':'РТ', 'parcel':'ЗУ', 'szz':'СЗЗ', 'search-area':'ОБЛ' };
    const ZONE_LABEL_MAP = {
      zu:'ЗУ', szz:'СЗЗ', site:'Площадка',
      industrial:'Пром зона', residential:'Жилая зона',
      'Ж1':'Ж1','Ж2':'Ж2','Ж3':'Ж3','Ж4':'Ж4','Ж5':'Ж5',
      'ОД':'ОД','ОД1':'ОД1','ОД2':'ОД2','О':'О',
      'П':'П','П1':'П1','П2':'П2','П3':'П3','КП':'КП',
      'Р':'Р','Р1':'Р1','Р2':'Р2','Р3':'Р3','Лс':'Лс','Пр':'Пр',
      'ИТ':'ИТ','Т':'Т','И':'И',
      'СХ':'СХ','СХ1':'СХ1','СХ2':'СХ2','СА':'СА',
      'СП':'СП','СН1':'СН1','СН2':'СН2','В':'В',
    };
    const _isParcelSzz = l.type === 'parcel' || l.type === 'szz';
    const badge    = _isParcelSzz && l.zoneType ? (ZONE_LABEL_MAP[l.zoneType] || BADGE_MAP[l.type]) : (BADGE_MAP[l.type] || l.type);
    const badgeCls = isSrc ? 't-src' : l.type === 'szz' ? 't-szz' : (isMonPt || isMpCall) ? 't-mp' : '';
    const draggable = 'true';
    const dragEvts  = `ondragstart="onLayerDragStart(event,${idx})"
                 ondragend="onLayerDragEnd(event)"
                 ondragover="onLayerDragOver(event)"
                 ondragleave="onLayerDragLeave(event)"
                 ondrop="onLayerDrop(event,${idx})"`;

    // Слои источников имеют кнопку разворота подсписка. У РТ подсписка нет:
    // каждая точка — самостоятельная строка, разворачивать нечего
    const hasSubList = !l.mpId
      && ['src-emission','src-noise','src-other','sources','monpoints'].includes(l.type);
    const isExp = !!_layerSubExpanded[l.id];
    const expandBtn = hasSubList
      ? `<span class="li-expand" onclick="event.stopPropagation();toggleLayerSub(${l.id})" title="Развернуть список">${isExp ? '▾' : '▸'}</span>`
      : '';

    const polyOp = `oncontextmenu="layerContextMenu(event,${l.id});return false"`;
    // SVG-значок для слоёв выносок; цветной квадрат для остальных
    const thumbHtml = isCalloutLayer
      ? `<div class="li-thumb" style="background:transparent;border:none;display:flex;align-items:center;justify-content:center">
           <svg viewBox="0 0 20 20" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
             <polyline points="4,16 9,10 14,10" stroke="${l.color}" stroke-width="1.8" stroke-linejoin="round"/>
             <rect x="9" y="5" width="8" height="5" rx="1" stroke="${l.color}" stroke-width="1.5"/>
           </svg>
         </div>`
      : `<div class="li-thumb" style="background:${thumbBg};${patBg}border:${borderW}px ${borderSt} ${strokeCol};opacity:${style.opacity ?? 1}"></div>`;
    const _lkd = window._isLayerLocked ? window._isLayerLocked(l) : false;
    const _dep = window._uxGroupDepth ? window._uxGroupDepth(l.groupId) : 0;
    parts.push(`<div class="li-row ${l.id === activeLayerId ? 'active' : ''} ${_selLayerIds.has(l.id) && _selLayerIds.size > 1 ? 'sel' : ''} ${l.groupId ? 'in-group' : ''} ${_lkd ? 'locked' : ''}"
                 style="--g-depth:${_dep}"
                 tabindex="0" draggable="${_lkd ? 'false' : draggable}"
                 ${dragEvts}
                 data-layer-id="${l.id}"
                 onclick="selectLayerClick(event,${l.id})"
                 onkeydown="handleLayerKey(event,${l.id})"
                 ${polyOp}>
      <input type="checkbox" class="li-chk" ${l.visible ? 'checked' : ''}
             onclick="toggleVis(event,${l.id})" title="Видимость (Alt — показать только этот слой)">
      ${thumbHtml}
      <span class="li-type ${badgeCls}">${badge}</span>
      <span class="li-name" id="lname-${l.id}"
            contenteditable="false"
            onblur="saveLayerName(${l.id})"
            onkeydown="handleNameKey(event,${l.id})"
            ondblclick="startRename(${l.id})">${escapeHtml(l.name)}</span>
      ${(l.callout && l.callout.on) ? `<span class="li-callout" title="Выноска: ${escapeHtml(l.callout.name || l.name)} — клик убирает"
             onclick="event.stopPropagation();toggleLayerCallout(${l.id}, false)"><svg class="icon icon-sm"><use href="#ico-tag"/></svg></span>` : ''}
      ${(isSrc || isMonPt || isMpCall) ? '' : `<span class="li-fillpct">${fillOp}%</span>`}
      ${expandBtn}
      <span class="li-lock ${_lkd ? 'on' : ''}" onclick="event.stopPropagation();toggleLayerLock(${l.id})" title="${_lkd ? 'Снять блокировку' : 'Заблокировать слой'}"><svg class="icon icon-sm"><use href="#ico-lock"/></svg></span>
      <span class="li-del" onclick="deleteLayer(event,${l.id})" title="Удалить">✕</span>
    </div>`);

    // Подсписок источников / РТ
    if (hasSubList && isExp) {
      const allSrcs = typeof _sources    !== 'undefined' ? _sources    : [];
      const allMps  = typeof _monPoints  !== 'undefined' ? _monPoints  : [];

      if (isMonPt) {
        allMps.forEach(p => {
          const col = p.color || '#3b82f6';
          const lbl = `РТ-${p.num}${p.name ? ' ' + escapeHtml(p.name) : ''}`;
          parts.push(`<div class="li-sub-item" onclick="mapFocusMp('${p.id}')" ondblclick="mpEditFromList('${p.id}')" oncontextmenu="mpContextMenu(event,'${p.id}');return false" title="Перейти к РТ">
            <div class="li-sub-badge" style="background:${col};color:#fff">${p.num || '●'}</div>
            <span class="li-sub-name">${lbl}</span>
          </div>`);
        });
        if (!allMps.length) parts.push('<div class="li-sub-empty">Нет расчётных точек</div>');
      } else {
        const TYPE_FILTER = { 'src-emission':'emission', 'src-noise':'noise', 'src-other':'other' };
        const tf = TYPE_FILTER[l.type]; // undefined для 'sources' — показываем все
        const filteredSrcs = tf ? allSrcs.filter(s => (s.type || 'emission') === tf) : allSrcs;
        filteredSrcs.forEach(s => {
          const col = s.color || '#ef4444';
          const lbl = s.name ? escapeHtml(s.name) : `Ист.${s.num || s.id}`;
          const typeLbl = { emission:'выбр.', noise:'шум', other:'' }[s.type || 'emission'] || '';
          parts.push(`<div class="li-sub-item" onclick="mapFocusSrc('${s.id}')" ondblclick="srcEditSource('${s.id}')" oncontextmenu="srcContextMenu(event,'${s.id}');return false" title="Перейти к источнику">
            <div class="li-sub-badge" style="background:${col};color:#fff">${s.num || '●'}</div>
            <span class="li-sub-name">${lbl}</span>
            ${typeLbl ? `<span class="li-sub-type">${typeLbl}</span>` : ''}
          </div>`);
        });
        if (!filteredSrcs.length) parts.push('<div class="li-sub-empty">Нет источников</div>');
      }
    }
  });

  _initLayerBoxDrop(box);
  if (!_shown) parts.push('<div class="empty">Ничего не найдено по фильтру</div>');
  else if (_shown < mapLayers.length)
    parts.push(`<div style="padding:4px 8px;font-size:var(--fs-1);color:var(--tx2)">Показано ${_shown} из ${mapLayers.length}</div>`);
  box.innerHTML = parts.join('');
  if (window._uxAfterRenderLayers) window._uxAfterRenderLayers();
}

function toggleLayerSub(layerId) {
  _layerSubExpanded[layerId] = !_layerSubExpanded[layerId];
  renderLayers();
}

function mapFocusSrc(srcId) {
  const srcs = typeof _sources !== 'undefined' ? _sources : [];
  const s = srcs.find(x => String(x.id) === String(srcId));
  if (!s || !map) return;
  let lat, lon;
  if (s.points && s.points.length) {
    lat = s.points.reduce((a, p) => a + (p[0] ?? p.lat ?? 0), 0) / s.points.length;
    lon = s.points.reduce((a, p) => a + (p[1] ?? p.lon ?? 0), 0) / s.points.length;
  } else { lat = s.lat; lon = s.lon; }
  if (lat != null && lon != null) map.panTo([lat, lon]);
}

function mapFocusMp(mpId) {
  const mps = typeof _monPoints !== 'undefined' ? _monPoints : [];
  const p = mps.find(x => String(x.id) === String(mpId));
  if (!p || p.lat == null || !map) return;
  map.panTo([p.lat, p.lon]);
}

// Кратковременная подсветка полигона слоя на карте
function _flashLayer(l) {
  if (!l || !l.poly || !l.poly.length) return;
  if (l.type !== 'parcel') return;
  try {
    const latlngs = l.poly.map(p => L.latLng(p[0], p[1]));
    const flash = L.polygon(latlngs, {
      color: '#60a5fa', weight: 5, fillColor: '#60a5fa', fillOpacity: 0.30, opacity: 0.9,
    }).addTo(map);
    setTimeout(() => { try { map.removeLayer(flash); } catch(e) {} }, 750);
  } catch(e) {}
}

// Список слоёв длинный, и выбор с карты раньше подсвечивал строку где-то
// за пределами видимой части — приходилось искать её глазами.
window._scrollLayerIntoView = function (id) {
  const row = document.querySelector(`.li-row[data-layer-id="${id}"]`);
  if (!row) return;
  const box = row.closest('.layer-box');
  if (!box) return;
  const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top || r.bottom > b.bottom) {
    box.scrollTop += (r.top - b.top) - (b.height - r.height) / 2;
  }
};

function selectLayer(id) {
  activeLayerId = id;
  renderLayers();
  updateButtons();
  const l = mapLayers.find(l => l.id === id) || null;
  showLayerProps(l);
  _scrollLayerIntoView(id);
  // Навигация — для всех слоёв с геометрией (без подсветки)
  if (l && l.poly && l.poly.length) {
    try {
      const bounds = l.layer && l.layer.getBounds
        ? l.layer.getBounds()
        : L.latLngBounds(l.poly.map(p => L.latLng(p[0], p[1])));
      if (bounds && bounds.isValid() && !map.getBounds().intersects(bounds)) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17, animate: true });
      }
    } catch(e) {}
  }
}

function _setLayerPatternBtns(pattern) {
  const el = document.getElementById('lp-fill-pattern');
  if (el) el.value = pattern || 'solid';
  ['solid','hatch-l','hatch-r','grid'].forEach(p => {
    const btn = document.getElementById('lp-fpat-' + p);
    if (!btn) return;
    btn.style.borderColor = '';
    btn.style.background  = '';
    btn.style.color       = '';
    btn.classList.toggle('active', p === (pattern || 'solid'));
  });
}
window.setLayerFillPattern = (pattern) => { _setLayerPatternBtns(pattern); applyLayerProps('fillPattern'); };

function _showLayerPropsBase(l) {
  const _vr = document.getElementById('lp-verts-row');
  if (_vr && (!l || !l.poly || !l.poly.length)) _vr.style.display = 'none';
  const panel = document.getElementById('layer-props-panel');
  if (!l) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const body = panel.querySelector('.section-body');
  const arrow = panel.querySelector('.section-arrow');
  if (body) body.style.display = '';
  if (arrow) arrow.textContent = '▾';
  document.getElementById('layer-props-name').textContent = l.name;

  // Показываем/скрываем блок доп. настроек выносок и строку заливки
  const _lpExtra      = document.getElementById('lp-callout-extra');
  const _lpFillRow    = document.getElementById('lp-fill-row');
  const _lpPatRow     = document.getElementById('lp-fill-pattern-row');
  const _lpDashRow    = document.getElementById('lp-dash-row');
  const _lpCrsRow     = document.getElementById('lp-crs-row');
  const _lpZoneRow    = document.getElementById('lp-zone-type-row');
  // src-callouts-emission/noise/other — фактические типы выносок источников
  const SRC_CALLOUT_KEY = {
    'src-callouts': null, 'src-callouts-emission': 'emission',
    'src-callouts-noise': 'noise', 'src-callouts-other': 'other',
  };
  const _isSrcCallout = Object.prototype.hasOwnProperty.call(SRC_CALLOUT_KEY, l.type);
  const _isCallout    = _isSrcCallout || l.type === 'mp-callouts';
  const _hasFillPat   = ['sources','src-emission','src-noise','src-other','parcel','szz'].includes(l.type);
  const _isSrc        = ['sources','src-emission','src-noise','src-other'].includes(l.type);
  const _hasZoneType  = l.type === 'parcel' || l.type === 'szz';
  // Своя выноска слоя — только у геометрии (ЗУ, СЗЗ и т.п.)
  const _zuRow    = document.getElementById('lp-zu-callout-row');
  const _canCall  = typeof window._canHaveCallout === 'function' && window._canHaveCallout(l);
  const _calloutOn = _canCall && !!(l.callout && l.callout.on);
  if (_zuRow) {
    _zuRow.style.display = _canCall ? '' : 'none';
    if (_canCall) {
      document.getElementById('lp-zu-callout-on').checked = _calloutOn;
      const isAuto = !!(l.callout && l.callout.formula);
      const auto = document.getElementById('lp-zu-callout-auto');
      if (auto) auto.checked = isAuto;
      const ti = document.getElementById('lp-zu-callout-text');
      ti.value = (l.callout && l.callout.name) || l.name || '';
      ti.disabled = !_calloutOn || isAuto;
      ti.style.opacity = (_calloutOn && !isAuto) ? '1' : '.5';
    }
  }
  const _zuStyleRow = document.getElementById('lp-zu-callout-style-row');
  if (_zuStyleRow) _zuStyleRow.style.display = _calloutOn ? '' : 'none';
  if (_lpExtra)   _lpExtra.style.display   = (_isCallout || _calloutOn) ? '' : 'none';
  if (_lpFillRow) _lpFillRow.style.display = _isCallout ? 'none' : '';
  if (_lpPatRow)  _lpPatRow.style.display  = _hasFillPat ? '' : 'none';
  if (_lpDashRow) _lpDashRow.style.display = _isSrc ? 'none' : '';
  if (_lpZoneRow) _lpZoneRow.style.display = _hasZoneType ? '' : 'none';
  if (_hasZoneType) {
    const defZone = l.type === 'szz' ? 'szz' : 'zu';
    document.getElementById('lp-zone-type').value = l.zoneType || defZone;
  }
  if (_hasFillPat) _setLayerPatternBtns((l._psStyle && l._psStyle.fillPattern) || 'solid');
  if (_lpCrsRow) _lpCrsRow.style.display = 'none';

  // Для слоя выносок — читаем параметры из источников нужного типа
  if (_isSrcCallout) {
    const srcKey = SRC_CALLOUT_KEY[l.type];  // null = все, 'emission'/'noise'/'other' = конкретный
    const srcs = typeof _sources !== 'undefined' ? _sources : [];
    const s0 = (srcKey ? srcs.find(s => (s.type || 'emission') === srcKey) : srcs[0]) || {};
    const cc  = s0.calloutColor      || '#ffffff';
    const cw  = s0.calloutLineWidth  || 1.5;
    const tc  = s0.calloutTextColor  || cc;
    const tsw = s0.calloutStrokeWidth  || 0;
    const tsc = s0.calloutStrokeColor  || '#ffffff';
    const ff  = s0.calloutFontFamily || 'Arial,sans-serif';
    const fs  = s0.calloutFontSize   || 12;
    document.getElementById('lp-fill-color').value   = cc;
    document.getElementById('lp-stroke-color').value = cc;
    document.getElementById('lp-fill-opacity').value = 100;
    document.getElementById('lp-fill-val').textContent = '100%';
    document.getElementById('lp-stroke-opacity').value = 100;
    document.getElementById('lp-stroke-val').textContent = '100%';
    document.getElementById('lp-weight').value = cw;
    document.getElementById('lp-weight-val').textContent = cw + 'px';
    document.getElementById('lp-dash').value = '';
    document.getElementById('lp-text-color').value = tc;
    document.getElementById('lp-text-stroke-w').value = tsw;
    document.getElementById('lp-text-stroke-w-val').textContent = tsw + 'px';
    document.getElementById('lp-text-stroke-color').value = tsc;
    document.getElementById('lp-font-family').value = ff;
    document.getElementById('lp-font-size').value = fs;
    document.getElementById('lp-font-size-val').textContent = fs + 'px';
    return;
  }
  // Поля «цвет текста / обводка / шрифт / размер» показывают стиль выноски слоя
  if (_calloutOn) {
    const c = l.callout || {};
    const tc  = c.calloutTextColor   || c.calloutColor || '#111827';
    const tsw = c.calloutStrokeWidth ?? 2;
    const tsc = c.calloutStrokeColor || '#ffffff';
    const ff  = c.calloutFontFamily  || 'Arial,sans-serif';
    const cfs = c.calloutFontSize    || 12;
    document.getElementById('lp-text-color').value = tc;
    document.getElementById('lp-text-stroke-w').value = tsw;
    document.getElementById('lp-text-stroke-w-val').textContent = tsw + 'px';
    document.getElementById('lp-text-stroke-color').value = tsc;
    document.getElementById('lp-font-family').value = ff;
    document.getElementById('lp-font-size').value = cfs;
    document.getElementById('lp-font-size-val').textContent = cfs + 'px';
    // Цвет и толщина линии выноски — свои, полигон их не трогает
    const clw = c.calloutLineWidth ?? 1.5;
    document.getElementById('lp-zu-callout-color').value = c.calloutColor || '#111827';
    document.getElementById('lp-zu-callout-lw').value = clw;
    document.getElementById('lp-zu-callout-lw-val').textContent = clw + 'px';
  }

  const s = l._psStyle || {};
  const _isSrcType = ['sources','src-emission','src-noise','src-other'].includes(l.type);
  const defColor = _isSrcType ? (l.color || '#ef4444') : l.type === 'monpoints' ? '#3b82f6' : (l.color || '#f59e0b');
  document.getElementById('lp-fill-color').value   = s.fillColor   || defColor;
  document.getElementById('lp-stroke-color').value = s.color       || defColor;
  const defFo = _isSrcType ? 0.15 : (l.type === 'szz' ? 0.1 : 0.15);
  const fo = Math.round((s.fillOpacity ?? defFo) * 100);
  document.getElementById('lp-fill-opacity').value = fo;
  document.getElementById('lp-fill-val').textContent = fo + '%';
  const so = Math.round((s.opacity ?? 1) * 100);
  document.getElementById('lp-stroke-opacity').value = so;
  document.getElementById('lp-stroke-val').textContent = so + '%';
  const w = s.weight ?? 2;
  document.getElementById('lp-weight').value = w;
  document.getElementById('lp-weight-val').textContent = w + 'px';
  if (typeof renderLayerVerts === 'function') renderLayerVerts();
  if (typeof _renderLayerPresets === 'function') _renderLayerPresets();
  // Тип линии: сравниваем без пробелов и приводим к варианту из списка.
  // Раньше значение вроде «8 5» или «8, 5» не совпадало ни с одним option,
  // select падал на первый пункт и показывал «Сплошная» у пунктирного слоя.
  const dashSel = document.getElementById('lp-dash');
  const norm = v => String(v ?? '').replace(/\s+/g, '');
  const cur  = norm(s.dashArray);
  dashSel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
  const match = [...dashSel.options].find(o => norm(o.value) === cur);
  if (match) dashSel.value = match.value;
  else if (cur) {
    // Нестандартный штрих — показываем как есть, а не врём «Сплошная»
    const opt = document.createElement('option');
    opt.value = s.dashArray; opt.textContent = `Свой (${s.dashArray})`;
    opt.dataset.custom = '1';
    dashSel.appendChild(opt);
    dashSel.value = s.dashArray;
  } else dashSel.value = '';
}




// Восстановить стиль слоя после повторного добавления на карту.
// Leaflet при remove+add пересоздаёт SVG-элемент, и заданный стиль вместе
// со штриховкой слетает — из-за этого стили «терялись» при выключении
// и включении группы или отдельного слоя.
window._reapplyLayerStyle = function(l) {
  if (!l || !l.layer || !l.visible) return;
  const st = l._psStyle;
  if (!st) return;
  try { if (l.layer.setStyle) l.layer.setStyle(st); } catch(e) {}
  if (!st.fillPattern || st.fillPattern === 'solid' || typeof window._applyFillPattern !== 'function') return;
  const fp = st.fillPattern, fc = st.fillColor || st.color || l.color;
  const apply = () => {
    try {
      if (typeof l.layer.eachLayer === 'function') l.layer.eachLayer(sub => window._applyFillPattern(sub, fc, fp));
      else window._applyFillPattern(l.layer, fc, fp);
    } catch(e) {}
  };
  apply();
  requestAnimationFrame(apply);   // после перерисовки Leaflet
};


// ── Выноски слоёв (ЗУ, СЗЗ и прочая геометрия) ──────────────────────────────
// Подпись на полочке у полигона. Текст по умолчанию — имя слоя (обычно
// кадастровый номер или название участка), рисуется тем же классом, что и
// выноски источников и РТ, поэтому ведёт себя одинаково: тянется за кружок,
// печатается в редакторе PDF и хранится в проекте.
let _zuCalloutGroup = null;

// Слой, которому вообще можно назначить выноску
window._canHaveCallout = function(l) {
  return !!(l && l.poly && l.poly.length >= 3 && l.type !== 'search-area');
};

// ── Выноски у любых строк панели: контур, РТ, слой источников ──────────────
// Группа или выделение бывает из чего угодно: участки, РТ, слои источников.
// Раньше групповые команды выносок понимали только контуры — у группы РТ
// пунктов «Выноски» и «Один стиль» не было вовсе. Теперь каждая строка
// раскрывается в носители выноски (l.callout / точка РТ / источники типа),
// и все меню (группа, выделение, редактор PDF) работают через этот список.
const _SRC_LAYER_TYPE = { 'src-emission': 'emission', 'src-noise': 'noise', 'src-other': 'other' };
function _calloutCarriers(layers) {
  const out = [], seen = new Set();
  const mps  = typeof _monPoints !== 'undefined' ? _monPoints : [];
  const srcs = typeof _sources   !== 'undefined' ? _sources   : [];
  const add = (kind, l, obj, on) => { if (obj && !seen.has(obj)) { seen.add(obj); out.push({ kind, l, obj, on }); } };
  (layers || []).forEach(l => {
    if (!l) return;
    if (l.mpId) {
      const p = mps.find(x => x.id === l.mpId);
      if (p) add('mp', l, p, !!p.showLabel);
    } else if (_SRC_LAYER_TYPE[l.type] || l.type === 'sources') {
      const t = _SRC_LAYER_TYPE[l.type];
      srcs.forEach(s => { if (!t || (s.type || 'emission') === t) add('src', l, s, !!s.showLabel); });
    } else if (window._canHaveCallout(l)) {
      if (!l.callout) l.callout = {};
      add('layer', l, l.callout, !!l.callout.on);
    }
  });
  return out;
}
window._calloutCarriers = _calloutCarriers;
window._calloutCarriersOfIds = ids => _calloutCarriers(mapLayers.filter(l => ids.includes(l.id)));

// Включить/выключить выноски у набора носителей и обновить всё вокруг
function _setCarriersCallout(cs, on) {
  if (!cs.length) return;
  if (typeof window._primeMapScale === 'function') window._primeMapScale();
  let mp = false, src = false;
  cs.forEach(c => {
    if (c.kind === 'layer') { c.l.callout.on = !!on; _drawLayerCallout(c.l); }
    else if (c.kind === 'mp') {
      if (typeof _clearMpCallout === 'function') _clearMpCallout(c.obj);
      c.obj.showLabel = !!on;
      if (on && typeof _drawMpCallout === 'function') _drawMpCallout(c.obj);
      mp = true;
    } else if (typeof _setSrcCallout === 'function') { _setSrcCallout(c.obj, on); src = true; }
  });
  if (mp) {
    if (typeof _saveMonPoints === 'function') _saveMonPoints();
    if (typeof _syncMpCalloutLayer === 'function') _syncMpCalloutLayer();
    if (typeof _mpRenderList === 'function') _mpRenderList();
  }
  if (src) {
    if (typeof _saveSources === 'function') _saveSources();
    if (typeof _syncCalloutLayer === 'function') _syncCalloutLayer();
    if (typeof _renderSourcesList === 'function') _renderSourcesList();
  }
  _syncPdfCallouts();
  if ((mp || src) && typeof pdfMap !== 'undefined' && pdfMap && typeof _refreshPdfMapLayers === 'function') _refreshPdfMapLayers();
  renderLayers();
  if (typeof markDirty === 'function') markDirty();
}
window._setCarriersCallout = _setCarriersCallout;

// Перерисовать уже показанные выноски носителей (после смены стиля)
function _redrawCarriers(cs) {
  cs.forEach(c => {
    const ls = c.kind === 'layer' ? c.l._calloutLayers : c.kind === 'mp' ? c.obj._calloutLayers : c.obj.layers;
    (ls || []).forEach(x => { if (x._draw && x._s) x._draw(); });
  });
}

// Общее меню выносок для набора слоёв — шапки разделов в редакторе PDF
// («Расчётные точки», «Выбросы», «Шум»): те же команды, что у групп
window.layersCalloutMenu = function(e, ids, title) {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('src-ctx-menu')?.remove();
  const layers = mapLayers.filter(l => ids.includes(l.id));
  if (!layers.length) return;
  const cs = _calloutCarriers(layers);
  const on = cs.filter(c => c.on).length;
  const anyVis = layers.some(l => l.visible !== false);
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
  const close = "document.getElementById('src-ctx-menu')?.remove();if(typeof _renderLayersList==='function'&&document.getElementById('pdf-editor')?.style.display!=='none')_renderLayersList()";
  const idList = layers.map(l => l.id).join(',');
  menu.innerHTML = `<div class="src-ctx-hdr">${escapeHtml(title || 'Слои')}</div>
    <button onclick="hideLayersByIds([${idList}], ${anyVis});${close}">${anyVis ? 'Скрыть' : 'Показать'} (${layers.length})</button>
    <button onclick="isolateLayers([${idList}], ${JSON.stringify(title || 'выбранное').replace(/"/g, '&quot;')});${close}">Показать только их</button>` +
    (cs.length ? `<div class="src-ctx-sep"></div>
    <button onclick="setLayersCallouts([${idList}], true);${close}">
      <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
      Включить выноски (${cs.length})</button>` +
    (on ? `<button onclick="setLayersCallouts([${idList}], false);${close}">Снять выноски (${on})</button>` : '') +
    `<button onclick="openCalloutStyleDialog([${idList}], ${JSON.stringify('Стиль выносок: ' + (title || 'выбранное')).replace(/"/g, '&quot;')});${close}">Один стиль выносок…</button>` : '');
  _placeCtxMenu(menu, e);
};

window.setLayersCallouts = function(ids, on) {
  const cs = window._calloutCarriersOfIds(ids);
  if (!cs.length) { setSt('Нет объектов для выноски', 'err'); return; }
  if (typeof mapUndoPush === 'function') mapUndoPush(on ? 'выноски' : 'скрыть выноски');
  _setCarriersCallout(cs, on);
  setSt(on ? `Выноски включены: ${cs.length}` : `Выноски скрыты: ${cs.length}`, 'ok');
};

// Видимость набора слоёв по id (для общих меню)
window.hideLayersByIds = function(ids, hide) {
  mapLayers.forEach(l => {
    if (!ids.includes(l.id) || (l.visible !== false) !== hide) return;
    toggleVis({ stopPropagation() {}, altKey: false }, l.id);
  });
};

// Живой объект-описатель для ShelfLeader. polygon и _onSave делаем
// неперечисляемыми: тогда они не попадают в проект при сохранении, а polygon
// через геттер всегда отдаёт актуальный контур (после правки вершин тоже).
// Формула выноски: текст вида "##{num}. {name} ({buffer}м)" пересчитывается
// из текущих свойств слоя при каждой перерисовке — подпись сама подхватывает
// переименование слоя или смену ширины СЗЗ, без ручной правки текста выноски.
// Доступные поля: {num} — номер по порядку в дереве слоёв, {name} — имя слоя,
// {buffer} — ширина СЗЗ в метрах (есть только у слоёв type==='szz'),
// {zoneType} — подпись типа зоны (СЗЗ/Участок/...).
function _renderCalloutFormula(tpl, l) {
  const ctx = {
    num:      l.callout && l.callout.num != null ? l.callout.num : (mapLayers.indexOf(l) + 1),
    name:     l.name || '',
    buffer:   l.bufferM != null ? l.bufferM : '',
    zoneType: ({ szz: 'СЗЗ', zu: 'Участок' })[l.zoneType] || l.zoneType || '',
  };
  return tpl.replace(/\{(\w+)\}/g, (m, key) => (key in ctx ? ctx[key] : m));
}

function _layerCalloutInit(l) {
  if (!l.callout) l.callout = {};
  const c = l.callout;
  c.geomType = 'area';
  if (c.formula) c.name = _renderCalloutFormula(c.formula, l);
  else if (!c.custom || !c.name) c.name = l.name;
  if (c.num == null) c.num = Math.max(0, mapLayers.indexOf(l)) + 1;
  if (!Object.getOwnPropertyDescriptor(c, 'polygon')) {
    Object.defineProperty(c, 'polygon', { get: () => l.poly, configurable: true, enumerable: false });
  }
  Object.defineProperty(c, '_onSave', {
    value: () => { if (typeof markDirty === 'function') markDirty(); },
    configurable: true, enumerable: false, writable: true,
  });
  return c;
}

// Наружу — чтобы расстановка могла подготовить описатель у слоя,
// выноска которого ещё ни разу не рисовалась (иначе падала на пустом якоре)
window._layerCalloutPrep = function(l) {
  try { return (l && l.poly && l.poly.length >= 3) ? _layerCalloutInit(l) : null; }
  catch (e) { return null; }
};

function _clearLayerCallout(l) {
  ((l && l._calloutLayers) || []).forEach(x => {
    try { if (_zuCalloutGroup) _zuCalloutGroup.removeLayer(x); } catch(e) {}
    try { map.removeLayer(x); } catch(e) {}
  });
  if (l) l._calloutLayers = [];
}

function _drawLayerCallout(l) {
  _clearLayerCallout(l);
  if (!l || !l.callout || !l.callout.on) return;
  if (l.visible === false || !window._canHaveCallout(l)) return;
  if (typeof _makeCalloutLayersGlobal !== 'function') return;
  if (!_zuCalloutGroup) _zuCalloutGroup = L.layerGroup().addTo(map);
  l._calloutLayers = _makeCalloutLayersGlobal(_layerCalloutInit(l), _zuCalloutGroup, true);
}

// Перерисовать выноски всех слоёв (открытие проекта, отмена, смена порядка)
window.refreshLayerCallouts = function() {
  mapLayers.forEach(l => { if (l.callout && l.callout.on) _drawLayerCallout(l); else _clearLayerCallout(l); });
  _syncPdfCallouts();
};

function _syncPdfCallouts() {
  if (typeof pdfMap !== 'undefined' && pdfMap && typeof _rebuildPdfProjectLayers === 'function') {
    try { _rebuildPdfProjectLayers(); } catch(e) {}
  }
}

// Включить или выключить выноску у слоя (или у всего выделения)
window.toggleLayerCallout = function(id, on) {
  const cs = window._calloutCarriersOfIds(_targetLayers(id));
  if (!cs.length) { setSt('Нет объектов для выноски', 'err'); return; }
  if (typeof mapUndoPush === 'function') mapUndoPush(on ? 'выноски слоёв' : 'скрыть выноски');
  _setCarriersCallout(cs, on);
  setSt(on ? `Выноски включены: ${cs.length}` : `Выноски скрыты: ${cs.length}`, 'ok');
};

// Слои группы вместе с вложенными подгруппами
function _layerGroupMembers(gid) {
  return typeof window._uxGroupLayers === 'function'
    ? window._uxGroupLayers(gid) : mapLayers.filter(l => l.groupId === gid);
}

// Выноски всей группе разом — то, ради чего группы и собирают
window.setGroupCallouts = function(gid, on) {
  const cs = _calloutCarriers(_layerGroupMembers(gid));
  if (!cs.length) { setSt('В группе нет объектов для выноски', 'err'); return; }
  if (typeof mapUndoPush === 'function') mapUndoPush('выноски группы');
  _setCarriersCallout(cs, on);
  const gname = (_layerGroups[gid] || {}).name || 'группа';
  setSt(`${on ? 'Выноски назначены' : 'Выноски сняты'}: «${gname}» (${cs.length})`, 'ok');
};

// Текст выноски активного слоя
window.setLayerCalloutText = function(text) {
  const l = getActiveLayer();
  if (!l || !l.callout) return;
  if (typeof text === 'string' && text.startsWith('##')) {
    l.callout.formula = text.slice(2);
    l.callout.name    = _renderCalloutFormula(l.callout.formula, l);
  } else {
    l.callout.formula = null;
    l.callout.name    = text;
  }
  l.callout.custom = true;
  ((l._calloutLayers) || []).forEach(x => { if (x._draw && x._s) x._draw(); });
  _syncPdfCallouts();
  if (typeof markDirty === 'function') markDirty();
};

// Чекбокс «Авто»: подпись сама собирается из номера/типа/ширины СЗЗ —
// без ручного ввода формулы. Выключили — обычное текстовое поле, как раньше.
window.setLayerCalloutAuto = function(on) {
  const l = getActiveLayer();
  if (!l || !l.callout) return;
  if (on) {
    l.callout.formula = l.type === 'szz' ? '{num}. {zoneType} {buffer}м' : '{num}. {name}';
    l.callout.name    = _renderCalloutFormula(l.callout.formula, l);
  } else {
    l.callout.formula = null;
    // Текст остаётся таким, каким был собран формулой — дальше его можно
    // поправить руками в обычном текстовом поле
  }
  l.callout.custom = true;
  ((l._calloutLayers) || []).forEach(x => { if (x._draw && x._s) x._draw(); });
  _syncPdfCallouts();
  showLayerProps(l);
  if (typeof markDirty === 'function') markDirty();
};

// Чекбокс «Выноска» в панели свойств
window.setLayerCalloutOn = function(on) {
  const l = getActiveLayer();
  if (!l) return;
  window.toggleLayerCallout(l.id, on);
  showLayerProps(l);
};

// Стиль выноски слоя из панели свойств
window._applyLayerCalloutStyle = function(l, st) {
  if (!l || !l.callout) return;
  Object.assign(l.callout, st);
  ((l._calloutLayers) || []).forEach(x => { if (x._draw && x._s) x._draw(); });
  _syncPdfCallouts();
};


// ── Один стиль выносок на группу (или на выделение) ─────────────────────────
// Диалог собирает стиль один раз и раскатывает его на все слои сразу: по
// отдельности выставлять цвет каждому участку в группе — то ещё занятие.
window.openCalloutStyleDialog = function(ids, title) {
  const targets = window._calloutCarriersOfIds(ids);
  if (!targets.length) { setSt('Нет объектов для выноски', 'err'); return; }
  document.getElementById('callout-style-modal')?.remove();
  // Стиль первой выноски — как отправная точка
  const base = (targets.find(c => c.on) || targets[0]).obj || {};
  const v = {
    color:  base.calloutColor       || '#111827',
    lw:     base.calloutLineWidth   ?? 1.5,
    tcolor: base.calloutTextColor   || base.calloutColor || '#111827',
    tsw:    base.calloutStrokeWidth ?? 2,
    tsc:    base.calloutStrokeColor || '#ffffff',
    ff:     base.calloutFontFamily  || 'Arial,sans-serif',
    fs:     base.calloutFontSize    || 12,
    leader: base.showLeaderLine !== false,
    circle: base.showCalloutCircle !== false,
  };
  const fonts = ['Arial,sans-serif|Arial', "'Times New Roman',serif|Times New Roman",
                 "'Courier New',monospace|Courier New", 'Verdana,sans-serif|Verdana',
                 'Georgia,serif|Georgia', 'Tahoma,sans-serif|Tahoma', "'Segoe UI',sans-serif|Segoe UI"];
  const m = document.createElement('div');
  m.id = 'callout-style-modal';
  m.className = 'app-dialog';
  m.innerHTML = `
    <div class="modal" style="width:380px">
      <div class="modal-hdr">
        <h2>${title}</h2>
        <button class="modal-close" onclick="document.getElementById('callout-style-modal')?.remove()"><svg class="icon icon-sm"><use href="#ico-x"/></svg></button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:var(--fs-1);color:var(--tx2)">Стиль применится ко всем слоям сразу: <b>${targets.length}</b></div>
        <div class="lp-row">
          <span class="lp-lbl">Цвет выноски</span>
          <input type="range" id="cs-lw" min="0.5" max="6" step="0.5" value="${v.lw}" oninput="document.getElementById('cs-lw-val').textContent=this.value+'px'">
          <span class="lp-val" id="cs-lw-val">${v.lw}px</span>
          <input type="color" class="lp-color" id="cs-color" value="${v.color}">
        </div>
        <div class="lp-row">
          <span class="lp-lbl">Цвет текста</span>
          <input type="color" class="lp-color" id="cs-tcolor" value="${v.tcolor}">
        </div>
        <div class="lp-row">
          <span class="lp-lbl">Обв. текста</span>
          <input type="range" id="cs-tsw" min="0" max="6" step="0.5" value="${v.tsw}" oninput="document.getElementById('cs-tsw-val').textContent=this.value+'px'">
          <span class="lp-val" id="cs-tsw-val">${v.tsw}px</span>
          <input type="color" class="lp-color" id="cs-tsc" value="${v.tsc}">
        </div>
        <div class="lp-row">
          <span class="lp-lbl">Шрифт</span>
          <select id="cs-ff" style="flex:1;font-size:var(--fs-1);background:var(--bg2);color:var(--tx1);border:1px solid var(--brd);border-radius:var(--r-sm);padding:2px 4px">
            ${fonts.map(f => { const [val, nm] = f.split('|');
              return `<option value="${val}" ${val === v.ff ? 'selected' : ''}>${nm}</option>`; }).join('')}
          </select>
        </div>
        <div class="lp-row">
          <span class="lp-lbl">Размер</span>
          <input type="range" id="cs-fs" min="8" max="36" value="${v.fs}" oninput="document.getElementById('cs-fs-val').textContent=this.value+'px'">
          <span class="lp-val" id="cs-fs-val">${v.fs}px</span>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:2px">
          <label style="display:flex;align-items:center;gap:5px;font-size:var(--fs-1);color:var(--tx2);cursor:pointer">
            <input type="checkbox" id="cs-leader" ${v.leader ? 'checked' : ''}>Линия и полочка
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:var(--fs-1);color:var(--tx2);cursor:pointer">
            <input type="checkbox" id="cs-circle" ${v.circle ? 'checked' : ''}>Кружок для перетаскивания
          </label>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
          <button class="btn" onclick="document.getElementById('callout-style-modal')?.remove()">Отмена</button>
          <button class="btn pri" onclick="applyCalloutStyleDialog([${ids.join(',')}])">Применить ко всем (${targets.length})</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
};

window.applyCalloutStyleDialog = function(ids) {
  const q = id => document.getElementById(id);
  const st = {
    calloutColor:       q('cs-color').value,
    calloutLineWidth:   parseFloat(q('cs-lw').value) || 1.5,
    calloutTextColor:   q('cs-tcolor').value,
    calloutStrokeWidth: parseFloat(q('cs-tsw').value),
    calloutStrokeColor: q('cs-tsc').value,
    calloutFontFamily:  q('cs-ff').value,
    calloutFontSize:    parseInt(q('cs-fs').value),
    showLeaderLine:     q('cs-leader').checked,
    showCalloutCircle:  q('cs-circle').checked,
  };
  const targets = window._calloutCarriersOfIds(ids);
  if (typeof mapUndoPush === 'function') mapUndoPush('стиль выносок');
  // Стиль без выноски смысла не имеет: выключенные включаем, уже показанные
  // перерисовываем с новым стилем
  targets.forEach(c => Object.assign(c.obj, st));
  const off = targets.filter(c => !c.on), shown = targets.filter(c => c.on);
  _redrawCarriers(shown);
  if (off.length) _setCarriersCallout(off, true);
  else {
    if (shown.some(c => c.kind === 'mp') && typeof _saveMonPoints === 'function') _saveMonPoints();
    if (shown.some(c => c.kind === 'src') && typeof _saveSources === 'function') _saveSources();
    _syncPdfCallouts();
    if (typeof pdfMap !== 'undefined' && pdfMap && typeof _refreshPdfMapLayers === 'function') _refreshPdfMapLayers();
    renderLayers();
    if (typeof markDirty === 'function') markDirty();
  }
  const al = getActiveLayer();
  if (al) showLayerProps(al);
  document.getElementById('callout-style-modal')?.remove();
  setSt(`Стиль выносок применён: ${targets.length}`, 'ok');
};

// Стиль выносок всей группе
window.openGroupCalloutStyle = function(gid) {
  const ids = _layerGroupMembers(gid).map(l => l.id);
  const gname = (_layerGroups[gid] || {}).name || 'группа';
  window.openCalloutStyleDialog(ids, `Стиль выносок: ${gname}`);
};

// Сколько объектов группы с выносками — для подписи в меню
function _groupCalloutState(gid) {
  const cs = _calloutCarriers(_layerGroupMembers(gid));
  return { total: cs.length, on: cs.filter(c => c.on).length };
}

// ── Выделение нескольких слоёв и группы ─────────────────────────────────────
// Клик — выбрать слой, Shift+клик — диапазон, Ctrl+клик — добавить/убрать.
// Правая кнопка даёт команды над выделением: скрыть, показать, сгруппировать.
// Уникальный id группы. Date.now() сам по себе давал одинаковые id группам,
// созданным в одну миллисекунду (автогруппировка по типу, импорт по КН):
// вторая группа затирала первую, и все слои оказывались в одной.
let _groupIdLast = 0;
function _newGroupId() {
  const t = Date.now();
  _groupIdLast = t > _groupIdLast ? t : _groupIdLast + 1;
  return 'g_' + _groupIdLast;
}

let _selLayerIds = new Set();       // выделенные слои
let _lastPickedLayerId = null;      // якорь для Shift-диапазона
let _layerGroups = {};              // { gid: { name, collapsed } }

window.getLayerSelection = () => [..._selLayerIds];
// Задать выделение извне (окно РТ выбирает точки — выделяются их слои)
window.setLayerSelection = function(ids) {
  _selLayerIds = new Set(ids || []);
  _lastPickedLayerId = (ids && ids.length) ? ids[ids.length - 1] : null;
};

window.selectLayerClick = function(e, id) {
  if (window._lpTouchedReset) window._lpTouchedReset();
  const ids = mapLayers.map(l => l.id);
  if (e && e.shiftKey && _lastPickedLayerId !== null) {
    const a = ids.indexOf(_lastPickedLayerId), b = ids.indexOf(id);
    if (a > -1 && b > -1) {
      _selLayerIds = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
  } else if (e && (e.ctrlKey || e.metaKey)) {
    if (_selLayerIds.has(id)) _selLayerIds.delete(id); else _selLayerIds.add(id);
    _lastPickedLayerId = id;
  } else {
    _selLayerIds = new Set([id]);
    _lastPickedLayerId = id;
  }
  selectLayer(id);                  // активный слой — тот, по которому кликнули
};

// Слои, к которым применяются команды меню: выделение или слой под курсором
function _targetLayers(id) {
  if (_selLayerIds.size > 1 && _selLayerIds.has(id)) return [..._selLayerIds];
  return [id];
}

window.hideLayers = function(id, hide) {
  _targetLayers(id).forEach(lid => {
    const l = mapLayers.find(x => x.id === lid);
    if (!l || l.visible === !hide) return;
    l.visible = !hide;
    if (typeof window._reconcileLayerVis === 'function') window._reconcileLayerVis(l);
    if (!l.poly && typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(l);
    if (typeof window._pdfOnLayerToggled === 'function') window._pdfOnLayerToggled(l);
  });
  renderLayers();
  setSt(hide ? 'Слои скрыты' : 'Слои показаны', 'ok');
};

window.groupLayers = function(id) {
  const ids = _targetLayers(id);
  if (ids.length < 2) { setSt('Выделите несколько слоёв: клик, затем Shift+клик', 'err'); return; }
  if (typeof mapUndoPush === 'function') mapUndoPush('группировка слоёв');
  const gid = _newGroupId();
  _layerGroups[gid] = { name: 'Группа ' + (Object.keys(_layerGroups).length + 1), collapsed: false };
  // Собираем участников подряд, начиная с позиции первого из них
  const members = mapLayers.filter(l => ids.includes(l.id));
  members.forEach(l => { l.groupId = gid; });
  const first = mapLayers.findIndex(l => l.id === members[0].id);
  const rest  = mapLayers.filter(l => !ids.includes(l.id));
  rest.splice(Math.min(first, rest.length), 0, ...members);
  mapLayers = rest;
  _syncLayerOrder();
  renderLayers();
  setSt(`Слоёв в группе: ${members.length}`, 'ok');
};

// Собрать перечисленные слои в новую группу (для импорта по КН и прочих пакетных операций)
window.groupLayersByIds = function(ids, name) {
  const members = mapLayers.filter(l => ids.includes(l.id));
  if (members.length < 2) return null;
  const gid = _newGroupId();
  _layerGroups[gid] = { name: name || ('Группа ' + (Object.keys(_layerGroups).length + 1)), collapsed: false };
  members.forEach(l => { l.groupId = gid; });
  const first = mapLayers.findIndex(l => l.id === members[0].id);
  const rest  = mapLayers.filter(l => !ids.includes(l.id));
  rest.splice(Math.min(first, rest.length), 0, ...members);
  mapLayers = rest;
  _syncLayerOrder();
  renderLayers();
  return gid;
};

// Вынести слой (или всё выделение) из группы, не разбирая её
window.removeFromGroup = function(id) {
  const ids = _targetLayers(id);
  const affected = mapLayers.filter(l => ids.includes(l.id) && l.groupId);
  if (!affected.length) { setSt('Слой не в группе', 'err'); return; }
  if (typeof mapUndoPush === 'function') mapUndoPush('вынести из группы');
  affected.forEach(l => { delete l.groupId; });
  _compactGroups();   // если группа опустела — она исчезнет из панели
  _syncLayerOrder();
  renderLayers();
  setSt(affected.length > 1 ? `Вынесено из группы: ${affected.length}` : `«${affected[0].name}» вынесен из группы`, 'ok');
};

window.ungroupLayers = function(gid) {
  if (typeof mapUndoPush === 'function') mapUndoPush('разгруппировка');
  mapLayers.forEach(l => { if (l.groupId === gid) delete l.groupId; });
  delete _layerGroups[gid];
  renderLayers();
  setSt('Группа разобрана', 'ok');
};

// Есть ли такая группа (нужно РТ: они помнят свою группу сами)
window._layerGroupExists = gid => !!(gid && _layerGroups[gid]);
// Имя группы — окно РТ показывает его в строке точки
window.getLayerGroupName = gid => (gid && _layerGroups[gid]) ? _layerGroups[gid].name : '';
// Имя и свёрнутость — панели редактора PDF, чтобы рисовать группы так же
window.getLayerGroupInfo = gid => (gid && _layerGroups[gid])
  ? { name: _layerGroups[gid].name, collapsed: !!_layerGroups[gid].collapsed } : null;

window.toggleLayerGroup = function(gid) {
  const g = _layerGroups[gid];
  if (!g) return;
  g.collapsed = !g.collapsed;
  renderLayers();
};

// Видимость всей группы одним переключателем
window.toggleGroupVis = function(e, gid) {
  e.stopPropagation();
  const members = mapLayers.filter(l => l.groupId === gid);
  // В редакторе листа PDF — та же развилка, что и в toggleVis: видимость
  // группы переключается только для текущего листа, глобальный l.visible
  // не трогаем (иначе групповой тумблер обходил бы по-листовую модель).
  const pdfEditorEl = document.getElementById('pdf-editor');
  if (pdfEditorEl && pdfEditorEl.style.display !== 'none' && typeof window._pdfSheetVisiblePublic === 'function' && typeof window._pdfSetSheetVis === 'function') {
    const anyVisPdf = members.some(l => window._pdfSheetVisiblePublic(l));
    members.forEach(l => window._pdfSetSheetVis(l, !anyVisPdf));
    return;
  }
  const anyVisible = members.some(l => l.visible !== false);
  members.forEach(l => {
    l.visible = !anyVisible;
    if (typeof window._reconcileLayerVis === 'function') window._reconcileLayerVis(l);
    if (!l.poly && typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(l);
    if (typeof window._pdfOnLayerToggled === 'function') window._pdfOnLayerToggled(l);
  });
  renderLayers();
};

// Переименование идёт прямо в строке списка — как у слоёв.
// Раньше тут было системное окно Windows — как и ещё в двух десятках мест
// и выбивался из остального интерфейса.
window.renameLayerGroup = function(gid) {
  // startGroupRename правит имя прямо в строке панели, но строки может не
  // быть в DOM (например, в панели PDF-редактора — там своя разметка без
  // #gname-<gid>). Раньше здесь проверялось window.startGroupRename как
  // функция — она существует всегда, поэтому askText ниже не вызывался
  // никогда, и в PDF-редакторе «Переименовать» молча ничего не делало.
  if (window.startGroupRename && window.startGroupRename(gid)) return;
  const g = _layerGroups[gid];
  if (!g) return;
  askText('Название группы', g.name, v => {
    g.name = v || g.name;
    renderLayers();
  });
};

// Группы уходят в проект вместе со слоями
window.captureLayerGroups = () => ({
  // пустые группы в проект не пишем
  groups: JSON.parse(JSON.stringify(Object.fromEntries(
    Object.entries(_layerGroups).filter(([gid]) => mapLayers.some(l => l.groupId === gid))))),
  // key — стабильный ключ слоя: поли-слои имеют id:N, авто-слои — type:X.
  // Без него при повторном открытии проекта авто-слои (источники, выноски) теряли
  // членство в группе: их id меняется при каждой загрузке, найти их по id нельзя
  members: mapLayers.filter(l => l.groupId)
    .map(l => ({ id: l.id, mpId: l.mpId || undefined, gid: l.groupId, key: _layerKey(l) })),
});
window.restoreLayerGroups = (data) => {
  _layerGroups = (data && data.groups) ? JSON.parse(JSON.stringify(data.groups)) : {};
  const members = (data && data.members) || [];
  // byId — поли-слои (id стабилен, пишется в проект)
  const byId  = new Map(members.map(m => [String(m.id), m.gid]));
  // byKey — авто-слои (type:src-emission и т.п.), чей id меняется при загрузке
  const byKey = new Map(members.filter(m => m.key).map(m => [m.key, m.gid]));
  mapLayers.forEach(l => {
    // Слои-точки получают id заново при каждой загрузке, поэтому их членство
    // в группе восстанавливает сама РТ (pt.groupId) — здесь его не трогаем
    if (l.mpId) return;
    const gid = byId.get(String(l.id)) || byKey.get(_layerKey(l));
    if (gid && _layerGroups[gid]) l.groupId = gid; else delete l.groupId;
  });
  _selLayerIds.clear();
};


// Пустое место панели — зона «вынести из группы»: бросил слой мимо строк,
// он вышел из группы и встал в конец списка
function _initLayerBoxDrop(box) {
  if (!box || box._dropBound) return;
  box._dropBound = true;
  box.addEventListener('dragover', e => {
    if (_dragKind !== 'layer' || draggedLayerIdx === null) return;
    const onRow = e.target.closest && e.target.closest('.li-row, .li-group');
    if (onRow) { box.classList.remove('drop-out'); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    box.classList.add('drop-out');
  });
  box.addEventListener('dragleave', e => { if (e.target === box) box.classList.remove('drop-out'); });
  box.addEventListener('drop', e => {
    box.classList.remove('drop-out');
    if (_dragKind !== 'layer' || draggedLayerIdx === null) return;
    if (e.target.closest && e.target.closest('.li-row, .li-group')) return;   // строку обрабатывает она сама
    e.preventDefault();
    const moved = mapLayers[draggedLayerIdx];
    if (!moved) return;
    if (typeof mapUndoPush === 'function') mapUndoPush('вынести из группы');
    const wasInGroup = !!moved.groupId;
    delete moved.groupId;
    mapLayers.splice(draggedLayerIdx, 1);
    mapLayers.push(moved);
    draggedLayerIdx = null; _dragKind = null;
    _compactGroups(); _syncLayerOrder(); renderLayers();
    setSt(wasInGroup ? `«${moved.name}» вынесен из группы` : 'Слой перемещён в конец списка', 'ok');
  });
}

// ── Перетаскивание слоёв и групп ────────────────────────────────────────────
// Слой можно бросить на заголовок группы или на её участника — он войдёт
// в группу. Брошенный на обычный слой — выйдет из группы.
// Заголовок группы тащится целиком вместе с содержимым.
let _dragKind = null;        // 'layer' | 'group'
let _dragGroupId = null;

// Непрерывный блок слоёв одной группы
function _groupBlock(gid) {
  const members = mapLayers.filter(l => l.groupId === gid);
  const start = mapLayers.findIndex(l => l.groupId === gid);
  return { start, members };
}

// Переставить слои так, чтобы участники группы шли подряд
function _compactGroups() {
  // Группа без слоёв больше не нужна
  Object.keys(_layerGroups).forEach(gid => {
    if (!mapLayers.some(l => l.groupId === gid)) delete _layerGroups[gid];
  });
  const seen = new Set();
  const out = [];
  mapLayers.forEach(l => {
    const gid = l.groupId;
    if (!gid || !_layerGroups[gid]) { if (!seen.has(l)) out.push(l); return; }
    if (seen.has(l)) return;
    mapLayers.filter(x => x.groupId === gid).forEach(x => { out.push(x); seen.add(x); });
  });
  mapLayers = out;
}

window.onGroupDragStart = function(e, gid) {
  _dragKind = 'group'; _dragGroupId = gid; draggedLayerIdx = null;
  e.dataTransfer.effectAllowed = 'move';
  e.stopPropagation();
};

window.onGroupDragOver = function(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
};
window.onGroupDragLeave = function(e) { e.currentTarget.classList.remove('drag-over'); };

// Бросили на заголовок группы
window.onGroupDrop = function(e, gid) {
  e.preventDefault(); e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  if (typeof mapUndoPush === 'function') mapUndoPush('перенос в группу');

  if (_dragKind === 'layer' && draggedLayerIdx !== null) {
    // Слои входят в группу и встают в конец её блока
    const ids = (_dragLayerIds && _dragLayerIds.length)
      ? _dragLayerIds
      : [(mapLayers[draggedLayerIdx] || {}).id];
    const moved = mapLayers.filter(l => ids.includes(l.id));
    mapLayers = mapLayers.filter(l => !ids.includes(l.id));
    moved.forEach(m => { m.groupId = gid; });
    const { members } = _groupBlock(gid);
    const inPlace = members.filter(m => mapLayers.includes(m));
    const lastIdx = inPlace.length
      ? mapLayers.lastIndexOf(inPlace[inPlace.length - 1])
      : mapLayers.length - 1;
    mapLayers.splice(lastIdx + 1, 0, ...moved);
    _dragLayerIds = null;
    setSt(moved.length > 1
      ? `Слоёв перенесено в «${_layerGroups[gid].name}»: ${moved.length}`
      : `Слой «${moved[0] ? moved[0].name : ''}» перенесён в группу «${_layerGroups[gid].name}»`, 'ok');
  } else if (_dragKind === 'group' && _dragGroupId && _dragGroupId !== gid) {
    // Группу на группу — вкладываем одну в другую (Alt — просто переставить рядом)
    if (!e.altKey && window.nestGroupInto) {
      const okNest = window.nestGroupInto(_dragGroupId, gid);
      _dragKind = null; _dragGroupId = null; draggedLayerIdx = null;
      if (okNest) return;
    }
    const src = mapLayers.filter(l => l.groupId === _dragGroupId);
    const rest = mapLayers.filter(l => l.groupId !== _dragGroupId);
    const at = rest.findIndex(l => l.groupId === gid);
    rest.splice(at < 0 ? rest.length : at, 0, ...src);
    mapLayers = rest;
  }
  _dragKind = null; _dragGroupId = null; draggedLayerIdx = null;
  _compactGroups();
  _syncLayerOrder();
  renderLayers();
};

// Переместить группу целиком вверх/вниз
window.moveGroupOrder = function(gid, dir) {
  const { members } = _groupBlock(gid);
  if (!members.length) return;
  if (typeof mapUndoPush === 'function') mapUndoPush('порядок групп');
  const rest = mapLayers.filter(l => l.groupId !== gid);
  const firstIdx = mapLayers.indexOf(members[0]);
  const lastIdx  = mapLayers.indexOf(members[members.length - 1]);
  // Соседний элемент за пределами блока: слой или целая соседняя группа
  let at;
  if (dir < 0) {
    const prev = mapLayers[firstIdx - 1];
    if (!prev) return;
    at = prev.groupId ? rest.indexOf(mapLayers.filter(l => l.groupId === prev.groupId)[0]) : rest.indexOf(prev);
  } else {
    const next = mapLayers[lastIdx + 1];
    if (!next) return;
    const blk = next.groupId ? mapLayers.filter(l => l.groupId === next.groupId) : [next];
    at = rest.indexOf(blk[blk.length - 1]) + 1;
  }
  if (at < 0) at = rest.length;
  rest.splice(at, 0, ...members);
  mapLayers = rest;
  _compactGroups();
  _syncLayerOrder();
  renderLayers();
};

// ── Пресеты стилей слоёв ────────────────────────────────────────────────────
// Готовые оформления одним кликом + свои, сохранённые пользователем
const LAYER_PRESETS_BUILTIN = [
  { id:'zu',   name:'ЗУ',            style:{ color:'#f59e0b', fillColor:'#f59e0b', fillOpacity:0.15, opacity:1, weight:2,   dashArray:null,      fillPattern:'solid'   } },
  { id:'szz',  name:'СЗЗ',           style:{ color:'#c084fc', fillColor:'#c084fc', fillOpacity:0.10, opacity:1, weight:2,   dashArray:'8,5',     fillPattern:'solid'   } },
  { id:'zhil', name:'Жилая зона',    style:{ color:'#ef4444', fillColor:'#ef4444', fillOpacity:0.18, opacity:1, weight:1.5, dashArray:null,      fillPattern:'hatch-l' } },
  { id:'prom', name:'Промзона',      style:{ color:'#64748b', fillColor:'#64748b', fillOpacity:0.18, opacity:1, weight:1.5, dashArray:null,      fillPattern:'hatch-r' } },
  { id:'voda', name:'Водоохранная',  style:{ color:'#0ea5e9', fillColor:'#0ea5e9', fillOpacity:0.14, opacity:1, weight:1.5, dashArray:'2,6',     fillPattern:'solid'   } },
  { id:'ohr',  name:'Охранная зона', style:{ color:'#22c55e', fillColor:'#22c55e', fillOpacity:0.12, opacity:1, weight:1.5, dashArray:'12,4,2,4',fillPattern:'grid'    } },
];

function _userPresets() {
  return (typeof Store !== 'undefined' ? Store.get('layerPresets', []) : []) || [];
}

window.applyLayerPreset = function(id) {
  const all = [...LAYER_PRESETS_BUILTIN, ..._userPresets()];
  const p = all.find(x => x.id === id);
  const al = getActiveLayer();
  if (!p || !al || !al.layer) return;
  if (typeof mapUndoPush === 'function') mapUndoPush('стиль слоя');
  al._psStyle = { ...p.style };
  al.color = p.style.color;
  try { al.layer.setStyle(al._psStyle); } catch(e) {}
  if (p.style.fillPattern && p.style.fillPattern !== 'solid' && typeof window._applyFillPattern === 'function') {
    const apply = () => {
      if (typeof al.layer.eachLayer === 'function') al.layer.eachLayer(sub => window._applyFillPattern(sub, p.style.fillColor, p.style.fillPattern));
      else window._applyFillPattern(al.layer, p.style.fillColor, p.style.fillPattern);
    };
    apply(); requestAnimationFrame(apply);
  }
  if (typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(al);
  if (typeof window._pdfOnLayerStyleChanged === 'function') window._pdfOnLayerStyleChanged(al);
  showLayerProps(al);
  renderLayers();
  setSt(`Стиль «${p.name}» применён`, 'ok');
};

window.saveLayerPreset = function() {
  const al = getActiveLayer();
  if (!al || !al._psStyle) { setSt('Выберите слой', 'err'); return; }
  askText('Название стиля', al.name || 'Мой стиль', name => {
    if (!name) return;
    const list = _userPresets();
    list.push({ id: 'u_' + Date.now(), name, style: { ...al._psStyle } });
    if (typeof Store !== 'undefined') Store.set('layerPresets', list);
    showLayerProps(al);
    setSt(`Стиль «${name}» сохранён`, 'ok');
  });
};

window.deleteLayerPreset = function(id) {
  const list = _userPresets().filter(p => p.id !== id);
  if (typeof Store !== 'undefined') Store.set('layerPresets', list);
  showLayerProps(getActiveLayer());
};

// Кнопки пресетов в панели стиля слоя
window._confirmDeleteLayerPreset = function(id) {
  const p = _userPresets().find(x => x.id === id);
  askConfirm('Удалить стиль?', `«${escapeHtml(p ? p.name : '')}» будет удалён из готовых стилей.`, () => deleteLayerPreset(id));
};

function _renderLayerPresets() {
  const box = document.getElementById('lp-presets');
  if (!box) return;
  const user = _userPresets();
  const chip = (p, own) =>
    `<button onclick="applyLayerPreset('${p.id}')" title="${own ? 'Свой стиль — ПКМ удалить' : 'Готовый стиль'}"
       ${own ? `oncontextmenu="event.preventDefault();_confirmDeleteLayerPreset('${p.id}')"` : ''}
       style="display:inline-flex;align-items:center;gap:4px;padding:2px 6px;font-size:var(--fs-1);border-radius:var(--r-sm);
              border:1px solid var(--brd);background:var(--bg2);color:var(--tx1);cursor:pointer">
       <span style="width:11px;height:11px;border-radius:var(--r-xs);background:${hexToRgba(p.style.fillColor, p.style.fillOpacity)};
                    border:1.5px ${p.style.dashArray ? 'dashed' : 'solid'} ${p.style.color}"></span>${escapeHtml(p.name)}</button>`;
  box.innerHTML =
    LAYER_PRESETS_BUILTIN.map(p => chip(p, false)).join('') +
    user.map(p => chip(p, true)).join('') +
    `<button onclick="saveLayerPreset()" title="Сохранить текущий стиль как свой"
        style="padding:2px 6px;font-size:var(--fs-1);border-radius:var(--r-sm);border:1px dashed var(--brd);
               background:none;color:var(--tx2);cursor:pointer">+ свой</button>`;
}

// ── Отмена/повтор на главной карте ──────────────────────────────────────────
// Снимок состояния проекта перед каждым изменяющим действием. Восстановление
// идёт через тот же _restoreAppState, что и переключение вкладок, поэтому
// возвращаются и слои, и источники, и РТ, и их стили.
let _mapUndo = [], _mapRedo = [];
const MAP_UNDO_LIMIT = 25;
let _mapUndoBusy = false;

window.mapUndoPush = function(label) {
  if (typeof markDirty === 'function') markDirty();
  if (_mapUndoBusy || typeof _captureAppState !== 'function') return;
  try {
    _mapUndo.push({ label: label || '', state: _captureAppState() });
    if (_mapUndo.length > MAP_UNDO_LIMIT) _mapUndo.shift();
    _mapRedo = [];
    _mapUndoBtns();
  } catch(e) {}
};

function _mapUndoBtns() {
  const u = document.getElementById('rb-btn-undo'), r = document.getElementById('rb-btn-redo');
  if (u) u.disabled = !_mapUndo.length;
  if (r) r.disabled = !_mapRedo.length;
}

function _mapUndoApply(stack, other, msg) {
  if (!stack.length || typeof _restoreAppState !== 'function') { setSt('Нечего отменять'); return; }
  const cur = _captureAppState();
  const snap = stack.pop();
  other.push({ label: snap.label, state: cur });
  _mapUndoBusy = true;
  try { _restoreAppState(snap.state); } finally { _mapUndoBusy = false; }
  _mapUndoBtns();
  setSt(msg + (snap.label ? ': ' + snap.label : ''), 'ok');
}

window.mapUndo = () => _mapUndoApply(_mapUndo, _mapRedo, 'Отменено');
window.mapRedo = () => _mapUndoApply(_mapRedo, _mapUndo, 'Возвращено');

// ── Координаты вершин полигона прямо в свойствах слоя ───────────────────────
// Показываем/принимаем как WGS-84, так и любую МСК из справочника CRS_DB
function _lpFillVertCrs() {
  const sel = document.getElementById('lp-verts-crs');
  if (!sel || sel.options.length || typeof CRS_DB === 'undefined') return;
  let html = '<option value="wgs84">WGS-84 (градусы)</option>';
  let last = null;
  CRS_DB.forEach(c => {
    if (!c.p4) return;
    if (c.group !== last) { if (last !== null) html += '</optgroup>'; html += `<optgroup label="${c.group || ''}">`; last = c.group; }
    html += `<option value="${c.id}">${c.name}</option>`;
  });
  if (last !== null) html += '</optgroup>';
  sel.innerHTML = html;
  const saved = localStorage.getItem('szztool_crs');
  if (saved) sel.value = saved;
}

// Свернуть/развернуть блок координат вершин
window.toggleVertsBlock = function() {
  const b = document.getElementById('lp-verts-body');
  const a = document.getElementById('lp-verts-arrow');
  if (!b) return;
  const open = b.style.display !== 'none';
  b.style.display = open ? 'none' : '';
  if (a) a.textContent = open ? '▸' : '▾';
  if (!open) renderLayerVerts();
};

window.renderLayerVerts = function() {
  const l = getActiveLayer();
  const box = document.getElementById('lp-verts-row');
  const ta  = document.getElementById('lp-verts');
  if (!box || !ta) return;
  if (!l || !l.poly || !l.poly.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  _lpFillVertCrs();
  const crsId = (document.getElementById('lp-verts-crs') || {}).value || 'wgs84';
  const toXY  = (typeof wgsToCrs === 'function') ? wgsToCrs : null;
  ta.value = l.poly.map(([lat, lon], i) => {
    if (crsId !== 'wgs84' && toXY) {
      const xy = toXY(lat, lon, crsId);
      if (xy) return `${xy.x.toFixed(2)}, ${xy.y.toFixed(2)}`;
    }
    return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }).join('\n');
  const cnt = document.getElementById('lp-verts-cnt');
  if (cnt) cnt.textContent = l.poly.length + ' точек';
};

window.applyLayerVerts = function() {
  const l = getActiveLayer();
  const ta = document.getElementById('lp-verts');
  if (!l || !ta) return;
  const crsId = (document.getElementById('lp-verts-crs') || {}).value || 'wgs84';
  const pts = [];
  ta.value.split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t) return;
    const m = t.split(/[;,\s]+/).map(parseFloat).filter(isFinite);
    if (m.length < 2) return;
    if (crsId !== 'wgs84' && typeof CRS_DB !== 'undefined') {
      const crs = CRS_DB.find(c => c.id === crsId);
      const ll = (typeof transformToWGS84 === 'function') ? transformToWGS84(m[0], m[1], crs) : null;
      if (ll) pts.push(ll);
    } else {
      pts.push([m[0], m[1]]);
    }
  });
  if (pts.length < 3) { setSt('Нужно минимум 3 точки', 'err'); return; }
  if (typeof mapUndoPush === 'function') mapUndoPush();
  l.poly = pts;
  try {
    l.layer.setLatLngs(pts.map(p => L.latLng(p[0], p[1])));
    if (l.geojson) delete l.geojson;
  } catch(e) { setSt('Не удалось применить координаты', 'err'); return; }
  _syncLayerOrder();
  renderLayers();
  if (typeof window._pdfOnLayerStyleChanged === 'function') window._pdfOnLayerStyleChanged(l);
  try { map.fitBounds(l.layer.getBounds(), { padding: [40, 40] }); } catch(e) {}
  setSt(`Координаты обновлены (${pts.length} точек)`, 'ok');
};

// ── Панель свойств: чтение всех полей одним объектом ────────────────────────
function _lpReadValues() {
  const q = id => document.getElementById(id);
  const num = (id, d) => { const e = q(id); const v = e ? parseFloat(e.value) : NaN; return isFinite(v) ? v : d; };
  const val = (id, d) => { const e = q(id); return (e && e.value !== '') ? e.value : d; };
  return {
    fillColor:   val('lp-fill-color',   '#f59e0b'),
    color:       val('lp-stroke-color', '#f59e0b'),
    fillOpacity: num('lp-fill-opacity', 15) / 100,
    opacity:     num('lp-stroke-opacity', 100) / 100,
    weight:      num('lp-weight', 2),
    dashArray:   (q('lp-dash') || {}).value || null,
    fillPattern: val('lp-fill-pattern', 'solid'),
    zoneType:    (q('lp-zone-type') || {}).value || null,
    textColor:       val('lp-text-color', '#111827'),
    textStrokeWidth: num('lp-text-stroke-w', 0),
    textStrokeColor: val('lp-text-stroke-color', '#ffffff'),
    fontFamily:      val('lp-font-family', 'Arial,sans-serif'),
    fontSize:        num('lp-font-size', 12),
    calloutColor:     val('lp-zu-callout-color', '#111827'),
    calloutLineWidth: num('lp-zu-callout-lw', 1.5),
  };
}
window._lpReadValues = _lpReadValues;

// Слои, к которым относится панель свойств: всё выделение либо активный слой
function _propsTargets() {
  const al = getActiveLayer();
  if (!al) return [];
  if (_selLayerIds.size > 1 && _selLayerIds.has(al.id)) {
    const sel = mapLayers.filter(l => _selLayerIds.has(l.id));
    return sel.length ? sel : [al];
  }
  return [al];
}
window._propsTargets = _propsTargets;

// Поля, которых пользователь уже касался. При мультивыделении на остальные
// слои раскатываются только они — иначе первое движение ползунка затёрло бы
// всем остальным цвет, штриховку и тип линии.
let _lpTouched = new Set();
window._lpTouchedReset = () => { _lpTouched = new Set(); };
window._lpIsTouched    = f => _lpTouched.has(f);

// Подписи-значения рядом с ползунками — обновляются один раз за вызов
function _lpSyncLabels(V) {
  const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
  set('lp-fill-val',          Math.round(V.fillOpacity * 100) + '%');
  set('lp-stroke-val',        Math.round(V.opacity * 100) + '%');
  set('lp-weight-val',        V.weight + 'px');
  set('lp-text-stroke-w-val', V.textStrokeWidth + 'px');
  set('lp-font-size-val',     V.fontSize + 'px');
  set('lp-zu-callout-lw-val', V.calloutLineWidth + 'px');
}

// Точка входа из панели. field — какое именно поле тронули.
function applyLayerProps(field) {
  const al = getActiveLayer();
  if (!al || !al.layer) return;
  if (field) _lpTouched.add(field);

  const V = _lpReadValues();
  _lpSyncLabels(V);

  const targets = _propsTargets();
  // Одиночный слой ведёт себя ровно как раньше — применяется весь набор полей.
  const only = (targets.length > 1) ? new Set(field ? [field] : _lpTouched) : null;

  targets.forEach(t => {
    try { _applyPropsToLayer(t, V, only); }
    catch (e) { console.warn('applyLayerProps', t && t.id, e); }
  });

  if (typeof renderLayerVerts    === 'function') renderLayerVerts();
  if (typeof _renderLayerPresets === 'function') _renderLayerPresets();
  renderLayers();
  if (typeof markDirty === 'function') markDirty();
  if (targets.length > 1) setSt(`Стиль применён к слоям: ${targets.length}`, 'ok');
}
window.applyLayerProps = applyLayerProps;

// Движок: применяет значения V к одному слою.
// only — набор разрешённых полей (null = применять всё).
function _applyPropsToLayer(al, V, only) {
  if (!al || !al.layer) return;
  const ok  = f => !only || only.has(f);
  const cur = al._psStyle || {};
  const _isSrcTypeL = ['sources','src-emission','src-noise','src-other'].includes(al.type);
  const defColor = _isSrcTypeL ? (al.color || '#ef4444')
                 : al.type === 'monpoints' ? '#3b82f6'
                 : (al.color || '#f59e0b');
  const defFo = al.type === 'szz' ? 0.1 : 0.15;

  const fc   = ok('fillColor')   ? V.fillColor   : (cur.fillColor   ?? defColor);
  const sc   = ok('color')       ? V.color       : (cur.color       ?? defColor);
  const fo   = ok('fillOpacity') ? V.fillOpacity : (cur.fillOpacity ?? defFo);
  const so   = ok('opacity')     ? V.opacity     : (cur.opacity     ?? 1);
  const w    = ok('weight')      ? V.weight      : (cur.weight      ?? 2);
  const dash = ok('dashArray')   ? (V.dashArray || null) : (cur.dashArray ?? null);
  const fp   = ok('fillPattern') ? V.fillPattern : (cur.fillPattern ?? 'solid');

  const newStyle = { fillColor: fc, color: sc, fillOpacity: fo, opacity: so, weight: w, dashArray: dash, fillPattern: fp };
  al._psStyle = newStyle;
  if (ok('color')) al.color = sc;

  if ((al.type === 'parcel' || al.type === 'szz') && ok('zoneType') && V.zoneType) {
    al.zoneType = V.zoneType;
  }

  const _CALLOUT_SRCTYPE = {
    'src-callouts': null, 'src-callouts-emission': 'emission',
    'src-callouts-noise': 'noise', 'src-callouts-other': 'other',
  };
  const _isSrcCalloutType = Object.prototype.hasOwnProperty.call(_CALLOUT_SRCTYPE, al.type);
  if (_isSrcCalloutType || al.type === 'mp-callouts') {
    const tc  = ok('textColor')       ? V.textColor       : undefined;
    const tsw = ok('textStrokeWidth') ? V.textStrokeWidth : undefined;
    const tsc = ok('textStrokeColor') ? V.textStrokeColor : undefined;
    const ff  = ok('fontFamily')      ? V.fontFamily      : undefined;
    const fs  = ok('fontSize')        ? V.fontSize        : undefined;
    if (_isSrcCalloutType && typeof _applyCalloutStyle === 'function') {
      const st = { sourceType: _CALLOUT_SRCTYPE[al.type] };
      if (ok('color'))  st.color     = sc;
      if (ok('weight')) st.lineWidth = w;
      if (tc  !== undefined) st.textColor       = tc;
      if (tsc !== undefined) st.textStrokeColor = tsc;
      if (tsw !== undefined) st.textStrokeWidth = tsw;
      if (ff  !== undefined) st.fontFamily      = ff;
      if (fs  !== undefined) st.fontSize        = fs;
      _applyCalloutStyle(st);
    } else if (al.type === 'mp-callouts' && typeof _monPoints !== 'undefined') {
      _monPoints.forEach(pt => {
        if (ok('color'))  pt.calloutColor     = sc;
        if (ok('weight')) pt.calloutLineWidth = w;
        if (tc  !== undefined) pt.calloutTextColor   = tc;
        if (tsc !== undefined) pt.calloutStrokeColor = tsc;
        if (tsw !== undefined) pt.calloutStrokeWidth = tsw;
        if (ff  !== undefined) pt.calloutFontFamily  = ff;
        if (fs  !== undefined) pt.calloutFontSize    = fs;
      });
      _monPoints.forEach(pt => {
        (pt._calloutLayers || []).forEach(l => { if (l._draw && l._s) l._draw(); });
      });
      if (typeof _saveMonPoints === 'function') _saveMonPoints();
    }
    if (ok('color')) al.color = sc;
    al._psStyle = { ...al._psStyle, color: sc, weight: w };
    if (typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(al);
    if (typeof window._pdfOnLayerStyleChanged === 'function') window._pdfOnLayerStyleChanged(al);
    return;
  } else if (al.type === 'monpoints') {
    if (typeof _monPoints !== 'undefined') {
      _monPoints.forEach(pt => {
        if (ok('color')) pt.color = sc;
        if (pt._circleLayer) pt._circleLayer.setStyle({ color: sc, fillColor: sc, fillOpacity: fo, weight: w });
      });
      if (typeof _saveMonPoints === 'function') _saveMonPoints();
    }
  } else if (_isSrcTypeL) {
    // Обновляем стиль всех источников слоя и перерисовываем
    const srcTypeFilter = al.type === 'sources' ? null : al.type.replace('src-', '');
    if (typeof _sources !== 'undefined' && typeof _clearSourceLayers === 'function' && typeof _drawSource === 'function') {
      const toUpdate = srcTypeFilter ? _sources.filter(s => (s.type || 'emission') === srcTypeFilter) : _sources;
      toUpdate.forEach(s => {
        if (ok('color'))       s.color         = sc;
        if (ok('fillColor'))   s.fillColor     = fc;
        if (ok('fillOpacity')) s.fillOpacity   = fo;
        if (ok('opacity'))     s.strokeOpacity = so;
        if (ok('weight'))      s.weight        = w;
        if (ok('fillPattern')) s.fillPattern   = fp;
      });
      toUpdate.forEach(s => { _clearSourceLayers(s); _drawSource(s); });
    } else {
      al.layer.eachLayer(sub => {
        if (sub.setStyle) sub.setStyle(newStyle);
        else if (typeof sub.eachLayer === 'function')
          sub.eachLayer(s2 => { if (s2.setStyle) s2.setStyle(newStyle); });
      });
    }
    // Синхронизируем стиль с PDF-картой если редактор открыт
    if (typeof _pdfSourceLayers !== 'undefined' && _pdfSourceLayers.length) {
      _pdfSourceLayers.forEach(l => {
        if (l.setStyle) l.setStyle(newStyle);
        else if (typeof l.eachLayer === 'function')
          l.eachLayer(s2 => { if (s2.setStyle) s2.setStyle(newStyle); });
      });
    }
  } else {
    if (al.layer.setStyle) al.layer.setStyle(newStyle);
    // Применяем SVG-паттерн заливки для ЗУ/СЗЗ
    if (typeof window._applyFillPattern === 'function' && fp !== 'solid') {
      const applyPat = () => {
        if (typeof al.layer.eachLayer === 'function') {
          al.layer.eachLayer(sub => window._applyFillPattern(sub, fc, fp));
        } else {
          window._applyFillPattern(al.layer, fc, fp);
        }
      };
      applyPat();
      requestAnimationFrame(applyPat);
    }
  }

  // Стиль собственной выноски слоя — из тех же полей, что и у выносок источников
  if (al.callout && al.callout.on && typeof window._applyLayerCalloutStyle === 'function') {
    const st = {};
    if (ok('calloutColor'))     st.calloutColor       = V.calloutColor;
    if (ok('calloutLineWidth')) st.calloutLineWidth   = V.calloutLineWidth;
    if (ok('textColor'))        st.calloutTextColor   = V.textColor;
    if (ok('textStrokeColor'))  st.calloutStrokeColor = V.textStrokeColor;
    if (ok('textStrokeWidth'))  st.calloutStrokeWidth = V.textStrokeWidth;
    if (ok('fontFamily'))       st.calloutFontFamily  = V.fontFamily;
    if (ok('fontSize'))         st.calloutFontSize    = V.fontSize;
    if (Object.keys(st).length) window._applyLayerCalloutStyle(al, st);
  }
  if (typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(al);
  // Стиль должен сразу совпадать и на карте редактора PDF
  if (typeof window._pdfOnLayerStyleChanged === 'function') window._pdfOnLayerStyleChanged(al);
}
window._applyPropsToLayer = _applyPropsToLayer;

let _dragLayerIds = null;
function onLayerDragStart(e, idx) {
  _dragKind = 'layer'; _dragGroupId = null;
  draggedLayerIdx = idx;
  const dl = mapLayers[idx];
  if (window._lockGuard && window._lockGuard(dl, 'перетаскивание')) { e.preventDefault(); return; }
  // Тянут одну из выделенных строк — значит едет всё выделение
  _dragLayerIds = (dl && _selLayerIds.size > 1 && _selLayerIds.has(dl.id))
    ? mapLayers.filter(x => _selLayerIds.has(x.id)).map(x => x.id)
    : (dl ? [dl.id] : []);
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    document.querySelectorAll('.li-row').forEach(r => {
      const nm = r.querySelector('.li-name');
      const rid = nm ? Number(String(nm.id).replace('lname-', '')) : NaN;
      if (_dragLayerIds.includes(rid)) r.style.opacity = '0.4';
    });
    if (e.target && e.target.style) e.target.style.opacity = '0.4';
  }, 0);
}
function onLayerDragEnd(e) {
  if (e.target && e.target.style) e.target.style.opacity = '1';
  document.querySelectorAll('.li-row').forEach(el => { el.classList.remove('drag-over'); el.style.opacity = '1'; });
  document.querySelectorAll('.li-group').forEach(el => el.classList.remove('drag-over'));
  _dragLayerIds = null;
}
function onLayerDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onLayerDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onLayerDrop(e, dropIdx) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  // На слой бросили группу — ставим весь её блок на это место
  if (_dragKind === 'group' && _dragGroupId) {
    const target = mapLayers[dropIdx];
    const src  = mapLayers.filter(l => l.groupId === _dragGroupId);
    const rest = mapLayers.filter(l => l.groupId !== _dragGroupId);
    const at = rest.indexOf(target);
    rest.splice(at < 0 ? rest.length : at, 0, ...src);
    mapLayers = rest;
    _dragKind = null; _dragGroupId = null;
    _compactGroups(); _syncLayerOrder(); renderLayers();
    return;
  }
  if (draggedLayerIdx === null) return;
  const ids = (_dragLayerIds && _dragLayerIds.length)
    ? _dragLayerIds
    : [(mapLayers[draggedLayerIdx] || {}).id];
  const target = mapLayers[dropIdx];
  // Бросили на саму же перетаскиваемую строку — делать нечего
  if (!target || ids.includes(target.id)) {
    draggedLayerIdx = null; _dragKind = null; _dragLayerIds = null;
    return;
  }
  if (typeof mapUndoPush === 'function') mapUndoPush('порядок слоёв');
  const moved = mapLayers.filter(l => ids.includes(l.id));
  const rest  = mapLayers.filter(l => !ids.includes(l.id));
  // Группу берём у строки, на которую бросили: внутрь группы — входим,
  // на обычный слой — выходим из группы
  const targetGid = target.groupId || null;
  moved.forEach(m => {
    if (targetGid && _layerGroups[targetGid]) m.groupId = targetGid;
    else delete m.groupId;
  });
  const at = rest.indexOf(target);
  rest.splice(at < 0 ? rest.length : at, 0, ...moved);
  mapLayers = rest;
  draggedLayerIdx = null; _dragKind = null; _dragLayerIds = null;
  _compactGroups();
  _syncLayerOrder();
  renderLayers();
  if (moved.length > 1) setSt(`Перемещено слоёв: ${moved.length}`, 'ok');
}

// Переместить слой в списке на одну позицию (как слои в фотошопе:
// выше в списке — выше на карте)
window.moveLayerOrder = function(id, dir) {
  const i = mapLayers.findIndex(l => l.id === id);
  if (i < 0) return;
  if (typeof mapUndoPush === 'function') mapUndoPush('порядок слоёв');
  const j = i + dir;
  if (j < 0 || j >= mapLayers.length) return;
  const [moved] = mapLayers.splice(i, 1);
  mapLayers.splice(j, 0, moved);
  _syncLayerOrder();
  renderLayers();
};

// Синхронизирует z-порядок Leaflet-слоёв с порядком в панели слоёв.
// mapLayers[0] = верх списка = должен рисоваться поверх всего.
// В Leaflet последний добавленный слой — поверх всех,
// поэтому перебираем массив с конца (низ списка) к началу (верх).
function _syncLayerOrder() {
  if (!map) return;
  // Найденные ЗУ под слоями проекта держит их отдельная панель (см.
  // _parcelCanvas) — перебирать тысячи участков здесь больше не нужно.
  // bringToFront не пересоздаёт SVG-элемент — паттерн не слетает.
  // Идём с конца (низ списка) к началу (верх списка): последний bringToFront остаётся поверх всех.
  for (let i = mapLayers.length - 1; i >= 0; i--) {
    const l = mapLayers[i];
    if (!l.layer || !l.visible || !map.hasLayer(l.layer)) continue;
    if (typeof l.layer.bringToFront === 'function') l.layer.bringToFront();
    // Группы (источники, РТ) сами не умеют bringToFront — поднимаем их содержимое
    else if (typeof l.layer.eachLayer === 'function') {
      l.layer.eachLayer(sub => { if (typeof sub.bringToFront === 'function') { try { sub.bringToFront(); } catch(e) {} } });
    }
  }
  if (typeof _refreshPdfMapLayers === 'function') _refreshPdfMapLayers();
}

function handleLayerKey(e, id) {
  if (!e.target.classList.contains('li-row')) return;
  // Значки в строке не делаем отдельными остановками Tab — иначе на сотне
  // слоёв до карты не добраться. Их действия висят на самой строке.
  if (e.key === ' ')      { e.preventDefault(); startRename(id); }
  if (e.key === 'Enter')  { e.preventDefault(); selectLayer(id); }
  if (e.key === 'Delete') { e.preventDefault(); deleteLayer({ stopPropagation() {} }, id); }
}
function startRename(id) {
  const span = document.getElementById('lname-' + id);
  if (!span) return;
  span.contentEditable = 'true';
  span.focus();
  document.execCommand('selectAll', false, null);
}
function handleNameKey(e, id) {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.key === ' ') e.stopPropagation();
}
function saveLayerName(id) {
  const span = document.getElementById('lname-' + id);
  const l    = mapLayers.find(x => x.id === id);
  if (l && span) {
    const def = l.mpId ? 'РТ' : l.type === 'parcel' ? 'Участок' : 'СЗЗ';
    l.name = span.textContent.trim() || def;
    span.contentEditable = 'false';
    span.textContent = l.name;
    // Строка РТ — это сама точка: имя должно доехать до неё и до выноски
    if (l.mpId && typeof window.mpRenameFromLayer === 'function') {
      window.mpRenameFromLayer(l.mpId, l.name);
    }
    // Выноска по формуле включает {name} — пересчитываем подпись на новое имя
    if (l.callout && l.callout.formula && l.callout.on) _drawLayerCallout(l);
    if (typeof markDirty === 'function') markDirty();
  }
}
function toggleVis(e, id) {
  e.stopPropagation();
  const l = mapLayers.find(x => x.id === id);
  // Alt — оставить видимым только этот слой; повторный Alt возвращает всё
  if (e.altKey && window.isolateLayer) {
    e.preventDefault();
    window.isolateLayer(id);
    return;
  }
  if (!l) return;
  // Открыт редактор листа PDF — галочка в его панели слоёв переключает
  // видимость только для ТЕКУЩЕГО листа (pdfSheets[i].layerVis), а не
  // общий l.visible: иначе выключение на одном листе тут же меняло бы
  // картинку на всех остальных. На главной карте (вне режима PDF) поведение
  // не меняется — общий флаг, как и раньше.
  const pdfEditorEl = document.getElementById('pdf-editor');
  if (pdfEditorEl && pdfEditorEl.style.display !== 'none' && typeof window._pdfSetSheetVis === 'function') {
    window._pdfSetSheetVis(l, e.target.checked);
    return;
  }
  if (l) {
    l.visible = e.target.checked;
    l.visible ? map.addLayer(l.layer) : map.removeLayer(l.layer);
    _reapplyLayerStyle(l);
    // Выноска слоя прячется и возвращается вместе с ним
    if (l.callout && l.callout.on) { if (l.visible) _drawLayerCallout(l); else _clearLayerCallout(l); }
    // Запоминаем видимость авто-слоёв (РТ/источники/выноски): они пересоздаются
    // при загрузке проекта и иначе снова включились бы
    if (!l.poly && typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(l);
    // Точечно обновляем карту редактора: полная перестройка здесь не нужна
    if (typeof window._pdfOnLayerToggled === 'function') window._pdfOnLayerToggled(l);
    else if (typeof _refreshPdfMapLayers === 'function') _refreshPdfMapLayers();
    updatePdfOverlays();
  }
}
function deleteLayer(e, id) {
  e.stopPropagation();
  const l = mapLayers.find(x => x.id === id);
  if (window._lockGuard && window._lockGuard(l, 'удаление')) return;
  if (typeof mapUndoPush === 'function') mapUndoPush('удаление слоя');
  // Слои источников/РТ/выносок не имеют своей геометрии: они лишь отражают
  // содержимое менеджеров. Удалять надо сами данные, иначе объекты остаются
  // в списках, где их добавляют, и слой возвращается при первом же изменении.
  if (l) {
    const SRC_TYPE = { 'src-emission': 'emission', 'src-noise': 'noise', 'src-other': 'other' };
    const CALLOUT_TYPE = { 'src-callouts-emission': 'emission', 'src-callouts-noise': 'noise',
                           'src-callouts-other': 'other', 'src-callouts': null };
    if (l.type === 'sources') {
      if (typeof clearAllSources === 'function') clearAllSources();
      return;
    }
    if (SRC_TYPE[l.type] !== undefined) {
      if (typeof clearSourcesOfType === 'function') clearSourcesOfType(SRC_TYPE[l.type]);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(CALLOUT_TYPE, l.type)) {
      if (typeof hideSourceCalloutsOfType === 'function') hideSourceCalloutsOfType(CALLOUT_TYPE[l.type]);
      return;
    }
    // Строка отдельной РТ — удаляем именно эту точку, а не все
    if (l.mpId) {
      if (typeof mpDeletePoint === 'function') mpDeletePoint(l.mpId);
      return;
    }
    if (l.type === 'monpoints') {
      if (typeof mpDeleteAll === 'function') mpDeleteAll();
      return;
    }
    if (l.type === 'mp-callouts') {
      if (typeof mpHideAllCallouts === 'function') mpHideAllCallouts();
      return;
    }
  }
  mapLayers.filter(x => x.parentId === id).forEach(c => { c.parentId = null; });
  _removeLayer(id);
  renderLayers(); updateButtons();
  setSt('Слой удалён', 'ok');
}
function _removeLayer(id) {
  if (_editLayerId    === id) _editCleanup();
  if (_polyMoveLayerId === id) _polyMoveCleanup();
  const idx = mapLayers.findIndex(x => x.id === id);
  if (idx > -1) {
    const l = mapLayers[idx];
    _clearLayerCallout(l);
    if (map.hasLayer(l.layer)) map.removeLayer(l.layer);
    mapLayers.splice(idx, 1);
    if (activeLayerId === id) activeLayerId = mapLayers.length ? mapLayers[0].id : null;
  }
}
function clearAll() {
  mapLayers.forEach(l => { _clearLayerCallout(l); if (map.hasLayer(l.layer)) map.removeLayer(l.layer); });
  mapLayers = []; activeLayerId = null;
  clearMarkers(); finishPolyDraw(); polyPts = [];
  foundParcels = [];
  renderLayers(); updateButtons();
  document.getElementById('res-cnt').textContent = '0';
  if (typeof window._resReset === 'function') window._resReset();
  document.getElementById('res-list').innerHTML = '<div class="empty">Здесь появятся<br>кадастровые номера ЗУ</div>';
  setProgress(null);
  setSt('Всё очищено', 'ok');
}
function markLayerExcluded(layerId) {
  clearExcludedMark();
  const l = mapLayers.find(x => x.id === layerId);
  if (!l || !l.layer || !l.layer.setStyle) return;
  _excludedLayerId = layerId;
  _excludedLayerOrigStyle = { ...(l._psStyle || {}) };
  l.layer.setStyle({ color: '#6b7280', fillColor: '#374151', fillOpacity: 0.55, weight: 2, dashArray: '5,4', opacity: 0.7 });
  l.layer.unbindTooltip();
  l.layer.bindTooltip('Исходный ЗУ — исключён из поиска', { permanent: false, className: 'parcel-tip' });
}

function clearExcludedMark() {
  if (_excludedLayerId === null) return;
  const l = mapLayers.find(x => x.id === _excludedLayerId);
  if (l && l.layer) {
    if (l.layer.setStyle && _excludedLayerOrigStyle) l.layer.setStyle(_excludedLayerOrigStyle);
    l.layer.unbindTooltip();
  }
  _excludedLayerId = null;
  _excludedLayerOrigStyle = null;
}

// Исходный ЗУ вырезается из СЗЗ и исключается из результатов поиска.
// Кнопку убрали — поведение включено всегда, состояние живёт в проекте.
let _exclParcelActive = true;
window.isExclParcelActive = () => _exclParcelActive !== false;
window.setExclParcelActive = (v) => { _exclParcelActive = v !== false; applyExclState(); };

function toggleExclParcel() {
  _exclParcelActive = !_exclParcelActive;
  applyExclState();
}

function applyExclState() {
  const active = _exclParcelActive;

  if (_donutPreviewLayer) { map.removeLayer(_donutPreviewLayer); _donutPreviewLayer = null; }

  if (!active) {
    clearExcludedMark();
    return;
  }

  const al = getActiveLayer();
  if (!al || !al.poly || !al.parentId) return; // кнопка активна, но нет слоя с полигоном и родителем

  const parentLayer = mapLayers.find(l => l.id === al.parentId);
  if (!parentLayer) return;

  if (_excludedLayerId !== parentLayer.id) {
    clearExcludedMark();
    markLayerExcluded(parentLayer.id);
  }

  try {
    const szzRing = al.poly.map(p => [p[1], p[0]]);
    if (szzRing[0][0] !== szzRing[szzRing.length-1][0]) szzRing.push([...szzRing[0]]);
    const szzTurf = turf.polygon([szzRing]);

    const exRing = parentLayer.poly.map(p => [p[1], p[0]]);
    if (exRing[0][0] !== exRing[exRing.length-1][0]) exRing.push([...exRing[0]]);
    const exTurf = turf.polygon([exRing]);

    const donut = turf.difference(szzTurf, exTurf);
    if (donut) {
      _donutPreviewLayer = L.geoJSON(donut, {
        style: { color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.18, weight: 1.5, dashArray: '5,3' }
      }).addTo(map);
    }
  } catch(e) {}
}

function clearMarkers() {
  closeParcelInfo();
  selectedParcelCns.clear();
  _updateMultiSelBadge();
  const _exclActive = document.getElementById('rb-btn-excl')?.classList.contains('active');
  if (!_exclActive) clearExcludedMark();
  if (_donutPreviewLayer) { map.removeLayer(_donutPreviewLayer); _donutPreviewLayer = null; }
  parcelMkrs.forEach(p => { if (map.hasLayer(p.layer)) map.removeLayer(p.layer); });
  parcelMkrs = [];
}
function updateButtons() {
  const al = getActiveLayer();
  const hasPoly = !!(al && al.poly && al.poly.length);
  const gen = document.getElementById('btn-gen-szz');
  const ready = !!(al && al.type === 'parcel');
  gen.disabled = !ready;
  // Серая кнопка без объяснения — тупик: непонятно, чего не хватает.
  // Причина пишется и в подсказку, и рядом с кнопкой.
  gen.title = ready
    ? `Построить СЗЗ вокруг слоя «${al.name}»`
    : (al ? `Активен слой «${al.name}» — это не земельный участок. Выберите слой типа ЗУ`
          : 'Сначала постройте или выберите земельный участок');
  const hint = document.getElementById('szz-need-hint');
  if (hint) {
    hint.style.display = ready ? 'none' : '';
    hint.textContent = al ? 'активный слой — не ЗУ' : 'нужен слой ЗУ';
  }
  const rbFind = document.getElementById('rb-btn-find');
  if (rbFind) rbFind.disabled = !hasPoly;
}
function fitActive() {
  const al = getActiveLayer();
  if (al && al.layer && al.layer.getBounds) map.fitBounds(al.layer.getBounds(), { padding: [40,40] });
}

function toggleBasemapMenu(e) {
  if (e) { e.stopPropagation(); }
  const menu = document.getElementById('basemap-menu');
  const open = menu.classList.toggle('open');
  if (open) {
    setTimeout(() => document.addEventListener('click', _closeBasemapMenu, { once: true }), 0);
  }
}
function _closeBasemapMenu() {
  const menu = document.getElementById('basemap-menu');
  if (menu) menu.classList.remove('open');
}
function setBasemap(name) {
  // В сохранённых проектах может стоять убранная подложка — возвращаем схему,
  // иначе обращение к несуществующему слою уронило бы карту.
  if (!BASEMAPS[name]) name = 'osm';
  if (BASEMAPS[currentBasemap]) map.removeLayer(BASEMAPS[currentBasemap]);
  currentBasemap = name;
  useSat = (name === 'sat'); // compat
  BASEMAPS[name].addTo(map);
  // обновить иконку кнопки
  const icons = { osm: 'ico-map-scheme', sat: 'ico-sat' };
  const btn = document.getElementById('basemap-btn');
  if (btn) btn.innerHTML = `<svg class="icon"><use href="#${icons[name] || 'ico-layers'}"/></svg>`;
  // пометить активный пункт меню
  document.querySelectorAll('.bm-opt').forEach(el => el.classList.toggle('active', el.dataset.bm === name));
  _closeBasemapMenu();
}

// legacy alias (pdf-editor вызывает toggleSat)
function toggleSat() { setBasemap(currentBasemap === 'sat' ? 'osm' : 'sat'); }

// ── Единое управление оверлейными слоями ──────────────────────────────────
function toggleOverlay(key) {
  const cfg = OV[key]; if (!cfg) return;
  cfg.on = !cfg.on;
  if (key === 'zouit') {
    zouitLayers.forEach(l => cfg.on ? l.addTo(map) : map.removeLayer(l));
  } else if (cfg.layer) {
    cfg.on ? cfg.layer.addTo(map) : map.removeLayer(cfg.layer);
  }
  _updateNspdClick();
  _renderLayersPanel();
}

// Compat-алиасы (старый HTML мог вызывать эти функции)
function toggleCad()      { toggleOverlay('cad'); }
function toggleZouit()    { toggleOverlay('zouit'); }
function toggleOks()      { toggleOverlay('oks'); }
function togglePzz()      { toggleOverlay('pzz'); }
function toggleRedlines() { toggleOverlay('redlines'); }
function toggleNp()       { toggleOverlay('np'); }
function toggleKvartal()  { toggleOverlay('kvartal'); }

function _updateNspdClick() { /* обработчик встроен в основной map.on('click') */ }

// ── Панель выбора слоёв ───────────────────────────────────────────────────
function toggleLayersPanel(e) {
  if (e) e.stopPropagation();
  const p = document.getElementById('layers-panel');
  const open = p.classList.toggle('open');
  if (open) {
    _renderLayersPanel();
    setTimeout(() => document.addEventListener('click', _closeLayersPanelOutside, { once: true }), 0);
  }
}
function _closeLayersPanelOutside(e) {
  const p = document.getElementById('layers-panel');
  if (p && !p.contains(e.target)) p.classList.remove('open');
}
function closeLayersPanel() {
  document.getElementById('layers-panel')?.classList.remove('open');
}

function _renderLayersPanel() {
  const panel = document.getElementById('layers-panel');
  if (!panel || !panel.classList.contains('open')) return;

  const groups = [
    { key: 'cadastre',  title: 'Кадастр НСПД' },
    { key: 'zones',     title: 'Зоны' },
    { key: 'territory', title: 'Территории' },
  ];

  let html = `<div class="lp-header"><span>Слои карты</span>
    <button class="lp-close" onclick="closeLayersPanel()">✕</button></div>`;

  for (const g of groups) {
    const items = Object.entries(OV).filter(([, c]) => c.group === g.key);
    if (!items.length) continue;
    html += `<div class="lp-group-title">${g.title}</div>`;
    for (const [key, cfg] of items) {
      html += `<div class="lp-item${cfg.on ? ' active' : ''}" onclick="toggleOverlay('${key}')">
        <span class="lp-dot"></span>
        <span class="lp-label">${cfg.label}</span>
      </div>`;
    }
  }
  panel.innerHTML = html;
}

let _clickSeq = 0; // токен: быстрые повторные клики отменяют показ устаревших ответов

async function _nspdMapClick(e) {
  if (document.getElementById('pdf-editor').style.display !== 'none') return;
  if (tool) return;
  const t = e.originalEvent && e.originalEvent.target;
  if (t && t.closest && (t.closest('.leaflet-marker-icon') || t.closest('.leaflet-marker-shadow'))) return;
  const { lat, lng } = e.latlng;
  const clickable = Object.entries(OV).filter(([, c]) => c.on && c.clickable && (c.lid || (c.lids && c.lids.length)));
  if (!clickable.length) return;

  // Все активные слои опрашиваются одним запросом (прокси ходит в НСПД параллельно).
  // ЗОУИТ — это 5 отдельных НСПД-слоёв (своего общего lid у него нет), поэтому
  // для него подставляются все 5 id сразу (см. OV.zouit.lids).
  const lids = clickable.flatMap(([, c]) => c.lids || [c.lid]).join(',');
  const seq  = ++_clickSeq;
  const mapEl = document.getElementById('map');
  mapEl.style.cursor = 'progress';
  setSt('Запрашиваю объект в НСПД…', 'spin');
  try {
    const r = await fetchSafe(`${_NSPD_PROXY}/nspd-click?lids=${lids}&lat=${lat}&lon=${lng}`, 15000);
    const data = await r.json();
    if (seq !== _clickSeq) return; // пришёл ответ на старый клик — игнорируем
    if (data.found) {
      _showNspdPanel(data, e.latlng);
      setSt('', '');
    } else {
      setSt('В этой точке объектов не найдено', '');
    }
  } catch(err) {
    console.error('nspd-click', err);
    if (seq === _clickSeq) setSt('НСПД не ответил — попробуйте ещё раз', 'err');
  } finally {
    if (seq === _clickSeq) mapEl.style.cursor = '';
  }
}

let _nspdHighlight = null;
let _lastNspdData  = null;

const LAYER_LABELS = {
  '36048':  'Земельный участок',
  '36049':  'Здание (ОКС)',
  '875831': 'Населённый пункт',
  '875838': 'Территориальная зона',
  '879243': 'Красная линия',
  '36071':  'Кадастровый квартал',
  '37577':  'ЗОУИТ', '37578': 'ЗОУИТ', '37579': 'ЗОУИТ', '37580': 'ЗОУИТ', '37581': 'ЗОУИТ',
};

const ATTR_LABELS = {
  address:'Адрес', area_value:'Площадь', statecd:'Статус', date_create:'Дата постановки',
  category_type:'Категория земель', util_by_doc:'ВРИ', ownership_form:'Форма собственности',
  cad_cost:'Кадастровая стоимость', kpzu:'Удельный показатель', kvartal:'Кадастровый квартал',
  name:'Наименование', zone_name:'Название зоны', zone_type:'Тип зоны', full_name:'Полное название',
  floors:'Этажность', building_type:'Тип здания', year_built:'Год постройки',
  zone_code:'Код зоны', zone_descr:'Вид зоны', category_name:'Тип объекта',
  reg_numb_border:'Номер документа', label:'Обозначение', descr:'Описание',
};

function _showNspdPanel(data, latlng) {
  const panel = document.getElementById('parcel-info-panel');
  if (!panel) return;
  _lastNspdData = data;

  const lid    = data.lid || '36048';
  const a      = data.attrs || {};
  const cn     = data.cn || a.cn || '';
  const title  = LAYER_LABELS[lid] || 'Объект';
  const name   = escapeHtml(data.name || cn || '—');
  const hasGeom = data.geometry && data.geometry.type && data.geometry.type !== 'Point';
  const ovKey   = Object.keys(OV).find(k => OV[k].lid === lid || (OV[k].lids && OV[k].lids.includes(lid)));
  const canAdd  = OV[ovKey]?.canAdd && hasGeom;

  // label/val приходят из внешнего НСПД-ответа — экранируем перед innerHTML
  const row = (label, val, cls='') => val
    ? `<div class="pi-row"><div class="pi-key">${escapeHtml(label)}</div><div class="pi-val${cls?' '+cls:''}">${escapeHtml(val)}</div></div>` : '';

  // Для ЗУ — структурированный вывод
  let bodyHtml = '';
  if (lid === '36048') {
    const area = a.area_value ? parseFloat(a.area_value).toLocaleString('ru') + ' м²' : '';
    const status = a.statecd==='2'?'Учтённый':a.statecd==='1'?'Временный':a.statecd==='3'?'Ранее учтённый':'';
    bodyHtml = `
      <div class="pi-section">Расположение</div>
      ${row('Кадастровый квартал', a.kvartal, 'mono')}
      ${row('Адрес', a.address || 'не указан')}
      <div class="pi-section">Характеристики</div>
      ${row('Площадь', area)}${row('Статус', status)}
      ${row('Дата постановки', a.date_create)}${row('Категория', a.category_type)}
      ${row('ВРИ', a.util_by_doc)}${row('Собственность', a.ownership_form)}
      ${a.cad_cost ? '<div class="pi-section">Кадастровая оценка</div>' : ''}
      ${row('Стоимость', a.cad_cost, 'cost')}${row('Удельный', a.kpzu)}`;
  } else {
    // Generic: показываем все доступные атрибуты с переводом ключей
    for (const [k, v] of Object.entries(a)) {
      if (!v || v === true) continue;
      const label = ATTR_LABELS[k] || k;
      bodyHtml += row(label, String(v));
    }
    if (!bodyHtml) bodyHtml = '<div class="pi-row" style="color:var(--tx2);font-size:var(--fs-1)">Атрибуты не получены</div>';
  }

  const nspd = cn
    ? `https://nspd.gov.ru/map?thematic=PKK&zoom=17&cn=${encodeURIComponent(cn)}`
    : 'https://nspd.gov.ru/map?thematic=PKK';

  panel.innerHTML = `
    <div class="pi-header">
      <div class="pi-title-block">
        <div class="pi-type">${title}</div>
        <div class="pi-cn">${name}</div>
      </div>
      <button class="pi-close" onclick="closeNspdPanel()" title="Закрыть">✕</button>
    </div>
    <div class="pi-body">${bodyHtml}</div>
    <div class="pi-footer" style="display:flex;flex-direction:column;gap:6px">
      ${canAdd ? `<button class="pi-add-layer-btn" onclick="nspdFeatureToLayer()">+ Добавить в слои</button>` : ''}
      <a class="pi-link" href="${nspd}" target="_blank" rel="noopener">Открыть на карте НСПД ↗</a>
    </div>`;
  panel.style.display = 'flex';

  if (_nspdHighlight) { map.removeLayer(_nspdHighlight); _nspdHighlight = null; }
  if (hasGeom) {
    _nspdHighlight = L.geoJSON(data.geometry, {
      style: { color: '#f97316', weight: 2, fillColor: '#f97316', fillOpacity: 0.12 }
    }).addTo(map);
  }
}

// lid НСПД-слоя -> тип слоя в mapLayers (цвет берётся из палитры addMapLayer по типу)
const _LID_TO_TYPE = {
  '36071':  'kvartal',
  '36049':  'oks',
  '875838': 'pzz',
  '37577':  'zouit', '37578': 'zouit', '37579': 'zouit', '37580': 'zouit', '37581': 'zouit',
};

function nspdFeatureToLayer() {
  const data = _lastNspdData;
  if (!data?.geometry) return;
  const a    = data.attrs || {};
  const cn   = data.cn || a.cn || '';
  const lid  = data.lid || '36048';
  const geom = data.geometry;

  let rings = [];
  if (geom.type === 'Polygon')      rings = [geom.coordinates[0]];
  else if (geom.type === 'MultiPolygon') rings = geom.coordinates.map(p => p[0]);
  if (!rings.length) return;

  const toLL       = ring => ring.map(([lng, lat]) => [lat, lng]);
  const latlngRings = rings.map(toLL);
  const largest    = latlngRings.reduce((a, b) => a.length >= b.length ? a : b);
  const name       = data.name || cn || 'Объект';
  const tip        = name + (a.address ? '\n' + a.address : '');
  const type       = _LID_TO_TYPE[lid] || 'parcel'; // ЗУ и НП как и раньше — 'parcel'
  // Та же палитра, что и в addMapLayer() — чтобы цвет полигона на карте совпал
  // с тем, что addMapLayer запишет в _psStyle (сам addMapLayer стиль не применяет).
  const TYPE_COLORS = { parcel: '#f59e0b', kvartal: '#22d3ee', oks: '#f472b6', pzz: '#a3e635', zouit: '#fb923c' };
  const color      = TYPE_COLORS[type] || '#f59e0b';
  const style      = { color, fillColor: color, fillOpacity: 0.15, weight: 2 };

  const storedData = JSON.parse(JSON.stringify(data)); // снимок — не зависит от будущих кликов

  const leafletLayer = L.polygon(latlngRings, { ...style, fillRule: 'evenodd', bubblingMouseEvents: false })
    .bindTooltip(tip, { sticky: true, className: 'parcel-tip' })
    .addTo(map);

  leafletLayer.on('click', function(e) {
    _showNspdPanel(storedData, e.latlng);
  });

  addMapLayer(type, name, largest, leafletLayer);

  if (_nspdHighlight) { map.removeLayer(_nspdHighlight); _nspdHighlight = null; }
  closeNspdPanel();
}

function closeNspdPanel() {
  const panel = document.getElementById('parcel-info-panel');
  if (panel) panel.style.display = 'none';
  if (_nspdHighlight) { map.removeLayer(_nspdHighlight); _nspdHighlight = null; }
  _lastNspdData = null;
}

// compat alias
function closeCadPanel() { closeNspdPanel(); }
function cadParcelToLayer() { nspdFeatureToLayer(); }

function initZoomRect() {
  const overlay = document.getElementById('zoom-rect-overlay');
  const wrapper = document.getElementById('map-wrapper');

  wrapper.addEventListener('mousedown', e => {
    if (!zoomRectActive) return;
    if (e.target.closest('.leaflet-control')) return;
    e.preventDefault();
    const rect = wrapper.getBoundingClientRect();
    zoomRectStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    zoomRectDrawing = true;
    Object.assign(overlay.style, { display: 'block', left: zoomRectStart.x+'px', top: zoomRectStart.y+'px', width: '0', height: '0' });
  });

  document.addEventListener('mousemove', e => {
    if (!zoomRectDrawing) return;
    const rect = wrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const x = Math.min(cx, zoomRectStart.x), y = Math.min(cy, zoomRectStart.y);
    overlay.style.left = x+'px'; overlay.style.top = y+'px';
    overlay.style.width = Math.abs(cx-zoomRectStart.x)+'px';
    overlay.style.height = Math.abs(cy-zoomRectStart.y)+'px';
  });

  document.addEventListener('mouseup', e => {
    if (!zoomRectDrawing) return;
    zoomRectDrawing = false;
    overlay.style.display = 'none';
    const rect = wrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const x1 = Math.min(cx, zoomRectStart.x), y1 = Math.min(cy, zoomRectStart.y);
    const x2 = Math.max(cx, zoomRectStart.x), y2 = Math.max(cy, zoomRectStart.y);
    if (Math.abs(x2-x1) > 10 && Math.abs(y2-y1) > 10) {
      const sw = map.containerPointToLatLng(L.point(x1, y2));
      const ne = map.containerPointToLatLng(L.point(x2, y1));
      map.fitBounds([[sw.lat, sw.lng],[ne.lat, ne.lng]]);
    }
    toggleZoomRect();
  });
}

function toggleZoomRect() {
  zoomRectActive = !zoomRectActive;
  const btn = document.getElementById('zoom-rect-btn');
  btn.classList.toggle('active', zoomRectActive);
  document.getElementById('map').style.cursor = zoomRectActive ? 'crosshair' : '';
}

function highlightParcel(cn) { selectParcel(cn); }

function selectParcel(cn) {
  // Сбросить мультивыделение при обычном (не Shift) клике
  if (selectedParcelCns.size > 0) clearMultiSelection();
  // Снять выделение с предыдущего
  if (selectedParcelCn && selectedParcelCn !== cn) {
    const prev = parcelMkrs.find(x => x.cn === selectedParcelCn);
    if (prev && prev.layer && prev.layer.setStyle) prev.layer.setStyle(prev.origStyle);
    const prevCard = document.getElementById('card-' + selectedParcelCn.replace(/\W/g,'_'));
    if (prevCard) prevCard.classList.remove('selected');
  }

  selectedParcelCn = cn;
  const pm = parcelMkrs.find(x => x.cn === cn);
  if (pm && pm.layer) {
    const bounds = pm.layer.getBounds ? pm.layer.getBounds() : pm.layer.getLatLng().toBounds(100);
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
    if (pm.layer.setStyle) {
      pm.layer.setStyle({ ...pm.origStyle, color: '#3b82f6', weight: 3.5, fillOpacity: 0.45 });
    }
  }

  // Выделить карточку в списке (список рисуется порциями — дорисуем до неё)
  if (typeof window._ensureParcelCard === 'function') window._ensureParcelCard(cn);
  const card = document.getElementById('card-' + cn.replace(/\W/g,'_'));
  if (card) {
    card.classList.add('selected');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Показать панель информации
  const p = foundParcels.find(x => x.cn === cn);
  if (p) showParcelInfo(p);
}

function closeParcelInfo() {
  const panel = document.getElementById('parcel-info-panel');
  if (panel) panel.style.display = 'none';
  if (selectedParcelCn) {
    const pm = parcelMkrs.find(x => x.cn === selectedParcelCn);
    if (pm && pm.layer && pm.layer.setStyle) pm.layer.setStyle(pm.origStyle);
    const card = document.getElementById('card-' + selectedParcelCn.replace(/\W/g,'_'));
    if (card) card.classList.remove('selected');
    selectedParcelCn = null;
  }
}

function showParcelInfo(p) {
  const panel = document.getElementById('parcel-info-panel');
  if (!panel) return;

  const badge = p.inP
    ? '<span class="pi-badge inside">✓ Внутри СЗЗ</span>'
    : '<span class="pi-badge cross">⚠ Пересечение с СЗЗ</span>';

  // key/val приходят из внешнего НСПД-ответа — экранируем перед innerHTML
  const row = (key, val, cls = '') => val
    ? `<div class="pi-row"><div class="pi-key">${escapeHtml(key)}</div><div class="pi-val${cls ? ' ' + cls : ''}">${escapeHtml(val)}</div></div>`
    : '';

  const sec = (title) => `<div class="pi-section">${title}</div>`;

  panel.innerHTML = `
    <div class="pi-header">
      <div class="pi-title-block">
        <div class="pi-type">Земельный участок</div>
        <div class="pi-cn">${escapeHtml(p.cn)}</div>
        ${badge}
      </div>
      <button class="pi-close" onclick="closeParcelInfo()" title="Закрыть">✕</button>
    </div>
    <div class="pi-body">
      ${sec('Расположение')}
      ${row('Кадастровый квартал', p.kvartal, 'mono')}
      ${row('Адрес', p.addr || 'не указан')}
      ${row('Координаты центра', p.lat ? `${p.lat.toFixed(6)}°, ${p.lon.toFixed(6)}°` : '')}
      ${sec('Характеристики')}
      ${row('Площадь', p.area)}
      ${row('Дата постановки на учёт', p.date_cn)}
      ${row('Статус', p.status)}
      ${row('Категория земель', p.cat)}
      ${row('Вид разрешённого использования', p.util)}
      ${row('Форма собственности', p.ownership)}
      ${row('Функциональная зона', p.zone)}
      ${p.cad_cost || p.cad_unit ? sec('Кадастровая оценка') : ''}
      ${row('Кадастровая стоимость', p.cad_cost, 'cost')}
      ${row('Удельный показатель', p.cad_unit)}
    </div>
    <div class="pi-footer">
      <a class="pi-link" href="https://nspd.gov.ru/map?thematic=PKK" target="_blank" rel="noopener">
        Открыть на карте НСПД ↗
      </a>
    </div>`;

  panel.style.display = 'flex';
}

// Найденные ЗУ — тысячи контуров. В SVG каждый был отдельным элементом, и
// сдвиг/зум карты пересчитывал их все. Рисуем их на одном холсте (canvas) в
// своей панели между подложкой (200) и слоями проекта (overlayPane, 400):
// так они всегда под ЗУ/СЗЗ пользователя без ручного bringToBack.
let _parcelRenderer = null;
function _parcelCanvas() {
  if (_parcelRenderer) return _parcelRenderer;
  if (!map.getPane('parcels')) map.createPane('parcels').style.zIndex = 390;
  _parcelRenderer = L.canvas({ pane: 'parcels', padding: 0.5, tolerance: 2 });
  return _parcelRenderer;
}

function addParcelLayer(p) {
  const tip = p.cn + (p.addr ? '\n' + p.addr : '');
  const onCanvas = { renderer: _parcelCanvas(), pane: 'parcels' };
  if (p.geometry && p.geometry.type && p.geometry.type !== 'Point') {
    try {
      const style = p.inP
        ? { color: '#16a34a', fillColor: '#22c55e', fillOpacity: 0.25, weight: 2 }
        : { color: '#b45309', fillColor: '#f59e0b', fillOpacity: 0.2, weight: 2 };
      // L.geoJSON корректно рисует Polygon и MultiPolygon (все подполигоны)
      const layer = L.geoJSON(p.geometry, { style: () => style, ...onCanvas })
        .bindTooltip(tip, { sticky: true, className: 'parcel-tip' })
        .on('click', e => { L.DomEvent.stopPropagation(e); if (e.originalEvent.shiftKey) toggleParcelMultiSelect(p.cn); else selectParcel(p.cn); })
        .on('contextmenu', e => { L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e); _parcelMapContextMenu(e.originalEvent, p); })
        .addTo(map);
      parcelMkrs.push({ cn: p.cn, layer, origStyle: { ...style } });
      return;
    } catch(e) {}
  }
  const color = p.inP ? '#22c55e' : '#f59e0b';
  const origStyle = { color, fillColor: color, fillOpacity: 0.5, weight: 2 };
  const layer = L.circleMarker([p.lat, p.lon], { radius: 6, ...origStyle, ...onCanvas })
    .bindTooltip(tip, { sticky: true })
    .on('click', e => { L.DomEvent.stopPropagation(e); if (e.originalEvent.shiftKey) toggleParcelMultiSelect(p.cn); else selectParcel(p.cn); })
    .on('contextmenu', e => { L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e); _parcelMapContextMenu(e.originalEvent, p); })
    .addTo(map);
  parcelMkrs.push({ cn: p.cn, layer, origStyle });
}

function toggleFills() {
  const hideSzz = document.getElementById('pdf-no-fill-szz')?.checked ?? false;
  const hideZu  = document.getElementById('pdf-no-fill-zu')?.checked  ?? false;
  mapLayers.forEach(l => {
    if (l.layer && l.layer.setStyle) {
      const s = l._psStyle || {};
      const def = l.type === 'szz' ? 0.1 : 0.15;
      const fo  = l.type === 'szz' ? (hideSzz ? 0 : (s.fillOpacity ?? def)) : (hideZu ? 0 : (s.fillOpacity ?? def));
      l.layer.setStyle({ fillOpacity: fo });
    }
  });
  if (typeof _refreshPdfMapLayers === 'function') {
    mapLayers.forEach(l => {
      const s = l._psStyle || {};
      const def = l.type === 'szz' ? 0.1 : 0.15;
      const fo  = l.type === 'szz' ? (hideSzz ? 0 : (s.fillOpacity ?? def)) : (hideZu ? 0 : (s.fillOpacity ?? def));
      l._tempFillOpacity = fo;
    });
    if (typeof _refreshPdfMapLayersWithOpacity === 'function') _refreshPdfMapLayersWithOpacity();
    mapLayers.forEach(l => { delete l._tempFillOpacity; });
  }
}

// Заглушка для PDF overlay (переопределяется в pdf-editor.js)
function updatePdfOverlays() {}

// ═══════════════════════════════════════════════
// POLYGON OPERATIONS — копирование ЗУ и булевы операции
// ═══════════════════════════════════════════════

// Конвертировать слой в turf Feature
function _layerToTurf(l) {
  if (l.geojson) {
    return l.geojson.type === 'Feature'
      ? l.geojson
      : { type: 'Feature', properties: {}, geometry: l.geojson };
  }
  const ring = l.poly.map(p => [p[1], p[0]]);
  if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
    ring.push([...ring[0]]);
  }
  return turf.polygon([ring]);
}

// ── Мультивыделение участков (Shift+клик) ──────────────────────────────────

function toggleParcelMultiSelect(cn) {
  const pm = parcelMkrs.find(x => x.cn === cn);
  if (!pm) return;
  if (selectedParcelCns.has(cn)) {
    selectedParcelCns.delete(cn);
    if (pm.layer.setStyle) pm.layer.setStyle(pm.origStyle);
    document.getElementById('card-' + cn.replace(/\W/g,'_'))?.classList.remove('multi-selected');
  } else {
    selectedParcelCns.add(cn);
    if (pm.layer.setStyle) pm.layer.setStyle(_MULTI_STYLE);
    document.getElementById('card-' + cn.replace(/\W/g,'_'))?.classList.add('multi-selected');
  }
  _updateMultiSelBadge();
}

function clearMultiSelection() {
  selectedParcelCns.forEach(cn => {
    const pm = parcelMkrs.find(x => x.cn === cn);
    if (pm && pm.layer && pm.layer.setStyle) pm.layer.setStyle(pm.origStyle);
    document.getElementById('card-' + cn.replace(/\W/g,'_'))?.classList.remove('multi-selected');
  });
  selectedParcelCns.clear();
  _updateMultiSelBadge();
}

function _updateMultiSelBadge() {
  const bar = document.getElementById('multi-sel-bar');
  if (!bar) return;
  const n = selectedParcelCns.size;
  bar.style.display = n > 0 ? 'flex' : 'none';
  const cnt = bar.querySelector('.multi-sel-cnt');
  if (cnt) cnt.textContent = `${n} уч. выбрано (Shift+клик для добавления)`;
}

function _createCombinedParcelLayer() {
  const cns = [...selectedParcelCns];
  const withGeom = cns
    .map(cn => foundParcels.find(p => p.cn === cn))
    .filter(p => p && p.geometry && p.geometry.type !== 'Point');
  if (withGeom.length < 2) { setSt('Нужно минимум 2 участка с полигонами', 'err'); return; }
  try {
    let combined = { type: 'Feature', properties: {}, geometry: withGeom[0].geometry };
    for (let i = 1; i < withGeom.length; i++) {
      const next = turf.union(combined, { type: 'Feature', properties: {}, geometry: withGeom[i].geometry });
      if (!next) throw new Error('turf.union вернул null');
      combined = next;
    }
    const geom = combined.geometry;
    const outerCoords = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
    const poly = outerCoords.map(c => [c[1], c[0]]);
    const color = '#7c3aed';
    const leafLayer = L.geoJSON(geom, { style: () => ({ color, weight: 2, fillColor: color, fillOpacity: 0.1 }) }).addTo(map);
    const newL = addMapLayer('szz', `Объединение ${cns.length} ЗУ`, poly, leafLayer);
    newL.geojson = geom;
    map.fitBounds(leafLayer.getBounds(), { padding: [40, 40] });
    clearMultiSelection();
    setSt(`Слой «${newL.name}» создан`, 'ok');
  } catch(e) {
    setSt('Ошибка объединения: ' + e.message, 'err');
    console.error('_createCombinedParcelLayer:', e);
  }
}

// Контекстное меню для найденного ЗУ на карте (ПКМ)
function _parcelMapContextMenu(e, p) {
  document.getElementById('src-ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu';
  menu.className = 'src-ctx-menu';

  const btn = document.createElement('button');
  btn.textContent = '⊕ Добавить полигон в слои';
  btn.onclick = () => { copyParcelToLayer(p.cn); menu.remove(); };
  menu.appendChild(btn);

  // Если мультивыделено ≥2 участков — предлагаем объединить
  if (selectedParcelCns.size >= 2) {
    const sep = document.createElement('div');
    sep.className = 'src-ctx-sep';
    menu.appendChild(sep);
    const btnCombine = document.createElement('button');
    btnCombine.textContent = `⊞ Объединить ${selectedParcelCns.size} выбранных в полигон`;
    btnCombine.onclick = () => { _createCombinedParcelLayer(); menu.remove(); };
    menu.appendChild(btnCombine);
  }

  placeCtxMenu(menu, e);   // подрезка и раскрытие вверх — в utils.js
  const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// Копировать найденный ЗУ в список слоёв
window.copyParcelToLayer = (cn) => {
  const p = foundParcels.find(x => x.cn === cn);
  if (!p || !p.geometry) { setSt('Нет геометрии для копирования', 'err'); return; }
  const geom = p.geometry;
  let outerRing;
  if (geom.type === 'Polygon') {
    outerRing = geom.coordinates[0];
  } else if (geom.type === 'MultiPolygon') {
    outerRing = geom.coordinates.reduce((best, rings) =>
      rings[0].length > best.length ? rings[0] : best, geom.coordinates[0][0]);
  } else { setSt('Неподдерживаемый тип геометрии', 'err'); return; }
  const poly = outerRing.map(c => [c[1], c[0]]);
  const cfg = getStyleCfg();
  const style = { color: '#f59e0b', weight: cfg.parcelW, fillColor: '#f59e0b', fillOpacity: 0.15 };
  const leafLayer = L.geoJSON(geom, { style: () => style }).addTo(map);
  const newL = addMapLayer('parcel', `ЗУ ${cn}`, poly, leafLayer);
  newL.geojson = geom;
  map.fitBounds(leafLayer.getBounds(), { padding: [40, 40] });
  setSt(`Полигон ЗУ ${cn} добавлен в слои`, 'ok');
};

// Контекстное меню слоя в списке (ПКМ)
// Меню группы: свернуть, переименовать, разгруппировать, скрыть/показать
window.layerGroupContextMenu = (e, gid) => {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('src-ctx-menu')?.remove();
  const g = _layerGroups[gid];
  if (!g) return;
  const members = mapLayers.filter(l => l.groupId === gid);
  const anyVis = members.some(l => l.visible !== false);
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
  const close = "document.getElementById('src-ctx-menu')?.remove()";
  const cs = _groupCalloutState(gid);
  const _gLocked = !!g.locked;
  const _gNested = !!g.parent;
  const _gColor  = g.color || '#64748b';
  menu.innerHTML = `
    <button onclick="toggleGroupVis(event,'${gid}');${close}">${anyVis ? 'Скрыть' : 'Показать'} группу (${members.length})</button>
    <button onclick="isolateGroup('${gid}');${close}">Показать только эту группу</button>
    <button onclick="selectGroupLayers('${gid}');${close}">Выделить слои группы</button>
    <button onclick="startGroupRename('${gid}');${close}">Переименовать группу</button>
    <button onclick="toggleGroupLock('${gid}');${close}">${_gLocked ? 'Разблокировать группу' : 'Заблокировать группу'}</button>
    <label class="src-ctx-color" onclick="event.stopPropagation()">Цвет метки
      <input type="color" value="${_gColor}" oninput="setGroupColor('${gid}', this.value)">
      <button class="src-ctx-mini" onclick="setGroupColor('${gid}', null);${close}">сброс</button>
    </label>` +
    (_gNested ? `<button onclick="unnestGroup('${gid}');${close}">Вынести на верхний уровень</button>` : '') +
    (cs.total ? `<div class="src-ctx-sep"></div>
    <button onclick="setGroupCallouts('${gid}', true);${close}">
      <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
      Выноски всей группе (${cs.total})</button>
    <button onclick="openGroupCalloutStyle('${gid}');${close}">Один стиль выносок группе…</button>` +
    (cs.on ? `<button onclick="setGroupCallouts('${gid}', false);${close}">Снять выноски (${cs.on})</button>` : '') : '') + `
    <div class="src-ctx-sep"></div>
    <button onclick="newLayerGroup();${close}">Новая группа…</button>
    <button onclick="ungroupLayers('${gid}');${close}">Разгруппировать</button>` +
    (members.length ? `<button class="src-ctx-del" onclick="deleteLayers([${members.map(l => l.id).join(',')}]);${close}">✕ Удалить все слои группы (${members.length})</button>` : '');
  _placeCtxMenu(menu, e);
};

// Общее размещение контекстного меню у курсора
function _placeCtxMenu(menu, e) {
  document.body.appendChild(menu);
  placeCtxMenu(menu, e);   // подрезка и раскрытие вверх — в utils.js
  const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}


// Цвет сразу всем выделенным слоям: по одному перекрашивать десяток — мучение
window.pickLayersColor = function(ids) {
  const list = mapLayers.filter(l => ids.includes(l.id));
  if (!list.length) return;
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = (list[0]._psStyle && list[0]._psStyle.color) || list[0].color || '#f59e0b';
  inp.style.cssText = 'position:fixed;left:-100px;top:-100px';
  document.body.appendChild(inp);
  inp.addEventListener('change', () => {
    const col = inp.value;
    if (typeof mapUndoPush === 'function') mapUndoPush('цвет выделенных');
    // У РТ цвет живёт в самой точке: её кружок и номер рисуются по pt.color
    const mpIds = list.filter(l => l.mpId).map(l => l.mpId);
    if (mpIds.length && typeof window.mpSetColor === 'function') window.mpSetColor(mpIds, col);
    list.forEach(l => {
      l.color = col;
      l._psStyle = { ...(l._psStyle || {}), color: col, fillColor: col };
      try { if (l.layer && l.layer.setStyle) l.layer.setStyle(l._psStyle); } catch(e) {}
      if (typeof window._reapplyLayerStyle === 'function') window._reapplyLayerStyle(l);
      if (typeof window._pdfOnLayerStyleChanged === 'function') window._pdfOnLayerStyleChanged(l);
    });
    renderLayers();
    if (typeof _renderLayersList === 'function') _renderLayersList();
    if (typeof markDirty === 'function') markDirty();
    setSt(`Цвет изменён у слоёв: ${list.length}`, 'ok');
    inp.remove();
  });
  inp.click();
};

// Удалить всё выделение разом, с одним подтверждением
window.deleteLayers = function(ids) {
  const list = mapLayers.filter(l => ids.includes(l.id));
  if (!list.length) return;
  const _run = () => {
    if (typeof mapUndoPush === 'function') mapUndoPush('удаление слоёв');
    const fake = { stopPropagation() {} };
    list.forEach(l => { try { deleteLayer(fake, l.id); } catch(e) {} });
    renderLayers();
    if (typeof _renderLayersList === 'function') _renderLayersList();
    setSt(`Удалено слоёв: ${list.length}`, 'ok');
  };
  // Один слой удаляем без вопроса — его легко вернуть отменой
  if (list.length > 1) askConfirm('Удалить выделенные слои?', `Будет удалено: ${list.length}.`, _run);
  else _run();
};

// Блок команд «выделение / группа» для меню слоя (пусто, если не применимо)
function _groupMenuHtml(l, id) {
  const close = "document.getElementById('src-ctx-menu')?.remove()";
  const sel = _targetLayers(id);
  let html = '';
  if (sel.length > 1) {
    const anyVis = sel.some(x => (mapLayers.find(m => m.id === x) || {}).visible !== false);
    const selL    = window._calloutCarriersOfIds(sel);
    const anyCall = selL.some(c => c.on);
    const allLocked = mapLayers.filter(x => sel.includes(x.id)).every(x => x.locked);
    // «Объединить выделенные» — прямое объединение без выбора второго слоя
    // в диалоге, доступно когда среди выделения ≥2 полигонов ЗУ/СЗЗ.
    // «Объединить с...» (у отдельного слоя) остаётся для точечного выбора.
    const mergeableCnt = mapLayers.filter(x => sel.includes(x.id) && ['parcel', 'szz'].includes(x.type) && x.poly).length;
    html += `<div class="src-ctx-hdr">Выделено слоёв: ${sel.length}</div>
      <button onclick="hideLayers(${id}, ${anyVis});${close}">${anyVis ? 'Скрыть' : 'Показать'} слои</button>
      <button onclick="isolateLayers([${sel.join(',')}], 'выделенное');${close}">Показать только выделенные</button>
      <button onclick="groupLayers(${id});${close}">Сгруппировать <span class="src-ctx-key">Ctrl+G</span></button>
      <button onclick="lpToggleLock();${close}">${allLocked ? 'Разблокировать выделенные' : 'Заблокировать выделенные'}</button>` +
      (selL.length ? `<button onclick="setLayersCallouts([${sel.join(',')}], true);${close}">
        <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
        Выноски у выделенных (${selL.length})</button>` +
      (anyCall ? `<button onclick="setLayersCallouts([${sel.join(',')}], false);${close}">Снять выноски (${selL.filter(c => c.on).length})</button>` : '') +
      `<button onclick="openCalloutStyleDialog([${sel.join(',')}], 'Стиль выносок: выделено ${sel.length}');${close}">Один стиль выносок…</button>` : '') +
      `<button onclick="pickLayersColor([${sel.join(',')}]);${close}">Цвет выделенным…</button>` +
      (mergeableCnt >= 2 ? `<button onclick="mergeSelectedLayers([${sel.join(',')}]);${close}">⊕ Объединить выделенные (${mergeableCnt})</button>` : '') +
      `<div class="src-ctx-sep"></div>
      <button class="src-ctx-del" onclick="deleteLayers([${sel.join(',')}]);${close}">✕ Удалить выделенные (${sel.length})</button>
      <div class="src-ctx-sep"></div>`;
  }
  if (l.groupId) {
    html += `<button onclick="removeFromGroup(${id});${close}">Вынести из группы</button>
      <button onclick="ungroupLayers('${l.groupId}');${close}">Разгруппировать</button>`;
  }
  // Порядок: раньше стрелки жили в строке списка и съедали место у названия.
  // Перетаскивание никуда не делось, а точечный сдвиг теперь здесь.
  html += `<button onclick="moveLayerOrder(${id},-1);${close}">Поднять слой</button>
    <button onclick="moveLayerOrder(${id},1);${close}">Опустить слой</button>
    <div class="src-ctx-sep"></div>`;
  // Изоляция и замок нужны всегда — это самые частые операции над слоем
  html += `<button onclick="isolateLayer(${id});${close}">Показать только этот слой <span class="src-ctx-key">Alt+клик</span></button>
    <button onclick="toggleLayerLock(${id});${close}">${l.locked ? 'Разблокировать слой' : 'Заблокировать слой'}</button>`;
  if (sel.length < 2) html += `<button onclick="newLayerGroup();${close}">Новая группа…</button>`;
  return html ? html + '<div class="src-ctx-sep"></div>' : '';
}

window.layerContextMenu = (e, id) => {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('src-ctx-menu')?.remove();
  const l = mapLayers.find(x => x.id === id);
  if (!l) return;

  // Команды выделения и группы идут ПЕРВЫМ блоком, а не вместо остального меню
  const groupHtml = _groupMenuHtml(l, id);

  // ── ПКМ на слое источников ──
  if (l.type === 'src-emission' || l.type === 'src-noise' || l.type === 'src-other') {
    const srcType = l.type === 'src-emission' ? 'emission' : l.type === 'src-noise' ? 'noise' : 'other';
    const srcs = (typeof _sources !== 'undefined' ? _sources : []).filter(s => (s.type || 'emission') === srcType);
    const anyLabel = srcs.some(s => s.showLabel);
    const typeName = srcType === 'emission' ? 'выбросов' : srcType === 'noise' ? 'шума' : 'прочих';
    const menu = document.createElement('div');
    menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
    menu.innerHTML = groupHtml + `<button onclick="srcToggleTypeCallouts('${srcType}');document.getElementById('src-ctx-menu')?.remove()">
      <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
      ${anyLabel ? 'Скрыть' : 'Включить'} выноски ${typeName}</button>` +
      (srcs.length ? `<button onclick="openCalloutStyleDialog([${id}], 'Стиль выносок ${typeName}');document.getElementById('src-ctx-menu')?.remove()">Один стиль выносок…</button>` : '');
    document.body.appendChild(menu);
    placeCtxMenu(menu, e);   // подрезка и раскрытие вверх — в utils.js
    const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
    return;
  }

  // ── ПКМ на строке отдельной РТ ──
  // Сверху штатные команды групп (как у любого слоя), ниже — действия точки
  if (l.mpId) {
    const pt = (typeof _monPoints !== 'undefined' ? _monPoints : []).find(p => p.id === l.mpId);
    const menu = document.createElement('div');
    menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
    const close = "document.getElementById('src-ctx-menu')?.remove()";
    // Команды выделения (выноски, стиль, цвет, удаление) уже в groupHtml —
    // выделение РТ в окне РТ и в редакторе PDF отражается в выделение слоёв
    menu.innerHTML = groupHtml +
      `<button onclick="mpEditFromList('${l.mpId}');${close}">✎ Настройки РТ</button>
       <button onclick="mpActivateMoveMode('${l.mpId}');${close}">✥ Переместить</button>
       <button onclick="mpToggleOneCallout('${l.mpId}');${close}">
         <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
         ${pt && pt.showLabel ? 'Скрыть' : 'Включить'} выноску</button>
       <button onclick="openCalloutStyleDialog([${id}], 'Стиль выноски: ${escapeHtml(l.name || 'РТ').replace(/'/g, '&#39;')}');${close}">Стиль выноски…</button>
       <button onclick="pickLayersColor([${id}]);${close}">Цвет…</button>
       <button onclick="mpExportCoords('${l.mpId}');${close}"><svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-copy"/></svg>Экспорт координат</button>
       <div class="src-ctx-sep"></div>
       <button class="src-ctx-del" onclick="mpDeletePoint('${l.mpId}');${close}">✕ Удалить РТ</button>`;
    document.body.appendChild(menu);
    placeCtxMenu(menu, e);
    const off = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
    return;
  }

  // ── ПКМ на сводном слое РТ ──
  if (l.type === 'monpoints') {
    const mps = typeof _monPoints !== 'undefined' ? _monPoints : [];
    const anyLabel = mps.some(p => p.showLabel);
    const menu = document.createElement('div');
    menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
    menu.innerHTML = groupHtml + `<button onclick="mpToggleAllCallouts();document.getElementById('src-ctx-menu')?.remove()">
      <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
      ${anyLabel ? 'Скрыть' : 'Включить'} выноски РТ</button>`;
    document.body.appendChild(menu);
    placeCtxMenu(menu, e);   // подрезка и раскрытие вверх — в utils.js
    const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
    return;
  }

  if (!['parcel', 'szz', 'search-area'].includes(l.type)) {
    if (!groupHtml) return;
    const gm = document.createElement('div');
    gm.id = 'src-ctx-menu'; gm.className = 'src-ctx-menu';
    gm.innerHTML = groupHtml.replace(/<div class="src-ctx-sep"><\/div>$/, '');
    _placeCtxMenu(gm, e);
    return;
  }
  const pasteBtn = _copiedLayer
    ? `<button onclick="_pasteLayer();document.getElementById('src-ctx-menu')?.remove()"><svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-paste"/></svg>Вставить слой</button>
    <div class="src-ctx-sep"></div>`
    : '';
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu';
  menu.className = 'src-ctx-menu';
  const _co = l.callout && l.callout.on;
  const _canCall = window._canHaveCallout(l) && _targetLayers(id).length <= 1;
  menu.innerHTML = groupHtml +
    (_canCall ? `<button onclick="toggleLayerCallout(${id}, ${!_co});document.getElementById('src-ctx-menu')?.remove()">
      <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
      ${_co ? 'Убрать выноску' : 'Выноска с названием'}</button>
      <div class="src-ctx-sep"></div>` : '') + `
    <button onclick="_copyLayer(${id});document.getElementById('src-ctx-menu')?.remove()">⧉ Копировать слой</button>
    ${pasteBtn}
    <div class="src-ctx-sep"></div>
    <button onclick="startPolyMove(${id});document.getElementById('src-ctx-menu')?.remove()">✥ Переместить</button>
    <button onclick="startPolyEdit(${id});document.getElementById('src-ctx-menu')?.remove()">✏ Редактировать вершины</button>
    <button onclick="showLayerCoordsModal(${id});document.getElementById('src-ctx-menu')?.remove()"><svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-copy"/></svg>Экспорт координат</button>
    <div class="src-ctx-sep"></div>
    <button onclick="showPolyOpModal('difference',${id});document.getElementById('src-ctx-menu')?.remove()">✂ Вырезать из этого слоя...</button>
    <button onclick="showPolyOpModal('union',${id});document.getElementById('src-ctx-menu')?.remove()">⊕ Объединить с другим слоем...</button>
    <div class="src-ctx-sep"></div>
    <button onclick="selectLayer(${id});document.getElementById('src-ctx-menu')?.remove();searchSettlements()"><svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-search"/></svg>Найти НП</button>
  `;
  _placeCtxMenu(menu, e);
};

// Копировать слой в буфер
window._copyLayer = (id) => {
  const l = mapLayers.find(x => x.id === id);
  if (!l) return;
  _copiedLayer = {
    type:      l.type,
    name:      l.name,
    poly:      JSON.parse(JSON.stringify(l.poly)),
    _psStyle:  JSON.parse(JSON.stringify(l._psStyle || {})),
    color:     l.color,
    rawCoords: l.rawCoords ? JSON.parse(JSON.stringify(l.rawCoords)) : null,
    crsId:     l.crsId || null,
    parentId:  l.parentId || null,
  };
  setSt(`Слой «${l.name}» скопирован`, 'ok');
};

// Вставить слой из буфера
window._pasteLayer = () => {
  if (!_copiedLayer) return;
  const c = _copiedLayer;
  const s = c._psStyle;
  const leafLayer = L.polygon(c.poly, {
    color:       s.color,
    fillColor:   s.fillColor,
    fillOpacity: s.fillOpacity,
    opacity:     s.opacity ?? 1,
    weight:      s.weight ?? 2,
    dashArray:   s.dashArray ?? null,
  }).addTo(map);
  const newL = addMapLayer(c.type, 'Копия ' + c.name, c.poly, leafLayer, c.parentId);
  newL.color     = c.color;
  newL._psStyle  = JSON.parse(JSON.stringify(s));
  if (c.rawCoords) { newL.rawCoords = JSON.parse(JSON.stringify(c.rawCoords)); newL.crsId = c.crsId; }
  map.fitBounds(leafLayer.getBounds(), { padding: [40, 40] });
  setSt(`Вставлен слой «${newL.name}»`, 'ok');
};

// Модальное окно выбора второго слоя для операции
window.showPolyOpModal = (mode, id) => {
  document.getElementById('poly-op-modal')?.remove();
  const l = mapLayers.find(x => x.id === id);
  if (!l) return;
  const compatible = mapLayers.filter(x => x.id !== id && ['parcel', 'szz'].includes(x.type));
  if (!compatible.length) { setSt('Нет других подходящих слоёв для операции', 'err'); return; }
  const isDiff = mode === 'difference';
  const titleText = isDiff ? `Вырезать из «${escapeHtml(l.name)}»` : `Объединить «${escapeHtml(l.name)}» с...`;
  const hintText  = isDiff ? 'Выбери что вырезать:' : 'Выбери с чем объединить:';
  const btnText   = isDiff ? 'Вырезать' : 'Объединить';
  const opts = compatible.map(x =>
    `<option value="${x.id}">${x.type === 'szz' ? 'СЗЗ' : 'ЗУ'} — ${escapeHtml(x.name)}</option>`).join('');
  const modal = document.createElement('div');
  modal.id = 'poly-op-modal';
  modal.className = 'app-dialog';
  modal.innerHTML = `
    <div class="modal" style="width:360px">
      <div class="modal-hdr">
        <h2>${titleText}</h2>
        <button class="modal-close" onclick="document.getElementById('poly-op-modal')?.remove()">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
        <div style="font-size:var(--fs-1);color:var(--tx2)">${hintText}</div>
        <select id="poly-op-select" class="modal-input">${opts}</select>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
          <button class="btn" onclick="document.getElementById('poly-op-modal')?.remove()">Отмена</button>
          <button class="btn pri" onclick="doPolyOp('${mode}',${id},+document.getElementById('poly-op-select').value);document.getElementById('poly-op-modal')?.remove()">${btnText}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

// Выполнить булеву операцию с полигонами
window.doPolyOp = (mode, id1, id2) => {
  const l1 = mapLayers.find(l => l.id === id1);
  const l2 = mapLayers.find(l => l.id === id2);
  if (!l1 || !l2) { setSt('Слои не найдены', 'err'); return; }
  let t1, t2;
  try { t1 = _layerToTurf(l1); } catch(e) { setSt('Ошибка геометрии первого слоя', 'err'); return; }
  try { t2 = _layerToTurf(l2); } catch(e) { setSt('Ошибка геометрии второго слоя', 'err'); return; }
  let result;
  try {
    result = mode === 'difference'
      ? turf.difference(t1, t2)
      : turf.union(t1, t2);
  } catch(err) {
    setSt('Ошибка при выполнении операции с полигонами', 'err');
    console.error('doPolyOp error:', err);
    return;
  }
  if (!result) { setSt('Результат пуст — полигоны не пересекаются или совпадают', 'err'); return; }
  const geom = result.geometry;
  const outerCoords = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
  const poly = outerCoords.map(c => [c[1], c[0]]);
  const s = l1._psStyle || {};
  const leafLayer = L.geoJSON(geom, { style: () => ({
    color: s.color, weight: s.weight || 2,
    fillColor: s.fillColor, fillOpacity: s.fillOpacity || 0.1,
    dashArray: s.dashArray || null,
  }) }).addTo(map);
  const suffix = mode === 'difference' ? ' (вырезано)' : ` + ${l2.name}`;
  const newL = addMapLayer(l1.type, l1.name + suffix, poly, leafLayer, l1.parentId);
  newL.geojson = geom;
  if (mode === 'difference') newL.originalOuterPoly = l1.poly; // оригинальное кольцо СЗЗ до вырезания
  map.fitBounds(leafLayer.getBounds(), { padding: [40, 40] });
  setSt(`Создан слой «${newL.name}»`, 'ok');
};

// Объединить уже выделенные слои (Shift+клик) без выбора второго слоя в
// диалоге — «Объединить с...» остаётся рядом для случая, когда нужно явно
// выбрать, с чем именно объединять (выбор нужен, когда выделен один слой
// или хочется объединить не всё выделение целиком).
window.mergeSelectedLayers = function(ids) {
  const layers = ids.map(id => mapLayers.find(l => l.id === id))
                     .filter(l => l && ['parcel', 'szz'].includes(l.type) && l.poly);
  if (layers.length < 2) { setSt('Нужно минимум 2 подходящих слоя (ЗУ/СЗЗ) в выделении', 'err'); return; }
  let combined;
  try {
    combined = _layerToTurf(layers[0]);
    for (let i = 1; i < layers.length; i++) {
      const next = turf.union(combined, _layerToTurf(layers[i]));
      if (!next) throw new Error('turf.union вернул null — полигоны не пересекаются и не касаются');
      combined = next;
    }
  } catch(err) {
    setSt('Ошибка объединения: ' + err.message, 'err');
    console.error('mergeSelectedLayers:', err);
    return;
  }
  const geom = combined.geometry;
  const outerCoords = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
  const poly = outerCoords.map(c => [c[1], c[0]]);
  const s = layers[0]._psStyle || {};
  const leafLayer = L.geoJSON(geom, { style: () => ({
    color: s.color, weight: s.weight || 2,
    fillColor: s.fillColor, fillOpacity: s.fillOpacity || 0.1,
    dashArray: s.dashArray || null,
  }) }).addTo(map);
  const newL = addMapLayer(layers[0].type, `Объединение ${layers.length} слоёв`, poly, leafLayer, layers[0].parentId);
  newL.geojson = geom;
  map.fitBounds(leafLayer.getBounds(), { padding: [40, 40] });
  setSt(`Слой «${newL.name}» создан из ${layers.length} выделенных`, 'ok');
};

// ── Редактирование вершин полигона ────────────────────────────────────────────
window.startPolyEdit = function(id) {
  if (window._lockGuard && window._lockGuard(id, 'редактирование')) return;
  _editCleanup();
  const l = mapLayers.find(x => x.id === id);
  if (!l || !l.poly || l.poly.length < 3) { setSt('Нет геометрии для редактирования', 'err'); return; }

  _editLayerId = id;
  _editVerts   = l.poly.map(p => [...p]);

  // Toolbar
  _editToolbar = document.createElement('div');
  _editToolbar.id = 'poly-edit-toolbar';
  _editToolbar.innerHTML =
    `<span class="pet-name">✏ <b>${escapeHtml(l.name)}</b></span>` +
    `<span class="pet-hint" id="pet-hint">${_editVerts.length} вершин</span>` +
    `<span class="pet-tip">тяни — переместить · ПКМ — удалить · клик на ○ — добавить</span>` +
    `<button class="btn pet-btn" onclick="cancelPolyEdit()">Отмена</button>` +
    `<button class="btn pri pet-btn" onclick="applyPolyEdit()">✓ Применить</button>`;
  document.getElementById('map-wrapper').appendChild(_editToolbar);

  _editRebuild();
  setSt(`Редактирование «${l.name}»`, 'ok');
};

function _editRebuild() {
  _editMkrs.forEach(m => map.removeLayer(m));
  _editMidMkrs.forEach(m => map.removeLayer(m));
  _editMkrs = []; _editMidMkrs = [];
  if (_editPreview) { map.removeLayer(_editPreview); _editPreview = null; }

  const n = _editVerts.length;
  if (n < 3) return;

  // Preview outline
  _editPreview = L.polygon(_editVerts.map(p => L.latLng(p[0], p[1])), {
    color: '#3b82f6', weight: 2, fillOpacity: 0.06,
    fillColor: '#3b82f6', dashArray: '6,4', interactive: false,
  }).addTo(map);

  // Vertex markers
  for (let i = 0; i < n; i++) {
    const icon = L.divIcon({ className: '', html: '<div class="edit-vtx"></div>', iconSize: [14,14], iconAnchor: [7,7] });
    const m = L.marker(L.latLng(_editVerts[i][0], _editVerts[i][1]), { icon, draggable: true, zIndexOffset: 1000 }).addTo(map);
    const idx = i;
    m.on('drag', ev => {
      _editVerts[idx] = [ev.latlng.lat, ev.latlng.lng];
      _editUpdatePreview();
    });
    m.on('contextmenu', ev => {
      L.DomEvent.preventDefault(ev); L.DomEvent.stopPropagation(ev);
      if (_editVerts.length <= 3) { setSt('Минимум 3 вершины', 'err'); return; }
      _editVerts.splice(idx, 1);
      _editRebuild();
    });
    _editMkrs.push(m);
  }

  // Midpoint markers
  for (let i = 0; i < n; i++) {
    const a = _editVerts[i], b = _editVerts[(i+1) % n];
    const mid = [(a[0]+b[0])/2, (a[1]+b[1])/2];
    const icon = L.divIcon({ className: '', html: '<div class="edit-mid"></div>', iconSize: [10,10], iconAnchor: [5,5] });
    const m = L.marker(L.latLng(mid[0], mid[1]), { icon, zIndexOffset: 999 }).addTo(map);
    const ins = i + 1;
    m.on('click', ev => { L.DomEvent.stopPropagation(ev); _editVerts.splice(ins, 0, [...mid]); _editRebuild(); });
    _editMidMkrs.push(m);
  }

  const hint = document.getElementById('pet-hint');
  if (hint) hint.textContent = `${n} вершин`;
}

function _editUpdatePreview() {
  if (_editPreview) _editPreview.setLatLngs(_editVerts.map(p => L.latLng(p[0], p[1])));
  const n = _editVerts.length;
  _editMidMkrs.forEach((m, i) => {
    const a = _editVerts[i % n], b = _editVerts[(i+1) % n];
    if (a && b) m.setLatLng([(a[0]+b[0])/2, (a[1]+b[1])/2]);
  });
}

window.applyPolyEdit = function() {
  if (_editLayerId === null) return;
  const l = mapLayers.find(x => x.id === _editLayerId);
  if (!l) { _editCleanup(); return; }

  const newVerts = [..._editVerts];
  _editCleanup();

  const s = l._psStyle || {};
  if (l.layer && map.hasLayer(l.layer)) map.removeLayer(l.layer);

  const newLeaf = L.polygon(newVerts.map(p => L.latLng(p[0], p[1])), {
    color:       s.color       || l.color || '#f59e0b',
    weight:      s.weight      ?? 2,
    fillColor:   s.fillColor   || l.color || '#f59e0b',
    fillOpacity: s.fillOpacity ?? 0.15,
    dashArray:   s.dashArray   || null,
  }).addTo(map);

  l.poly  = newVerts;
  l.layer = newLeaf;
  delete l.geojson;
  _bindPolyCtx(l.id, newLeaf);

  renderLayers();
  updateButtons();
  setSt('Полигон обновлён', 'ok');
};

window.cancelPolyEdit = function() {
  const wasEditing = _editLayerId !== null;
  _editCleanup();
  if (wasEditing) setSt('Редактирование отменено', 'ok');
};

function _editCleanup() {
  _editMkrs.forEach(m => map.removeLayer(m));
  _editMidMkrs.forEach(m => map.removeLayer(m));
  _editMkrs = []; _editMidMkrs = [];
  if (_editPreview) { map.removeLayer(_editPreview); _editPreview = null; }
  if (_editToolbar) { _editToolbar.remove(); _editToolbar = null; }
  _editLayerId = null;
  _editVerts   = [];
}

// ── Перемещение полигона ───────────────────────────────────────────────────
window.startPolyMove = function(id) {
  if (window._lockGuard && window._lockGuard(id, 'перемещение')) return;
  _polyMoveCleanup();
  _editCleanup();           // нельзя редактировать и перемещать одновременно

  const l = mapLayers.find(x => x.id === id);
  if (!l || !l.poly || l.poly.length < 3) { setSt('Нет геометрии для перемещения', 'err'); return; }

  // Центроид полигона
  const cLat = l.poly.reduce((s, p) => s + p[0], 0) / l.poly.length;
  const cLon = l.poly.reduce((s, p) => s + p[1], 0) / l.poly.length;

  _polyMoveLayerId = id;

  const icon = L.divIcon({
    html: `<div class="poly-move-handle" title="${escapeHtml(l.name)}">✥</div>`,
    iconSize: [36, 36], iconAnchor: [18, 18], className: '',
  });

  const marker = L.marker([cLat, cLon], { draggable: true, zIndexOffset: 2000, icon }).addTo(map);

  let origPoly = l.poly.map(p => [...p]);
  let startLat = cLat, startLon = cLon;

  marker.on('dragstart', ev => {
    origPoly = l.poly.map(p => [...p]);
    startLat = ev.target.getLatLng().lat;
    startLon = ev.target.getLatLng().lng;
  });

  marker.on('drag', ev => {
    const dLat = ev.latlng.lat - startLat;
    const dLon = ev.latlng.lng - startLon;
    const newPoly = origPoly.map(p => [p[0] + dLat, p[1] + dLon]);
    // Обновляем слой на лету
    if (l.layer && typeof l.layer.setLatLngs === 'function') {
      l.layer.setLatLngs(newPoly.map(p => L.latLng(p[0], p[1])));
    }
    l.poly = newPoly;
  });

  marker.on('dragend', ev => {
    const dLat = ev.target.getLatLng().lat - startLat;
    const dLon = ev.target.getLatLng().lng - startLon;
    const newPoly = origPoly.map(p => [p[0] + dLat, p[1] + dLon]);
    l.poly = newPoly;
    delete l.geojson;

    // Пересобираем слой через L.polygon для надёжности (geoJSON-слои не имеют setLatLngs)
    const s = l._psStyle || {};
    if (l.layer && map.hasLayer(l.layer)) map.removeLayer(l.layer);
    l.layer = L.polygon(newPoly.map(p => L.latLng(p[0], p[1])), {
      color:       s.color       || l.color || '#f59e0b',
      weight:      s.weight      ?? 2,
      fillColor:   s.fillColor   || l.color || '#f59e0b',
      fillOpacity: s.fillOpacity ?? 0.15,
      dashArray:   s.dashArray   || null,
    }).addTo(map);
    _bindPolyCtx(l.id, l.layer);

    _polyMoveCleanup();
    renderLayers();
    updateButtons();
    setSt(`Слой «${l.name}» перемещён`, 'ok');
  });

  _polyMoveMarker = marker;
  map.panTo([cLat, cLon]);
  setSt(`Перетащите маркер чтобы переместить «${l.name}»`, 'ok');
};

function _polyMoveCleanup() {
  if (_polyMoveMarker) { try { map.removeLayer(_polyMoveMarker); } catch(e){} _polyMoveMarker = null; }
  _polyMoveLayerId = null;
}

// ── Общая модалка координат (используется слоями, источниками, РТ) ─────────────
window.showCoordsModal = function(title, rings, filename) {
  document.getElementById('layer-coords-modal')?.remove();

  const fmt = v => (+v).toFixed(6);
  const toText = ring => ring.map(p => `${fmt(p[0])} ${fmt(p[1])}`).join('\n');

  let coordsText;
  if (rings.length === 1) {
    coordsText = toText(rings[0]);
  } else {
    coordsText = rings.map((r, i) =>
      (i === 0 ? '# Внешний контур' : `# Часть ${i}`) + '\n' + toText(r)
    ).join('\n\n');
  }
  const totalPts = rings.reduce((s, r) => s + r.length, 0);
  const safeName = (filename || title).replace(/[^а-яёa-z0-9_\-]/gi, '_');

  const modal = document.createElement('div');
  modal.id = 'layer-coords-modal';
  modal.className = 'app-dialog';
  modal.innerHTML = `
    <div class="modal" style="width:400px">
      <div class="modal-hdr">
        <h2>Координаты: «${title}»</h2>
        <button class="modal-close" onclick="document.getElementById('layer-coords-modal')?.remove()">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:var(--fs-1);color:var(--tx2)">${totalPts} точек · широта долгота · WGS 84</div>
        <textarea id="lcm-text" readonly
          style="width:100%;height:220px;resize:vertical;font-size:var(--fs-1);font-family:monospace;
                 background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:var(--r-sm);
                 padding:8px;box-sizing:border-box;line-height:1.5"
        >${coordsText}</textarea>
        <div style="display:flex;gap:8px">
          <button class="btn" id="lcm-copy-btn" onclick="(()=>{
            navigator.clipboard.writeText(document.getElementById('lcm-text').value);
            const b=document.getElementById('lcm-copy-btn');
            b.textContent='✓ Скопировано'; setTimeout(()=>b.textContent='Скопировать',1500);
          })()" style="flex:1">Скопировать</button>
          <button class="btn pri" onclick="(()=>{
            const txt=document.getElementById('lcm-text').value;
            const a=document.createElement('a');
            a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(txt);
            a.download='${safeName}_coords.txt';
            a.click();
          })()" style="flex:1">⬇ Скачать .txt</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

// ── Экспорт координат полигона слоя ──────────────────────────────────────────
window.showLayerCoordsModal = function(id) {
  const l = mapLayers.find(x => x.id === id);
  if (!l || !l.poly || l.poly.length < 3) { setSt('Нет геометрии', 'err'); return; }

  let rings = [];
  if (l.geojson && l.geojson.type === 'Polygon') {
    rings = l.geojson.coordinates.map(ring => ring.slice(0, -1).map(c => [c[1], c[0]]));
  } else if (l.geojson && l.geojson.type === 'MultiPolygon') {
    rings = l.geojson.coordinates.map(poly => poly[0].slice(0, -1).map(c => [c[1], c[0]]));
  } else {
    rings = [l.poly];
  }
  showCoordsModal(l.name, rings, l.name);
};


/* ═══════════════════════════════════════════════════════════════════════════
   UX-блок панели слоёв и свойств
   • свойства применяются ко всему выделению, а не к одному слою
   • группы: вложенность, блокировка, цветная метка, изоляция
   Живёт в конце map.js намеренно: ему нужен прямой доступ к mapLayers,
   _layerGroups и _selLayerIds — это script-scoped let, из другого файла их
   не видно.
   ═══════════════════════════════════════════════════════════════════════════ */

// ── A. Панель свойств: показ выделения ──────────────────────────────────────

// Поле панели → id элемента ввода. Нужен, чтобы подсветить «разные значения».
const _LP_FIELD_INPUTS = {
  fillColor:   'lp-fill-color',
  color:       'lp-stroke-color',
  fillOpacity: 'lp-fill-opacity',
  opacity:     'lp-stroke-opacity',
  weight:      'lp-weight',
  dashArray:   'lp-dash',
  fillPattern: 'lp-fill-pattern',
  zoneType:    'lp-zone-type',
};

function _lpFieldValueOf(l, f) {
  if (f === 'zoneType') return l.zoneType || '';
  const s = l._psStyle || {};
  return s[f];
}

// Поля, которые у выделенных слоёв различаются, помечаем классом lp-mixed.
// Пока поле не тронули — оно не раскатывается на выделение (см. applyLayerProps).
function _lpMarkMixed(targets) {
  Object.entries(_LP_FIELD_INPUTS).forEach(([f, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const vals = new Set(targets.map(l => String(_lpFieldValueOf(l, f))));
    const mixed = vals.size > 1 && !window._lpIsTouched(f);
    el.classList.toggle('lp-mixed', mixed);
    if (mixed) el.dataset.mixedHint = 'Разные значения — тронь, чтобы задать всем';
    else delete el.dataset.mixedHint;
  });
}

function _lpClearMixed() {
  Object.values(_LP_FIELD_INPUTS).forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('lp-mixed'); delete el.dataset.mixedHint; }
  });
}

// Площадь, периметр и число вершин слоя. Считаем через turf по эллипсоиду —
// та же математика, что и у измерителя на карте.
function _lpGeomStats(l) {
  if (!l || !l.poly || l.poly.length < 3 || typeof turf === 'undefined') return null;
  try {
    const ring = l.poly.map(p => [p[1], p[0]]);
    ring.push(ring[0]);
    const area = turf.area(turf.polygon([ring]));
    const per  = turf.length(turf.lineString(ring), { units: 'kilometers' }) * 1000;
    return { area, per, n: l.poly.length };
  } catch (e) { return null; }
}

function _lpRenderGeomInfo(targets) {
  const box = document.getElementById('lp-geom-info');
  if (!box) return;
  const withGeom = targets.filter(l => l.poly && l.poly.length >= 3);
  if (!withGeom.length) { box.style.display = 'none'; box.innerHTML = ''; return; }

  let area = 0, per = 0, n = 0, ok = 0;
  withGeom.forEach(l => {
    const g = _lpGeomStats(l);
    if (!g) return;
    area += g.area; per += g.per; n += g.n; ok++;
  });
  if (!ok) { box.style.display = 'none'; return; }

  const fmtA = typeof _fmtArea === 'function' ? _fmtArea(area) : Math.round(area) + ' м²';
  const fmtP = typeof _fmtDist === 'function' ? _fmtDist(per)  : Math.round(per) + ' м';
  const crs  = ok === 1 && withGeom[0].crsId ? withGeom[0].crsId : null;
  const head = ok > 1 ? `Суммарно по ${ok} слоям` : 'Геометрия';

  box.style.display = '';
  box.innerHTML =
    `<div class="lp-geom-hdr">${head}</div>` +
    `<div class="lp-geom-grid">` +
      `<span>Площадь</span><b>${fmtA}</b>` +
      `<span>Периметр</span><b>${fmtP}</b>` +
      `<span>Вершин</span><b>${n}</b>` +
      (crs ? `<span>СК</span><b>${crs}</b>` : '') +
    `</div>`;
}

// Новая точка входа: панель обслуживает всё выделение целиком.
// Базовый рендер (_showLayerPropsBase) остаётся прежним и заполняет поля по
// активному слою, а сверху накладываются пометки «разное» и сводка геометрии.
function showLayerProps(l) {
  const panel = document.getElementById('layer-props-panel');
  if (!l) {
    if (panel) panel.style.display = 'none';
    _lpClearMixed();
    _lpRenderGeomInfo([]);
    return;
  }
  _showLayerPropsBase(l);
  if (window.Workspace) Workspace.inspectLayer();

  const targets = _propsTargets();
  const nameEl  = document.getElementById('layer-props-name');
  if (targets.length > 1) {
    if (nameEl) nameEl.textContent = `выделено ${targets.length}`;
    _lpMarkMixed(targets);
  } else {
    if (nameEl) nameEl.textContent = l.name;
    _lpClearMixed();
  }
  _lpRenderGeomInfo(targets);
  _lpSyncOpacityRow(targets);
  _lpSyncLockRow(targets);
}
window.showLayerProps = showLayerProps;

// ── A5. Общая непрозрачность слоя ───────────────────────────────────────────
// Отдельно от заливки и обводки: приглушает слой целиком, не трогая их
// соотношение. Реализована как CSS-прозрачность SVG-элементов Leaflet.

function _eachLayerPath(leaf, fn) {
  if (!leaf) return;
  if (leaf._path) { fn(leaf._path); return; }
  if (typeof leaf.eachLayer === 'function') leaf.eachLayer(sub => _eachLayerPath(sub, fn));
}
// Нужна и редактору PDF: там слой создаётся заново, и общую прозрачность
// приходится накладывать на его собственные элементы.
window._eachLayerPath = _eachLayerPath;

window._applyLayerOpacityTo = function(l, v) {
  if (!l || !l.layer) return;
  const o = Math.max(0, Math.min(1, v));
  if (!l._psStyle) l._psStyle = {};
  l._psStyle.layerOpacity = o;
  _eachLayerPath(l.layer, el => { el.style.opacity = o === 1 ? '' : String(o); });
  // Выноска слоя гаснет вместе с ним — иначе подпись висит над пустотой
  (l._calloutLayers || []).forEach(x => {
    const el = x && (x._el || x._container || x._path);
    if (el && el.style) el.style.opacity = o === 1 ? '' : String(o);
  });
};

window.setLayerOpacity = function(v) {
  const o = (parseInt(v, 10) || 0) / 100;
  const targets = _propsTargets();
  if (!targets.length) return;
  targets.forEach(l => window._applyLayerOpacityTo(l, o));
  const lab = document.getElementById('lp-opacity-all-val');
  if (lab) lab.textContent = Math.round(o * 100) + '%';
  if (typeof markDirty === 'function') markDirty();
  if (typeof window._pdfOnLayerStyleChanged === 'function') targets.forEach(l => window._pdfOnLayerStyleChanged(l));
};

function _lpSyncOpacityRow(targets) {
  const sl = document.getElementById('lp-opacity-all');
  if (!sl) return;
  const vals = new Set(targets.map(l => (l._psStyle && l._psStyle.layerOpacity) ?? 1));
  const v = vals.size === 1 ? [...vals][0] : 1;
  sl.value = Math.round(v * 100);
  const lab = document.getElementById('lp-opacity-all-val');
  if (lab) lab.textContent = Math.round(v * 100) + '%';
  sl.classList.toggle('lp-mixed', vals.size > 1);
}

// ── A6. Копирование стиля ───────────────────────────────────────────────────
let _lpStyleClip = null;

window.lpCopyStyle = function() {
  const l = getActiveLayer();
  if (!l) return;
  _lpStyleClip = JSON.parse(JSON.stringify(l._psStyle || {}));
  if (l.callout) _lpStyleClip._callout = JSON.parse(JSON.stringify({
    calloutColor: l.callout.calloutColor, calloutLineWidth: l.callout.calloutLineWidth,
    calloutTextColor: l.callout.calloutTextColor, calloutStrokeColor: l.callout.calloutStrokeColor,
    calloutStrokeWidth: l.callout.calloutStrokeWidth, calloutFontFamily: l.callout.calloutFontFamily,
    calloutFontSize: l.callout.calloutFontSize,
  }));
  const btn = document.getElementById('lp-paste-style');
  if (btn) btn.disabled = false;
  setSt(`Стиль слоя «${l.name}» скопирован`, 'ok');
};

window.lpPasteStyle = function() {
  if (!_lpStyleClip) { setSt('Сначала скопируй стиль', 'err'); return; }
  const targets = _propsTargets();
  if (!targets.length) return;
  if (typeof mapUndoPush === 'function') mapUndoPush('вставка стиля');
  const st = { ..._lpStyleClip };
  const cal = st._callout; delete st._callout;
  targets.forEach(l => {
    l._psStyle = { ...(l._psStyle || {}), ...st };
    l.color = st.color || l.color;
    try { if (l.layer && l.layer.setStyle) l.layer.setStyle(l._psStyle); } catch (e) {}
    if (typeof window._reapplyLayerStyle === 'function') window._reapplyLayerStyle(l);
    if (st.layerOpacity != null) window._applyLayerOpacityTo(l, st.layerOpacity);
    if (cal && l.callout && l.callout.on && typeof window._applyLayerCalloutStyle === 'function') {
      window._applyLayerCalloutStyle(l, cal);
    }
    if (typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(l);
    if (typeof window._pdfOnLayerStyleChanged === 'function') window._pdfOnLayerStyleChanged(l);
  });
  renderLayers();
  const al = getActiveLayer();
  if (al) showLayerProps(al);
  if (typeof markDirty === 'function') markDirty();
  setSt(targets.length > 1 ? `Стиль вставлен в ${targets.length} слоёв` : 'Стиль вставлен', 'ok');
};

// ── A2. Открепляемая панель свойств ─────────────────────────────────────────
// Стиль крутят долго, а список слоёв при этом должен оставаться на виду.
// Панель умеет жить плавающим окном: положение и размер запоминаются.

let _lpFloating = false;

function _lpStoreGet(k, d) {
  try { return (typeof Store !== 'undefined' && Store.get) ? (Store.get(k) ?? d) : d; }
  catch (e) { return d; }
}
function _lpStoreSet(k, v) {
  try { if (typeof Store !== 'undefined' && Store.set) Store.set(k, v); } catch (e) {}
}

// Где сейчас панель: в редакторе PDF и на карте у неё своё место, поэтому
// положение запоминается отдельно для каждого режима
function _lpCtx() {
  const ed = document.getElementById('pdf-editor');
  return (ed && ed.style.display !== 'none') ? 'pdf' : 'map';
}
const _LP_DEF_POS = { left: 360, top: 120, w: 300, h: 420 };
function _lpPosGet() {
  const all = _lpStoreGet('lpFloatPos', null);
  if (!all) return { ..._LP_DEF_POS };
  // Старый формат — один общий набор координат
  if (all.left !== undefined) return { ...all };
  return { ...(all[_lpCtx()] || _LP_DEF_POS) };
}
function _lpPosSet(pos) {
  const all = _lpStoreGet('lpFloatPos', null);
  const obj = (all && all.left === undefined) ? { ...all } : {};
  obj[_lpCtx()] = pos;
  _lpStoreSet('lpFloatPos', obj);
}
// Режим крепления: своя колонка слева, свободное окно или колонка справа
function _lpModeGet() { return _lpStoreGet('lpDock', {})[_lpCtx()] || 'right'; }
function _lpModeSet(m) {
  const all = { ...(_lpStoreGet('lpDock', {}) || {}) };
  all[_lpCtx()] = m;
  _lpStoreSet('lpDock', all);
}

window.toggleLayerPropsDock = function() {
  // Кнопка гоняет по кругу: боковая колонка → свободное окно → колонка справа
  const next = _lpModeGet() === 'float' ? 'right' : 'float';
  _lpModeSet(next);
  _lpFloating = next !== 'sidebar';
  _lpStoreSet('lpFloating', _lpFloating);
  _lpApplyDock();
  const names = { sidebar: 'в боковой колонке', float: 'отдельным окном', right: 'у правого края' };
  setSt('Панель свойств — ' + names[next], 'ok');
};

function _lpApplyDock() {
  const panel = document.getElementById('layer-props-panel');
  if (!panel) return;
  const mode = _lpModeGet();
  if (window.Workspace && Workspace.mountLayerProps(mode)) {
    _lpFloating = false;
    return;
  }
  _lpFloating = mode !== 'sidebar';
  const btn = document.getElementById('lp-dock-btn');
  panel.classList.toggle('lp-floating',   mode === 'float');
  panel.classList.toggle('lp-dock-right', mode === 'right');
  if (mode === 'float') {
    const pos = _lpPosGet();
    // Не даём панели остаться за экраном, если окно стало меньше
    const w = Math.min(pos.w || 300, Math.max(240, window.innerWidth  - 40));
    const h = Math.min(pos.h || 420, Math.max(200, window.innerHeight - 40));
    panel.style.left   = Math.min(Math.max(0, pos.left), window.innerWidth  - 80) + 'px';
    panel.style.top    = Math.min(Math.max(0, pos.top),  window.innerHeight - 40) + 'px';
    panel.style.width  = w + 'px';
    panel.style.height = h + 'px';
    panel.style.right  = '';
  } else if (mode === 'right') {
    panel.style.left = panel.style.top = panel.style.height = '';
    _lpFitRight(panel);
  } else {
    panel.style.left = panel.style.top = panel.style.width = panel.style.height = panel.style.right = '';
  }
  if (mode !== 'sidebar') {
    // Развёрнутой панель должна быть всегда: свёрнутое окно выглядит
    // как потерянный огрызок заголовка
    const body = panel.querySelector('.section-body');
    if (body) body.style.display = '';
    _lpBindFloatDrag(panel);
  }
  if (mode === 'right') { _lpBindRightResize(panel); _lpWatchRight(); }
  if (btn) btn.title = { sidebar: 'Открепить панель', float: 'Прикрепить к правому краю',
                         right: 'Вернуть в боковую колонку' }[mode];
}
window._lpApplyDock = _lpApplyDock;


// Панель у правого края не должна залезать на панель результатов поиска:
// та — часть раскладки окна, а не накладка. Считаем её ширину и встаём левее.
function _lpRightOffset() {
  const res = document.getElementById('results-panel');
  if (!res) return 0;
  const cs = getComputedStyle(res);
  if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
  return Math.round(res.getBoundingClientRect().width) || 0;
}

function _lpFitRight(panel) {
  panel = panel || document.getElementById('layer-props-panel');
  if (!panel || !panel.classList.contains('lp-dock-right')) return;
  const off = _lpRightOffset();
  const maxW = Math.max(220, window.innerWidth - off - 320);   // оставляем место карте
  const w = Math.min(_lpStoreGet('lpRightW', 300) || 300, maxW);
  panel.style.right = off + 'px';
  panel.style.width = w + 'px';
}
// Прямая ссылка, без обёртки: стрелка перезаписала бы саму функцию и звала себя
window._lpFitRight = _lpFitRight;

// Панель результатов появляется и исчезает — подстраиваемся автоматически
function _lpWatchRight() {
  if (window._lpRightWatched) return;
  window._lpRightWatched = true;
  window.addEventListener('resize', () => _lpFitRight());
  const res = document.getElementById('results-panel');
  if (res && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => _lpFitRight()).observe(res, { attributes: true, attributeFilter: ['style', 'class'] });
  }
}

// Тянем левый край — меняем ширину прикреплённой панели
function _lpBindRightResize(panel) {
  if (panel._lpRightResBound) return;
  panel._lpRightResBound = true;
  const grip = document.createElement('div');
  grip.className = 'lp-right-grip';
  grip.title = 'Тянуть — ширина панели';
  panel.appendChild(grip);
  grip.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const off = _lpRightOffset();
    const onMove = ev => {
      const w = Math.min(Math.max(220, startW + (startX - ev.clientX)),
                         Math.max(220, window.innerWidth - off - 320));
      panel.style.width = w + 'px';
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      _lpStoreSet('lpRightW', Math.round(panel.getBoundingClientRect().width));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// Подсветка зоны крепления при перетаскивании
function _lpDropHint(side) {
  let el = document.getElementById('lp-drop-hint');
  if (!side) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'lp-drop-hint';
    document.body.appendChild(el);
  }
  el.className = 'lp-drop-hint ' + side;
}

function _lpBindFloatDrag(panel) {
  const hdr = panel.querySelector('.section-hdr');
  if (!hdr || hdr._lpDragBound) return;
  hdr._lpDragBound = true;
  hdr.addEventListener('pointerdown', e => {
    if (!_lpFloating) return;
    if (e.target.closest('button, input, select')) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const EDGE = 70;                       // насколько близко к краю — значит «прикрепить»
    let side = null;
    const onMove = ev => {
      const left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth  - 80);
      const top  = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
      panel.style.left = left + 'px';
      panel.style.top  = top  + 'px';
      side = ev.clientX > window.innerWidth - EDGE ? 'right'
           : ev.clientX < EDGE                     ? 'left' : null;
      _lpDropHint(side);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      _lpDropHint(null);
      if (side === 'right' || side === 'left') {
        // Бросили у края — панель крепится туда и там же останется
        _lpModeSet(side === 'right' ? 'right' : 'sidebar');
        _lpApplyDock();
        setSt(side === 'right' ? 'Панель прикреплена справа' : 'Панель возвращена в боковую колонку', 'ok');
        return;
      }
      const rr = panel.getBoundingClientRect();
      _lpPosSet({ left: rr.left, top: rr.top, w: rr.width, h: rr.height });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  // Изменение размера мышкой тоже запоминаем
  if (!panel._lpResObs && typeof ResizeObserver !== 'undefined') {
    panel._lpResObs = new ResizeObserver(() => {
      if (_lpModeGet() !== 'float') return;
      clearTimeout(panel._lpResT);
      panel._lpResT = setTimeout(() => {
        const rr = panel.getBoundingClientRect();
        _lpPosSet({ left: rr.left, top: rr.top, w: rr.width, h: rr.height });
      }, 400);
    });
    panel._lpResObs.observe(panel);
  }
}

// ── B. Группы: вложенность ──────────────────────────────────────────────────
// _layerGroups[gid] = { name, collapsed, parent?, color?, locked? }

// Цепочка групп от корня до gid. Защищена от циклов на случай кривого проекта.
window._uxGroupChain = function(gid) {
  const chain = [];
  let cur = gid, guard = 0;
  while (cur && _layerGroups[cur] && guard++ < 16) {
    chain.unshift(cur);
    cur = _layerGroups[cur].parent || null;
  }
  return chain;
};

window._uxGroupDepth = gid => window._uxGroupChain(gid).length;

// Все слои группы, включая вложенные подгруппы
window._uxGroupLayers = function(gid) {
  return mapLayers.filter(l => l.groupId && window._uxGroupChain(l.groupId).includes(gid));
};

function _uxGroupVisState(gid) {
  const members = window._uxGroupLayers(gid);
  const vis = members.filter(l => l.visible !== false).length;
  return { total: members.length, vis, all: vis === members.length && members.length > 0, some: vis > 0 && vis < members.length };
}

// Заголовки всех групп цепочки. Возвращает true, если строку слоя показывать
// не нужно (какая-то из групп цепочки свёрнута).
window._uxEmitGroupHeaders = function(parts, gid, rendered) {
  const chain = window._uxGroupChain(gid);
  if (!chain.length) return false;
  let hidden = false;
  chain.forEach((cg, i) => {
    if (hidden) return;                       // предок свёрнут — вложенное не рисуем
    const g = _layerGroups[cg];
    if (!g) return;
    if (!rendered.has(cg)) {
      rendered.add(cg);
      parts.push(_uxGroupHeaderHtml(cg, g, i));
    }
    if (g.collapsed) hidden = true;
  });
  return hidden;
};

function _uxGroupHeaderHtml(gid, g, depth) {
  const st  = _uxGroupVisState(gid);
  const col = g.color || '';
  const lock = g.locked
    ? `<span class="li-lock on" onclick="event.stopPropagation();toggleGroupLock('${gid}')" title="Группа заблокирована — клик снимает"><svg class="icon icon-sm"><use href="#ico-lock"/></svg></span>`
    : `<span class="li-lock" onclick="event.stopPropagation();toggleGroupLock('${gid}')" title="Заблокировать группу"><svg class="icon icon-sm"><use href="#ico-lock"/></svg></span>`;
  return `<div class="li-group ${g.collapsed ? 'collapsed' : ''} ${g.locked ? 'locked' : ''}"
           data-gid="${gid}" style="--g-depth:${depth}"
           onclick="toggleLayerGroup('${gid}')"
           draggable="true"
           ondragstart="onGroupDragStart(event,'${gid}')"
           ondragend="onLayerDragEnd(event)"
           ondragover="onGroupDragOver(event)"
           ondragleave="onGroupDragLeave(event)"
           ondrop="onGroupDrop(event,'${gid}')"
           oncontextmenu="layerGroupContextMenu(event,'${gid}');return false"
           title="Клик — свернуть или развернуть группу">
      ${col ? `<span class="li-group-bar" style="background:${col}"></span>` : ''}
      <span class="li-group-arrow">${g.collapsed ? '▸' : '▾'}</span>
      <input type="checkbox" class="li-chk li-group-chk" data-gid="${gid}" ${st.all ? 'checked' : ''}
             onclick="toggleGroupVis(event,'${gid}')" title="Видимость всей группы (Alt — изолировать)">
      <span class="li-group-name" id="gname-${gid}"
            contenteditable="false"
            onblur="saveGroupName('${gid}')"
            onkeydown="handleGroupNameKey(event,'${gid}')"
            ondblclick="event.stopPropagation();startGroupRename('${gid}')">${escapeHtml(g.name)}</span>
      <span class="li-group-cnt">${st.total}</span>
      ${lock}
      <span class="li-move" onclick="event.stopPropagation();moveGroupOrder('${gid}',-1)" title="Группу выше">▲</span>
      <span class="li-move" onclick="event.stopPropagation();moveGroupOrder('${gid}',1)" title="Группу ниже">▼</span>
    </div>`;
}

// Чекбоксы групп с частичной видимостью должны выглядеть частичными,
// иначе «включено» показывается при одном видимом слое из восьми.
window._uxAfterRenderLayers = function() {
  document.querySelectorAll('.li-group-chk').forEach(chk => {
    const st = _uxGroupVisState(chk.dataset.gid);
    chk.indeterminate = st.some;
  });
  const btn = document.getElementById('lp-paste-style');
  if (btn) btn.disabled = !_lpStyleClip;
};

// ── B8. Переименование группы прямо в строке ────────────────────────────────
window.startGroupRename = function(gid) {
  const span = document.getElementById('gname-' + gid);
  if (!span) return false;   // строки группы нет в DOM (напр. панель PDF-редактора) — пусть вызывающий сам решит, что делать
  span.contentEditable = 'true';
  span.focus();
  try { document.execCommand('selectAll', false, null); } catch (e) {}
  return true;
};

window.handleGroupNameKey = function(e, gid) {
  if (e.key === 'Enter')  { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { e.preventDefault(); e.target.textContent = (_layerGroups[gid] || {}).name || ''; e.target.blur(); }
  e.stopPropagation();
};

window.saveGroupName = function(gid) {
  const span = document.getElementById('gname-' + gid);
  const g = _layerGroups[gid];
  if (!g || !span) return;
  const v = span.textContent.trim();
  g.name = v || g.name;
  span.contentEditable = 'false';
  span.textContent = g.name;
  if (typeof markDirty === 'function') markDirty();
};

// ── B12. Новая (в том числе пустая) группа ──────────────────────────────────
window.newLayerGroup = function(name) {
  if (typeof mapUndoPush === 'function') mapUndoPush('новая группа');
  const gid = _newGroupId();
  _layerGroups[gid] = { name: name || ('Группа ' + (Object.keys(_layerGroups).length + 1)), collapsed: false };
  // Если что-то выделено — сразу складываем внутрь: пустая группа нужна редко
  const sel = mapLayers.filter(l => _selLayerIds.has(l.id));
  if (sel.length) {
    sel.forEach(l => { l.groupId = gid; });
    const first = mapLayers.findIndex(l => l.id === sel[0].id);
    const rest  = mapLayers.filter(l => !_selLayerIds.has(l.id));
    rest.splice(Math.min(first, rest.length), 0, ...sel);
    mapLayers = rest;
    _syncLayerOrder();
  }
  renderLayers();
  setSt(sel.length ? `Новая группа, слоёв: ${sel.length}` : 'Создана пустая группа — перетащи в неё слои', 'ok');
  setTimeout(() => window.startGroupRename(gid), 30);
  return gid;
};

// ── B14. Автогруппировка по типу ────────────────────────────────────────────
const _UX_TYPE_GROUP = {
  parcel: 'Земельные участки', szz: 'Санитарно-защитные зоны', 'search-area': 'Области поиска',
  sources: 'Источники', 'src-emission': 'Источники', 'src-noise': 'Источники', 'src-other': 'Источники',
  monpoints: 'Расчётные точки',
  'src-callouts': 'Выноски', 'src-callouts-emission': 'Выноски', 'src-callouts-noise': 'Выноски',
  'src-callouts-other': 'Выноски', 'mp-callouts': 'Выноски',
};

window.groupLayersByType = function() {
  const free = mapLayers.filter(l => !l.groupId);
  if (!free.length) { setSt('Все слои уже разложены по группам', 'err'); return; }
  const buckets = {};
  free.forEach(l => {
    const name = _UX_TYPE_GROUP[l.type] || 'Прочее';
    (buckets[name] = buckets[name] || []).push(l);
  });
  const names = Object.keys(buckets).filter(n => buckets[n].length >= 2);
  if (!names.length) { setSt('Нечего группировать: нет двух слоёв одного типа', 'err'); return; }
  if (typeof mapUndoPush === 'function') mapUndoPush('группировка по типу');
  names.forEach(n => {
    const ids = buckets[n].map(l => l.id);
    if (typeof window.groupLayersByIds === 'function') window.groupLayersByIds(ids, n);
  });
  renderLayers();
  setSt(`Создано групп: ${names.length}`, 'ok');
};

// ── B13. Вложить группу в группу ────────────────────────────────────────────
window.nestGroupInto = function(childGid, parentGid) {
  if (!childGid || !parentGid || childGid === parentGid) return false;
  if (!_layerGroups[childGid] || !_layerGroups[parentGid]) return false;
  // Родителя нельзя вкладывать в собственного потомка
  if (window._uxGroupChain(parentGid).includes(childGid)) {
    setSt('Нельзя вложить группу в саму себя', 'err');
    return false;
  }
  if (typeof mapUndoPush === 'function') mapUndoPush('вложение группы');
  _layerGroups[childGid].parent = parentGid;
  // Блок вложенной группы переносим внутрь блока родителя, иначе заголовки
  // разъедутся: рендер опирается на порядок mapLayers
  const child  = window._uxGroupLayers(childGid);
  const rest   = mapLayers.filter(l => !child.includes(l));
  const anchor = rest.filter(l => l.groupId && window._uxGroupChain(l.groupId).includes(parentGid));
  const at = anchor.length ? rest.indexOf(anchor[anchor.length - 1]) + 1 : rest.length;
  rest.splice(at, 0, ...child);
  mapLayers = rest;
  _syncLayerOrder();
  renderLayers();
  setSt(`«${_layerGroups[childGid].name}» вложена в «${_layerGroups[parentGid].name}»`, 'ok');
  return true;
};

window.unnestGroup = function(gid) {
  const g = _layerGroups[gid];
  if (!g || !g.parent) { setSt('Группа и так на верхнем уровне', 'err'); return; }
  if (typeof mapUndoPush === 'function') mapUndoPush('вынести группу');
  delete g.parent;
  renderLayers();
  setSt(`«${g.name}» вынесена на верхний уровень`, 'ok');
};

// ── B15. Цветная метка группы ───────────────────────────────────────────────
window.setGroupColor = function(gid, color) {
  const g = _layerGroups[gid];
  if (!g) return;
  if (color) g.color = color; else delete g.color;
  renderLayers();
  if (typeof markDirty === 'function') markDirty();
};

// ── B10. Изоляция ───────────────────────────────────────────────────────────
// Alt+клик по галке видимости — показать только это. Повторный — вернуть как было.
let _uxIsolateSnapshot = null;

function _uxSetVisible(l, on) {
  if (!l || l.visible === on) return;
  l.visible = on;
  try { on ? map.addLayer(l.layer) : map.removeLayer(l.layer); } catch (e) {}
  if (on && typeof _reapplyLayerStyle === 'function') _reapplyLayerStyle(l);
  if (l.callout && l.callout.on) { if (on) _drawLayerCallout(l); else _clearLayerCallout(l); }
  if (!l.poly && typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(l);
  if (typeof window._pdfOnLayerToggled === 'function') window._pdfOnLayerToggled(l);
}

window.isolateLayers = function(keepIds, label) {
  const keep = new Set(keepIds);
  if (_uxIsolateSnapshot) { window.clearIsolate(); return; }
  _uxIsolateSnapshot = mapLayers.map(l => ({ id: l.id, visible: l.visible !== false }));
  mapLayers.forEach(l => _uxSetVisible(l, keep.has(l.id)));
  renderLayers();
  _uxSyncIsolateBadge();
  setSt(`Изоляция: ${label || 'выбранное'} — повторный Alt+клик вернёт всё`, 'ok');
};

window.clearIsolate = function() {
  if (!_uxIsolateSnapshot) return;
  const snap = _uxIsolateSnapshot;
  _uxIsolateSnapshot = null;
  snap.forEach(s => {
    const l = mapLayers.find(x => x.id === s.id);
    if (l) _uxSetVisible(l, s.visible);
  });
  renderLayers();
  _uxSyncIsolateBadge();
  setSt('Видимость слоёв возвращена', 'ok');
};

window.isolateLayer = id => window.isolateLayers([id], 'слой');
window.isolateGroup = gid => window.isolateLayers(window._uxGroupLayers(gid).map(l => l.id),
                                                  `группа «${(_layerGroups[gid] || {}).name || ''}»`);
window._uxIsIsolated = () => !!_uxIsolateSnapshot;

function _uxSyncIsolateBadge() {
  const b = document.getElementById('ux-isolate-badge');
  if (b) b.style.display = _uxIsolateSnapshot ? '' : 'none';
}

// ── B11. Блокировка ─────────────────────────────────────────────────────────
// Заблокированный слой нельзя удалить, перетащить, править и сдвинуть.
window._isLayerLocked = function(l) {
  if (!l) return false;
  if (l.locked) return true;
  return window._uxGroupChain(l.groupId).some(g => _layerGroups[g] && _layerGroups[g].locked);
};

window._lockGuard = function(id, what) {
  const l = typeof id === 'object' ? id : mapLayers.find(x => x.id === id);
  if (!window._isLayerLocked(l)) return false;
  setSt(`«${l.name}» заблокирован — ${what || 'действие'} недоступно. Сними замок в панели слоёв`, 'err');
  return true;
};

window.toggleLayerLock = function(id) {
  const ids = (_selLayerIds.size > 1 && _selLayerIds.has(id)) ? [..._selLayerIds] : [id];
  const l0 = mapLayers.find(x => x.id === ids[0]);
  const to = !(l0 && l0.locked);
  ids.forEach(lid => { const l = mapLayers.find(x => x.id === lid); if (l) l.locked = to; });
  renderLayers();
  if (typeof markDirty === 'function') markDirty();
  setSt(to ? 'Заблокировано' : 'Разблокировано', 'ok');
};

window.toggleGroupLock = function(gid) {
  const g = _layerGroups[gid];
  if (!g) return;
  g.locked = !g.locked;
  renderLayers();
  if (typeof markDirty === 'function') markDirty();
  setSt(g.locked ? `Группа «${g.name}» заблокирована` : `Группа «${g.name}» разблокирована`, 'ok');
};

function _lpSyncLockRow(targets) {
  const btn = document.getElementById('lp-lock-btn');
  if (!btn) return;
  const locked = targets.length && targets.every(l => l.locked);
  btn.classList.toggle('active', !!locked);
  btn.title = locked ? 'Снять блокировку' : 'Заблокировать от правок и удаления';
}

window.lpToggleLock = function() {
  const targets = _propsTargets();
  if (!targets.length) return;
  const to = !targets.every(l => l.locked);
  targets.forEach(l => { l.locked = to; });
  renderLayers();
  const al = getActiveLayer();
  if (al) showLayerProps(al);
  setSt(to ? `Заблокировано слоёв: ${targets.length}` : `Разблокировано слоёв: ${targets.length}`, 'ok');
};

// ── Выделить все слои группы ────────────────────────────────────────────────
window.selectGroupLayers = function(gid) {
  const members = window._uxGroupLayers(gid);
  if (!members.length) { setSt('Группа пуста', 'err'); return; }
  _selLayerIds = new Set(members.map(l => l.id));
  _lastPickedLayerId = members[0].id;
  window._lpTouchedReset();
  selectLayer(members[0].id);
  setSt(`Выделено слоёв: ${members.length} — свойства применятся ко всем`, 'ok');
};

// ── Горячие клавиши панели слоёв ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = (e.target && e.target.tagName) || '';
  const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
  const mod = e.ctrlKey || e.metaKey;
  // Ввод текста перехватывает одиночные клавиши, но не сочетания с Ctrl.
  // Раньше выходили сразу, и самый обычный порядок работы — найти слои
  // поиском, выделить и нажать Ctrl+G — молча не срабатывал: фокус
  // оставался в поле поиска.
  if (typing && !mod) return;
  // Редактор PDF живёт со своим набором клавиш
  const pdfOpen = (document.getElementById('pdf-editor') || {}).style &&
                  document.getElementById('pdf-editor').style.display !== 'none';
  if (pdfOpen) return;

  // e.code — физическая клавиша, не зависит от раскладки (как и в обработчике
  // выше для Ctrl+Z/Y/S). e.key.toLowerCase()==='g' здесь раньше ловил
  // нажатие нестабильно: на русской раскладке значение e.key для Ctrl+буква
  // не всегда гарантированно остаётся латинским — отсюда «через раз».
  if (mod && e.code === 'KeyG') {
    e.preventDefault();
    if (e.shiftKey) {
      const al = getActiveLayer();
      if (al && al.groupId) window.ungroupLayers(al.groupId);
      else setSt('Активный слой не в группе', 'err');
    } else {
      if (_selLayerIds.size > 1) window.newLayerGroup();
      else setSt('Выдели несколько слоёв: клик, затем Ctrl+клик или Shift+клик', 'err');
    }
    return;
  }
  if (typing) return;   // дальше — одиночные клавиши, они принадлежат полю
  if (e.key === 'F4') { e.preventDefault(); window.toggleLayerPropsDock(); return; }
  if (e.key === 'Escape' && window._uxIsIsolated()) { window.clearIsolate(); return; }
});

// Восстановление режима панели при запуске
document.addEventListener('DOMContentLoaded', () => {
  _lpFloating = !!_lpStoreGet('lpFloating', false);
  if (_lpFloating) setTimeout(_lpApplyDock, 120);
});
