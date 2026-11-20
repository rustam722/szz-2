// ═══════════════════════════════════════════════
// PDF-EDITOR.JS — фотошоп-редактор поверх карты
// ═══════════════════════════════════════════════
//
// Архитектура:
//  • #pdf-editor — fullscreen overlay
//  • #pdf-canvas — A4 контейнер, масштабируется через CSS transform
//  • #pdf-map    — Leaflet карта ВНУТРИ canvas (не снаружи!)
//  • .ps-obj     — абсолютно позиционированные объекты поверх карты
//  • Drag/resize через PointerEvents (надёжнее чем mouse)
//  • Состояние сохраняется в localStorage
// ═══════════════════════════════════════════════

'use strict';

// ── Состояние ────────────────────────────────────
let pdfObjects   = [];   // массив объектов
let pdfSelId     = null; // id выбранного
let pdfTool      = 'select';
let pdfObjCnt    = 0;
// Ориентация листа: по умолчанию книжная; последний выбор запоминается
let pdfOrientation = (typeof Store !== 'undefined' ? Store.get('pdfUi_orientation', 'portrait') : 'portrait');
// Формат листа: A4 по умолчанию, можно переключить на A3 (вдвое больше
// площади — актуально для проектов с сотнями-тысячами объектов, когда на A4
// часть выносок физически некуда ставить)
let pdfFormat = (typeof Store !== 'undefined' ? Store.get('pdfUi_format', 'A4') : 'A4');
let pdfMap       = null; // отдельная карта внутри pdf-canvas
let _drawGhost   = null;
let _drawStart   = null;
let pdfMapSat    = false; // спутник/схема для pdf-карты
let pdfMapDrag   = false; // режим перемещения карты
let _pdfTile     = null;  // текущий тайловый слой pdf-карты
// Вид карты редактора текущего проекта: { lat, lon, zoom, sat }.
// pdfMap один на всё приложение, поэтому при переключении вкладок вид
// сохраняется в состояние вкладки и применяется обратно при возврате.
let _pdfSavedView = null;

// ── Настройки интерфейса редактора (не привязаны к проекту) ──────────────────
// Масштаб холста, сетка и привязки живут между сеансами: раньше сбрасывались
// при каждом входе в редактор.
const _UI_PREF = {
  get: (k, def) => (typeof Store !== 'undefined' ? Store.get('pdfUi_' + k, def) : def),
  set: (k, v)   => { if (typeof Store !== 'undefined') Store.set('pdfUi_' + k, v); },
};

// ── Snap / Align ──────────────────────────────────
let _snapGuides  = [];    // активные направляющие
let _snapEnabled = _UI_PREF.get('snapNodes', true);  // включён ли магнит
const SNAP_DIST  = 10;    // пикселей для притяжения

// ── Инсет-карты (лупа) ───────────────────────────
const _insetMaps = {};    // id → L.map

// ── Слои полигонов на pdf-карте ──────────────────
let _pdfGeoLayers    = [];   // [{ id, gl }] — GeoJSON-слои на pdfMap, id = id слоя из mapLayers
let _pdfSourceLayers = [];   // слои источников на pdfMap
let _pdfMpLayers     = [];   // слои расчётных точек на pdfMap

// ── Undo / Redo ───────────────────────────────────
let _undoStack   = [];
let _redoStack   = [];

// ── Copy / Paste ──────────────────────────────────
let _clipboard   = null;

// ── Canvas zoom ───────────────────────────────────
let _zoomMul     = _UI_PREF.get('zoomMul', 1.0);

// ── Grid ──────────────────────────────────────────
let _gridEnabled = _UI_PREF.get('grid', false);
let _gridSnap    = _UI_PREF.get('gridSnap', false);
const _gridSize  = 20;

// ── Панель слоёв — состояние секций ──────────────
let _plGeoExpanded = false;   // на сотнях слоёв развёрнутый список забивает панель
let _plObjExpanded = true;
let _plSrcExpanded = true;
// Свёрнутость групп источников по типу. Разворачиваем по умолчанию: на малых
// проектах так привычнее, а на больших группы схлопываются вручную.
let _plSrcGrp = { emission: true, noise: true, other: true };
let _plMpExpanded  = true;

// ── Path drawing ──────────────────────────────────
let _pathDraft    = null;   // { type, pts, freehand }
let _pathGhostSvg = null;   // SVG-превью пути

const CANVAS_W_L = 1123; // landscape, A4
const CANVAS_H_L = 794;
const CANVAS_W_P = 794;  // portrait, A4
const CANVAS_H_P = 1123;
// A3 — ровно в sqrt(2) раз крупнее A4 по каждой стороне (ISO 216: A3
// сложенный пополам даёт A4), тот же масштаб px/мм, что и у констант выше
const CANVAS_W_L_A3 = 1588; // landscape, A3
const CANVAS_H_L_A3 = 1123;
const CANVAS_W_P_A3 = 1123; // portrait, A3
const CANVAS_H_P_A3 = 1588;

// Размер холста для текущих ориентации+формата — единая точка правды вместо
// повторения "pdfOrientation==='landscape' ? CANVAS_W_L : CANVAS_W_P" по
// всему файлу (так эти места забывали бы про A3)
function _pdfCanvasSize() {
  const a3 = pdfFormat === 'A3';
  const land = pdfOrientation === 'landscape';
  if (land) return { W: a3 ? CANVAS_W_L_A3 : CANVAS_W_L, H: a3 ? CANVAS_H_L_A3 : CANVAS_H_L };
  return { W: a3 ? CANVAS_W_P_A3 : CANVAS_W_P, H: a3 ? CANVAS_H_P_A3 : CANVAS_H_P };
}
// Размер листа в мм для текущего формата (для jsPDF)
function _pdfPageMm() {
  const land = pdfOrientation === 'landscape';
  const a3 = pdfFormat === 'A3';
  const short = a3 ? 297 : 210, long = a3 ? 420 : 297;
  return { w: land ? long : short, h: land ? short : long };
}

// ── Вход/выход ───────────────────────────────────
function enterPdfMode() {
  const editor = document.getElementById('pdf-editor');
  editor.style.display = window.Workspace ? 'grid' : 'flex';
  if (window.Workspace) Workspace.enterPdf();

  // Строим интерфейс редактора
  _buildEditorUI();

  // Инициализируем карту внутри pdf-canvas (если ещё не создана)
  if (!pdfMap) _initPdfMap();
  else _refreshPdfMapLayers(); // При повторном открытии — обновить слои проекта

  // Обновляем счётчик ID чтобы новые объекты не конфликтовали с восстановленными
  pdfObjCnt = pdfObjects.reduce((m, o) => {
    const n = parseInt((o.id || '').replace('pobj_', '')) || 0;
    return Math.max(m, n + 1);
  }, pdfObjCnt);

  _buildToolbar();

  _renderAll();
  _renderLayersList();
  _renderProps();
  _applyGridState();   // сетка/привязка — из сохранённых настроек
  _applyPdfSections(); // свёрнутые секции правой панели
  _initCanvasZoomWheel();
  _initScrollbars();
  _initCanvasDrawing();
  _initPathDrawing();
  _initSidebarResize();
  { let _t = 'sheet'; try { _t = Store.get('pdfTab') || 'sheet'; } catch(e) {} window.pdfTab(_t, true); }
  _renderSheetBar();
  if (window._lpApplyDock)        window._lpApplyDock();   // у панели свойств своё место в редакторе
  if (window._initPdfMarquee)     window._initPdfMarquee();
  if (window._initPdfGroupBar)    window._initPdfGroupBar();
  if (window._pdfSyncEnteredClass) window._pdfSyncEnteredClass();

  // Применяем ориентацию после reflow — layout должен устояться
  requestAnimationFrame(() => {
    _applyOrientation();
    requestAnimationFrame(() => {
      _applyOrientation();
      if (pdfMap) {
        const c = pdfMap.getCenter(), z = pdfMap.getZoom();
        pdfMap.invalidateSize();
        pdfMap.setView(c, z, { animate: false });
      }
    });
  });

  setSt('Режим редактора PDF — выбирай объекты и настраивай', 'ok');
}

function exitPdfMode() {
  _saveState();
  document.getElementById('pdf-editor').style.display = 'none';
  if (window.Workspace) Workspace.exitPdf();
  // На карте у панели свойств своё место — возвращаем его
  if (window._lpApplyDock) window._lpApplyDock();
  setSt('Выход из редактора PDF', 'ok');
}

// ── Инициализация карты внутри pdf-canvas ────────
function _initPdfMap() {
  // Создаём div карты внутри #pdf-canvas
  const canvas = document.getElementById('pdf-canvas');
  const mapDiv = document.createElement('div');
  mapDiv.id = 'pdf-map';
  canvas.insertBefore(mapDiv, canvas.firstChild);

  // Вид проекта, если он был сохранён; иначе копируем центр/зум основной карты
  const center = _pdfSavedView ? L.latLng(_pdfSavedView.lat, _pdfSavedView.lon) : map.getCenter();
  const zoom   = _pdfSavedView ? _pdfSavedView.zoom : map.getZoom();

  pdfMap = L.map('pdf-map', {
    center, zoom,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    keyboard: false,
    attributionControl: false,
    zoomSnap: 0,
  });

  // Та же подложка что на основной карте
  // crossOrigin: 'anonymous' нужен чтобы html2canvas мог захватить тайлы без ошибки CORS
  pdfMapSat = _pdfSavedView && _pdfSavedView.sat !== undefined ? !!_pdfSavedView.sat : useSat;
  if (pdfMapSat) {
    _pdfTile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, crossOrigin: 'anonymous' });
  } else {
    _pdfTile = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, crossOrigin: 'anonymous' });
  }
  _pdfTile.addTo(pdfMap);

  // Слои проекта (полигоны + источники + РТ)
  _rebuildPdfProjectLayers();

  // Масштаб
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(pdfMap);

  // При изменении зума/позиции — обновляем объекты масштаба и привязанные полочки
  pdfMap.on('zoomend moveend', () => {
    setTimeout(() => {
      pdfObjects.filter(o => o.type === 'scale').forEach(obj => {
        const el = document.getElementById(obj.id);
        if (el) _renderObjContent(el, obj);
      });
      _updateAllSrcLeaderTails();
    }, 120);
  });
}

// ── Вид карты редактора: сохранение/восстановление по проектам ──────────────
// Снимок текущего вида (для _captureAppState)
window._pdfCaptureView = function() {
  if (!pdfMap) return _pdfSavedView;   // редактор ещё не открывали — отдаём что было
  try {
    const c = pdfMap.getCenter();
    return { lat: c.lat, lon: c.lng, zoom: pdfMap.getZoom(), sat: !!pdfMapSat };
  } catch(e) { return _pdfSavedView; }
};

// Применить вид проекта (для _restoreAppState). view == null → подогнать под слои проекта
window._pdfApplyView = function(view) {
  _pdfSavedView = view || null;
  if (!pdfMap) return;                 // применится при создании карты
  if (view) {
    if (view.sat !== undefined && !!view.sat !== !!pdfMapSat) togglePdfMapSat();
    try { pdfMap.setView([view.lat, view.lon], view.zoom, { animate: false }); } catch(e) {}
  } else {
    _pdfFitToProjectLayers();
  }
};

// Подогнать карту редактора под геометрию проекта (новый/ещё не позиционированный проект)
function _pdfFitToProjectLayers() {
  if (!pdfMap) return;
  const valid = (typeof mapLayers !== 'undefined' ? mapLayers : [])
    .filter(l => l.visible && l.layer && l.layer.getBounds);
  if (!valid.length) {
    try { pdfMap.setView(map.getCenter(), map.getZoom(), { animate: false }); } catch(e) {}
    return;
  }
  try {
    let bounds = valid[0].layer.getBounds();
    valid.slice(1).forEach(l => { try { bounds.extend(l.layer.getBounds()); } catch(e) {} });
    if (bounds && bounds.isValid()) {
      pdfMap.invalidateSize(false);
      pdfMap.fitBounds(bounds, { padding: [24, 24], animate: false });
    }
  } catch(e) {}
}

// ── Слои проекта на карте редактора ─────────────────────────────────────────
// Единая точка отрисовки: используется и при создании карты, и при обновлении.
// Раньше цикл копирования слоёв был продублирован в _initPdfMap и
// _refreshPdfMapLayers, и копии успели разойтись.

// Видимость слоя — своя у каждого листа (pdfSheets[i].layerVis), а не один
// общий l.visible на весь проект. Если для текущего листа переопределения
// нет — наследуем общий флаг (так старые проекты без layerVis продолжают
// работать как раньше). Это единая точка правды: через неё же проходят
// _layerTypeVisible (map.js, источники/авто-слои) и _mpVisiblePublic
// (monpoints.js, РТ) — поэтому растровый путь, вектор (pdf-vector.js уже
// читает _pdfGeoLayers/_layerTypeVisible/_mpVisiblePublic) и легенда
// становятся «по листовыми» одной правкой здесь, без изменений в них.
function _pdfSheetVisible(l) {
  const base = !!l && l.visible !== false;
  const sh = (typeof pdfSheets !== 'undefined') ? pdfSheets[pdfSheetIdx] : null;
  if (!sh || !sh.layerVis || !l) return base;
  const key = (typeof window.layerStableKey === 'function') ? window.layerStableKey(l) : null;
  if (key && Object.prototype.hasOwnProperty.call(sh.layerVis, key)) return sh.layerVis[key];
  return base;
}
window._pdfSheetVisiblePublic = _pdfSheetVisible;

const _pdfMpCalloutsLayer = { type: 'mp-callouts' };
const _pdfMpCalloutLayer = pt => ({ type: 'mp-callout:' + pt.id, visible: pt.pdfShowLabel === true });
window._pdfMpCalloutsVisible = () => _pdfSheetVisible(_pdfMpCalloutsLayer);
window._pdfMpCalloutVisible = pt => _pdfSheetVisible(_pdfMpCalloutLayer(pt));
window._pdfSetMpCallouts = (points, visible) => _pdfSetSheetLayersVis(points.map(_pdfMpCalloutLayer), visible);

// Записать видимость слоя для ТЕКУЩЕГО листа (не трогая общий l.visible) и
// перестроить карту редактора/панель под новое состояние.
window._pdfSetSheetVis = (layer, visible) => _pdfSetSheetLayersVis([layer], visible);
function _pdfSetSheetLayersVis(layers, visible) {
  if (!layers.length) return;
  _sheetsInit();
  const sh = pdfSheets[pdfSheetIdx];
  if (!sh) return;
  if (!sh.layerVis) sh.layerVis = {};
  layers.forEach(layer => {
    if (layer) sh.layerVis[window.layerStableKey(layer)] = !!visible;
  });
  if (typeof _rebuildPdfProjectLayers === 'function') _rebuildPdfProjectLayers();
  if (typeof _renderLayersList === 'function') _renderLayersList();
  if (typeof markDirty === 'function') markDirty();
}

// Слой панели слоёв, который рисуется на карте редактора как полигон?
function _pdfIsGeoLayer(l) {
  if (!l || !_pdfSheetVisible(l)) return false;
  if (l.type === 'monpoints' || l.type === 'mp-callouts') return false;
  if ((l.type || '').startsWith('src-')) return false;
  return !!(l.layer && l.layer.toGeoJSON);
}

// Добавить один слой панели на карту редактора; возвращает запись { id, gl }
// «Прозрачность» слоя — это CSS-непрозрачность на его элементах, а не опция
// Leaflet: в _psStyle её нет, поэтому в копию слоя для листа она не попадала
// и ползунок на редактор не влиял.
function _pdfApplyLayerOpacity(l, gl, cl) {
  const o = (l && l._psStyle && l._psStyle.layerOpacity);
  if (o == null || !isFinite(o)) return;
  const v = o === 1 ? '' : String(Math.max(0, Math.min(1, o)));
  const each = window._eachLayerPath;
  if (typeof each === 'function') each(gl, el => { el.style.opacity = v; });
  (cl || []).forEach(x => {
    const el = x && (x._el || x._container || x._path);
    if (el && el.style) el.style.opacity = v;
  });
}

function _pdfAddGeoLayer(l) {
  if (!pdfMap || !_pdfIsGeoLayer(l)) return null;
  try {
    const geo   = l.layer.toGeoJSON();
    const style = l._psStyle || { color: l.color, fillColor: l.color, fillOpacity: l.type === 'szz' ? 0.1 : 0.15, weight: 2 };
    const gl = L.geoJSON(geo, { style: () => style }).addTo(pdfMap);
    if (style.fillPattern && style.fillPattern !== 'solid' && typeof window._applyFillPattern === 'function') {
      const fp = style.fillPattern, fc = style.fillColor || style.color;
      requestAnimationFrame(() => gl.eachLayer(sub => window._applyFillPattern(sub, fc, fp)));
    }
    // Выноска слоя (ЗУ/СЗЗ) — тот же объект, что и на основной карте,
    // поэтому текст, стиль и положение полки везде одинаковые
    let cl = [];
    if (l.callout && l.callout.on && typeof _makeCalloutLayersGlobal === 'function') {
      try { cl = _makeCalloutLayersGlobal(l.callout, pdfMap, true) || []; } catch(e) { cl = []; }
    }
    _pdfApplyLayerOpacity(l, gl, cl);
    return { id: l.id, gl, cl };
  } catch(e) { return null; }
}

// Снять слой редактора вместе с его выноской
function _pdfRemoveGeoRec(rec) {
  if (!rec) return;
  try { pdfMap.removeLayer(rec.gl); } catch(e) {}
  (rec.cl || []).forEach(x => { try { pdfMap.removeLayer(x); } catch(e) {} });
}

// Порядок отрисовки: mapLayers[0] — верх панели — должен быть поверх остальных.
// Источники и РТ всегда над полигонами.
function _pdfRestackLayers() {
  if (!pdfMap) return;
  for (let i = mapLayers.length - 1; i >= 0; i--) {
    const rec = _pdfGeoLayers.find(r => r.id === mapLayers[i].id);
    if (rec && typeof rec.gl.bringToFront === 'function') { try { rec.gl.bringToFront(); } catch(e) {} }
  }
  // Держим массив в том же порядке, что и панель слоёв
  const idx = new Map(mapLayers.map((l, i) => [l.id, i]));
  _pdfGeoLayers.sort((a, b) => (idx.get(a.id) ?? 1e6) - (idx.get(b.id) ?? 1e6));
  [..._pdfSourceLayers, ..._pdfMpLayers].forEach(l => {
    if (l && typeof l.bringToFront === 'function') { try { l.bringToFront(); } catch(e) {} }
  });
}

// Перерисовать только источники (включая выноски)
function _pdfRebuildSources() {
  if (!pdfMap) return;
  _pdfSourceLayers.forEach(l => { try { pdfMap.removeLayer(l); } catch(e) {} });
  _pdfSourceLayers = typeof _addSourcesToPdfMap === 'function' ? _addSourcesToPdfMap(pdfMap) : [];
}

// Перерисовать только расчётные точки (включая выноски)
function _pdfRebuildMonPoints() {
  if (!pdfMap) return;
  _pdfMpLayers.forEach(l => { try { pdfMap.removeLayer(l); } catch(e) {} });
  _pdfMpLayers = typeof _addMonPointsToPdfMap === 'function' ? _addMonPointsToPdfMap(pdfMap) : [];
}

// Полная перестройка всех слоёв проекта (создание карты, смена проекта, реордер)
function _rebuildPdfProjectLayers() {
  if (!pdfMap) return;
  _pdfGeoLayers.forEach(_pdfRemoveGeoRec);
  _pdfGeoLayers = [];
  // От низа списка к верху — последний добавленный оказывается поверх
  for (let i = mapLayers.length - 1; i >= 0; i--) {
    const rec = _pdfAddGeoLayer(mapLayers[i]);
    if (rec) _pdfGeoLayers.unshift(rec);
  }
  _pdfRebuildSources();
  _pdfRebuildMonPoints();
  _insetSyncLayers();
}

// ── Обновить слои на pdf-карте (при смене проекта) ──
function _refreshPdfMapLayers() {
  if (!pdfMap) return;
  _rebuildPdfProjectLayers();
  // Позицию карты НЕ меняем — пользователь сам выставил нужный вид
  setTimeout(() => {
    if (!pdfMap) return;
    const c = pdfMap.getCenter(), z = pdfMap.getZoom();
    pdfMap.invalidateSize();
    pdfMap.setView(c, z, { animate: false });
  }, 150);
}

// Точечная реакция на переключение видимости одного слоя в панели.
// Полная перестройка карты редактора для этого не нужна.
window._pdfOnLayerToggled = function(l) {
  if (!pdfMap || !l) return;
  const t = l.type || '';
  _insetSyncLayers();          // фрагмент показывает ровно то же, что и лист
  if (t.startsWith('src-'))                        { _pdfRebuildSources();   return; }
  if (t === 'monpoints' || t === 'mp-callouts')    { _pdfRebuildMonPoints(); return; }
  const rec = _pdfGeoLayers.find(r => r.id === l.id);
  if (l.visible) {
    if (!rec) {
      const added = _pdfAddGeoLayer(l);
      if (added) { _pdfGeoLayers.push(added); _pdfRestackLayers(); }
    }
  } else if (rec) {
    _pdfRemoveGeoRec(rec);
    _pdfGeoLayers = _pdfGeoLayers.filter(r => r !== rec);
  }
};

// Стиль слоя изменили в панели — пересоздаём только этот слой на карте редактора
window._pdfOnLayerStyleChanged = function(l) {
  if (!pdfMap || !l) return;
  const t = l.type || '';
  _insetSyncLayers();
  if (t.startsWith('src-'))                     { _pdfRebuildSources();   return; }
  if (t === 'monpoints' || t === 'mp-callouts') { _pdfRebuildMonPoints(); return; }
  const rec = _pdfGeoLayers.find(r => r.id === l.id);
  if (rec) {
    _pdfRemoveGeoRec(rec);
    _pdfGeoLayers = _pdfGeoLayers.filter(r => r !== rec);
  }
  const added = _pdfAddGeoLayer(l);
  if (added) { _pdfGeoLayers.push(added); _pdfRestackLayers(); }
};

// Быстрое обновление fillOpacity без пересоздания слоёв (для toggleFills)
function _refreshPdfMapLayersWithOpacity() {
  if (!pdfMap || !_pdfGeoLayers.length) return;
  _pdfGeoLayers.forEach(({ id, gl }) => {
    const l = mapLayers.find(x => x.id === id);
    if (!l) return;
    const fo = l._tempFillOpacity ?? (l._psStyle?.fillOpacity ?? (l.type === 'szz' ? 0.1 : 0.15));
    try { gl.setStyle({ fillOpacity: fo }); } catch(e) {}
    _pdfApplyLayerOpacity(l, gl, null);
    // setStyle сбрасывает fill → восстанавливаем паттерн
    const style = l._psStyle;
    if (style?.fillPattern && style.fillPattern !== 'solid' && typeof window._applyFillPattern === 'function') {
      const fp = style.fillPattern, fc = style.fillColor || style.color;
      requestAnimationFrame(() => gl.eachLayer(sub => window._applyFillPattern(sub, fc, fp)));
    }
  });
}

// ═══════════════════════════════════════════════════
// ── ИНСТРУМЕНТЫ РИСОВАНИЯ ПУТИ ──────────────────
// ═══════════════════════════════════════════════════

// ── Вспомогательные функции пути ─────────────────
function _updatePathBBox(obj) {
  const pts = obj.data.pts || [];
  if (!pts.length) return;
  const pad = 24;
  let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
  pts.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); });
  obj.data.x = minX - pad;
  obj.data.y = minY - pad;
  obj.data.w = Math.max(maxX - minX + pad*2, 10);
  obj.data.h = Math.max(maxY - minY + pad*2, 10);
}

function _catmullToBezierLocal(pts, closed) {
  if (pts.length < 2) return '';
  const ext = closed
    ? [pts[pts.length-1], ...pts, pts[0], pts[1]]
    : [pts[0], ...pts, pts[pts.length-1]];
  let d = `M ${ext[1].x} ${ext[1].y}`;
  for (let i = 1; i < ext.length - 2; i++) {
    const p0=ext[i-1], p1=ext[i], p2=ext[i+1], p3=ext[i+2];
    const cp1x = p1.x + (p2.x-p0.x)/6, cp1y = p1.y + (p2.y-p0.y)/6;
    const cp2x = p2.x - (p3.x-p1.x)/6, cp2y = p2.y - (p3.y-p1.y)/6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x} ${p2.y}`;
  }
  if (closed) d += ' Z';
  return d;
}

// Алгоритм Ramer-Douglas-Peucker для упрощения фриханда
function _simplifyPath(pts, tolerance) {
  if (pts.length <= 2) return pts;
  function perpDist(pt, a, b) {
    const dx=b.x-a.x, dy=b.y-a.y, len=Math.sqrt(dx*dx+dy*dy)||1;
    return Math.abs(dx*(a.y-pt.y)-(a.x-pt.x)*dy)/len;
  }
  function rdp(points, s, e, eps) {
    let maxD=0, idx=0;
    for (let i=s+1;i<e;i++) { const d=perpDist(points[i],points[s],points[e]); if(d>maxD){maxD=d;idx=i;} }
    if (maxD>eps) return [...rdp(points,s,idx,eps), ...rdp(points,idx,e,eps)];
    return [points[e]];
  }
  return [pts[0], ...rdp(pts, 0, pts.length-1, tolerance)];
}

// ── Рендер SVG объектов ───────────────────────────
function _renderPathSvg(obj) {
  const d = obj.data;
  const pts = d.pts || [];
  if (pts.length < 2) return '<svg style="width:100%;height:100%"></svg>';
  const lx = d.x, ly = d.y;
  const localPts = pts.map(p => `${(p.x-lx).toFixed(1)},${(p.y-ly).toFixed(1)}`).join(' ');
  const fill = d.closed && d.bg && d.bg !== 'transparent' ? d.bg : 'none';
  const tag  = d.closed ? 'polygon' : 'polyline';
  return `<svg width="${d.w}" height="${d.h}" viewBox="0 0 ${d.w} ${d.h}" style="overflow:visible;display:block;pointer-events:none">
    <${tag} points="${localPts}" fill="${fill}" stroke="${d.strokeColor}" stroke-width="${d.strokeW}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function _renderBezierSvg(obj) {
  const d = obj.data;
  const pts = d.pts || [];
  if (pts.length < 2) return '<svg style="width:100%;height:100%"></svg>';
  const lx = d.x, ly = d.y;
  const localPts = pts.map(p => ({ x: p.x-lx, y: p.y-ly }));
  const pathD = _catmullToBezierLocal(localPts, d.closed);
  const fill  = d.closed && d.bg && d.bg !== 'transparent' ? d.bg : 'none';
  return `<svg width="${d.w}" height="${d.h}" viewBox="0 0 ${d.w} ${d.h}" style="overflow:visible;display:block;pointer-events:none">
    <path d="${pathD}" fill="${fill}" stroke="${d.strokeColor}" stroke-width="${d.strokeW}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function _renderCalloutHtml(obj) {
  const d = obj.data;
  // tx/ty — положение хвоста в локальных координатах объекта
  const tx = (d.tailX ?? 0) - d.x;
  const ty = (d.tailY ?? 0) - d.y;
  const w  = d.w, h = d.h;
  // Точка крепления хвоста к боксу (ближайший край)
  const ax = Math.max(10, Math.min(w-10, tx));
  const ay = Math.max(10, Math.min(h-10, ty));
  const nx = ty-ay, ny = -(tx-ax), len = Math.sqrt(nx*nx+ny*ny)||1, tw=10;
  const p1 = `${(ax+nx/len*tw/2).toFixed(1)},${(ay+ny/len*tw/2).toFixed(1)}`;
  const p2 = `${(ax-nx/len*tw/2).toFixed(1)},${(ay-ny/len*tw/2).toFixed(1)}`;
  const r  = d.radius||8;
  return `<div style="position:absolute;inset:0;pointer-events:none">
    <svg style="position:absolute;inset:0;overflow:visible;width:${w}px;height:${h}px;pointer-events:none">
      <polygon points="${p1} ${tx.toFixed(1)},${ty.toFixed(1)} ${p2}" fill="${d.bg}" stroke="${d.strokeColor}" stroke-width="${d.strokeW}" stroke-linejoin="round"/>
      <rect x="0" y="0" width="${w}" height="${h}" fill="${d.bg}" stroke="${d.strokeColor}" stroke-width="${d.strokeW}" rx="${r}"/>
    </svg>
    <div class="callout-text-inner" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:6px 12px;font-size:${d.fontSize}px;color:${d.color};font-family:${d.fontFamily};font-weight:${d.fontWeight};word-break:break-word;z-index:1;pointer-events:none;user-select:none">${escapeHtml(d.content)||'Выноска'}</div>
  </div>`;
}

// ── Выноска с полочкой (GIS-style leader) ────────
function _renderLeaderHtml(obj) {
  const d = obj.data;
  const w = d.w, h = d.h;
  const sw = d.strokeW || 1.5;
  const color = d.strokeColor || '#0f172a';
  const bg = (d.bg && d.bg !== 'transparent') ? d.bg : 'transparent';

  // Tail point in local coordinates (may be outside bbox)
  const tx = (d.tailX ?? d.x + w / 2) - d.x;
  const ty = (d.tailY ?? d.y + h + 60) - d.y;

  // Shelf sits at the BOTTOM edge of bbox
  const shelfY = h - sw;

  // Pick shelf anchor: end closest to tail
  const dLeft  = Math.hypot(tx - 0, ty - shelfY);
  const dRight = Math.hypot(tx - w, ty - shelfY);
  const anchorX = dLeft <= dRight ? 0 : w;

  // Direction from anchor to tail
  const ang = Math.atan2(ty - shelfY, tx - anchorX);
  const ahl = 9;
  // Filled arrowhead triangle
  const ax1x = (tx - ahl * Math.cos(ang - 0.38)).toFixed(1);
  const ax1y = (ty - ahl * Math.sin(ang - 0.38)).toFixed(1);
  const ax2x = (tx - ahl * Math.cos(ang + 0.38)).toFixed(1);
  const ax2y = (ty - ahl * Math.sin(ang + 0.38)).toFixed(1);

  const rad = d.radius || 0;
  const sty = d.leaderStyle || 0;
  const arrow = `<polygon points="${tx.toFixed(1)},${ty.toFixed(1)} ${ax1x},${ax1y} ${ax2x},${ax2y}" fill="${color}"/>`;
  const dot   = `<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="${(sw * 2.2).toFixed(1)}" fill="${color}"/>`;
  const leaderLine = `<line x1="${anchorX}" y1="${shelfY}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${color}" stroke-width="${sw}"/>`;
  const shelf = `<line x1="0" y1="${shelfY}" x2="${w}" y2="${shelfY}" stroke="${color}" stroke-width="${sw}"/>`;
  // Колено: от острия вертикально вверх, затем горизонтально к полочке
  const kneeY  = Math.min(ty, shelfY) - 0;
  const knee = `<polyline points="${tx.toFixed(1)},${ty.toFixed(1)} ${tx.toFixed(1)},${shelfY} ${anchorX},${shelfY}"
       fill="none" stroke="${color}" stroke-width="${sw}"/>`;

  // Варианты оформления выноски
  const shapes = [
    // 0 — полочка + наклонная линия + стрелка
    `${bg !== 'transparent' ? `<rect x="0" y="0" width="${w}" height="${shelfY}" fill="${bg}" rx="${rad}"/>` : ''}
     ${shelf}${leaderLine}${arrow}`,
    // 1 — полочка + линия с точкой на конце (ГОСТ-стиль)
    `${bg !== 'transparent' ? `<rect x="0" y="0" width="${w}" height="${shelfY}" fill="${bg}" rx="${rad}"/>` : ''}
     ${shelf}${leaderLine}${dot}`,
    // 2 — рамка вокруг текста + линия со стрелкой
    `<rect x="0" y="0" width="${w}" height="${shelfY}" fill="${bg !== 'transparent' ? bg : '#fff'}"
        stroke="${color}" stroke-width="${sw}" rx="${rad}"/>
     ${leaderLine}${arrow}`,
    // 3 — колено под прямым углом (как на монтажных схемах)
    `${bg !== 'transparent' ? `<rect x="0" y="0" width="${w}" height="${shelfY}" fill="${bg}" rx="${rad}"/>` : ''}
     ${shelf}${knee}${arrow}`,
    // 4 — без полочки: только линия к тексту
    `${bg !== 'transparent' ? `<rect x="0" y="0" width="${w}" height="${shelfY}" fill="${bg}" rx="${rad}"/>` : ''}
     ${leaderLine}${arrow}`,
    // 5 — «флажок»: полочка и заливка подписи цветом линии
    `<rect x="0" y="0" width="${w}" height="${shelfY}" fill="${color}" rx="${rad}"/>
     ${shelf}${leaderLine}${arrow}`,
  ];
  const inverted = sty === 5;
  return `<div style="position:absolute;inset:0;pointer-events:none;overflow:visible">
    <svg style="position:absolute;left:0;top:0;overflow:visible;pointer-events:none" width="${w}" height="${h}">
      ${shapes[sty] || shapes[0]}
    </svg>
    <div class="leader-text-inner" style="
      position:absolute;left:0;top:0;bottom:${sw + 2}px;
      width:max-content;white-space:nowrap;
      display:flex;align-items:flex-end;
      padding:3px 8px;
      font-size:${d.fontSize}px;color:${inverted ? '#ffffff' : d.color};
      font-family:${d.fontFamily};font-weight:${d.fontWeight};
      font-style:${d.fontStyle||'normal'};
      text-align:${d.textAlign||'left'};
      pointer-events:none;user-select:none;
      -webkit-text-stroke:${(d.textStrokeW>0)?`${d.textStrokeW}px ${d.textStrokeColor}`:'0'};
    ">${escapeHtml(d.content)||'Подпись объекта'}</div>
  </div>`;
}

window.applyLeaderStyle = function(s) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'leader') return;
  obj.data.leaderStyle = s;
  _renderObj(obj); _renderProps(); _saveState();
};

// ── Выноска источника — колено как отдельная точка, без рамки ──
function _syncSrcLeaderPos(obj) {
  const d = obj.data;
  if (d.kneeX === undefined || d.kneeY === undefined) return;
  const goRight = (d.tailX ?? d.kneeX) <= d.kneeX;
  const nx = Math.round(goRight ? d.kneeX : d.kneeX - d.w);
  const ny = Math.round(d.kneeY - d.h);
  if (d.x !== nx || d.y !== ny) {
    d.x = nx; d.y = ny;
    const el = document.getElementById(obj.id);
    if (el) { el.style.left = nx + 'px'; el.style.top = ny + 'px'; }
  }
}

function _renderSrcLeaderHtml(obj) {
  const d = obj.data;
  const sw = d.strokeW || 1.5;
  const color = d.strokeColor || '#333333';
  const bg = 'transparent'; // src-leader: always transparent background

  const kneeX = d.kneeX ?? d.x;
  const kneeY = d.kneeY ?? (d.y + d.h);
  const goRight = (d.tailX ?? kneeX) <= kneeX;

  // Local coordinates relative to bbox top-left (d.x, d.y)
  const kx = kneeX - d.x;            // = 0 (goRight) or d.w (goLeft)
  const ky = kneeY - d.y;            // = d.h
  const shelfEndX = goRight ? d.w : 0;
  const tx = (d.tailX ?? kneeX) - d.x;
  const ty = (d.tailY ?? kneeY + 60) - d.y;

  const justifyContent = goRight ? 'flex-start' : 'flex-end';
  const txtAlign = goRight ? 'left' : 'right';

  return `<div style="position:absolute;inset:0;pointer-events:none;overflow:visible">
    <svg style="position:absolute;left:0;top:0;overflow:visible;pointer-events:none" width="${d.w}" height="${d.h}">
      ${bg !== 'transparent' ? `<rect x="0" y="0" width="${d.w}" height="${Math.max(0,ky-sw)}" fill="${bg}" rx="${d.radius||0}"/>` : ''}
      <line x1="${kx}" y1="${ky.toFixed(1)}" x2="${shelfEndX}" y2="${ky.toFixed(1)}" stroke="${color}" stroke-width="${sw}"/>
      <line x1="${kx}" y1="${ky.toFixed(1)}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${color}" stroke-width="${sw}"/>
    </svg>
    <div class="leader-text-inner" style="
      position:absolute;left:0;top:0;bottom:${sw + 2}px;
      width:max-content;white-space:nowrap;
      display:flex;align-items:flex-end;justify-content:${justifyContent};
      padding:3px 4px;
      font-size:${d.fontSize}px;color:${d.color};
      font-family:${d.fontFamily};font-weight:${d.fontWeight};
      font-style:${d.fontStyle||'normal'};text-align:${txtAlign};
      pointer-events:auto;user-select:none;cursor:grab;
      -webkit-text-stroke:${(d.textStrokeW>0)?`${d.textStrokeW}px ${d.textStrokeColor}`:'0'};
    ">${escapeHtml(d.content)||'Источник'}</div>
  </div>`;
}

// ── Авто-подгон ширины полочки под текст ──────────
function _scheduleLeaderFit(el, obj) {
  requestAnimationFrame(() => {
    const textDiv = el.querySelector('.leader-text-inner');
    if (!textDiv) return;
    const textW = textDiv.offsetWidth;
    if (!textW || Math.abs(textW - obj.data.w) <= 2) return;
    obj.data.w = textW;
    el.style.width = textW + 'px';
    el.innerHTML = _renderLeaderHtml(obj);
    _updateHandles(el, obj);
  });
}
function _scheduleSrcLeaderFit(el, obj) {
  requestAnimationFrame(() => {
    const textDiv = el.querySelector('.leader-text-inner');
    if (!textDiv) return;
    const textW = textDiv.offsetWidth;
    if (!textW || Math.abs(textW - obj.data.w) <= 2) return;
    obj.data.w = textW;
    _syncSrcLeaderPos(obj);
    el.style.width = textW + 'px';
    el.innerHTML = _renderSrcLeaderHtml(obj);
    _updateHandles(el, obj);
  });
}

// ── Полочка-выноска, привязанная к источнику ──────

function _getSrcById(id) {
  return (typeof _sources !== 'undefined') ? _sources.find(s => s.id === id) : null;
}

function _getSrcCenterLatLon(src) {
  if (!src) return null;
  const anchor = _srcAnchor(src);
  return _validSourceCoords(anchor) ? { lat: anchor[0], lon: anchor[1] } : null;
}

function _getSrcBoundsOnCanvas(src) {
  if (!pdfMap || !_getSrcCenterLatLon(src)) return null;
  let pts = [];
  if (src.polygon && src.polygon.length) {
    pts = src.polygon.map(p => pdfMap.latLngToContainerPoint(L.latLng(p[0], p[1])));
  } else if (src.points && src.points.length) {
    pts = src.points.map(p => pdfMap.latLngToContainerPoint(L.latLng(p[0], p[1])));
  } else if (src.lat != null) {
    const cp = pdfMap.latLngToContainerPoint(L.latLng(src.lat, src.lon));
    pts = [cp];
  }
  if (!pts.length) return null;
  let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
  pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

function _getSrcLeaderTailPt(srcId, anchorType) {
  if (!pdfMap) return { x: 200, y: 300 };
  const src = _getSrcById(srcId);
  if (!src) return { x: 200, y: 300 };
  const b = _getSrcBoundsOnCanvas(src);
  if (!b) return { x: 200, y: 300 };
  const anchor = anchorType || 'center';
  const map = {
    center: [b.cx, b.cy],
    n:  [b.cx,    b.minY], s:  [b.cx,    b.maxY],
    w:  [b.minX,  b.cy],   e:  [b.maxX,  b.cy],
    nw: [b.minX,  b.minY], ne: [b.maxX,  b.minY],
    sw: [b.minX,  b.maxY], se: [b.maxX,  b.maxY],
  };
  const ex = map[anchor] || map.center;
  return { x: Math.round(ex[0]), y: Math.round(ex[1]) };
}

function _updateSrcLeaderTail(obj) {
  if (!obj.data.srcId) return;
  const pt = _getSrcLeaderTailPt(obj.data.srcId, obj.data.anchorType);
  obj.data.tailX = pt.x;
  obj.data.tailY = pt.y;
}

function _updateAllSrcLeaderTails() {
  if (!pdfMap) return;
  pdfObjects.filter(o => o.type === 'src-leader').forEach(obj => {
    _updateSrcLeaderTail(obj);
    const el = document.getElementById(obj.id);
    if (el) { _renderObjContent(el, obj); _updateHandles(el, obj); }
  });
}

function setSrcLeaderAnchor(anchorType) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'src-leader') return;
  obj.data.anchorType = anchorType;
  _updateSrcLeaderTail(obj);
  const el = document.getElementById(obj.id);
  if (el) { _renderObjContent(el, obj); _updateHandles(el, obj); }
  _renderProps();
  _saveState();
}

// ── Хендлы точек пути ─────────────────────────────
function _renderPathHandles(el, obj) {
  const pts = obj.data.pts || [];
  pts.forEach((pt, idx) => {
    const h = document.createElement('div');
    h.className = `ps-handle ps-path-pt${idx===0?' ps-path-first':''}`;
    h.style.left = (pt.x - obj.data.x - 6) + 'px';
    h.style.top  = (pt.y - obj.data.y - 6) + 'px';
    el.appendChild(h);
    h.addEventListener('pointerdown', e => _onPathPtDrag(e, obj, idx));
  });
  // Ручка поворота
  const rEl = document.createElement('div');
  rEl.className = 'ps-handle ps-rotate-handle';
  el.appendChild(rEl);
  rEl.addEventListener('pointerdown', e => _onRotateStart(e, obj));
}

function _onPathPtDrag(e, obj, idx) {
  e.stopPropagation(); e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);
  const canvas = document.getElementById('pdf-canvas');

  function onMove(ev) {
    const rect = canvas.getBoundingClientRect();
    let nx = (ev.clientX - rect.left) * (canvas.offsetWidth  / rect.width);
    let ny = (ev.clientY - rect.top)  * (canvas.offsetHeight / rect.height);
    if (_gridSnap) { nx = Math.round(nx/_gridSize)*_gridSize; ny = Math.round(ny/_gridSize)*_gridSize; }
    obj.data.pts[idx] = { x: Math.round(nx), y: Math.round(ny) };
    _updatePathBBox(obj);
    el.style.left = obj.data.x+'px'; el.style.top = obj.data.y+'px';
    el.style.width = obj.data.w+'px'; el.style.height = obj.data.h+'px';
    _renderObjContent(el, obj); _updateHandles(el, obj);
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

function _renderCalloutHandles(el, obj) {
  const h = document.createElement('div');
  h.className = 'ps-handle ps-callout-tail';
  h.style.left = ((obj.data.tailX||0) - obj.data.x - 8) + 'px';
  h.style.top  = ((obj.data.tailY||0) - obj.data.y - 8) + 'px';
  if (obj.type === 'src-leader') {
    h.style.background = '#f59e0b';
    h.style.border = '2px solid #92400e';
    h.title = 'Переместить якорь (обновится при сдвиге карты)';
  } else {
    h.title = 'Переместить острие выноски';
  }
  h.addEventListener('pointerdown', e => _onCalloutTailDrag(e, obj));
  el.appendChild(h);

  // Knee handle for src-leader — blue circle at the knee point
  if (obj.type === 'src-leader') {
    const d = obj.data;
    const kx = (d.kneeX ?? d.x) - d.x;
    const ky = (d.kneeY ?? (d.y + d.h)) - d.y;
    const kh = document.createElement('div');
    kh.className = 'ps-handle ps-knee-handle';
    kh.style.left = (kx - 8) + 'px';
    kh.style.top  = (ky - 8) + 'px';
    kh.style.background = '#60a5fa';
    kh.style.border = '2px solid #1d4ed8';
    kh.title = 'Переместить метку (колено)';
    kh.addEventListener('pointerdown', e => _onKneeDrag(e, obj));
    el.appendChild(kh);
  }
}

function _onKneeDrag(e, obj) {
  e.stopPropagation(); e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);
  const canvas = document.getElementById('pdf-canvas');
  const startX = e.clientX, startY = e.clientY;
  const ox  = obj.data.x,   oy  = obj.data.y;
  const okx = obj.data.kneeX ?? obj.data.x;
  const oky = obj.data.kneeY ?? (obj.data.y + obj.data.h);
  function onMove(ev) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    const dx = Math.round((ev.clientX - startX) * scaleX);
    const dy = Math.round((ev.clientY - startY) * scaleY);
    obj.data.x = ox + dx;  obj.data.y = oy + dy;
    obj.data.kneeX = okx + dx;  obj.data.kneeY = oky + dy;
    el.style.left = obj.data.x + 'px';
    el.style.top  = obj.data.y + 'px';
    _renderObjContent(el, obj);
    _updateHandles(el, obj);
    _syncPropsXY();
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

function _onCalloutTailDrag(e, obj) {
  e.stopPropagation(); e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);
  const canvas = document.getElementById('pdf-canvas');
  const startX = e.clientX, startY = e.clientY;
  const otailX = obj.data.tailX ?? 0;
  const otailY = obj.data.tailY ?? 0;

  function onMove(ev) {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth  / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    let dcx = (ev.clientX - startX) * scaleX;
    let dcy = (ev.clientY - startY) * scaleY;
    const rot = (obj.data.rotation || 0) * Math.PI / 180;
    if (rot) {
      const cosr = Math.cos(-rot), sinr = Math.sin(-rot);
      const rdcx = dcx * cosr - dcy * sinr;
      const rdcy = dcx * sinr + dcy * cosr;
      dcx = rdcx; dcy = rdcy;
    }
    obj.data.tailX = Math.round(otailX + dcx);
    obj.data.tailY = Math.round(otailY + dcy);
    _renderObjContent(el, obj); _updateHandles(el, obj);
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

// ── Ghost-превью пути ─────────────────────────────
function _showPathGhost() {
  const canvas = document.getElementById('pdf-canvas');
  if (document.getElementById('path-ghost-svg')) return;
  _pathGhostSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  _pathGhostSvg.id = 'path-ghost-svg';
  _pathGhostSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5000;overflow:visible';
  canvas.appendChild(_pathGhostSvg);
}

function _updatePathGhost(curX, curY) {
  if (!_pathGhostSvg || !_pathDraft) return;
  const pts   = [...(_pathDraft.pts||[]), { x:curX, y:curY }];
  const color = ({ bezier:'#8b5cf6', 'polygon-shape':'#22c55e', callout:'#f59e0b', leader:'#f59e0b' })[pdfTool] || '#3b82f6';

  let lineEl = '';
  if (pdfTool === 'bezier' && pts.length >= 2) {
    lineEl = `<path d="${_catmullToBezierLocal(pts,false)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="6,3" stroke-linecap="round"/>`;
  } else if ((pdfTool === 'callout' || pdfTool === 'leader' || pdfTool === 'arrow') && _pathDraft.pts.length === 1) {
    const t = _pathDraft.pts[0];
    lineEl = `<line x1="${t.x}" y1="${t.y}" x2="${curX}" y2="${curY}" stroke="${color}" stroke-width="2" stroke-dasharray="6,3"/>
              <circle cx="${t.x}" cy="${t.y}" r="5" fill="${color}"/>`;
  } else {
    const pStr = pts.map(p=>`${p.x},${p.y}`).join(' ');
    lineEl = `<polyline points="${pStr}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="6,3" stroke-linecap="round"/>`;
  }

  // Карандаш — свободное рисование: точки не показываем, они только мешают.
  // У пера/безье/многоугольника точки нужны — по ним кликают и замыкают контур.
  const dots = _pathDraft.freehand ? '' : (_pathDraft.pts||[]).map((p,i) =>
    `<circle cx="${p.x}" cy="${p.y}" r="${i===0?7:4}" fill="${i===0?'#22c55e':color}" stroke="white" stroke-width="2"/>`
  ).join('');

  _pathGhostSvg.innerHTML = lineEl + dots;
}

function _clearPathGhost() {
  if (_pathGhostSvg) { _pathGhostSvg.remove(); _pathGhostSvg = null; }
  _pathDraft = null;
}

function _finishPath(closed) {
  if (!_pathDraft || (_pathDraft.pts||[]).length < 2) { _clearPathGhost(); return; }
  let pts = _pathDraft.pts;
  if (_pathDraft.freehand) pts = _simplifyPath(pts, 4);

  // Карандаш отдаём в bezier: линия проходит сглаженной кривой, а не «острыми» углами
  const type = _pathDraft.type === 'polygon-shape' ? 'path'
             : _pathDraft.type === 'freehand'      ? 'bezier'
             : _pathDraft.type;
  const isClosed = closed || _pathDraft.type === 'polygon-shape';
  const color = ({ bezier:'#8b5cf6', path:'#3b82f6' })[type] || '#3b82f6';
  const fill  = isClosed ? hexToRgba(color, 0.12) : 'transparent';

  const pad=24;
  let minX=pts[0].x, maxX=pts[0].x, minY=pts[0].y, maxY=pts[0].y;
  pts.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});

  _clearPathGhost();
  _pushUndo();
  createPdfObj(type, {
    pts, closed:isClosed,
    x:minX-pad, y:minY-pad, w:Math.max(maxX-minX+pad*2,10), h:Math.max(maxY-minY+pad*2,10),
    strokeColor:color, bg:fill,
    content: '__' + type + '__',
    name: isClosed ? 'Фигура' : type==='bezier' ? 'Кривая' : 'Путь',
  });
  setPdfTool('select');
}

// ── Инициализация рисования пути в canvas ─────────
function _initPathDrawing() {
  const canvas = document.getElementById('pdf-canvas');
  // Защита от повторной привязки при каждом enterPdfMode()
  if (canvas._pathDrawingBound) return;
  canvas._pathDrawingBound = true;
  // leader тоже ставится кликами (остриё → подпись), а не протяжкой
  const PATH_TOOLS = ['path','bezier','polygon-shape','freehand','callout','leader','arrow'];

  // Клик — добавить точку (только для не-фриханд)
  canvas.addEventListener('click', e => {
    if (!PATH_TOOLS.includes(pdfTool) || pdfTool==='freehand') return;
    if (e.target.closest('.ps-obj') && !e.target.closest('#path-ghost-svg')) return;
    const rect  = canvas.getBoundingClientRect();
    const sx    = canvas.offsetWidth/rect.width, sy = canvas.offsetHeight/rect.height;
    const x = Math.round((e.clientX-rect.left)*sx);
    const y = Math.round((e.clientY-rect.top)*sy);

    // Стрелка: 1-й клик — начало, 2-й — конец (направление задаётся кликами)
    if (pdfTool === 'arrow') {
      if (!_pathDraft) {
        _pathDraft = { type:'arrow', pts:[{x,y}] };
        _showPathGhost();
        setSt('Теперь кликните, куда должна указывать стрелка', 'ok');
      } else {
        const a = _pathDraft.pts[0];
        _clearPathGhost();
        _pushUndo();
        const o = createPdfObj('arrow', { ax1: a.x, ay1: a.y, ax2: x, ay2: y, rotation: 0, name: 'Стрелка' });
        _arrowSyncBox(o);
        _renderObj(o);
        setPdfTool('select');
      }
      return;
    }

    // Выноска-облако и выноска с полочкой: 1-й клик — остриё, 2-й — подпись
    if (pdfTool === 'callout' || pdfTool === 'leader') {
      const tool = pdfTool;
      if (!_pathDraft) {
        _pathDraft = { type: tool, pts:[{x,y}] };
        _showPathGhost();
        setSt('Теперь кликните, где поставить подпись', 'ok');
      } else {
        const tailPt = _pathDraft.pts[0];
        _clearPathGhost();
        _pushUndo();
        if (tool === 'callout') {
          createPdfObj('callout', { tailX:tailPt.x, tailY:tailPt.y, x:x-80, y:y-28, w:160, h:56, name:'Выноска' });
        } else {
          // Подпись встаёт там, где кликнули: полочка по низу блока
          const bw = 170, bh = 46;
          createPdfObj('leader', {
            x: Math.round(x - bw / 2), y: Math.round(y - bh / 2), w: bw, h: bh,
            tailX: tailPt.x, tailY: tailPt.y, name: 'Выноска-полочка',
          });
        }
        setPdfTool('select');
      }
      return;
    }

    if (!_pathDraft) {
      _pathDraft = { type:pdfTool, pts:[{x,y}] };
      _showPathGhost();
    } else {
      // Кликнули рядом с первой точкой → замкнуть (polygon-shape)
      const fp = _pathDraft.pts[0];
      if (['polygon-shape'].includes(pdfTool) && _pathDraft.pts.length >= 3
          && Math.hypot(x-fp.x, y-fp.y) < 18) {
        _finishPath(true); return;
      }
      _pathDraft.pts.push({x,y});
      _updatePathGhost(x, y);
    }
  });

  // Двойной клик — завершить путь
  canvas.addEventListener('dblclick', e => {
    if (!PATH_TOOLS.includes(pdfTool) || pdfTool==='freehand' || pdfTool==='callout') return;
    if (!_pathDraft || _pathDraft.pts.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    // Двойной клик добавляет дублирующую точку через одиночный click — удаляем её
    if (_pathDraft.pts.length >= 2) _pathDraft.pts.pop();
    _finishPath(pdfTool === 'polygon-shape');
  });

  // Правый клик — завершить путь (привычно по CAD/иллюстраторам)
  canvas.addEventListener('contextmenu', e => {
    if (!_pathDraft || _pathDraft.freehand) return;
    e.preventDefault();
    e.stopPropagation();
    if (_pathDraft.pts.length >= 2) _finishPath(pdfTool === 'polygon-shape');
    else _clearPathGhost();
  });

  // Движение мыши — ghost
  canvas.addEventListener('pointermove', e => {
    if (!_pathDraft || _pathDraft.freehand) return;
    const rect = canvas.getBoundingClientRect();
    _updatePathGhost(
      (e.clientX-rect.left)*(canvas.offsetWidth/rect.width),
      (e.clientY-rect.top) *(canvas.offsetHeight/rect.height)
    );
  });
}

// ═══════════════════════════════════════════════════
// ── ПОВОРОТ ОБЪЕКТА ──────────────────────────────
// ═══════════════════════════════════════════════════

// ── Поворот объекта ───────────────────────────────
function _onRotateStart(e, obj) {
  e.stopPropagation();
  e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);

  function getCenterPage() {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const c0 = getCenterPage();
  const a0 = Math.atan2(e.clientY - c0.y, e.clientX - c0.x) * 180 / Math.PI;
  const r0 = obj.data.rotation || 0;

  function onMove(ev) {
    const c = getCenterPage();
    const a = Math.atan2(ev.clientY - c.y, ev.clientX - c.x) * 180 / Math.PI;
    let nr = r0 + a - a0;
    if (ev.shiftKey) nr = Math.round(nr / 15) * 15;
    const delta = (Math.round(nr * 10) / 10) - (obj.data.rotation || 0);
    obj.data.rotation = Math.round(nr * 10) / 10;
    el.style.transform = `rotate(${obj.data.rotation}deg)`;
    // Группу крутим целиком — каждый объект на тот же угол
    _groupMembers(obj).forEach(o => {
      if (o.id === obj.id) return;
      o.data.rotation = Math.round(((o.data.rotation || 0) + delta) * 10) / 10;
      const oe = document.getElementById(o.id);
      if (oe) oe.style.transform = `rotate(${o.data.rotation}deg)`;
    });
    const ri = document.getElementById('pp-rotation');
    if (ri) ri.value = obj.data.rotation;
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

// ── Множественное выделение и группы ────────────────────────────────────────
// Shift+клик добавляет объект к выделению, Ctrl+G объединяет в группу:
// группа двигается, поворачивается и удаляется целиком.
let _pdfMultiSel = new Set();

function _groupMembers(obj) {
  if (!obj) return [];
  // Вошли в группу — двигаем только сам объект, как в Illustrator
  if (window._pdfInEnteredGroup && window._pdfInEnteredGroup(obj)) return [obj];
  if (obj.groupId) return pdfObjects.filter(o => o.groupId === obj.groupId);
  if (_pdfMultiSel.has(obj.id)) return pdfObjects.filter(o => _pdfMultiSel.has(o.id));
  return [obj];
}

function _paintSelection() {
  pdfObjects.forEach(o => {
    const el = document.getElementById(o.id);
    if (el) el.classList.toggle('ps-multi', _pdfMultiSel.has(o.id) && o.id !== pdfSelId);
  });
  if (window.Workspace) Workspace.pdfSelectionChanged();
}

window.togglePdfMultiSel = function(id) {
  if (_pdfMultiSel.has(id)) _pdfMultiSel.delete(id);
  else _pdfMultiSel.add(id);
  _paintSelection();
  setSt(`Выделено объектов: ${_pdfMultiSel.size + (pdfSelId && !_pdfMultiSel.has(pdfSelId) ? 1 : 0)}`, 'ok');
};

window.groupPdfObjects = function() {
  const ids = new Set(_pdfMultiSel);
  if (pdfSelId) ids.add(pdfSelId);
  if (ids.size < 2) { setSt('Выделите 2+ объекта: Shift+клик', 'err'); return; }
  _pushUndo();
  // Уникальный id: Date.now() в одну миллисекунду давал одинаковые группы
  const gid = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  pdfObjects.filter(o => ids.has(o.id)).forEach(o => { o.groupId = gid; });
  // Группу заводим в списке сразу — с именем по содержимому, а не «Группа 4»
  if (window._pdfRegisterGroup) window._pdfRegisterGroup(gid);
  _pdfMultiSel.clear(); _paintSelection();
  _renderLayersList(); _saveState();
  setSt(`Сгруппировано объектов: ${ids.size}`, 'ok');
};

window.ungroupPdfObjects = function() {
  // Берём группу активного объекта, а если он не в группе — любую из выделения
  let obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || !obj.groupId) {
    obj = pdfObjects.find(o => o.groupId && _pdfMultiSel.has(o.id)) || null;
  }
  if (!obj || !obj.groupId) { setSt('Объект не в группе', 'err'); return; }
  _pushUndo();
  const gid = obj.groupId;
  const n = pdfObjects.filter(o => o.groupId === gid).length;
  pdfObjects.forEach(o => { if (o.groupId === gid) delete o.groupId; });
  if (window._pdfForgetGroup) window._pdfForgetGroup(gid);
  _renderLayersList(); _saveState();
  setSt(`Группа разобрана (${n} объектов)`, 'ok');
};

// Сдвинуть объект на dx/dy (используется при перетаскивании группы)
function _moveObjBy(o, dx, dy, base) {
  const b = base[o.id];
  if (!b) return;
  o.data.x = b.x + dx;
  o.data.y = b.y + dy;
  if (b.pts) o.data.pts = b.pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
  if (b.tailX !== undefined && o.type !== 'src-leader') { o.data.tailX = b.tailX + dx; o.data.tailY = b.tailY + dy; }
  if (o.type === 'src-leader' && b.kneeX !== undefined) {
    o.data.kneeX = b.kneeX + dx; o.data.kneeY = b.kneeY + dy;
    _syncSrcLeaderPos(o);
  }
  const el = document.getElementById(o.id);
  if (el) {
    el.style.left = o.data.x + 'px';
    el.style.top  = o.data.y + 'px';
    if (['path','bezier','callout','src-leader'].includes(o.type)) { _renderObjContent(el, o); _updateHandles(el, o); }
  }
}

// ── Copy / Paste ──────────────────────────────────
function copyPdfObj() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  _clipboard = { type: obj.type, name: obj.name, data: JSON.parse(JSON.stringify(obj.data)) };
  setSt('Скопировано ✓', 'ok');
}

function pastePdfObj() {
  if (!_clipboard) { setSt('Буфер пуст', 'err'); return; }
  _pushUndo();
  createPdfObj(_clipboard.type, {
    ..._clipboard.data,
    x: (_clipboard.data.x || 0) + 24,
    y: (_clipboard.data.y || 0) + 24,
    name: _clipboard.name,
  });
  setSt('Вставлено ✓', 'ok');
}

// ── Canvas zoom / панорамирование ─────────────────
// Смещение листа внутри области просмотра (как рука в фотошопе)
let _panX = 0, _panY = 0;

function _applyPan() {
  const canvas = document.getElementById('pdf-canvas');
  if (canvas) canvas.style.translate = `${_panX}px ${_panY}px`;
  _syncScrollbars();
}

// ── Полосы прокрутки листа ──────────────────────────────────────────────────
// Обычные скроллбары тут не работают: лист масштабируется через transform и
// layout-размер не меняется. Рисуем свои — по горизонтали и вертикали.
function _sheetMetrics() {
  const wrap = document.getElementById('pdf-canvas-wrap');
  const canvas = document.getElementById('pdf-canvas');
  if (!wrap || !canvas) return null;
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  const m = (canvas.style.transform || '').match(/scale\(([\d.]+)\)/);
  const sc = m ? parseFloat(m[1]) : 1;
  return { wrap, vw: wrap.clientWidth, vh: wrap.clientHeight, sw: W * sc, sh: H * sc };
}

function _initScrollbars() {
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (!wrap || wrap._sbBound) return;
  wrap._sbBound = true;
  ['h', 'v'].forEach(axis => {
    const bar = document.createElement('div');
    bar.className = 'pdf-sb pdf-sb-' + axis + ' no-export';
    bar.id = 'pdf-sb-' + axis;
    const thumb = document.createElement('div');
    thumb.className = 'pdf-sb-thumb';
    bar.appendChild(thumb);
    wrap.appendChild(bar);

    let dragging = false, start = 0, pan0 = 0;
    thumb.addEventListener('pointerdown', e => {
      dragging = true;
      start = axis === 'h' ? e.clientX : e.clientY;
      pan0  = axis === 'h' ? _panX : _panY;
      thumb.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    });
    thumb.addEventListener('pointermove', e => {
      if (!dragging) return;
      const mt = _sheetMetrics();
      if (!mt) return;
      const view = axis === 'h' ? mt.vw : mt.vh;
      const total = axis === 'h' ? mt.sw : mt.sh;
      const d = (axis === 'h' ? e.clientX : e.clientY) - start;
      // Сдвиг ползунка → сдвиг листа в обратную сторону, с учётом масштаба полосы
      const k = total / view;
      if (axis === 'h') _panX = pan0 - d * k; else _panY = pan0 - d * k;
      _clampPan();
      _applyPan();
    });
    const stop = () => { dragging = false; };
    thumb.addEventListener('pointerup', stop);
    thumb.addEventListener('pointercancel', stop);
    // Клик по дорожке — перелистнуть на экран
    bar.addEventListener('pointerdown', e => {
      if (e.target !== bar) return;
      const mt = _sheetMetrics(); if (!mt) return;
      const view = axis === 'h' ? mt.vw : mt.vh;
      const pos  = axis === 'h' ? e.offsetX / bar.clientWidth : e.offsetY / bar.clientHeight;
      const cur  = axis === 'h' ? _panX : _panY;
      const dir  = pos > 0.5 + (cur / (axis === 'h' ? mt.sw : mt.sh)) ? -1 : 1;
      if (axis === 'h') _panX += dir * view * 0.8; else _panY += dir * view * 0.8;
      _clampPan(); _applyPan();
    });
  });
  _syncScrollbars();
}

// Не даём утащить лист совсем из вида
function _clampPan() {
  const mt = _sheetMetrics();
  if (!mt) return;
  // Оставляем запас в треть экрана: иначе на среднем зуме сдвиг «съедался»
  // и приближение выглядело как зум строго в центр листа
  const maxX = Math.max(0, (mt.sw - mt.vw) / 2) + mt.vw * 0.35;
  const maxY = Math.max(0, (mt.sh - mt.vh) / 2) + mt.vh * 0.35;
  _panX = Math.max(-maxX, Math.min(maxX, _panX));
  _panY = Math.max(-maxY, Math.min(maxY, _panY));
}

function _syncScrollbars() {
  const mt = _sheetMetrics();
  if (!mt) return;
  [['h', mt.vw, mt.sw, _panX], ['v', mt.vh, mt.sh, _panY]].forEach(([axis, view, total, pan]) => {
    const bar = document.getElementById('pdf-sb-' + axis);
    if (!bar) return;
    const thumb = bar.firstChild;
    if (total <= view + 1) { bar.style.display = 'none'; return; }   // лист влезает целиком
    bar.style.display = 'block';
    const ratio = view / total;
    const len = Math.max(28, (axis === 'h' ? bar.clientWidth : bar.clientHeight) * ratio);
    const track = (axis === 'h' ? bar.clientWidth : bar.clientHeight) - len;
    // pan=0 — лист по центру, значит ползунок посередине дорожки
    const off = track / 2 - pan * ratio;
    const pos = Math.max(0, Math.min(track, off));
    if (axis === 'h') { thumb.style.width = len + 'px'; thumb.style.left = pos + 'px'; }
    else              { thumb.style.height = len + 'px'; thumb.style.top  = pos + 'px'; }
  });
}

window.resetCanvasPan = function() {
  _panX = 0; _panY = 0; _applyPan();
};

function zoomCanvas(delta, anchor) {
  const prev = _zoomMul;
  _zoomMul = Math.max(0.25, Math.min(6, _zoomMul + delta));
  if (_zoomMul === prev) return;
  // Зум «к курсору»: точка под мышью остаётся на месте
  if (anchor) {
    const wrap = document.getElementById('pdf-canvas-wrap');
    const r = wrap.getBoundingClientRect();
    const cxw = anchor.x - (r.left + r.width  / 2) - _panX;
    const cyw = anchor.y - (r.top  + r.height / 2) - _panY;
    const k = _zoomMul / prev;
    _panX -= cxw * (k - 1);
    _panY -= cyw * (k - 1);
  }
  _UI_PREF.set('zoomMul', _zoomMul);
  _applyOrientation();
  _clampPan();
  _applyPan();
  _syncZoomPct();
  if (pdfMap) setTimeout(() => {
    const c = pdfMap.getCenter(), z = pdfMap.getZoom();
    pdfMap.invalidateSize();
    pdfMap.setView(c, z, { animate: false });
  }, 300);
  Object.values(_insetMaps).forEach(m => setTimeout(() => {
    try { const c = m.getCenter(), z = m.getZoom(); m.invalidateSize(); m.setView(c, z, { animate: false }); } catch(e){}
  }, 300));
}

function _initCanvasZoomWheel() {
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (wrap._zoomWheelBound) return;
  wrap._zoomWheelBound = true;

  wrap.addEventListener('wheel', e => {
    // Вставки-лупы (inset) имеют собственный Leaflet-зум — не перехватываем
    if (e.target.closest('.inset-leaflet')) return;
    e.preventDefault();
    // Ctrl + колесо — плавный зум САМОЙ КАРТЫ (лист не трогаем)
    if ((e.ctrlKey || e.metaKey) && pdfMap) {
      const step = e.shiftKey ? 0.05 : 0.2;
      const z = pdfMap.getZoom() + (e.deltaY < 0 ? step : -step);
      pdfMap.setZoom(Math.max(1, Math.min(19, z)), { animate: false });
      pdfObjects.filter(o => o.type === 'scale').forEach(o => _renderObj(o));
      return;
    }
    // Обычное колесо — зум листа к точке под курсором
    const step = e.shiftKey ? 0.04 : (e.altKey ? 0.03 : 0.12);
    zoomCanvas(e.deltaY < 0 ? step : -step, { x: e.clientX, y: e.clientY });
  }, { passive: false });

  // Панорамирование листа: средняя кнопка, пробел + ЛКМ или ЛКМ по пустому фону
  if (!wrap._panBound) {
    wrap._panBound = true;
    let panning = false, sx = 0, sy = 0, ox = 0, oy = 0;
    wrap.addEventListener('pointerdown', e => {
      const onEmpty = e.target === wrap;                 // вне листа
      if (!(e.button === 1 || _spaceDown || onEmpty)) return;
      panning = true; sx = e.clientX; sy = e.clientY; ox = _panX; oy = _panY;
      wrap.setPointerCapture(e.pointerId);
      wrap.style.cursor = 'grabbing';
      e.preventDefault();
    });
    wrap.addEventListener('pointermove', e => {
      if (!panning) return;
      _panX = ox + (e.clientX - sx);
      _panY = oy + (e.clientY - sy);
      _clampPan();
      _applyPan();
    });
    const stop = () => { panning = false; wrap.style.cursor = _spaceDown ? 'grab' : ''; };
    wrap.addEventListener('pointerup', stop);
    wrap.addEventListener('pointercancel', stop);
  }
}

// Пробел — временный режим «рука», как в фотошопе
let _spaceDown = false;
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  const ed = document.getElementById('pdf-editor');
  if (!ed || ed.style.display === 'none') return;
  const t = e.target;
  if (t && (t.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(t.tagName))) return;
  e.preventDefault();
  _spaceDown = true;
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (wrap) wrap.style.cursor = 'grab';
});
document.addEventListener('keyup', e => {
  if (e.code !== 'Space') return;
  _spaceDown = false;
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (wrap) wrap.style.cursor = '';
});

// ── Секции правой панели: сворачиваются, состояние запоминается ────────────
window.togglePdfSection = function(which) {
  const el = document.getElementById(which === 'toolbar' ? 'pdf-toolbar' : 'pdf-props-panel');
  const ar = document.getElementById('pdf-sec-arrow-' + which);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : '';
  if (ar) ar.textContent = open ? '▸' : '▾';
  _UI_PREF.set('sec_' + which, !open);
};

function _applyPdfSections() {
  ['toolbar', 'props'].forEach(which => {
    const open = _UI_PREF.get('sec_' + which, true);
    const el = document.getElementById(which === 'toolbar' ? 'pdf-toolbar' : 'pdf-props-panel');
    const ar = document.getElementById('pdf-sec-arrow-' + which);
    if (el) el.style.display = open ? '' : 'none';
    if (ar) ar.textContent = open ? '▾' : '▸';
  });
}

// ── Ресайз панели инструментов ────────────────────
function _initSidebarResize() {
  const handle  = document.getElementById('pdf-resize-handle');
  const sidebar = document.getElementById('pdf-sidebar');
  if (!handle || !sidebar) return;
  if (handle._workspaceResize) return;
  if (handle._resizeBound) return;
  handle._resizeBound = true;

  // Вертикальный ресайз высоты панели слоёв
  const vHandle    = document.getElementById('pdf-layers-resize');
  const propsPanel = document.getElementById('pdf-props-panel');
  if (vHandle && propsPanel && !vHandle._resizeBound) {
    vHandle._resizeBound = true;
    let startY = 0, startH = 0;
    vHandle.addEventListener('pointerdown', e => {
      e.preventDefault();
      vHandle.setPointerCapture(e.pointerId);
      vHandle.classList.add('dragging');
      startY = e.clientY;
      startH = propsPanel.offsetHeight;
      function onMove(ev) {
        const newH = Math.max(0, Math.min(500, startH + ev.clientY - startY));
        propsPanel.style.maxHeight = newH + 'px';
      }
      function onUp() {
        vHandle.classList.remove('dragging');
        vHandle.removeEventListener('pointermove', onMove);
        vHandle.removeEventListener('pointerup', onUp);
      }
      vHandle.addEventListener('pointermove', onMove);
      vHandle.addEventListener('pointerup', onUp);
    });
  }

  let startX = 0, startW = 0;

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    startX = e.clientX;
    startW = sidebar.offsetWidth;

    function onMove(ev) {
      // Тянем влево → панель шире; вправо → уже
      const delta = startX - ev.clientX;
      const newW  = Math.max(180, Math.min(600, startW + delta));
      sidebar.style.width = newW + 'px';
      // Перерисовать масштаб холста
      _applyOrientation();
      if (pdfMap) pdfMap.invalidateSize();
    }
    function onUp() {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      // Финальный пересчёт
      setTimeout(() => {
        _applyOrientation();
        if (pdfMap) pdfMap.invalidateSize();
        Object.values(_insetMaps).forEach(m => m.invalidateSize());
      }, 50);
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// ── Grid ──────────────────────────────────────────
// Отрисовка сетки по текущему _gridEnabled (вызывается и при входе в редактор,
// чтобы восстановленное состояние отразилось на холсте и кнопке)
function _applyGridState() {
  // Сетка рендерится через оверлей (поверх карты), не через background canvas
  let ov = document.getElementById('pdf-grid-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'pdf-grid-overlay';
    ov.className = 'no-export'; // скрыть при экспорте
    ov.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2';
    document.getElementById('pdf-canvas').appendChild(ov);
  }
  ov.style.display = _gridEnabled ? 'block' : 'none';
  const btn = document.getElementById('grid-btn');
  if (btn) btn.classList.toggle('active', _gridEnabled);
  const sbtn = document.getElementById('grid-snap-btn');
  if (sbtn) sbtn.classList.toggle('active', _gridSnap);
}

function toggleGrid() {
  _gridEnabled = !_gridEnabled;
  _UI_PREF.set('grid', _gridEnabled);
  _applyGridState();
}

function toggleGridSnap() {
  _gridSnap = !_gridSnap;
  _UI_PREF.set('gridSnap', _gridSnap);
  const btn = document.getElementById('grid-snap-btn');
  if (btn) btn.classList.toggle('active', _gridSnap);
}

// Магнит к узлам объектов
window.setSnapEnabled = function(on) {
  _snapEnabled = !!on;
  _UI_PREF.set('snapNodes', _snapEnabled);
};

// Сброс масштаба холста в 100 %
window.resetCanvasZoom = function() {
  _zoomMul = 1;
  _panX = 0; _panY = 0; _applyPan();
  _UI_PREF.set('zoomMul', _zoomMul);
  _applyOrientation();
  _syncZoomPct();
};

function _syncZoomPct() {
  const pct = document.getElementById('pdf-zoom-pct');
  if (pct) pct.innerHTML = `<svg class="icon icon-sm"><use href="#ico-fit"/></svg> ${Math.round(_zoomMul * 100)}%`;
}

// ── Context menu ──────────────────────────────────
function _showContextMenu(e, obj) {
  e.preventDefault();
  _hideContextMenu();
  const menu = document.createElement('div');
  menu.id = 'pdf-ctx-menu';
  const ico = (id) => `<svg class="icon icon-sm" style="margin-right:5px;vertical-align:middle"><use href="#${id}"/></svg>`;
  menu.innerHTML = `
    <div class="ctx-item" onclick="copyPdfObj();_hideContextMenu()">${ico('ico-copy')}Копировать</div>
    <div class="ctx-item" onclick="pastePdfObj();_hideContextMenu()">${ico('ico-paste')}Вставить</div>
    <div class="ctx-item" onclick="duplicatePdfObj();_hideContextMenu()">${ico('ico-duplicate')}Дублировать</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="movePdfObjDown();_hideContextMenu()">${ico('ico-layer-up')}На передний план</div>
    <div class="ctx-item" onclick="movePdfObjUp();_hideContextMenu()">${ico('ico-layer-down')}На задний план</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="alignPdfObj('left');_hideContextMenu()">${ico('ico-align-l')}По левому краю</div>
    <div class="ctx-item" onclick="alignPdfObj('cx');_hideContextMenu()">${ico('ico-align-cx')}По центру гор.</div>
    <div class="ctx-item" onclick="alignPdfObj('cy');_hideContextMenu()">${ico('ico-align-cy')}По центру вер.</div>
    <div class="ctx-item" onclick="alignPdfObj('right');_hideContextMenu()">${ico('ico-align-r')}По правому краю</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="groupPdfObjects();_hideContextMenu()">${ico('ico-layers')}Сгруппировать (Ctrl+G)</div>
    <div class="ctx-item" onclick="ungroupPdfObjects();_hideContextMenu()">${ico('ico-layers')}Разгруппировать</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="toggleLockPdfObj();_hideContextMenu()">${obj.locked ? ico('ico-unlock')+'Разблокировать' : ico('ico-lock')+'Заблокировать'}</div>
    <div class="ctx-item danger" onclick="deletePdfObj();_hideContextMenu()">${ico('ico-trash')}Удалить</div>
  `;
  menu.style.cssText = `position:fixed;left:${Math.min(e.clientX, window.innerWidth-180)}px;top:${Math.min(e.clientY, window.innerHeight-300)}px;z-index:99999`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', _hideContextMenu, { once: true }), 10);
}

function _hideContextMenu() {
  const m = document.getElementById('pdf-ctx-menu');
  if (m) m.remove();
}

// ── Стрелка-объект ────────────────────────────────
// Стрелка задаётся двумя точками (начало и остриё) в координатах холста.
// Коробка объекта только вмещает их — крутить её не нужно, направление
// меняется перетаскиванием любого из концов.
function _arrowPts(d) {
  // Старые стрелки (коробка + поворот) переводим в две точки один раз
  if (d.ax1 === undefined) {
    const w = d.w || 200, h = d.h || 30, a = (d.rotation || 0) * Math.PI / 180;
    const cx = d.x + w / 2, cy = d.y + h / 2;
    d.ax1 = Math.round(cx - Math.cos(a) * w / 2);
    d.ay1 = Math.round(cy - Math.sin(a) * w / 2);
    d.ax2 = Math.round(cx + Math.cos(a) * w / 2);
    d.ay2 = Math.round(cy + Math.sin(a) * w / 2);
    d.rotation = 0;
  }
  return { x1: d.ax1, y1: d.ay1, x2: d.ax2, y2: d.ay2 };
}

// Пересчитать габариты объекта под текущие концы стрелки
function _arrowSyncBox(obj) {
  const d = obj.data;
  const p = _arrowPts(d);
  const pad = Math.max(14, (d.strokeW || 3) * 5);
  d.x = Math.round(Math.min(p.x1, p.x2) - pad);
  d.y = Math.round(Math.min(p.y1, p.y2) - pad);
  d.w = Math.round(Math.abs(p.x2 - p.x1) + pad * 2);
  d.h = Math.round(Math.abs(p.y2 - p.y1) + pad * 2);
}

// Пять видов наконечника. Направление и пунктир — отдельные переключатели:
// «в обе стороны» это не вид острия, а то, на скольких концах оно стоит,
// и занимать им место среди стилей было незачем.
// cut — на сколько укоротить линию, чтобы она не торчала из острия.
const ARROW_STYLES = [
  { name: 'Треугольник', cut: 0.85 },
  { name: 'Открытый',    cut: 0     },
  { name: 'Узкий',       cut: 0.9   },
  { name: 'Ромб',        cut: 1.7   },
  { name: 'Круг',        cut: 1.0   },
];

// Рисует наконечник вида st в точке (tx,ty) под углом a
function _arrowHead(style, tx, ty, a, head, color, sw) {
  const P = (r, da) => (tx - r * Math.cos(a + da)).toFixed(1) + ',' + (ty - r * Math.sin(a + da)).toFixed(1);
  const tip = tx.toFixed(1) + ',' + ty.toFixed(1);
  switch (style) {
    case 1:  // открытый: две линии «галочкой», без заливки
      return `<polyline points="${P(head, -0.42)} ${tip} ${P(head, 0.42)}" fill="none"
        stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 2:  // узкий: длинное острое перо
      return `<polygon points="${tip} ${P(head * 1.5, -0.2)} ${P(head * 1.5, 0.2)}" fill="${color}"/>`;
    case 3: { // ромб: острие и симметричное основание
      const bx = (tx - Math.cos(a) * head * 2).toFixed(1), by = (ty - Math.sin(a) * head * 2).toFixed(1);
      return `<polygon points="${tip} ${P(head, -1.05)} ${bx},${by} ${P(head, 1.05)}" fill="${color}"/>`;
    }
    case 4: { // круг: точка на конце
      const cx = (tx - Math.cos(a) * head * 0.5).toFixed(1), cy = (ty - Math.sin(a) * head * 0.5).toFixed(1);
      return `<circle cx="${cx}" cy="${cy}" r="${(head * 0.55).toFixed(1)}" fill="${color}"/>`;
    }
    default: // треугольник
      return `<polygon points="${tip} ${P(head, -0.38)} ${P(head, 0.38)}" fill="${color}"/>`;
  }
}

// Длина и угол стрелки — из её концов. В свойствах их удобнее задавать
// числом, чем подгонять мышью.
function _arrowLen(d) { const p = _arrowPts(d); return Math.hypot(p.x2 - p.x1, p.y2 - p.y1); }
function _arrowAng(d) { const p = _arrowPts(d); return Math.atan2(p.y2 - p.y1, p.x2 - p.x1) * 180 / Math.PI; }

window.setArrowStyle = function (i) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'arrow') return;
  _pushUndo();
  obj.data.arrowStyle = i;   // вид острия; направление задаётся отдельно
  _arrowSyncBox(obj);
  _renderObj(obj);
  _renderProps();
  _saveState();
};

// Длина и угол задаются от середины: стрелка не съезжает с места
// На скольких концах стоит остриё и пунктирная ли линия — это не вид
// наконечника, поэтому отдельными переключателями.
window.setArrowDir = function (dir) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'arrow') return;
  _pushUndo();
  obj.data.arrowDir = dir;
  _arrowSyncBox(obj); _renderObj(obj); _renderProps(); _saveState();
};

window.toggleArrowDash = function () {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'arrow') return;
  _pushUndo();
  obj.data.dashArrow = !obj.data.dashArrow;
  _renderObj(obj); _renderProps(); _saveState();
};

window.setArrowGeom = function () {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'arrow') return;
  const lenEl = document.getElementById('pp-arrow-len');
  const angEl = document.getElementById('pp-arrow-ang');
  const len = Math.max(10, parseFloat(lenEl && lenEl.value) || _arrowLen(obj.data));
  const ang = (parseFloat(angEl && angEl.value) || 0) * Math.PI / 180;
  const p = _arrowPts(obj.data);
  const cx = (p.x1 + p.x2) / 2, cy = (p.y1 + p.y2) / 2;
  obj.data.ax1 = Math.round(cx - Math.cos(ang) * len / 2);
  obj.data.ay1 = Math.round(cy - Math.sin(ang) * len / 2);
  obj.data.ax2 = Math.round(cx + Math.cos(ang) * len / 2);
  obj.data.ay2 = Math.round(cy + Math.sin(ang) * len / 2);
  _arrowSyncBox(obj);
  _renderObj(obj);
  _updateHandles(document.getElementById(obj.id), obj);
  _saveState();
};

function _arrowHtml(obj) {
  const d = obj.data;
  const p = _arrowPts(d);
  const color = d.strokeColor || '#ef4444';
  const sw = Math.max(1, d.strokeW || 3);
  const si = d.arrowStyle || 0;
  const st = ARROW_STYLES[si] || ARROW_STYLES[0];
  const dir = d.arrowDir || 'end';
  const head = Math.max(8, sw * 3.2);
  const x1 = p.x1 - d.x, y1 = p.y1 - d.y, x2 = p.x2 - d.x, y2 = p.y2 - d.y;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const tri = (tx, ty, a) => _arrowHead(si, tx, ty, a, head, color, sw);
  // Каждый наконечник закрывает линию на свою глубину: у открытого линия
  // должна дойти до острия, у ромба — отступить на всю его длину.
  const cut = head * st.cut;
  const sx = (dir === 'start' || dir === 'both') ? x1 + Math.cos(ang) * cut : x1;
  const sy = (dir === 'start' || dir === 'both') ? y1 + Math.sin(ang) * cut : y1;
  const _cutEnd = (dir === 'end' || dir === 'both' || dir === 'dot-end') ? cut : 0;
  const ex = x2 - Math.cos(ang) * _cutEnd;
  const ey = y2 - Math.sin(ang) * _cutEnd;
  return `<svg width="${d.w}" height="${d.h}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block;pointer-events:none">
    <line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"
          stroke="${color}" stroke-width="${sw}" stroke-linecap="round"
          ${d.dashArrow ? `stroke-dasharray="${sw * 3},${sw * 2}"` : ''}/>
    ${(dir === 'end'   || dir === 'both' || dir === 'dot-end') ? tri(x2, y2, ang) : ''}
    ${(dir === 'start' || dir === 'both') ? tri(x1, y1, ang + Math.PI) : ''}
    ${dir === 'dot-end' ? `<circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="${(sw * 1.7).toFixed(1)}" fill="${color}"/>` : ''}
  </svg>`;
}

// Перетаскивание конца стрелки
// Общий поворот пишет в data.rotation, а стрелка живёт двумя точками и
// это поле игнорирует — поэтому крутим и укорачиваем сами, вокруг середины.
// mode: 'rotate' — угол при неизменной длине, 'scale' — длина при неизменном угле.
function _onArrowTransform(e, obj, mode) {
  e.stopPropagation(); e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);
  const canvas = document.getElementById('pdf-canvas');
  const p0 = { ..._arrowPts(obj.data) };
  const cx = (p0.x1 + p0.x2) / 2, cy = (p0.y1 + p0.y2) / 2;
  // Переводим экранные координаты в координаты листа тем же способом,
  // что и перетаскивание концов, иначе при зуме ручка «убегает».
  const toSheet = ev => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (canvas.offsetWidth / r.width),
             y: (ev.clientY - r.top)  * (canvas.offsetHeight / r.height) };
  };
  const s0 = toSheet(e);
  const a0 = Math.atan2(s0.y - cy, s0.x - cx);
  const d0 = Math.max(1, Math.hypot(s0.x - cx, s0.y - cy));

  function onMove(ev) {
    const sp = toSheet(ev);
    let put;
    if (mode === 'rotate') {
      let da = Math.atan2(sp.y - cy, sp.x - cx) - a0;
      if (ev.shiftKey) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);  // шаг 15°
      const c = Math.cos(da), sn = Math.sin(da);
      put = p => ({ x: cx + (p.x - cx) * c - (p.y - cy) * sn,
                    y: cy + (p.x - cx) * sn + (p.y - cy) * c });
    } else {
      let k = Math.max(0.05, Math.hypot(sp.x - cx, sp.y - cy) / d0);
      put = p => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k });
    }
    const a = put({ x: p0.x1, y: p0.y1 }), b = put({ x: p0.x2, y: p0.y2 });
    obj.data.ax1 = Math.round(a.x); obj.data.ay1 = Math.round(a.y);
    obj.data.ax2 = Math.round(b.x); obj.data.ay2 = Math.round(b.y);
    _arrowSyncBox(obj);
    _renderObj(obj);
    _updateHandles(document.getElementById(obj.id), obj);
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

function _onArrowEndDrag(e, obj, which) {
  e.stopPropagation(); e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);
  const canvas = document.getElementById('pdf-canvas');
  const startX = e.clientX, startY = e.clientY;
  const p0 = { ..._arrowPts(obj.data) };
  function onMove(ev) {
    const rect = canvas.getBoundingClientRect();
    const kx = canvas.offsetWidth / rect.width, ky = canvas.offsetHeight / rect.height;
    let dx = (ev.clientX - startX) * kx, dy = (ev.clientY - startY) * ky;
    if (ev.shiftKey) {                       // Shift — угол кратно 45°
      const ox = which === 1 ? p0.x2 : p0.x1, oy = which === 1 ? p0.y2 : p0.y1;
      const nx = (which === 1 ? p0.x1 : p0.x2) + dx, ny = (which === 1 ? p0.y1 : p0.y2) + dy;
      const a = Math.round(Math.atan2(ny - oy, nx - ox) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(nx - ox, ny - oy);
      dx = ox + Math.cos(a) * len - (which === 1 ? p0.x1 : p0.x2);
      dy = oy + Math.sin(a) * len - (which === 1 ? p0.y1 : p0.y2);
    }
    if (which === 1) { obj.data.ax1 = Math.round(p0.x1 + dx); obj.data.ay1 = Math.round(p0.y1 + dy); }
    else             { obj.data.ax2 = Math.round(p0.x2 + dx); obj.data.ay2 = Math.round(p0.y2 + dy); }
    _arrowSyncBox(obj);
    _renderObj(obj);
    _updateHandles(document.getElementById(obj.id), obj);
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

// ── Масштаб растеризации при экспорте ────────────────────────────────────────
// devicePixelRatio * 2 на 4K-мониторе давало канвас под 10000 px по стороне:
// html2canvas держит клон страницы + сам канвас (4 байта на пиксель), и экспорт
// падал или отдавал белый лист. Ограничиваем и по стороне, и по площади.
const _EXPORT_MIN_SCALE  = 3.5;    // ≈330 dpi для A4 — иначе на dpr=1 выходило 190 dpi
const _EXPORT_MAX_SCALE  = 4.5;    // ≈430 dpi — выше визуального выигрыша нет
const _EXPORT_MAX_PIXELS = 25e6;   // 25 Мп ≈ 100 МБ RGBA — потолок по памяти
const _EXPORT_MAX_SIDE   = 10000;  // запас до лимита канваса в Chromium
// Потолок веса картинки внутри PDF (символов data-URI ≈ 0.75 байта каждый).
// ~32 МБ base64 ≈ 24 МБ данных — дальше PDF тяжело открывается и печатается.
const _PDF_MAX_EMBED_CHARS = 32 * 1024 * 1024;
// До этого размера PNG берём всегда: схематичная подложка жмётся хорошо,
// и качество линий/подписей важнее пары мегабайт.
const _PNG_ALWAYS_CHARS    = 6 * 1024 * 1024;

function _exportScale(el) {
  const w = el.offsetWidth || 1, h = el.offsetHeight || 1;
  // Не ниже _EXPORT_MIN_SCALE: на мониторе с dpr=1 старое dpr*2 давало всего
  // ~190 dpi, отсюда и мыло на подписях, линиях и полигонах
  const want    = Math.max(_EXPORT_MIN_SCALE, (window.devicePixelRatio || 1) * 2);
  const byArea  = Math.sqrt(_EXPORT_MAX_PIXELS / (w * h));
  const bySide  = Math.min(_EXPORT_MAX_SIDE / w, _EXPORT_MAX_SIDE / h);
  return Math.max(1, Math.min(want, _EXPORT_MAX_SCALE, byArea, bySide));
}

// ── Подложка удвоенного разрешения на время экспорта ────────────────────────
// Тайлы приходят под размер экрана; при растеризации в 3-4× они просто
// растягиваются и мылятся. На время съёмки подменяем слой на тайлы следующего
// зума, показанные вдвое мельче (как detectRetina) — деталей вдвое больше.
async function _pdfHiResTiles() {
  if (!pdfMap || !_pdfTile) return null;
  const z = Math.round(pdfMap.getZoom());
  const maxZ = _pdfTile.options.maxZoom || 19;
  if (z + 1 > maxZ) return null;              // дальше провайдер тайлов не отдаёт

  const url = _pdfTile._url;
  const hi = L.tileLayer(url, {
    maxZoom: maxZ, crossOrigin: 'anonymous',
    tileSize: 128, zoomOffset: 1, keepBuffer: 4, updateWhenIdle: true,
  });
  const old = _pdfTile;
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    hi.once('load', finish);
    setTimeout(finish, 5000);                 // не ждём вечно, если тайлы не приходят
    hi.addTo(pdfMap);
  });
  pdfMap.removeLayer(old);
  _pdfTile = hi;
  hi.bringToBack();

  return () => {                              // вернуть обычную подложку
    try {
      old.addTo(pdfMap);
      old.bringToBack();
      pdfMap.removeLayer(hi);
      _pdfTile = old;
    } catch(e) {}
  };
}

// ── Помощники экспорта: translate3d→top/left для SVG-слоёв Leaflet ────────────
// html2canvas не применяет CSS left/top с отрицательными значениями к SVG-элементам.
// Leaflet позиционирует SVG слой за пределами холста (left:-padding, top:-padding),
// что приводит к смещению полигонов относительно тайлов.
// Решение: сдвигаем SVG в (0,0) и переключаем viewBox на зону видимого вьюпорта.
function _fixLeafletSvgForExport(mapInst) {
  const fixed = [];
  if (!mapInst) return fixed;
  let panes, mapSize;
  try { panes = mapInst.getPanes(); mapSize = mapInst.getSize(); } catch(e) { return fixed; }
  const overlayPane = panes && panes.overlayPane;
  if (!overlayPane || !mapSize) return fixed;
  overlayPane.querySelectorAll('svg').forEach(svg => {
    const t = svg.style.transform || '';
    const m = t.match(/translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px/);
    if (!m) return;
    svg._exportTx   = t;
    svg._exportLeft = svg.style.left;
    svg._exportTop  = svg.style.top;
    svg._exportW    = svg.getAttribute('width');
    svg._exportH    = svg.getAttribute('height');
    svg._exportVB   = svg.getAttribute('viewBox');
    // Позиционируем SVG в (0,0) и выставляем viewBox точно на вьюпорт.
    // После reset=true у Leaflet SVG-координаты == container-points,
    // т.е. (0,0) — верхний левый угол карты, (mapW, mapH) — правый нижний.
    svg.style.transform = '';
    svg.style.left = '0px';
    svg.style.top  = '0px';
    svg.setAttribute('width',   mapSize.x);
    svg.setAttribute('height',  mapSize.y);
    svg.setAttribute('viewBox', `0 0 ${mapSize.x} ${mapSize.y}`);
    fixed.push(svg);
  });
  return fixed;
}
function _restoreLeafletSvg(fixed) {
  fixed.forEach(svg => {
    svg.style.transform = svg._exportTx;
    svg.style.left = svg._exportLeft;
    svg.style.top  = svg._exportTop;
    if (svg._exportW  !== null) svg.setAttribute('width',   svg._exportW);
    if (svg._exportH  !== null) svg.setAttribute('height',  svg._exportH);
    if (svg._exportVB !== null) svg.setAttribute('viewBox', svg._exportVB);
    delete svg._exportTx; delete svg._exportLeft; delete svg._exportTop;
    delete svg._exportW;  delete svg._exportH;    delete svg._exportVB;
  });
}

// ── Экспорт PNG ───────────────────────────────────
async function exportPng() {
  const btn = document.getElementById('pdf-export-png-btn');
  const savedHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.innerHTML = '<svg class="icon icon-sm"><use href="#ico-image"/></svg>⏳…'; btn.disabled = true; }
  selectPdfObj(null);
  const hiddenEls = _hideExportOverlays();
  const canvas = document.getElementById('pdf-canvas');
  // Сбрасываем CSS transform чтобы карта не смещалась при захвате
  const savedTransform = canvas.style.transform;
  canvas.style.transform = 'none';
  canvas.style.transformOrigin = 'top left';
  if (pdfMap) {
    pdfMap.invalidateSize();
    // { reset: true } форсирует полный ре-рендер Leaflet (viewreset + _update SVG-слоёв)
    pdfMap.setView(pdfMap.getCenter(), pdfMap.getZoom(), { reset: true, animate: false });
  }
  Object.values(_insetMaps).forEach(m => {
    try { m.invalidateSize(); m.setView(m.getCenter(), m.getZoom(), { reset: true, animate: false }); } catch(e){}
  });
  // Подложка удвоенного разрешения + ожидание отрисовки тайлов
  const restoreTiles = await _pdfHiResTiles();
  await new Promise(r => setTimeout(r, 800));
  // Повторно скрываем ручки выносок (могли быть показаны заново через viewreset → _draw)
  document.querySelectorAll('.callout-handle').forEach(el => el.setAttribute('display', 'none'));
  // Конвертируем transform:translate3d → top/left на SVG-слоях (html2canvas не читает translate3d)
  const svgFixed = [
    ..._fixLeafletSvgForExport(pdfMap),
    ...Object.values(_insetMaps).flatMap(m => { try { return _fixLeafletSvgForExport(m); } catch(e) { return []; } }),
  ];
  try {
    const snap = await html2canvas(canvas, {
      useCORS: true, allowTaint: false,
      scale: _exportScale(canvas),
      backgroundColor: '#ffffff',
      ignoreElements: el => el.classList && (el.classList.contains('ps-handle') || el.classList.contains('no-export')),
    });
    const al  = getActiveLayer();
    const fname = `${(al ? al.name : 'map').replace(/[^\wа-яА-Я]/g,'_')}_${new Date().toISOString().slice(0,10)}.png`;
    await _download(snap.toDataURL('image/png'), fname);
    setSt(`PNG сохранён ✓ (${snap.width}×${snap.height})`, 'ok');
  } catch(err) { setSt('Ошибка PNG: ' + err.message, 'err'); console.error(err); }
  finally { _restoreLeafletSvg(svgFixed); if (restoreTiles) restoreTiles(); }
  // Восстанавливаем transform
  canvas.style.transform = savedTransform;
  canvas.style.transformOrigin = 'center center';
  if (pdfMap) pdfMap.invalidateSize(false);
  Object.values(_insetMaps).forEach(m => { try { m.invalidateSize(false); } catch(e){} });
  _showExportOverlays(hiddenEls);
  if (btn && savedHtml) { btn.innerHTML = savedHtml; btn.disabled = false; }
}

// Скрыть элементы управления картами перед экспортом
function _hideExportOverlays() {
  const hidden = [];
  document.querySelectorAll('#pdf-map .leaflet-control-container').forEach(el => {
    hidden.push({ el, display: el.style.display }); el.style.display = 'none';
  });
  document.querySelectorAll('.inset-leaflet .leaflet-control-container, .no-export').forEach(el => {
    hidden.push({ el, display: el.style.display }); el.style.display = 'none';
  });
  // Скрываем кружки-ручки перетаскивания выносок (SVG-элементы)
  document.querySelectorAll('.callout-handle').forEach(el => {
    hidden.push({ el, _svg: true });
    el.setAttribute('display', 'none');
  });
  return hidden;
}

function _showExportOverlays(hidden) {
  hidden.forEach(({ el, display, _svg }) => {
    if (_svg) el.removeAttribute('display');
    else el.style.display = display;
  });
}

// ── Snap / Притяжение ─────────────────────────────
function _clearSnapGuides() {
  _snapGuides.forEach(g => g.remove());
  _snapGuides = [];
}

function _showGuide(dir, pos) {
  const canvas = document.getElementById('pdf-canvas');
  const g = document.createElement('div');
  g.className = 'snap-guide snap-guide-' + dir;
  if (dir === 'v') { g.style.cssText = `position:absolute;left:${pos}px;top:0;width:1px;height:100%;background:#f97316;opacity:.8;pointer-events:none;z-index:9999`; }
  else             { g.style.cssText = `position:absolute;top:${pos}px;left:0;height:1px;width:100%;background:#f97316;opacity:.8;pointer-events:none;z-index:9999`; }
  canvas.appendChild(g);
  _snapGuides.push(g);
}

function _snapObject(obj, nx, ny) {
  const canvas = document.getElementById('pdf-canvas');
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  const d = obj.data;

  // Сначала — grid snap
  if (_gridSnap) {
    nx = Math.round(nx / _gridSize) * _gridSize;
    ny = Math.round(ny / _gridSize) * _gridSize;
  }

  // Изображения можно выносить за пределы листа (лишнее обрежется при экспорте)
  const noClamp = obj.type === 'image';

  if (!_snapEnabled) {
    // Даже без snap — не даём выйти за страницу (кроме изображений)
    return noClamp ? { x: nx, y: ny } : {
      x: Math.max(0, Math.min(W - d.w, nx)),
      y: Math.max(0, Math.min(H - d.h, ny)),
    };
  }

  _clearSnapGuides();

  // ── Цели для snap по X ──────────────────────────
  // Формат: { val, offset } — когда левый_край + offset == val → snap
  // offset=0: левый край объекта, offset=w/2: центр, offset=w: правый край
  const targetsX = [
    // Края и центр страницы
    { val: 0,              offset: 0      },   // левый → к левому краю
    { val: W,              offset: d.w    },   // правый → к правому краю
    { val: Math.round(W/2),offset: d.w/2  },   // центр
    { val: 0,              offset: d.w    },   // правый → к левому краю (у стены)
    { val: W,              offset: 0      },   // левый → к правому краю
  ];
  const targetsY = [
    { val: 0,              offset: 0      },
    { val: H,              offset: d.h    },
    { val: Math.round(H/2),offset: d.h/2  },
    { val: 0,              offset: d.h    },
    { val: H,              offset: 0      },
  ];

  // Цели от других объектов
  pdfObjects.filter(o => o.id !== obj.id && o.visible).forEach(o => {
    const od = o.data;
    // Выравнивание краёв — левый к левому, правый к правому, и т.д.
    targetsX.push(
      { val: od.x,                   offset: 0     },  // левый → левый
      { val: od.x,                   offset: d.w   },  // правый → левый
      { val: od.x + od.w,            offset: 0     },  // левый → правый
      { val: od.x + od.w,            offset: d.w   },  // правый → правый
      { val: od.x + od.w/2,          offset: d.w/2 },  // центр → центр
    );
    targetsY.push(
      { val: od.y,                   offset: 0     },
      { val: od.y,                   offset: d.h   },
      { val: od.y + od.h,            offset: 0     },
      { val: od.y + od.h,            offset: d.h   },
      { val: od.y + od.h/2,          offset: d.h/2 },
    );
  });

  let sx = nx, sy = ny;
  let snappedX = false, snappedY = false;

  for (const { val, offset } of targetsX) {
    if (!snappedX && Math.abs(nx + offset - val) < SNAP_DIST) {
      sx = Math.round(val - offset);
      _showGuide('v', val);
      snappedX = true;
    }
  }
  for (const { val, offset } of targetsY) {
    if (!snappedY && Math.abs(ny + offset - val) < SNAP_DIST) {
      sy = Math.round(val - offset);
      _showGuide('h', val);
      snappedY = true;
    }
  }

  // Жёсткий clamp — объект не выходит за страницу (кроме изображений)
  if (!noClamp) {
    sx = Math.max(0, Math.min(W - d.w, sx));
    sy = Math.max(0, Math.min(H - d.h, sy));
  }

  return { x: sx, y: sy };
}

// ── Выравнивание объектов ─────────────────────────
function alignPdfObj(dir) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.locked) return;

  // Для текстовых объектов left/cx/right — выравнивание текста внутри блока
  const textTypes = ['text', 'rect', 'ellipse', 'callout', 'leader'];
  if (textTypes.includes(obj.type) && ['left', 'cx', 'right'].includes(dir)) {
    _pushUndo();
    obj.data.textAlign = dir === 'cx' ? 'center' : dir;
    const el = document.getElementById(obj.id);
    if (el) {
      el.style.textAlign = obj.data.textAlign;
      el.style.justifyContent = obj.data.textAlign === 'left' ? 'flex-start'
                               : obj.data.textAlign === 'right' ? 'flex-end' : 'center';
    }
    _renderProps();
    _saveState();
    return;
  }

  const canvas = document.getElementById('pdf-canvas');
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  const d = obj.data;
  _pushUndo();
  switch(dir) {
    case 'left':   d.x = 0; break;
    case 'cx':     d.x = Math.round(W / 2 - d.w / 2); break;
    case 'right':  d.x = Math.round(W - d.w); break;
    case 'top':    d.y = 0; break;
    case 'cy':     d.y = Math.round(H / 2 - d.h / 2); break;
    case 'bottom': d.y = Math.round(H - d.h); break;
  }
  const el = document.getElementById(obj.id);
  if (el) { el.style.left = d.x + 'px'; el.style.top = d.y + 'px'; }
  _syncPropsAll();
  _saveState();
}

// ── Undo / Redo ───────────────────────────────────
function _pushUndo() {
  _undoStack.push(JSON.stringify(pdfObjects.map(o => ({ ...o, data: { ...o.data, imgSrc: o.data.imgSrc ? '[img]' : '' } }))));
  if (_undoStack.length > 40) _undoStack.shift();
  _redoStack = [];
}

function undoPdf() {
  if (!_undoStack.length) return;
  _redoStack.push(JSON.stringify(pdfObjects.map(o => ({ ...o, data: { ...o.data, imgSrc: o.data.imgSrc ? '[img]' : '' } }))));
  _restoreState(JSON.parse(_undoStack.pop()));
  setSt('Отменено ↩', 'ok');
}

function redoPdf() {
  if (!_redoStack.length) return;
  _undoStack.push(JSON.stringify(pdfObjects.map(o => ({ ...o, data: { ...o.data, imgSrc: o.data.imgSrc ? '[img]' : '' } }))));
  _restoreState(JSON.parse(_redoStack.pop()));
  setSt('Повторено ↪', 'ok');
}

function _migrateSrcLeader(d) {
  if (!d) return d;
  // Если kneeX/kneeY остались от старых дефолтов (не привязаны к x/y) — сбрасываем
  const kx = (d.kneeX ?? d.x) - d.x;
  const ky = (d.kneeY ?? (d.y + d.h)) - d.y;
  if (kx < -(d.w || 0) - 10 || kx > (d.w || 0) * 2 + 10 || ky < 0 || ky > (d.h || 0) * 3 + 10) {
    d.kneeX = d.x;
    d.kneeY = d.y + (d.h || 48);
  }
  return d;
}

function _restoreState(saved) {
  // Удалить inset карты
  Object.keys(_insetMaps).forEach(id => { try { _insetMaps[id].remove(); } catch(e) {} delete _insetMaps[id]; });
  // В undo-стеке base64 заменён на '[img]' — возвращаем живые картинки по id
  const _imgKeep = {};
  pdfObjects.forEach(o => {
    if (o.data && o.data.imgSrc && o.data.imgSrc !== '[img]') _imgKeep[o.id] = o.data.imgSrc;
  });
  pdfObjects = saved.map(o => {
    const data = { ...OBJ_DEFAULTS[o.type] || OBJ_DEFAULTS.rect, ...o.data };
    if (data.imgSrc === '[img]') data.imgSrc = _imgKeep[o.id] || '';
    if (o.type === 'src-leader') _migrateSrcLeader(data);
    return { ...o, data };
  });
  pdfSelId = null;
  _renderAll();
  _renderLayersList();
  _renderProps();
  _saveState();
}

// ── Лупа — вставка увеличенного фрагмента ────────
function addPdfInset() {
  const { W, H } = _pdfCanvasSize();
  _pushUndo();
  createPdfObj('inset', { x: Math.round(W / 2 - 170), y: Math.round(H / 2 - 115), w: 340, h: 230, name: 'Лупа' });
  setPdfTool('select');
}

// ── Слои внутри лупы ────────────────────────────────────────────────────────
// Лупа показывает то же, что и большая карта, поэтому её содержимое
// пересобирается на тех же событиях: переключили видимость слоя или сменили
// стиль — фрагмент обновляется вместе с листом.
const _insetLayers = {};   // id врезки → добавленные на неё слои

function _insetBuildLayers(objId, imap) {
  if (!imap) return;
  (_insetLayers[objId] || []).forEach(l => { try { imap.removeLayer(l); } catch(e) {} });
  const out = [];
  // Полигоны проекта — тем же фильтром, что и на большой карте: скрытый слой
  // в лупу не попадает, группы источников/РТ не рисуются заглушками
  for (let i = mapLayers.length - 1; i >= 0; i--) {
    const l = mapLayers[i];
    if (!_pdfIsGeoLayer(l)) continue;
    try {
      const geo   = l.layer.toGeoJSON();
      const style = l._psStyle || { color: l.color, fillColor: l.color, fillOpacity: l.type === 'szz' ? 0.1 : 0.15, weight: 3 };
      const glInset = L.geoJSON(geo, { style: () => style }).addTo(imap);
      out.push(glInset);
      if (style.fillPattern && style.fillPattern !== 'solid' && typeof window._applyFillPattern === 'function') {
        const fp = style.fillPattern, fc = style.fillColor || style.color;
        requestAnimationFrame(() => glInset.eachLayer(sub => window._applyFillPattern(sub, fc, fp)));
      }
      // Выноска слоя — как на листе; тянуть её во фрагменте не даём,
      // иначе одно и то же положение правилось бы из двух мест
      if (l.callout && l.callout.on && typeof _makeCalloutLayersGlobal === 'function') {
        try { out.push(..._makeCalloutLayersGlobal(l.callout, imap, false)); } catch(e) {}
      }
    } catch(e) {}
  }
  // Источники и расчётные точки — теми же функциями, что и на большой карте,
  // поэтому в лупе появляются кружки радиусов, номера и выноски
  try {
    if (typeof _addSourcesToPdfMap   === 'function') out.push(..._addSourcesToPdfMap(imap));
    if (typeof _addMonPointsToPdfMap === 'function') out.push(..._addMonPointsToPdfMap(imap));
  } catch(e) {}
  _insetLayers[objId] = out;
}

// Пересобрать содержимое всех луп на листе
window._insetSyncLayers = function() {
  Object.entries(_insetMaps).forEach(([id, imap]) => {
    try { _insetBuildLayers(id, imap); } catch(e) {}
  });
};

function _initInsetMap(el, obj) {
  if (_insetMaps[obj.id]) return; // уже создана
  const mapDiv = document.createElement('div');
  mapDiv.className = 'inset-leaflet';
  mapDiv.id = 'imap_' + obj.id;
  mapDiv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;border-radius:inherit';
  el.appendChild(mapDiv);

  const hasSaved = obj.data.insetSavedLat != null && obj.data.insetSavedLon != null;
  const center = hasSaved
    ? L.latLng(obj.data.insetSavedLat, obj.data.insetSavedLon)
    : (pdfMap ? pdfMap.getCenter() : map.getCenter());
  const zoom = hasSaved
    ? obj.data.insetSavedZoom
    : Math.min(19, (pdfMap ? pdfMap.getZoom() : map.getZoom()) + (obj.data.insetZoom || 2));

  const imap = L.map('imap_' + obj.id, {
    center, zoom,
    zoomControl: false,        // плюсы/минусы убраны (мешают при экспорте)
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: false,
    attributionControl: false,
    zoomSnap: 0,               // дробный зум — нужен для точного масштаба 1:N
  });

  (pdfMapSat
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, crossOrigin: 'anonymous' })
    : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, crossOrigin: 'anonymous' })
  ).addTo(imap);

  _insetBuildLayers(obj.id, imap);

  // Бейдж "Фрагмент" — только в редакторе, скрыт при экспорте
  const badge = document.createElement('div');
  badge.className = 'inset-badge no-export';
  badge.style.cssText = 'position:absolute;top:4px;left:4px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;z-index:500;pointer-events:none';
  badge.textContent = 'Фрагмент';
  mapDiv.appendChild(badge);

  // Масштабная плашка врезки — печатается вместе с листом
  const plate = document.createElement('div');
  plate.className = 'inset-scale';
  plate.id = 'iscale_' + obj.id;
  plate.style.cssText = 'position:absolute;right:5px;bottom:4px;z-index:500;pointer-events:none;' +
    'background:rgba(255,255,255,.88);padding:2px 5px;border-radius:3px';
  mapDiv.appendChild(plate);
  // Масштаб лупы видно прямо на ней, не открывая свойства
  const _badgeScale = () => {
    try {
      badge.textContent = 'Фрагмент · 1 : ' + (_insetScale(obj) || '—').toLocaleString('ru');
      _insetScalePlate(obj, imap);
    } catch(e) {}
  };
  setTimeout(_badgeScale, 300);

  _insetMaps[obj.id] = imap;

  // Сохраняем позицию лупы при перемещении/зуме
  imap.on('moveend zoomend', () => {
    _badgeScale();
    const c = imap.getCenter();
    obj.data.insetSavedLat  = c.lat;
    obj.data.insetSavedLon  = c.lng;
    obj.data.insetSavedZoom = imap.getZoom();
    _saveState();
  });

  // Применяем текущее состояние фиксации карты
  if (!pdfMapDrag) {
    imap.dragging.disable();
    imap.scrollWheelZoom.disable();
    imap.doubleClickZoom.disable();
    imap.touchZoom.disable();
  }
  setTimeout(() => imap.invalidateSize(), 150);

  // Стоп всплытие событий (чтоб не мешал drag объекта)
  mapDiv.addEventListener('pointerdown', e => e.stopPropagation());
}

// ── Управление картой внутри PDF ─────────────────
function togglePdfMapSat() {
  if (!pdfMap) return;
  if (_pdfTile) pdfMap.removeLayer(_pdfTile);
  pdfMapSat = !pdfMapSat;
  const satUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const osmUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  _pdfTile = L.tileLayer(pdfMapSat ? satUrl : osmUrl, { maxZoom:19, crossOrigin: 'anonymous' });
  _pdfTile.addTo(pdfMap);
  // Синхронизируем тайловый слой всех лупа-карт
  Object.entries(_insetMaps).forEach(([id, imap]) => {
    imap.eachLayer(l => { if (l instanceof L.TileLayer) imap.removeLayer(l); });
    L.tileLayer(pdfMapSat ? satUrl : osmUrl, { maxZoom:19, crossOrigin: 'anonymous' }).addTo(imap);
  });
  const btn = document.getElementById('pdf-sat-btn');
  if (btn) { btn.innerHTML = `<svg class="icon icon-sm"><use href="#ico-${pdfMapSat?'map-scheme':'sat'}"/></svg>${pdfMapSat?'Схема':'Спутник'}`; btn.classList.toggle('active', pdfMapSat); }
}

function togglePdfMapDrag() {
  if (!pdfMap) return;
  pdfMapDrag = !pdfMapDrag;
  const mapEl = document.getElementById('pdf-map');
  if (pdfMapDrag) {
    pdfMap.dragging.enable();
    pdfMap.scrollWheelZoom.enable();
    pdfMap.doubleClickZoom.enable();
    pdfMap.touchZoom.enable();
    if (mapEl) { mapEl.style.cursor = 'grab'; mapEl.style.pointerEvents = ''; }
    Object.values(_insetMaps).forEach(imap => {
      imap.dragging.enable();
      imap.scrollWheelZoom.enable();
      imap.doubleClickZoom.enable();
      imap.touchZoom.enable();
    });
    setPdfTool('select');
    setSt('Режим перемещения карты — двигай и масштабируй колесом мыши', 'ok');
  } else {
    pdfMap.dragging.disable();
    pdfMap.scrollWheelZoom.disable();
    pdfMap.doubleClickZoom.disable();
    pdfMap.touchZoom.disable();
    if (mapEl) { mapEl.style.cursor = ''; }
    Object.values(_insetMaps).forEach(imap => {
      imap.dragging.disable();
      imap.scrollWheelZoom.disable();
      imap.doubleClickZoom.disable();
      imap.touchZoom.disable();
    });
    setSt('Карта зафиксирована', 'ok');
  }
  const btn = document.getElementById('pdf-drag-btn');
  if (btn) { btn.innerHTML = `<svg class="icon icon-sm"><use href="#ico-${pdfMapDrag?'lock':'hand'}"/></svg>${pdfMapDrag?'Зафикс.':'Двигать'}`; btn.classList.toggle('active', pdfMapDrag); }
}

function fitPdfMapToLayer() {
  if (!pdfMap) return;
  const targets = getActiveLayer()
    ? [getActiveLayer()]
    : mapLayers;
  const valid = targets.filter(l => l.layer && l.layer.getBounds);
  if (!valid.length) { setSt('Нет слоёв для позиционирования', 'err'); return; }
  try {
    let bounds = valid[0].layer.getBounds();
    valid.slice(1).forEach(l => { try { bounds.extend(l.layer.getBounds()); } catch(e) {} });
    if (!bounds || !bounds.isValid()) { setSt('Нет данных для позиционирования', 'err'); return; }
    pdfMap.invalidateSize(false);
    pdfMap.fitBounds(bounds, { padding: [24, 24] });
    setSt('Карта PDF центрирована на участке ✓', 'ok');
  } catch(e) {
    setSt('Ошибка позиционирования карты', 'err');
  }
}

// ── UI редактора ──────────────────────────────────
function _buildEditorUI() {
  _buildLeftToolbar();
  _buildToolbar();    // правый сайдбар — доп. контролы
  _buildActions();
}

// ── Левый тулбар (инструменты, как в Photoshop) ──
function _buildLeftToolbar() {
  const tb = document.getElementById('pdf-left-toolbar');
  if (!tb) return;
  const T = (t) => pdfTool === t ? 'class="ps-ltool active"' : 'class="ps-ltool"';
  const ico = (id) => {
    if (id === 'ico-legend') return `<i class="fi fi-rr-list-check icon-lg"></i>`;
    if (id === 'ico-scale')  return `<i class="fi fi-rr-ruler-horizontal icon-lg"></i>`;
    return `<svg class="icon icon-lg"><use href="#${id}"/></svg>`;
  };
  tb.innerHTML = `
    <button class="ps-ltool" data-tip="Отменить (Ctrl+Z)" onclick="undoPdf()">${ico('ico-undo')}</button>
    <button class="ps-ltool" data-tip="Повторить (Ctrl+Y)" onclick="redoPdf()">${ico('ico-redo')}</button>
    <div class="ps-ltool-sep"></div>
    <button ${T('select')} id="pst-select" data-tip="Выбрать (V)" onclick="setPdfTool('select')">${ico('ico-cursor')}</button>
    <div class="ps-ltool-cap">фигуры</div>
    <button ${T('text')} id="pst-text" data-tip="Текст (T)" onclick="setPdfTool('text')">${ico('ico-text')}</button>
    <button ${T('rect')} id="pst-rect" data-tip="Прямоугольник (R)" onclick="setPdfTool('rect')">${ico('ico-rect')}</button>
    <button ${T('ellipse')} id="pst-ellipse" data-tip="Эллипс (E)" onclick="setPdfTool('ellipse')">${ico('ico-circle')}</button>
    <button ${T('line')} id="pst-line" data-tip="Линия (L)" onclick="setPdfTool('line')">${ico('ico-line')}</button>
    <button class="ps-ltool" id="pst-image" data-tip="Изображение" onclick="document.getElementById('ps-image-upload').click()">${ico('ico-image')}</button>
    <div class="ps-ltool-cap">линии</div>
    <button ${T('path')} id="pst-path" data-tip="Перо — прямые (P) | 2×клик = завершить" onclick="setPdfTool('path')">${ico('ico-path-pen')}</button>
    <button ${T('bezier')} id="pst-bezier" data-tip="Безье (B) | 2×клик = завершить" onclick="setPdfTool('bezier')">${ico('ico-bezier')}</button>
    <button ${T('freehand')} id="pst-freehand" data-tip="Карандаш (F)" onclick="setPdfTool('freehand')">${ico('ico-pencil')}</button>
    <button ${T('polygon-shape')} id="pst-polygon-shape" data-tip="Многоугольник" onclick="setPdfTool('polygon-shape')">${ico('ico-hex')}</button>
    <div class="ps-ltool-cap">выноски</div>
    <button ${T('callout')} id="pst-callout" data-tip="Выноска-облако — 1й клик=острие, 2й=бокс" onclick="setPdfTool('callout')">${ico('ico-bubble')}</button>
    <button ${T('leader')} id="pst-leader" data-tip="Выноска с полочкой — клик = остриё, полочка над ним. Стиль выбирается в свойствах" onclick="setPdfTool('leader')">${ico('ico-leader')}</button>
    <div class="ps-ltool-cap">элементы</div>
    <button class="ps-ltool" data-tip="Легенда" onclick="addPdfLegend()">${ico('ico-legend')}</button>
    <button class="ps-ltool" data-tip="Масштаб" onclick="addPdfScale()">${ico('ico-scale')}</button>
    <button class="ps-ltool" data-tip="Стрелка севера" onclick="addPdfNorth()">${ico('ico-north')}</button>
    <button class="ps-ltool" data-tip="Стрелка-указатель" onclick="createPdfObj('arrow',{name:'Стрелка'})">${ico('ico-pointer')}</button>
    <button class="ps-ltool" data-tip="Лупа — фрагмент карты" onclick="addPdfInset()">${ico('ico-inset')}</button>
  `;
}

// ── Правый сайдбар — доп. контролы ───────────────
function _buildToolbar() {
  const tb = document.getElementById('pdf-toolbar');
  const ico = (id) => `<svg class="icon icon-sm"><use href="#${id}"/></svg>`;
  tb.innerHTML = `
    <div class="ps-tb-row">
      <button class="ps-align-btn" onclick="zoomCanvas(-0.15)" title="Отдалить лист">${ico('ico-zoom-out')}</button>
      <button id="pdf-zoom-pct" class="ps-align-btn" style="flex:2;font-size:var(--fs-1)" onclick="resetCanvasZoom()" title="Вписать лист в окно">${ico('ico-fit')} ${Math.round(_zoomMul*100)}%</button>
      <button class="ps-align-btn" onclick="zoomCanvas(0.15)" title="Приблизить лист">${ico('ico-zoom-in')}</button>
    </div>
    <div class="ps-tb-row">
      <button class="ps-align-btn ${_gridEnabled?'active':''}" id="grid-btn" onclick="toggleGrid()">${ico('ico-grid')} Сетка</button>
      <button class="ps-align-btn ${_gridSnap?'active':''}" id="grid-snap-btn" onclick="toggleGridSnap()">${ico('ico-magnet')} Привязка</button>
    </div>
    <div class="ps-tb-row">
      <button class="orient-btn ${pdfOrientation==='landscape'?'active':''}" onclick="setPdfOrientation('landscape')">${ico('ico-landscape')} Альбом</button>
      <button class="orient-btn ${pdfOrientation==='portrait' ?'active':''}" onclick="setPdfOrientation('portrait')">${ico('ico-portrait')} Книжная</button>
    </div>
    <div class="ps-tb-row">
      <button class="orient-btn ${pdfFormat!=='A3'?'active':''}" onclick="setPdfFormat('A4')" title="297×210 мм">A4</button>
      <button class="orient-btn ${pdfFormat==='A3'?'active':''}" onclick="setPdfFormat('A3')" title="420×297 мм — вдвое больше места">A3</button>
    </div>
    <div class="ps-tb-checks">
      <label class="ps-tb-check">
        <input type="checkbox" id="snap-toggle" ${_snapEnabled?'checked':''} onchange="setSnapEnabled(this.checked)">${ico('ico-magnet')} Магнит к узлам
      </label>
      <label class="ps-tb-check">
        <input type="checkbox" id="pdf-no-fill-szz" onchange="toggleFills()"> Без заливки СЗЗ
      </label>
      <label class="ps-tb-check">
        <input type="checkbox" id="pdf-no-fill-zu"  onchange="toggleFills()"> Без заливки ЗУ
      </label>
    </div>
    <div class="ps-tb-label">Выноски на листе</div>
    <div class="ps-tb-row">
      <button class="ps-align-btn" style="flex:2;font-size:var(--fs-1)"
              onclick="autoArrangeFit({ targets:{emission:true,noise:true,other:true,mp:true,zu:true} })"
              title="Расставить так, чтобы всё поместилось на лист: подберёт шрифт, при нехватке места перейдёт на номера">
        ${ico('ico-tag')} Подобрать под лист</button>
      <button class="ps-align-btn" style="font-size:var(--fs-1)" onclick="openCalloutArrangeDialog()"
              title="Настройки расстановки">${ico('ico-sliders')}</button>
    </div>

    <div class="ps-tb-label">Выравнивание</div>
    <div class="ps-tb-row" style="flex-wrap:wrap">
      <button class="ps-align-btn" title="По левому краю"  onclick="alignPdfObj('left')">${ico('ico-align-l')}</button>
      <button class="ps-align-btn" title="По центру (гор)" onclick="alignPdfObj('cx')">${ico('ico-align-cx')}</button>
      <button class="ps-align-btn" title="По правому краю" onclick="alignPdfObj('right')">${ico('ico-align-r')}</button>
      <button class="ps-align-btn" title="По верху"        onclick="alignPdfObj('top')">${ico('ico-align-t')}</button>
      <button class="ps-align-btn" title="По центру (вер)" onclick="alignPdfObj('cy')">${ico('ico-align-cy')}</button>
      <button class="ps-align-btn" title="По низу"         onclick="alignPdfObj('bottom')">${ico('ico-align-b')}</button>
    </div>
  `;
  const pctBtn = document.getElementById('pdf-zoom-pct');
  if (pctBtn) pctBtn.innerHTML = `${ico('ico-fit')} ${Math.round(_zoomMul*100)}%`;
  const sb = document.getElementById('pdf-sat-btn');
  if (sb) {
    sb.innerHTML = pdfMapSat
      ? `${ico('ico-map-scheme')} Схема`
      : `${ico('ico-sat')} Спутник`;
    sb.classList.toggle('active', pdfMapSat);
  }
  const db = document.getElementById('pdf-drag-btn');
  if (db) {
    db.innerHTML = pdfMapDrag
      ? `${ico('ico-lock')} Зафиксировано`
      : `${ico('ico-hand')} Двигать`;
    db.classList.toggle('active', pdfMapDrag);
  }
  if (window.Workspace) Workspace.pdfToolbarBuilt();
}

function _buildActions() {
  // Кнопки PDF/PNG/Карта теперь в #pdf-sidebar-header (всегда видны)
  // Здесь только скрытый anchor для pdf-save-btn id (используется в renderPdf/exportPng)
  const existing = document.getElementById('pdf-save-btn');
  if (!existing) {
    const phantom = document.createElement('span');
    phantom.id = 'pdf-save-btn';
    phantom.style.display = 'none';
    document.getElementById('pdf-actions').appendChild(phantom);
  }
  document.getElementById('pdf-actions').style.display = 'none'; // прячем пустую зону
}

// ── Ориентация ────────────────────────────────────
function setPdfOrientation(o) {
  // Съём центра до смены layout-размера: invalidateSize() сам «подгоняет»
  // центр при ресайзе лишь приблизительно (сдвиг на половину разницы
  // ширины/высоты), а книжная/альбомная меняют ширину и высоту неравно —
  // отсюда видимый съезд карты при каждом переключении.
  const savedView = (typeof window._pdfCaptureView === 'function') ? window._pdfCaptureView() : null;
  pdfOrientation = o;
  if (typeof Store !== 'undefined') Store.set('pdfUi_orientation', o);
  _applyOrientation();
  _buildLeftToolbar();
  _buildToolbar();
  _buildActions();
  setTimeout(() => {
    if (!pdfMap) return;
    pdfMap.invalidateSize();
    if (savedView) { try { pdfMap.setView([savedView.lat, savedView.lon], savedView.zoom, { animate: false }); } catch(e) {} }
  }, 350);
}

// ── Формат листа (A4/A3) ───────────────────────────
window.setPdfFormat = function(fmt) {
  const savedView = (typeof window._pdfCaptureView === 'function') ? window._pdfCaptureView() : null;
  pdfFormat = fmt;
  if (typeof Store !== 'undefined') Store.set('pdfUi_format', fmt);
  _applyOrientation();
  _buildLeftToolbar();
  _buildToolbar();
  _buildActions();
  setTimeout(() => {
    if (!pdfMap) return;
    pdfMap.invalidateSize();
    if (savedView) { try { pdfMap.setView([savedView.lat, savedView.lon], savedView.zoom, { animate: false }); } catch(e) {} }
  }, 350);
  if (typeof _saveState === 'function') _saveState();
};

function _applyOrientation() {
  const canvas = document.getElementById('pdf-canvas');
  canvas.className = pdfOrientation;
  const { W, H } = _pdfCanvasSize();
  // CSS-классы .portrait/.landscape задают размер только под A4 — для A3
  // переопределяем инлайн-стилем (он всегда весомее классового правила)
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  // Масштабируем чтобы влезло в окно с отступами
  const wrap = document.getElementById('pdf-canvas-wrap');
  const maxW = wrap.clientWidth  - 48;
  const maxH = wrap.clientHeight - 48;
  if (maxW <= 0 || maxH <= 0) return; // layout ещё не готов
  const scale = Math.min(maxW / W, maxH / H, 1) * _zoomMul;
  canvas.style.transform = `scale(${scale})`;
  canvas.style.transformOrigin = 'center center';
}

// ── Инструменты ───────────────────────────────────
// Короткая подсказка в строке состояния: без неё непонятно, как работает
// каждый из четырёх типов выносок и чем завершается рисование
const TOOL_HINTS = {
  text:     'Текст: клик — блок по умолчанию, протяжка — блок нужного размера. 2× клик по объекту — правка текста',
  rect:     'Прямоугольник: протяните рамку. Shift — ровный квадрат',
  ellipse:  'Эллипс: протяните рамку. Shift — ровный круг',
  line:     'Линия: протяните. Shift — угол кратно 45°',
  path:     'Перо: клики по точкам. Завершить — двойной клик, Enter или правый клик. Esc — отмена',
  bezier:   'Кривая Безье: клики по опорным точкам. Завершить — двойной клик, Enter или правый клик',
  freehand: 'Карандаш: рисуйте с зажатой кнопкой мыши',
  'polygon-shape': 'Многоугольник: клики по вершинам. Замкнуть — клик по первой точке, двойной клик, Enter или правый клик',
  callout:  'Выноска-облако: 1-й клик — куда указывает остриё, 2-й клик — где встанет текстовый блок',
  leader:   'Выноска с полочкой: 1-й клик — на что указываем, 2-й клик — где встанет подпись. Стиль выбирается в свойствах',
  arrow:    'Стрелка: 1-й клик — начало, 2-й клик — куда указывает',
  inset:    'Лупа: врезка с фрагментом карты. Масштаб задаётся в свойствах',
  select:   '',
};

function setPdfTool(t) {
  // Прерываем активное рисование пути при смене инструмента
  if (_pathDraft) _clearPathGhost();
  pdfTool = t;
  document.querySelectorAll('[id^="pst-"]').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('pst-' + t);
  if (btn) btn.classList.add('active');
  const canvas = document.getElementById('pdf-canvas');
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';

  // Когда активен инструмент рисования — ни карта, ни её полигоны, ни выноски
  // не должны перехватывать события мыши, иначе клик не доходит до холста
  // и инструмент молча не срабатывает (класс .ps-drawing гасит их в CSS)
  const isDrawing = t !== 'select' && t !== 'image';
  canvas.classList.toggle('ps-drawing', isDrawing);
  const mapEl = document.getElementById('pdf-map');
  if (mapEl) mapEl.style.pointerEvents = isDrawing ? 'none' : '';

  const hint = TOOL_HINTS[t];
  if (hint) setSt(hint, 'ok');
}

// ── Создание объекта ──────────────────────────────
const OBJ_DEFAULTS = {
  text:    { w:220, h:52,  bg:'rgba(255,255,255,1)',    color:'#0f172a', fontSize:18, fontFamily:'Segoe UI', fontWeight:'700', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0,   shadow:false, strokeColor:'transparent', strokeW:0, content:'Заголовок', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, shelf:false },
  rect:    { w:160, h:90,  bg:'rgba(59,130,246,0.12)',  color:'#1e40af', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0,   shadow:false, strokeColor:'#3b82f6',     strokeW:2, content:'',          textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  ellipse: { w:140, h:90,  bg:'rgba(34,197,94,0.12)',   color:'#166534', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:999, shadow:false, strokeColor:'#22c55e',     strokeW:2, content:'',          textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  line:    { w:200, h:4,   bg:'transparent',             color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#ef4444', strokeW:4, content:'', textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  legend:  { w:240, h:130, bg:'rgba(255,255,255,1)',    color:'#0f172a', fontSize:13, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'left',   radius:0,   shadow:false, strokeColor:'transparent', strokeW:0, content:'__legend__', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, legendStyle:0 },
  scale:   { w:170, h:52,  bg:'rgba(255,255,255,1)',    color:'#0f172a', fontSize:12, fontFamily:'Segoe UI', fontWeight:'700', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0,   shadow:false, strokeColor:'transparent', strokeW:0, content:'__scale__',  textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  north:   { w:60,  h:60,  bg:'transparent',            color:'#0f172a', fontSize:10, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0,   shadow:false, strokeColor:'transparent', strokeW:0, content:'__north__',  textShadow:false, textStrokeColor:'transparent', textStrokeW:0, northStyle:0 },
  image:   { w:160, h:100, bg:'transparent',             color:'transparent', fontSize:12, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'transparent', strokeW:0, content:'',           textShadow:false, textStrokeColor:'transparent', textStrokeW:0, imgSrc:'', imgOpacity:1 },
  inset:   { w:340, h:230, bg:'#ffffff',                color:'#0f172a',     fontSize:11, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#334155',     strokeW:2, content:'__inset__',  textShadow:false, textStrokeColor:'transparent', textStrokeW:0, insetZoom:0 },
  arrow:   { w:200, h:30,  bg:'transparent',            color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#ef4444',     strokeW:3, content:'__arrow__',  textShadow:false, textStrokeColor:'transparent', textStrokeW:0, arrowDir:'end', rotation:0 },
  path:    { x:0,   y:0,  w:200, h:100, pts:[], closed:false, bg:'transparent', color:'transparent', fontSize:12, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#3b82f6', strokeW:3, content:'__path__',   textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0 },
  bezier:  { x:0,   y:0,  w:200, h:100, pts:[], closed:false, bg:'transparent', color:'transparent', fontSize:12, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#8b5cf6', strokeW:3, content:'__bezier__', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0 },
  callout: { x:200, y:200, w:160, h:56, tailX:120, tailY:320, bg:'rgba(255,255,255,1)',    color:'#0f172a', fontSize:13, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#334155', strokeW:2, content:'Выноска',    textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0 },
  leader:  { x:200, y:120, w:180, h:48, tailX:290, tailY:240, bg:'transparent', color:'#0f172a', fontSize:13, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'left', radius:0, shadow:false, strokeColor:'#0f172a', strokeW:1.5, content:'Подпись', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0 },
  'src-leader': { x:290, y:74,  w:120, h:48, kneeX:290, kneeY:122, tailX:290, tailY:170, bg:'transparent', color:'#333333', fontSize:13, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'left', radius:0, shadow:false, strokeColor:'#333333', strokeW:1.5, content:'Источник', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0, srcId:null, anchorType:'center' },
};

function _typeName(type) {
  return { text:'Текст', rect:'Прямоугольник', ellipse:'Эллипс', line:'Линия', legend:'Легенда', scale:'Масштаб', north:'Стрелка С', image:'Изображение', inset:'Лупа', arrow:'Стрелка', path:'Путь', bezier:'Кривая', callout:'Выноска', leader:'Выноска-полочка', 'src-leader':'Полочка источника', 'src-leader-emission':'Полочка выброс.', 'src-leader-noise':'Полочка шума' }[type] || type;
}

function createPdfObj(type, overrides = {}) {
  const canvas = document.getElementById('pdf-canvas');
  const W = canvas.offsetWidth || CANVAS_W_L;
  const H = canvas.offsetHeight || CANVAS_H_L;
  const defaults = OBJ_DEFAULTS[type] || OBJ_DEFAULTS.rect;
  const d = Object.assign({}, defaults, { x: Math.round(W/2 - defaults.w/2), y: Math.round(H/2 - defaults.h/2) }, overrides);

  // src-leader: kneeX/kneeY/tailX/tailY в дефолтах захардкожены под старую позицию —
  // пересчитываем их относительно реальной x/y, если не переданы явно в overrides
  if (type === 'src-leader') {
    if (!overrides.kneeX && !overrides.kneeY) { d.kneeX = d.x; d.kneeY = d.y + d.h; }
    if (!overrides.tailX && !overrides.tailY) { d.tailX = d.x; d.tailY = d.y + d.h + 60; }
  }

  const id  = 'pobj_' + (pdfObjCnt++);
  const obj = { id, type, name: overrides.name || _typeName(type), locked: false, visible: true, data: d };
  // Порядок наложения задаётся порядком массива: _renderAll() выводит объекты
  // подряд, поэтому последний в массиве лежит сверху. Раньше новый объект
  // вставлялся в начало (unshift), а его элемент дописывался в конец DOM —
  // до первой перерисовки он был сверху, а после неё уезжал под остальные.
  // Отсюда и «порядок иногда меняется сам».
  pdfObjects.push(obj);

  _renderObj(obj);
  selectPdfObj(id);
  _renderLayersList();
  _saveState();
  return obj;
}


// ── Расшифровка нумерованных подписей ───────────────────────────────────────
// Список «номер — название» ставится на лист обычными текстовыми блоками:
// их можно двигать, править и стилизовать, как любой другой текст.
window._pdfRemoveIndexBlocks = function() {
  // deletePdfObj() работает только с выделенным объектом, поэтому чистим сами
  const ids = pdfObjects.filter(o => o.data && o.data.isCalloutIndex).map(o => o.id);
  if (!ids.length) return 0;
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  pdfObjects = pdfObjects.filter(o => !(o.data && o.data.isCalloutIndex));
  if (ids.includes(pdfSelId)) pdfSelId = null;
  _renderLayersList(); _renderProps(); _saveState();
  return ids.length;
};

window._pdfBuildIndexBlocks = function(index) {
  if (!index || !index.length) return;
  _pdfRemoveIndexBlocks();
  const canvas = document.getElementById('pdf-canvas');
  const W = (canvas && canvas.offsetWidth)  || 794;
  const H = (canvas && canvas.offsetHeight) || 1123;

  // Раскладка колонок общая с резервом места под расшифровку в
  // autoArrangeCallouts (sources.js) — чтобы подписи заранее обходили то же
  // место, которое здесь займёт сама расшифровка
  const lay = window._indexBlockLayout(index, W, H);
  lay.rects.forEach((r, c) => {
    const part = index.slice(c * lay.perCol, (c + 1) * lay.perCol);
    if (!part.length) return;
    createPdfObj('text', {
      name: `Экспликация ${c + 1}`,
      isCalloutIndex: true,
      text: part.map(it => `${it.n} — ${it.name}`).join('\n'),
      x: r.x, y: r.y, w: r.w, h: r.h,
      fontSize: lay.fs,
      lineHeight: 1.3,
      align: 'left',
      color: '#111827',
      bg: 'rgba(255,255,255,.85)',
    });
  });
  _renderLayersList();
  _saveState();
  const fits = lay.totalW <= W;
  setSt(`Расшифровка: ${index.length} строк, ${lay.cols} колонк${lay.cols === 1 ? 'а' : 'и'} ` +
        `(${lay.totalW}×${Math.round(lay.colH)} px)` +
        (fits ? ' — блоки можно двигать и править как обычный текст'
              : ' — на лист по ширине не помещается, вынесите часть на отдельный лист'),
        fits ? 'ok' : 'err');
};

// ── Рендер одного объекта ─────────────────────────
// Порядок элементов в DOM = порядок наложения. Держим его равным порядку
// массива, иначе одиночная перерисовка объекта выбрасывала его наверх.
function _syncObjDomOrder() {
  const canvas = document.getElementById('pdf-canvas');
  if (!canvas) return;
  // appendChild на уже вставленном узле просто переставляет его, не пересоздавая,
  // поэтому лупы и их карты Leaflet при этом не страдают
  pdfObjects.forEach(o => {
    const el = document.getElementById(o.id);
    if (el) canvas.appendChild(el);
  });
}

function _renderObj(obj, skipOrder) {
  const canvas = document.getElementById('pdf-canvas');
  let el = document.getElementById(obj.id);
  if (!el) {
    el = document.createElement('div');
    el.id = obj.id;
    el.className = 'ps-obj ps-obj-' + obj.type;
    canvas.appendChild(el);
    _attachObjEvents(el, obj);
    // Элемент дописан в конец — вернём его на место, положенное по массиву
    if (!skipOrder) _syncObjDomOrder();
  }

  const d = obj.data;
  const _isSvgType = ['path','bezier','north','callout','leader','src-leader','arrow'].includes(obj.type);
  const _isShelf = !_isSvgType && obj.type === 'text' && d.shelf;
  el.style.cssText = `
    position:absolute;
    left:${d.x}px; top:${d.y}px;
    width:${d.w}px; height:${d.h}px;
    background:${_isSvgType ? 'transparent' : d.bg};
    border-radius:${_isShelf ? 0 : d.radius}px;
    border:${_isSvgType || _isShelf ? 'none' : d.strokeW > 0 ? `${d.strokeW}px solid ${d.strokeColor}` : 'none'};
    border-bottom:${_isShelf ? `${d.strokeW > 0 ? d.strokeW : 1.5}px solid ${d.strokeColor && d.strokeColor !== 'transparent' ? d.strokeColor : d.color || '#0f172a'}` : ''};
    box-shadow:${d.shadow && !_isSvgType ? '0 4px 14px rgba(0,0,0,0.18)' : 'none'};
    overflow:${_isSvgType ? 'visible' : 'hidden'};
    color:${d.color};
    font-size:${d.fontSize}px;
    font-family:${d.fontFamily};
    font-weight:${d.fontWeight};
    font-style:${d.fontStyle};
    text-decoration:${d.textDecoration};
    text-align:${d.textAlign};
    display:${obj.visible ? 'flex' : 'none'};
    align-items:center;
    justify-content:${d.textAlign==='left'?'flex-start':d.textAlign==='right'?'flex-end':'center'};
    box-sizing:border-box;
    cursor:${obj.locked ? 'not-allowed' : pdfTool==='select' ? 'grab' : 'crosshair'};
    z-index:${100 + pdfObjects.indexOf(obj)};
    text-shadow:${d.textShadow ? '1px 1px 0 #fff,-1px -1px 0 #fff,1px -1px 0 #fff,-1px 1px 0 #fff' : 'none'};
    -webkit-text-stroke:${(d.textStrokeW > 0) ? `${d.textStrokeW}px ${d.textStrokeColor || '#000'}` : '0'};
    padding:${d.type==='legend' ? '12px' : d.type==='scale' ? '5px 10px' : d.type==='text' ? '6px 12px' : '0'};
    user-select:none;
    transform:${d.rotation ? `rotate(${d.rotation}deg)` : 'none'};
    transform-origin:center center;
  `;
  el.classList.toggle('ps-selected', obj.id === pdfSelId);

  // Контент
  _renderObjContent(el, obj);

  // Хендлы изменения размера (только для выбранного)
  _updateHandles(el, obj);
}

function _renderObjContent(el, obj) {
  const d = obj.data;
  if (d.content === '__legend__') { el.innerHTML = _legendHtml(d); return; }
  if (d.content === '__scale__')  { el.innerHTML = _scaleHtml(d);  return; }
  if (d.content === '__north__')  { el.innerHTML = _northHtml(d);  return; }
  if (d.content === '__inset__')  { _initInsetMap(el, obj); if (_insetMaps[obj.id]) setTimeout(() => _insetMaps[obj.id].invalidateSize(), 80); return; }
  if (d.content === '__arrow__')  { el.innerHTML = _arrowHtml(obj); return; }
  if (d.content === '__path__')   { el.innerHTML = _renderPathSvg(obj);   return; }
  if (d.content === '__bezier__') { el.innerHTML = _renderBezierSvg(obj); return; }
  if (obj.type  === 'callout')    { el.innerHTML = _renderCalloutHtml(obj); return; }
  if (obj.type  === 'leader') { el.innerHTML = _renderLeaderHtml(obj); _scheduleLeaderFit(el, obj); return; }
  if (obj.type  === 'src-leader') { el.innerHTML = _renderSrcLeaderHtml(obj); _scheduleSrcLeaderFit(el, obj); return; }
  if (obj.type === 'image') {
    if (d.imgSrc && d.imgSrc !== '[img]') {
      el.innerHTML = `<img src="${d.imgSrc}" style="width:100%;height:100%;object-fit:contain;border-radius:${d.radius}px;opacity:${d.imgOpacity ?? 1};pointer-events:none">`;
    } else {
      el.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;border:1.5px dashed var(--tx2);border-radius:var(--r-sm);color:var(--tx2);font-size:var(--fs-1);text-align:center;padding:6px;box-sizing:border-box">Изображение отсутствует —<br>загрузите заново</div>`;
    }
    return;
  }
  // Текст — span с contenteditable. content может прийти из имени слоя/источника
  // (пользовательский ввод) — экранируем перед innerHTML
  el.innerHTML = `<span class="ps-text-content" style="width:100%;text-align:inherit;pointer-events:none;white-space:pre-wrap;word-break:break-word">${escapeHtml(d.content)}</span>`;
}

// Значки условных обозначений: вид выбирается для всей легенды
// (legendSymbolAll) и/или для отдельной строки (legendSymbols[id]).
// 'auto' — прежний вид раскладки (квадрат, у «Мин.» — полоса).
const LEGEND_SYMBOLS = [   // [вид, название, короткое — для кнопок]
  ['auto',    'Авто'],   ['square', 'Квадрат'], ['outline', 'Контур'], ['line', 'Полоса'],
  ['dash',    'Пунктир'],['circle', 'Круг'],    ['hatch',   'Штриховка', 'Штрих'], ['point', 'Точка'],
];

function _legendSymbolOf(d, it) {
  const m = d.legendSymbols || {};
  return m[it.id] || (it.legacyId && m[it.legacyId]) || d.legendSymbolAll || 'auto';
}

// SVG значка w×h. Цвета — из стиля слоя: обводка it.color, заливка it.bg
let _lgHatchSeq = 0;
function _legendSymbolSvg(it, kind, w, h) {
  const c = it.color || '#334155', bg = it.bg || 'transparent';
  const dash = it.brd === 'dashed' ? ' stroke-dasharray="4 2"' : it.brd === 'dotted' ? ' stroke-dasharray="1.5 1.5"' : '';
  const svg = inner => `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="flex-shrink:0;display:block;overflow:visible">${inner}</svg>`;
  const s = Math.min(w, h), x0 = (w - s) / 2, y0 = (h - s) / 2;
  switch (kind) {
    case 'outline': return svg(`<rect x="${x0+1}" y="${y0+1}" width="${s-2}" height="${s-2}" rx="1" fill="none" stroke="${c}" stroke-width="2"${dash}/>`);
    case 'line':    return svg(`<line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="${c}" stroke-width="${Math.max(3, Math.round(h/4))}" stroke-linecap="butt"/>`);
    case 'dash':    return svg(`<line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="${c}" stroke-width="${Math.max(2.5, Math.round(h/5))}" stroke-dasharray="5 3"/>`);
    case 'circle':  return svg(`<circle cx="${w/2}" cy="${h/2}" r="${s/2-1}" fill="${bg}" stroke="${c}" stroke-width="2"${dash}/>`);
    case 'point':   return svg(`<circle cx="${w/2}" cy="${h/2}" r="${Math.max(2.5, s/4)}" fill="${c}"/>`);
    case 'hatch': {
      // id уникален на каждый значок: одинаковые id в одном документе
      // склеиваются, и штриховка бралась бы у первого слоя
      const id = 'lgh' + (++_lgHatchSeq);
      return svg(`<defs><pattern id="${id}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
                 `<line x1="0" y1="0" x2="0" y2="4" stroke="${c}" stroke-width="1.4"/></pattern></defs>` +
                 `<rect x="${x0+1}" y="${y0+1}" width="${s-2}" height="${s-2}" fill="url(#${id})" stroke="${c}" stroke-width="2"${dash}/>`);
    }
    default:        // square
      return svg(`<rect x="${x0+1}" y="${y0+1}" width="${s-2}" height="${s-2}" rx="1" fill="${bg}" stroke="${c}" stroke-width="2"${dash}/>`);
  }
}

function _legendHtml(d) {
  const sty = d.legendStyle || 0;
  const fs = d.fontSize || 13;
  const fc = d.color || '#0f172a';
  const hidden = d.legendHidden || [];

  // Строки легенды: порядок и названия можно задать вручную в свойствах.
  // Скрытые ищем и по новому ключу, и по старому id — иначе в уже сохранённых
  // проектах спрятанные строки возвращались обратно
  const _isHidden = it => hidden.includes(it.id) || (it.legacyId && hidden.includes(it.legacyId));
  const items = _legendItems(d).filter(it => !_isHidden(it));

  // Полоса/пунктир шире квадрата — так они читаются как линия
  const swatch = (it, sz=16) => {
    const kind = _legendSymbolOf(d, it);
    if (kind === 'auto')
      return `<div style="width:${sz}px;height:${sz}px;flex-shrink:0;background:${it.bg};border:2px ${it.brd} ${it.color};border-radius:2px"></div>`;
    const wide = kind === 'line' || kind === 'dash';
    return _legendSymbolSvg(it, kind, wide ? Math.round(sz * 1.6) : sz, sz);
  };

  if (sty === 0) { // Стиль 1: Классический с заголовком
    let h = `<div style="padding:4px 0 2px;font-size:${fs+1}px;font-weight:700;color:${fc};border-bottom:1px solid ${fc}30;margin-bottom:4px">Условные обозначения</div>`;
    items.forEach(it => { h += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">${swatch(it)}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`; });
    return `<div style="padding:8px 10px;width:100%;box-sizing:border-box">${h}</div>`;
  }
  if (sty === 1) { // Стиль 2: Рамки вокруг каждой строки
    let h = `<div style="font-size:${fs}px;font-weight:700;color:${fc};margin-bottom:6px">Легенда</div>`;
    items.forEach(it => { h += `<div style="display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:var(--r-sm);border:1px solid ${it.color}40;margin-bottom:2px">${swatch(it)}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`; });
    return `<div style="padding:8px;width:100%;box-sizing:border-box">${h}</div>`;
  }
  if (sty === 2) { // Стиль 3: Минимальный (нет фона)
    let h = '';
    items.forEach(it => {
      const sym = _legendSymbolOf(d, it) === 'auto'
        ? `<div style="width:24px;height:3px;background:${it.color};flex-shrink:0"></div>` : swatch(it, 13);
      h += `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px">${sym}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`;
    });
    return `<div style="padding:6px 8px;width:100%;box-sizing:border-box">${h}</div>`;
  }
  if (sty === 3) { // Стиль 4: Горизонтальный компактный
    let h = '';
    items.forEach(it => { h += `<div style="display:inline-flex;align-items:center;gap:4px;margin:0 8px 4px 0">${swatch(it,12)}<span style="font-size:${fs-1}px;color:${fc}">${it.name}</span></div>`; });
    return `<div style="padding:6px 8px;width:100%;box-sizing:border-box;display:flex;flex-wrap:wrap">${h}</div>`;
  }
  if (sty === 4) { // Стиль 5: Таблица с сеткой
    let rows = items.map(it =>
      `<tr><td style="border:1px solid ${fc}55;padding:3px 6px;width:30px;text-align:center">${swatch(it,14).replace('flex-shrink:0','margin:0 auto')}</td>` +
      `<td style="border:1px solid ${fc}55;padding:3px 8px;font-size:${fs-1}px;color:${fc}">${it.name}</td></tr>`).join('');
    return `<div style="padding:8px 10px;width:100%;box-sizing:border-box">
      <div style="font-size:${fs}px;font-weight:700;color:${fc};text-align:center;margin-bottom:5px">Условные обозначения</div>
      <table style="border-collapse:collapse;width:100%">${rows}</table></div>`;
  }
  if (sty === 5) { // Стиль 6: Цветная шапка
    let h = items.map(it =>
      `<div style="display:flex;align-items:center;gap:6px;padding:2px 0">${swatch(it)}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`).join('');
    return `<div style="width:100%;box-sizing:border-box">
      <div style="background:${fc};color:#fff;font-size:${fs}px;font-weight:700;padding:5px 10px;letter-spacing:.4px">УСЛОВНЫЕ ОБОЗНАЧЕНИЯ</div>
      <div style="padding:7px 10px">${h}</div></div>`;
  }
  if (sty === 6) { // Стиль 7: ГОСТ — рамка вокруг блока
    let h = items.map(it =>
      `<div style="display:flex;align-items:center;gap:7px;margin-bottom:4px">${swatch(it)}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`).join('');
    return `<div style="width:100%;height:100%;box-sizing:border-box;border:1.6px solid ${fc};padding:8px 10px">
      <div style="font-size:${fs}px;font-weight:700;color:${fc};text-align:center;text-decoration:underline;text-underline-offset:3px;margin-bottom:7px;letter-spacing:.5px">УСЛОВНЫЕ ОБОЗНАЧЕНИЯ</div>${h}</div>`;
  }
  if (sty === 7) { // Стиль 8: Две колонки
    let h = items.map(it =>
      `<div style="display:flex;align-items:center;gap:5px;min-width:0">${swatch(it,13)}<span style="font-size:${fs-1}px;color:${fc};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.name}</span></div>`).join('');
    return `<div style="padding:7px 9px;width:100%;box-sizing:border-box">
      <div style="font-size:${fs}px;font-weight:700;color:${fc};margin-bottom:5px">Условные обозначения</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px">${h}</div></div>`;
  }
  return `<div style="padding:8px">${items.map(it => `<div style="display:flex;gap:5px;align-items:center;margin-bottom:3px">${swatch(it)}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`).join('')}</div>`;
}

// ── Масштабная линейка ───────────────────────────
// Ширину и подписи считаем сами по разрешению карты: раньше ширина бралась
// у контрола Leaflet (его может не быть → 80px), а «полоски» не рисовались
// вовсе — был просто П-образный уголок.
// Метров местности в одном пикселе листа — измеряем по факту, а не по
// сферической формуле Меркатора: на 62° с.ш. сфера врёт ~0.4 %, и масштаб
// с полоской уезжали на столько же.
function _mapMetersPerPx(m) {
  if (!m) return null;
  try {
    const c = m.getCenter();
    const a = m.latLngToContainerPoint(c);
    const b = m.containerPointToLatLng(a.add(L.point(200, 0)));
    const d = (typeof geodDist === 'function') ? geodDist(c, b) : c.distanceTo(b);
    if (d > 0) return d / 200;
  } catch(e) {}
  return null;
}

// Метры бумаги на 1 CSS-пиксель листа: A4 297 мм при ширине холста 1123 px
const PAPER_M_PER_PX = 0.297 / 1123;

// Подогнать зум карты редактора под точный масштаб 1:S
window.fitPdfMapToScale = function(S) {
  if (!pdfMap) return;
  const lat = pdfMap.getCenter().lat;
  const target = S * PAPER_M_PER_PX;                       // нужное м/пиксель
  let z = Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / target);
  pdfMap.setZoom(Math.max(1, Math.min(19, z)), { animate: false });
  // Уточняем по фактически измеренному разрешению (эллипсоид против сферы)
  const real = _mapMetersPerPx(pdfMap);
  if (real) {
    z = pdfMap.getZoom() + Math.log2(real / target);
    pdfMap.setZoom(Math.max(1, Math.min(19, z)), { animate: false });
  }
  setTimeout(() => {
    pdfObjects.filter(o => o.type === 'scale').forEach(o => _renderObj(o));
    _renderProps();
  }, 150);
  setSt(`Масштаб карты 1\u202F:\u202F${S.toLocaleString('ru')}`, 'ok');
};

function _scaleMetrics(d, mapInst) {
  const M = mapInst || pdfMap;             // лист или врезка-лупа
  const boxW = Math.max(60, (d.w || 170) - 12);
  let mPerPx = 0.5, ratio = 50000;
  if (M) {
    const lat = M.getCenter().lat;
    mPerPx = _mapMetersPerPx(M)
          || 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, M.getZoom());
    // Реальный знаменатель масштаба: 1 CSS-пиксель листа = 297 мм / 1123 px
    // (для книжной ориентации 210/794 — то же самое) = 0.00026447 м бумаги.
    // Раньше значение «примагничивалось» к ближайшему стандартному масштабу,
    // и подпись врала до 40 % — теперь округляем только до 2 значащих цифр.
    const raw = mPerPx / PAPER_M_PER_PX;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    ratio = Math.max(1, Math.round(raw / pow) * pow);
  }
  // Пользователь зафиксировал свой масштаб — показываем именно его
  if (d.scaleFixed && d.scaleCustom) ratio = d.scaleCustom;
  // Подбираем «круглую» длину, близкую к ширине объекта
  const rough = mPerPx * boxW;
  const pow   = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
  const nice  = [1, 2, 5, 10].map(k => k * pow)
    .filter(v => v / mPerPx <= boxW)
    .pop() || pow;
  const barPx = Math.max(30, nice / mPerPx);
  const label = nice >= 1000 ? (nice / 1000).toLocaleString('ru') + ' км' : nice.toLocaleString('ru') + ' м';
  const half  = nice / 2;
  const halfLabel = half >= 1000 ? (half / 1000).toLocaleString('ru') : String(half);
  return { barPx, nice, label, halfLabel, ratio, unit: nice >= 1000 ? 'км' : 'м' };
}

function _scaleHtml(d, mapInst) {
  const m = _scaleMetrics(d, mapInst);
  const c  = d.color || '#0f172a';
  const bg = (d.bg && d.bg !== 'transparent') ? d.bg : '#fff';
  const fs = d.fontSize || 12;
  const num = `1\u202F:\u202F${m.ratio.toLocaleString('ru')}`;
  const sty = d.scaleStyle || 0;
  const W = m.barPx;
  const lbl = (txt, left) =>
    `<span style="position:absolute;left:${left}px;transform:translateX(-50%);font-size:${fs - 2}px">${txt}</span>`;

  // Чередующиеся блоки (классическая картографическая линейка)
  const blocks = (n, h, alt) => {
    const seg = W / n;
    return Array.from({ length: n }, (_, i) =>
      `<div style="width:${seg}px;height:${h}px;background:${(i % 2 === 0) === alt ? c : bg};border:1px solid ${c};box-sizing:border-box;margin-left:${i ? -1 : 0}px"></div>`
    ).join('');
  };
  const ticksRow = `<div style="position:relative;height:${fs + 2}px;width:${W}px">
      ${lbl('0', 0)}${lbl(m.halfLabel, W / 2)}${lbl(m.label, W)}</div>`;

  const variants = [
    // 0 — блоки в один ряд + подписи (по умолчанию)
    `<div style="display:flex">${blocks(4, 7, true)}</div>${ticksRow}
     <div style="font-size:${fs}px;font-weight:700;margin-top:1px">${num}</div>`,
    // 1 — двухрядная «шахматка» ГОСТ
    `<div style="display:flex">${blocks(4, 5, true)}</div>
     <div style="display:flex;margin-top:-1px">${blocks(4, 5, false)}</div>${ticksRow}
     <div style="font-size:${fs}px;font-weight:700;margin-top:1px">${num}</div>`,
    // 2 — линия с засечками
    `<div style="position:relative;width:${W}px;height:10px">
       <div style="position:absolute;left:0;top:5px;width:${W}px;height:2px;background:${c}"></div>
       ${[0, 0.5, 1].map(k => `<div style="position:absolute;left:${W * k}px;top:0;width:2px;height:12px;background:${c}"></div>`).join('')}
     </div>${ticksRow}
     <div style="font-size:${fs}px;font-weight:700;margin-top:1px">${num}</div>`,
    // 3 — только полоска с подписью справа
    `<div style="display:flex;align-items:center;gap:6px">
       <div style="display:flex">${blocks(2, 7, true)}</div>
       <span style="font-size:${fs}px;font-weight:700">${m.label}</span>
     </div>`,
    // 4 — только численный масштаб
    `<div style="font-size:${fs + 2}px;font-weight:700">${num}</div>`,
    // 5 — численный + именованный
    `<div style="font-size:${fs}px;font-weight:700">${num}</div>
     <div style="font-size:${fs - 2}px">в 1 см ${(m.ratio / 100 >= 1000
        ? (m.ratio / 100000).toLocaleString('ru') + ' км'
        : (m.ratio / 100).toLocaleString('ru') + ' м')}</div>`,
    // 6 — как было раньше: численный масштаб и П-образная скоба
    `<span style="font-size:${fs}px;font-weight:700">${num}</span>
     <div class="ps-scale-bar" style="width:${W}px;height:5px;margin-top:2px;
          border-top:2px solid ${c};border-left:2px solid ${c};border-right:2px solid ${c}"></div>`,
  ];
  return `<div class="ps-scale-content" style="color:${c};display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%">
    ${variants[sty] || variants[0]}
  </div>`;
}

// Плашка масштаба внутри лупы — в отличие от бейджа «Фрагмент» она
// печатается: врезка на листе должна нести собственный масштаб.
function _insetScalePlate(obj, imap) {
  const box = document.getElementById('iscale_' + obj.id);
  if (!box) return;
  if (obj.data.insetShowScale === false) { box.style.display = 'none'; return; }
  box.style.display = '';
  const cfg = _insetScaleCfg(obj);
  box.style.background = cfg.bg;
  box.style.padding = '2px 5px';
  // Тот же генератор, что у масштаба листа: стили, шрифт и цвет ведут себя одинаково
  box.innerHTML = _scaleHtml(cfg, imap);
}

// Настройки плашки лупы: свои, но с теми же полями, что у объекта «Масштаб»
function _insetScaleCfg(obj) {
  const d = obj.data.insetScale || {};
  return {
    w: Math.max(70, Math.min(150, (obj.data.w || 340) * 0.42)),
    scaleStyle: d.scaleStyle ?? 0,
    fontSize:   d.fontSize   ?? 9,
    color:      d.color      || '#111827',
    bg:         d.bg         || 'rgba(255,255,255,.88)',
    scaleFixed: d.scaleFixed || false,
    scaleCustom: d.scaleCustom || 0,
  };
}

// Изменить настройку плашки лупы
window.setInsetScaleOpt = function(key, value) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'inset') return;
  if (!obj.data.insetScale) obj.data.insetScale = {};
  obj.data.insetScale[key] = value;
  const imap = _insetMaps[obj.id];
  if (imap) _insetScalePlate(obj, imap);
  _renderProps();
  _saveState();
};

window.toggleInsetScale = function(on) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'inset') return;
  obj.data.insetShowScale = !!on;
  const imap = _insetMaps[obj.id];
  if (imap) _insetScalePlate(obj, imap);
  _saveState();
};

// ── Масштаб лупы ────────────────────────────────────────────────────────────
// Лупа лежит на том же листе, поэтому знаменатель считается так же, как у карты
function _insetScale(obj) {
  const imap = _insetMaps[obj.id];
  if (!imap) return null;
  const lat = imap.getCenter().lat;
  const mPerPx = _mapMetersPerPx(imap)
              || 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, imap.getZoom());
  const raw = mPerPx / PAPER_M_PER_PX;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
  return Math.max(1, Math.round(raw / pow) * pow);
}

window.applyInsetScale = function() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  const inp = document.getElementById('pp-inset-scale');
  if (!obj || obj.type !== 'inset' || !inp) return;
  const imap = _insetMaps[obj.id];
  if (!imap) return;
  const S = Math.round(parseFloat(inp.value));
  if (!isFinite(S) || S < 50) { setSt('Введите масштаб от 1:50 и крупнее', 'err'); return; }
  const lat = imap.getCenter().lat;
  const target = S * PAPER_M_PER_PX;
  let z = Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / target);
  imap.setZoom(Math.max(1, Math.min(19, z)), { animate: false });
  const realI = _mapMetersPerPx(imap);
  if (realI) imap.setZoom(Math.max(1, Math.min(19, imap.getZoom() + Math.log2(realI / target))), { animate: false });
  obj.data.insetSavedZoom = imap.getZoom();
  _saveState();
  setTimeout(_renderProps, 120);
  setSt(`Масштаб лупы 1\u202F:\u202F${S.toLocaleString('ru')}`, 'ok');
};

// Показать в лупе активный слой целиком
window.insetFitToLayer = function() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'inset') return;
  const imap = _insetMaps[obj.id];
  const al = typeof getActiveLayer === 'function' ? getActiveLayer() : null;
  if (!imap || !al || !al.layer || !al.layer.getBounds) { setSt('Выберите слой с полигоном на карте', 'err'); return; }
  try {
    imap.invalidateSize(false);
    imap.fitBounds(al.layer.getBounds(), { padding: [10, 10], animate: false });
    const c = imap.getCenter();
    obj.data.insetSavedLat = c.lat; obj.data.insetSavedLon = c.lng; obj.data.insetSavedZoom = imap.getZoom();
    _saveState(); setTimeout(_renderProps, 120);
  } catch(e) {}
};

// Свой масштаб: подгоняем карту под введённое значение
window.applyCustomScale = function() {
  const inp = document.getElementById('pp-scale-custom');
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!inp || !obj) return;
  const S = Math.round(parseFloat(inp.value));
  if (!isFinite(S) || S < 50) { setSt('Введите масштаб от 1:50 и крупнее', 'err'); return; }
  obj.data.scaleCustom = S;
  if (obj.data.scaleFixed) {           // просто подписываем, карту не трогаем
    _renderObj(obj); _saveState();
    setSt(`Подпись масштаба: 1\u202F:\u202F${S.toLocaleString('ru')} (карта не менялась)`, 'ok');
  } else {
    fitPdfMapToScale(S);               // подгоняем зум карты под масштаб
    _saveState();
  }
};

// Режим «подпись важнее карты»: показываем введённое значение как есть
window.toggleFixedScale = function(on) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.data.scaleFixed = !!on;
  if (on && !obj.data.scaleCustom) obj.data.scaleCustom = _scaleMetrics(obj.data).ratio;
  _renderObj(obj); _renderProps(); _saveState();
};

window.applyScaleStyle = function(s) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'scale') return;
  obj.data.scaleStyle = s;
  _renderObj(obj); _renderProps(); _saveState();
};

function _northHtml(d) {
  const c = d.color || '#0f172a';
  const bg = (d.bg && d.bg !== 'transparent') ? d.bg : '#fff';
  const s = d.northStyle || 0;

  // Буква (по центру по X), y — базовая линия
  const T = (y, size, txt = 'С', fill = c, extra = '') =>
    `<text x="20" y="${y}" font-size="${size}" font-weight="bold" font-family="Arial, sans-serif" fill="${fill}" text-anchor="middle" ${extra}>${txt}</text>`;

  // Роза: 4 главных луча (каждый — тёмная/светлая половины), центр 20,23
  const rose4 = (len, hw) => [0, 90, 180, 270].map(a =>
    `<g transform="rotate(${a} 20 23)">
       <polygon points="20,${23 - len} ${20 - hw},23 20,23" fill="${c}"/>
       <polygon points="20,${23 - len} ${20 + hw},23 20,23" fill="${bg}" stroke="${c}" stroke-width="0.8"/>
     </g>`).join('');
  // Диагональные лучи (сплошные, короче)
  const rose4d = (len, hw) => [45, 135, 225, 315].map(a =>
    `<g transform="rotate(${a} 20 23)"><polygon points="20,${23 - len} ${20 - hw},23 ${20 + hw},23" fill="${c}"/></g>`).join('');
  // Деления по кругу
  const ticks = (r1, r2) => [0, 45, 90, 135, 180, 225, 270, 315].map(a =>
    `<g transform="rotate(${a} 20 23)"><line x1="20" y1="${23 - r2}" x2="20" y2="${23 - r1}" stroke="${c}" stroke-width="0.8"/></g>`).join('');

  const svgs = [
    // 0 — Классическая игла: половина залита, половина белая
    T(9, 9) +
    `<polygon points="20,12 14,36 20,30" fill="${c}"/>
     <polygon points="20,12 26,36 20,30" fill="${bg}" stroke="${c}" stroke-width="1"/>`,

    // 1 — Компас: игла С–Ю в круге
    T(8, 8) +
    `<circle cx="20" cy="24" r="12.5" fill="${bg}" stroke="${c}" stroke-width="1.3"/>
     <polygon points="20,13.5 23.2,24 16.8,24" fill="${c}"/>
     <polygon points="20,34.5 23.2,24 16.8,24" fill="${bg}" stroke="${c}" stroke-width="0.9"/>
     <circle cx="20" cy="24" r="1.4" fill="${c}"/>`,

    // 2 — Простая стрелка
    T(9, 9) +
    `<line x1="20" y1="36" x2="20" y2="17" stroke="${c}" stroke-width="2"/>
     <polygon points="20,11 25,20.5 20,18 15,20.5" fill="${c}"/>`,

    // 3 — Роза 4 румба
    T(6.5, 6.5) + rose4(14, 2.6) + `<circle cx="20" cy="23" r="1.5" fill="${c}"/>`,

    // 4 — Роза 8 румбов (классическая картографическая)
    T(6.5, 6.5) + rose4d(9, 1.5) + rose4(14, 2.6) + `<circle cx="20" cy="23" r="1.5" fill="${c}"/>`,

    // 5 — Роза в круге с делениями
    T(6.5, 6.5) +
    `<circle cx="20" cy="23" r="13.5" fill="${bg}" stroke="${c}" stroke-width="1.2"/>` +
    ticks(11, 13.5) + rose4(10.5, 2.1) + `<circle cx="20" cy="23" r="1.3" fill="${c}"/>`,

    // 6 — Тонкая картографическая игла
    T(8.5, 8.5) +
    `<polygon points="20,11 17,34 20,30" fill="${c}"/>
     <polygon points="20,11 23,34 20,30" fill="${bg}" stroke="${c}" stroke-width="0.9"/>`,

    // 7 — Значок в круге
    `<circle cx="20" cy="21" r="15" fill="${bg}" stroke="${c}" stroke-width="1.5"/>
     <polygon points="20,9 24.5,25 20,21.5 15.5,25" fill="${c}"/>` +
    T(32.5, 8),

    // 8 — Двойной шеврон
    T(9, 9) +
    `<polyline points="13,32 20,13 27,32" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
     <polyline points="15,38 20,25 25,38" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity="0.45"/>`,

    // 9 — Минимализм: засечка-точка и линия
    T(11, 11, 'С', c, 'font-family="Georgia, serif"') +
    `<line x1="20" y1="34" x2="20" y2="15" stroke="${c}" stroke-width="1.4"/>
     <circle cx="20" cy="34" r="2" fill="${c}"/>`,

    // 10 — Игла С–Ю с буквами
    T(8, 8) +
    `<polygon points="20,11 16.5,23 20,23" fill="${c}"/>
     <polygon points="20,11 23.5,23 20,23" fill="${bg}" stroke="${c}" stroke-width="0.9"/>
     <polygon points="20,35 16.5,23 20,23" fill="${bg}" stroke="${c}" stroke-width="0.9"/>
     <polygon points="20,35 23.5,23 20,23" fill="${c}"/>` +
    T(39.5, 6, 'Ю', c, 'opacity="0.6"'),

    // 11 — Современный треугольник
    `<polygon points="20,7 29,31 20,26 11,31" fill="${c}"/>` +
    T(24, 8, 'С', bg) +
    `<line x1="11" y1="35" x2="29" y2="35" stroke="${c}" stroke-width="1.2"/>`,
  ];
  return `<svg class="ps-north-svg" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">${svgs[s] || svgs[0]}</svg>`;
}

// ── Хендлы изменения размера ──────────────────────
const HANDLES = ['nw','n','ne','e','se','s','sw','w'];

function _updateHandles(el, obj) {
  el.querySelectorAll('.ps-handle').forEach(h => h.remove());
  if (obj.id !== pdfSelId || obj.locked) return;

  // Путь, кривая, многоугольник и кисть: точки правятся по отдельности, но
  // менять размер фигуры целиком тоже нужно — раньше функция выходила здесь
  // и обычных ручек они не получали вовсе.
  if (['path','bezier'].includes(obj.type)) {
    _renderPathHandles(el, obj);
    // дальше добавляются стандартные ручки размера
  } else
  // Выноска / Полочка — хендл хвоста + стандартные
  if (obj.type === 'callout' || obj.type === 'leader' || obj.type === 'src-leader') {
    _renderCalloutHandles(el, obj);
    if (obj.type === 'src-leader') {
      // Полочке источника ресайз не нужен (ширина по тексту), но поворот — как у всех
      const rl = document.createElement('div');
      rl.className = 'ps-handle ps-rotate-handle';
      rl.title = 'Поворот (Shift = шаг 15°)';
      el.appendChild(rl);
      rl.addEventListener('pointerdown', e => _onRotateStart(e, obj));
      return;
    }
  }

  // Стрелка: концы задают направление и длину сразу, но тянуть оба конца,
  // чтобы просто повернуть или укоротить, неудобно — поэтому рядом ручка
  // поворота (длина сохраняется) и ручка длины (угол сохраняется).
  if (obj.type === 'arrow') {
    const ap = _arrowPts(obj.data);
    [[1, ap.x1, ap.y1, 'Начало стрелки'], [2, ap.x2, ap.y2, 'Остриё стрелки']].forEach(([which, px, py, title]) => {
      const hEl = document.createElement('div');
      hEl.className = 'ps-handle ps-arrow-end';
      hEl.style.left = (px - obj.data.x - 9) + 'px';   // половина ручки в 18 px
      hEl.style.top  = (py - obj.data.y - 9) + 'px';
      hEl.title = title + ' (Shift — кратно 45°)';
      el.appendChild(hEl);
      hEl.addEventListener('pointerdown', ev => _onArrowEndDrag(ev, obj, which));
    });

    const mx = (ap.x1 + ap.x2) / 2, my = (ap.y1 + ap.y2) / 2;
    const ang = Math.atan2(ap.y2 - ap.y1, ap.x2 - ap.x1);
    // Обе ручки уводим от линии по нормали, чтобы они не лезли под остриё
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    const put = (cls, off, title, mode) => {
      const hEl = document.createElement('div');
      hEl.className = 'ps-handle ' + cls;
      hEl.style.left = (mx + nx * off - obj.data.x - 9) + 'px';
      hEl.style.top  = (my + ny * off - obj.data.y - 9) + 'px';
      hEl.title = title;
      el.appendChild(hEl);
      hEl.addEventListener('pointerdown', ev => _onArrowTransform(ev, obj, mode));
    };
    put('ps-arrow-rot', -22, 'Поворот вокруг середины (Shift — шаг 15°)', 'rotate');
    put('ps-arrow-len',      22, 'Длина: тянуть от середины', 'scale');
    return;
  }

  // Стандартные resize-хендлы
  HANDLES.forEach(h => {
    const hEl = document.createElement('div');
    hEl.className = 'ps-handle';
    hEl.dataset.h = h;
    el.appendChild(hEl);
    hEl.addEventListener('pointerdown', e => _onResizeStart(e, obj, h));
  });

  // Ручка поворота
  const rEl = document.createElement('div');
  rEl.className = 'ps-handle ps-rotate-handle';
  rEl.title = 'Поворот (Shift = шаг 15°)';
  el.appendChild(rEl);
  rEl.addEventListener('pointerdown', e => _onRotateStart(e, obj));
}

// ── Pointer Events для drag/resize ───────────────
function _attachObjEvents(el, obj) {
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('ps-handle')) return; // handled separately
    if (pdfTool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();

    // src-leader: тяга за полочку (текст) — двигает весь объект как обычный drag
    if (obj.type === 'src-leader' && e.target.closest('.leader-text-inner') && !obj.locked) {
      if (pdfSelId !== obj.id) selectPdfObj(obj.id);
      _pushUndo();
      const startX = e.clientX, startY = e.clientY;
      const ox  = obj.data.x,   oy  = obj.data.y;
      const okx = obj.data.kneeX ?? obj.data.x;
      const oky = obj.data.kneeY ?? (obj.data.y + obj.data.h);
      el.setPointerCapture(e.pointerId);
      function onMoveKnee(ev) {
        const canvas = document.getElementById('pdf-canvas');
        const rect   = canvas.getBoundingClientRect();
        const scaleX = canvas.offsetWidth  / rect.width;
        const scaleY = canvas.offsetHeight / rect.height;
        const dx = Math.round((ev.clientX - startX) * scaleX);
        const dy = Math.round((ev.clientY - startY) * scaleY);
        obj.data.x = ox + dx;  obj.data.y = oy + dy;
        obj.data.kneeX = okx + dx;  obj.data.kneeY = oky + dy;
        el.style.left = obj.data.x + 'px';
        el.style.top  = obj.data.y + 'px';
        _renderObjContent(el, obj);
        _updateHandles(el, obj);
      }
      function onUpKnee() {
        el.removeEventListener('pointermove', onMoveKnee);
        el.removeEventListener('pointerup',   onUpKnee);
        _saveState();
      }
      el.addEventListener('pointermove', onMoveKnee);
      el.addEventListener('pointerup',   onUpKnee);
      return;
    }

    // Shift или Ctrl+клик — добавить/убрать из выделения, без перетаскивания
    if (e.shiftKey || e.ctrlKey || e.metaKey) { togglePdfMultiSel(obj.id); return; }

    // Выбрать
    if (pdfSelId !== obj.id) selectPdfObj(obj.id);
    if (obj.locked) return;

    // Drag (вся группа, если объект в группе или в множественном выделении)
    _pushUndo();
    const startX = e.clientX, startY = e.clientY;
    const ox = obj.data.x, oy = obj.data.y;
    const origPts  = obj.data.pts  ? obj.data.pts.map(p => ({...p})) : null;
    const origArrow = obj.type === 'arrow' ? { ..._arrowPts(obj.data) } : null;
    const origTailX = obj.data.tailX, origTailY = obj.data.tailY;
    const origKneeX = obj.data.kneeX, origKneeY = obj.data.kneeY;
    const members = _groupMembers(obj).filter(o => o.id !== obj.id && !o.locked);
    const base = {};
    members.forEach(o => { base[o.id] = {
      x: o.data.x, y: o.data.y,
      pts: o.data.pts ? o.data.pts.map(p => ({...p})) : null,
      tailX: o.data.tailX, tailY: o.data.tailY,
      kneeX: o.data.kneeX, kneeY: o.data.kneeY,
    }; });
    el.setPointerCapture(e.pointerId);

    function onMove(ev) {
      const canvas = document.getElementById('pdf-canvas');
      const rect   = canvas.getBoundingClientRect();
      const scaleX = canvas.offsetWidth  / rect.width;
      const scaleY = canvas.offsetHeight / rect.height;
      const nx = Math.round(ox + (ev.clientX - startX) * scaleX);
      const ny = Math.round(oy + (ev.clientY - startY) * scaleY);
      const snapped = _snapObject(obj, nx, ny);
      const dx = snapped.x - ox, dy = snapped.y - oy;
      obj.data.x = snapped.x;
      obj.data.y = snapped.y;
      // Двигаем точки пути
      if (origPts)           obj.data.pts  = origPts.map(p => ({ x: p.x + dx, y: p.y + dy }));
      // Стрелка: концы едут вместе с коробкой
      if (obj.type === 'arrow' && origArrow) {
        obj.data.ax1 = origArrow.x1 + dx; obj.data.ay1 = origArrow.y1 + dy;
        obj.data.ax2 = origArrow.x2 + dx; obj.data.ay2 = origArrow.y2 + dy;
        _renderObjContent(el, obj);
      }
      // src-leader: tail stays fixed on source; move knee with box
      if (origTailX !== undefined && obj.type !== 'src-leader') { obj.data.tailX = origTailX + dx; obj.data.tailY = origTailY + dy; }
      if (obj.type === 'src-leader' && origKneeX !== undefined) {
        obj.data.kneeX = origKneeX + dx;
        obj.data.kneeY = origKneeY + dy;
        _syncSrcLeaderPos(obj);
      }
      el.style.left = obj.data.x + 'px';
      el.style.top  = obj.data.y + 'px';
      if (['path','bezier','callout','src-leader'].includes(obj.type)) { _renderObjContent(el, obj); _updateHandles(el, obj); }
      members.forEach(o => _moveObjBy(o, dx, dy, base));
      _syncPropsXY();
      if (_insetMaps[obj.id]) _insetMaps[obj.id].invalidateSize();
    }
    function onUp() {
      _clearSnapGuides();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      _saveState();
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  });

  // Правый клик — контекстное меню
  el.addEventListener('contextmenu', e => {
    if (pdfTool !== 'select') return;
    selectPdfObj(obj.id);
    _showContextMenu(e, obj);
  });

  // Двойной клик — редактировать текст
  el.addEventListener('dblclick', e => {
    if (obj.locked) return;
    e.stopPropagation();

    // Выноска / Выноска-полочка — редактировать текст
    if (obj.type === 'callout' || obj.type === 'leader' || obj.type === 'src-leader') {
      const sel = obj.type === 'callout' ? '.callout-text-inner' : '.leader-text-inner';
      const div = el.querySelector(sel);
      if (!div) return;
      div.style.pointerEvents = 'auto';
      div.style.userSelect = 'text';
      div.contentEditable = 'true';
      div.focus();
      const range = document.createRange();
      range.selectNodeContents(div);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      div.onblur = () => {
        div.contentEditable = 'false';
        // src-leader: полочка остаётся кликабельной для перетаскивания
        div.style.pointerEvents = obj.type === 'src-leader' ? 'auto' : 'none';
        div.style.userSelect = 'none';
        if (obj.type === 'src-leader') div.style.cursor = 'grab';
        obj.data.content = div.textContent;
        _saveState();
      };
      return;
    }

    // Обычный текст
    const span = el.querySelector('.ps-text-content');
    if (!span) return;
    span.style.pointerEvents = 'auto';
    span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    span.onblur = () => {
      span.contentEditable = 'false';
      span.style.pointerEvents = 'none';
      obj.data.content = span.textContent;
      _saveState();
    };
  });
}

function _onResizeStart(e, obj, handle) {
  e.stopPropagation();
  e.preventDefault();
  const el = document.getElementById(obj.id);
  const startX = e.clientX, startY = e.clientY;
  const ox = obj.data.x, oy = obj.data.y;
  const ow = obj.data.w, oh = obj.data.h;

  el.setPointerCapture(e.pointerId);

  const canvas = document.getElementById('pdf-canvas');
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.offsetWidth  / rect.width;
  const scaleY = canvas.offsetHeight / rect.height;
  const W = canvas.offsetWidth, H = canvas.offsetHeight;

  // Точки ломаной хранятся в координатах листа, а не внутри коробки, поэтому
  // при изменении размера их надо тянуть самим — иначе коробка растёт, а
  // фигура внутри остаётся прежней.
  const pts0 = obj.data.pts ? obj.data.pts.map(p => ({ ...p })) : null;

  // Типы, требующие перерисовки контента при каждом изменении размера
  const svgTypes = ['path', 'bezier', 'callout', 'leader'];
  const svgContents = ['__path__', '__bezier__', '__arrow__', '__legend__', '__scale__', '__north__'];
  const needsRerender = svgTypes.includes(obj.type) || svgContents.includes(obj.data.content);

  function onMove(ev) {
    const dx = (ev.clientX - startX) * scaleX;
    const dy = (ev.clientY - startY) * scaleY;
    let nx = ox, ny = oy, nw = ow, nh = oh;

    if (handle.includes('e'))  nw = Math.max(40, ow + dx);
    if (handle.includes('s'))  nh = Math.max(20, oh + dy);
    if (handle.includes('w')) { nx = ox + dx; nw = Math.max(40, ow - dx); }
    if (handle.includes('n')) { ny = oy + dy; nh = Math.max(20, oh - dy); }

    // Shift — сохранять пропорции (aspect ratio)
    if (ev.shiftKey && ow > 0 && oh > 0) {
      const ar = ow / oh;
      if (['se','sw','ne','nw'].includes(handle)) {
        const dw = Math.abs(nw - ow), dh = Math.abs(nh - oh);
        if (dw >= dh) {
          nh = Math.max(20, Math.round(nw / ar));
          if (handle.includes('n')) ny = oy + oh - nh;
        } else {
          nw = Math.max(40, Math.round(nh * ar));
          if (handle.includes('w')) nx = ox + ow - nw;
        }
      } else if (handle === 'e' || handle === 'w') {
        nh = Math.max(20, Math.round(nw / ar));
      } else if (handle === 'n' || handle === 's') {
        nw = Math.max(40, Math.round(nh * ar));
        if (handle === 'n') ny = oy + oh - nh;
      }
    }

    // Примагничивание (snap) к границам страницы при resize
    _clearSnapGuides();
    if (handle.includes('e') && Math.abs(nx + nw - W) < SNAP_DIST) {
      nw = W - nx; _showGuide('v', W);
    }
    if (handle.includes('s') && Math.abs(ny + nh - H) < SNAP_DIST) {
      nh = H - ny; _showGuide('h', H);
    }
    if (handle.includes('w') && Math.abs(nx) < SNAP_DIST) {
      nw = Math.max(40, nw + nx); nx = 0; _showGuide('v', 0);
    }
    if (handle.includes('n') && Math.abs(ny) < SNAP_DIST) {
      nh = Math.max(20, nh + ny); ny = 0; _showGuide('h', 0);
    }

    // Жёсткий clamp — объект не выходит за страницу (изображения — можно)
    if (obj.type !== 'image') {
      if (handle.includes('w') && nx < 0) { nw = Math.max(40, nw + nx); nx = 0; }
      if (handle.includes('n') && ny < 0) { nh = Math.max(20, nh + ny); ny = 0; }
      nw = Math.min(nw, W - nx);
      nh = Math.min(nh, H - ny);
    }

    obj.data.x = Math.round(nx); obj.data.y = Math.round(ny);
    obj.data.w = Math.round(nw); obj.data.h = Math.round(nh);
    // Тянем точки фигуры за коробкой пропорционально: ломаная, многоугольник
    // и кисть меняют размер целиком, а не только рамку вокруг себя.
    if (pts0 && ow > 0 && oh > 0) {
      const kx = nw / ow, ky = nh / oh;
      obj.data.pts = pts0.map(p => ({ ...p,
        x: Math.round(nx + (p.x - ox) * kx),
        y: Math.round(ny + (p.y - oy) * ky) }));
    }
    el.style.left = obj.data.x+'px'; el.style.top = obj.data.y+'px';
    el.style.width = obj.data.w+'px'; el.style.height = obj.data.h+'px';
    if (needsRerender) {
      _renderObjContent(el, obj);
      _updateHandles(el, obj);
    }
    _syncPropsAll();
  }
  function onUp() {
    _clearSnapGuides();
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    // Перерисовать контент и восстановить ручки после завершения resize
    _renderObjContent(el, obj);
    _updateHandles(el, obj);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

// ── Draw tool (рисование на канвасе) ─────────────
function _initCanvasDrawing() {
  const canvas = document.getElementById('pdf-canvas');
  if (!canvas || canvas._canvasDrawBound) return;
  canvas._canvasDrawBound = true;

  canvas.addEventListener('pointerdown', e => {
    if (pdfTool === 'select' || pdfTool === 'image') return;
    if (pdfMapDrag) return;
    if (e.target.closest('#pdf-map')) return;
    if (e.target.classList.contains('ps-obj') || e.target.closest('.ps-obj')) return;
    // Path-инструменты работают через click/dblclick, кроме freehand
    if (['path','bezier','polygon-shape','callout','leader','arrow'].includes(pdfTool)) return;
    // Freehand — начинаем запись
    if (pdfTool === 'freehand') {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.offsetWidth/rect.width, sy = canvas.offsetHeight/rect.height;
      const x = Math.round((e.clientX-rect.left)*sx);
      const y = Math.round((e.clientY-rect.top)*sy);
      _pathDraft = { type:'freehand', pts:[{x,y}], freehand:true };
      _showPathGhost();
      canvas.setPointerCapture(e.pointerId);
      const mmFree = ev => {
        const rr = canvas.getBoundingClientRect();
        _pathDraft.pts.push({ x:Math.round((ev.clientX-rr.left)*(canvas.offsetWidth/rr.width)), y:Math.round((ev.clientY-rr.top)*(canvas.offsetHeight/rr.height)) });
        _updatePathGhost(_pathDraft.pts[_pathDraft.pts.length-1].x, _pathDraft.pts[_pathDraft.pts.length-1].y);
      };
      const muFree = () => { canvas.removeEventListener('pointermove',mmFree); canvas.removeEventListener('pointerup',muFree); _finishPath(false); };
      canvas.addEventListener('pointermove', mmFree);
      canvas.addEventListener('pointerup', muFree);
      return;
    }
    e.preventDefault();

    // Позиция внутри pdf-canvas с учётом scale
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth  / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    _drawStart = {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };

    _drawGhost = document.createElement('div');
    _drawGhost.id = 'ps-draw-ghost';
    // Эллипс рисуется сразу овалом, а не прямоугольной рамкой
    const ghostRadius = pdfTool === 'ellipse' ? ';border-radius:50%' : '';
    _drawGhost.style.cssText = `left:${_drawStart.x}px;top:${_drawStart.y}px;width:0;height:0${ghostRadius}`;
    canvas.appendChild(_drawGhost);
    canvas.setPointerCapture(e.pointerId);
  });

  // Shift при протяжке: квадрат / круг (равные стороны), для линии — шаг 45°
  function _drawRectFrom(cx, cy, shift) {
    let dx = cx - _drawStart.x, dy = cy - _drawStart.y;
    if (shift && pdfTool !== 'line') {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * s;
      dy = Math.sign(dy || 1) * s;
    }
    if (shift && pdfTool === 'line') {
      // Прижимаем к ближайшему направлению, кратному 45°
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      dx = Math.cos(ang) * len; dy = Math.sin(ang) * len;
    }
    const ex = _drawStart.x + dx, ey = _drawStart.y + dy;
    return {
      x: Math.min(ex, _drawStart.x), y: Math.min(ey, _drawStart.y),
      w: Math.abs(dx), h: pdfTool === 'line' ? 4 : Math.abs(dy),
      ex, ey,
    };
  }

  canvas.addEventListener('pointermove', e => {
    if (!_drawGhost || !_drawStart) return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth  / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    const g = _drawRectFrom((e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY, e.shiftKey);
    _drawGhost.style.left = g.x+'px'; _drawGhost.style.top = g.y+'px';
    _drawGhost.style.width = g.w+'px'; _drawGhost.style.height = g.h+'px';
  });

  canvas.addEventListener('pointerup', e => {
    if (!_drawGhost || !_drawStart) return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth  / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;
    // Клик или протяжка решаем ПО СЫРЫМ дельтам: раньше ширина сразу
    // клампилась до 40 px, из-за чего ветка «просто клик» была недостижима —
    // выноски по клику не создавались, а вместо них появлялся кривой объект
    const rawW = Math.abs(cx - _drawStart.x);
    const rawH = Math.abs(cy - _drawStart.y);
    const isClick = rawW < 8 && rawH < 8;
    const g  = _drawRectFrom(cx, cy, e.shiftKey);   // Shift = квадрат/круг/45°
    const x  = g.x, y = g.y;
    const w  = Math.max(40, g.w);
    const h  = pdfTool === 'line' ? 4 : Math.max(20, g.h);

    _drawGhost.remove(); _drawGhost = null; _drawStart = null;

    if (isClick) { // просто клик
      if (pdfTool === 'text') {
        createPdfObj('text', { x: Math.round(cx - 110), y: Math.round(cy - 26) });
      }
    } else {
      createPdfObj(pdfTool, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    }
    setPdfTool('select');
  });

  // Клик по пустому месту — снять выделение
  canvas.addEventListener('click', e => {
    if (e.target === canvas || e.target.id === 'pdf-map') {
      selectPdfObj(null);
    }
  });
}

// ── Выделение ─────────────────────────────────────
function selectPdfObj(id) {
  pdfSelId = id;
  pdfObjects.forEach(obj => {
    const el = document.getElementById(obj.id);
    if (!el) return;
    el.classList.toggle('ps-selected', obj.id === id);
    _updateHandles(el, obj);
    el.style.cursor = obj.locked ? 'not-allowed' : pdfTool === 'select' ? 'grab' : 'crosshair';
  });
  _renderProps();
  _renderLayersList();
  // Выбрал объект — панель сразу показывает его свойства
  if (id && typeof window._pdfTabOnSelect === 'function') window._pdfTabOnSelect();
}

// ── Действия с объектами ──────────────────────────
function deletePdfObj() {
  if (!pdfSelId) return;
  _pushUndo();
  // Убиваем inset-карту если есть
  if (_insetMaps[pdfSelId]) {
    try { _insetMaps[pdfSelId].remove(); } catch(e) {}
    delete _insetMaps[pdfSelId];
  }
  const el = document.getElementById(pdfSelId);
  if (el) el.remove();
  pdfObjects = pdfObjects.filter(o => o.id !== pdfSelId);
  pdfSelId   = null;
  _renderLayersList(); _renderProps(); _saveState();
}

function duplicatePdfObj() {
  if (!pdfSelId) return;
  const src = pdfObjects.find(o => o.id === pdfSelId);
  if (!src) return;
  createPdfObj(src.type, { ...deepClone(src.data), x: src.data.x + 18, y: src.data.y + 18, name: src.name + ' копия' });
}

function toggleLockPdfObj() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.locked = !obj.locked;
  _renderObj(obj); _renderLayersList(); _saveState();
}

function movePdfObjUp() {
  const idx = pdfObjects.findIndex(o => o.id === pdfSelId);
  if (idx <= 0) return;
  [pdfObjects[idx-1], pdfObjects[idx]] = [pdfObjects[idx], pdfObjects[idx-1]];
  _renderAll(); _renderLayersList(); _saveState();
}

function movePdfObjDown() {
  const idx = pdfObjects.findIndex(o => o.id === pdfSelId);
  if (idx < 0 || idx >= pdfObjects.length-1) return;
  [pdfObjects[idx+1], pdfObjects[idx]] = [pdfObjects[idx], pdfObjects[idx+1]];
  _renderAll(); _renderLayersList(); _saveState();
}

const PDF_FONTS = [
  'Segoe UI','Arial','Times New Roman','Georgia','Courier New','Tahoma','Verdana',
  'Impact','Trebuchet MS','Arial Black','Comic Sans MS','Calibri','Cambria',
  'Consolas','Palatino Linotype','Garamond','Century Gothic','Franklin Gothic Medium',
  'Lucida Console','Lucida Sans Unicode','Arial Narrow','Book Antiqua',
  'PT Sans','PT Serif','Roboto','Open Sans','Lato','Montserrat','Oswald','Nunito',
];

// ── Панель свойств ────────────────────────────────

// ── Разделы панели свойств ──────────────────────────────────────────────────
// Плоский список из десятка строк читался тяжело: теперь свойства разложены
// по разделам, каждый сворачивается и запоминает своё состояние.
function _ppSec(id, title, body) {
  if (!body || !body.trim()) return '';
  const open = _UI_PREF.get('pp_' + id, true);
  return `<div class="pp-sec">
    <div class="pp-sec-hdr" onclick="togglePropsSection('${id}')">
      <span class="pp-sec-arrow" id="pp-sec-arrow-${id}">${open ? '▾' : '▸'}</span>${title}
    </div>
    <div class="pp-sec-body" id="pp-sec-${id}" style="${open ? '' : 'display:none'}">${body}</div>
  </div>`;
}

window.togglePropsSection = function(id) {
  const b = document.getElementById('pp-sec-' + id);
  const a = document.getElementById('pp-sec-arrow-' + id);
  if (!b) return;
  const open = b.style.display !== 'none';
  b.style.display = open ? 'none' : '';
  if (a) a.textContent = open ? '▸' : '▾';
  _UI_PREF.set('pp_' + id, !open);
};

function _renderProps() {
  const panel = document.getElementById('pdf-props-panel');
  if (!pdfSelId) {
    panel.innerHTML = '<div class="pp-title">⚙ Свойства</div><div class="pp-empty">Выберите объект</div>';
    return;
  }
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const d = obj.data;

  const bgHex = _rgbaToHex(d.bg);
  const alpha  = _rgbaAlpha(d.bg);
  // Настройки текста показываем только там, где текст действительно есть:
  // у фигур без подписи (линия, стрелка, путь, кривая, картинка, стрелка С,
  // лупа) блок шрифта только путал
  const showText = ['text','callout','leader','src-leader','scale','legend'].includes(obj.type)
                || (['rect','ellipse'].includes(obj.type) && !!(d.content || '').trim());
  const isScale  = obj.type === 'scale';
  const isLeader = obj.type === 'leader';
  const isNorth  = obj.type === 'north';
  const isLegend = obj.type === 'legend';
  const isImage  = obj.type === 'image';
  const isSrcLeader = obj.type === 'src-leader';
  const srcForLeader = isSrcLeader ? _getSrcById(d.srcId) : null;
  const srcLabel = srcForLeader ? (srcForLeader.name || `Ист.${srcForLeader.id}`) : (d.srcId ? `ID:${d.srcId}` : '—');
  const anchorLabels = { nw:'↖', n:'↑', ne:'↗', w:'←', center:'⊙', e:'→', sw:'↙', s:'↓', se:'↘' };
  const anchorBtns = Object.entries(anchorLabels).map(([a, lbl]) =>
    `<button onclick="setSrcLeaderAnchor('${a}')" style="padding:3px 2px;font-size:var(--fs-2);border-radius:var(--r-xs);border:1px solid ${(d.anchorType||'center')===a?'var(--acc2)':'var(--bd2)'};background:${(d.anchorType||'center')===a?'var(--acc-soft)':'var(--bg3)'};color:${(d.anchorType||'center')===a?'var(--acc2)':'var(--tx2)'};cursor:pointer">${lbl}</button>`
  ).join('');

  const fontOpts = PDF_FONTS.map(f => `<option ${d.fontFamily===f?'selected':''}>${f}</option>`).join('');

  const isArrow = obj.type === 'arrow';

  // ── Раздел «Особое» — то, что есть только у этого типа объекта ──
  const secSpecial = `
      ${isArrow ? `
      <div class="pp-row"><span class="pp-lbl">Остриё</span></div>
      <div class="pp-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px">
        ${ARROW_STYLES.map((a, i) => `<button onclick="setArrowStyle(${i})"
            class="${(d.arrowStyle || 0) === i ? 'active' : ''}" title="${a.name}">
            <svg viewBox="0 0 26 14" style="width:100%;height:13px;display:block">
              <line x1="1" y1="7" x2="${[16, 22, 15, 11, 15][i]}" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              ${_arrowHead(i, 24, 7, 0, 6, 'currentColor', 2)}
            </svg></button>`).join('')}
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Концы</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px;flex:1">
          ${[['end','Остриё в конце','→'],['start','Остриё в начале','←'],
             ['both','Остриё с двух сторон','↔'],['dot-end','Точка в начале, остриё в конце','•→']].map(([v, t, g]) =>
            `<button onclick="setArrowDir('${v}')" class="${(d.arrowDir || 'end') === v ? 'active' : ''}" title="${t}">${g}</button>`).join('')}
        </div>
      </div>
      <div class="pp-row">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" ${d.dashArrow ? 'checked' : ''} onchange="toggleArrowDash()">
          <span class="pp-lbl" style="cursor:pointer">Пунктиром</span>
        </label>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Длина</span>
        <input class="pp-inp-sm" type="number" id="pp-arrow-len" value="${Math.round(_arrowLen(d))}" min="10"
               oninput="setArrowGeom()"><span style="font-size:var(--fs-0);color:var(--tx3)">px</span>
        <span class="pp-lbl" style="margin-left:6px">Угол</span>
        <input class="pp-inp-sm" type="number" id="pp-arrow-ang" value="${Math.round(_arrowAng(d))}" min="-180" max="180"
               oninput="setArrowGeom()"><span style="font-size:var(--fs-0);color:var(--tx3)">°</span>
      </div>` : ''}

      ${isImage ? `
      <div class="pp-row">
        <span class="pp-lbl">Прозрачн.</span>
        <input type="range" min="10" max="100" value="${Math.round((d.imgOpacity ?? 1) * 100)}" style="flex:1" oninput="applyImgOpacity(this.value)">
        <span id="pp-imgop-val" style="width:36px;text-align:right;font-size:var(--fs-1);color:var(--tx2)">${Math.round((d.imgOpacity ?? 1) * 100)}%</span>
      </div>
      <div class="pp-row">
        <button onclick="document.getElementById('ps-image-upload').click()" style="flex:1;padding:5px 8px;font-size:var(--fs-1);border-radius:var(--r-sm);border:1px solid var(--bd);background:var(--bg3);color:var(--tx2);cursor:pointer">Заменить изображение…</button>
      </div>
      <div class="pp-sep"></div>` : ''}

      ${obj.type === 'inset' ? `
      <div class="pp-row">
        <span class="pp-lbl">Масштаб</span>
        <span style="font-size:var(--fs-1);color:var(--tx2)">1 :</span>
        <input type="number" id="pp-inset-scale" min="50" max="5000000" step="100"
               value="${_insetScale(obj) || 2000}"
               onkeydown="if(event.key==='Enter'){event.preventDefault();applyInsetScale()}" style="flex:1;min-width:0">
        <button onclick="applyInsetScale()" style="padding:4px 8px;font-size:var(--fs-1);border-radius:var(--r-sm);border:1px solid var(--bd);background:var(--bg3);color:var(--tx2);cursor:pointer">ОК</button>
      </div>
      <div class="pp-row">
        <button onclick="insetFitToLayer()" style="flex:1;padding:5px 8px;font-size:var(--fs-1);border-radius:var(--r-sm);border:1px solid var(--bd);background:var(--bg3);color:var(--tx2);cursor:pointer">Показать активный слой целиком</button>
      </div>
      <label class="pp-row" style="gap:6px;cursor:pointer">
        <input type="checkbox" ${d.insetShowScale === false ? '' : 'checked'} onchange="toggleInsetScale(this.checked)">
        <span style="font-size:var(--fs-1);color:var(--tx2)">Масштабная плашка на лупе (печатается)</span>
      </label>
      ${d.insetShowScale === false ? '' : `
      <div class="pp-row" style="flex-direction:column;align-items:stretch;gap:3px">
        <span class="pp-lbl">Стиль плашки</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px">
          ${['Блоки','ГОСТ 2 ряда','Засечки','Компакт','1:N','1:N + в 1 см','Скоба'].map((n,i)=>
            `<button onclick="setInsetScaleOpt('scaleStyle',${i})" style="padding:4px 2px;font-size:var(--fs-0);border-radius:var(--r-sm);border:1px solid ${((d.insetScale||{}).scaleStyle||0)===i?'var(--acc)':'var(--bd)'};background:${((d.insetScale||{}).scaleStyle||0)===i?'var(--acc-soft, rgba(10,132,255,.14))':'var(--bg3)'};color:${((d.insetScale||{}).scaleStyle||0)===i?'var(--acc2)':'var(--tx2)'};cursor:pointer">${n}</button>`).join('')}
        </div>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Шрифт</span>
        <input type="range" min="6" max="14" value="${(d.insetScale||{}).fontSize ?? 9}" style="flex:1"
               oninput="setInsetScaleOpt('fontSize', +this.value)">
        <span style="width:30px;text-align:right;font-size:var(--fs-1);color:var(--tx2)">${(d.insetScale||{}).fontSize ?? 9}px</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Цвет</span>
        <input type="color" value="${(d.insetScale||{}).color || '#111827'}" onchange="setInsetScaleOpt('color', this.value)" style="flex:1;height:24px;padding:0;border:none;background:none;cursor:pointer">
        <label style="display:flex;align-items:center;gap:4px;font-size:var(--fs-1);color:var(--tx2);white-space:nowrap">
          <input type="checkbox" ${((d.insetScale||{}).bg || 'rgba(255,255,255,.88)') === 'transparent' ? 'checked' : ''}
                 onchange="setInsetScaleOpt('bg', this.checked ? 'transparent' : 'rgba(255,255,255,.88)')">без подложки
        </label>
      </div>`}
      <div class="pp-sep"></div>` : ''}

      ${isLeader ? `
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px;flex:1">
          ${['Полочка','Точка','В рамке','Колено','Без полочки','Флажок'].map((n,i)=>
            `<button onclick="applyLeaderStyle(${i})" style="padding:4px 2px;font-size:var(--fs-0);border-radius:var(--r-sm);border:1px solid ${(d.leaderStyle||0)===i?'var(--acc2)':'var(--bd)'};background:${(d.leaderStyle||0)===i?'var(--acc-soft)':'var(--bg3)'};color:${(d.leaderStyle||0)===i?'var(--acc2)':'var(--tx2)'};cursor:pointer">${n}</button>`).join('')}
        </div>
      </div>
      <div class="pp-sep"></div>` : ''}

      ${isScale ? `
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px;flex:1">
          ${['Блоки','ГОСТ 2 ряда','Засечки','Компакт','1:N','1:N + в 1 см','Скоба'].map((n,i)=>
            `<button onclick="applyScaleStyle(${i})" style="padding:4px 2px;font-size:var(--fs-0);border-radius:var(--r-sm);border:1px solid ${(d.scaleStyle||0)===i?'var(--acc2)':'var(--bd)'};background:${(d.scaleStyle||0)===i?'var(--acc-soft)':'var(--bg3)'};color:${(d.scaleStyle||0)===i?'var(--acc2)':'var(--tx2)'};cursor:pointer">${n}</button>`).join('')}
        </div>
      </div>
      <div class="pp-row" style="flex-direction:column;align-items:stretch;gap:3px">
        <span class="pp-lbl">Подогнать карту под масштаб</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px">
          ${[500,1000,2000,5000,10000,25000,50000,100000].map(S =>
            `<button onclick="fitPdfMapToScale(${S})" title="Установить зум карты так, чтобы масштаб стал ровно 1:${S}" style="padding:4px 2px;font-size:var(--fs-0);border-radius:var(--r-sm);border:1px solid var(--bd);background:var(--bg3);color:var(--tx2);cursor:pointer">1:${S >= 1000 ? (S/1000)+'к' : S}</button>`).join('')}
        </div>
        <div style="display:flex;gap:4px;align-items:center;margin-top:2px">
          <span style="font-size:var(--fs-1);color:var(--tx2)">1 :</span>
          <input type="number" id="pp-scale-custom" min="50" max="5000000" step="100"
                 value="${d.scaleCustom || _scaleMetrics(d).ratio}"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();applyCustomScale()}"
                 style="flex:1;min-width:0">
          <button onclick="applyCustomScale()" title="Применить свой масштаб"
                  style="padding:4px 8px;font-size:var(--fs-1);border-radius:var(--r-sm);border:1px solid var(--bd);background:var(--bg3);color:var(--tx2);cursor:pointer">ОК</button>
        </div>
        <label style="display:flex;align-items:center;gap:5px;font-size:var(--fs-1);color:var(--tx2);margin-top:2px">
          <input type="checkbox" id="pp-scale-fixed" ${d.scaleFixed ? 'checked' : ''} onchange="toggleFixedScale(this.checked)">
          Показывать введённый масштаб, не пересчитывать по карте
        </label>
      </div>
      <div class="pp-sep"></div>` : ''}

      ${isNorth ? `
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;flex:1">
          ${Array.from({length:12},(_,i)=>i).map(i=>`<button onclick="applyNorthStyle(${i})" title="Вариант ${i+1}" style="width:30px;height:30px;padding:2px;border-radius:var(--r-sm);border:1px solid ${(d.northStyle||0)===i?'var(--acc2)':'var(--bd)'};background:${(d.northStyle||0)===i?'var(--acc-soft)':'var(--bg3)'};cursor:pointer"><span style="display:block;width:100%;height:100%;pointer-events:none">${_northHtml({northStyle:i,color:(d.northStyle||0)===i?'#60a5fa':'#9aa4b2',bg:'#161b27'})}</span></button>`).join('')}
        </div>
      </div>
      <div class="pp-sep"></div>` : ''}

      ${isLegend ? `
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px;flex:1">
          ${['Классика','Рамки','Мин.','Гориз.','Таблица','Шапка','ГОСТ','2 колонки'].map((n,i)=>`<button onclick="applyLegendStyle(${i})" style="padding:4px 2px;font-size:var(--fs-0);border-radius:var(--r-sm);border:1px solid ${(d.legendStyle||0)===i?'var(--acc2)':'var(--bd)'};background:${(d.legendStyle||0)===i?'var(--acc-soft)':'var(--bg3)'};color:${(d.legendStyle||0)===i?'var(--acc2)':'var(--tx2)'};cursor:pointer">${n}</button>`).join('')}
        </div>
      </div>
      <div class="pp-row">
        <span class="pp-lbl" title="Вид значка у всех строк легенды. У отдельной строки его можно поменять в списке ниже">Значки</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px;flex:1">
          ${LEGEND_SYMBOLS.map(([k, n, short]) => {
            const on = (d.legendSymbolAll || 'auto') === k && !Object.keys(d.legendSymbols || {}).length;
            const col = on ? '#60a5fa' : '#9aa4b2';
            const prev = k === 'auto'
              ? `<span style="display:block;height:11px;line-height:11px;font-weight:700">A</span>`
              : _legendSymbolSvg({ color: col, bg: on ? 'rgba(96,165,250,.3)' : 'rgba(154,164,178,.25)', brd: 'solid' }, k, k === 'line' || k === 'dash' ? 18 : 11, 11);
            return `<button onclick="applyLegendSymbolAll('${k}')" title="${n} — для всех строк" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:0;padding:4px 1px 3px;font-size:var(--fs-0);line-height:1.1;border-radius:var(--r-sm);border:1px solid ${on?'var(--acc2)':'var(--bd)'};background:${on?'var(--acc-soft)':'var(--bg3)'};color:${on?'var(--acc2)':'var(--tx2)'};cursor:pointer">${prev}<span style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${short || n}</span></button>`;
          }).join('')}
        </div>
      </div>
      <div class="pp-sep"></div>
      <div class="pp-row" style="flex-direction:column;align-items:stretch;gap:0">
        <span class="pp-lbl" style="margin-bottom:4px">Видимость элементов</span>
        ${_legendItemsHtml(d)}
      </div>
      <div class="pp-sep"></div>` : ''}

      ${isSrcLeader ? `
      <div class="pp-row">
        <span class="pp-lbl">Источник</span>
        <span style="font-size:var(--fs-1);color:var(--tx2);flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${srcLabel}</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Якорь</span>
        <div class="pp-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:2px;flex:1">${anchorBtns}</div>
      </div>
      <div class="pp-sep"></div>` : ''}

  `;

  // ── Положение и размер ──
  const secGeom = `
      <div class="pp-row">
        <span class="pp-lbl">X / Y</span>
        <input class="pp-inp-sm" type="number" id="pp-x" aria-label="Положение по X" value="${Math.round(d.x)}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-y" aria-label="Положение по Y" value="${Math.round(d.y)}" oninput="applyPdfProp()">
        <span style="font-size:var(--fs-0);color:var(--tx3)">px</span>
      </div>
      ${isArrow ? '' : `
      <div class="pp-row">
        <span class="pp-lbl">Ш / В</span>
        <input class="pp-inp-sm" type="number" id="pp-w" aria-label="Ширина объекта" value="${Math.round(d.w)}" min="20" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-h" aria-label="Высота объекта" value="${Math.round(d.h)}" min="10" oninput="applyPdfProp()">
        <span style="font-size:var(--fs-0);color:var(--tx3)">px</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Скругл.</span>
        <input class="pp-slider" type="range" id="pp-radius" min="0" max="200" value="${d.radius||0}" oninput="applyPdfProp()">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Поворот</span>
        <input class="pp-slider" type="range" id="pp-rotation" min="-180" max="180" value="${d.rotation||0}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-rotation-val" value="${d.rotation||0}" min="-180" max="180" style="width:44px" oninput="document.getElementById('pp-rotation').value=this.value;applyPdfProp()">
        <button class="pp-mini-btn" onclick="_resetRotation()" title="Сбросить поворот">↺</button>
      </div>`}
  `;

  // ── Заливка и контур ──
  const secFill = `
      ${isArrow ? '' : `
      <div class="pp-row">
        <span class="pp-lbl">Заливка</span>
        <input class="pp-color" type="color" id="pp-bg" value="${bgHex}" oninput="applyPdfProp()">
        <input class="pp-slider" type="range" id="pp-alpha" min="0" max="100" value="${Math.round(alpha*100)}" oninput="applyPdfProp()">
        <span id="pp-alpha-val" style="font-size:var(--fs-1);color:var(--tx2);min-width:28px">${Math.round(alpha*100)}%</span>
      </div>`}
      <div class="pp-row">
        <span class="pp-lbl">Контур</span>
        <input class="pp-color" type="color" id="pp-stroke" value="${d.strokeColor==='transparent'?'#334155':d.strokeColor}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-sw" value="${d.strokeW}" min="0" max="20" oninput="applyPdfProp()">
        <span style="font-size:var(--fs-0);color:var(--tx3)">px</span>
      </div>

  `;

  // ── Текст ──
  const secText = !showText ? '' : `
      <div class="pp-row">
        <span class="pp-lbl">Шрифт</span>
        <select class="pp-inp" id="pp-font" onchange="applyPdfProp()">${fontOpts}</select>
        <input class="pp-inp-sm" type="number" id="pp-fsize" value="${d.fontSize}" min="6" max="120" oninput="applyPdfProp()" style="width:42px">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div class="pp-style-btns">
          <button class="pp-sbtn ${d.fontWeight==='700'?'active':''}" onclick="togglePdfFontStyle('bold')" style="font-weight:700">B</button>
          <button class="pp-sbtn ${d.fontStyle==='italic'?'active':''}" onclick="togglePdfFontStyle('italic')" style="font-style:italic">I</button>
          <button class="pp-sbtn ${d.textDecoration==='underline'?'active':''}" onclick="togglePdfFontStyle('underline')" style="text-decoration:underline">U</button>
          <select class="pp-inp" id="pp-align" onchange="applyPdfProp()" style="flex:1;font-size:var(--fs-1);padding:2px">
            <option value="left"   ${d.textAlign==='left'   ?'selected':''}>← Лево</option>
            <option value="center" ${d.textAlign==='center' ?'selected':''}>↔ Центр</option>
            <option value="right"  ${d.textAlign==='right'  ?'selected':''}>→ Право</option>
          </select>
        </div>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Цв.текста</span>
        <input class="pp-color" type="color" id="pp-color" value="${d.color === 'transparent' ? '#000000' : d.color}" oninput="applyPdfProp()">
        <span class="pp-lbl" style="margin-left:4px">Тень</span>
        <input type="checkbox" id="pp-tshadow" ${d.textShadow?'checked':''} onchange="applyPdfProp()">
        <span class="pp-lbl" style="margin-left:4px">Обв.</span>
        <input class="pp-color" type="color" id="pp-tsc" value="${(d.textStrokeColor && d.textStrokeColor !== 'transparent') ? d.textStrokeColor : '#000000'}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-tsw" value="${d.textStrokeW || 0}" min="0" max="10" oninput="applyPdfProp()" style="width:34px">
      </div>
      ${obj.type === 'text' ? `
      <div class="pp-row">
        <span class="pp-lbl">Полочка</span>
        <input type="checkbox" id="pp-shelf" ${d.shelf?'checked':''} onchange="applyPdfProp()" title="Показывать только нижнюю черту вместо рамки">
        <span style="font-size:var(--fs-1);color:var(--tx2);margin-left:6px">вместо рамки — полоска снизу</span>
      </div>` : ''}
  `;

  panel.innerHTML = `
    <div class="pp-title"><svg class="icon icon-sm"><use href="#ico-sliders"/></svg>
      <span style="color:var(--tx);text-transform:none">${obj.name}</span>
      <span class="pp-type">${_typeName(obj.type)}</span>
    </div>
    <div class="pp-body">
      ${_ppSec('special', 'Особое',            secSpecial)}
      ${_ppSec('geom',    'Положение и размер', secGeom)}
      ${_ppSec('fill',    'Заливка и контур',   secFill)}
      ${_ppSec('text',    'Текст',              secText)}
      <div class="pp-actions">
        <button class="pp-sbtn" onclick="duplicatePdfObj()" title="Дублировать (Ctrl+D)"><svg class="icon icon-sm"><use href="#ico-duplicate"/></svg></button>
        <button class="pp-sbtn" onclick="toggleLockPdfObj()" title="${obj.locked?'Разблокировать':'Заблокировать'}"><svg class="icon icon-sm"><use href="#ico-${obj.locked?'unlock':'lock'}"/></svg></button>
        <button class="pp-sbtn" onclick="groupPdfObjects()" title="Сгруппировать выделенные (Ctrl+G)"><svg class="icon icon-sm"><use href="#ico-layers"/></svg></button>
        <button class="pp-sbtn danger" onclick="deletePdfObj()" title="Удалить (Delete)"><svg class="icon icon-sm"><use href="#ico-trash"/></svg></button>
      </div>
    </div>
  `;
}

function applyNorthStyle(s) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.data.northStyle = s;
  _renderObj(obj); _renderProps(); _saveState();
}
function applyLegendStyle(s) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.data.legendStyle = s;
  _renderObj(obj); _renderProps(); _saveState();
}
// Значок для всех строк: сбрасывает и выбранные по отдельности
function applyLegendSymbolAll(kind) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.data.legendSymbolAll = kind;
  delete obj.data.legendSymbols;
  _renderObj(obj); _renderProps(); _saveState();
}
// Значок одной строки (или всех выделенных). '' — как у всей легенды
function setLegendItemSymbol(itemId, kind) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const ids = (typeof _lgSel !== 'undefined' && _lgSel.has(itemId) && _lgSel.size > 1) ? [..._lgSel] : [itemId];
  const m = obj.data.legendSymbols || (obj.data.legendSymbols = {});
  ids.forEach(id => { if (kind) m[id] = kind; else delete m[id]; });
  if (!Object.keys(m).length) delete obj.data.legendSymbols;
  _renderObj(obj); _renderProps(); _saveState();
}

// Все возможные строки легенды в порядке, заданном пользователем.
// Стиль плашки берётся из фактического стиля слоя, подпись — своя или имя слоя.
function _legendItems(d) {
  const labels = d.legendLabels || {};
  const all = [];
  // Ключ строки — устойчивый: у слоёв без геометрии (источники, РТ, выноски)
  // id пересоздаётся при каждой загрузке проекта, и настройки легенды,
  // привязанные к нему, переставали находиться. Старые ключи (голый id)
  // продолжаем понимать, чтобы не ломать уже сохранённые проекты.
  const keyOf = l => (typeof window.layerStableKey === 'function')
    ? window.layerStableKey(l) : String(l.id);
  let mpDone = false;
  // Видимость — по текущему листу (_pdfSheetVisible), не общий l.visible:
  // иначе в легенду попадали строки слоёв, выключенных именно для ЭТОГО
  // листа, или наоборот пропадали включённые здесь, но выключенные глобально.
  mapLayers.filter(l => _pdfSheetVisible(l)).forEach(l => {
    // Все расчётные точки — одна строка легенды, а не полсотни отдельных
    if (l.mpId) {
      if (mpDone) return;
      mpDone = true;
      const k = 'type:monpoints', lg = String(l.id);
      all.push({ id: k, legacyId: lg,
        bg: hexToRgba(l.color, 0.85), brd: 'solid', color: l.color,
        name: labels[k] || labels[lg] || 'Расчётные точки' });
      return;
    }
    const st = l._psStyle || {};
    const k = keyOf(l), lg = String(l.id);
    all.push({
      id: k,
      legacyId: lg,
      bg: hexToRgba(st.fillColor || l.color, st.fillOpacity ?? (l.type === 'szz' ? 0.12 : 0.2)),
      brd: st.dashArray ? (/^2\s*,/.test(String(st.dashArray)) ? 'dotted' : 'dashed') : 'solid',
      color: st.color || l.color,
      name: labels[k] || labels[lg] || l.name,
    });
  });
  if (foundParcels.filter(p => p.inP).length) {
    all.push({ id:'zu-inside', bg:'rgba(34,197,94,0.25)',  brd:'solid', color:'#16a34a',
               name: labels['zu-inside'] || 'ЗУ внутри СЗЗ' });
    all.push({ id:'zu-cross',  bg:'rgba(245,158,11,0.25)', brd:'solid', color:'#b45309',
               name: labels['zu-cross'] || 'ЗУ на пересечении' });
  }
  const order = d.legendOrder || [];
  if (!order.length) return all;
  const rank = new Map(order.map((k, i) => [k, i]));
  // Позицию ищем и по новому ключу, и по старому — порядок в уже сохранённых
  // проектах записан прежними id
  const pos = (it, i) => rank.has(it.id) ? rank.get(it.id)
            : rank.has(it.legacyId) ? rank.get(it.legacyId)
            : order.length + i;
  return all
    .map((it, i) => ({ it, i }))
    .sort((a, b) => pos(a.it, a.i) - pos(b.it, b.i))
    .map(x => x.it);
}

// Переместить строку легенды вверх/вниз
window.moveLegendItem = function(itemId, dir) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const ids = _legendItems(obj.data).map(it => it.id);
  const i = ids.indexOf(itemId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  obj.data.legendOrder = ids;
  _renderObj(obj); _renderProps(); _saveState();
};

// Своя подпись строки легенды (пусто — вернуть имя слоя)
window.renameLegendItem = function(itemId, value) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  if (!obj.data.legendLabels) obj.data.legendLabels = {};
  const v = (value || '').trim();
  if (v) obj.data.legendLabels[itemId] = v;
  else delete obj.data.legendLabels[itemId];
  _renderObj(obj); _saveState();
};

// ── Строки легенды ──────────────────────────────────────────────────────────
// Выделение как везде: клик, Shift — диапазон, Ctrl — добавить. Над
// выделением работает ПКМ-меню: скрыть, показать, убрать из легенды.
let _lgSel = new Set();
let _lgLast = null;

window.lgSelClick = function(e, id, ids) {
  // По самому полю ввода не выделяем — там правят подпись
  if (e.target && e.target.tagName === 'INPUT') return;
  e.stopPropagation();
  const list = ids || [];
  if (e.shiftKey && _lgLast && list.includes(_lgLast)) {
    const a = list.indexOf(_lgLast), b = list.indexOf(id);
    _lgSel = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (e.ctrlKey || e.metaKey) {
    if (_lgSel.has(id)) _lgSel.delete(id); else _lgSel.add(id);
    _lgLast = id;
  } else {
    _lgSel = new Set([id]); _lgLast = id;
  }
  _renderProps();
};

// Строка легенды — это слой карты. Возвращаем сам слой по строке,
// служебные строки (ЗУ внутри/на пересечении) слоя не имеют.
function _lgLayersOf(ids) {
  const all = (typeof mapLayers !== 'undefined' ? mapLayers : []);
  return ids.map(id => all.find(l => String(l.id) === String(id))).filter(Boolean);
}

window.lgSelAction = function(what, arg) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || !_lgSel.size) return;
  const ids = [..._lgSel];

  // Видимость самих слоёв на карте и на листе — теми же функциями, что и в панели слоёв
  if (what === 'layer-hide' || what === 'layer-show') {
    const ls = _lgLayersOf(ids);
    if (!ls.length) { setSt('В выделении нет слоёв карты', 'err'); return; }
    ls.forEach(l => {
      l.visible = what === 'layer-show';
      if (typeof window._reconcileLayerVis === 'function') window._reconcileLayerVis(l);
      if (typeof window._pdfOnLayerToggled === 'function') window._pdfOnLayerToggled(l);
    });
    if (typeof renderLayers === 'function') renderLayers();
    _renderObj(obj); _renderProps(); _renderLayersList(); _saveState();
    setSt(`${what === 'layer-show' ? 'Показаны' : 'Скрыты'} слои: ${ls.length}`, 'ok');
    return;
  }

  // Цвет самих слоёв — сразу всему выделению
  if (what === 'layer-color') {
    const ls = _lgLayersOf(ids);
    if (!ls.length) { setSt('В выделении нет слоёв карты', 'err'); return; }
    const col = arg || '#f59e0b';
    ls.forEach(l => {
      l.color = col;
      l._psStyle = { ...(l._psStyle || {}), color: col, fillColor: col };
      try { if (l.layer && l.layer.setStyle) l.layer.setStyle(l._psStyle); } catch(e) {}
      if (typeof window._pdfOnLayerStyleChanged === 'function') window._pdfOnLayerStyleChanged(l);
    });
    if (typeof renderLayers === 'function') renderLayers();
    _renderObj(obj); _renderProps(); _saveState();
    setSt(`Цвет изменён у слоёв: ${ls.length}`, 'ok');
    return;
  }

  // Видимость строк в самой легенде
  if (!obj.data.legendHidden) obj.data.legendHidden = [];
  const h = obj.data.legendHidden;
  ids.forEach(id => {
    const i = h.indexOf(id);
    if (what === 'hide' && i < 0) h.push(id);
    if (what === 'show' && i >= 0) h.splice(i, 1);
  });
  _renderObj(obj); _renderProps(); _saveState();
  setSt(what === 'hide' ? 'Строки убраны из легенды' : 'Строки возвращены в легенду', 'ok');
};

// Цвет выбирается системным окном, а не самодельным списком
window.lgPickColor = function() {
  const inp = document.createElement('input');
  inp.type = 'color';
  const first = _lgLayersOf([..._lgSel])[0];
  inp.value = (first && (first._psStyle?.color || first.color)) || '#f59e0b';
  inp.style.cssText = 'position:fixed;left:-100px;top:-100px';
  document.body.appendChild(inp);
  inp.addEventListener('change', () => { window.lgSelAction('layer-color', inp.value); inp.remove(); });
  inp.addEventListener('blur',  () => setTimeout(() => inp.remove(), 300));
  inp.click();
};

window.lgSelMenu = function(e, id, ids) {
  e.preventDefault(); e.stopPropagation();
  if (!_lgSel.has(id)) { _lgSel = new Set([id]); _lgLast = id; _renderProps(); }
  document.getElementById('src-ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
  const close = "document.getElementById('src-ctx-menu')?.remove()";
  const withLayers = _lgLayersOf([..._lgSel]).length;
  menu.innerHTML = `
    <div class="src-ctx-hdr">Строк выделено: ${_lgSel.size}</div>
    <button onclick="lgSelAction('hide');${close}">Скрыть из легенды</button>
    <button onclick="lgSelAction('show');${close}">Показать в легенде</button>
    <div class="src-ctx-sep"></div>
    <div class="src-ctx-hdr">Значок</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">` +
    [['', 'Общий'], ...LEGEND_SYMBOLS.filter(([k]) => k !== 'auto')].map(([k, n]) =>
      `<button onclick="setLegendItemSymbol('${id}','${k}');${close}">${n}</button>`).join('') +
    `</div>` +
    (withLayers ? `<div class="src-ctx-sep"></div>
    <button onclick="lgSelAction('layer-hide');${close}">Скрыть слои на карте (${withLayers})</button>
    <button onclick="lgSelAction('layer-show');${close}">Показать слои на карте (${withLayers})</button>
    <button onclick="lgPickColor();${close}">Цвет слоёв…</button>` : '');
  if (typeof _placeCtxMenu === 'function') _placeCtxMenu(menu, e);
  else { document.body.appendChild(menu); menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px'; }
};

function _legendItemsHtml(d) {
  const hidden = d.legendHidden || [];
  const items = _legendItems(d);
  if (!items.length) return '<span style="font-size:var(--fs-1);color:var(--tx3)">Нет слоёв</span>';
  const btn = (html, onclick, title) =>
    `<button onclick="event.stopPropagation();${onclick}" title="${title}" style="background:none;border:none;cursor:pointer;padding:0 2px;line-height:1;color:var(--tx2);font-size:var(--fs-0)">${html}</button>`;
  window._lgRowIds = items.map(x => x.id);
  const ids = '_lgRowIds';
  // Панель действий не рисуем: те же команды уже есть по правой кнопке,
  // дублировать их в свойствах незачем — только место занимают
  const bar = _lgSel.size > 1
    ? `<div style="font-size:var(--fs-1);color:var(--tx2);opacity:.8;padding:2px 0 4px">
         Выделено строк: ${_lgSel.size} — правая кнопка даёт действия</div>`
    : '';
  return bar + items.map(it => {
    // Скрытость читаем и по старому ключу — проекты, сохранённые раньше,
    // помнят строки по прежним id слоёв
    const vis = !(hidden.includes(it.id) || (it.legacyId && hidden.includes(it.legacyId)));
    const sel = _lgSel.has(it.id) ? ' sel' : '';
    return `<div class="lg-row${sel}${vis ? '' : ' hidden-item'}"
         onclick="lgSelClick(event,'${it.id}',${ids})"
         oncontextmenu="lgSelMenu(event,'${it.id}',${ids});return false"
         title="Клик — выбрать, Shift — диапазон, Ctrl — добавить, ПКМ — меню">
      <button onclick="event.stopPropagation();toggleLegendItem('${it.id}')" title="${vis?'Скрыть из легенды':'Показать в легенде'}" style="background:none;border:none;cursor:pointer;padding:0;line-height:1;color:${vis?'var(--acc2)':'var(--tx3)'}"><svg class="icon icon-sm"><use href="#ico-${vis?'eye':'eye-off'}"/></svg></button>
      ${(() => { const k = _legendSymbolOf(d, it);
        return k === 'auto'
          ? `<div style="width:13px;height:13px;flex-shrink:0;background:${it.bg};border:1.5px ${it.brd} ${it.color};border-radius:var(--r-xs)"></div>`
          : _legendSymbolSvg(it, k, k === 'line' || k === 'dash' ? 18 : 13, 13); })()}
      <input type="text" value="${String(it.name).replace(/"/g,'&quot;')}"
             oninput="renameLegendItem('${it.id}', this.value)" title="Своя подпись в легенде"
             style="flex:1;min-width:0;font-size:var(--fs-1);background:var(--bg);border:1px solid var(--bd);border-radius:var(--r-xs);color:${vis?'var(--tx)':'var(--tx3)'};padding:2px 4px">
      <select onclick="event.stopPropagation()" onchange="setLegendItemSymbol('${it.id}', this.value)"
              title="Значок этой строки (при нескольких выделенных — у всех выделенных)"
              style="width:66px;flex-shrink:0;font-size:var(--fs-0);background:var(--bg);border:1px solid var(--bd);border-radius:var(--r-xs);color:var(--tx2);padding:1px 2px">
        ${(() => { const own = (d.legendSymbols || {})[it.id] || (it.legacyId && (d.legendSymbols || {})[it.legacyId]) || '';
          return `<option value=""${own ? '' : ' selected'}>Общий</option>` +
            LEGEND_SYMBOLS.filter(([k]) => k !== 'auto').map(([k, n]) => `<option value="${k}"${own === k ? ' selected' : ''}>${n}</option>`).join(''); })()}
      </select>
      ${btn('▲', `moveLegendItem('${it.id}',-1)`, 'Выше')}${btn('▼', `moveLegendItem('${it.id}',1)`, 'Ниже')}
    </div>`;
  }).join('');
}

function toggleLegendItem(itemId) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  if (!obj.data.legendHidden) obj.data.legendHidden = [];
  const idx = obj.data.legendHidden.indexOf(itemId);
  if (idx >= 0) obj.data.legendHidden.splice(idx, 1);
  else obj.data.legendHidden.push(itemId);
  _renderObj(obj); _renderProps(); _saveState();
}

function _syncPropsXY() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const ex = document.getElementById('pp-x'), ey = document.getElementById('pp-y');
  if (ex) ex.value = Math.round(obj.data.x);
  if (ey) ey.value = Math.round(obj.data.y);
}
function _syncPropsAll() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const d = obj.data;
  const ids = { 'pp-x': Math.round(d.x), 'pp-y': Math.round(d.y), 'pp-w': Math.round(d.w), 'pp-h': Math.round(d.h) };
  Object.entries(ids).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val; });
}

function applyPdfProp() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.locked) return;
  const d = obj.data;

  d.x = parseInt(document.getElementById('pp-x')?.value) || d.x;
  d.y = parseInt(document.getElementById('pp-y')?.value) || d.y;
  d.w = parseInt(document.getElementById('pp-w')?.value) || d.w;
  d.h = parseInt(document.getElementById('pp-h')?.value) || d.h;

  if (document.getElementById('pp-font'))   d.fontFamily = document.getElementById('pp-font').value;
  if (document.getElementById('pp-fsize'))  d.fontSize   = parseInt(document.getElementById('pp-fsize').value) || 14;
  if (document.getElementById('pp-align'))  d.textAlign  = document.getElementById('pp-align').value;
  if (document.getElementById('pp-tshadow'))d.textShadow = document.getElementById('pp-tshadow').checked;
  if (document.getElementById('pp-color'))  d.color      = document.getElementById('pp-color').value;
  if (document.getElementById('pp-tsc') && document.getElementById('pp-tsw')) {
    const tsw = parseInt(document.getElementById('pp-tsw').value) || 0;
    d.textStrokeW     = tsw;
    d.textStrokeColor = tsw > 0 ? document.getElementById('pp-tsc').value : 'transparent';
  }

  const bgEl = document.getElementById('pp-bg'), alphaEl = document.getElementById('pp-alpha');
  if (bgEl && alphaEl) {
    const alpha = parseInt(alphaEl.value) / 100;
    d.bg = hexToRgba(bgEl.value, alpha);
    const av = document.getElementById('pp-alpha-val');
    if (av) av.textContent = Math.round(alpha * 100) + '%';
  }

  const sw = parseInt(document.getElementById('pp-sw')?.value) || 0;
  const sc = document.getElementById('pp-stroke')?.value || '#334155';
  d.strokeW = sw;
  // Для путей и кривых обводка всегда применяется (иначе ничего не видно)
  d.strokeColor = (['path','bezier'].includes(obj.type) || sw > 0) ? sc : 'transparent';
  if (document.getElementById('pp-shelf') !== null) d.shelf = document.getElementById('pp-shelf').checked;
  if (document.getElementById('pp-radius')) d.radius = parseInt(document.getElementById('pp-radius').value) || 0;
  if (document.getElementById('pp-shadow')) d.shadow = document.getElementById('pp-shadow').checked;
  if (document.getElementById('pp-rotation')) {
    d.rotation = parseFloat(document.getElementById('pp-rotation').value) || 0;
    const rv = document.getElementById('pp-rotation-val');
    if (rv) rv.value = d.rotation;
  }

  _renderObj(obj);
  _saveState();
}

function _resetRotation() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.data.rotation = 0;
  _renderObj(obj);
  _renderProps();
  _saveState();
}

function togglePdfFontStyle(style) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const d = obj.data;
  if (style === 'bold')      d.fontWeight      = d.fontWeight === '700' ? '400' : '700';
  if (style === 'italic')    d.fontStyle       = d.fontStyle === 'italic' ? 'normal' : 'italic';
  if (style === 'underline') d.textDecoration  = d.textDecoration === 'underline' ? 'none' : 'underline';
  _renderObj(obj);
  _renderProps();
  _saveState();
}

// ── Инлайн-переименование объекта в панели слоёв ──
function renamePdfObj(event, id) {
  event.stopPropagation();
  const obj = pdfObjects.find(o => o.id === id);
  if (!obj) return;
  // event.target может быть отсоединён (click перерисовывает список раньше dblclick)
  const nameEl = document.querySelector(`.pl-name[ondblclick*="${id}"]`);
  if (!nameEl) return;
  const inp = document.createElement('input');
  inp.className = 'pl-rename-input';
  inp.value = obj.name;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = () => {
    const v = inp.value.trim() || obj.name;
    obj.name = v;
    _renderLayersList();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
    if (ev.key === 'Escape') { obj.name = obj.name; inp.blur(); }
  });
}

// ── Переключатели видимости слоёв карты прямо из редактора ──────────────────
function _pdfLayersForVis(types) {
  const list = mapLayers.filter(l => l.type !== 'mp-callouts' && types.includes(l.type));
  if (types.includes('mp-callouts') && _monPoints.length) list.push(_pdfMpCalloutsLayer);
  return list;
}

function _plVisChip(types, label) {
  const list = _pdfLayersForVis(types);
  if (!list.length) return '';
  const on = list.some(l => _pdfSheetVisible(l));
  const arg = types.map(t => `'${t}'`).join(',');
  return `<button class="pl-vis-chip${on ? ' on' : ''}" onclick="event.stopPropagation();togglePdfMapLayers([${arg}])"
                  title="${label}: ${on ? 'скрыть' : 'показать'}">
    <svg class="icon icon-sm"><use href="#ico-${on ? 'eye' : 'eye-off'}"/></svg>${label}</button>`;
}

// Переключить видимость группы слоёв карты (все указанные типы разом)
// Групповые чипы («Источники», «РТ», «Выноски») живут только в панели
// PDF-редактора — переключают видимость для ТЕКУЩЕГО листа (как и
// toggleVis внутри этого режима), а не общий l.visible.
window.togglePdfMapLayers = function(types) {
  const list = _pdfLayersForVis(types);
  _pdfSetSheetLayersVis(list, !list.some(_pdfSheetVisible));
};

const _SRC_CALLOUT_TYPES = ['src-callouts-emission', 'src-callouts-noise', 'src-callouts-other'];

// Поиск по панели объектов редактора
let _plQuery = '';
window.plSearch = function(v) {
  _plQuery = (v || '').trim().toLowerCase();
  _renderLayersList();
  const inp = document.getElementById('pl-search');
  if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
};
const _plMatch = (txt) => !_plQuery || String(txt || '').toLowerCase().includes(_plQuery);


// ── Слои карты в панели редактора ───────────────────────────────────────────
// Список работает теми же функциями, что и панель главного окна: выделение
// кликом, Shift — диапазон, Ctrl — добавить, ПКМ — то же меню (скрыть,
// сгруппировать, удалить). Значит, поведение везде одинаковое, а видимость
// сразу подхватывают и лист, и лупа.
function _plGeoList() {
  const all = (typeof mapLayers !== 'undefined' ? mapLayers : []);
  return all.filter(l => l.poly && l.poly.length >= 3 && _plMatch(l.name));
}

// ── Группы в панели редактора — те же, что и на основной карте ──────────────
// Раньше список тут был плоский: группы, собранные в панели слоёв, в редакторе
// не показывались вовсе, и «В группу» выглядело командой в никуда.
// Шапка группы и её команды — штатные, общие с главным окном.
function _plGroupHeader(gid, count) {
  const g = (typeof window.getLayerGroupInfo === 'function') ? window.getLayerGroupInfo(gid) : null;
  if (!g) return '';
  const members = (typeof mapLayers !== 'undefined' ? mapLayers : []).filter(l => l.groupId === gid);
  const anyVis = members.some(l => _pdfSheetVisible(l));
  const nm = String(g.name || 'Группа').replace(/</g, '&lt;');
  return `<div class="pl-item pl-group-hdr" data-gid="${gid}"
       onclick="event.stopPropagation();toggleLayerGroup('${gid}');_renderLayersList()"
       oncontextmenu="plGroupMenu(event,'${gid}');return false"
       title="${nm} — клик свернуть/развернуть, ПКМ меню группы"
       style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600">
    <span style="width:12px;text-align:center;opacity:.7">${g.collapsed ? '▸' : '▾'}</span>
    <span class="pl-name" style="flex:1">⊞ ${nm} <span style="opacity:.5;font-weight:400">(${count})</span></span>
    <span class="pl-del" style="opacity:${anyVis ? 1 : 0.4}"
          onclick="event.stopPropagation();toggleGroupVis(event,'${gid}');_renderLayersList()"
          title="${anyVis ? 'Скрыть группу' : 'Показать группу'}">
      <svg class="icon icon-sm"><use href="#ico-${anyVis ? 'eye' : 'eye-off'}"/></svg></span>
  </div>`;
}

// Пройти список в порядке mapLayers и расставить шапки групп. Участники группы
// в mapLayers лежат подряд, поэтому шапку достаточно выдать перед первым из них.
function _plWithGroups(list, rowHtml) {
  const shown = new Set();
  const counts = {};
  list.forEach(l => { if (l.groupId) counts[l.groupId] = (counts[l.groupId] || 0) + 1; });
  let out = '';
  list.forEach(l => {
    const gid = l.groupId;
    if (!gid || !(typeof window.getLayerGroupInfo === 'function' && window.getLayerGroupInfo(gid))) {
      out += rowHtml(l, false);
      return;
    }
    if (!shown.has(gid)) { shown.add(gid); out += _plGroupHeader(gid, counts[gid]); }
    const g = window.getLayerGroupInfo(gid);
    if (!g.collapsed) out += rowHtml(l, true);
  });
  return out;
}

// Меню группы в редакторе — те же команды, что и в главном окне
// (window.layerGroupContextMenu, js/map.js). Раньше здесь был укороченный
// список из 4 пунктов — не хватало изоляции, выделения, блокировки, цвета
// метки, выносок группой и «Новая группа…», которые есть в основной панели
// слоёв. Действия — те же глобальные функции из map.js, что работают с
// общими mapLayers/_layerGroups, поэтому их можно звать и отсюда без правок.
window.plGroupMenu = function(e, gid) {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('src-ctx-menu')?.remove();
  const g = _layerGroups[gid];
  if (!g) return;
  const members = mapLayers.filter(l => l.groupId === gid);
  const anyVis = members.some(l => _pdfSheetVisible(l));
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
  const close = "document.getElementById('src-ctx-menu')?.remove();_renderLayersList()";
  const cs = (typeof _groupCalloutState === 'function') ? _groupCalloutState(gid, true) : { total: 0, on: 0 };
  const _gLocked = !!g.locked;
  const _gNested = !!g.parent;
  const _gColor  = g.color || '#64748b';
  menu.innerHTML = `
    <button onclick="toggleLayerGroup('${gid}');${close}">Свернуть / развернуть</button>
    <button onclick="toggleGroupVis(event,'${gid}');${close}">${anyVis ? 'Скрыть' : 'Показать'} группу (${members.length})</button>
    <button onclick="isolateGroup('${gid}');${close}">Показать только эту группу</button>
    <button onclick="selectGroupLayers('${gid}');${close}">Выделить слои группы</button>
    <button onclick="renameLayerGroup('${gid}');${close}">Переименовать</button>
    <button onclick="toggleGroupLock('${gid}');${close}">${_gLocked ? 'Разблокировать группу' : 'Заблокировать группу'}</button>
    <label class="src-ctx-color" onclick="event.stopPropagation()">Цвет метки
      <input type="color" value="${_gColor}" oninput="setGroupColor('${gid}', this.value)">
      <button class="src-ctx-mini" onclick="setGroupColor('${gid}', null);${close}">сброс</button>
    </label>` +
    (_gNested ? `<button onclick="unnestGroup('${gid}');${close}">Вынести на верхний уровень</button>` : '') +
    (cs.total ? `<div class="src-ctx-sep"></div>
    <button onclick="setGroupCallouts('${gid}', true, true);${close}">Выноски всей группе (${cs.total})</button>
    <button onclick="openGroupCalloutStyle('${gid}', true);${close}">Один стиль выносок группе…</button>` +
    (cs.on ? `<button onclick="setGroupCallouts('${gid}', false, true);${close}">Снять выноски (${cs.on})</button>` : '') : '') + `
    <div class="src-ctx-sep"></div>
    <button onclick="newLayerGroup();${close}">Новая группа…</button>
    <button onclick="ungroupLayers('${gid}');${close}">Разобрать группу</button>`;
  if (typeof placeCtxMenu === 'function') placeCtxMenu(menu, e);
  else { document.body.appendChild(menu); menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px'; }
  const off = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
};

function _selLayerCount() {
  return (typeof getLayerSelection === 'function') ? getLayerSelection().length : 0;
}

function _plGeoHtml() {
  const list = _plGeoList();
  if (!list.length)
    return '<div class="pl-empty" style="padding:5px 10px;font-size:var(--fs-1);color:var(--tx3)">Нет слоёв с геометрией</div>';
  const sel = new Set((typeof getLayerSelection === 'function') ? getLayerSelection() : []);
  const rows = _plWithGroups(list, (l, inGroup) => {
    const st  = l._psStyle || {};
    const col = st.color || l.color || '#f59e0b';
    const fill = st.fillColor || col;
    const op  = st.fillOpacity ?? 0.15;
    const cls = (sel.size > 1 && sel.has(l.id)) ? ' sel' : (l.id === activeLayerId ? ' active' : '');
    const badge = l.type === 'szz' ? 'СЗЗ' : l.type === 'parcel' ? 'ЗУ' : '';
    return `<div class="pl-item pl-geo-item${cls}"${inGroup ? ' style="padding-left:18px"' : ''}
         onclick="selectLayerClick(event,${l.id});_renderLayersList()"
         oncontextmenu="layerContextMenu(event,${l.id},true);return false"
         title="${(l.name || '').replace(/"/g, '&quot;')} — клик выбрать, Shift диапазон, Ctrl добавить, ПКМ меню">
      <input type="checkbox" class="pl-chk" ${_pdfSheetVisible(l) ? 'checked' : ''}
             onclick="event.stopPropagation();toggleVis(event,${l.id});_renderLayersList()" title="Видимость">
      <div class="pl-thumb" style="background:${fill};opacity:${Math.max(0.25, op + 0.25)};border-color:${col}"></div>
      ${badge ? `<span class="pl-badge">${badge}</span>` : ''}
      <span class="pl-name">${l.name || 'Без имени'}</span>
      ${(l.callout && l.callout.on) ? '<svg class="icon icon-sm pl-geo-tag"><use href="#ico-tag"/></svg>' : ''}
      <span class="pl-del" onclick="event.stopPropagation();deleteLayer(event,${l.id});_renderLayersList()" title="Удалить слой">✕</span>
    </div>`;
  });
  // Действия над выделением — те же функции, что и в меню главного окна
  const n = _selLayerCount();
  const bar = n > 1
    ? `<div class="pl-selhint">Выделено слоёв: ${n} — действия по правой кнопке</div>`
    : '';
  return bar + rows;
}

// Удаление всего выделения — с одним подтверждением, а не по слою
window._plDeleteSelected = function() {
  const ids = (typeof getLayerSelection === 'function') ? getLayerSelection() : [];
  if (ids.length < 2) return;
  askConfirm('Удалить выделенные слои?', `Будет удалено: ${ids.length}.`, () => {
    const fake = { stopPropagation() {} };
    ids.slice().forEach(id => { try { deleteLayer(fake, id); } catch(e) {} });
    _renderLayersList();
    if (typeof renderLayers === 'function') renderLayers();
  });
};




// ── Доступ для векторного экспорта (js/pdf-vector.js) ───────────────────────
// Он рисует по данным, а не по DOM, поэтому ему нужны те же вычисления,
// что и экрану: фильтр слоёв, метрики масштаба, точки стрелки, строки легенды.
window._pdfIsGeoLayerPublic = (l) => _pdfIsGeoLayer(l);
window._scaleMetricsPublic  = (d, m) => _scaleMetrics(d, m);
window._arrowPtsPublic      = (d) => _arrowPts(d);
window._legendItemsPublic   = (d) => _legendItems(d);

// Снять только подложку: объекты листа и векторные слои Leaflet прячем,
// чтобы они не попали в растр дважды
function _hideForTiles() {
  const hidden = [];
  const hide = (el) => { if (el && el.style.visibility !== 'hidden') { hidden.push([el, el.style.visibility]); el.style.visibility = 'hidden'; } };
  document.querySelectorAll('#pdf-canvas .ps-obj').forEach(hide);
  const mapEl = document.getElementById('pdf-map');
  if (mapEl) {
    mapEl.querySelectorAll('.leaflet-overlay-pane, .leaflet-marker-pane, .leaflet-shadow-pane, .leaflet-tooltip-pane')
      .forEach(hide);
    // Общий SVG выносок висит прямо на контейнере карты
    Array.from(mapEl.children).forEach(ch => { if (ch.tagName === 'svg') hide(ch); });
  }
  return () => hidden.forEach(([el, v]) => { el.style.visibility = v || ''; });
}

// Растровая подложка листа: только тайлы
async function _captureTilesOnly() {
  const canvas = document.getElementById('pdf-canvas');
  const savedTransform = canvas.style.transform;
  canvas.style.transform = 'none';
  canvas.style.transformOrigin = 'top left';
  if (pdfMap) {
    pdfMap.invalidateSize();
    pdfMap.setView(pdfMap.getCenter(), pdfMap.getZoom(), { reset: true, animate: false });
  }
  const restoreTiles = await _pdfHiResTiles();
  const restoreVec = _hideForTiles();
  await new Promise(r => setTimeout(r, 700));
  try {
    const snap = await html2canvas(canvas, {
      useCORS: true, allowTaint: false,
      scale: _exportScale(canvas), backgroundColor: '#ffffff',
      ignoreElements: el => el.classList && (el.classList.contains('ps-handle') || el.classList.contains('no-export')),
    });
    const jpg = snap.toDataURL('image/jpeg', 0.92);
    const png = snap.toDataURL('image/png');
    const usePng = png.length <= Math.max(_PNG_ALWAYS_CHARS, jpg.length * 2);
    return { data: usePng ? png : jpg, fmt: usePng ? 'PNG' : 'JPEG' };
  } finally {
    restoreVec();
    if (restoreTiles) restoreTiles();
    canvas.style.transform = savedTransform;
    canvas.style.transformOrigin = 'center center';
    if (pdfMap) pdfMap.invalidateSize(false);
  }
}

// Снимок одного объекта листа как растра — для типов, которые нечестно
// пересобирать вручную примитивами jsPDF (картинка, лупа, легенда с её
// восемью HTML/CSS-раскладками вроде сетки в две колонки). Проще и надёжнее
// один раз сфотографировать реальный DOM-элемент, чем переписывать каждую
// раскладку на координатах PDF и держать их синхронными при любой правке.
async function _captureObjRaster(obj) {
  const el = document.getElementById(obj.id);
  if (!el) return null;
  // #pdf-canvas обычно показан с CSS transform:scale(...) (зум редактора на
  // экране). html2canvas на вложенном элементе путается во вложенном
  // transform предка и накладывает контент сам на себя в двух масштабах —
  // ровно как _captureTilesOnly/renderPdf всегда сбрасывают transform в
  // 'none' перед снимком, так же нужно и здесь.
  const canvas = document.getElementById('pdf-canvas');
  const savedTransform = canvas ? canvas.style.transform : '';
  if (canvas) { canvas.style.transform = 'none'; canvas.style.transformOrigin = 'top left'; }
  try {
    const snap = await html2canvas(el, {
      useCORS: true, allowTaint: false, backgroundColor: null,
      scale: _exportScale(el),
      ignoreElements: e => e.classList && (e.classList.contains('ps-handle') || e.classList.contains('no-export')),
    });
    return { data: snap.toDataURL('image/png'), fmt: 'PNG' };
  } catch (e) { return null; }
  finally { if (canvas) { canvas.style.transform = savedTransform; canvas.style.transformOrigin = 'center center'; } }
}

// ── Векторный экспорт ───────────────────────────────────────────────────────
// Подложка остаётся растром, всё остальное — примитивы PDF: линии и текст
// не мылятся при увеличении и на печати А3/А1.
window.renderPdfVector = async function () {
  if (typeof window.renderPdfVectorSheet !== 'function') {
    setSt('Модуль векторного экспорта не загружен', 'err'); return;
  }
  _sheetsInit();
  const chosen = await _pdfPickSheetsForExport();
  if (!chosen) return;   // отменено в пикере

  const btn = document.getElementById('pdf-export-vec-btn');
  const saved = btn ? btn.innerHTML : null;
  if (btn) { btn.innerHTML = '⏳…'; btn.disabled = true; }
  selectPdfObj(null);
  const hiddenEls = _hideExportOverlays();
  const startIdx = pdfSheetIdx;
  let doc = null;
  try {
    const fontB64 = await window.loadPdfFont();
    // Жирный — отдельный файл; если вдруг не загрузится (сеть), не валим
    // весь экспорт — просто жирный текст временно выйдет как обычный,
    // как было раньше, а не откажет целиком
    const fontBoldB64 = await window.loadPdfFontBold().catch(() => null);
    for (let n = 0; n < chosen.length; n++) {
      const i = chosen[n];
      if (chosen.length > 1) setSt(`Векторный лист ${n + 1} из ${chosen.length}…`, 'ok');
      if (i !== pdfSheetIdx) { window.pdfSheetGo(i); await new Promise(r => setTimeout(r, 400)); }
      const land = pdfOrientation === 'landscape';
      const fmt = pdfFormat === 'A3' ? 'a3' : 'a4';
      const tiles = await _captureTilesOnly();
      if (!doc) {
        const { jsPDF } = window.jspdf;
        doc = new jsPDF({ orientation: land ? 'l' : 'p', unit: 'mm', format: fmt });
        doc.addFileToVFS('DejaVuSans.ttf', fontB64);
        doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
        if (fontBoldB64) {
          doc.addFileToVFS('DejaVuSans-Bold.ttf', fontBoldB64);
          doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');
        } else {
          doc.addFont('DejaVuSans.ttf', 'DejaVu', 'bold');
        }
      } else {
        doc.addPage(fmt, land ? 'l' : 'p');
      }
      await window.renderPdfVectorSheet(doc, { tiles, rasterObj: _captureObjRaster });
    }
    const al = (typeof getActiveLayer === 'function') ? getActiveLayer() : null;
    const fname = (al ? al.name : 'map').replace(/[^а-яa-z0-9_\s]/gi, '_').slice(0, 40);
    await _download(doc.output('datauristring'),
                    `${fname}_вектор_${new Date().toISOString().slice(0, 10)}.pdf`);
    setSt(`Векторный PDF сохранён ✓ — листов: ${chosen.length}`, 'ok');
  } catch (e) {
    setSt('Ошибка векторного экспорта: ' + e.message, 'err');
    console.error(e);
  } finally {
    if (pdfSheetIdx !== startIdx) window.pdfSheetGo(startIdx);
    _showExportOverlays(hiddenEls);
    if (btn && saved) { btn.innerHTML = saved; btn.disabled = false; }
  }
};

// ── Листы проекта ───────────────────────────────────────────────────────────
// Один лист — это свой набор объектов, своя ориентация и своё положение
// карты. Активный лист живёт в обычных pdfObjects/pdfOrientation, остальные
// лежат в pdfSheets; при переключении содержимое просто меняется местами.
let pdfSheets   = [];
let pdfSheetIdx = 0;
let _sheetCnt   = 0;

function _sheetsInit() {
  if (pdfSheets.length) return;
  pdfSheets = [{ id: 'sh_' + (++_sheetCnt), name: 'Лист 1',
                 objects: pdfObjects, orientation: pdfOrientation, format: pdfFormat, view: null,
                 layerVis: {}, includeInExport: true }];
  pdfSheetIdx = 0;
}

// Сохранить то, что сейчас на экране, в активный лист
function _sheetCapture() {
  _sheetsInit();
  const sh = pdfSheets[pdfSheetIdx];
  if (!sh) return;
  sh.objects = pdfObjects;
  sh.orientation = pdfOrientation;
  sh.format = pdfFormat;
  try { sh.view = (typeof _pdfCaptureView === 'function') ? _pdfCaptureView() : sh.view; } catch(e) {}
}

// Показать лист i
window.pdfSheetGo = function(i) {
  _sheetsInit();
  if (i === pdfSheetIdx || !pdfSheets[i]) return;
  _sheetCapture();
  pdfSheetIdx = i;
  const sh = pdfSheets[i];
  pdfObjects     = sh.objects || [];
  pdfOrientation = sh.orientation || 'portrait';
  pdfFormat      = sh.format || 'A4';
  pdfSelId = null;
  if (typeof _pdfMultiSelSet === 'function') { try { _pdfMultiSelSet([]); } catch(e) {} }
  _applyOrientation();
  // _applyOrientation меняет реальный layout-размер #pdf-canvas (книжная ↔
  // альбомная — разные px), а Leaflet об этом не узнаёт сам: без
  // invalidateSize() его внутренний пиксельный ноль остаётся старым, и
  // последующий setView считает координаты по неверному размеру контейнера —
  // карта «съезжает», причём съехавший центр потом попадает в _sheetCapture
  // и уже навсегда оседает в сохранённом виде листа.
  if (pdfMap && typeof pdfMap.invalidateSize === 'function') pdfMap.invalidateSize();
  // У нового активного листа своя видимость слоёв/источников/РТ
  // (pdfSheets[i].layerVis) — без этого карта редактора продолжала бы
  // показывать то, что было видно на предыдущем листе.
  if (typeof _rebuildPdfProjectLayers === 'function') _rebuildPdfProjectLayers();
  _renderAll();            // сам снимает объекты прошлого листа и его лупы
  _renderLayersList();
  _renderProps();
  _renderSheetBar();
  if (sh.view && typeof _pdfApplyView === 'function') _pdfApplyView(sh.view);
  _saveState();
  setSt(`Лист: ${sh.name}`, 'ok');
};

// Добавить лист: пустой или копию текущего
window.pdfSheetAdd = function(copy) {
  _sheetsInit();
  _sheetCapture();
  const src = pdfSheets[pdfSheetIdx];
  let objects = [];
  if (copy) {
    objects = deepClone(src.objects || []);
    // Новые id нужны не только объектам, но и группам. Раньше копия листа
    // сохраняла исходные groupId, а метаданные групп (имя, свёрнутость,
    // замок) в проекте одни на все листы — поэтому переименование, свёртка
    // или разгруппировка на копии меняли группу и на исходном листе.
    const gmap = new Map();
    objects.forEach(o => {
      o.id = 'pobj_' + (pdfObjCnt++);
      if (!o.groupId) return;
      if (!gmap.has(o.groupId))
        gmap.set(o.groupId, 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      o.groupId = gmap.get(o.groupId);
    });
    if (gmap.size && window._pdfCloneGroupMeta) window._pdfCloneGroupMeta(gmap);
  }
  pdfSheets.push({
    id: 'sh_' + (++_sheetCnt),
    name: 'Лист ' + (pdfSheets.length + 1),
    objects,
    orientation: src.orientation || pdfOrientation,
    format: src.format || pdfFormat,
    view: src.view || ((typeof _pdfCaptureView === 'function') ? _pdfCaptureView() : null),
    // Копия листа наследует его видимость слоёв; пустой новый лист — со всеми
    // слоями видимыми по умолчанию (наследование общего l.visible).
    layerVis: copy && src.layerVis ? { ...src.layerVis } : {},
    includeInExport: true,
  });
  const idx = pdfSheets.length - 1;
  pdfSheetIdx = idx - 1 >= 0 ? pdfSheetIdx : 0;   // переключаемся штатным путём
  window.pdfSheetGo(idx);
  setSt(copy ? 'Лист скопирован' : 'Новый лист добавлен', 'ok');
};

// Общий пикер листов для массового экспорта (renderPdfAllSheets/renderPdfVector).
// При одном листе ничего не спрашивает — сразу он. Выбор запоминается в
// sh.includeInExport, чтобы при следующем экспорте не отмечать заново.
// Возвращает Promise<number[]|null> — индексы в pdfSheets для экспорта,
// null — пользователь отменил (крестик/Escape/клик мимо).
function _pdfPickSheetsForExport() {
  _sheetsInit();
  if (pdfSheets.length < 2) return Promise.resolve(pdfSheets.map((_, i) => i));
  return new Promise(resolve => {
    const rows = pdfSheets.map((sh, i) => `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 2px;cursor:pointer">
        <input type="checkbox" data-sheet-idx="${i}" ${sh.includeInExport !== false ? 'checked' : ''}>
        <span>${String(sh.name || ('Лист ' + (i + 1))).replace(/</g, '&lt;')}</span>
      </label>`).join('');
    const body = `<div style="max-height:40vh;overflow:auto;text-align:left">${rows}</div>`;
    let settled = false;
    const wrap = askConfirm('Какие листы экспортировать?', body, () => {
      settled = true;
      const chosen = [];
      Array.from(wrap.querySelectorAll('input[type=checkbox]')).forEach(c => {
        const idx = parseInt(c.dataset.sheetIdx, 10);
        if (!pdfSheets[idx]) return;
        pdfSheets[idx].includeInExport = c.checked;
        if (c.checked) chosen.push(idx);
      });
      resolve(chosen.length ? chosen : null);
    }, { ok: 'Экспортировать', danger: false });
    // У askConfirm нет отдельного onCancel — ловим закрытие по любой причине
    // (крестик/Escape/клик мимо) через удаление модалки из документа, иначе
    // при отмене промис никогда не резолвится и экспорт зависает молча.
    const mo = new MutationObserver(() => {
      if (document.body.contains(wrap)) return;
      mo.disconnect();
      if (!settled) resolve(null);
    });
    mo.observe(document.body, { childList: true });
  });
}

window.pdfSheetDelete = function(i) {
  _sheetsInit();
  if (pdfSheets.length < 2) { setSt('Последний лист удалить нельзя', 'err'); return; }
  const sh = pdfSheets[i];
  if (!sh) return;
  askConfirm('Удалить лист?', `«${sh.name}» удалится вместе со всеми объектами на нём. Отменить это нельзя.`,
    () => _pdfSheetDeleteDo(i));
};

function _pdfSheetDeleteDo(i) {
  pdfSheets.splice(i, 1);
  if (pdfSheetIdx >= pdfSheets.length) pdfSheetIdx = pdfSheets.length - 1;
  else if (i < pdfSheetIdx) pdfSheetIdx--;
  const cur = pdfSheets[pdfSheetIdx];
  pdfObjects     = cur.objects || [];
  pdfOrientation = cur.orientation || 'portrait';
  pdfSelId = null;
  _applyOrientation(); _renderAll(); _renderLayersList(); _renderProps(); _renderSheetBar();
  if (cur.view && typeof _pdfApplyView === 'function') _pdfApplyView(cur.view);
  _saveState();
  setSt(`Лист удалён, осталось: ${pdfSheets.length}`, 'ok');
};

window.pdfSheetRename = function(i) {
  _sheetsInit();
  const sh = pdfSheets[i];
  if (!sh) return;
  askText('Название листа', sh.name, v => {
    sh.name = v || sh.name;
    _renderSheetBar(); _saveState();
  });
};

function _renderSheetBar() {
  _sheetsInit();
  const bar = document.getElementById('pdf-sheets');
  if (!bar) return;
  bar.innerHTML = pdfSheets.map((sh, i) => `
    <button class="pdf-sheet${i === pdfSheetIdx ? ' active' : ''}"
            onclick="pdfSheetGo(${i})" ondblclick="pdfSheetRename(${i})"
            oncontextmenu="pdfSheetMenu(event,${i});return false"
            title="${sh.name} — 2×клик переименовать, ПКМ меню">
      ${sh.name}<span class="pdf-sheet-n">${(sh.objects || []).length}</span>
    </button>`).join('') +
    `<button class="pdf-sheet-add" onclick="pdfSheetAdd(false)" title="Добавить лист">+</button>`;
}
window._renderSheetBar = _renderSheetBar;

window.pdfSheetMenu = function(e, i) {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('src-ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
  const close = "document.getElementById('src-ctx-menu')?.remove()";
  menu.innerHTML = `
    <button onclick="pdfSheetRename(${i});${close}">Переименовать</button>
    <button onclick="pdfSheetAdd(true);${close}">Дублировать лист</button>
    <div class="src-ctx-sep"></div>
    <button onclick="pdfSheetDelete(${i});${close}">Удалить лист</button>`;
  if (typeof _placeCtxMenu === 'function') _placeCtxMenu(menu, e);
  else { document.body.appendChild(menu); menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px'; }
};

// Снимок листов для проекта
window._pdfSheetsCapture = function() {
  _sheetCapture();
  // Полная копия: поверхностный клон делил с живыми объектами вложенные
  // массивы (точки ломаных, врезки), и правка на одном листе доезжала
  // в снимок, а через него — на другой лист или в другой проект
  return pdfSheets.map(sh => ({
    id: sh.id, name: sh.name, orientation: sh.orientation, format: sh.format || 'A4', view: sh.view || null,
    objects: deepClone(sh.objects || []),
    layerVis: sh.layerVis ? { ...sh.layerVis } : null,
    includeInExport: sh.includeInExport !== false,
  }));
};

// Восстановление листов из проекта
window._pdfSheetsRestore = function(list) {
  if (!Array.isArray(list) || !list.length) {
    // Старый проект: один лист из того, что уже загружено
    pdfSheets = [];
    _sheetsInit();
    _renderSheetBar();
    return;
  }
  pdfSheets = list.map((sh, i) => ({
    id: sh.id || ('sh_' + (i + 1)),
    name: sh.name || ('Лист ' + (i + 1)),
    orientation: sh.orientation || 'portrait',
    format: sh.format || 'A4',
    view: sh.view || null,
    objects: Array.isArray(sh.objects) ? sh.objects : [],
    layerVis: (sh.layerVis && typeof sh.layerVis === 'object') ? { ...sh.layerVis } : {},
    includeInExport: sh.includeInExport !== false,
  }));
  _sheetCnt = pdfSheets.length;
  pdfSheetIdx = 0;
  pdfObjects     = pdfSheets[0].objects;
  pdfOrientation = pdfSheets[0].orientation;
  pdfFormat      = pdfSheets[0].format || 'A4';
  _renderSheetBar();
};

// ── Вкладки боковой панели ──────────────────────────────────────────────────
// Лист / Объект / Слои. Выбранная вкладка запоминается, а при выделении
// объекта панель сама показывает его свойства — иначе их приходится искать.
let _pdfTab = 'sheet';

window.pdfTab = function(name, silent) {
  if (window.Workspace) name = Workspace.pdfSection(name, silent);
  _pdfTab = name || 'sheet';
  ['sheet', 'props', 'layers'].forEach(t => {
    const pane = document.getElementById('pdf-pane-' + t);
    const btn  = document.querySelector('.pdf-tab[data-tab="' + t + '"]');
    if (pane) pane.classList.toggle('active', t === _pdfTab);
    if (btn)  btn.classList.toggle('active',  t === _pdfTab);
  });
  if (!silent && typeof _UI_PREF !== 'undefined') { try { Store.set('pdfTab', _pdfTab); } catch(e) {} }
  // Карта в редакторе меняет размеры вместе с панелью
  if (typeof pdfMap !== 'undefined' && pdfMap) setTimeout(() => { try { pdfMap.invalidateSize(); } catch(e) {} }, 60);
};

// Показать свойства выбранного объекта, не заставляя искать вкладку
window._pdfTabOnSelect = function() {
  window.pdfTab('props');
};


// ── Выделение нескольких источников в панели редактора ──────────────────────
// Логика та же, что у слоёв карты: клик — выбрать, Shift — диапазон,
// Ctrl — добавить. Над выделением работают обычные функции источников.
let _srcSel = new Set();
let _srcLastId = null;

// На больших проектах (сотни-тысячи источников) список в панели — это
// столько же DOM-строк. Полная пересборка через _renderLayersList() на
// КАЖДЫЙ клик — это пересборка innerHTML всей панели (геослои + источники +
// РТ) заново: на 1426 источниках это ~900 мс мёртвого времени на каждый
// клик, то есть выбор ощутимо подвисает. Для простого клика по строке меняется
// только подсветка выделения — её можно обновить точечно (classList на уже
// существующих узлах), без пересборки: это быстрее на 2-3 порядка.
function _plSyncSrcSelection() {
  const panel = document.getElementById('pdf-layers-panel');
  if (!panel) return false;
  const rows = panel.querySelectorAll('.pl-sub-item[data-src-id]');
  if (!rows.length) return _srcSel.size === 0;   // секция свёрнута/пуста — полный рендер не нужнее
  rows.forEach(el => { el.classList.toggle('sel', _srcSel.has(el.dataset.srcId)); });
  const bar = document.getElementById('pl-src-selhint');
  if (bar) {
    bar.style.display = _srcSel.size > 1 ? '' : 'none';
    bar.textContent = `Выделено источников: ${_srcSel.size} — действия по правой кнопке`;
  }
  return true;
}

window.srcSelClick = function(e, id, ids) {
  e.stopPropagation();
  const list = ids || [];
  if (e.shiftKey && _srcLastId && list.includes(_srcLastId)) {
    const a = list.indexOf(_srcLastId), b = list.indexOf(id);
    _srcSel = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (e.ctrlKey || e.metaKey) {
    if (_srcSel.has(id)) _srcSel.delete(id); else _srcSel.add(id);
    _srcLastId = id;
  } else {
    _srcSel = new Set([id]);
    _srcLastId = id;
    if (typeof _pdfFocusSrc === 'function') _pdfFocusSrc(id);
  }
  if (!_plSyncSrcSelection()) _renderLayersList();
};

window.srcSelAction = function(what) {
  const ids = [..._srcSel];
  if (!ids.length) return;
  const srcs = (typeof _sources !== 'undefined' ? _sources : []).filter(s => ids.includes(s.id));
  if (what === 'callouts-on' || what === 'callouts-off') {
    // Подпись на карте — это showLabel, а не объект-выноска на листе
    const want = what === 'callouts-on';
    const n = (typeof srcSetLabels === 'function') ? srcSetLabels(ids, want) : 0;
    setSt(`Подписи источников ${want ? 'включены' : 'скрыты'}: ${n}`, 'ok');
  } else if (what === 'leader') {
    // Выноска с полочкой на самом листе
    srcs.forEach(s => { try { window.srcToggleCallout(s.id); } catch(e) {} });
    setSt(`Выноски на листе переключены: ${srcs.length}`, 'ok');
  } else if (what === 'duplicate') {
    srcs.forEach(s => { try { window.srcDuplicate(s.id); } catch(e) {} });
  } else if (what === 'delete') {
    askConfirm('Удалить источники?', `Будет удалено: ${srcs.length}.`, () => {
      srcs.forEach(s => { try { window.deleteSource(s.id); } catch(e) {} });
      _srcSel.clear();
      _renderLayersList();
    });
    return;
  }
  _renderLayersList();
};

window.srcSelMenu = function(e, id, ids) {
  e.preventDefault(); e.stopPropagation();
  if (!_srcSel.has(id)) { _srcSel = new Set([id]); _srcLastId = id; if (!_plSyncSrcSelection()) _renderLayersList(); }
  if (_srcSel.size < 2 && typeof srcContextMenu === 'function') return srcContextMenu(e, id);
  document.getElementById('src-ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
  const close = "document.getElementById('src-ctx-menu')?.remove()";
  menu.innerHTML = `
    <div class="src-ctx-hdr">Выделено источников: ${_srcSel.size}</div>
    <button onclick="srcSelAction('callouts-on');${close}">Показать подписи на карте</button>
    <button onclick="srcSelAction('callouts-off');${close}">Скрыть подписи на карте</button>
    <button onclick="srcSelAction('leader');${close}">Выноска с полочкой на листе</button>
    <div class="src-ctx-sep"></div>
    <button onclick="srcSelAction('duplicate');${close}">Дублировать</button>
    <button class="src-ctx-del" onclick="srcSelAction('delete');${close}">✕ Удалить</button>`;
  if (typeof _placeCtxMenu === 'function') _placeCtxMenu(menu, e);
  else { document.body.appendChild(menu); menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px'; }
};

// ── Панель слоёв ──────────────────────────────────
function _renderLayersList() {
  const panel = document.getElementById('pdf-layers-panel');
  const OBJ_ICONS = { text:'T', rect:'▭', ellipse:'◯', line:'╱', legend:'≡', scale:'⊢⊣', north:'N↑', image:'▣', inset:'⊞', arrow:'→', path:'∿', bezier:'〰', callout:'▯', leader:'⌐', 'src-leader':'⌖' };
  const SRC_ICONS = { emission:'◎', noise:'◉', other:'○' };
  // Тип источника задаёт группу, а не подпись в каждой строке
  const SRC_GROUPS = [
    { type:'emission', name:'Выбросы', layers:['src-emission'] },
    { type:'noise',    name:'Шум',     layers:['src-noise']    },
    { type:'other',    name:'Прочие',  layers:['src-other']    },
  ];

  // ── Секция «Объекты» ──
  const objList = pdfObjects.filter(o => _plMatch(o.name) || _plMatch(_typeName(o.type)));
  // Список строит UX-блок: он умеет заголовки групп, вложение и замки
  const objContent = window._pdfObjListHtml(objList);

  // ── Секция «Источники» ──
  const srcsAll = typeof _sources !== 'undefined' ? _sources : [];
  const srcs = srcsAll.filter(s2 => _plMatch(s2.name) || _plMatch('№' + (s2.num || '')));
  // Источники были плоским списком: при трёхстах источниках это триста строк
  // в колонке 248 px, и в каждой повторялся тип («выбр.», «шум»). Отдельным
  // рядом сверху висели переключатели видимости — управление слоями стояло
  // стопкой над списком объектов. Теперь тип задаёт группу, переключатель
  // видимости живёт на её заголовке, а из строк повтор типа убран.
  const _srcRow = (s, ids) => {
    const ico = SRC_ICONS[s.type||'emission'] || '●';
    const lbl = s.name ? s.name : `${ico} №${s.num||''}`;
    const col = s.color || '#ef4444';
    const _sel = _srcSel.has(s.id) ? ' sel' : '';
    return `<div class="pl-item pl-sub-item${_sel}" data-src-id="${s.id}"
         onclick="srcSelClick(event,'${s.id}',${ids})"
         oncontextmenu="srcSelMenu(event,'${s.id}',${ids});return false"
         title="Клик — выбрать и показать, Shift — диапазон, Ctrl — добавить, ПКМ — меню">
      <div class="pl-thumb" style="background:${col};border-color:${col};color:#fff;font-size:var(--fs-0);font-weight:700">${s.num||ico}</div>
      <span class="pl-name">${lbl}</span>
    </div>`;
  };
  // Порядок строк для Shift-диапазона — один массив на панель. Раньше он
  // вписывался JSON-ом в onclick КАЖДОЙ строки: при 2000 источниках это
  // ~100 МБ HTML и секунды на каждую пересборку панели.
  window._plSrcIds = srcs.map(x => x.id);
  const _allIds = '_plSrcIds';
  const srcContent = srcs.length === 0
    ? '<div class="pl-empty" style="padding:5px 10px;font-size:var(--fs-1);color:var(--tx3)">Нет источников</div>'
    : SRC_GROUPS.map(g => {
        const list = srcs.filter(x => (x.type || 'emission') === g.type);
        if (!list.length) return '';
        const open = _plSrcGrp[g.type] !== false;
        return `<div class="pl-subsection-hdr" onclick="togglePlSrcGroup('${g.type}')"
            oncontextmenu="plTypeMenu(event,${JSON.stringify(g.layers).replace(/"/g, '&quot;')},'${g.name}');return false"
            title="Клик — свернуть, ПКМ — меню">
            <span class="pl-section-arrow">${open ? '▾' : '▸'}</span>
            <span style="flex:1">${g.name} <span style="opacity:.5;font-weight:400">(${list.length})</span></span>
            ${_plVisChip(g.layers, 'Показать')}
          </div>
          ${open ? list.map(x => _srcRow(x, _allIds)).join('') : ''}`;
      }).join('');

  // Контейнер подсказки всегда в DOM (просто скрыт/пуст, когда не нужен) —
  // это даёт _plSyncSrcSelection() ниже обновлять его точечно, без полной
  // пересборки панели
  const srcSelBar = `<div class="pl-selhint" id="pl-src-selhint" style="${_srcSel.size > 1 ? '' : 'display:none'}">Выделено источников: ${_srcSel.size} — действия по правой кнопке</div>`;
  const srcVisRow = srcSelBar;

  // ── Секция «РТ» ──
  const mpsAll = typeof _monPoints !== 'undefined' ? _monPoints : [];
  const mps = mpsAll.filter(p => _plMatch(p.name) || _plMatch('РТ-' + (p.num || '')));
  // Выделение здесь то же, что в окне РТ: клик, Shift — диапазон, Ctrl —
  // добавить. Диапазон считается по порядку строк этой панели.
  const mpSelN = (typeof window.mpSelSize === 'function') ? window.mpSelSize() : 0;
  // Порядок строк — как в mapLayers, чтобы участники группы шли подряд
  // и шапка группы вставала перед ними, ровно как на основной карте
  const mpLayerRows = (typeof mapLayers !== 'undefined' ? mapLayers : [])
    .filter(l => l.mpId && mps.some(p => p.id === l.mpId));
  const mpById = new Map(mps.map(p => [p.id, p]));
  window._plMpIds = mpLayerRows.map(l => l.mpId);
  const mpIdsAttr = '_plMpIds';
  // Своих кнопок тут нет: всё, что можно сделать с выделением, лежит в меню
  // по правой кнопке — там же, где и у остальных слоёв
  const mpVisRow = mpSelN
    ? `<div class="pl-selhint">Выделено РТ: ${mpSelN} — действия по правой кнопке</div>`
    : (mps.length > 1
        ? '<div class="pl-selhint" style="opacity:.7">Клик — выбрать, Shift — диапазон, Ctrl — добавить, ПКМ — меню</div>'
        : '');
  const mpContent = mps.length === 0
    ? '<div class="pl-empty" style="padding:5px 10px;font-size:var(--fs-1);color:var(--tx3)">Нет расчётных точек</div>'
    : _plWithGroups(mpLayerRows, (gl, inGroup) => {
        const p = mpById.get(gl.mpId);
        if (!p) return '';
        const col = p.color || '#3b82f6';
        const sel = (typeof window.mpSelHas === 'function') && window.mpSelHas(p.id);
        // Подпись берём из строки слоя, а не собираем заново: иначе панель
        // клеила «РТ-1» + название «1» и получалось «РТ-1 1»
        const lbl = gl.name ? String(gl.name).replace(/</g, '&lt;')
                  : (typeof window.mpRowLabel === 'function' ? window.mpRowLabel(p) : `РТ-${p.num}`);
        const hidden = !_pdfSheetVisible(gl);
        return `<div class="pl-item pl-sub-item${sel ? ' sel' : ''}"
             style="${inGroup ? 'padding-left:18px;' : ''}${sel ? 'background:rgba(59,130,246,.18);box-shadow:inset 2px 0 0 var(--acc2);' : ''}${hidden ? 'opacity:.45;' : ''}"
             onclick="pdfMpClick(event,'${p.id}',${mpIdsAttr})"
             oncontextmenu="layerContextMenu(event,${gl.id},true);return false"
             title="Клик — выбрать, Shift — диапазон, Ctrl — добавить, 2×клик — центрировать, ПКМ — меню"
             ondblclick="_pdfFocusMp('${p.id}')">
          <input type="checkbox" class="pl-chk" ${hidden ? '' : 'checked'}
                 onclick="event.stopPropagation();toggleVis(event,${gl.id});_renderLayersList()" title="Видимость">
          <div class="pl-thumb" style="background:${col};border-color:${col};color:#fff;font-size:var(--fs-0);font-weight:700">${p.num||'●'}</div>
          <span class="pl-name">${lbl}</span>
        </div>`;
      });

  panel.innerHTML = `
    <div class="pl-search-row">
      <input type="text" id="pl-search" value="${_plQuery.replace(/"/g,'&quot;')}"
             oninput="plSearch(this.value)" placeholder="Поиск объекта, источника, РТ…"
             autocomplete="off" spellcheck="false">
      ${_plQuery ? `<button onclick="plSearch('')" title="Сбросить">✕</button>` : ''}
    </div>
    <div class="pl-list" id="pl-list-inner">

      <div class="pl-section-hdr" onclick="togglePlSection('geo')"
           oncontextmenu="plTypeMenu(event,'geo','Слои карты');return false">
        <span class="pl-section-arrow">${_plGeoExpanded?'▾':'▸'}</span>
        <span style="flex:1">Слои карты <span style="opacity:.5;font-weight:400">(${_plGeoList().length})</span></span>
        ${_selLayerCount() > 1 ? `<span class="pl-selcnt" title="Выделено слоёв">${_selLayerCount()}</span>` : ''}
      </div>
      ${_plGeoExpanded ? `<div class="pl-geo-box">${_plGeoHtml()}</div>` : ''}

      <div class="pl-section-hdr" onclick="togglePlSection('src')"
           oncontextmenu="plTypeMenu(event,['src-emission','src-noise','src-other'],'Источники');return false">
        <span class="pl-section-arrow">${_plSrcExpanded?'▾':'▸'}</span>
        <span style="flex:1">Источники <span style="opacity:.5;font-weight:400">(${srcs.length}${srcs.length !== srcsAll.length ? ' из ' + srcsAll.length : ''})</span></span>
        ${_plVisChip(_SRC_CALLOUT_TYPES, 'Выноски')}
      </div>
      ${_plSrcExpanded ? srcVisRow + srcContent : ''}

      <div class="pl-section-hdr" onclick="togglePlSection('mp')"
           oncontextmenu="plTypeMenu(event,'mp','Расчётные точки');return false">
        <span class="pl-section-arrow">${_plMpExpanded?'▾':'▸'}</span>
        <span style="flex:1">Расчётные точки <span style="opacity:.5;font-weight:400">(${mps.length}${mps.length !== mpsAll.length ? ' из ' + mpsAll.length : ''})</span></span>
        ${_plVisChip(['monpoints'], 'Точки')}
        ${_plVisChip(['mp-callouts'], 'Выноски')}
      </div>
      ${_plMpExpanded ? mpVisRow + mpContent : ''}

    </div>
  `;
  _renderObjectsPanel(objList, objContent);
  if (window.Workspace) Workspace.pdfTreeBuilt();
}

// Список объектов листа — во вкладке «Объект», рядом со свойствами:
// искать объект в соседней вкладке было незачем
function _renderObjectsPanel(objList, objContent) {
  const box = document.getElementById('pdf-objects-panel');
  if (!box) return;
  box.innerHTML = `
    <div class="pl-section-hdr" onclick="togglePlSection('obj')">
      <span class="pl-section-arrow">${_plObjExpanded ? '▾' : '▸'}</span>
      <span style="flex:1">Объекты листа <span style="opacity:.5;font-weight:400">(${objList.length}${objList.length !== pdfObjects.length ? ' из ' + pdfObjects.length : ''})</span></span>
      <button class="pl-order-btn" onclick="event.stopPropagation();movePdfObjDown()" title="На передний план">↑</button>
      <button class="pl-order-btn" onclick="event.stopPropagation();movePdfObjUp()" title="На задний план">↓</button>
    </div>
    ${_plObjExpanded ? objContent : ''}`;
}

// ПКМ по шапке раздела («Расчётные точки», «Выбросы», «Шум») — те же
// команды выносок и видимости, что у групп слоёв (layersCalloutMenu, map.js)
window.plTypeMenu = function(e, types, title) {
  const ids = (types === 'geo' ? _plGeoList() : (typeof mapLayers !== 'undefined' ? mapLayers : [])
    .filter(l => types === 'mp' ? !!l.mpId : types.includes(l.type))).map(l => l.id);
  if (!ids.length) { e.preventDefault(); return; }
  window.layersCalloutMenu(e, ids, title);
};

window.togglePlSrcGroup = function(type) {
  _plSrcGrp[type] = _plSrcGrp[type] === false;
  _renderLayersList();
};

function togglePlSection(sec) {
  if (sec === 'geo') _plGeoExpanded = !_plGeoExpanded;
  if (sec === 'obj') _plObjExpanded = !_plObjExpanded;
  if (sec === 'src') _plSrcExpanded = !_plSrcExpanded;
  if (sec === 'mp')  _plMpExpanded  = !_plMpExpanded;
  _renderLayersList();
}

function _pdfFocusSrc(id) {
  if (!pdfMap) return;
  const s = (typeof _sources !== 'undefined' ? _sources : []).find(x => x.id === id);
  if (!s) return;
  let lat, lon;
  if (s.points && s.points.length) {
    lat = s.points.reduce((a, p) => a + (p[0]||p.lat||0), 0) / s.points.length;
    lon = s.points.reduce((a, p) => a + (p[1]||p.lon||0), 0) / s.points.length;
  } else { lat = s.lat; lon = s.lon; }
  if (lat != null && lon != null) { pdfMap.panTo([lat, lon]); setSt(`Центр на источнике №${s.num||s.id}`, 'ok'); }
}

// Строка РТ в панели: обычный клик выделяет и центрирует карту, клик с
// Shift/Ctrl — только набирает выделение, карту при этом не дёргаем
window.pdfMpClick = function(e, id, ids) {
  if (typeof window.mpSelClick === 'function') window.mpSelClick(e, id, ids);
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) _pdfFocusMp(id);
};

function _pdfFocusMp(id) {
  if (!pdfMap) return;
  const p = (typeof _monPoints !== 'undefined' ? _monPoints : []).find(x => x.id === id);
  if (!p || p.lat == null) return;
  pdfMap.panTo([p.lat, p.lon]);
  setSt(`Центр на РТ-${p.num}`, 'ok');
}

function togglePdfObjVis(e, id) {
  if (e && e.altKey && window.isolatePdfObjects) {
    e.stopPropagation(); e.preventDefault();
    window.isolatePdfObjects([id], 'объект');
    return;
  }
  e.stopPropagation();
  const obj = pdfObjects.find(o => o.id === id);
  if (!obj) return;
  obj.visible = !obj.visible;
  const el = document.getElementById(id);
  if (el) el.style.display = obj.visible ? 'flex' : 'none';
  _renderLayersList();
  _saveState();
}

// ── Рендер всех объектов ──────────────────────────
function _renderAll() {
  // Удаляем все объекты; для инсетов сначала убиваем Leaflet-карту
  document.querySelectorAll('.ps-obj').forEach(el => {
    if (_insetMaps[el.id]) {
      try { _insetMaps[el.id].remove(); } catch(e) {}
      delete _insetMaps[el.id];
    }
    el.remove();
  });
  pdfObjects.forEach(obj => _renderObj(obj, true));
  _syncObjDomOrder();        // один проход вместо перестановки на каждый объект
  // Обновляем якоря полочек после отрисовки
  setTimeout(_updateAllSrcLeaderTails, 100);
}

// ── Стандартные объекты ───────────────────────────
function _addDefaultObjects() {
  const al = getActiveLayer();
  const title = al ? `Карта объекта: ${al.name}` : 'Схема расположения земельных участков';
  // Светлая подложка у заголовка: на спутнике тёмный текст на прозрачном фоне не читался
  const { W } = _pdfCanvasSize();
  createPdfObj('text', { x:20, y:16, w:Math.min(460, W - 40), h:46, content: title, name:'Заголовок',
    fontWeight:'700', shelf:true, bg:'rgba(255,255,255,0.92)', strokeColor:'#0f172a', strokeW:1.5, radius:3 });
  addPdfLegend();
  addPdfScale();
  addPdfNorth();
  selectPdfObj(null);
}

function addPdfLegend() {
  const { H } = _pdfCanvasSize();
  createPdfObj('legend', { x:14, y:H-160, w:240, h:140, name:'Легенда' });
  setPdfTool('select');
}
function addPdfScale() {
  const { W, H } = _pdfCanvasSize();
  createPdfObj('scale', { x:W-190, y:H-66, name:'Масштаб' });
  setPdfTool('select');
}
function addPdfNorth() {
  const { W } = _pdfCanvasSize();
  // Светлая подложка — иначе тёмная стрелка теряется на спутниковой подложке
  createPdfObj('north', { x:W-76, y:16, name:'Стрелка С', bg:'rgba(255,255,255,0.9)', radius:4 });
  setPdfTool('select');
}

// ── Изображение ───────────────────────────────────
function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const sel = pdfObjects.find(o => o.id === pdfSelId);
    if (sel && sel.type === 'image') {
      // Выбрана картинка — заменяем содержимое, а не создаём новую
      _pushUndo();
      sel.data.imgSrc = ev.target.result;
      sel.name = file.name.slice(0, 20);
      _renderObj(sel); _renderLayersList(); _renderProps(); _saveState();
    } else {
      // Размер по пропорциям исходника (вписываем в 260px)
      const img = new Image();
      img.onload = () => {
        const k = Math.min(260 / img.naturalWidth, 260 / img.naturalHeight, 1);
        createPdfObj('image', {
          imgSrc: ev.target.result,
          w: Math.max(40, Math.round(img.naturalWidth * k)),
          h: Math.max(40, Math.round(img.naturalHeight * k)),
          name: file.name.slice(0, 20),
        });
        setPdfTool('select');
      };
      img.src = ev.target.result;
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

window.applyImgOpacity = function(v) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.type !== 'image') return;
  obj.data.imgOpacity = (+v) / 100;
  const lbl = document.getElementById('pp-imgop-val');
  if (lbl) lbl.textContent = v + '%';
  _renderObj(obj);
  _saveState();
};

// ── Хук: вызывается из sources.js при удалении источников ───────────────────
// Работает внутри скоупа pdf-editor.js — все переменные гарантированно доступны.
window._pdfOnSourcesDeleted = function(deletedIds) {
  const ids = new Set(deletedIds);

  // 1. Удаляем src-leader объекты из pdfObjects (аннотации PDF-редактора)
  let changed = false;
  for (let i = pdfObjects.length - 1; i >= 0; i--) {
    const o = pdfObjects[i];
    if (o.type === 'src-leader' && o.data && ids.has(o.data.srcId)) {
      const el = document.getElementById(o.id);
      if (el) el.remove();
      pdfObjects.splice(i, 1);
      changed = true;
    }
  }
  if (changed) {
    _renderLayersList();
    _saveState();
  }

  // 2. Если PDF-карта открыта — перерисовываем слои источников
  // (иначе старые выноски ShelfLeader остаются на pdfMap)
  if (pdfMap) _refreshPdfMapLayers();
};

// ── Сохранение состояния ──────────────────────────
function _saveState() {
  if (typeof markDirty === 'function') markDirty();
  try {
    const state = pdfObjects.map(obj => ({
      id:      obj.id,
      type:    obj.type,
      name:    obj.name,
      locked:  obj.locked,
      visible: obj.visible,
      groupId: obj.groupId,
      data:    { ...obj.data, imgSrc: obj.data.imgSrc ? '[img]' : '' }, // не сохраняем base64
    }));
    Store.set('pdfObjects', state);
    if (window._pdfCaptureGroups) Store.set('pdfGroups', window._pdfCaptureGroups());
    Store.set('pdfOrientation', pdfOrientation);
    Store.set('pdfWasInit', true); // пользователь хоть раз открывал редактор
  } catch(e) {}
}

function _loadState() {
  // null = ключ никогда не сохранялся (первый запуск)
  const rawSaved = Store.get('pdfObjects', null);
  const wasInit  = Store.get('pdfWasInit', false) || rawSaved !== null;
  pdfOrientation = Store.get('pdfOrientation', 'portrait');
  // Восстанавливаем объекты без изображений (base64 не сериализуем)
  pdfObjects = (rawSaved || []).filter(o => o.type && o.data).map(o => {
    const data = { ...OBJ_DEFAULTS[o.type] || OBJ_DEFAULTS.rect, ...o.data };
    if (o.type === 'src-leader') _migrateSrcLeader(data);
    return { ...o, data };
  });
  // Чтобы новые объекты не конфликтовали по id
  const maxCnt = pdfObjects.reduce((m, o) => {
    const n = parseInt((o.id || '').replace('pobj_', '')) || 0;
    return Math.max(m, n + 1);
  }, pdfObjCnt);
  pdfObjCnt = maxCnt;
  return wasInit; // true = состояние уже сохранялось, не добавлять дефолты
}

// ── Хелперы для цветов ────────────────────────────
function _rgbaToHex(color) {
  if (!color || color === 'transparent') return '#ffffff';
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return color.startsWith('#') ? color : '#ffffff';
  return '#' + [m[1],m[2],m[3]].map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
}
function _rgbaAlpha(color) {
  if (!color || color === 'transparent') return 0;
  const m = color.match(/[\d.]+\)$/);
  return m ? parseFloat(m[0]) : 1;
}

// ── Клавиатура ────────────────────────────────────
document.addEventListener('keydown', e => {
  if (document.getElementById('pdf-editor').style.display === 'none') return;
  if (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // e.code — физическая клавиша: работает и в русской раскладке
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Delete' || e.key === 'Backspace') deletePdfObj();
  if (!mod && e.code === 'KeyV') setPdfTool('select');
  if (!mod && e.code === 'KeyT') setPdfTool('text');
  if (!mod && e.code === 'KeyR') setPdfTool('rect');
  if (!mod && e.code === 'KeyE') setPdfTool('ellipse');
  if (!mod && e.code === 'KeyL') setPdfTool('line');
  if (!mod && e.code === 'KeyP') setPdfTool('path');
  if (!mod && e.code === 'KeyB') setPdfTool('bezier');
  if (!mod && e.code === 'KeyF') setPdfTool('freehand');
  // Enter — завершить начатый путь/линию/многоугольник (многоугольник замыкается)
  if (e.key === 'Enter' && _pathDraft && _pathDraft.pts.length >= 2) {
    e.preventDefault();
    _finishPath(pdfTool === 'polygon-shape');
    return;
  }
  if (e.key === 'Escape') {
    if (window.exitPdfGroup && window.exitPdfGroup()) return;
    if (window._pdfIsIsolated && window._pdfIsIsolated()) { window.clearPdfIsolate(); return; }
    _clearPathGhost(); selectPdfObj(null); setPdfTool('select');
  }
  if (mod && e.code === 'KeyD') { e.preventDefault(); duplicatePdfObj(); }
  if (mod && e.code === 'KeyG' && !e.shiftKey) { e.preventDefault(); groupPdfObjects(); }
  if (mod && e.code === 'KeyG' &&  e.shiftKey) { e.preventDefault(); ungroupPdfObjects(); }
  if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undoPdf(); }
  if (mod && (e.code === 'KeyY' || (e.shiftKey && e.code === 'KeyZ'))) { e.preventDefault(); redoPdf(); }
  if (mod && e.code === 'KeyC') { e.preventDefault(); copyPdfObj(); }
  if (mod && e.code === 'KeyV') { e.preventDefault(); pastePdfObj(); }

  // Стрелки — двигать объект
  if (pdfSelId && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    const obj = pdfObjects.find(o => o.id === pdfSelId);
    if (obj && !obj.locked) {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft')  obj.data.x -= step;
      if (e.key === 'ArrowRight') obj.data.x += step;
      if (e.key === 'ArrowUp')    obj.data.y -= step;
      if (e.key === 'ArrowDown')  obj.data.y += step;
      const el = document.getElementById(obj.id);
      if (el) { el.style.left = obj.data.x+'px'; el.style.top = obj.data.y+'px'; }
      _syncPropsXY();
      e.preventDefault();
    }
  }
});

// ── Экспорт PDF ───────────────────────────────────
// Снять текущий лист в картинку: вся подготовка (hi-res тайлы, фикс SVG,
// скрытие ручек) нужна одинаково и для одного листа, и для пачки листов.
async function _captureSheetImage() {
  const canvas = document.getElementById('pdf-canvas');
  const savedTransform = canvas.style.transform;
  canvas.style.transform = 'none';
  canvas.style.transformOrigin = 'top left';
  if (pdfMap) {
    pdfMap.invalidateSize();
    pdfMap.setView(pdfMap.getCenter(), pdfMap.getZoom(), { reset: true, animate: false });
  }
  Object.values(_insetMaps).forEach(m => {
    try { m.invalidateSize(); m.setView(m.getCenter(), m.getZoom(), { reset: true, animate: false }); } catch(e){}
  });
  const restoreTiles = await _pdfHiResTiles();
  await new Promise(r => setTimeout(r, 800));
  document.querySelectorAll('.callout-handle').forEach(el => el.setAttribute('display', 'none'));
  const svgFixed = [
    ..._fixLeafletSvgForExport(pdfMap),
    ...Object.values(_insetMaps).flatMap(m => { try { return _fixLeafletSvgForExport(m); } catch(e) { return []; } }),
  ];
  try {
    const snap = await html2canvas(canvas, {
      useCORS: true, allowTaint: false,
      scale: _exportScale(canvas), backgroundColor: '#ffffff',
      ignoreElements: el => el.classList && (el.classList.contains('ps-handle') || el.classList.contains('no-export')),
    });
    const png = snap.toDataURL('image/png');
    const jpg = snap.toDataURL('image/jpeg', 0.96);
    const pngOk = png.length <= Math.max(_PNG_ALWAYS_CHARS, jpg.length * 3)
               && png.length <= _PDF_MAX_EMBED_CHARS;
    return { data: pngOk ? png : jpg, fmt: pngOk ? 'PNG' : 'JPEG',
             land: pdfOrientation === 'landscape', a3: pdfFormat === 'A3' };
  } finally {
    _restoreLeafletSvg(svgFixed);
    if (restoreTiles) restoreTiles();
    canvas.style.transform = savedTransform;
    canvas.style.transformOrigin = 'center center';
    if (pdfMap) pdfMap.invalidateSize(false);
    Object.values(_insetMaps).forEach(m => { try { m.invalidateSize(false); } catch(e){} });
  }
}

// Все листы проекта — в один PDF, по странице на лист
window.renderPdfAllSheets = async function() {
  _sheetsInit();
  if (pdfSheets.length < 2) return renderPdf();
  const chosen = await _pdfPickSheetsForExport();
  if (!chosen) return;   // отменено в пикере
  if (chosen.length === 1) return renderPdf();

  const btn = document.getElementById('pdf-export-pdf-btn');
  const savedHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.innerHTML = '<svg class="icon icon-sm"><use href="#ico-save"/></svg>⏳…'; btn.disabled = true; }

  selectPdfObj(null);
  const hidden = _hideExportOverlays();
  const startIdx = pdfSheetIdx;
  let doc = null;
  try {
    for (let n = 0; n < chosen.length; n++) {
      const i = chosen[n];
      setSt(`Готовлю лист ${n + 1} из ${chosen.length}…`, 'ok');
      if (i !== pdfSheetIdx) { window.pdfSheetGo(i); await new Promise(r => setTimeout(r, 400)); }
      const shot = await _captureSheetImage();
      const short = shot.a3 ? 297 : 210, long = shot.a3 ? 420 : 297;
      const w = shot.land ? long : short, h = shot.land ? short : long;
      const pageFmt = shot.a3 ? 'a3' : 'a4';
      if (!doc) {
        const { jsPDF } = window.jspdf;
        doc = new jsPDF({ orientation: shot.land ? 'l' : 'p', unit: 'mm', format: pageFmt });
      } else {
        doc.addPage(pageFmt, shot.land ? 'l' : 'p');
      }
      doc.addImage(shot.data, shot.fmt, 0, 0, w, h, undefined, 'FAST');
    }
    const al = (typeof getActiveLayer === 'function') ? getActiveLayer() : null;
    const fname = (al ? al.name : 'map').replace(/[^а-яa-z0-9_\s]/gi, '_').slice(0, 40);
    await _download(doc.output('datauristring'),
                    `${fname}_${chosen.length}л_${new Date().toISOString().slice(0, 10)}.pdf`);
    setSt(`PDF сохранён ✓ — листов: ${chosen.length}`, 'ok');
  } catch(e) {
    setSt('Ошибка генерации PDF: ' + e.message, 'err');
    console.error(e);
  } finally {
    if (pdfSheetIdx !== startIdx) window.pdfSheetGo(startIdx);
    _showExportOverlays(hidden);
    if (btn && savedHtml) { btn.innerHTML = savedHtml; btn.disabled = false; }
  }
};

async function renderPdf() {
  const btn = document.getElementById('pdf-export-pdf-btn');
  const savedHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.innerHTML = '<svg class="icon icon-sm"><use href="#ico-save"/></svg>⏳…'; btn.disabled = true; }

  selectPdfObj(null);
  const hiddenEls = _hideExportOverlays();
  const canvas = document.getElementById('pdf-canvas');
  const isLand = pdfOrientation === 'landscape';

  // Сбрасываем transform чтобы карта не смещалась при захвате
  const savedTransform = canvas.style.transform;
  canvas.style.transform = 'none';
  canvas.style.transformOrigin = 'top left';
  if (pdfMap) {
    pdfMap.invalidateSize();
    // { reset: true } форсирует полный ре-рендер Leaflet (viewreset + _update SVG-слоёв)
    pdfMap.setView(pdfMap.getCenter(), pdfMap.getZoom(), { reset: true, animate: false });
  }
  Object.values(_insetMaps).forEach(m => {
    try { m.invalidateSize(); m.setView(m.getCenter(), m.getZoom(), { reset: true, animate: false }); } catch(e){}
  });
  // Подложка удвоенного разрешения + ожидание отрисовки тайлов
  const restoreTiles = await _pdfHiResTiles();
  await new Promise(r => setTimeout(r, 800));
  // Повторно скрываем ручки выносок (могли быть показаны заново через viewreset → _draw)
  document.querySelectorAll('.callout-handle').forEach(el => el.setAttribute('display', 'none'));
  // Конвертируем transform:translate3d → top/left на SVG-слоях (html2canvas не читает translate3d)
  const svgFixed = [
    ..._fixLeafletSvgForExport(pdfMap),
    ...Object.values(_insetMaps).flatMap(m => { try { return _fixLeafletSvgForExport(m); } catch(e) { return []; } }),
  ];
  try {
    const snap  = await html2canvas(canvas, {
      useCORS: true,
      allowTaint: false,
      scale: _exportScale(canvas),
      backgroundColor: '#ffffff',
      ignoreElements: el => el.classList && (el.classList.contains('ps-handle') || el.classList.contains('no-export')),
    });

    // PNG без потерь: JPEG размывал подписи, тонкие линии и штриховки.
    // На схематичной подложке PNG весит не больше JPEG — берём его.
    // На спутнике PNG раздувается в 5–10 раз, там переходим на JPEG высокого
    // качества, иначе PDF получается на десятки мегабайт.
    const png = snap.toDataURL('image/png');
    const jpg = snap.toDataURL('image/jpeg', 0.96);
    const pngOk = png.length <= Math.max(_PNG_ALWAYS_CHARS, jpg.length * 3)
               && png.length <= _PDF_MAX_EMBED_CHARS;
    const imgData = pngOk ? png : jpg;
    const imgFmt  = pngOk ? 'PNG' : 'JPEG';
    const { jsPDF } = window.jspdf;
    const { w: pdfW, h: pdfH } = _pdfPageMm();
    const doc  = new jsPDF({ orientation: isLand ? 'l' : 'p', unit: 'mm', format: pdfFormat === 'A3' ? 'a3' : 'a4' });
    doc.addImage(imgData, imgFmt, 0, 0, pdfW, pdfH, undefined, 'FAST');

    const al    = getActiveLayer();
    const fname = (al ? al.name : 'map').replace(/[^а-яa-z0-9_\s]/gi,'_').slice(0,40);
    const pdfFilename = `${fname}_${new Date().toISOString().slice(0,10)}.pdf`;
    await _download(doc.output('datauristring'), pdfFilename);
    setSt(imgFmt === 'PNG' ? 'PDF сохранён ✓ (без потерь)'
                           : 'PDF сохранён ✓ (фотоподложка — сжатие JPEG)', 'ok');
  } catch(e) {
    setSt('Ошибка генерации PDF: ' + e.message, 'err');
    console.error(e);
  } finally {
    _restoreLeafletSvg(svgFixed);
    if (restoreTiles) restoreTiles();
  }

  // Восстанавливаем transform
  canvas.style.transform = savedTransform;
  canvas.style.transformOrigin = 'center center';
  if (pdfMap) pdfMap.invalidateSize(false);
  Object.values(_insetMaps).forEach(m => { try { m.invalidateSize(false); } catch(e){} });
  _showExportOverlays(hiddenEls);
  if (btn && savedHtml) { btn.innerHTML = savedHtml; btn.disabled = false; }
}

// ── stub для совместимости ────────────────────────
function updatePdfOverlays() {
  if (document.getElementById('pdf-editor').style.display !== 'none') {
    pdfObjects.filter(o => ['legend','scale'].includes(o.type)).forEach(obj => {
      const el = document.getElementById(obj.id);
      if (el) _renderObjContent(el, obj);
    });
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   UX-блок редактора PDF
   • группы видны в списке объектов, сворачиваются, прячутся и блокируются
   • в группу можно войти двойным кликом и править один объект
   • выделение рамкой по холсту и Shift/Ctrl-выделение в списке
   • перетаскивание порядка объектов в списке
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Метаданные групп: имя, свёрнутость, замок ───────────────────────────────
// Раньше группа существовала только как поле groupId у объекта: в списке её
// не было видно, имени у неё не было, а _saveState её вообще не сохранял —
// после перезагрузки проекта группировка молча исчезала.
let _pdfGroupMeta = {};

function _pdfLoadGroups() {
  try {
    const g = (typeof Store !== 'undefined' && Store.get) ? Store.get('pdfGroups') : null;
    _pdfGroupMeta = g && typeof g === 'object' ? g : {};
  } catch (e) { _pdfGroupMeta = {}; }
}
function _pdfSaveGroups() {
  try { if (typeof Store !== 'undefined' && Store.set) Store.set('pdfGroups', _pdfGroupMeta); } catch (e) {}
}
window._pdfCaptureGroups = () => JSON.parse(JSON.stringify(_pdfGroupMeta));
window._pdfRestoreGroups = (g) => { _pdfGroupMeta = (g && typeof g === 'object') ? JSON.parse(JSON.stringify(g)) : {}; };

function _pdfGroupIds() {
  const ids = [];
  pdfObjects.forEach(o => { if (o.groupId && !ids.includes(o.groupId)) ids.push(o.groupId); });
  return ids;
}
function _pdfGroupObjs(gid) { return pdfObjects.filter(o => o.groupId === gid); }

function _pdfGroupInfo(gid) {
  if (!_pdfGroupMeta[gid]) _pdfGroupMeta[gid] = { name: _pdfAutoGroupName(gid), collapsed: false, locked: false };
  return _pdfGroupMeta[gid];
}

// C21. Имя группы по её содержимому: «Выноска + Текст ×3» понятнее «Группы 4»
function _pdfAutoGroupName(gid) {
  const objs = _pdfGroupObjs(gid);
  if (!objs.length) return 'Группа';
  const counts = {};
  objs.forEach(o => { const t = _typeName(o.type); counts[t] = (counts[t] || 0) + 1; });
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([t, c]) => c > 1 ? `${t} ×${c}` : t);
  const more = Object.keys(counts).length > 2 ? ' +…' : '';
  return parts.join(' + ') + more;
}

// ── Вход в группу ───────────────────────────────────────────────────────────
// Пока мы «внутри», объекты группы двигаются поодиночке, как в Illustrator.
let _pdfEnteredGroup = null;

window.enterPdfGroup = function(gid) {
  if (!gid) return;
  _pdfEnteredGroup = gid;
  _pdfSyncEnteredClass();
  _renderLayersList();
  setSt(`Вход в группу «${_pdfGroupInfo(gid).name}» — Esc выйти`, 'ok');
};

window.exitPdfGroup = function() {
  if (!_pdfEnteredGroup) return false;
  _pdfEnteredGroup = null;
  _pdfSyncEnteredClass();
  _renderLayersList();
  setSt('Выход из группы', 'ok');
  return true;
};

function _pdfSyncEnteredClass() {
  pdfObjects.forEach(o => {
    const el = document.getElementById(o.id);
    if (el) el.classList.toggle('ps-in-entered-group', !!_pdfEnteredGroup && o.groupId === _pdfEnteredGroup);
  });
  const bar = document.getElementById('pdf-group-bar');
  if (bar) {
    if (_pdfEnteredGroup) {
      bar.style.display = '';
      bar.innerHTML = `<span>В группе: <b>${_pdfGroupInfo(_pdfEnteredGroup).name}</b></span>` +
                      `<button onclick="exitPdfGroup()">Выйти (Esc)</button>`;
    } else bar.style.display = 'none';
  }
}
window._pdfSyncEnteredClass = _pdfSyncEnteredClass;
window._pdfInEnteredGroup = obj => !!_pdfEnteredGroup && obj && obj.groupId === _pdfEnteredGroup;

// ── Список объектов с группами ──────────────────────────────────────────────
const _PDF_OBJ_ICONS = { text:'T', rect:'▭', ellipse:'◯', line:'╱', legend:'≡', scale:'⊢⊣',
  north:'N↑', image:'▣', inset:'⊞', arrow:'→', path:'∿', bezier:'〰', callout:'▯',
  leader:'⌐', 'src-leader':'⌖' };

function _pdfObjRowHtml(obj, depth) {
  const icon = _PDF_OBJ_ICONS[obj.type] || '?';
  const sel  = obj.id === pdfSelId;
  const multi = _pdfMultiSelHas(obj.id);
  return `<div class="pl-item ${sel ? 'selected' : ''} ${multi ? 'multi' : ''} ${obj.locked ? 'locked' : ''}"
       style="--o-depth:${depth || 0}"
       draggable="true"
       ondragstart="onPdfObjDragStart(event,'${obj.id}')"
       ondragover="onPdfObjDragOver(event)"
       ondragleave="onPdfObjDragLeave(event)"
       ondrop="onPdfObjDrop(event,'${obj.id}')"
       ondragend="onPdfObjDragEnd(event)"
       onclick="pdfListClick(event,'${obj.id}')"
       ondblclick="pdfListDblClick(event,'${obj.id}')"
       title="Клик — выбрать · Ctrl/Shift+клик — несколько · 2×клик — войти в группу">
    <span class="pl-vis" onclick="togglePdfObjVis(event,'${obj.id}')" style="color:${obj.visible?'var(--acc2)':'var(--tx3)'}" title="Видимость (Alt — только этот объект)"><svg class="icon icon-sm"><use href="#ico-${obj.visible?'eye':'eye-off'}"/></svg></span>
    <div class="pl-thumb">${icon}</div>
    <span class="pl-name" ondblclick="event.stopPropagation();renamePdfObj(event,'${obj.id}')">${obj.name}</span>
    <span class="pl-lock ${obj.locked ? 'on' : ''}" onclick="event.stopPropagation();togglePdfObjLock('${obj.id}')" title="${obj.locked ? 'Разблокировать' : 'Заблокировать'}"><svg class="icon icon-sm"><use href="#ico-${obj.locked ? 'lock' : 'unlock'}"/></svg></span>
  </div>`;
}

function _pdfGroupRowHtml(gid) {
  const g = _pdfGroupInfo(gid);
  const objs = _pdfGroupObjs(gid);
  const visN = objs.filter(o => o.visible).length;
  const entered = _pdfEnteredGroup === gid;
  return `<div class="pl-group ${g.collapsed ? 'collapsed' : ''} ${entered ? 'entered' : ''} ${g.locked ? 'locked' : ''}"
       ondragover="onPdfGroupDragOver(event)"
       ondragleave="onPdfObjDragLeave(event)"
       ondrop="onPdfGroupDrop(event,'${gid}')"
       onclick="togglePdfGroup('${gid}')"
       ondblclick="event.stopPropagation();enterPdfGroup('${gid}')"
       oncontextmenu="pdfGroupMenu(event,'${gid}');return false"
       title="Клик — свернуть · 2×клик — войти в группу · ПКМ — меню">
    <span class="pl-group-arrow">${g.collapsed ? '▸' : '▾'}</span>
    <span class="pl-vis" onclick="event.stopPropagation();togglePdfGroupVis('${gid}')" style="color:${visN ? 'var(--acc2)' : 'var(--tx3)'}" title="Видимость всей группы"><svg class="icon icon-sm"><use href="#ico-${visN ? 'eye' : 'eye-off'}"/></svg></span>
    <span class="pl-group-name" id="pgname-${gid}"
          contenteditable="false"
          onblur="savePdfGroupName('${gid}')"
          onkeydown="pdfGroupNameKey(event,'${gid}')"
          ondblclick="event.stopPropagation();renamePdfGroup('${gid}')">${escapeHtml(g.name)}</span>
    <span class="pl-group-cnt">${objs.length}</span>
    <span class="pl-lock ${g.locked ? 'on' : ''}" onclick="event.stopPropagation();togglePdfGroupLock('${gid}')" title="${g.locked ? 'Разблокировать группу' : 'Заблокировать группу'}"><svg class="icon icon-sm"><use href="#ico-${g.locked ? 'lock' : 'unlock'}"/></svg></span>
  </div>`;
}

// Список объектов: одиночки и группы вперемешку, в порядке pdfObjects
window._pdfObjListHtml = function(objList) {
  if (!objList.length) {
    return `<div class="pl-empty">${pdfObjects.length ? 'Ничего не найдено' : 'На листе пока нет объектов.<br>Выберите инструмент слева.'}</div>`;
  }
  const out = [];
  const doneGroups = new Set();
  objList.forEach(obj => {
    const gid = obj.groupId;
    if (gid && _pdfGroupObjs(gid).length > 1) {
      if (!doneGroups.has(gid)) {
        doneGroups.add(gid);
        out.push(_pdfGroupRowHtml(gid));
      }
      if (_pdfGroupInfo(gid).collapsed) return;
      out.push(_pdfObjRowHtml(obj, 1));
    } else {
      out.push(_pdfObjRowHtml(obj, 0));
    }
  });
  return out.join('');
};

// ── Операции над группой ────────────────────────────────────────────────────
window.togglePdfGroup = function(gid) {
  const g = _pdfGroupInfo(gid);
  g.collapsed = !g.collapsed;
  _pdfSaveGroups();
  _renderLayersList();
};

window.togglePdfGroupVis = function(gid) {
  const objs = _pdfGroupObjs(gid);
  const to = !objs.every(o => o.visible);
  _pushUndo();
  objs.forEach(o => {
    o.visible = to;
    const el = document.getElementById(o.id);
    if (el) el.style.display = to ? 'flex' : 'none';
  });
  _renderLayersList(); _saveState();
};

window.togglePdfGroupLock = function(gid) {
  const g = _pdfGroupInfo(gid);
  g.locked = !g.locked;
  _pushUndo();
  _pdfGroupObjs(gid).forEach(o => { o.locked = g.locked; });
  _pdfSaveGroups();
  _renderAll(); _renderLayersList(); _saveState();
  setSt(g.locked ? `Группа «${g.name}» заблокирована` : `Группа «${g.name}» разблокирована`, 'ok');
};

window.renamePdfGroup = function(gid) {
  const span = document.getElementById('pgname-' + gid);
  if (!span) return;
  span.contentEditable = 'true';
  span.focus();
  try { document.execCommand('selectAll', false, null); } catch (e) {}
};

window.pdfGroupNameKey = function(e, gid) {
  e.stopPropagation();
  if (e.key === 'Enter')  { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { e.preventDefault(); e.target.textContent = _pdfGroupInfo(gid).name; e.target.blur(); }
};

window.savePdfGroupName = function(gid) {
  const span = document.getElementById('pgname-' + gid);
  if (!span) return;
  const g = _pdfGroupInfo(gid);
  g.name = span.textContent.trim() || g.name;
  span.contentEditable = 'false';
  span.textContent = g.name;
  _pdfSaveGroups();
  if (typeof markDirty === 'function') markDirty();
};

window.selectPdfGroup = function(gid) {
  const objs = _pdfGroupObjs(gid);
  if (!objs.length) return;
  _pdfMultiSelSet(objs.map(o => o.id));
  selectPdfObj(objs[0].id);
  setSt(`Выделено объектов: ${objs.length}`, 'ok');
};

window.isolatePdfGroup = function(gid) {
  const keep = new Set(_pdfGroupObjs(gid).map(o => o.id));
  window.isolatePdfObjects([...keep], `группа «${_pdfGroupInfo(gid).name}»`);
};

window.pdfGroupMenu = function(e, gid) {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('src-ctx-menu')?.remove();
  const g = _pdfGroupInfo(gid);
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu'; menu.className = 'src-ctx-menu';
  const close = "document.getElementById('src-ctx-menu')?.remove()";
  menu.innerHTML = `
    <div class="src-ctx-hdr">${escapeHtml(g.name)}</div>
    <button onclick="enterPdfGroup('${gid}');${close}">Войти в группу <span class="src-ctx-key">2×клик</span></button>
    <button onclick="selectPdfGroup('${gid}');${close}">Выделить объекты группы</button>
    <button onclick="isolatePdfGroup('${gid}');${close}">Показать только эту группу</button>
    <button onclick="renamePdfGroup('${gid}');${close}">Переименовать</button>
    <button onclick="togglePdfGroupLock('${gid}');${close}">${g.locked ? 'Разблокировать' : 'Заблокировать'}</button>
    <div class="src-ctx-sep"></div>
    <button onclick="ungroupPdfGroup('${gid}');${close}">Разгруппировать <span class="src-ctx-key">Ctrl+Shift+G</span></button>`;
  if (typeof _placeCtxMenu === 'function') _placeCtxMenu(menu, e);
  else { document.body.appendChild(menu); menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px'; }
};

window.ungroupPdfGroup = function(gid) {
  const objs = _pdfGroupObjs(gid);
  if (!objs.length) return;
  _pushUndo();
  objs.forEach(o => { delete o.groupId; });
  delete _pdfGroupMeta[gid];
  if (_pdfEnteredGroup === gid) _pdfEnteredGroup = null;
  _pdfSaveGroups();
  _renderLayersList(); _saveState();
  setSt(`Группа разобрана (${objs.length})`, 'ok');
};

// ── Множественное выделение: доступ к набору ────────────────────────────────
function _pdfMultiSelHas(id) {
  try { return _pdfMultiSel.has(id); } catch (e) { return false; }
}
function _pdfMultiSelSet(ids) {
  try {
    _pdfMultiSel.clear();
    ids.forEach(i => _pdfMultiSel.add(i));
    _paintSelection();
  } catch (e) {}
}
window._pdfMultiSelSet = _pdfMultiSelSet;

// ── C19. Shift/Ctrl-клик в списке ───────────────────────────────────────────
let _pdfListAnchor = null;

window.pdfListClick = function(e, id) {
  const ids = pdfObjects.map(o => o.id);
  if (e.shiftKey && _pdfListAnchor) {
    const a = ids.indexOf(_pdfListAnchor), b = ids.indexOf(id);
    if (a > -1 && b > -1) _pdfMultiSelSet(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (e.ctrlKey || e.metaKey) {
    // Активный объект тоже часть выделения: ниже selectPdfObj перенесёт
    // pdfSelId на новый, и без этого первый кликнутый потерялся бы
    if (pdfSelId && pdfSelId !== id && !_pdfMultiSel.has(pdfSelId)) _pdfMultiSel.add(pdfSelId);
    togglePdfMultiSel(id);
    _pdfListAnchor = id;
  } else {
    _pdfMultiSelSet([]);
    _pdfListAnchor = id;
  }
  selectPdfObj(id);
};

window.pdfListDblClick = function(e, id) {
  e.stopPropagation();
  const obj = pdfObjects.find(o => o.id === id);
  if (obj && obj.groupId) window.enterPdfGroup(obj.groupId);
};

// ── C20. Перетаскивание порядка в списке ────────────────────────────────────
let _pdfDragObjId = null;

window.onPdfObjDragStart = function(e, id) {
  _pdfDragObjId = id;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', id); } catch (err) {}
};
window.onPdfObjDragOver = function(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
};
window.onPdfGroupDragOver = function(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
};
window.onPdfObjDragLeave = function(e) { e.currentTarget.classList.remove('drag-over'); };
window.onPdfObjDragEnd = function() {
  _pdfDragObjId = null;
  document.querySelectorAll('.pl-item, .pl-group').forEach(el => el.classList.remove('drag-over'));
};

window.onPdfObjDrop = function(e, targetId) {
  e.preventDefault(); e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  if (!_pdfDragObjId || _pdfDragObjId === targetId) { _pdfDragObjId = null; return; }
  const from = pdfObjects.findIndex(o => o.id === _pdfDragObjId);
  const to   = pdfObjects.findIndex(o => o.id === targetId);
  if (from < 0 || to < 0) { _pdfDragObjId = null; return; }
  _pushUndo();
  const [moved] = pdfObjects.splice(from, 1);
  const target = pdfObjects[to > from ? to - 1 : to];
  // Группу берём у строки, на которую бросили: так объект входит в группу
  // или выходит из неё тем же жестом, что и на карте
  if (target && target.groupId) moved.groupId = target.groupId;
  else delete moved.groupId;
  pdfObjects.splice(pdfObjects.indexOf(target) + (to > from ? 1 : 0), 0, moved);
  _pdfDragObjId = null;
  _renderAll(); _renderLayersList(); _saveState();
};

window.onPdfGroupDrop = function(e, gid) {
  e.preventDefault(); e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  if (!_pdfDragObjId) return;
  const obj = pdfObjects.find(o => o.id === _pdfDragObjId);
  if (!obj) { _pdfDragObjId = null; return; }
  _pushUndo();
  obj.groupId = gid;
  // Ставим в конец блока группы, чтобы строки не разъезжались
  const members = _pdfGroupObjs(gid).filter(o => o.id !== obj.id);
  pdfObjects = pdfObjects.filter(o => o.id !== obj.id);
  const lastIdx = members.length ? pdfObjects.indexOf(members[members.length - 1]) : pdfObjects.length - 1;
  pdfObjects.splice(lastIdx + 1, 0, obj);
  _pdfDragObjId = null;
  _renderAll(); _renderLayersList(); _saveState();
  setSt(`«${obj.name}» перенесён в группу «${_pdfGroupInfo(gid).name}»`, 'ok');
};

// ── Замок и изоляция объектов ───────────────────────────────────────────────
window.togglePdfObjLock = function(id) {
  const ids = _pdfMultiSelHas(id) ? [..._pdfMultiSel] : [id];
  const first = pdfObjects.find(o => o.id === ids[0]);
  const to = !(first && first.locked);
  _pushUndo();
  ids.forEach(i => { const o = pdfObjects.find(x => x.id === i); if (o) o.locked = to; });
  _renderAll(); _renderLayersList(); _saveState();
};

let _pdfIsolateSnap = null;

window.isolatePdfObjects = function(keepIds, label) {
  if (_pdfIsolateSnap) { window.clearPdfIsolate(); return; }
  const keep = new Set(keepIds);
  _pdfIsolateSnap = pdfObjects.map(o => ({ id: o.id, visible: o.visible }));
  pdfObjects.forEach(o => {
    o.visible = keep.has(o.id);
    const el = document.getElementById(o.id);
    if (el) el.style.display = o.visible ? 'flex' : 'none';
  });
  _renderLayersList();
  setSt(`Изоляция: ${label || 'объект'} — Esc или повторный Alt+клик вернёт всё`, 'ok');
};

window.clearPdfIsolate = function() {
  if (!_pdfIsolateSnap) return false;
  const snap = _pdfIsolateSnap;
  _pdfIsolateSnap = null;
  snap.forEach(s => {
    const o = pdfObjects.find(x => x.id === s.id);
    if (!o) return;
    o.visible = s.visible;
    const el = document.getElementById(o.id);
    if (el) el.style.display = o.visible ? 'flex' : 'none';
  });
  _renderLayersList();
  setSt('Видимость объектов возвращена', 'ok');
  return true;
};
window._pdfIsIsolated = () => !!_pdfIsolateSnap;

// ── C18. Выделение рамкой по холсту ─────────────────────────────────────────
function _initPdfMarquee() {
  const canvas = document.getElementById('pdf-canvas');
  if (!canvas || canvas._marqueeBound) return;
  canvas._marqueeBound = true;

  canvas.addEventListener('pointerdown', e => {
    if (pdfTool !== 'select') return;
    if (pdfMapDrag) return;                       // включён режим таскания карты
    if (e.button !== 0) return;
    // Рамка начинается только с пустого места: по объекту работает перетаскивание
    if (e.target.closest('.ps-obj') || e.target.closest('.ps-handle')) return;
    if (e.target.closest('#pdf-map') && !e.shiftKey) return;   // по карте — только с Shift

    const rect = canvas.getBoundingClientRect();
    const sx = canvas.offsetWidth / rect.width, sy = canvas.offsetHeight / rect.height;
    const x0 = (e.clientX - rect.left) * sx, y0 = (e.clientY - rect.top) * sy;

    const box = document.createElement('div');
    box.className = 'ps-marquee';
    canvas.appendChild(box);
    let moved = false;

    const draw = (x1, y1) => {
      box.style.left   = Math.min(x0, x1) + 'px';
      box.style.top    = Math.min(y0, y1) + 'px';
      box.style.width  = Math.abs(x1 - x0) + 'px';
      box.style.height = Math.abs(y1 - y0) + 'px';
    };

    const onMove = ev => {
      const r = canvas.getBoundingClientRect();
      const x1 = (ev.clientX - r.left) * (canvas.offsetWidth / r.width);
      const y1 = (ev.clientY - r.top)  * (canvas.offsetHeight / r.height);
      if (Math.abs(x1 - x0) > 3 || Math.abs(y1 - y0) > 3) moved = true;
      draw(x1, y1);
    };

    const onUp = ev => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const r = canvas.getBoundingClientRect();
      const x1 = (ev.clientX - r.left) * (canvas.offsetWidth / r.width);
      const y1 = (ev.clientY - r.top)  * (canvas.offsetHeight / r.height);
      box.remove();
      if (!moved) return;                          // просто клик — снимет выделение штатный обработчик
      const L = Math.min(x0, x1), T = Math.min(y0, y1);
      const R = Math.max(x0, x1), B = Math.max(y0, y1);
      const hit = pdfObjects.filter(o => {
        if (!o.visible || o.locked) return false;
        const d = o.data;
        return d.x < R && d.x + d.w > L && d.y < B && d.y + d.h > T;
      });
      if (!hit.length) { _pdfMultiSelSet([]); selectPdfObj(null); return; }
      // Группы захватываются целиком, если мы не внутри группы
      const ids = new Set();
      hit.forEach(o => {
        if (o.groupId && _pdfEnteredGroup !== o.groupId) _pdfGroupObjs(o.groupId).forEach(m => ids.add(m.id));
        else ids.add(o.id);
      });
      _pdfMultiSelSet([...ids]);
      selectPdfObj(hit[0].id);
      setSt(`Рамкой выделено: ${ids.size}`, 'ok');
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, true);
}
window._initPdfMarquee = _initPdfMarquee;

// Полоска «вы внутри группы» над холстом
function _initPdfGroupBar() {
  if (document.getElementById('pdf-group-bar')) return;
  const host = document.getElementById('pdf-canvas-wrap') || document.getElementById('pdf-editor');
  if (!host) return;
  const bar = document.createElement('div');
  bar.id = 'pdf-group-bar';
  bar.style.display = 'none';
  host.appendChild(bar);
}
window._initPdfGroupBar = _initPdfGroupBar;

_pdfLoadGroups();

// Регистрация и забвение групп — вызываются из штатных groupPdfObjects/ungroupPdfObjects
window._pdfRegisterGroup = function(gid) {
  _pdfGroupMeta[gid] = { name: _pdfAutoGroupName(gid), collapsed: false, locked: false };
  _pdfSaveGroups();
};
window._pdfForgetGroup = function(gid) {
  delete _pdfGroupMeta[gid];
  if (_pdfEnteredGroup === gid) _pdfEnteredGroup = null;
  _pdfSaveGroups();
};
// Копия листа получает свои группы: переносим настройки со старых id на новые,
// чтобы имя и замок у копии были как у исходника, но жили отдельно от него
window._pdfCloneGroupMeta = function(gmap) {
  gmap.forEach((nid, oid) => {
    const src = _pdfGroupMeta[oid];
    _pdfGroupMeta[nid] = src ? { ...src } : { name: 'Группа', collapsed: false, locked: false };
  });
  _pdfSaveGroups();
};

/* ── Меню экспорта ──────────────────────────────────────────────────────── */
window.togglePdfExportMenu = function (ev) {
  if (ev) ev.stopPropagation();
  const m = document.getElementById('pdf-export-menu');
  if (!m) return;
  const open = m.style.display !== 'none';
  m.style.display = open ? 'none' : 'block';
  if (!open) {
    // Меню висит под кнопкой в шапке — места вниз хватает всегда, но если
    // окно низкое, общий расчёт ограничит высоту вместо ухода за край.
    const btn = document.getElementById('pdf-export-btn');
    if (btn && typeof placePopup === 'function') {
      const r = btn.getBoundingClientRect();
      // Переводим в координаты экрана: в CSS меню прижато к правому краю
      // обёртки, а общий расчёт задаёт left/top — правило right пришлось бы
      // гасить, иначе ширина зажимается с двух сторон.
      m.style.position = 'fixed';
      m.style.right = 'auto';
      m.style.bottom = 'auto';
      placePopup(m, r.right - m.offsetWidth, r.bottom + 4, { flipFrom: r.top - 4 });
    }
    // Закрытие по клику мимо — вешаем один раз на текущее открытие
    setTimeout(() => document.addEventListener('mousedown', _pdfExportOutside), 0);
  }
};
window.closePdfExportMenu = function () {
  const m = document.getElementById('pdf-export-menu');
  if (m) m.style.display = 'none';
  document.removeEventListener('mousedown', _pdfExportOutside);
};
function _pdfExportOutside(e) {
  const w = document.querySelector('.pdf-export-wrap');
  if (w && !w.contains(e.target)) window.closePdfExportMenu();
}
