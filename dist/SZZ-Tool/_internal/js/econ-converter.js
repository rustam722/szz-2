// ═══════════════════════════════════════════════════════════════════════════
//  УПРЗА Эколог → XML (конвертер таблиц Excel)
//  ---------------------------------------------------------------------------
//  Перенесено из отдельного инструмента «Конвертер в ЭКолог.xml»
//  (\\Pk2\папка обмена\Беляев РА\Конвертер). Разбор Excel-таблиц (.xls/.xlsx/
//  .xlsm) с источниками выбросов и загрязняющими веществами → XML формата
//  INTEGRAL (УПРЗА Эколог). Логика автоопределения колонок/строк-источников/
//  кодирования windows-1251 не менялась — перенесена как есть.
//
//  Изменения при переносе:
//   • XLSX.js уже загружен в index.html (lib/xlsx.full.min.js, используется
//     export.js) — свою копию библиотеки не тащим.
//   • Разметка строится лениво при первом переключении на вкладку
//     (EconConv.ensureInit, вызывается из ConvHub.switchTab в
//     noise-converter.js), по тому же образцу, что и сам режим конвертера.
//   • Each-файл-свою-ссылку (a.href=blob;download) заменено на кнопки,
//     вызывающие _download() из export.js — обычный a.click() заблокирован
//     под pywebview.
//   • alert()-подобный showE() теперь пишет в блок .nc-eb вместо системного
//     алерта, который не подчиняется теме и блокирует всё окно.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  //  Описание полей таблицы и ключевых слов для автоопределения колонок
  // ══════════════════════════════════════════════════════════════════════════
  const FLD = [
    { id: 'ID', lb: '№ ИЗАВ', req: 1, ks: ['№ изав', 'номер изав'] },
    { id: 'TP', lb: 'Тип ИЗАВ', req: 1, ks: ['тип изав', 'тип источника'] },
    { id: 'NM', lb: 'Наименование ИЗАВ', req: 1, ks: ['наименование изав', 'наименование источника'] },
    { id: 'H', lb: 'Высота, м', req: 1, ks: ['высота источника', 'высота, м', 'высота (м)'] },
    { id: 'D', lb: 'Диаметр (орг.), м', req: 1, ks: ['диаметр, м', 'диаметр'] },
    { id: 'DU', lb: 'Ширина площ. (неорг.), м', req: 0, ks: ['ширина площадного', 'ширина площад'] },
    { id: 'X1', lb: 'X1', req: 1, ks: ['x1'] },
    { id: 'Y1', lb: 'Y1', req: 1, ks: ['y1'] },
    { id: 'X2', lb: 'X2', req: 0, ks: ['x2'] },
    { id: 'Y2', lb: 'Y2', req: 0, ks: ['y2'] },
    { id: 'W', lb: 'Скорость ГВС, м/с', req: 1, ks: ['скорость выхода', 'скорость гвс'] },
    { id: 'V', lb: 'Объём ГВС, м³/с', req: 1, ks: ['объём (расход)', 'объём (расход)', 'расход гвс'] },
    { id: 'T', lb: 'Темп. ГВС, °C', req: 1, ks: ['температура гвс'] },
    { id: 'P', lb: 'Плотность, кг/м³', req: 0, ks: ['плотность гвс', 'плотность'] },
    { id: 'CP', lb: 'Код ЗВ', req: 1, ks: ['| код', 'код зв'] },
    { id: 'GRS', lb: 'Мощность, г/с', req: 1, ks: ['мощность выброса', 'г/с'] },
    { id: 'TG', lb: 'Валовые, т/год', req: 1, ks: ['суммарные годовые', 'валовые', 'итого за год'] },
  ];

  let batch = [], baseRows = [], colH = [], cmap = {}, preSrc = [];

  function toF(v) { const s = String(v || '').trim().replace(',', '.').replace(/\s/g, ''); if (!s || s === 'NaN') return 0; const f = parseFloat(s); return isNaN(f) ? 0 : f; }
  function fm(v) { const f = toF(v); if (!f) return '0'; if (Math.abs(f) >= 1000) return f.toFixed(4).replace(/\.?0+$/, ''); return parseFloat(f.toPrecision(7)).toString().replace(/e([+-])(\d)$/, 'e$10$2'); }
  function eH(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function gc(row, fid) { const c = cmap[fid]; return c >= 0 ? row[c] : ''; }

  function w1251(s) {
    const t = [0x0402,0x0403,0x201A,0x0453,0x201E,0x2026,0x2020,0x2021,0x20AC,0x2030,0x0409,0x2039,0x040A,0x040C,0x040B,0x040F,0x0452,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0,0x2122,0x0459,0x203A,0x045A,0x045C,0x045B,0x045F,0x00A0,0x040E,0x045E,0x0408,0x00A4,0x0490,0x00A6,0x00A7,0x0401,0x00A9,0x0404,0x00AB,0x00AC,0x00AD,0x00AE,0x0407,0x00B0,0x00B1,0x0406,0x0456,0x0491,0x00B5,0x00B6,0x00B7,0x0451,0x2116,0x0454,0x00BB,0x0458,0x0405,0x0455,0x0457,0x0410,0x0411,0x0412,0x0413,0x0414,0x0415,0x0416,0x0417,0x0418,0x0419,0x041A,0x041B,0x041C,0x041D,0x041E,0x041F,0x0420,0x0421,0x0422,0x0423,0x0424,0x0425,0x0426,0x0427,0x0428,0x0429,0x042A,0x042B,0x042C,0x042D,0x042E,0x042F,0x0430,0x0431,0x0432,0x0433,0x0434,0x0435,0x0436,0x0437,0x0438,0x0439,0x043A,0x043B,0x043C,0x043D,0x043E,0x043F,0x0440,0x0441,0x0442,0x0443,0x0444,0x0445,0x0446,0x0447,0x0448,0x0449,0x044A,0x044B,0x044C,0x044D,0x044E,0x044F];
    const m = {};
    for (let i = 0; i < t.length; i++) if (t[i]) m[t[i]] = i + 0x80;
    const b = new Uint8Array(s.length * 2);
    let n = 0;
    for (let j = 0; j < s.length; j++) { const c = s.charCodeAt(j); if (c < 0x80) b[n++] = c; else if (m[c] !== undefined) b[n++] = m[c]; else b[n++] = 0x3F; }
    return b.slice(0, n);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Чтение Excel и автоопределение колонок/листа
  // ══════════════════════════════════════════════════════════════════════════
  function bestSheet(wb) {
    for (let s = 0; s < wb.SheetNames.length; s++) {
      const ws = wb.Sheets[wb.SheetNames[s]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      for (let r = 0; r < Math.min(5, rows.length); r++) {
        if (Array.isArray(rows[r]) && rows[r].join(' ').toLowerCase().indexOf('изав') >= 0) return ws;
      }
    }
    return wb.Sheets[wb.SheetNames[0]];
  }

  function buildH(rows) {
    let nc = 0;
    for (let r = 0; r < Math.min(6, rows.length); r++) nc = Math.max(nc, rows[r].length);
    colH = [];
    for (let c = 0; c < nc; c++) {
      const pts = [];
      for (let r = 0; r < Math.min(6, rows.length); r++) { const v = String(rows[r][c] || '').trim(); if (v && v !== 'undefined') pts.push(v); }
      colH.push(pts.join(' | '));
    }
  }

  function autoMap() {
    cmap = {};
    FLD.forEach(f => {
      let found = -1;
      for (let c = 0; c < colH.length && found < 0; c++) {
        const h = colH[c].toLowerCase();
        for (let k = 0; k < f.ks.length; k++) { if (h.indexOf(f.ks[k]) >= 0) { found = c; break; } }
      }
      cmap[f.id] = found;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Распознавание строк-источников и разбор
  // ══════════════════════════════════════════════════════════════════════════
  function isSrc(rows, i) {
    const ic = cmap['ID'], tc = cmap['TP'], nc = cmap['NM'];
    if (ic < 0 || i >= rows.length) return false;
    const v = String(rows[i][ic] || '').trim();
    if (!v || v.length > 10 || !/^\d+$/.test(v)) return false;
    // Фильтр от строки нумерации: если в колонке «Наименование» просто
    // цифра 1-99 — это строка номеров колонок, а не источник
    if (nc >= 0) {
      const nmStr = String(rows[i][nc] || '').trim();
      if (nmStr && /^\d{1,2}$/.test(nmStr)) return false;
    }
    if (v[0] === '0') return true;
    const n = parseInt(v, 10);
    if (n >= 100) return true;
    const tpStr = tc >= 0 ? String(rows[i][tc] || '').toLowerCase().trim() : '';
    const isTpOk = (tpStr.indexOf('орган') >= 0 || tpStr === '1' || tpStr === '2' || tpStr === '3');
    if (n >= 1 && n <= 99 && isTpOk) return true;
    return false;
  }

  function parse(rows) {
    const srcs = [], skip = [];
    let cur = null, ds = 0;
    for (let i = 0; i < Math.min(30, rows.length); i++) { if (isSrc(rows, i)) { ds = i; break; } }
    for (let i = ds; i < rows.length; i++) {
      const row = rows[i];
      const cid = cmap['ID'] >= 0 ? String(row[cmap['ID']] || '').trim() : '';
      if (cid.length > 10) continue;
      if (isSrc(rows, i)) {
        if (cur) srcs.push(cur);
        const tpRaw = String(row[cmap['TP']] || '').toLowerCase().trim();
        const tp = (tpRaw.indexOf('неорг') >= 0 || tpRaw === '3') ? '3' : '1';
        let dVal = fm(gc(row, 'D'));
        let zVal = '0';
        if (tp === '3') {
          const duRaw = gc(row, 'DU');
          const duNum = toF(duRaw);
          zVal = (cmap['DU'] >= 0 && duNum !== 0) ? fm(duRaw) : fm(gc(row, 'D'));
          dVal = '0';
        }
        cur = {
          xcode: cid.padStart(4, '0'), name: String(row[cmap['NM']] || '').trim(), tp, h: fm(gc(row, 'H')), d: dVal, z: zVal,
          v: fm(gc(row, 'V')), w: fm(gc(row, 'W')), t: fm(gc(row, 'T')), p: fm(gc(row, 'P')),
          x1: fm(gc(row, 'X1')), y1: fm(gc(row, 'Y1')), x2: fm(gc(row, 'X2')), y2: fm(gc(row, 'Y2')), cnt: [],
        };
      }
      if (cur) {
        const cp = String(gc(row, 'CP') || '').trim();
        if (cp && /^\d+$/.test(cp) && cp.length >= 3) {
          cur.cnt.push({ cp: cp.padStart(4, '0'), grs: fm(gc(row, 'GRS')), tg: fm(gc(row, 'TG')) });
        } else if (cp && cp.length > 1 && isNaN(parseFloat(cp))) {
          skip.push('Стр.' + (i + 1) + ': ' + cp);
        }
      }
    }
    if (cur) srcs.push(cur);
    return { srcs, skip };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  XML (INTEGRAL)
  // ══════════════════════════════════════════════════════════════════════════
  function getEntName() { const el = document.getElementById('nc-ent-name'); return el ? el.value.trim() : ''; }

  function mkXML(srcs) {
    const entName = getEntName();
    const td = new Date().toISOString().slice(0, 10);
    const L = ['<?xml version="1.0" encoding="windows-1251" standalone="no"?>', '<INTEGRAL xmlns="http://integral.ru">', '  <IST>'];
    srcs.forEach((s, i) => {
      const n = i + 1;
      let cx = '';
      if (s.cnt.length) cx = '<CNT>' + s.cnt.map(c => `<REC><CNT_CP>${c.cp}</CNT_CP><CNT_AS>2</CNT_AS><CNT_GRS>${c.grs}</CNT_GRS><CNT_GSGRS>${c.grs}</CNT_GSGRS><CNT_TG>${c.tg}</CNT_TG><CNT_TGTG>${c.tg}</CNT_TGTG></REC>`).join('') + '</CNT>';
      const npt = entName ? `<NAME_PR>${eH(entName)}</NAME_PR>` : '';
      L.push(`    <REC><IST_NN>${n}</IST_NN><IST_VN>1</IST_VN>${npt}<XCODE>${s.xcode}</XCODE><IST_NAME>${eH(s.name)}</IST_NAME><IST_TP>${s.tp}</IST_TP><IST_H>${s.h}</IST_H><IST_D>${s.d}</IST_D><IST_V>${s.v}</IST_V><IST_W>${s.w}</IST_W><IST_T>${s.t}</IST_T><IST_X1>${s.x1}</IST_X1><IST_Y1>${s.y1}</IST_Y1><IST_X2>${s.x2}</IST_X2><IST_Y2>${s.y2}</IST_Y2><IST_XX1>${s.x1}</IST_XX1><IST_YY1>${s.y1}</IST_YY1><IST_XX2>${s.x2}</IST_XX2><IST_YY2>${s.y2}</IST_YY2><IST_Z>${s.z || '0'}</IST_Z><IST_RZ>0</IST_RZ><IST_RL>1</IST_RL><IST_TST>0</IST_TST><IST_TEND>0</IST_TEND><IST_SST>0</IST_SST><IST_SEND>0</IST_SEND><IST_LAT>0</IST_LAT><IST_LONG>0</IST_LONG><IST_CORNER>0</IST_CORNER><IST_DIRECT>0</IST_DIRECT><IST_P>${s.p}</IST_P><DT>${td}</DT><P_U>0</P_U>${cx}</REC>`);
    });
    L.push('  </IST>', '</INTEGRAL>');
    return L.join('\n');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UI — очередь файлов, предпросмотр, сопоставление колонок
  // ══════════════════════════════════════════════════════════════════════════
  function showE(m) { const eb = document.getElementById('nc-eb'); if (!eb) return; eb.textContent = '! ' + m; eb.classList.add('nc-on'); }
  function hideE() { const eb = document.getElementById('nc-eb'); if (eb) eb.classList.remove('nc-on'); }
  function on(id) { const el = document.getElementById(id); if (el) el.classList.add('nc-on'); }
  function off(id) { const el = document.getElementById(id); if (el) el.classList.remove('nc-on'); }
  function log(m, cl) { const box = document.getElementById('nc-log'); if (!box) return; on('nc-log'); const d = document.createElement('div'); d.className = cl; d.textContent = '> ' + m; box.appendChild(d); box.scrollTop = box.scrollHeight; }
  function setP(p, l) { const pf = document.getElementById('nc-pf'); const pct = document.getElementById('nc-ppct'); const lbl = document.getElementById('nc-plbl'); if (pf) pf.style.width = p + '%'; if (pct) pct.textContent = p + '%'; if (lbl) lbl.textContent = l; on('nc-pw'); }

  function init(files) {
    batch = Array.from(files).filter(f => /\.(xlsx?|xlsm)$/i.test(f.name));
    if (!batch.length) { showE('Нет .xls/.xlsx среди выбранных файлов'); return; }
    document.getElementById('nc-dz').classList.add('nc-has');
    ['nc-eb', 'nc-log', 'nc-pw', 'nc-pv', 'nc-map', 'nc-stats'].forEach(off);
    document.getElementById('nc-log').innerHTML = '';
    document.getElementById('nc-dl').innerHTML = '';
    const fl = document.getElementById('nc-fl'); fl.innerHTML = '';
    batch.forEach((f, i) => {
      const d = document.createElement('div'); d.className = 'nc-fi'; d.id = 'nc-fi' + i;
      d.innerHTML = `<span>📊</span><span class="nc-fi-name">${eH(f.name)}</span>` +
        `<span class="nc-fi-sz">${Math.round(f.size / 1024)} KB</span>` +
        `<span class="nc-fi-st" id="nc-fst${i}">ожидает</span>` +
        (batch.length > 1 ? `<button class="nc-fi-rm" onclick="EconConv.rmFile(${i})">✕</button>` : '');
      fl.appendChild(d);
    });
    on('nc-fq');
    document.getElementById('nc-bcv').disabled = true;
    readBase(batch[0]);
  }
  function rmFile(i) { batch.splice(i, 1); if (!batch.length) { resetAll(); return; } init(batch); }
  function resetAll() {
    batch = []; baseRows = []; preSrc = [];
    document.getElementById('nc-dz').classList.remove('nc-has');
    document.getElementById('nc-file').value = '';
    ['nc-eb', 'nc-log', 'nc-pw', 'nc-pv', 'nc-map', 'nc-fq', 'nc-stats'].forEach(off);
    document.getElementById('nc-dl').innerHTML = '';
    document.getElementById('nc-bcv').disabled = true;
  }

  function readBase(f) {
    const r = new FileReader();
    r.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = bestSheet(wb);
        baseRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        buildH(baseRows); autoMap(); buildMapUI(); buildPrev();
      } catch (ex) { showE('Ошибка чтения файла: ' + ex.message); }
    };
    r.readAsArrayBuffer(f);
  }

  function buildMapUI() {
    const allOk = FLD.every(f => !f.req || cmap[f.id] >= 0);
    const fc = FLD.filter(f => cmap[f.id] >= 0).length;
    const bg = document.getElementById('nc-mbg');
    bg.textContent = allOk ? 'Авто ✓' : 'Нужна проверка';
    bg.className = 'nc-map-badge ' + (allOk ? 'nc-ok' : 'nc-warn');
    document.getElementById('nc-msb').textContent = allOk
      ? 'Все колонки найдены. Можно проверить и конвертировать.'
      : `Найдено ${fc}/${FLD.length}. Отмеченные жёлтым — укажи вручную.`;
    let opts = '<option value="-1">— не указано —</option>';
    for (let c = 0; c < colH.length; c++) {
      const lbl = 'Кол.' + (c + 1) + (colH[c] ? ' : ' + colH[c].substring(0, 38) + (colH[c].length > 38 ? '..' : '') : '');
      opts += `<option value="${c}">${eH(lbl)}</option>`;
    }
    const grid = document.getElementById('nc-mg'); grid.innerHTML = '';
    FLD.forEach(f => {
      const d = document.createElement('div'); d.className = 'nc-map-row';
      const v = cmap[f.id];
      d.innerHTML = `<div class="nc-map-lbl">${f.req ? '<span class="nc-req">* </span>' : ''}${f.lb}</div>` +
        `<select class="nc-map-sel ${v >= 0 ? 'nc-f' : 'nc-m'}" data-id="${f.id}" onchange="EconConv.chMap(this)" title="Колонка Excel для: ${f.lb}">${opts}</select>`;
      grid.appendChild(d);
      d.querySelector('select').value = String(v);
    });
    on('nc-map');
    document.getElementById('nc-bcv').disabled = false;
  }

  function chMap(sel) {
    cmap[sel.getAttribute('data-id')] = parseInt(sel.value, 10);
    sel.className = 'nc-map-sel ' + (parseInt(sel.value, 10) >= 0 ? 'nc-f' : 'nc-m');
    const allOk = FLD.every(f => !f.req || cmap[f.id] >= 0);
    const fc = FLD.filter(f => cmap[f.id] >= 0).length;
    const bg = document.getElementById('nc-mbg');
    bg.textContent = allOk ? 'Авто ✓' : 'Нужна проверка';
    bg.className = 'nc-map-badge ' + (allOk ? 'nc-ok' : 'nc-warn');
    document.getElementById('nc-msb').textContent = allOk
      ? 'Все колонки найдены. Можно конвертировать.'
      : `Найдено ${fc}/${FLD.length}. Отмеченные жёлтым — укажи вручную.`;
    buildPrev();
  }

  function resetMap() { autoMap(); buildMapUI(); buildPrev(); setSt('Сопоставление колонок сброшено к автоопределению', 'ok'); }

  function buildPrev() {
    if (!baseRows.length || cmap['ID'] < 0) return;
    const res = parse(baseRows); preSrc = res.srcs;
    const tb = document.getElementById('nc-pvb'); tb.innerHTML = '';
    preSrc.forEach((s, i) => {
      const tr = document.createElement('tr');
      const dOrZ = (s.tp === '3') ? s.z : s.d;
      tr.innerHTML = `<td>${i + 1}</td><td><b>${s.xcode}</b></td>` +
        `<td title="${eH(s.name)}">${eH(s.name.substring(0, 26))}${s.name.length > 26 ? '..' : ''}</td>` +
        `<td>${s.tp === '3' ? '<span style="color:var(--amber)">Неорг</span>' : '<span style="color:var(--acc2)">Орг</span>'}</td>` +
        `<td>${s.h}</td><td>${dOrZ}</td><td>${s.x1}</td><td>${s.y1}</td><td><b>${s.cnt.length}</b></td>`;
      tb.appendChild(tr);
    });
    const nzv = preSrc.reduce((a, s) => a + s.cnt.length, 0);
    document.getElementById('nc-pvc').textContent = `${preSrc.length} ист., ${nzv} ЗВ`;
    document.getElementById('nc-ss').textContent = preSrc.length;
    document.getElementById('nc-sz').textContent = nzv;
    on('nc-pv'); on('nc-stats');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Конвертация пачки файлов
  // ══════════════════════════════════════════════════════════════════════════
  async function doConvert() {
    const miss = FLD.filter(f => f.req && !(cmap[f.id] >= 0)).map(f => f.lb);
    if (miss.length) { showE('Укажи колонки: ' + miss.join(', ')); return; }
    const btn = document.getElementById('nc-bcv');
    btn.disabled = true; btn.textContent = '⏳ Обрабатываю…';
    document.getElementById('nc-log').innerHTML = ''; hideE();
    document.getElementById('nc-dl').innerHTML = '';
    await runBatch();
    setP(100, 'Готово!');
    btn.disabled = false; btn.textContent = '▶ Конвертировать в XML';
  }

  function runBatch() {
    return new Promise(resolve => {
      let idx = 0;
      function next() {
        if (idx >= batch.length) { resolve(); return; }
        const f = batch[idx], i = idx; idx++;
        setP(Math.round(i / batch.length * 88), '📄 ' + f.name);
        document.getElementById('nc-fst' + i).textContent = '...';
        const r = new FileReader();
        r.onload = e => {
          try {
            const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            const ws = bestSheet(wb);
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            const res = parse(rows);
            const nzv = res.srcs.reduce((a, s) => a + s.cnt.length, 0);
            log(`${f.name}: ${res.srcs.length} ист., ${nzv} ЗВ`, 'nc-lok');
            if (res.skip.length) res.skip.forEach(s => log(s, 'nc-lw'));
            const xml = mkXML(res.srcs);
            const enc = w1251(xml);
            const blob = new Blob([enc], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const outName = f.name.replace(/\.[^.]+$/, '') + '_ecolog.xml';
            const a = document.createElement('button');
            a.className = 'nc-btn'; a.style.width = '100%'; a.style.justifyContent = 'center';
            a.textContent = '⬇ ' + outName;
            a.onclick = async () => {
              try { await (typeof _download === 'function' ? _download(url, outName) : _fallbackDl(url, outName)); }
              catch (ex) { askNotice('Ошибка сохранения файла: ' + ex.message); }
            };
            document.getElementById('nc-dl').appendChild(a);
            document.getElementById('nc-fst' + i).textContent = '✓ ' + res.srcs.length + ' ист.';
            document.getElementById('nc-fst' + i).className = 'nc-fi-st nc-v';
            document.getElementById('nc-fi' + i).classList.add('nc-ok');
          } catch (ex) {
            log('Ошибка ' + f.name + ': ' + ex.message, 'nc-le');
            document.getElementById('nc-fst' + i).textContent = 'ошибка';
            document.getElementById('nc-fst' + i).className = 'nc-fi-st nc-x';
            document.getElementById('nc-fi' + i).classList.add('nc-err');
          }
          next();
        };
        r.readAsArrayBuffer(f);
      }
      next();
    });
  }
  function _fallbackDl(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }

  // ══════════════════════════════════════════════════════════════════════════
  //  Разметка панели (строится один раз при первом переключении на вкладку)
  // ══════════════════════════════════════════════════════════════════════════
  function _html() {
    return `
<div style="overflow-y:auto;flex:1;min-height:0;padding:16px 20px 28px;display:flex;flex-direction:column;gap:14px">
  <div class="nc-dz" id="nc-dz">
    <span class="nc-dz-icon">📂</span>
    <div class="nc-dz-title">Перетащи файлы сюда</div>
    <div class="nc-dz-hint">или нажми · <b>.XLS / .XLSX / .XLSM</b> · можно несколько</div>
  </div>
  <input type="file" id="nc-file" accept=".xls,.xlsx,.xlsm" multiple style="display:none" onchange="EconConv.init(this.files)">
  <div class="nc-fq" id="nc-fq"><div class="nc-fq-title">📋 Файлы в очереди</div><div id="nc-fl"></div></div>
  <div class="nc-eb" id="nc-eb"></div>

  <div class="nc-ent">
    <div class="nc-ent-label">🏢 Наименование предприятия</div>
    <input type="text" id="nc-ent-name" placeholder="Например: ООО Нефтяная компания" autocomplete="off">
    <div class="nc-ent-hint">Будет записано в тег &lt;NAME_PR&gt; каждой записи XML (необязательно)</div>
  </div>

  <div class="nc-map" id="nc-map">
    <div class="nc-map-hdr">
      <div class="nc-map-title">Сопоставление колонок</div>
      <span class="nc-map-badge" id="nc-mbg"></span>
      <button class="nc-btn" style="margin-left:auto;padding:4px 10px" onclick="EconConv.resetMap()" title="Сбросить к автоопределению">↻</button>
    </div>
    <div class="nc-ent-hint" id="nc-msb" style="margin-bottom:12px"></div>
    <div class="nc-map-grid" id="nc-mg"></div>
  </div>

  <div class="nc-pv" id="nc-pv">
    <div class="nc-pv-hdr"><div class="nc-pv-title">🔍 Предпросмотр</div><div class="nc-pv-cnt" id="nc-pvc"></div></div>
    <div class="nc-pv-scroll"><table class="nc-table"><thead><tr><th>#</th><th>Код</th><th>Наименование</th><th>Тип</th><th>H</th><th>D/Ширина</th><th>X1</th><th>Y1</th><th>ЗВ</th></tr></thead><tbody id="nc-pvb"></tbody></table></div>
  </div>

  <button class="nc-btn nc-btn-green" id="nc-bcv" disabled onclick="EconConv.doConvert()">▶ Конвертировать в XML</button>
  <div class="nc-pw" id="nc-pw"><div class="nc-pw-lbl"><span id="nc-plbl">...</span><span id="nc-ppct">0%</span></div><div class="nc-pw-bar"><div class="nc-pw-fill" id="nc-pf"></div></div></div>
  <div class="nc-log" id="nc-log"></div>
  <div class="nc-stats" id="nc-stats">
    <div class="nc-stat-card"><div class="nc-stat-num" id="nc-ss">—</div><div class="nc-stat-lbl">Источников</div></div>
    <div class="nc-stat-card"><div class="nc-stat-num" id="nc-sz">—</div><div class="nc-stat-lbl">Веществ (ЗВ)</div></div>
    <div class="nc-stat-card"><div class="nc-stat-num" id="nc-sr">—</div><div class="nc-stat-lbl">Строк</div></div>
  </div>
  <div id="nc-dl" class="nc-dl"></div>
  <div class="nc-hint" style="align-self:flex-start">windows-1251 · INTEGRAL XML · УПРЗА Эколог</div>
</div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Инициализация панели (лениво, при первом переключении на вкладку)
  // ══════════════════════════════════════════════════════════════════════════
  let _inited = false;
  function ensureInit() {
    if (_inited) return;
    _inited = true;
    const pane = document.getElementById('nc-pane-ecolog');
    if (!pane) return;
    pane.innerHTML = _html();
    const dz = document.getElementById('nc-dz');
    const fi = document.getElementById('nc-file');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('nc-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('nc-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('nc-over'); init(e.dataTransfer.files); });
    document.getElementById('nc-ent-name').addEventListener('input', function () {
      this.closest('.nc-ent').classList.toggle('nc-filled', this.value.trim().length > 0);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Публичный интерфейс — разметка дёргает обработчики через EconConv.*
  // ══════════════════════════════════════════════════════════════════════════
  window.EconConv = { ensureInit, init, rmFile, resetMap, chMap, doConvert };
})();
