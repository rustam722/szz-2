// ═══════════════════════════════════════════════
// MONPOINTS.JS — Расчётные точки (РТ)
// ═══════════════════════════════════════════════
'use strict';

let _monPoints           = [];
let _mpLayerGroup        = null;
let _mpCalloutLayerGroup = null;
let _mpCounter           = 0;
let _mpEditId            = null;

const MP_DEFAULT_COLOR = '#3b82f6';

// ── Инициализация ─────────────────────────────────────────────────────────────
function _initMonPoints() {
  if (!_mpLayerGroup)        _mpLayerGroup        = L.layerGroup().addTo(map);
  if (!_mpCalloutLayerGroup) _mpCalloutLayerGroup = L.layerGroup().addTo(map);
}

// ── Якорь РТ (для ShelfLeader) ────────────────────────────────────────────────
// ShelfLeader вызывает _srcAnchor(s) — для РТ нужно чтобы s.lat/lon были заполнены
// _srcAnchor возвращает [lat, lon] для точечных объектов, что нам и нужно.

// ── Отрисовка ─────────────────────────────────────────────────────────────────
// Своя группа Leaflet на каждую точку: так штатный _reconcileLayerVis может
// включать и выключать РТ по отдельности, как любой другой слой
function _mpGrp(pt) {
  if (!pt._grp) {
    pt._grp = L.layerGroup();
    if (pt.hidden !== true && typeof map !== 'undefined' && map) pt._grp.addTo(map);
  }
  return pt._grp;
}

function _drawMonPoint(pt) {
  const grp = _mpGrp(pt);
  const color = pt.color || MP_DEFAULT_COLOR;
  const circle = L.circleMarker([pt.lat, pt.lon], {
    radius: 7, color, fillColor: color, fillOpacity: 0.85, weight: 2,
  }).addTo(grp);
  const label = `<b>РТ-${pt.num}</b>${pt.name ? ' ' + pt.name : ''}`;
  circle.bindTooltip(label, { direction: 'top', offset: [0, -8] });
  circle.on('click', e => { L.DomEvent.stop(e); _mpEditId = pt.id; openMonPointsModal(); });
  circle.on('contextmenu', e => { L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e); mpContextMenu(e.originalEvent, pt.id); });
  pt._circleLayer = circle;

  // Выноска
  if (pt.showLabel) _drawMpCallout(pt);
}

function _drawMpCallout(pt) {
  if (!_mpCalloutLayerGroup || typeof _makeCalloutLayersGlobal !== 'function') return;
  pt._onSave = _saveMonPoints; // кастомный save для drag
  const layers = _makeCalloutLayersGlobal(pt, _mpCalloutLayerGroup, true);
  pt._calloutLayers = layers;
}

function _clearMpCallout(pt) {
  (pt._calloutLayers || []).forEach(l => {
    try { _mpCalloutLayerGroup.removeLayer(l); } catch(e) {}
  });
  pt._calloutLayers = [];
}

function _clearMonPointLayer(pt) {
  if (pt._circleLayer && pt._grp) { try { pt._grp.removeLayer(pt._circleLayer); } catch(e) {} }
  pt._circleLayer = null;
  _clearMpCallout(pt);
}

// Точка уходит из проекта — снимаем и её группу Leaflet
function _mpDropGrp(pt) {
  _clearMonPointLayer(pt);
  if (pt._grp && typeof map !== 'undefined' && map) { try { map.removeLayer(pt._grp); } catch(e) {} }
  pt._grp = null;
}

// ── Сохранение ────────────────────────────────────────────────────────────────
// Видимость, имя, цвет и группа РТ живут в её строке панели слоёв — там их
// меняют штатными командами. Перед сохранением переносим их в саму точку,
// иначе после перезагрузки проекта всё это терялось.
function _mpPullStateFromLayers() {
  if (typeof mapLayers === 'undefined') return;
  mapLayers.forEach(l => {
    if (!l.mpId) return;
    const pt = _monPoints.find(p => p.id === l.mpId);
    if (!pt) return;
    pt.hidden = l.visible === false;
    if (l.groupId) pt.groupId = l.groupId; else delete pt.groupId;
    // Своё имя запоминаем, только если строку правда переименовали. Иначе
    // авто-подпись «РТ-N …» замёрзла бы при первом же сохранении и перестала
    // обновляться после перенумерации или переименования точки
    // Имя точки отсюда НЕ переписываем: сохранение бывает раньше, чем строка
    // успеет обновиться, и свежее имя затиралось бы старой подписью строки.
    // Переименование строки обрабатывается отдельно — в mpRenameFromLayer().
    const auto = _mpLabel({ ...pt, layerName: undefined });
    if (l.name && l.name !== auto) pt.layerName = l.name; else delete pt.layerName;
    // Цвет забираем, только если его правда поменяли на строке (панель стиля).
    // Иначе цвет, заданный в форме РТ или в меню, откатывался назад: сохранение
    // идёт раньше пересинхронизации, и строка ещё держит прежнее значение.
    if (l.color && l.color !== l._mpColorSync) pt.color = l.color;
    // Стиль из панели свойств слоя (толщина, прозрачность, обводка) хранится
    // на строке. В настройках авто-слоёв ему места нет — они одни на тип,
    // а строк-точек много, поэтому держим стиль в самой точке.
    if (l._psStyle && Object.keys(l._psStyle).length) pt._psStyle = { ...l._psStyle };
    else delete pt._psStyle;
  });
}

// Вернуть точкам их группы после загрузки проекта. Порядок восстановления
// такой: сначала создаются слои (в том числе строки РТ), и только потом
// приходят сами группы — поэтому членство проставляем отдельным шагом.
window._mpReapplyGroups = function() {
  if (typeof mapLayers === 'undefined') return 0;
  let n = 0;
  mapLayers.forEach(l => {
    if (!l.mpId) return;
    const pt = _monPoints.find(p => p.id === l.mpId);
    if (!pt) return;
    const gid = pt.groupId;
    if (gid && typeof window._layerGroupExists === 'function' && window._layerGroupExists(gid)) {
      if (l.groupId !== gid) { l.groupId = gid; n++; }
    } else if (l.groupId) {
      delete l.groupId;       // группы больше нет — не держим висячую ссылку
    }
  });
  if (n && typeof renderLayers === 'function') renderLayers();
  return n;
};

// Строку РТ переименовали в панели слоёв. Строка — это сама точка, поэтому
// новое имя должно попасть и на выноску (на карте и на листе PDF).
window.mpRenameFromLayer = function(mpId, newName) {
  const pt = _monPoints.find(p => p.id === mpId);
  const nm = String(newName || '').trim();
  if (!pt || !nm) return;
  const l = _mpLayerOf(mpId);
  if (l) l.name = nm;
  pt.layerName = nm;
  // При «подписях номерами» на выноске стоит номер, а настоящее имя отдельно
  if (pt.calloutFullName != null) pt.calloutFullName = nm;
  else if (pt.name !== nm) {
    pt.name = nm;
    if (pt.showLabel) { _clearMpCallout(pt); _drawMpCallout(pt); }
    // Подпись у самого кружка тоже держит имя
    if (pt._circleLayer) {
      try { pt._circleLayer.setTooltipContent(`<b>РТ-${pt.num}</b> ${nm}`); } catch (e) {}
    }
  }
  _saveMonPoints();
  _mpRenderList();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
};

function _mpClean(pt) {
  const { _circleLayer, _calloutLayers, _onSave, _grp, ...rest } = pt;
  return rest;
}

function _saveMonPoints() {
  if (typeof markDirty === 'function') markDirty();
  _mpPullStateFromLayers();
  localStorage.setItem('szztool_monpoints', JSON.stringify(_monPoints.map(_mpClean)));
}

// ── Синхронизация слоёв ───────────────────────────────────────────────────────
// Настройки слоя (видимость/цвет/стиль), запомненные для типа авто-слоя.
// Без них слой пересоздавался бы видимым — скрытые РТ «всплывали» обратно.
function _mpPref(type) {
  return (typeof window._autoLayerPref === 'function' && window._autoLayerPref(type)) || null;
}
function _mpNewEntry(id, type, name, group) {
  const pref = _mpPref(type);
  return { id, type, name, poly: null, layer: group,
    visible: pref ? pref.visible !== false : true,
    color: (pref && pref.color) || MP_DEFAULT_COLOR,
    _psStyle: (pref && pref._psStyle) ? { ...pref._psStyle } : {} };
}
function _mpReconcile(type) {
  const l = mapLayers.find(x => x.type === type);
  if (l && typeof window._reconcileLayerVis === 'function') window._reconcileLayerVis(l);
}

// Имя строки в панели: своё, если его меняли, иначе «РТ-N название».
// Название не приклеиваем, если оно и есть номер: «РТ-1 1» и «РТ-1 РТ-1» —
// это просто «РТ-1». Так же и после «подписей номерами»: там настоящее
// название уезжает в calloutFullName, а в name остаётся порядковый номер.
function _mpLabel(pt) {
  if (pt.layerName) return pt.layerName;
  const n = 'РТ-' + (pt.num || '?');
  const raw = pt.calloutFullName != null ? pt.calloutFullName : pt.name;
  const nm = String(raw == null ? '' : raw).trim();
  if (!nm || nm === n || nm === String(pt.num)) return n;
  return n + ' ' + nm;
}
window.mpRowLabel = _mpLabel;

// Описательная часть названия — без повтора номера. В окне РТ номер уже
// стоит отдельной колонкой, поэтому «РТ-1» с названием «1» — это пусто
function _mpNamePart(pt) {
  const lbl = _mpLabel(pt);
  const n = 'РТ-' + (pt.num || '?');
  return lbl === n ? '' : (lbl.startsWith(n + ' ') ? lbl.slice(n.length + 1) : lbl);
}

// Каждая РТ — отдельная строка в панели слоёв, как любой другой слой: своё
// выделение, группировка штатными командами, видимость, перетаскивание, ПКМ.
// Сводной строки «Расч. точки» больше нет — она мешала группировать точки.
function _syncMonPointsLayer() {
  if (typeof mapLayers === 'undefined' || typeof renderLayers !== 'function') return;

  const byMp = new Map();
  mapLayers.forEach(l => { if (l.mpId) byMp.set(l.mpId, l); });

  // Убираем строки удалённых точек
  const alive = new Set(_monPoints.map(p => p.id));
  for (let i = mapLayers.length - 1; i >= 0; i--) {
    const l = mapLayers[i];
    if (l.mpId && !alive.has(l.mpId)) { mapLayers.splice(i, 1); byMp.delete(l.mpId); }
  }
  // Старая сводная строка из прежних проектов — она больше не нужна
  const oldAgg = mapLayers.findIndex(l => l.type === 'monpoints' && !l.mpId);
  if (oldAgg >= 0) mapLayers.splice(oldAgg, 1);

  const knownGroup = gid => gid && typeof window._layerGroupExists === 'function'
    ? window._layerGroupExists(gid) : !!gid;

  _monPoints.forEach(pt => {
    let l = byMp.get(pt.id);
    if (!l) {
      l = {
        id: (typeof _newLayerId === 'function' ? _newLayerId() : Date.now() + Math.random()),
        type: 'monpoints', mpId: pt.id, name: _mpLabel(pt), poly: null, layer: _mpGrp(pt),
        visible: pt.hidden !== true, color: pt.color || MP_DEFAULT_COLOR,
        _psStyle: pt._psStyle ? { ...pt._psStyle } : {},
      };
      // Группу точка помнит сама: её id слоя при каждой загрузке новый
      if (pt.groupId && knownGroup(pt.groupId)) l.groupId = pt.groupId;
      l._mpColorSync = l.color;
      mapLayers.push(l);
    } else {
      l.layer = _mpGrp(pt);
      if (!pt.layerName) l.name = _mpLabel(pt);     // имя не переопределяли — держим актуальным
      // Цвет точки — ведущий; запоминаем, что именно отдали строке, чтобы
      // потом отличить правку цвета на строке от устаревшего значения
      if (pt.color && l.color !== pt.color && l.color === l._mpColorSync) l.color = pt.color;
      l._mpColorSync = l.color;
    }
    if (typeof window._reconcileLayerVis === 'function') window._reconcileLayerVis(l);
  });
  renderLayers();
}

function _syncMpCalloutLayer() {
  if (typeof mapLayers === 'undefined' || typeof renderLayers !== 'function') return;
  const hasCallouts = _monPoints.some(p => p.showLabel);
  const existing = mapLayers.find(l => l.type === 'mp-callouts');
  if (!hasCallouts) {
    if (existing) {
      if (typeof window._rememberAutoLayer === 'function') window._rememberAutoLayer(existing);
      mapLayers.splice(mapLayers.findIndex(l => l.type === 'mp-callouts'), 1); renderLayers();
    }
    return;
  }
  if (!existing) {
    mapLayers.push(_mpNewEntry((typeof _newLayerId === 'function' ? _newLayerId() : Date.now()+4), 'mp-callouts', 'Выноски РТ', _mpCalloutLayerGroup));
  } else { existing.layer = _mpCalloutLayerGroup; }
  _mpReconcile('mp-callouts');
  renderLayers();
}

// ── Заполнение селектора СК ────────────────────────────────────────────────────
function _buildMpCrsSelect() {
  const sel = document.getElementById('mp-import-crs');
  if (!sel || typeof CRS_DB === 'undefined') return;
  if (sel.options.length > 1) return;
  let html = '<option value="">WGS-84 (координаты в градусах)</option>';
  let lastGroup = null;
  CRS_DB.forEach(c => {
    if (!c.p4) return;
    if (c.group !== lastGroup) {
      if (lastGroup !== null) html += '</optgroup>';
      html += `<optgroup label="${c.group || ''}">`;
      lastGroup = c.group;
    }
    html += `<option value="${c.id}">${c.name}</option>`;
  });
  if (lastGroup !== null) html += '</optgroup>';
  sel.innerHTML = html;
}

// ── Открыть/закрыть модал ─────────────────────────────────────────────────────
window.openMonPointsModal = () => {
  _initMonPoints();
  _buildMpCrsSelect();
  document.getElementById('mp-modal').style.display = 'flex';
  if (_mpEditId) { mpTab('add'); _mpPopulateForm(_mpEditId); }
  else           { mpTab('add'); _mpResetForm(); }
};

window.closeMonPointsModal = () => {
  document.getElementById('mp-modal').style.display = 'none';
  if (typeof _cancelMapPick === 'function') _cancelMapPick();
  _mpEditId = null;
};

// ── Вкладки ───────────────────────────────────────────────────────────────────
window.mpTab = (tab) => {
  ['add', 'list', 'import'].forEach(t => {
    const btn = document.getElementById(`mp-tab-${t}`);
    const panel = document.getElementById(`mp-panel-${t}`);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'list')   _mpRenderList();
  if (tab === 'import') _buildMpCrsSelect();
};

// ── Форма: показать/скрыть блок выноски ───────────────────────────────────────
window.mpToggleLabelControls = () => {
  const show = document.getElementById('mp-show-label').checked;
  document.getElementById('mp-label-controls').style.display = show ? 'flex' : 'none';
};

// ── Форма добавления/редактирования ───────────────────────────────────────────
function _mpResetForm() {
  document.getElementById('mp-name').value         = '';
  document.getElementById('mp-lat').value          = '';
  document.getElementById('mp-lon').value          = '';
  document.getElementById('mp-color').value        = MP_DEFAULT_COLOR;
  document.getElementById('mp-show-label').checked = false;
  document.getElementById('mp-label-controls').style.display = 'none';
  document.getElementById('mp-callout-color').value     = MP_DEFAULT_COLOR;
  document.getElementById('mp-callout-fontsize').value  = 12;
  document.getElementById('mp-callout-linewidth').value = 1.5;
  document.getElementById('mp-form-submit').innerHTML = '<svg class="icon icon-sm"><use href="#ico-plus"/></svg>Добавить';
  document.getElementById('mp-form-cancel').style.display = 'none';
  _mpEditId = null;
}

function _mpPopulateForm(id) {
  const pt = _monPoints.find(p => p.id === id);
  if (!pt) return;
  document.getElementById('mp-name').value         = pt.name  || '';
  document.getElementById('mp-lat').value          = pt.lat   || '';
  document.getElementById('mp-lon').value          = pt.lon   || '';
  document.getElementById('mp-color').value        = pt.color || MP_DEFAULT_COLOR;
  document.getElementById('mp-show-label').checked = !!pt.showLabel;
  document.getElementById('mp-label-controls').style.display = pt.showLabel ? 'flex' : 'none';
  document.getElementById('mp-callout-color').value     = pt.calloutColor     || MP_DEFAULT_COLOR;
  document.getElementById('mp-callout-fontsize').value  = pt.calloutFontSize  || 12;
  document.getElementById('mp-callout-linewidth').value = pt.calloutLineWidth || 1.5;
  document.getElementById('mp-form-submit').innerHTML = '<svg class="icon icon-sm"><use href="#ico-check"/></svg>Сохранить';
  document.getElementById('mp-form-cancel').style.display = 'flex';
}

window.mpSubmitForm = () => {
  const name       = document.getElementById('mp-name').value.trim();
  const lat        = parseFloat(document.getElementById('mp-lat').value);
  const lon        = parseFloat(document.getElementById('mp-lon').value);
  const color      = document.getElementById('mp-color').value;
  const showLabel  = document.getElementById('mp-show-label').checked;
  const cColor     = document.getElementById('mp-callout-color').value;
  const cFontSize  = parseInt(document.getElementById('mp-callout-fontsize').value) || 12;
  const cLineWidth = parseFloat(document.getElementById('mp-callout-linewidth').value) || 1.5;

  if (!name)                    { setSt('Введите название РТ', 'err'); return; }
  if (isNaN(lat) || isNaN(lon)) { setSt('Введите координаты', 'err'); return; }

  if (_mpEditId) {
    const pt = _monPoints.find(p => p.id === _mpEditId);
    if (pt) {
      _clearMonPointLayer(pt);
      // Подписи могли быть заменены номерами: на выноске тогда стоит номер,
      // а настоящее название лежит в calloutFullName — меняем именно его,
      // иначе правка имени молча выключала бы режим номеров
      const numbered = pt.calloutFullName != null;
      const keepNum  = pt.name;
      Object.assign(pt, { name, lat, lon, color, showLabel, calloutColor: cColor, calloutFontSize: cFontSize, calloutLineWidth: cLineWidth });
      if (numbered) { pt.calloutFullName = name; pt.name = keepNum; }
      // Строка в панели слоёв должна подхватить новое имя, а не держать старое.
      // Переписываем её сразу: сохранение идёт раньше пересинхронизации и
      // иначе запомнило бы старую подпись строки как «своё имя»
      delete pt.layerName;
      const row = _mpLayerOf(pt.id);
      if (row) row.name = _mpLabel(pt);
      _drawMonPoint(pt);
    }
    setSt(`РТ "${name}" обновлена`, 'ok');
    _mpEditId = null;
  } else {
    _mpCounter++;
    const pt = { id: 'mp_'+Date.now(), num: _mpCounter, name, lat, lon, color, showLabel,
      calloutColor: cColor, calloutFontSize: cFontSize, calloutLineWidth: cLineWidth };
    _monPoints.push(pt);
    _drawMonPoint(pt);
    setSt(`РТ-${pt.num} "${name}" добавлена`, 'ok');
  }
  _saveMonPoints();
  _syncMonPointsLayer();
  _syncMpCalloutLayer();
  // Выноска живёт ещё и на листе PDF — без этого там оставалось старое имя
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  _mpResetForm();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
};

window.mpCancelEdit = () => { _mpResetForm(); };

// ── Указать на карте ──────────────────────────────────────────────────────────
window.mpPickPoint = () => {
  if (typeof _startMapPick !== 'function') return;
  document.getElementById('mp-modal').style.display = 'none';
  _startMapPick(ll => {
    document.getElementById('mp-lat').value = ll.lat.toFixed(6);
    document.getElementById('mp-lon').value = ll.lng.toFixed(6);
    document.getElementById('mp-modal').style.display = 'flex';
  });
};

// ── Импорт CSV ────────────────────────────────────────────────────────────────
window.mpImportFile = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById('mp-csv-text').value = ev.target.result; };
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
};

window.mpImportText = () => {
  const text    = document.getElementById('mp-csv-text').value.trim();
  const crsId   = document.getElementById('mp-import-crs').value;
  const replace = document.getElementById('mp-import-replace').checked;
  if (!text) { setSt('Вставьте данные для импорта', 'err'); return; }

  const crs = (typeof CRS_DB !== 'undefined' && crsId) ? CRS_DB.find(c => c.id === crsId && c.p4) : null;
  // Пустые строки и комментарии (#) пропускаем. Заголовок («Имя;X;Y») отсеется
  // ниже сам: в его колонках координат не числа. Название точки может быть любым,
  // в т.ч. «РТ-1».
  const lines = text.split(/\r?\n/).filter(l => {
    const t = l.trim();
    return t && !t.startsWith('#');
  });

  // Число из ячейки: запятая — дробная часть, и вся ячейка должна быть числом
  // (иначе «X_start» или «55abc» приняли бы за координату).
  const num = s => { s = String(s).trim().replace(',', '.'); return /^[-+]?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN; };

  const added = [];
  lines.forEach(line => {
    // Определяем разделитель: если есть табы — используем только таб
    // (запятая в этом случае является разделителем дробной части)
    let parts;
    if (line.includes('\t')) {
      parts = line.split('\t').map(s => s.trim());
    } else if (line.includes(';')) {
      parts = line.split(';').map(s => s.trim());
    } else {
      parts = line.split(',').map(s => s.trim());
    }
    if (parts.length < 3) return;
    const name = parts[0];
    let v1 = num(parts[1]), v2 = num(parts[2]);
    if (isNaN(v1) || isNaN(v2)) return;
    let lat, lon;
    if (crs && typeof proj4 !== 'undefined') {
      try { const w = proj4(crs.p4, 'WGS84', [v1, v2]); lon = w[0]; lat = w[1]; } catch(e) { return; }
    } else { lat = v1; lon = v2; }
    if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    added.push({ name, lat, lon });
  });

  if (!added.length) { setSt('Нет корректных строк для импорта', 'err'); return; }
  if (replace) { _monPoints.forEach(p => _mpDropGrp(p)); _monPoints = []; _mpCounter = 0; }

  added.forEach(({ name, lat, lon }) => {
    _mpCounter++;
    const pt = { id: 'mp_'+Date.now()+'_'+_mpCounter, num: _mpCounter, name, lat, lon, color: MP_DEFAULT_COLOR };
    _monPoints.push(pt);
    _drawMonPoint(pt);
  });

  _saveMonPoints(); _syncMonPointsLayer(); _syncMpCalloutLayer();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
  setSt(`Импортировано ${added.length} РТ`, 'ok');
  document.getElementById('mp-csv-text').value = '';
  mpTab('list');
};

// ── Список ────────────────────────────────────────────────────────────────────

// ── Рабочие инструменты списка РТ ───────────────────────────────────────────
// Постановка точек кликами по карте: не нужно каждый раз открывать окно
// и вводить координаты руками.
let _mpClickMode = false;

window.mpAddByClick = () => {
  if (_mpClickMode) { mpStopAddByClick(); return; }
  _mpClickMode = true;
  closeMonPointsModal();
  const c = map.getContainer();
  c.classList.add('ms-passthrough');
  c.style.cursor = 'crosshair';
  map.on('click', _mpOnMapClick);
  setSt('Ставьте РТ кликами по карте. Esc или повторное нажатие кнопки — выход', 'ok');
};

window.mpStopAddByClick = () => {
  if (!_mpClickMode) return;
  _mpClickMode = false;
  const c = map.getContainer();
  c.classList.remove('ms-passthrough');
  c.style.cursor = '';
  map.off('click', _mpOnMapClick);
  setSt(`Добавление РТ завершено (всего ${_monPoints.length})`, 'ok');
};

window._mpIsAdding = () => _mpClickMode;

function _mpOnMapClick(e) {
  if (!_mpClickMode) return;
  _mpCounter++;
  const pt = {
    id: 'mp_' + Date.now(), num: _mpCounter,
    name: 'РТ-' + _mpCounter,
    lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6),
    color: MP_DEFAULT_COLOR, showLabel: false,
    calloutColor: MP_DEFAULT_COLOR, calloutFontSize: 12, calloutLineWidth: 1.5,
  };
  _monPoints.push(pt);
  _drawMonPoint(pt);
  _saveMonPoints(); _syncMonPointsLayer();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
  setSt(`РТ-${pt.num} поставлена (${pt.lat.toFixed(5)}, ${pt.lon.toFixed(5)}). Esc — выход`, 'ok');
}

// Перенумеровать РТ подряд, с обновлением имён вида «РТ-N»
window.mpRenumber = () => {
  if (!_monPoints.length) return;
  askConfirm('Перенумеровать расчётные точки',
    `Номера будут переставлены подряд: 1…${_monPoints.length}. Имена вида «РТ-N» обновятся, свои названия останутся.`,
    () => {
      _monPoints.forEach((p, i) => {
        const oldAuto = 'РТ-' + p.num;
        p.num = i + 1;
        if (!p.name || p.name === oldAuto) p.name = 'РТ-' + p.num;
      });
      _mpCounter = _monPoints.length;
      _monPoints.forEach(p => { _clearMonPointLayer(p); _drawMonPoint(p); });
      _saveMonPoints(); _syncMonPointsLayer(); _syncMpCalloutLayer(); _mpRenderList();
      if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
      setSt('РТ перенумерованы', 'ok');
    }, { ok: 'Перенумеровать', danger: false });
};

// Расстояние от точки до границы активного слоя (обычно СЗЗ), м
function _mpDistToActive(pt) {
  const al = (typeof getActiveLayer === 'function') ? getActiveLayer() : null;
  if (!al || !al.poly || al.poly.length < 2 || typeof geodDist !== 'function') return null;
  const P = L.latLng(pt.lat, pt.lon);
  let best = Infinity;
  for (let i = 0; i < al.poly.length; i++) {
    const a = al.poly[i], b = al.poly[(i + 1) % al.poly.length];
    // Проекция точки на отрезок в локальных метрах
    const A = L.latLng(a[0], a[1]), B = L.latLng(b[0], b[1]);
    const ab = geodDist(A, B);
    if (ab < 0.01) { best = Math.min(best, geodDist(P, A)); continue; }
    const t = Math.max(0, Math.min(1,
      ((P.lat - A.lat) * (B.lat - A.lat) + (P.lng - A.lng) * (B.lng - A.lng)) /
      (Math.pow(B.lat - A.lat, 2) + Math.pow(B.lng - A.lng, 2) || 1e-12)));
    const C = L.latLng(A.lat + (B.lat - A.lat) * t, A.lng + (B.lng - A.lng) * t);
    best = Math.min(best, geodDist(P, C));
  }
  return isFinite(best) ? best : null;
}

// Поиск в списке РТ
let _mpQuery = '';
window.mpSearch = (v) => { _mpQuery = (v || '').trim().toLowerCase(); _mpRenderList(); };

// ── Выделение РТ ────────────────────────────────────────────────────────────
// Клик — выбрать, Shift — диапазон, Ctrl — добавить. Выделение общее с панелью
// слоёв: каждая РТ — обычный слой, поэтому группировать их нужно теми же
// командами, что и всё остальное («В группу», «Вынести», «Разобрать»).
let _mpSel     = new Set();
let _mpLastId  = null;
let _mpViewIds = [];                    // порядок строк на экране — для Shift

function _mpEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _mpSelPoints() { return _monPoints.filter(p => _mpSel.has(p.id)); }

// Слой-строка данной РТ в панели
function _mpLayerOf(id) {
  return (typeof mapLayers !== 'undefined') ? mapLayers.find(l => l.mpId === id) : null;
}
function _mpSelLayerIds() {
  return _mpSelPoints().map(p => _mpLayerOf(p.id)).filter(Boolean).map(l => l.id);
}

// Выделение РТ отражаем в выделение слоёв: тогда штатные команды групп
// работают над теми же точками, что выбраны в окне РТ
function _mpPushSelToLayers() {
  if (typeof window.setLayerSelection !== 'function') return;
  window.setLayerSelection(_mpSelLayerIds());
}

// Собрать выделенные РТ в группу — той же командой, что и любые слои
window.mpGroupSelected = function() {
  const ids = _mpSelLayerIds();
  if (ids.length < 2) { setSt('Выделите хотя бы две РТ: клик, затем Shift+клик', 'err'); return; }
  _mpPushSelToLayers();
  if (typeof window.groupLayers === 'function') window.groupLayers(ids[0]);
  _mpRenderList();
};

// Вынести выделенные РТ из групп — тоже штатной командой
window.mpUngroupSelected = function() {
  const ids = _mpSelLayerIds();
  if (!ids.length) { setSt('Сначала выделите РТ в списке', 'err'); return; }
  _mpPushSelToLayers();
  if (typeof window.removeFromGroup === 'function') window.removeFromGroup(ids[0]);
  _mpRenderList();
};

// Перерисовать переданные точки на карте и обновить всё вокруг
function _mpRefresh(pts) {
  (pts || _monPoints).forEach(p => { _clearMonPointLayer(p); _drawMonPoint(p); });
  _saveMonPoints(); _syncMonPointsLayer(); _syncMpCalloutLayer(); _mpRenderList();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
}

// ids — порядок строк того списка, по которому щёлкнули. Списков два (окно РТ
// и панель редактора PDF), выделение у них общее, поэтому диапазон Shift
// считается по порядку именно того списка, где был клик.
window.mpSelClick = function(e, id, ids) {
  // Клик по кнопке внутри строки — это её действие, а не выделение
  if (e.target && e.target.closest && e.target.closest('button')) return;
  e.stopPropagation();
  const list = (ids && ids.length) ? ids : _mpViewIds;
  if (e.shiftKey && _mpLastId && list.includes(_mpLastId)) {
    const a = list.indexOf(_mpLastId), b = list.indexOf(id);
    if (a >= 0 && b >= 0) _mpSel = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (e.ctrlKey || e.metaKey) {
    if (_mpSel.has(id)) _mpSel.delete(id); else _mpSel.add(id);
    _mpLastId = id;
  } else {
    _mpSel = new Set([id]);
    _mpLastId = id;
  }
  _mpPushSelToLayers();
  _mpRenderList();
};

// Доступ к выделению для панели редактора PDF
window.mpSelHas  = (id) => _mpSel.has(id);
window.mpSelSize = () => _mpSel.size;

window.mpSelClear = () => { _mpSel.clear(); _mpPushSelToLayers(); _mpRenderList(); };

window.mpSelAll = () => {
  _mpSel = new Set(_mpViewIds);
  _mpLastId = _mpViewIds[_mpViewIds.length - 1] || null;
  _mpPushSelToLayers();
  _mpRenderList();
};

// Действия над выделением
window.mpSelAction = function(what) {
  const pts = _mpSelPoints();
  if (!pts.length) { setSt('Сначала выделите РТ в списке', 'err'); return; }
  if (what === 'callouts-on' || what === 'callouts-off') {
    const want = what === 'callouts-on';
    pts.forEach(p => { p.showLabel = want; });
    _mpRefresh(pts);
    setSt(`Выноски ${want ? 'включены' : 'скрыты'}: ${pts.length} РТ`, 'ok');
  } else if (what === 'hide' || what === 'show') {
    // Видимость — через строку слоя, как у всех остальных слоёв
    const hide = what === 'hide';
    pts.forEach(p => {
      const l = _mpLayerOf(p.id);
      if (l) { l.visible = !hide; if (typeof window._reconcileLayerVis === 'function') window._reconcileLayerVis(l); }
      p.hidden = hide;
    });
    _mpRefresh(pts);
    setSt(`РТ ${hide ? 'скрыты' : 'показаны'}: ${pts.length}`, 'ok');
  } else if (what === 'delete') {
    askConfirm('Удалить выделенные РТ?', `Будет удалено: ${pts.length}. Отменить это нельзя.`, () => {
      const ids = new Set(pts.map(p => p.id));
      pts.forEach(p => _mpDropGrp(p));
      _monPoints = _monPoints.filter(p => !ids.has(p.id));
      _mpSel.clear(); _mpLastId = null; _mpPushSelToLayers();
      _mpRefresh([]);
      setSt(`Удалено РТ: ${ids.size}`, 'ok');
    });
  }
};

// Цвет сразу всем выделенным
window.mpSelColor = function(color) {
  const pts = _mpSelPoints();
  if (!pts.length) return;
  pts.forEach(p => { p.color = color; });
  _mpRefresh(pts);
  setSt(`Цвет изменён у ${pts.length} РТ`, 'ok');
};

// Цвет точкам по id — для общих команд панели слоёв («Цвет выделенным…»)
window.mpSetColor = function(ids, color) {
  const pts = _monPoints.filter(p => ids.includes(p.id));
  if (!pts.length) return;
  pts.forEach(p => { p.color = color; });
  _mpRefresh(pts);
};

// Один стиль выносок выделенным РТ — тот же диалог, что у групп и слоёв
window.mpSelStyle = function() {
  const ids = _mpSelLayerIds();
  if (!ids.length) { setSt('Сначала выделите РТ в списке', 'err'); return; }
  if (typeof window.openCalloutStyleDialog === 'function')
    window.openCalloutStyleDialog(ids, `Стиль выносок: РТ (${ids.length})`);
};

window.mpExportCoords = function(id) {
  const p = _monPoints.find(x => x.id === id);
  if (!p || typeof showCoordsModal !== 'function') return;
  showCoordsModal('РТ-' + (p.num || '') + (p.name ? ' ' + p.name : ''), [[[p.lat, p.lon]]], p.name || ('РТ-' + p.num));
};

function _mpRenderList() {
  // В редакторе PDF тот же список РТ живёт в боковой панели — выделение
  // и группы у них общие, поэтому перерисовываем оба
  if (typeof _renderLayersList === 'function') {
    const ed = document.getElementById('pdf-editor');
    if (ed && ed.style.display !== 'none') { try { _renderLayersList(); } catch (e) {} }
  }
  const body = document.getElementById('mp-list-body');
  if (!body) return;
  const bar = document.getElementById('mp-sel-bar');
  if (!_monPoints.length) {
    body.innerHTML = '<div class="empty">Нет расчётных точек</div>';
    _mpViewIds = [];
    if (bar) bar.style.display = 'none';
    return;
  }
  const inp = document.getElementById('mp-search');
  if (inp && inp.value !== _mpQuery) inp.value = _mpQuery;
  const list = _monPoints.filter(p =>
    !_mpQuery || String(p.name || '').toLowerCase().includes(_mpQuery) || String('РТ-' + p.num).toLowerCase().includes(_mpQuery));
  if (!list.length) {
    body.innerHTML = '<div class="empty">Ничего не найдено</div>';
    _mpViewIds = [];
    if (bar) bar.style.display = 'none';
    return;
  }
  // Выделение живёт только среди видимых строк, иначе групповое действие
  // тихо задело бы отфильтрованные точки
  const visible = new Set(list.map(p => p.id));
  [..._mpSel].forEach(id => { if (!visible.has(id)) _mpSel.delete(id); });

  const al = (typeof getActiveLayer === 'function') ? getActiveLayer() : null;

  // Название группы РТ берём из панели слоёв — группы у них штатные
  const grpName = pt => {
    const l = _mpLayerOf(pt.id);
    if (!l || !l.groupId || typeof window.getLayerGroupName !== 'function') return '';
    return window.getLayerGroupName(l.groupId) || '';
  };

  const row = pt => {
    const dist = _mpDistToActive(pt);
    const distHtml = dist == null ? '' :
      `<span title="Расстояние до границы слоя «${al ? _mpEsc(al.name) : ''}»" style="color:var(--acc2);font-size:var(--fs-1);flex-shrink:0">${dist < 1000 ? dist.toFixed(0) + ' м' : (dist / 1000).toFixed(2) + ' км'}</span>`;
    const hasLabel = !!pt.showLabel;
    const lineOn   = hasLabel && pt.showLeaderLine !== false;
    const leaderBtn = hasLabel
      ? `<button class="btn" onclick="mpToggleLeader('${pt.id}')" title="${lineOn ? 'Скрыть линию выноски' : 'Показать линию выноски'}" style="padding:2px 6px;font-size:var(--fs-1);${lineOn ? '' : 'opacity:.45'}">${lineOn ? '⎸↔' : '⎸'}</button>`
      : '';
    const sel = _mpSel.has(pt.id);
    const g = grpName(pt);
    const gHtml = g
      ? `<span title="Группа слоёв" style="color:var(--tx2);font-size:var(--fs-1);flex-shrink:0;opacity:.8">⊞ ${_mpEsc(g)}</span>`
      : '';
    return `
    <div class="mp-row${sel ? ' sel' : ''}" onclick="mpSelClick(event,'${pt.id}')"
         style="display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid var(--bd);cursor:pointer;${sel ? 'background:rgba(59,130,246,.18);box-shadow:inset 2px 0 0 var(--acc2);' : ''}${pt.hidden ? 'opacity:.45;' : ''}"
         ondblclick="mpEditFromList('${pt.id}')" oncontextmenu="mpContextMenu(event,'${pt.id}');return false">
      <span style="width:10px;height:10px;border-radius:50%;background:${pt.color||MP_DEFAULT_COLOR};flex-shrink:0"></span>
      <b style="color:var(--acc2);flex-shrink:0">РТ-${pt.num}</b>
      <span style="flex:1;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_mpEsc(_mpNamePart(pt))}</span>
      ${gHtml}
      <span style="color:var(--tx2);font-size:var(--fs-1);flex-shrink:0">${Number(pt.lat).toFixed(5)}, ${Number(pt.lon).toFixed(5)}</span>
      ${distHtml}
      ${leaderBtn}
      <button class="btn" onclick="mpEditFromList('${pt.id}')" style="padding:2px 6px;font-size:var(--fs-1)">✏</button>
      <button class="btn warn" onclick="mpDeletePoint('${pt.id}')" style="padding:2px 6px;font-size:var(--fs-1)"><svg class="icon icon-sm"><use href="#ico-trash"/></svg></button>
    </div>`;
  };

  // Плоский список: группировку делают штатные команды панели слоёв, а здесь
  // у строки просто показано, в какой группе она состоит
  _mpViewIds = list.map(p => p.id);
  body.innerHTML = list.map(row).join('');

  // Панель действий над выделением — только когда что-то выделено
  if (bar) {
    const n = _mpSel.size;
    bar.style.display = n ? 'flex' : 'none';
    const cnt = document.getElementById('mp-sel-count');
    if (cnt) cnt.textContent = `Выделено: ${n}`;
  }
}

window.mpEditFromList = (id) => {
  _mpEditId = id;
  const modal = document.getElementById('mp-modal');
  if (modal.style.display !== 'flex') openMonPointsModal();
  mpTab('add');
  _mpPopulateForm(id);
};

window.mpDeletePoint = (id) => {
  const pt = _monPoints.find(p => p.id === id);
  if (!pt) return;
  // Удаление выделенной точки при активном выделении убирает всё выделение:
  // иначе кнопка «корзина» у строки молча игнорировала остальные выбранные
  if (_mpSel.size > 1 && _mpSel.has(id)) { window.mpSelAction('delete'); return; }
  _mpSel.delete(id);
  _mpDropGrp(pt);
  _monPoints = _monPoints.filter(p => p.id !== id);
  _saveMonPoints(); _syncMonPointsLayer(); _syncMpCalloutLayer(); _mpRenderList();
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
  setSt('РТ удалена', 'ok');
};

window.mpActivateMoveMode = (id) => {
  const pt = _monPoints.find(p => p.id === id);
  if (!pt) return;
  if (window._mpMoveHandle) { try { window._mpMoveHandle.remove(); } catch(e){} window._mpMoveHandle = null; }
  const color = pt.color || MP_DEFAULT_COLOR;
  const icon = L.divIcon({
    html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 3px ${color},0 3px 10px rgba(0,0,0,.6);cursor:grab;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:12px;user-select:none">${pt.num||'?'}</div>`,
    iconSize:[30,30], iconAnchor:[15,15], className:''
  });
  const marker = L.marker([pt.lat, pt.lon], { draggable: true, zIndexOffset: 2000, icon });
  marker.on('drag', e => {
    const ll = e.target.getLatLng();
    pt.lat = ll.lat; pt.lon = ll.lng;
    if (pt._circleLayer) pt._circleLayer.setLatLng(ll);
  });
  marker.on('dragend', e => {
    const ll = e.target.getLatLng();
    pt.lat = ll.lat; pt.lon = ll.lng;
    _clearMonPointLayer(pt); _drawMonPoint(pt);
    _saveMonPoints(); _mpRenderList();
    setSt(`РТ-${pt.num} «${pt.name}» перемещена`, 'ok');
    marker.remove(); window._mpMoveHandle = null;
  });
  marker.addTo(_mpGrp(pt));
  window._mpMoveHandle = marker;
  map.panTo([pt.lat, pt.lon]);
  setSt(`Перетащите маркер чтобы переместить РТ-${pt.num}`, 'info');
};

window.mpContextMenu = (e, id) => {
  e.preventDefault();
  e.stopPropagation();
  // ПКМ по невыделенной точке работает с ней одной; по выделенной — со всем
  // выделением, как в списках слоёв и источников
  if (!_mpSel.has(id)) { _mpSel = new Set([id]); _mpLastId = id; _mpRenderList(); }
  const nSel = _mpSel.size;
  document.getElementById('src-ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu';
  menu.className = 'src-ctx-menu';
  const _close = "document.getElementById('src-ctx-menu')?.remove()";
  const pt  = _monPoints.find(p => p.id === id);
  const multi = nSel > 1;
  // Всё, что раньше стояло кнопками над списком, живёт здесь: отдельной
  // панели кнопок больше нет, операции — только правой кнопкой
  menu.innerHTML = `
    ${multi ? `<div class="src-ctx-hdr">Выделено РТ: ${nSel}</div>
      <button onclick="mpGroupSelected();${_close}">⊞ Сгруппировать</button>` : ''}
    <button onclick="mpUngroupSelected();${_close}">Вынести из группы</button>
    <button onclick="mpSelAction('hide');${_close}">Скрыть ${multi ? 'выделенные' : 'точку'}</button>
    <button onclick="mpSelAction('show');${_close}">Показать ${multi ? 'выделенные' : 'точку'}</button>
    <button onclick="mpSelAction('callouts-on');${_close}">
      <svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-tag"/></svg>
      Включить выноски${multi ? ` (${nSel})` : ''}</button>
    <button onclick="mpSelAction('callouts-off');${_close}">Скрыть выноски${multi ? ` (${nSel})` : ''}</button>
    <button onclick="mpSelStyle();${_close}">Один стиль выносок…</button>
    <label class="mp-ctx-color" style="display:flex;align-items:center;gap:var(--sp-2);width:100%;min-height:var(--pop-item-h);box-sizing:border-box;padding:var(--sp-1) var(--sp-2);border-radius:var(--r-sm);color:var(--tx);font-size:var(--fs-1);cursor:pointer;position:relative">
      Цвет${multi ? ` выделенным (${nSel})` : '…'}
      <input type="color" value="${(pt && pt.color) || MP_DEFAULT_COLOR}"
             onchange="mpSelColor(this.value);${_close}"
             style="position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;border:none;padding:0">
    </label>
    <div class="src-ctx-sep"></div>
    <button onclick="mpSelAll();${_close}">Выделить все РТ</button>
    ${multi ? `<button onclick="mpSelClear();${_close}">Снять выделение</button>` : ''}
    <div class="src-ctx-sep"></div>
    <button onclick="mpEditFromList('${id}');${_close}">✎ Настройки</button>
    <button onclick="mpActivateMoveMode('${id}');${_close}">✥ Переместить</button>
    <button onclick="mpExportCoords('${id}');${_close}"><svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#ico-copy"/></svg>Экспорт координат</button>
    <div class="src-ctx-sep"></div>
    <button class="src-ctx-del" onclick="mpDeletePoint('${id}');${_close}">✕ Удалить${multi ? ` выделенные (${nSel})` : ''}</button>
  `;
  placeCtxMenu(menu, e);   // подрезка и раскрытие вверх — в utils.js
  const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
};

window.mpDeleteAll = () => {
  if (!_monPoints.length) return;
  askConfirm('Удалить все расчётные точки?', `Будет удалено: ${_monPoints.length}. Отменить это нельзя.`, () => {
    _monPoints.forEach(p => _mpDropGrp(p));
    _monPoints = [];
    _mpSel.clear(); _mpPushSelToLayers();
    _saveMonPoints(); _syncMonPointsLayer(); _syncMpCalloutLayer(); _mpRenderList();
    if (typeof _updateTopSelects === 'function') _updateTopSelects();
    setSt('Все РТ удалены', 'ok');
  });
};

// Включить выноски у всех РТ (парная к mpHideAllCallouts — единая логика с источниками)
window.mpShowAllCallouts = () => {
  if (!_monPoints.length) return;
  _monPoints.forEach(p => { _clearMpCallout(p); p.showLabel = true; _drawMpCallout(p); });
  _saveMonPoints(); _syncMpCalloutLayer(); _mpRenderList();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  setSt(`Выноски РТ показаны (${_monPoints.length})`, 'ok');
};

// Выключить все выноски РТ (удаление слоя «Выноски РТ» не должно удалять сами точки)
window.mpHideAllCallouts = () => {
  const list = _monPoints.filter(p => p.showLabel);
  if (!list.length) return;
  list.forEach(p => { _clearMpCallout(p); p.showLabel = false; });
  _saveMonPoints(); _syncMpCalloutLayer(); _mpRenderList();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  setSt(`Выноски РТ скрыты (${list.length})`, 'ok');
};

window.mpExportCsv = () => {
  if (!_monPoints.length) { setSt('Нет расчётных точек', 'err'); return; }
  const rows = ['﻿Название;Широта;Долгота'];
  _monPoints.forEach(p => rows.push(`${p.name};${p.lat};${p.lon}`));
  const csv = rows.join('\r\n');
  if (window.pywebview && window.pywebview.api && window.pywebview.api.save_file) {
    const bytes = new TextEncoder().encode(csv);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    window.pywebview.api.save_file('РТ.csv', btoa(bin)).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'РТ.csv';
  a.click();
};

window.mpToggleAllCallouts = () => {
  if (!_monPoints.length) { setSt('Нет расчётных точек', 'err'); return; }
  if (typeof window._primeMapScale === 'function') window._primeMapScale();
  const anyVisible = _monPoints.some(p => p.showLabel);
  _monPoints.forEach(p => {
    _clearMpCallout(p);
    p.showLabel = !anyVisible;
    if (p.showLabel) _drawMpCallout(p);
  });
  _saveMonPoints(); _syncMpCalloutLayer();
  setSt(anyVisible ? 'Выноски РТ скрыты' : 'Выноски РТ показаны', 'ok');
};

window.mpFitBounds = () => {
  if (!_monPoints.length) return;
  map.fitBounds(L.latLngBounds(_monPoints.map(p => [p.lat, p.lon])), { padding: [40, 40] });
};

// Выноска одной РТ — из контекстного меню её строки в панели слоёв
window.mpToggleOneCallout = (id) => {
  const pt = _monPoints.find(p => p.id === id);
  if (!pt) return;
  _clearMpCallout(pt);
  pt.showLabel = !pt.showLabel;
  if (pt.showLabel) _drawMpCallout(pt);
  _saveMonPoints(); _syncMpCalloutLayer(); _mpRenderList();
  if (typeof _refreshPdfMapLayers === 'function' && typeof pdfMap !== 'undefined' && pdfMap) _refreshPdfMapLayers();
  setSt(`Выноска РТ-${pt.num} ${pt.showLabel ? 'включена' : 'скрыта'}`, 'ok');
};

window.mpToggleLeader = (id) => {
  const pt = _monPoints.find(p => p.id === id);
  if (!pt || !pt.showLabel) return;
  pt.showLeaderLine = pt.showLeaderLine === false ? true : false;
  (pt._calloutLayers || []).forEach(l => { if (l._draw) l._draw(); });
  _saveMonPoints();
  _mpRenderList();
};

// Видимость у каждой РТ своя — она задаётся её строкой в панели слоёв.
// Общая функция: раньше растровый путь (ниже) и векторный (js/pdf-vector.js)
// держали каждый свою копию этой проверки, и они успели разойтись.
window._mpVisiblePublic = function(pt) {
  const l = (typeof mapLayers !== 'undefined') ? mapLayers.find(x => x.mpId === pt.id) : null;
  const base = l ? l.visible !== false : pt.hidden !== true;
  // Если открыт редактор листа — видимость РТ может быть переопределена для
  // ТЕКУЩЕГО листа (pdfSheets[i].layerVis), см. _pdfSheetVisiblePublic. Вне
  // редактора это переопределение не должно протекать на основную карту.
  const pdfEditorEl = document.getElementById('pdf-editor');
  if (pdfEditorEl && pdfEditorEl.style.display !== 'none' && typeof window._pdfSheetVisiblePublic === 'function') {
    return window._pdfSheetVisiblePublic(l || { mpId: pt.id, visible: base });
  }
  return base;
};

// ── Отрисовка расчётных точек на PDF-карте ───────────────────────────────────
window._addMonPointsToPdfMap = function(targetMap) {
  const layers = [];
  // Видимость берём через _layerTypeVisible: она учитывает и запомненные настройки,
  // если запись слоя в панели ещё/уже отсутствует (иначе РТ всплывали в PDF)
  const _vis = t => (typeof window._layerTypeVisible === 'function') ? window._layerTypeVisible(t) : true;
  if (!_monPoints.length) return layers;
  const _mpVisible = window._mpVisiblePublic;

  const showCallouts = _vis('mp-callouts');

  // SVG-рендерер: canvas-слой при экспорте растягивался как растр и мылился
  const cr = L.svg({ padding: 0.5 });
  _monPoints.forEach(pt => {
    if (!_mpVisible(pt)) return;           // скрытую РТ не печатаем
    // Стиль берём из самой точки: у каждой РТ своя строка в панели, поэтому
    // общего агрегированного слоя «monpoints» больше нет — искать его бессмысленно
    const pst = pt._psStyle || {};
    const color = pt.color || MP_DEFAULT_COLOR;
    const fill  = pt.color || MP_DEFAULT_COLOR;
    const circle = L.circleMarker([pt.lat, pt.lon], {
      radius: 7, color, fillColor: fill,
      fillOpacity: pst.fillOpacity ?? 0.85,
      opacity:     pst.opacity     ?? 1,
      weight:      pst.weight      ?? 2,
      renderer: cr,
    }).addTo(targetMap);
    layers.push(circle);

    // Выноска РТ на карте редактора — такая же перетаскиваемая, как у источников
    // (раньше drag был выключен, и подвинуть выноску РТ в PDF было нельзя)
    if (pt.showLabel && showCallouts && typeof _makeCalloutLayersGlobal === 'function') {
      pt._onSave = _saveMonPoints;
      layers.push(..._makeCalloutLayersGlobal(pt, targetMap, true));
    }
  });
  return layers;
};

// ── Экспорт / импорт данных (для вкладок проектов) ───────────────────────────
window._mpGetData = function() {
  _mpPullStateFromLayers();
  return _monPoints.map(_mpClean);
};
window._mpLoadData = function(data) {
  _monPoints.forEach(p => _mpDropGrp(p));
  // Выделение относится к прошлому проекту
  _mpSel.clear(); _mpLastId = null; _mpViewIds = [];
  // Строки прошлых точек в панели тоже убираем — новые создаст синхронизация
  if (typeof mapLayers !== 'undefined') {
    for (let i = mapLayers.length - 1; i >= 0; i--) if (mapLayers[i].mpId) mapLayers.splice(i, 1);
  }
  _monPoints = data || [];
  _mpCounter = _monPoints.reduce((m, p) => Math.max(m, p.num || 0), 0);
  _monPoints.forEach(p => _drawMonPoint(p));
  localStorage.setItem('szztool_monpoints', JSON.stringify(_monPoints.map(_mpClean)));
  _syncMonPointsLayer();
  _syncMpCalloutLayer();
  // Re-add layer groups to map (clearAll() removes them) — но только если слой
  // должен быть виден: скрытые РТ не должны появляться после загрузки проекта
  if (typeof map !== 'undefined') {
    const _vis = t => (typeof window._layerTypeVisible === 'function') ? window._layerTypeVisible(t) : true;
    if (_mpCalloutLayerGroup) {
      if (_vis('mp-callouts') && !map.hasLayer(_mpCalloutLayerGroup)) map.addLayer(_mpCalloutLayerGroup);
      if (!_vis('mp-callouts') && map.hasLayer(_mpCalloutLayerGroup)) map.removeLayer(_mpCalloutLayerGroup);
    }
  }
  if (typeof _updateTopSelects === 'function') _updateTopSelects();
};
