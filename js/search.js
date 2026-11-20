'use strict';

// Адрес прокси приходит из app-config.js (динамический порт); 8767 — запуск из исходников
const LOCAL_PROXY = (window.APP_CONFIG && window.APP_CONFIG.proxy) || 'http://127.0.0.1:8767';

// ─── Порог классификации «внутри» vs «пересечение» ────────────────────────
// Если доля площади участка внутри СЗЗ ≥ RATIO_INSIDE → считается «внутри»,
// иначе — «пересечение». Любое пересечение с СЗЗ (даже краем) учитывается.
const RATIO_INSIDE = 0.50;   // 50 % площади участка в СЗЗ → «внутри»

// Статусы участков, которые НЕ включаем в результат
// 4 = Архивный, 5 = Снятый с учёта
const SKIP_STATECD = new Set(['4', '5']);

const STATECD = {
  '1': 'Временный', '2': 'Учтённый', '3': 'Ранее учтённый',
  '4': 'Архивный',  '5': 'Снятый с учёта',
};
const RIFR = {
  '1': 'Государственная (федеральная)', '2': 'Государственная (субъекта РФ)',
  '3': 'Муниципальная', '4': 'Частная', '0': 'Неустановленная',
};

let _proxyMode = null;
let _searchAbort = null;
let _parcelsHidden = false;
// Имя слоя, по которому выполнен последний поиск — уходит в проект,
// чтобы после открытия заголовки списка результатов остались прежними
let _foundLayerName = '';

async function _detectProxy() {
  try {
    const r = await fetchSafe(`${LOCAL_PROXY}/ping`, 2000);
    if (!r.ok) return false;
    const d = await r.json();
    if (d && d.ok) { _proxyMode = 'local'; return true; }
  } catch(e) {}
  _proxyMode = null;
  return false;
}

async function checkProxy() {
  const dot   = document.getElementById('rb-proxy-dot');
  const label = document.getElementById('rb-proxy-label');
  const box   = document.getElementById('mb-proxy');
  // Индикатор переехал в строку вкладок и виден всегда, а места там мало:
  // короткое состояние в строке, полная фраза — в подсказке.
  const set = (cls, short, full) => {
    dot.className = 'proxy-dot' + (cls ? ' ' + cls : '');
    label.textContent = short;
    if (box) box.title = full;
  };
  set('', 'Проверяю…', 'Проверяю связь с Росреестром');
  const ok = await _detectProxy();
  if (ok) set('ok', 'Прокси готов', 'Прокси Росреестра работает — нажми, чтобы проверить ещё раз');
  else    set('err', 'Прокси не работает', 'Прокси не запущен — перезапустите приложение. Нажми, чтобы проверить ещё раз');
}

function cancelSearch() {
  if (_searchAbort) _searchAbort.abort();
}

// Явно задать видимость найденных ЗУ. Раньше было только переключение, и при
// возврате в проект состояние разъезжалось: участки на карте есть, а флаг и
// кнопка говорят «скрыто» (или наоборот).
window.setParcelsHidden = function(hidden) {
  _parcelsHidden = !!hidden;
  parcelMkrs.forEach(p => {
    if (!p.layer) return;
    if (_parcelsHidden) { if (map.hasLayer(p.layer)) map.removeLayer(p.layer); }
    else if (!map.hasLayer(p.layer)) p.layer.addTo(map);
  });
  _syncParcelsBtn();
};

window.areParcelsHidden = function() { return !!_parcelsHidden; };

function _syncParcelsBtn() {
  const btn = document.getElementById('rb-btn-toggle-zu');
  if (!btn) return;
  const useEl = btn.querySelector('use');
  const span  = btn.querySelector('span');
  if (useEl) useEl.setAttribute('href', _parcelsHidden ? '#ico-eye' : '#ico-eye-off');
  if (span)  span.textContent = _parcelsHidden ? 'Показать ЗУ' : 'Скрыть ЗУ';
  btn.classList.toggle('active', _parcelsHidden);
}

function toggleParcelsVisibility() {
  setParcelsHidden(!_parcelsHidden);
}

/**
 * Запрашивает НСПД по ФАКТИЧЕСКОМУ полигону СЗЗ.
 * szzPoly  — массив [lat, lon] вершин внешнего кольца СЗЗ.
 * holePoly — массив [lat, lon] вершин «дырки» (исходный ЗУ). Если передан,
 *            отправляем в НСПД GeoJSON Polygon с дыркой (кольцо без центра).
 */
async function _fetchContour(szzPoly, holePoly = null, geojsonGeom = null, signal = null) {
  if (!_proxyMode) {
    if (!await _detectProxy()) throw new Error('Прокси не запущен — запусти proxy.bat');
  }
  let sq;
  if (geojsonGeom && (geojsonGeom.type === 'Polygon' || geojsonGeom.type === 'MultiPolygon')) {
    // Используем полную геометрию (с дырками) — кольца уже в формате [lon, lat].
    // Для MultiPolygon берём часть с наибольшей настоящей площадью (не первую
    // по порядку — он в GeoJSON ничем не гарантирован) и её дырки, если есть.
    let mpPart = geojsonGeom.coordinates[0];
    if (geojsonGeom.type === 'MultiPolygon' && geojsonGeom.coordinates.length > 1) {
      let bestArea = -1;
      geojsonGeom.coordinates.forEach(part => {
        const ring = part && part[0];
        if (!ring || ring.length < 3) return;
        let area = 0;
        try { area = turf.area(turf.polygon([ring])); } catch (e) { area = 0; }
        if (area > bestArea) { bestArea = area; mpPart = part; }
      });
    }
    const geomToSend = geojsonGeom.type === 'MultiPolygon'
      ? { type: 'Polygon', coordinates: mpPart }
      : geojsonGeom;
    sq = JSON.stringify(geomToSend);
  } else {
    // Классический путь: внешнее кольцо + опциональная дырка
    const outer = szzPoly.map(p => [p[1], p[0]]);
    if (outer[0][0] !== outer[outer.length - 1][0] || outer[0][1] !== outer[outer.length - 1][1]) {
      outer.push([...outer[0]]);
    }
    const coords = [outer];
    if (holePoly && holePoly.length >= 3) {
      const hole = holePoly.map(p => [p[1], p[0]]);
      if (hole[0][0] !== hole[hole.length - 1][0] || hole[0][1] !== hole[hole.length - 1][1]) {
        hole.push([...hole[0]]);
      }
      coords.push(hole);
    }
    sq = JSON.stringify({ type: 'Polygon', coordinates: coords });
  }
  const params = new URLSearchParams({ sq });
  const r = await fetchSafe(`${LOCAL_PROXY}/pkk?${params}`, 90000, signal);
  if (!r.ok) { _proxyMode = null; throw new Error(`HTTP ${r.status}`); }
  const data = await r.json();
  return data.features || [];
}

// ── Область поиска: нарисовать прямо на карте ────────────────────────────────
// Рамкой (drag) или произвольным контуром (клики + двойной клик).
// Из нарисованного создаётся слой «Область поиска», он же становится активным,
// и по нему сразу запускается поиск ЗУ.
let _saMode = null;          // 'rect' | 'poly' | null
let _saRectStart = null;
let _saPreview = null;       // временный слой-превью
let _saPts = [];             // вершины контура

function _saBtns() {
  const r = document.getElementById('rb-btn-area-rect');
  const p = document.getElementById('rb-btn-area-poly');
  if (r) r.classList.toggle('active', _saMode === 'rect');
  if (p) p.classList.toggle('active', _saMode === 'poly');
}

function _saCleanup() {
  if (_saPreview) { try { map.removeLayer(_saPreview); } catch(e) {} _saPreview = null; }
  _saPts = []; _saRectStart = null;
  const c = map.getContainer();
  c.classList.remove('ms-passthrough');
  c.style.cursor = '';
  _saBtns();
}

// Идёт ли выделение области (map.js спрашивает, чтобы не мешать своим кликам)
window._saIsActive = function() { return !!_saMode; };

window.cancelSearchArea = function() {
  _saMode = null;
  _saCleanup();
  map.doubleClickZoom.enable();
  map.dragging.enable();
  setSt('Выделение области отменено');
};

window.startSearchArea = function(mode) {
  if (_saMode === mode) { cancelSearchArea(); return; }
  _saCleanup();
  _saMode = mode;
  if (typeof setTool === 'function') setTool(null, true);
  if (typeof _msMode !== 'undefined' && _msMode && typeof toggleMeasure === 'function') toggleMeasure(_msMode);
  // Пока рисуем область — полигоны и метки не должны перехватывать клики
  map.getContainer().classList.add('ms-passthrough');
  map.doubleClickZoom.disable();
  _saBtns();
  setSt(mode === 'rect'
    ? 'Область поиска: зажмите левую кнопку и растяните рамку (Esc — отмена)'
    : 'Область поиска: кликайте вершины, двойной клик — замкнуть и искать (Esc — отмена)', 'ok');
};

// Создать слой из нарисованной области и сразу искать
function _saFinish(latlngs) {
  _saMode = null;
  _saCleanup();
  map.doubleClickZoom.enable();
  map.dragging.enable();
  if (!latlngs || latlngs.length < 3) { setSt('Область слишком мала', 'err'); return; }
  const pts = latlngs.map(ll => [ll.lat, ll.lng]);
  const layer = L.polygon(latlngs, {
    color: '#0ea5e9', weight: 2, fillColor: '#0ea5e9', fillOpacity: 0.10, dashArray: '6,4',
  }).addTo(map);
  const n = mapLayers.filter(l => l.type === 'search-area').length + 1;
  addMapLayer('search-area', `Область поиска ${n}`, pts, layer);
  setSt('Область задана — ищу ЗУ…', 'spin');
  setTimeout(() => searchParcels(), 50);
}

// Рамка: тянем мышью по карте
function _initSearchAreaTools() {
  const wrapper = document.getElementById('map-wrapper');
  if (!wrapper || wrapper._saBound) return;
  wrapper._saBound = true;

  wrapper.addEventListener('mousedown', e => {
    if (_saMode !== 'rect') return;
    if (e.target.closest('.leaflet-control')) return;
    e.preventDefault();
    const r = map.getContainer().getBoundingClientRect();
    _saRectStart = map.containerPointToLatLng(L.point(e.clientX - r.left, e.clientY - r.top));
    map.dragging.disable();
  });

  document.addEventListener('mousemove', e => {
    if (_saMode !== 'rect' || !_saRectStart) return;
    const r = map.getContainer().getBoundingClientRect();
    const cur = map.containerPointToLatLng(L.point(e.clientX - r.left, e.clientY - r.top));
    const b = L.latLngBounds(_saRectStart, cur);
    if (_saPreview) _saPreview.setBounds(b);
    else _saPreview = L.rectangle(b, { color: '#0ea5e9', weight: 2, dashArray: '6,4',
      fillColor: '#0ea5e9', fillOpacity: 0.08, interactive: false }).addTo(map);
  });

  document.addEventListener('mouseup', e => {
    if (_saMode !== 'rect' || !_saRectStart) return;
    map.dragging.enable();
    const r = map.getContainer().getBoundingClientRect();
    const cur = map.containerPointToLatLng(L.point(e.clientX - r.left, e.clientY - r.top));
    const b = L.latLngBounds(_saRectStart, cur);
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const small = map.latLngToContainerPoint(sw).distanceTo(map.latLngToContainerPoint(ne)) < 15;
    if (small) { _saRectStart = null; setSt('Рамка слишком мала — попробуйте ещё раз', 'err'); return; }
    _saFinish([sw, L.latLng(sw.lat, ne.lng), ne, L.latLng(ne.lat, sw.lng)]);
  });

  // Контур: клики по карте
  map.on('click', e => {
    if (_saMode !== 'poly') return;
    _saPts.push(e.latlng);
    if (_saPreview) _saPreview.setLatLngs(_saPts);
    else _saPreview = L.polygon(_saPts, { color: '#0ea5e9', weight: 2, dashArray: '6,4',
      fillColor: '#0ea5e9', fillOpacity: 0.08, interactive: false }).addTo(map);
  });
  map.on('dblclick', () => {
    if (_saMode !== 'poly') return;
    if (_saPts.length < 3) { setSt('Нужно минимум 3 точки', 'err'); return; }
    _saFinish([..._saPts]);
  });
}


// ── Добавление участков по кадастровому номеру ──────────────────────────────
// Номера можно вставить списком или загрузить из Excel/CSV: для каждого
// запрашивается геометрия из НСПД и создаётся слой участка.
window.openCnImportModal = function() {
  document.getElementById('cn-modal').style.display = 'flex';
  document.getElementById('cn-input').focus();
  _cnSetStatus('');
};
window.closeCnImportModal = function() {
  document.getElementById('cn-modal').style.display = 'none';
};

function _cnSetStatus(html, type) {
  const el = document.getElementById('cn-status');
  if (el) { el.innerHTML = html; el.className = 'cn-status' + (type ? ' ' + type : ''); }
}

// Достаём кадастровые номера из любого текста: XX:XX:XXXXXXX:XX
// Номер целиком, а не его кусок: без границ регулярка откусывала от длинной
// строки цифр правдоподобный, но другой номер — например из «89:07:010101:123456789»
// получалось «89:07:010101:123456», и в проект добавлялся несуществующий участок.
// Теперь такая строка честно не распознаётся, вместо того чтобы стать чужим номером.
const _CN_RE = /(?<![\d:])\d{2}:\d{2}:\d{5,8}:\d{1,7}(?![\d:])/;

// Номер к сравнимому виду: НСПД пишет кварталы то с ведущими нулями, то без
function _cnKey(cn) {
  const p = String(cn || '').trim().split(/[:\s]+/);
  if (p.length < 4 || !p.slice(0, 4).every(x => /^\d+$/.test(x))) return String(cn || '').trim().toLowerCase();
  return p.slice(0, 4).map(x => String(parseInt(x, 10))).join(':');
}
function _cnParse(text) {
  const found = String(text || '').match(new RegExp(_CN_RE.source, 'g')) || [];
  return [...new Set(found)];
}

// Строка списка → { cn, label }: номер плюс необязательное название после
// разделителя (;  —  -  ,  таб). Повторные номера отбрасываем.
function _cnParseRows(text) {
  const rows = [], seen = new Set();
  String(text || '').split(/[\r\n]+/).forEach(line => {
    const m = line.match(_CN_RE);
    if (!m) return;
    const cn = m[0];
    if (seen.has(cn)) return;
    seen.add(cn);
    // Всё, что осталось от строки после номера и разделителей, — название
    const label = line.replace(_CN_RE, ' ').replace(/^[\s;:,\-–—|\t]+|[\s;:,\-–—|\t]+$/g, '').trim();
    rows.push({ cn, label });
  });
  return rows;
}

// Имя слоя по выбранному режиму
function _cnLayerName(cn, label, mode) {
  const n = (label || '').trim();
  if (mode === 'cn' || !n) return cn;
  if (mode === 'name')     return n;
  if (mode === 'cn-name')  return cn + ' — ' + n;
  return n;                                  // both: есть название — берём его
}

// Импорт из Excel/CSV — номера ищем по всем ячейкам
window.cnImportFile = function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  const isExcel = /\.(xlsx|xlsm|xls)$/i.test(file.name);
  reader.onload = ev => {
    let text = '';
    try {
      if (isExcel && typeof XLSX !== 'undefined') {
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
        wb.SheetNames.forEach(n => { text += XLSX.utils.sheet_to_csv(wb.Sheets[n]) + '\n'; });
      } else {
        text = typeof ev.target.result === 'string' ? ev.target.result : new TextDecoder().decode(ev.target.result);
      }
    } catch(err) { _cnSetStatus('Не удалось прочитать файл: ' + err.message, 'err'); return; }
    // Разбираем построчно: номер из своей ячейки, название — из соседних
    const lines = [], seen = new Set();
    String(text).split(/[\r\n]+/).forEach(line => {
      const cn = (line.match(_CN_RE) || [])[0];
      if (!cn || seen.has(cn)) return;
      seen.add(cn);
      const cells = line.split(/[;,\t]/).map(c => c.trim().replace(/^"|"$/g, ''));
      // Название — первая непустая ячейка, которая не номер и не число
      const label = cells.find(c => c && !_CN_RE.test(c) && !/^[\d\s.,]+$/.test(c)) || '';
      lines.push(label ? (cn + '; ' + label) : cn);
    });
    if (!lines.length) { _cnSetStatus('В файле не найдено кадастровых номеров', 'err'); return; }
    const ta = document.getElementById('cn-input');
    ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + lines.join('\n');
    const named = lines.filter(l => l.includes(';')).length;
    _cnSetStatus(`Из файла добавлено номеров: <b>${lines.length}</b>` +
                 (named ? `, из них с названием: ${named}` : ''), 'ok');
  };
  if (isExcel) reader.readAsArrayBuffer(file); else reader.readAsText(file, 'UTF-8');
  e.target.value = '';
};

// Внешнее кольцо самой крупной (по настоящей площади, не по числу точек)
// части геометрии. У раздельного участка (MultiPolygon) один кусок может
// иметь куда больше вершин, чем настоящая основная часть — сортировка по
// длине кольца раньше иногда выбирала маленький, но детальный контур, или
// кусок, который на самом деле за границей смежного участка.
function _largestRingByArea(geom) {
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates[0] || null;
  if (geom.type !== 'MultiPolygon') return null;
  let best = null, bestArea = -1;
  geom.coordinates.forEach(part => {
    const ring = part && part[0];
    if (!ring || ring.length < 3) return;
    let area = 0;
    try { area = turf.area(turf.polygon([ring])); } catch (e) { area = 0; }
    if (area > bestArea) { bestArea = area; best = ring; }
  });
  return best;
}

// Внешнее кольцо геометрии → [[lat, lon], ...]
function _cnOuterRing(geom) {
  const ring = _largestRingByArea(geom);
  if (!ring || ring.length < 3) return null;
  return ring.map(c => [c[1], c[0]]);
}

window.cnImportAdd = async function() {
  const rows = _cnParseRows(document.getElementById('cn-input').value);
  if (!rows.length) { _cnSetStatus('Введите кадастровые номера — по одному в строке', 'err'); return; }
  const btn  = document.getElementById('cn-add-btn');
  if (btn) btn.disabled = true;
  const mode     = (document.getElementById('cn-name-mode') || {}).value || 'both';
  const withCall = !!(document.getElementById('cn-callouts') || {}).checked;
  const toGroup  = !!(document.getElementById('cn-group')    || {}).checked;

  let added = 0; const notFound = [], failed = [], newIds = [];
  for (let i = 0; i < rows.length; i++) {
    const { cn, label } = rows[i];
    const name = _cnLayerName(cn, label, mode);
    _cnSetStatus(`Загружаю ${i + 1} из ${rows.length}: <b>${cn}</b>…`);
    // Дубликаты не добавляем повторно — сверяем и по имени, и по номеру
    if (mapLayers.some(l => l.name === name || (l.cnInfo && l.cnInfo.cn === cn))) {
      notFound.push(cn + ' (уже есть)'); continue;
    }
    try {
      const r = await fetchSafe(`${LOCAL_PROXY}/pkk/detail?cn=${encodeURIComponent(cn)}`, 20000);
      if (!r.ok) {
        if (r.status === 404) {
          // Прокси говорит, каким номером НСПД ответил вместо запрошенного —
          // так видно, что номер не существует, а не «что-то не загрузилось»
          let got = '';
          try { got = (await r.json()).got || ''; } catch (e) {}
          // got — ответ НСПД, внешние данные: экранируем перед показом в innerHTML
          notFound.push(got ? `${cn} (в НСПД — ${escapeHtml(got)})` : cn);
        } else failed.push(cn);
        continue;
      }
      const data = await r.json();
      // Вторая линия обороны на случай старого прокси: номер в ответе должен
      // совпадать с запрошенным, иначе это другой участок
      const gotCn = (data.attrs || {}).cn || '';
      if (gotCn && _cnKey(gotCn) !== _cnKey(cn)) {
        notFound.push(`${cn} (в НСПД — ${escapeHtml(gotCn)})`);
        continue;
      }
      const poly = _cnOuterRing(data.geometry);
      if (!poly) { notFound.push(cn); continue; }
      const layer = L.polygon(poly.map(p => L.latLng(p[0], p[1])), {
        color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.15, weight: 2,
      }).addTo(map);
      const l = addMapLayer('parcel', name, poly, layer);
      l.geojson = data.geometry;                       // с дырками — для поиска и СЗЗ
      const a = data.attrs || {};
      l.cnInfo = { cn, label, addr: a.address || '', area: a.area_value || '', cat: a.category_type_desc || '' };
      // Выноска с названием участка — если попросили при импорте
      if (withCall) l.callout = { on: true, name, custom: !!label };
      layer.bindTooltip(name + (name !== cn ? '\n' + cn : '') + (a.address ? '\n' + a.address : ''),
                        { sticky: true, className: 'parcel-tip' });
      newIds.push(l.id);
      added++;
    } catch(err) { failed.push(cn); }
  }

  if (added) {
    const fresh = mapLayers.filter(l => newIds.includes(l.id));
    // Собрать импортированные участки в одну группу — потом всей группе
    // разом можно назначить выноски или скрыть её одним кликом
    if (toGroup && fresh.length > 1 && typeof groupLayersByIds === 'function') {
      const d = new Date();
      groupLayersByIds(newIds, `Участки по КН ${d.toLocaleDateString('ru-RU')}`);
    }
    if (withCall && typeof refreshLayerCallouts === 'function') refreshLayerCallouts();
    try {
      let b = fresh[0].layer.getBounds();
      fresh.slice(1).forEach(l => b.extend(l.layer.getBounds()));
      map.fitBounds(b, { padding: [50, 50] });
    } catch(e) {}
    renderLayers();
  }
  const named = rows.filter(r => r.label).length;
  const parts = [`Добавлено участков: <b>${added}</b>` +
                 (added && named ? ` (с названиями: ${Math.min(named, added)})` : '')];
  if (notFound.length) parts.push(`не найдено: ${notFound.length} (${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''})`);
  if (failed.length)   parts.push(`ошибка загрузки: ${failed.length}`);
  _cnSetStatus(parts.join('<br>'), added ? 'ok' : 'err');
  if (btn) btn.disabled = false;
  if (added) { document.getElementById('cn-input').value = ''; setSt(`Добавлено участков по КН: ${added}`, 'ok'); }
};

async function searchParcels() {
  const al = getActiveLayer();
  if (!al || !al.poly || !al.poly.length) { setSt('Выбери слой с полигоном', 'err'); return; }

  _searchAbort = new AbortController();
  _parcelsHidden = false;

  const szzPoly = al.poly;
  const btn = document.getElementById('rb-btn-find');
  const btnCancel = document.getElementById('rb-btn-cancel');
  if (btn) { btn.disabled = true; btn.style.display = 'none'; }
  if (btnCancel) btnCancel.style.display = '';
  const btnToggle = document.getElementById('rb-btn-toggle-zu');
  if (btnToggle) { const s = btnToggle.querySelector('span'); if (s) s.textContent = 'Скрыть ЗУ'; }
  clearMarkers();
  foundParcels = [];
  clearParcelFilter();
  document.getElementById('res-filter-wrap').style.display = 'none';
  _resReset();
  document.getElementById('res-list').innerHTML = '';
  document.getElementById('btn-export').disabled = true;
  document.getElementById('btn-export-word').disabled = true;
  document.getElementById('btn-export-geojson').disabled = true;
  document.getElementById('res-cnt').textContent = '0';

  try {
  if (!_proxyMode) {
    const ok = await _detectProxy();
    if (!ok) {
      setSt('Сервер недоступен — попробуй позже', 'err');
      return;
    }
  }

  // Количество дырок в geojson — вычисляем до построения szzTurf
  const _nHoles = (al.geojson && al.geojson.type === 'Polygon') ? al.geojson.coordinates.length - 1 : 0;

  // Turf-полигон слоя для геометрических проверок.
  // Если слой имеет дырки (ПКМ-метод) и parentId — используем ТОЛЬКО внешнее кольцо:
  // booleanIntersects(donut, pt) возвращает false для участков на границе дырки,
  // они никогда не доходят до hole-check и ошибочно исключаются.
  // Дырки (исходный ЗУ и доп. вырезы) фильтруются отдельно через holeExcludeTurf.
  let szzTurf;
  try {
    if (al.geojson && (al.geojson.type === 'Polygon' || al.geojson.type === 'MultiPolygon')) {
      if (_nHoles > 0) {
        if (al.originalOuterPoly) {
          // ПКМ-пончик с originalOuterPoly: используем простой полигон (без дырок).
          // НСПД уже отфильтровал ЗУ-внутренние участки через запрос с дыркой.
          // Донат здесь не нужен и вреден: swap lat↔lon зеркалит ориентацию витка (CW↔CCW),
          // и turf.booleanIntersects(donut, pt) возвращал false для ~5 граничных участков.
          // Простой полигон из originalOuterPoly работает корректно (так же как szzPoly в else-ветке).
          const srcRing = al.originalOuterPoly.map(p => [p[1], p[0]]);
          if (srcRing[0][0] !== srcRing[srcRing.length-1][0] || srcRing[0][1] !== srcRing[srcRing.length-1][1]) {
            srcRing.push([...srcRing[0]]);
          }
          szzTurf = turf.polygon([srcRing]);
        } else {
          // Пончик без originalOuterPoly: строим донат из geojson.
          const srcRing = [...al.geojson.coordinates[0]];
          if (srcRing[0][0] !== srcRing[srcRing.length-1][0] || srcRing[0][1] !== srcRing[srcRing.length-1][1]) {
            srcRing.push([...srcRing[0]]);
          }
          const _donutRings = [srcRing];
          for (let _h = 1; _h < al.geojson.coordinates.length; _h++) {
            const _holeRing = [...al.geojson.coordinates[_h]];
            if (_holeRing[0][0] !== _holeRing[_holeRing.length-1][0] || _holeRing[0][1] !== _holeRing[_holeRing.length-1][1]) {
              _holeRing.push([..._holeRing[0]]);
            }
            _donutRings.push(_holeRing);
          }
          szzTurf = turf.polygon(_donutRings);
        }
      } else {
        szzTurf = { type: 'Feature', properties: {}, geometry: al.geojson };
      }
    } else {
      const ring = szzPoly.map(p => [p[1], p[0]]);
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push([...ring[0]]);
      szzTurf = turf.polygon([ring]);
    }
  } catch(e) {
    setSt('Ошибка геометрии СЗЗ', 'err'); return;
  }

  // Полигон исходного ЗУ для вырезания (если включено)
  let excludeTurf = null;
  let excludePoly = null;
  const exclChecked = (typeof isExclParcelActive === 'function') ? isExclParcelActive() : true;
  if (exclChecked && al.parentId) {
    const parentLayer = mapLayers.find(l => l.id === al.parentId);
    if (parentLayer) {
      try {
        excludePoly = parentLayer.poly;
        const exRing = parentLayer.poly.map(p => [p[1], p[0]]);
        if (exRing[0][0] !== exRing[exRing.length - 1][0]) exRing.push([...exRing[0]]);
        excludeTurf = turf.polygon([exRing]);
      } catch(e) {}
    }
  }

  // Для ПКМ-метода: если слой имеет дырки (al.geojson с holes) и parentId,
  // строим holeExcludeTurf из parentLayer.poly — это даёт те же результаты,
  // что кнопка «исключить исходный ЗУ» (оба метода используют одну геометрию).
  // Первая дырка geojson создана turf.difference → координаты слегка отличаются
  // от оригинального ЗУ → booleanContains даёт разные результаты. Используем
  // parentLayer.poly напрямую для проверки первой дырки, holePoly — для
  // дополнительных вырезов (дырки [2]+).
  // (_nHoles уже вычислен выше, перед построением szzTurf)
  let holeExcludeTurf = excludeTurf || null;
  if (_nHoles > 0 && !holeExcludeTurf && al.parentId) {
    const _phLayer = mapLayers.find(l => l.id === al.parentId);
    if (_phLayer) {
      try {
        const _phRing = _phLayer.poly.map(p => [p[1], p[0]]);
        if (_phRing[0][0] !== _phRing[_phRing.length-1][0]) _phRing.push([..._phRing[0]]);
        holeExcludeTurf = turf.polygon([_phRing]);
      } catch(e) {}
    }
  }

  // ── Строим «донат» если включено вырезание исходного ЗУ ─────────────────
  // Донат = внешнее кольцо СЗЗ МИНУС дырка исходного ЗУ.
  // Участки внутри дырки автоматически не пересекают донат → исключаются.
  // Это решает проблему: раньше поиск шёл по всему внешнему кольцу СЗЗ,
  // включая область исходного ЗУ, и все участки внутри него тоже попадали.
  let effectiveTurf = szzTurf;
  let donutOk = false;
  if (excludeTurf) {
    try {
      const donut = turf.difference(szzTurf, excludeTurf);
      if (donut) { effectiveTurf = donut; donutOk = true; }
    } catch(e) {
      // Если turf.difference не справился — работаем с внешним кольцом + ручной фильтр
    }
  }

  // Запрашиваем НСПД: если донат построен — шлём полигон с дыркой,
  // иначе шлём внешнее кольцо (НСПД вернёт больше кандидатов, JS отфильтрует)
  setSt('Запрашиваю НСПД… (может занять до минуты)', 'spin');
  setProgress('indeterminate');

  let all = [];
  try {
    // Формируем запрос к НСПД.
    // Для ПКМ-пончика с originalOuterPoly: используем классический путь (без fetchGeom)
    // с originalOuterPoly как внешним кольцом и дыркой ЗУ из geojson.
    // НСПД понимает Polygon с дыркой и сам отфильтрует участки внутри ЗУ —
    // именно так работает кнопка «вырезать исходный ЗУ» (там тоже holePoly передаётся).
    let fetchGeom = null;
    let _apiSzzPoly  = szzPoly;
    let _apiHolePoly = exclChecked && excludePoly ? excludePoly : null;
    if (_nHoles > 0 && al.originalOuterPoly && al.geojson?.coordinates?.[1]) {
      // ПКМ-пончик: отправляем originalOuterPoly (оригинальная СЗЗ) + дырку ЗУ.
      // fetchGeom = null → _fetchContour использует классический путь с кольцами.
      _apiSzzPoly  = al.originalOuterPoly;                               // [lat,lon]
      _apiHolePoly = al.geojson.coordinates[1].map(c => [c[1], c[0]]); // [lon,lat] → [lat,lon]
    } else if (al.geojson) {
      if (al.geojson.type === 'Polygon') {
        fetchGeom = { type: 'Polygon', coordinates: [al.geojson.coordinates[0]] };
      } else if (al.geojson.type === 'MultiPolygon') {
        fetchGeom = al.geojson;
      }
    }
    all = await _fetchContour(_apiSzzPoly, _apiHolePoly, fetchGeom, _searchAbort.signal);
  } catch(e) {
    if (_searchAbort?.signal?.aborted) { setSt('Поиск отменён', ''); }
    else { setSt(`Ошибка: ${e.message}`, 'err'); }
    setProgress(null); return;
  }

  if (_searchAbort.signal.aborted) { setSt('Поиск отменён', ''); return; }

  setSt(`Проверяю геометрию (${all.length} объектов)…`, 'spin');
  setProgress(60);
  await new Promise(r => setTimeout(r, 30));

  const inside = [], cross = [];
  let _dbgSkipStatus = 0, _dbgSkipGeom = 0, _dbgSkipOut = 0, _dbgSkipExcl = 0;

  for (const f of all) {
    const a  = f?.attrs || {};
    const cn = a.cn || a.id || '—';

    const statecd = String(a.statecd || '');
    if (SKIP_STATECD.has(statecd)) {
      console.log(`[drop:status${statecd}] ${cn}`);
      _dbgSkipStatus++; continue;
    }

    const g = f.geometry || {}, c = f.center || {};
    let cLat, cLon;
    if (c.x && c.y) { cLon = c.x; cLat = c.y; }
    else if (g.type === 'Point') { cLon = g.coordinates[0]; cLat = g.coordinates[1]; }
    else if (g.type === 'Polygon' && g.coordinates?.[0]) {
      const r = g.coordinates[0];
      cLon = r.reduce((s,p)=>s+p[0],0)/r.length;
      cLat = r.reduce((s,p)=>s+p[1],0)/r.length;
    } else if (g.type === 'MultiPolygon' && g.coordinates?.[0]?.[0]) {
      const r = g.coordinates[0][0];
      cLon = r.reduce((s,p)=>s+p[0],0)/r.length;
      cLat = r.reduce((s,p)=>s+p[1],0)/r.length;
    }
    if (cLat === undefined) {
      console.log(`[drop:no-geom] ${cn}`);
      _dbgSkipGeom++; continue;
    }

    const addr    = a.address || a.readable_address || '';
    const rawCat  = String(a.category_type || '');
    const cat     = CATEGORIES[rawCat] || '';
    const util    = a.util_by_doc || a.utilization || '';
    const area    = a.area_value ? `${a.area_value} ${a.area_unit || 'м²'}` : '';
    const zone    = a.fp || a.functional_zone || '';

    // ── Геометрическая классификация по «эффективному» полигону ─────────
    // effectiveTurf = донат (если построен) или внешнее кольцо (fallback).
    // Донат автоматически исключает всё, что лежит внутри дырки.
    let status = 'out';
    let _droppedByHole = false; // флаг: исключён из-за дырки — rescue не применять
    const _dbgHasGeojson = !!(al.geojson && (al.geojson.type === 'Polygon' || al.geojson.type === 'MultiPolygon'));
    const _dbgHoles = _dbgHasGeojson && al.geojson.type === 'Polygon' ? al.geojson.coordinates.length - 1 : 0;
    try {
      const hasGeom = g.type && g.type !== 'Point' && g.coordinates;
      if (hasGeom) {
        const pt = g.type === 'Polygon'
          ? turf.polygon(g.coordinates)
          : turf.multiPolygon(g.coordinates);

        // Пересечение с СЗЗ:
        // — обычный случай: ЗУ пересекает или лежит внутри СЗЗ
        // — крупный ЗУ: СЗЗ целиком лежит внутри ЗУ (booleanIntersects может пропустить)
        const intersects = turf.booleanIntersects(szzTurf, pt);
        const szzInsidePt = !intersects && turf.booleanContains(pt, szzTurf);
        console.log(`[dbg:turf] ${cn} intersects=${intersects} szzInsidePt=${szzInsidePt} geojson=${_dbgHasGeojson} holes=${_dbgHoles}`);
        if (intersects || szzInsidePt) {
          // Вычисляем реальную площадь пересечения ЗУ с донатом СЗЗ.
          // Если площадь < 1 кв.м — ЗУ только касается границы дырки (boundary
          // coincidence) или целиком в дырке → исключаем без лишних проверок.
          let overlapOk = true;
          if (_dbgHoles > 0) {
            try {
              let inAnyHole = false;
              // Первая дырка: используем parentLayer.poly (holeExcludeTurf) если доступен.
              // Это даёт те же результаты, что кнопка «исключить исходный ЗУ»,
              // потому что оба метода используют одну и ту же исходную геометрию ЗУ.
              if (holeExcludeTurf) {
                if (turf.booleanContains(holeExcludeTurf, pt)) inAnyHole = true;
              }
              // Дополнительные дырки (ПКМ-вырезы сверх исходного ЗУ): проверяем
              // через координаты дырки из GeoJSON (начиная с [2] если holeExcludeTurf есть,
              // или с [1] если нет).
              if (!inAnyHole) {
                const _hStart = holeExcludeTurf ? 2 : 1;
                for (let h = _hStart; h < al.geojson.coordinates.length; h++) {
                  const raw = al.geojson.coordinates[h];
                  const ccw = raw.slice().reverse();
                  if (ccw[0][0] !== ccw[ccw.length - 1][0] || ccw[0][1] !== ccw[ccw.length - 1][1]) {
                    ccw.push([...ccw[0]]);
                  }
                  const holePoly = turf.polygon([ccw]);
                  if (turf.booleanContains(holePoly, pt)) { inAnyHole = true; break; }
                }
              }
              if (inAnyHole) {
                overlapOk = false;
                // szzTurf — простой полигон (без дырок) для ПКМ-пончика:
                // pip rescue step 2 вернул бы ЗУ-внутренние участки (их вершины
                // внутри простого полигона). Блокируем rescue через _droppedByHole=true.
                // Граничные участки (частично в ЗУ) сюда не попадают —
                // для них booleanContains=false, inAnyHole остаётся false.
                _droppedByHole = true;
                console.log(`[drop:in-hole] ${cn}`);
                _dbgSkipExcl++;
              }
            } catch(e) {
              console.log(`[hole-check-err] ${cn} err=${e.message}`);
            }
          }
          if (overlapOk) {
            status = turf.booleanContains(szzTurf, pt) ? 'inside' : 'cross';
            // Если вырезание активно — исключаем только то, что ЦЕЛИКОМ в исходном ЗУ
            if (excludeTurf) {
              try {
                if (turf.booleanContains(excludeTurf, pt)) {
                  console.log(`[drop:excl] ${cn}`);
                  _dbgSkipExcl++;
                  status = 'out';
                }
              } catch {}
            }
          }
        }
      } else {
        // Только точечная геометрия: проверяем через szzTurf (учитывает дырки)
        try {
          const ptF = turf.point([cLon, cLat]);
          status = turf.booleanPointInPolygon(ptF, szzTurf) ? 'inside' : 'out';
        } catch {
          const inSzz  = pip(cLat, cLon, szzPoly);
          const inHole = excludePoly ? pip(cLat, cLon, excludePoly) : false;
          status = (inSzz && !inHole) ? 'inside' : 'out';
        }
      }
    } catch {
      // turf выбросил исключение (сложная геометрия) — резервные проверки
      // Используем szzTurf (с дырками) вместо szzPoly (только внешнее кольцо)
      try {
        const ptF = turf.point([cLon, cLat]);
        if (turf.booleanPointInPolygon(ptF, szzTurf)) {
          status = 'inside';
        } else {
          // Центроид ЗУ вне СЗЗ — возможно, СЗЗ лежит внутри крупного ЗУ.
          // Проверяем: первая точка СЗЗ попадает в ЗУ?
          try {
            const ring = g.type === 'Polygon'   ? g.coordinates[0]
                       : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
            if (ring && ring.length > 3) {
              const ringLatLon = ring.map(p => [p[1], p[0]]);
              const szzPt = szzPoly[0]; // [lat, lon]
              if (pip(szzPt[0], szzPt[1], ringLatLon)) { status = 'cross'; }
            }
          } catch {}
        }
      } catch {
        // Крайний fallback: pip без учёта дырок
        const inSzz  = pip(cLat, cLon, szzPoly);
        const inHole = excludePoly ? pip(cLat, cLon, excludePoly) : false;
        if (inSzz && !inHole) {
          status = 'inside';
        } else {
          try {
            const ring = g.type === 'Polygon'   ? g.coordinates[0]
                       : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
            if (ring && ring.length > 3) {
              const ringLatLon = ring.map(p => [p[1], p[0]]);
              const szzPt = szzPoly[0];
              if (pip(szzPt[0], szzPt[1], ringLatLon)) { status = 'cross'; }
            }
          } catch {}
        }
      }
    }

    // Финальный резерв: turf вернул false (без исключения).
    // Проверяем PIP вручную: все вершины СЗЗ против каждого кольца ЗУ
    // и сэмпл вершин ЗУ против СЗЗ. Ловит граничные пересечения MultiPolygon.
    // Не применяем если ЗУ уже исключён как лежащий в дырке.
    if (status === 'out' && !_droppedByHole) {
      try {
        const polys = g.type === 'Polygon'      ? [g.coordinates]
                    : g.type === 'MultiPolygon' ? g.coordinates : [];
        pipRescue: for (const polyRings of polys) {
          const outerRing = polyRings?.[0];
          if (!outerRing || outerRing.length < 4) continue;
          const ringLL = outerRing.map(p => [p[1], p[0]]); // [lon,lat]→[lat,lon]
          // 1. Все вершины СЗЗ → в кольце ЗУ?
          for (const sp of szzPoly) {
            if (pip(sp[0], sp[1], ringLL)) { status = 'cross'; break pipRescue; }
          }
          // 2. Сэмпл вершин ЗУ → в СЗЗ? (через szzTurf — учитывает дырки)
          const step = Math.max(1, Math.floor(outerRing.length / 12));
          for (let i = 0; i < outerRing.length; i += step) {
            const p = outerRing[i];
            try {
              if (turf.booleanPointInPolygon(turf.point(p), szzTurf)) { status = 'cross'; break pipRescue; }
            } catch {
              if (pip(p[1], p[0], szzPoly)) { status = 'cross'; break pipRescue; }
            }
          }
        }
        if (status === 'cross') console.log(`[rescue:pip] ${cn} geojson=${_dbgHasGeojson} holes=${_dbgHoles}`);
      } catch {}
    }

    if (status === 'out') {
      let _firstCoord = 'n/a';
      try {
        const _r0 = g.type === 'Polygon'      ? g.coordinates?.[0]?.[0]
                  : g.type === 'MultiPolygon' ? g.coordinates?.[0]?.[0]?.[0] : null;
        if (_r0) _firstCoord = _r0.map(v => +v.toFixed(1)).join(',');
      } catch {}
      console.log(`[drop:out] ${cn} center=(${cLat?.toFixed(2)},${cLon?.toFixed(2)}) geom=${g.type||'none'} first=[${_firstCoord}]`);
      _dbgSkipOut++;
    }

    const _sBulk = STATECD[String(a.statecd || '')] || '';
    const _oBulk = RIFR[String(a.rifr ?? a.ownershp ?? '')] || a.ownership_form || '';
    const _cBulk = a.cad_cost != null ? Number(a.cad_cost).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' руб.' : '';
    const _uBulk = a.kpzu    != null ? Number(a.kpzu).toLocaleString('ru-RU',    { maximumFractionDigits: 2 }) + ' руб./кв. м' : '';
    const _dBulk = a.date_create ? String(a.date_create).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$3.$2.$1') : '';
    const record = {
      cn, addr, cat, util, area, zone, lat: cLat, lon: cLon, inP: status === 'inside', geometry: g,
      kvartal: cn.split(':').slice(0, 3).join(':'),
      status: _sBulk, ownership: _oBulk, cad_cost: _cBulk, cad_unit: _uBulk, date_cn: _dBulk,
    };
    if (status === 'inside') inside.push(record);
    else if (status === 'cross') cross.push(record);
  }

  console.log(`[filter] всего=${all.length} → inside=${inside.length} cross=${cross.length} | drop: status=${_dbgSkipStatus} no-geom=${_dbgSkipGeom} excl=${_dbgSkipExcl} out=${_dbgSkipOut}`);

  setProgress(90);

  foundParcels = [...inside, ...cross];
  inside.forEach(addParcelLayer);
  cross.forEach(addParcelLayer);
  toggleFills();

  if (foundParcels.length) {
    setSt(`Загружаю детали (0 / ${foundParcels.length})…`, 'spin');
    setProgress(1);
    await _enrichParcels(foundParcels, _searchAbort.signal);
    setProgress(null);
  }
  // Сведения об участках дописаны в те же объекты — автосохранению нужно
  // знать, что найденные ЗУ поменялись (см. _asFoundKey в main.js)
  window._foundRev = (window._foundRev || 0) + 1;

  if (_searchAbort.signal.aborted) { setSt('Поиск отменён', ''); return; }

  applyExclState();

  _foundLayerName = al.name || '';
  renderResults(inside, cross, _foundLayerName);
  setProgress(null);
  document.getElementById('btn-export').disabled         = !foundParcels.length;
  document.getElementById('btn-export-word').disabled    = !foundParcels.length;
  document.getElementById('btn-export-geojson').disabled = !foundParcels.some(p => p.geometry && p.geometry.type !== 'Point');

  setSt(`✓ Внутри: ${inside.length} ЗУ | Пересечение: ${cross.length} ЗУ`, 'ok');
  } finally {
    if (btn) { btn.disabled = false; btn.style.display = ''; }
    if (btnCancel) btnCancel.style.display = 'none';
    setProgress(null);
    _searchAbort = null;
  }
}

// ── Список найденных ЗУ — порциями ─────────────────────────────────────────
// Тысячи карточек разом — это секунды на открытие вкладки и тяжёлая
// прокрутка. Рисуем первые RES_CHUNK, следующие — когда низ списка подходит
// к экрану (IntersectionObserver на «маячке» в конце). Скрытая панель
// маячка не видит — и дальше первой порции ничего не строится.
const RES_CHUNK = 150;
let _res = { inside: [], cross: [], lbl: '' };   // отсортированные списки
let _resRows = [];                                 // после фильтра: {hdr} | {p}
let _resShown = 0;
let _resObserver = null;

function _resAppend(upto) {
  const end = Math.min(_resRows.length, Math.max(upto || 0, _resShown + RES_CHUNK));
  if (end <= _resShown) return;
  let html = '';
  for (let i = _resShown; i < end; i++) html += _resRows[i].hdr || parcelCard(_resRows[i].p);
  const more = document.getElementById('res-more');
  if (more) more.insertAdjacentHTML('beforebegin', html);
  else document.getElementById('res-list').insertAdjacentHTML('beforeend', html);
  _resShown = end;
  if (_resShown >= _resRows.length && more) more.remove();
}

function _resRenderList() {
  const list = document.getElementById('res-list');
  _resShown = 0;
  if (_resObserver) _resObserver.disconnect();
  list.innerHTML = _resRows.length ? '<div id="res-more" style="height:1px"></div>' : '';
  _resAppend();
  const more = document.getElementById('res-more');
  if (!more) return;
  if (!('IntersectionObserver' in window)) { _resAppend(_resRows.length); return; }
  if (!_resObserver) {
    _resObserver = new IntersectionObserver(es => {
      if (!es.some(e => e.isIntersecting)) return;
      _resAppend();
      // Маячок мог остаться в зоне видимости (короткие карточки, высокая
      // панель) — повторное наблюдение заново сообщит его положение
      const m = document.getElementById('res-more');
      if (m) { _resObserver.unobserve(m); _resObserver.observe(m); }
    }, { rootMargin: '400px' });
  }
  _resObserver.observe(more);
}

// Карточка нужна в DOM (выбор участка на карте прокручивает к ней) —
// дорисовываем список до неё
window._ensureParcelCard = function(cn) {
  const i = _resRows.findIndex(r => r.p && r.p.cn === cn);
  if (i >= _resShown) _resAppend(i + 1);
};

window._resReset = function() {
  _res = { inside: [], cross: [], lbl: '' };
  _resRows = []; _resShown = 0;
  if (_resObserver) _resObserver.disconnect();
};

function renderResults(inside, cross, layerName) {
  const list = document.getElementById('res-list');
  document.getElementById('res-cnt').textContent = inside.length;

  _res = { inside: _sortParcels(inside), cross: _sortParcels(cross),
           lbl: layerName ? `«${escapeHtml(layerName)}»` : 'слоя' };
  // Сброс фильтра при новых результатах — он же и рисует список
  clearParcelFilter();
  const filterWrap = document.getElementById('res-filter-wrap');

  if (!inside.length && !cross.length) {
    list.innerHTML = '<div class="empty">ЗУ не найдено</div>';
    if (filterWrap) filterWrap.style.display = 'none';
    return;
  }
  if (filterWrap) filterWrap.style.display = '';
  const bIn = document.querySelector('#res-status-filter button[data-v="in"] b');
  const bCr = document.querySelector('#res-status-filter button[data-v="cross"] b');
  const bAl = document.querySelector('#res-status-filter button[data-v="all"] b');
  if (bIn) bIn.textContent = inside.length;
  if (bCr) bCr.textContent = cross.length;
  if (bAl) bAl.textContent = inside.length + cross.length;
}

async function _enrichParcels(parcels, signal = null) {
  const CONCURRENCY = 5;
  let done = 0;
  const total = parcels.length;

  async function fetchDetail(p) {
    try {
      const r = await fetchSafe(`${LOCAL_PROXY}/pkk/detail?cn=${encodeURIComponent(p.cn)}`, 15000, signal);
      if (!r.ok) { console.warn('[detail] HTTP', r.status, p.cn); return; }
      const data = await r.json();
      const a = data.attrs || {};
      const vri = data.vri_list || [];
      if (vri.length)         p.util = vri.join('; ');
      else if (a.util_by_doc) p.util = a.util_by_doc;
      if (data.zone)                  p.zone = data.zone;
      if (!p.cat) {
        const rawCat = String(a.category_type || '');
        p.cat = CATEGORIES[rawCat] || a.category_type_desc || rawCat || '';
      }
      if (!p.area && a.area_value) p.area = `${a.area_value} ${a.area_unit || 'кв. м'}`;
      p.status    = STATECD[String(a.statecd ?? '')] || p.status || '';
      p.ownership = RIFR[String(a.rifr ?? a.ownershp ?? '')] || a.ownership_form || p.ownership || '';
      const cadCostRaw = a.cad_cost ?? a.cadCost ?? a.cad_cost_value;
      if (cadCostRaw) p.cad_cost = Number(cadCostRaw).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' руб.';
      const cadUnitRaw = a.kpzu ?? a.kv ?? a.specific_cost ?? a.cad_cost_kv;
      if (cadUnitRaw) p.cad_unit = Number(cadUnitRaw).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' руб./кв. м';
      const dateRaw = a.date_create ?? a.date_reg ?? a.reg_date;
      if (dateRaw) p.date_cn = String(dateRaw).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$3.$2.$1');
      console.log('[detail]', p.cn, { statecd: a.statecd, rifr: a.rifr, cad_cost: a.cad_cost, kpzu: a.kpzu, date_create: a.date_create, category_type: a.category_type });

      // Функциональная зона (Генплан, НСПД слой 37294)
      if (!p.zone && p.lat && p.lon) {
        try {
          const zr = await fetchSafe(
            `${LOCAL_PROXY}/nspd-click?lid=37294&lat=${p.lat}&lon=${p.lon}`,
            8000, signal
          );
          if (zr && zr.ok) {
            const zd = await zr.json();
            if (zd.found) {
              const name = zd.attrs?.name_zone || zd.name || '';
              if (name) p.zone = name;
            }
          }
        } catch (ze) { /* зона не найдена — ок */ }
      }

      // Обновляем геометрию если detail вернул полную (больше координат)
      const dg = data.geometry;
      if (dg?.type && dg.type !== 'Point' && dg.coordinates) {
        const curLen = JSON.stringify(p.geometry || {}).length;
        const newLen = JSON.stringify(dg).length;
        if (newLen > curLen) {
          p.geometry = dg;
          if (data.center?.x && data.center?.y) { p.lon = data.center.x; p.lat = data.center.y; }
          // Перерисовываем слой на карте
          const idx = parcelMkrs.findIndex(m => m.cn === p.cn);
          if (idx !== -1) {
            if (map.hasLayer(parcelMkrs[idx].layer)) map.removeLayer(parcelMkrs[idx].layer);
            parcelMkrs.splice(idx, 1);
            addParcelLayer(p);
          }
        }
      }
    } catch(e) {
      console.warn('[detail] error', p.cn, e?.message);
    } finally {
      done++;
      setProgress(Math.round(done / total * 100));
      setSt(`Детали: ${done}/${total}`, 'spin');
    }
  }

  for (let i = 0; i < parcels.length; i += CONCURRENCY) {
    if (signal?.aborted) break;
    const chunk = parcels.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(fetchDetail));
    if (i + CONCURRENCY < parcels.length) await new Promise(r => setTimeout(r, 200));
  }
}


// ── Сортировка списка найденных ЗУ ──────────────────────────────────────────
let _parcelSort = 'default';   // default | cn | area | dist
window.setParcelSort = function(v) {
  _parcelSort = v;
  const inside = foundParcels.filter(p => p.inP);
  const cross  = foundParcels.filter(p => !p.inP);
  renderResults(inside, cross, _foundLayerName);
};

// Площадь участка в числах: в данных она строкой вида «12 400 кв. м»
function _parcelArea(p) {
  const n = parseFloat(String(p.area || '').replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : -1;
}

// Расстояние от участка до границы активного слоя, м
function _parcelDist(p) {
  const al = (typeof getActiveLayer === 'function') ? getActiveLayer() : null;
  if (!al || !al.poly || al.poly.length < 2 || typeof geodDist !== 'function' || p.lat == null) return Infinity;
  const P = L.latLng(p.lat, p.lon);
  let best = Infinity;
  for (let i = 0; i < al.poly.length; i++) {
    const a = al.poly[i], b = al.poly[(i + 1) % al.poly.length];
    const A = L.latLng(a[0], a[1]), B = L.latLng(b[0], b[1]);
    const t = Math.max(0, Math.min(1,
      ((P.lat - A.lat) * (B.lat - A.lat) + (P.lng - A.lng) * (B.lng - A.lng)) /
      (Math.pow(B.lat - A.lat, 2) + Math.pow(B.lng - A.lng, 2) || 1e-12)));
    const C = L.latLng(A.lat + (B.lat - A.lat) * t, A.lng + (B.lng - A.lng) * t);
    best = Math.min(best, geodDist(P, C));
  }
  return best;
}

function _sortParcels(list) {
  const arr = [...list];
  if (_parcelSort === 'cn')   arr.sort((a, b) => String(a.cn).localeCompare(String(b.cn), 'ru', { numeric: true }));
  if (_parcelSort === 'area') arr.sort((a, b) => _parcelArea(b) - _parcelArea(a));
  if (_parcelSort === 'dist') arr.sort((a, b) => _parcelDist(a) - _parcelDist(b));
  return arr;
}

// ── Добавить найденный участок отдельным слоем ──────────────────────────────
window.parcelToLayer = function(cn) {
  const p = foundParcels.find(x => x.cn === cn);
  if (!p) return;
  if (mapLayers.some(l => l.name === cn)) { setSt(`Слой «${cn}» уже есть`, 'err'); return; }
  let poly = null;
  const g = p.geometry;
  if (g && g.type === 'Polygon') poly = g.coordinates[0].map(c => [c[1], c[0]]);
  else if (g && g.type === 'MultiPolygon') {
    const ring = _largestRingByArea(g);
    poly = ring ? ring.map(c => [c[1], c[0]]) : null;
  }
  if (!poly || poly.length < 3) { setSt('У участка нет контура — слой не создать', 'err'); return; }
  const layer = L.polygon(poly.map(q => L.latLng(q[0], q[1])), {
    color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.15, weight: 2,
  }).addTo(map);
  const l = addMapLayer('parcel', cn, poly, layer);
  l.geojson = g;
  layer.bindTooltip(cn + (p.addr ? '\n' + p.addr : ''), { sticky: true, className: 'parcel-tip' });
  setSt(`Участок ${cn} добавлен слоем`, 'ok');
};

function parcelCard(r) {
  const safeCn = r.cn.replace(/\W/g,'_');
  // Карточка может дорисоваться позже, чем участок выбрали на карте, —
  // отметку выделения ставим сразу при сборке
  const sel = (typeof selectedParcelCn !== 'undefined' && selectedParcelCn === r.cn) ? ' selected' : '';
  const multi = (typeof selectedParcelCns !== 'undefined' && selectedParcelCns.has(r.cn)) ? ' multi-selected' : '';
  // cn/addr/area/zone приходят из внешнего НСПД-ответа — экранируем перед innerHTML
  return `<div class="pcard${sel}${multi}" id="card-${safeCn}" onclick="selectParcel('${r.cn}')">
    <div class="pcn">${escapeHtml(r.cn)}</div>
    <div class="paddr">${escapeHtml(r.addr) || 'адрес не указан'}</div>
    <div class="ptags">
      <span class="tag ${r.inP?'tin':'tcrs'}">${r.inP?'✓ внутри':'⚠ пересечение'}</span>
      ${r.area?`<span class="tag tmuted">${escapeHtml(r.area)}</span>`:''}
      ${r.zone?`<span class="tag tmuted" title="Функциональная зона">${escapeHtml(r.zone)}</span>`:''}
    </div>
    <div class="pcard-actions">
      <button class="pcard-goto" onclick="event.stopPropagation();selectParcel('${r.cn}')" title="Показать на карте">
        <svg class="icon icon-sm"><use href="#ico-target"/></svg>на карте
      </button>
      <button class="pcard-goto" onclick="event.stopPropagation();parcelToLayer('${r.cn}')" title="Добавить участок отдельным слоем">
        <svg class="icon icon-sm"><use href="#ico-plus"/></svg>в слои
      </button>
    </div>
  </div>`;
}

// ── Фильтр найденных ЗУ ────────────────────────────────────────────────────
let _filterText = '';

function filterParcels(val) {
  _filterText = val.trim().toLowerCase();
  const clearBtn = document.getElementById('res-filter-clear');
  if (clearBtn) clearBtn.style.display = _filterText ? '' : 'none';
  _applyFilter();
}

function clearParcelFilter() {
  const inp = document.getElementById('res-filter-input');
  if (inp) inp.value = '';
  filterParcels('');
}

// Фильтр по статусу участка: все / только внутри / только пересечение
let _filterStatus = 'all';
window.setParcelStatusFilter = function(v) {
  _filterStatus = v;
  document.querySelectorAll('#res-status-filter button').forEach(b =>
    b.classList.toggle('active', b.dataset.v === v));
  _applyFilter();
};

// Показать все найденные участки на карте
window.fitParcelsBounds = function() {
  const withGeom = parcelMkrs.filter(p => p.layer && p.layer.getBounds);
  if (!withGeom.length) { setSt('Нет участков для показа', 'err'); return; }
  try {
    let b = withGeom[0].layer.getBounds();
    withGeom.slice(1).forEach(p => { try { b.extend(p.layer.getBounds()); } catch(e) {} });
    map.fitBounds(b, { padding: [50, 50] });
  } catch(e) {}
};

// Фильтр — по данным, а не по нарисованным карточкам: их в DOM только часть
function _resMatch(p) {
  if (_filterStatus === 'in'    && !p.inP) return false;
  if (_filterStatus === 'cross' &&  p.inP) return false;
  if (!_filterText) return true;
  return String(p.cn || '').toLowerCase().includes(_filterText) ||
         String(p.addr || '').toLowerCase().includes(_filterText);
}

function _applyFilter() {
  const ins = _res.inside.filter(_resMatch), crs = _res.cross.filter(_resMatch);
  _resRows = [];
  // Заголовок секции — только если под ним что-то осталось; число в нём — всего
  if (ins.length) {
    _resRows.push({ hdr: `<div class="res-section-hdr inside">✓ Внутри ${_res.lbl} — ${_res.inside.length} уч.</div>` });
    ins.forEach(p => _resRows.push({ p }));
  }
  if (crs.length) {
    _resRows.push({ hdr: `<div class="res-section-hdr cross">⚠ Пересечение — ${_res.cross.length} уч.</div>` });
    crs.forEach(p => _resRows.push({ p }));
  }
  _resRenderList();
  const visible = ins.length + crs.length;
  const cntEl = document.getElementById('res-filter-cnt');
  if (cntEl) {
    cntEl.textContent = (_filterText || _filterStatus !== 'all')
      ? `Показано: ${visible} из ${foundParcels.length}`
      : '';
  }
}
