'use strict';
// Границы населённых пунктов (НП)

const _SL_PROXY = (window.APP_CONFIG && window.APP_CONFIG.proxy) || 'http://127.0.0.1:8767';
let _slLayers  = [];       // [{name, brd_nmb, geojson, layer}]
let _slVisible = true;
let _slAbort   = null;

async function searchSettlements() {
  const al = getActiveLayer();
  if (!al || !al.poly || !al.poly.length) {
    setSt('Нет активного слоя', 'err');
    return;
  }

  if (_slAbort) { try { _slAbort.abort(); } catch(e) {} }
  _slAbort = new AbortController();

  const findBtn = document.getElementById('rb-btn-find');
  if (findBtn) findBtn.disabled = true;
  setSt('Поиск границ НП…', '');

  try {
    // Строим полигон из активного слоя
    let outerRing;
    if (al.geojson && al.geojson.coordinates && al.geojson.coordinates[0]) {
      outerRing = [...al.geojson.coordinates[0]];
    } else {
      outerRing = al.poly.map(p => [p[1], p[0]]);  // [lat,lon] -> [lon,lat]
    }
    // Замкнуть кольцо
    const f0 = outerRing[0], fN = outerRing[outerRing.length - 1];
    if (f0[0] !== fN[0] || f0[1] !== fN[1]) outerRing.push([...f0]);

    const sq = JSON.stringify({ type: 'Polygon', coordinates: [outerRing] });
    const params = new URLSearchParams({ sq });
    const r = await fetchSafe(`${_SL_PROXY}/settlements?${params}`, 90000, _slAbort.signal);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const feats = data.features || [];

    _clearSlLayers();

    for (const f of feats) {
      if (!f.geometry || !f.geometry.type) continue;
      try {
        // MultiPolygon разбиваем на отдельные объекты — каждая часть отдельным НП
        const parts = f.geometry.type === 'MultiPolygon'
          ? f.geometry.coordinates.map((rings, idx) => ({
              name:    f.geometry.coordinates.length > 1 ? `${f.name} (${idx + 1})` : f.name,
              brd_nmb: f.brd_nmb || '',
              geojson: { type: 'Polygon', coordinates: rings },
            }))
          : [{ name: f.name, brd_nmb: f.brd_nmb || '', geojson: f.geometry }];

        for (const part of parts) {
          const sl = { name: part.name, brd_nmb: part.brd_nmb, geojson: part.geojson, layer: null };
          const lyr = L.geoJSON(part.geojson, {
            style: () => ({
              color:       '#ef4444',
              fillColor:   '#fca5a5',
              fillOpacity: 0.07,
              weight:      2.5,
              dashArray:   '8 5',
              opacity:     0.9,
            })
          })
          .bindTooltip(`${part.name}`, { sticky: true, className: 'parcel-tip' })
          .on('contextmenu', e => {
            L.DomEvent.stopPropagation(e);
            L.DomEvent.preventDefault(e);
            _slContextMenu(e.originalEvent, sl);
          })
          .addTo(map);
          sl.layer = lyr;
          _slLayers.push(sl);
        }
      } catch(e) {
        console.warn('[settlements] layer error:', e);
      }
    }

    _renderSlList();
    const sec = document.getElementById('sl-results-section');
    if (sec) sec.style.display = _slLayers.length ? '' : 'none';
    setSt(`Найдено НП: ${_slLayers.length}`, 'ok');
  } catch(e) {
    if (e.name !== 'AbortError') setSt('Ошибка поиска НП: ' + (e.message || e), 'err');
  } finally {
    const al2 = getActiveLayer();
    const findBtn2 = document.getElementById('rb-btn-find');
    if (findBtn2) findBtn2.disabled = !(al2 && al2.poly && al2.poly.length);
  }
}

// ── ПКМ на полигоне НП ────────────────────────────────────────────────────
function _slContextMenu(e, sl) {
  document.getElementById('src-ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'src-ctx-menu';
  menu.className = 'src-ctx-menu';

  const ico = id => `<svg class="icon icon-sm" style="margin-right:4px;vertical-align:middle"><use href="#${id}"/></svg>`;
  const btnAdd = document.createElement('button');
  btnAdd.innerHTML = ico('ico-plus') + 'Добавить в слои';
  btnAdd.onclick = () => { _addSlToLayer(sl); menu.remove(); };
  menu.appendChild(btnAdd);

  const btnZoom = document.createElement('button');
  btnZoom.innerHTML = ico('ico-target') + 'Перейти к НП';
  btnZoom.onclick = () => {
    try { map.fitBounds(sl.layer.getBounds(), { padding: [30, 30] }); } catch(e) {}
    menu.remove();
  };
  menu.appendChild(btnZoom);

  const btnCoords = document.createElement('button');
  btnCoords.innerHTML = ico('ico-copy') + 'Экспорт координат';
  btnCoords.onclick = () => {
    const geom = sl.geojson;
    let rings = [];
    if (geom && geom.type === 'Polygon') rings = [geom.coordinates[0].map(c => [c[1], c[0]])];
    else if (geom && geom.type === 'MultiPolygon') rings = geom.coordinates.map(r => r[0].map(c => [c[1], c[0]]));
    if (typeof showCoordsModal === 'function') showCoordsModal('НП ' + sl.name, rings, sl.name);
    menu.remove();
  };
  menu.appendChild(btnCoords);

  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX, y = e.clientY;
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > vw - 8) x = vw - mw - 8;
  if (y + mh > vh - 8) y = vh - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ── Добавить НП как обычный слой (аналог copyParcelToLayer) ───────────────
function _addSlToLayer(sl) {
  const geom = sl.geojson;
  if (!geom || !geom.type) { setSt('Нет геометрии НП', 'err'); return; }

  let poly;
  if (geom.type === 'Polygon') {
    poly = geom.coordinates[0].map(c => [c[1], c[0]]);
  } else if (geom.type === 'MultiPolygon') {
    // Берём все внешние кольца всех частей — не отбрасываем анклавы/эксклавы
    poly = geom.coordinates.flatMap(rings => rings[0].map(c => [c[1], c[0]]));
  } else {
    setSt('Неподдерживаемый тип геометрии', 'err');
    return;
  }

  const cfg  = typeof getStyleCfg === 'function' ? getStyleCfg() : { parcelW: 2 };
  const style = { color: '#ef4444', weight: cfg.parcelW || 2, fillColor: '#fca5a5', fillOpacity: 0.12 };
  const leafLayer = L.geoJSON(geom, { style: () => style }).addTo(map);
  const newL = addMapLayer('parcel', `НП ${sl.name}`, poly, leafLayer);
  newL.geojson = geom;
  map.fitBounds(leafLayer.getBounds(), { padding: [40, 40] });
  setSt(`НП «${sl.name}» добавлен в слои`, 'ok');
}

// ── Добавить НП из списка в слои (по кнопке в карточке) ──────────────────
function _slAddToLayerByIdx(i) {
  const sl = _slLayers[i];
  if (sl) _addSlToLayer(sl);
}

function clearSettlements() {
  _clearSlLayers();
  _renderSlList();
  const sec = document.getElementById('sl-results-section');
  if (sec) sec.style.display = 'none';
}

function toggleSettlementsVis() {
  _slVisible = !_slVisible;
  _slLayers.forEach(sl => {
    try {
      if (_slVisible) sl.layer.addTo(map);
      else sl.layer.remove();
    } catch(e) {}
  });
  const btn = document.getElementById('btn-sl-toggle');
  if (btn) {
    btn.innerHTML = _slVisible
      ? '<svg class="icon icon-sm"><use href="#ico-eye-off"/></svg><span>Скрыть НП</span>'
      : '<svg class="icon icon-sm"><use href="#ico-eye"/></svg><span>Показать НП</span>';
  }
}

function _slZoomTo(i) {
  const sl = _slLayers[i];
  if (!sl) return;
  try { map.fitBounds(sl.layer.getBounds(), { padding: [30, 30] }); } catch(e) {}
}

function _clearSlLayers() {
  _slLayers.forEach(sl => { try { sl.layer.remove(); } catch(e) {} });
  _slLayers = [];
}

function _renderSlList() {
  const list = document.getElementById('sl-list');
  const cnt  = document.getElementById('sl-cnt');
  if (!list) return;
  if (cnt) cnt.textContent = _slLayers.length;
  if (!_slLayers.length) {
    list.innerHTML = '<div class="empty">Нет данных</div>';
    return;
  }
  list.innerHTML = _slLayers.map((sl, i) => `
    <div class="pcard sl-card" onclick="_slZoomTo(${i})">
      <div class="pcn">${sl.name}</div>
      ${sl.brd_nmb ? `<div class="paddr">${sl.brd_nmb}</div>` : ''}
      <div class="ptags">
        <span class="tag sl-tag">НП</span>
        <button class="sl-add-btn" onclick="event.stopPropagation();_slAddToLayerByIdx(${i})" title="Добавить в слои">⊕ в слои</button>
      </div>
      <button class="pcard-goto" onclick="event.stopPropagation();_slZoomTo(${i})" title="Показать на карте">
        <svg class="icon icon-sm"><use href="#ico-target"/></svg>на карте
      </button>
    </div>
  `).join('');
}
