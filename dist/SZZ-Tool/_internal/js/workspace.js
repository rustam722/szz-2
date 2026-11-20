/* Workspace chrome. Existing editors retain their controls and data ownership. */
window.Workspace = (() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const icon = name => `<svg class="icon icon-sm" aria-hidden="true"><use href="#ico-${name}"/></svg>`;
  const compact = () => window.innerWidth < 1050;
  const isPdf = () => $('pdf-editor').style.display !== 'none';
  const roots = {};
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem('workspace.' + key)) ?? fallback; }
    catch (_) { return fallback; }
  };
  const save = (key, value) => {
    try { localStorage.setItem('workspace.' + key, JSON.stringify(value)); } catch (_) {}
  };
  function element(tag, id, className, html = '') {
    const el = document.createElement(tag);
    if (id) el.id = id;
    el.className = className;
    el.innerHTML = html;
    return el;
  }
  function toggleButton(context, side, label, symbol) {
    return `<button type="button" class="ws-button ws-toggle" data-workspace="${context}" data-side="${side}" aria-controls="${context === 'map' ? (side === 'left' ? 'sidebar' : 'map-inspector') : (side === 'left' ? 'pdf-navigator' : 'pdf-sidebar')}" onclick="Workspace.toggle('${context}','${side}')">${icon(symbol)}<span>${label}</span></button>`;
  }
  function resizeMaps() {
    if (typeof map !== 'undefined' && map) map.invalidateSize({pan:false});
    if (isPdf() && typeof _applyOrientation === 'function') _applyOrientation();
  }
  let resizeFrame;
  function scheduleResize() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(resizeMaps);
  }
  function sync(context) {
    document.querySelectorAll(`[data-workspace="${context}"]`).forEach(btn => {
      const resultsVisible = context === 'map' && roots.map.classList.contains('ws-show-results') && !roots.map.classList.contains('ws-inspect-layer');
      const open = !roots[context].classList.contains('ws-hide-' + btn.dataset.side) && !(btn.dataset.side === 'right' && resultsVisible);
      btn.setAttribute('aria-expanded', String(open));
      btn.classList.toggle('active', open);
      btn.title = `${open ? 'Скрыть' : 'Показать'} ${btn.textContent.trim().toLowerCase()}`;
    });
    scheduleResize();
  }
  function setPanel(context, side, open, persist = true) {
    const root = roots[context];
    if (!root) return;
    root.classList.toggle('ws-hide-' + side, !open);
    if (context === 'map' && side === 'right' && open) root.classList.add('ws-inspect-layer');
    if (open && compact()) root.classList.add('ws-hide-' + (side === 'left' ? 'right' : 'left'));
    if (persist && !compact()) save(context + '.' + side, open);
    sync(context);
  }
  function toggle(context, side) {
    const resultsVisible = context === 'map' && side === 'right' && roots.map.classList.contains('ws-show-results') && !roots.map.classList.contains('ws-inspect-layer');
    setPanel(context, side, resultsVisible || roots[context].classList.contains('ws-hide-' + side));
  }
  function showResults() {
    roots.map.classList.remove('ws-hide-right','ws-inspect-layer');
    if (compact()) roots.map.classList.add('ws-hide-left');
    sync('map');
  }
  function applyResponsive(onlyContext) {
    for (const context of onlyContext ? [onlyContext] : ['map', 'pdf']) {
      const root = roots[context];
      const left = compact() ? context === 'map' : read(context + '.left', true);
      const right = compact() ? context === 'pdf' : read(context + '.right', true);
      root.classList.toggle('ws-hide-left', !left);
      root.classList.toggle('ws-hide-right', !right);
      sync(context);
    }
  }
  function reset(context) {
    const panels = context === 'map' ? ['sidebar', 'map-inspector'] : ['pdf-navigator', 'pdf-sidebar'];
    panels.forEach(id => { $(id).style.width = ''; save(id + '.width', null); });
    save(context + '.left', true);
    save(context + '.right', true);
    if (typeof _lpModeSet === 'function') { _lpModeSet('right'); _lpApplyDock(); }
    applyResponsive(context);
  }
  function bindResize(handleId, panelId, context, side, defaultWidth) {
    const handle = $(handleId), panel = $(panelId);
    if (!handle || !panel || handle._workspaceResize) return;
    handle._workspaceResize = true;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', side === 'left' ? 'Ширина списка слоёв' : 'Ширина панели свойств');
    handle.setAttribute('aria-controls', panelId);
    handle.tabIndex = 0;
    handle.title = 'Тяните для изменения ширины · двойной щелчок — сброс · ← → с клавиатуры';
    const min = side === 'left' ? 230 : 270;
    const max = () => Math.max(min, Math.min(440, window.innerWidth * .34));
    const set = width => {
      const value = Math.round(Math.max(min, Math.min(max(), width)));
      panel.style.width = value + 'px';
      handle.setAttribute('aria-valuenow', value);
      handle.setAttribute('aria-valuemin', min);
      handle.setAttribute('aria-valuemax', Math.round(max()));
      scheduleResize();
    };
    const stored = read(panelId + '.width', null);
    if (stored) set(stored);
    else {
      handle.setAttribute('aria-valuenow', defaultWidth);
      handle.setAttribute('aria-valuemin', min);
      handle.setAttribute('aria-valuemax', Math.round(max()));
    }
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startWidth = panel.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('ws-resizing');
      const move = ev => set(startWidth + (ev.clientX - startX) * (side === 'left' ? 1 : -1));
      const stop = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        handle.removeEventListener('lostpointercapture', stop);
        document.body.classList.remove('ws-resizing');
        save(panelId + '.width', panel.getBoundingClientRect().width);
        scheduleResize();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
      handle.addEventListener('lostpointercapture', stop);
    });
    handle.addEventListener('dblclick', () => { set(defaultWidth); save(panelId + '.width', null); });
    handle.addEventListener('keydown', e => {
      if (!['ArrowLeft','ArrowRight','Home'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      set(e.key === 'Home' ? defaultWidth : panel.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1));
      save(panelId + '.width', panel.getBoundingClientRect().width);
    });
    window.addEventListener('resize', () => { if (panel.style.width) set(parseFloat(panel.style.width)); });
  }
  function mountLayerProps(mode) {
    const panel = $('layer-props-panel');
    if (!roots.map || !panel) return false;
    if (mode === 'float') {
      if (panel.parentElement !== document.body) document.body.append(panel);
      return false;
    }
    const host = $(isPdf() ? 'pdf-layer-inspector' : 'map-inspector-content');
    if (panel.parentElement !== host) host.append(panel);
    panel.classList.remove('lp-floating', 'lp-dock-right');
    ['left','top','right','width','height'].forEach(p => panel.style[p] = '');
    const btn = $('lp-dock-btn');
    btn.title = 'Открепить свойства в отдельное окно (F4)';
    return true;
  }
  function inspectLayer() {
    const mode = typeof _lpModeGet === 'function' ? _lpModeGet() : 'right';
    if (mode === 'float') { _lpApplyDock(); return; }
    mountLayerProps(mode);
    if (isPdf()) $('pdf-sidebar').classList.add('ws-geo-properties');
    setPanel(isPdf() ? 'pdf' : 'map', 'right', true, false);
  }
  function inspectPdf() {
    $('pdf-sidebar').classList.remove('ws-geo-properties');
    setPanel('pdf', 'right', true, false);
  }
  function pdfSection(name, silent) {
    if (name === 'layers') {
      setPanel('pdf', 'left', true, !silent);
      return 'sheet';
    }
    if (!silent) inspectPdf();
    else $('pdf-sidebar').classList.remove('ws-geo-properties');
    return name === 'props' ? 'props' : 'sheet';
  }
  function pdfToolbarBuilt() {
    // The toolbar is rebuilt after changing tools. Move the new zoom controls,
    // keeping one instance of the ids used by the existing zoom implementation.
    const zoom = $('pdf-toolbar').querySelector('#pdf-zoom-pct');
    if (zoom && $('pdf-view-controls')) $('pdf-view-controls').replaceChildren(zoom.parentElement);
    document.querySelectorAll('#pdf-left-toolbar [data-tip]').forEach(btn => {
      btn.title = btn.dataset.tip;
      btn.setAttribute('aria-label', btn.dataset.tip);
    });
  }
  function pdfTreeBuilt() {
    const search = $('pdf-layers-panel').querySelector('.pl-search-row');
    if (search && $('pdf-tree-search')) {
      $('pdf-tree-search').replaceChildren(search);
      $('pl-search').setAttribute('aria-label','Поиск по составу листа');
    }
    pdfSelectionChanged();
  }
  function pdfSelectionChanged() {
    const bar = $('pdf-selection-bar');
    if (!bar || typeof pdfObjects === 'undefined') return;
    const ids = new Set(typeof _pdfMultiSel !== 'undefined' ? _pdfMultiSel : []);
    if (pdfSelId) ids.add(pdfSelId);
    const selected = pdfObjects.filter(o => ids.has(o.id));
    const groupId = selected.find(o => o.groupId)?.groupId;
    bar.replaceChildren();
    if (!selected.length) { bar.hidden = true; return; }
    bar.hidden = false;
    const sameGroup = groupId && selected.every(o => o.groupId === groupId);
    const count = sameGroup ? pdfObjects.filter(o => o.groupId === groupId).length : selected.length;
    const caption = element('span',null,'ws-selection-count',sameGroup ? `Группа · ${count} объектов` : `Выбрано: ${count}`);
    bar.append(caption);
    const button = element('button',null,'ws-button',icon('layers') + (groupId ? 'Разгруппировать' : 'В группу'));
    button.type = 'button';
    button.disabled = !groupId && selected.length < 2;
    button.title = groupId ? 'Разгруппировать (Ctrl+Shift+G)' : 'Выделите несколько объектов с Ctrl или Shift (Ctrl+G — сгруппировать)';
    button.onclick = () => groupId ? ungroupPdfObjects() : groupPdfObjects();
    bar.append(button);
  }
  function enterPdf() {
    const status = $('status-bar');
    $('pdf-view-bar').prepend(status);
    $('app').inert = true;
    $('pdf-sidebar-header').querySelector('button').focus();
  }
  function exitPdf() {
    $('app').inert = false;
    $('workspace-status').prepend($('status-bar'));
    document.querySelector('.mb-pdf-tab').focus();
    scheduleResize();
  }
  function init() {
    roots.map = document.querySelector('.app-body');
    roots.pdf = $('pdf-editor');
    document.documentElement.classList.add('workspace-ui');
    // Управление панелями жило отдельной строкой в 44 px под лентой. На
    // ноутбуке 1366×768 весь хром съедал 199 px — больше четверти экрана,
    // а в той строке было три кнопки, условная четвёртая и надпись
    // «Карта проекта», сообщавшая, что вы смотрите на карту проекта.
    // Кнопки переехали вправо в ленту, где пусто на всех вкладках;
    // строка убрана, экрану вернулось 44 px.
    const bar = element('div', 'map-workspace-bar', 'ws-ribbon-group',
      `${toggleButton('map','left','Слои','layers')}` +
      `<button type="button" id="map-results-toggle" class="ws-button" hidden onclick="Workspace.showResults()">${icon('search')}<span>Результаты</span></button>` +
      `<button type="button" class="ws-button ws-reset" onclick="Workspace.reset('map')" title="Вернуть стандартное расположение панелей">${icon('fit')}<span>Сбросить вид</span></button>` +
      `${toggleButton('map','right','Свойства','sliders')}`);
    const quick = document.querySelector('.rb-quick');
    if (quick) quick.append(bar); else roots.map.before(bar);
    const inspector = element('aside','map-inspector','ws-inspector',
      `<div class="ws-panel-heading"><strong>Свойства слоя</strong><button type="button" class="ws-icon-button" onclick="Workspace.toggle('map','right')" aria-label="Скрыть свойства слоя">${icon('x')}</button></div><div id="map-inspector-content"><div class="ws-empty">${icon('sliders')}<strong>Выберите слой</strong><p>Нажмите на слой в списке или на объект карты, чтобы изменить его оформление.</p></div></div>`);
    const divider = element('div','map-inspector-resize','ws-divider');
    // Results remain a separate column; when visible they take the inspector's
    // space rather than leaving the map squeezed between three sidebars.
    roots.map.append(divider, inspector);
    const footer = element('div','workspace-status','ws-status');
    $('app').append(footer);
    if ($('status-bar')) footer.append($('status-bar'));
    if ($('mb-proxy')) footer.append($('mb-proxy'));
    const coords = $('coords-input-section');
    if (coords) $('sidebar').prepend(coords);
    const layerHeading = $('sidebar').querySelector('.section-grow > .section-hdr');
    layerHeading.removeAttribute('onclick');
    layerHeading.querySelector('.section-arrow').remove();
    layerHeading.querySelector('.section-title').textContent = 'Слои проекта';
    layerHeading.append(element('span',null,'ws-count-hint','Ctrl + G · группа'));
    $('layer-search').setAttribute('aria-label','Поиск слоёв проекта');
    $('layer-type-filter').setAttribute('aria-label','Тип слоя');
    // Removing duplicate "clear all" from search prevents confusing it with
    // clearing the search field. The existing Home command remains available.
    const clear = $('layer-search').parentElement.querySelector('button[onclick="clearAll()"]');
    if (clear) clear.remove();

    const header = $('pdf-sidebar-header');
    roots.pdf.prepend(header);
    header.classList.add('ws-bar');
    const exportWrap = header.querySelector('.pdf-export-wrap');
    exportWrap.before(element('strong',null,'ws-bar-title','Макет для печати'));
    exportWrap.before(element('div',null,'ws-spacer'));
    exportWrap.before(element('div',null,'ws-header-panels',toggleButton('pdf','left','Слои','layers') + toggleButton('pdf','right','Свойства','sliders')));
    exportWrap.before(element('button',null,'ws-button ws-reset',icon('fit')));
    exportWrap.previousElementSibling.type = 'button';
    exportWrap.previousElementSibling.title = 'Сбросить расположение панелей';
    exportWrap.previousElementSibling.setAttribute('aria-label','Сбросить расположение панелей');
    exportWrap.previousElementSibling.onclick = () => reset('pdf');
    $('pdf-export-btn').childNodes.forEach(node => { if (node.nodeType === 3 && node.textContent.trim()) node.textContent = 'Экспорт'; });
    const nav = element('aside','pdf-navigator','ws-navigator',
      `<div class="ws-panel-heading"><strong>Состав листа</strong><button type="button" class="ws-icon-button" onclick="Workspace.toggle('pdf','left')" aria-label="Скрыть состав листа">${icon('x')}</button></div><div id="pdf-tree-search"></div><div id="pdf-selection-bar" hidden></div><div class="ws-tree-scroll" id="pdf-tree-scroll"></div>`);
    $('pdf-left-toolbar').after(nav, element('div','pdf-navigator-resize','ws-divider'));
    $('pdf-tree-scroll').append($('pdf-objects-panel'), $('pdf-pane-layers'));
    $('pdf-sidebar').prepend(element('div',null,'ws-panel-heading',`<strong>Настройки</strong><button type="button" class="ws-icon-button" onclick="Workspace.toggle('pdf','right')" aria-label="Скрыть настройки">${icon('x')}</button>`));
    document.querySelector('#pdf-tabs [data-tab="layers"]').remove();
    $('pdf-sidebar').append(element('div','pdf-layer-inspector','',`<button type="button" class="ws-button ws-properties-back" onclick="pdfTab('sheet')">← Настройки листа</button>`));
    const viewBar = element('div','pdf-view-bar','ws-view-bar',`<div id="pdf-view-controls"></div>`);
    $('pdf-canvas-col').append(viewBar);
    // Map positioning is a canvas action and stays accessible on every tab.
    $('pdf-sheets').after($('pdf-map-bar'));
    bindResize('main-resize-handle','sidebar','map','left',278);
    bindResize('map-inspector-resize','map-inspector','map','right',304);
    bindResize('pdf-navigator-resize','pdf-navigator','pdf','left',248);
    bindResize('pdf-resize-handle','pdf-sidebar','pdf','right',304);
    mountLayerProps('right');
    applyResponsive();
    let wasCompact = compact();
    window.addEventListener('resize', () => {
      if (wasCompact !== compact()) { wasCompact = compact(); applyResponsive(); }
      scheduleResize();
    });
    const results = $('results-panel');
    if (results) new MutationObserver(() => {
      const visible = results.style.display !== 'none';
      roots.map.classList.toggle('ws-show-results', visible);
      $('map-results-toggle').hidden = !visible;
      if (visible) showResults();
      else sync('map');
    }).observe(results,{attributes:true,attributeFilter:['style','class']});
    // Keyboard activation for the existing div-based menu tabs.
    document.querySelectorAll('.mb-tab').forEach(tab => {
      tab.setAttribute('role','button'); tab.tabIndex = 0;
      tab.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tab.click(); }
      });
    });
    document.querySelectorAll('.modal').forEach((modal, index) => {
      const heading = modal.querySelector('.modal-hdr h2');
      if (heading) {
        if (!heading.id) heading.id = 'workspace-dialog-title-' + index;
        modal.setAttribute('aria-labelledby', heading.id);
      }
      modal.setAttribute('role','dialog');
      modal.setAttribute('aria-modal','true');
      const close = modal.querySelector('.modal-close');
      if (close) close.setAttribute('aria-label','Закрыть окно');
    });
  }
  return {init,toggle,reset,mountLayerProps,inspectLayer,inspectPdf,pdfSection,pdfToolbarBuilt,pdfTreeBuilt,pdfSelectionChanged,enterPdf,exitPdf,showResults,
    showLayers: () => setPanel('map','left',true,false)};
})();
Workspace.init();
