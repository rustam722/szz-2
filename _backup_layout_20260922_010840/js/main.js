'use strict';

function toggleSection(hdrEl) {
  const section = hdrEl.closest('.section') || hdrEl.parentElement;
  const body = section.querySelector('.section-body');
  const arrow = hdrEl.querySelector('.section-arrow');
  if (!body) return;
  const isVisible = body.style.display !== 'none';
  body.style.display = isVisible ? 'none' : '';
  if (arrow) arrow.textContent = isVisible ? '▸' : '▾';
  // Раздел «Слои» тянется на всю панель. Свёрнутым тянуться нечему —
  // иначе от него остаётся заголовок и полпанели пустоты под ним.
  section.classList.toggle('collapsed', isVisible);
}

// ── Project tabs ──────────────────────────────────────────────────────────────
let _ptabs = [], _ptabCurrent = null;

window._ptabNew = function() {
  // Save current tab state before leaving
  const cur = _ptabs.find(t => t.id === _ptabCurrent);
  if (cur && typeof _captureAppState === 'function') cur.state = _captureAppState();

  const tid = 'ptab_' + Date.now();
  _ptabs.push({ id: tid, projectId: null, name: 'Новый проект', state: null, path: null });
  _ptabCurrent = tid;

  if (typeof _restoreAppState === 'function') _restoreAppState(null);
  if (typeof _setProjectPath === 'function') _setProjectPath(null);
  document.getElementById('tb-project-name').textContent = 'Новый проект';
  _ptabRender();
};

window._ptabSwitchTo = function(tid) {
  if (_ptabCurrent === tid) return;
  // Save current tab state
  const cur = _ptabs.find(t => t.id === _ptabCurrent);
  if (cur && typeof _captureAppState === 'function') cur.state = _captureAppState();

  const tab = _ptabs.find(t => t.id === tid);
  if (!tab) return;
  _ptabCurrent = tid;
  if (typeof _restoreAppState === 'function') _restoreAppState(tab.state || null);
  if (typeof _setProjectPath === 'function') _setProjectPath(tab.path || null);
  document.getElementById('tb-project-name').textContent = tab.name;
  _ptabRender();
};

window._ptabClose = function(tid, e) {
  e.stopPropagation();
  const t = _ptabs.find(x => x.id === tid);

  // Capture current state if we're closing the active tab
  if (t && _ptabCurrent === tid && typeof _captureAppState === 'function') {
    t.state = _captureAppState();
  }
  // Warn if there's unsaved data (never saved to file)
  const st = t ? t.state : null;
  const hasData = st && ((st.layers || []).length || (st.sources || []).length || (st.monPoints || []).length);
  if (t && !t.projectId && hasData) {
    if (!confirm(`Проект «${t.name}» не сохранён.\nЗакрыть без сохранения?`)) return;
  }

  const wasCurrent = _ptabCurrent === tid;
  _ptabs = _ptabs.filter(x => x.id !== tid);

  if (!_ptabs.length) {
    const newTid = 'ptab_' + Date.now();
    _ptabs.push({ id: newTid, projectId: null, name: 'Новый проект', state: null });
    _ptabCurrent = newTid;
    if (typeof _restoreAppState === 'function') _restoreAppState(null);
    document.getElementById('tb-project-name').textContent = 'Новый проект';
  } else if (wasCurrent) {
    _ptabCurrent = _ptabs[_ptabs.length - 1].id;
    const t = _ptabs.find(x => x.id === _ptabCurrent);
    if (typeof _restoreAppState === 'function') _restoreAppState(t ? t.state : null);
    document.getElementById('tb-project-name').textContent = t ? t.name : 'Новый проект';
  }
  _ptabRender();
};

window._ptabUpdateCurrentName = function(name, projectId) {
  const t = _ptabs.find(x => x.id === _ptabCurrent);
  if (!t) return;
  t.name = name || 'Новый проект';
  if (projectId !== undefined) t.projectId = projectId || null;
  _ptabRender();
};

// Путь файла проекта хранится вместе с вкладкой: «Сохранить» пишет в него молча
window._ptabUpdateCurrentPath = function(path) {
  const t = _ptabs.find(x => x.id === _ptabCurrent);
  if (t) t.path = path || null;
};

window._ptabStartRename = function(tid) {
  const t = _ptabs.find(x => x.id === tid);
  if (!t) return;
  const track = document.getElementById('ptabs-track');
  if (!track) return;
  const tabEl = track.querySelector(`[data-tid="${tid}"]`);
  if (!tabEl) return;
  const nameEl = tabEl.querySelector('.ptabs-name');
  if (!nameEl) return;
  const inp = document.createElement('input');
  inp.className = 'ptabs-rename-input';
  inp.value = t.name;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = () => {
    const v = inp.value.trim() || t.name;
    t.name = v;
    if (tid === _ptabCurrent) document.getElementById('tb-project-name').textContent = v;
    _ptabRender();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
    if (ev.key === 'Escape') { inp.value = t.name; inp.blur(); }
  });
};

function _ptabRender() {
  const track = document.getElementById('ptabs-track');
  if (!track) return;
  track.innerHTML = _ptabs.map(t =>
    `<div class="ptabs-tab${t.id === _ptabCurrent ? ' active' : ''}" data-tid="${t.id}" onclick="_ptabSwitchTo('${t.id}')">` +
    `<span class="ptabs-name" ondblclick="_ptabStartRename('${t.id}');event.stopPropagation()">${t.name}</span>` +
    `<button class="ptabs-x" onclick="_ptabClose('${t.id}',event)">×</button></div>`
  ).join('');
}

// ── Добавить dropdown (from menubar) ─────────────────────────────────────────
window._mbAddToggle = function(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('rb-add-panel');
  const btn   = document.getElementById('mb-add-tab');
  if (!panel || !btn) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  placeUnder(panel, btn);   // у нижнего края экрана раскроется вверх
};
window._rbAddClose = function() {
  const p = document.getElementById('rb-add-panel');
  if (p) p.style.display = 'none';
};
// backward-compat alias
window._rbAddToggle = window._mbAddToggle;

// ── Найти dropdown ────────────────────────────────────────────────────────────
window._rbFindToggle = function(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('rb-find-panel');
  const btn   = document.getElementById('rb-btn-find');
  if (!panel || !btn) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  placeUnder(panel, btn);
};
window._rbFindClose = function() {
  const p = document.getElementById('rb-find-panel');
  if (p) p.style.display = 'none';
};

document.addEventListener('click', e => {
  if (!e.target.closest('#mb-add-tab') && !e.target.closest('#rb-add-panel')) _rbAddClose();
  if (!e.target.closest('#rb-btn-find') && !e.target.closest('#rb-find-panel')) _rbFindClose();
});

// ── Ribbon tab switching ──────────────────────────────────────────────────────
window._tabSwitch = function(el) {
  const tab = el.dataset.tab;
  if (!tab) return;

  document.querySelectorAll('.mb-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');

  document.querySelectorAll('.rb-panel').forEach(p => { p.style.display = 'none'; });
  const panel = document.getElementById('ribbon-' + tab);
  if (panel) panel.style.display = '';

  if (tab === 'poly')        { if (typeof setTool === 'function') setTool('poly',   true); }
  else if (tab === 'coords') { if (typeof setTool === 'function') setTool('coords', true); }
  else                       { if (typeof setTool === 'function') setTool(null,     true); }

  const onSearch = (tab === 'search');
  const inputSection    = document.getElementById('search-input-section');
  const resultsPanel    = document.getElementById('results-panel');
  if (inputSection)  inputSection.style.display  = onSearch ? '' : 'none';
  if (resultsPanel)  resultsPanel.style.display  = onSearch ? 'flex' : 'none';
  if (onSearch) _syncSearchUI();
  // Перерисовываем карту — панель могла изменить размер контейнера
  requestAnimationFrame(() => { if (typeof map !== 'undefined' && map) map.invalidateSize(); });

  const coordsSection = document.getElementById('coords-input-section');
  if (coordsSection) coordsSection.style.display = (tab === 'coords') ? '' : 'none';
};

// ── Sync ribbon "Поиск" mirrors from sidebar authoritative elements ────────────
window._syncSearchUI = function() {
  const dot = document.getElementById('proxy-dot');
  const rbDot = document.getElementById('rb-proxy-dot');
  if (dot && rbDot) rbDot.className = dot.className;

  const lbl = document.getElementById('proxy-label');
  const rbLbl = document.getElementById('rb-proxy-label');
  if (lbl && rbLbl) rbLbl.textContent = lbl.textContent;


  const search = document.getElementById('btn-search');
  const rbFind = document.getElementById('rb-btn-find');
  if (search && rbFind) rbFind.disabled = search.disabled;

  // sync progress bar
  const pb = document.getElementById('progress-bar');
  const rbPb = document.getElementById('rb-progress-bar');
  if (pb && rbPb) {
    rbPb.style.display = pb.style.display;
    const fill = document.getElementById('progress-fill');
    const rbFill = document.getElementById('rb-progress-fill');
    if (fill && rbFill) rbFill.style.width = fill.style.width;
  }
};

// ── Автосохранение ────────────────────────────────────────────────────────────
// Раз в 90 с (и при закрытии окна) все вкладки пишутся в autosave.json через
// Python. При старте, если есть несохранённые данные, предлагается восстановить.
function _tabHasData(st) {
  return !!(st && ((st.layers || []).length || (st.sources || []).length ||
                   (st.monPoints || []).length || (st.foundParcels || []).length));
}

window._autosaveNow = function() {
  const api = window.pywebview && window.pywebview.api;
  if (!api || !api.autosave || !window._appInitialized) return;
  try {
    const cur = _ptabs.find(t => t.id === _ptabCurrent);
    if (cur && typeof _captureAppState === 'function') cur.state = _captureAppState();
    const tabs = _ptabs.map(t => ({ name: t.name, projectId: t.projectId, state: t.state }));
    const hasData = tabs.some(t => _tabHasData(t.state));
    if (!hasData) { if (api.clear_autosave) api.clear_autosave(); return; }
    // Предлагаем восстановление только если есть данные, ни разу не сохранённые в файл
    const offer = tabs.some(t => _tabHasData(t.state) && !t.projectId);
    api.autosave(JSON.stringify({ ts: Date.now(), offer: offer, tabs: tabs })).catch(() => {});
  } catch(e) {}
};

window._restoreAutosave = function(p) {
  const tabs = (p && p.tabs || []).filter(t => _tabHasData(t.state));
  if (!tabs.length) return;
  const base = Date.now();
  _ptabs = tabs.map((t, i) => ({
    id: 'ptab_' + (base + i), projectId: t.projectId || null,
    name: t.name || 'Новый проект', state: t.state || null,
  }));
  _ptabCurrent = _ptabs[0].id;
  if (typeof _restoreAppState === 'function') _restoreAppState(_ptabs[0].state);
  document.getElementById('tb-project-name').textContent = _ptabs[0].name;
  _ptabRender();
  if (typeof setSt === 'function') setSt('Автосохранение восстановлено', 'ok');
};

function initApp() {
  // Create the initial project tab
  const firstTid = 'ptab_' + Date.now();
  _ptabs.push({ id: firstTid, projectId: null, name: 'Новый проект', state: null });
  _ptabCurrent = firstTid;
  _ptabRender();

  initMap();
  if (typeof _initSources   === 'function') _initSources();
  if (typeof _initMonPoints === 'function') _initMonPoints();
  checkProxy();
  if (typeof _initSearchAreaTools === 'function') _initSearchAreaTools();
  if (typeof _initCanvasDrawing === 'function') _initCanvasDrawing();
  updateButtons();

  // Patch updateButtons and checkProxy to keep ribbon mirrors in sync
  const _origUpdateButtons = window.updateButtons;
  if (_origUpdateButtons) {
    window.updateButtons = function() { _origUpdateButtons(); _syncSearchUI(); };
  }
  const _origCheckProxy = window.checkProxy;
  if (_origCheckProxy) {
    window.checkProxy = async function() {
      await _origCheckProxy();
      _syncSearchUI();
    };
  }
  // Периодическая проверка: индикатор покажет обрыв прокси, а не только по кнопке
  setInterval(() => { if (window.checkProxy) window.checkProxy(); }, 60000);

  map.on('moveend zoomend', () => { if (typeof updatePdfOverlays === 'function') updatePdfOverlays(); });
  _initMainSidebarResize();
  _initLayerBoxResize();
  window.addEventListener('resize', debounce(() => {
    if (document.getElementById('pdf-editor').style.display !== 'none') {
      if (typeof _applyOrientation === 'function') _applyOrientation();
      if (typeof pdfMap !== 'undefined' && pdfMap) pdfMap.invalidateSize();
    } else {
      map.invalidateSize();
    }
  }, 200));

  window._appInitialized = true;
  if (window._pendingStartupProject) {
    const _proj = window._pendingStartupProject;
    window._pendingStartupProject = null;
    if (typeof _applyStartupProject === 'function') _applyStartupProject(_proj);
  }
  if (window._pendingAutosave) {
    const _as = window._pendingAutosave;
    window._pendingAutosave = null;
    window._restoreAutosave(_as);
  }
  setInterval(() => window._autosaveNow(), 90000);
}

function _initMainSidebarResize() {
  const handle  = document.getElementById('main-resize-handle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;
  const KEY = 'sidebarWidth';

  // Ширину панели подбирают под длину названий («Разведочная скважина № 351р»
  // в 300 px не помещается), поэтому она должна переживать перезапуск.
  const saved = (typeof Store !== 'undefined') ? Store.get(KEY, null) : null;
  if (saved && isFinite(saved)) sidebar.style.width = Math.max(200, Math.min(600, +saved)) + 'px';

  let startX = 0, startW = 0;

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    startX = e.clientX;
    startW = sidebar.offsetWidth;

    function onMove(ev) {
      const newW = Math.max(200, Math.min(600, startW + (ev.clientX - startX)));
      sidebar.style.width = newW + 'px';
      map.invalidateSize();
    }
    function onUp() {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      map.invalidateSize();
      try { if (typeof Store !== 'undefined') Store.set(KEY, sidebar.offsetWidth); } catch (e) {}
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });

  // Двойной клик по разделителю — ширина по самому длинному названию слоя,
  // но не шире трети окна
  handle.addEventListener('dblclick', () => {
    const names = [...document.querySelectorAll('.li-name')];
    if (!names.length) return;
    // Запас считаем по самой строке, а не «на глаз»: чекбокс, образец цвета,
    // метка типа, процент, замок и крестик занимают вполне конкретное место
    const row = names[0].closest('.li-row');
    const overhead = row
      ? Math.round(row.getBoundingClientRect().width - names[0].getBoundingClientRect().width)
        + (sidebar.offsetWidth - row.getBoundingClientRect().width) + 12
      : 170;
    const need = Math.max(...names.map(n => n.scrollWidth)) + overhead;
    const w = Math.max(240, Math.min(600, Math.min(need, Math.round(window.innerWidth / 3))));
    sidebar.style.width = w + 'px';
    map.invalidateSize();
    try { if (typeof Store !== 'undefined') Store.set(KEY, w); } catch (e) {}
    setSt(`Ширина панели: ${w} px`, 'ok');
  });
}

function _initLayerBoxResize() {
  const handle = document.getElementById('layer-resize-handle');
  const box    = document.getElementById('layer-box');
  if (!handle || !box) return;

  const STORAGE_KEY = 'layerBoxHeight';

  // Без ручной высоты список тянется на всю панель — класс manual
  // переключает его обратно на фиксированную (см. .section-grow в main.css).
  function setManual(h) {
    box.classList.add('manual');
    box.style.height = h + 'px';
  }
  function setAuto() {
    box.classList.remove('manual');
    box.style.height = '';
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved && saved >= 60) setManual(saved);

  let startY = 0, startH = 0;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startY = e.clientY;
    startH = box.offsetHeight;
    handle.style.background = 'rgba(255,255,255,0.08)';

    function onMove(ev) {
      setManual(Math.max(60, Math.min(600, startH + (ev.clientY - startY))));
    }
    function onUp() {
      handle.style.background = '';
      if (box.classList.contains('manual')) localStorage.setItem(STORAGE_KEY, box.offsetHeight);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Двойной клик возвращает список на всю панель — так же, как двойной клик
  // по вертикальному разделителю подгоняет её ширину.
  handle.addEventListener('dblclick', () => {
    setAuto();
    setSt('Список слоёв — во всю панель', 'ok');
  });
}

document.addEventListener('DOMContentLoaded', () => initApp());


/* ── Классы СЗЗ по СанПиН 2.2.1/2.1.1.1200-03 ────────────────────────────
   I — 1000 м, II — 500, III — 300, IV — 100, V — 50. Буфер почти всегда
   равен одному из них, поэтому пять кнопок рядом с полем экономят набор
   и заодно показывают, нормативное ли сейчас значение. */
window.szzSetClass = function (m) {
  const inp = document.getElementById('szz-buffer-m');
  if (!inp) return;
  inp.value = m;
  window.szzSyncClass();
  inp.dispatchEvent(new Event('change', { bubbles: true }));
};

window.szzSyncClass = function () {
  const inp = document.getElementById('szz-buffer-m');
  const box = document.getElementById('szz-classes');
  if (!inp || !box) return;
  const v = parseFloat(inp.value);
  box.querySelectorAll('.rb-cls').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.m) === v);
  });
};

document.addEventListener('DOMContentLoaded', () => { try { window.szzSyncClass(); } catch (e) {} });
