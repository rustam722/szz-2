'use strict';

async function exportCSV() {
  if (!foundParcels.length) return;
  const list = foundParcels;
  if (!list.length) { askNotice('Нет участков для выбранного фильтра'); return; }
  const rows = [[
    '№ п/п', 'Кадастровый номер', 'Кадастровый квартал', 'Адрес',
    'Площадь уточненная', 'Дата присвоения КН', 'Статус',
    'Категория земель', 'Вид разрешенного использования',
    'Форма собственности', 'Кадастровая стоимость',
    'Удельный показатель кад. стоимости',
    'Функциональная зона, согласно утвержденному генплану',
  ]];
  list.forEach((r, i) => rows.push([
    i+1, r.cn, r.kvartal || '', r.addr || '', r.area || '',
    r.date_cn || '', r.status || '', r.cat || '', r.util || '',
    r.ownership || '', r.cad_cost || '', r.cad_unit || '', r.zone || '',
  ]));
  const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g,'""')}"`).join(';')).join('\r\n');
  await _download('data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv),
    `szz_parcels_${_today()}.csv`);
}

async function exportWord() {
  if (!foundParcels.length) return;
  const exportList = foundParcels;
  if (!exportList.length) return;
  if (!window.docx) { askNotice('Библиотека docx загружается, подождите...'); return; }

  const btn = document.getElementById('btn-export-word');
  btn.textContent = '⏳…'; btn.disabled = true;

  try {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            AlignmentType, WidthType, BorderStyle, ShadingType, VerticalAlign,
            PageOrientation } = window.docx;

    const al = getActiveLayer();
    let cLat = 0, cLon = 0;
    if (al && al.poly) {
      cLat = al.poly.reduce((s,p) => s+p[0], 0) / al.poly.length;
      cLon = al.poly.reduce((s,p) => s+p[1], 0) / al.poly.length;
    } else {
      cLat = exportList.reduce((s,p) => s+p.lat, 0) / exportList.length;
      cLon = exportList.reduce((s,p) => s+p.lon, 0) / exportList.length;
    }

    const DIR_ORDER = [
      'На север от объекта','На северо-восток от объекта','На восток от объекта',
      'На юго-восток от объекта','На юг от объекта','На юго-запад от объекта',
      'На запад от объекта','На северо-запад от объекта',
    ];
    const grouped = {};
    DIR_ORDER.forEach(d => grouped[d] = []);

    exportList.forEach(p => {
      const dir = bearingToDir(getBearing(p.lat, p.lon, cLat, cLon));
      grouped[dir].push(p);
    });

    const F = 'Times New Roman', SZ = 20;
    const brd = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
    const borders = { top: brd, bottom: brd, left: brd, right: brd };
    const cm = { top: 55, bottom: 55, left: 100, right: 100 };
    const W = [400, 1700, 2300, 950, 1900, 2700, 1300, 1550, 1500];
    const TW = W.reduce((a,b) => a+b, 0);

    const mkCell = (text, width, opts = {}) => new TableCell({
      borders, width: { size: width, type: WidthType.DXA }, margins: cm,
      verticalAlign: VerticalAlign.CENTER,
      shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
      children: [new Paragraph({
        alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [new TextRun({ text: String(text ?? ''), font: F, size: SZ, bold: opts.bold || false })]
      })]
    });

    const NCOLS = W.length;
    const mkDirRow = text => new TableRow({
      children: [new TableCell({
        borders, columnSpan: NCOLS, width: { size: TW, type: WidthType.DXA },
        margins: { top: 55, bottom: 55, left: 200, right: 100 },
        shading: { fill: 'DEEAF1', type: ShadingType.CLEAR },
        children: [new Paragraph({
          children: [new TextRun({ text, font: F, size: SZ, bold: true, italics: true, color: '1F3864' })]
        })]
      })]
    });

    const HDR = [
      '№ п/п', 'Кадастровый номер', 'Адрес', 'Площадь уточненная',
      'Категория земель', 'Вид разрешенного использования',
      'Форма собственности', 'Кадастровая стоимость',
      'Функц. зона',
    ];
    const rows = [new TableRow({
      tableHeader: true,
      children: HDR.map((h, i) => mkCell(h, W[i], { fill: 'BDD7EE', bold: true, center: true })),
    })];

    let counter = 1;
    for (const dir of DIR_ORDER) {
      const parcels = grouped[dir];
      if (!parcels.length) continue;
      rows.push(mkDirRow(dir));
      for (const p of parcels) {
        rows.push(new TableRow({ children: [
          mkCell(counter++,       W[0], { center: true }),
          mkCell(p.cn,            W[1], { center: true }),
          mkCell(p.addr  || '',   W[2]),
          mkCell(p.area  || '',   W[3], { center: true }),
          mkCell(p.cat   || '',   W[4]),
          mkCell(p.util  || '',   W[5]),
          mkCell(p.ownership || '', W[6]),
          mkCell(p.cad_cost  || '', W[7], { center: true }),
          mkCell(p.zone  || '',   W[8]),
        ]}));
      }
    }

    const table = new Table({ width: { size: TW, type: WidthType.DXA }, columnWidths: W, rows });
    const szzName = al ? al.name : 'СЗЗ';

    const doc = new Document({ sections: [{ properties: { page: {
      size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
      margin: { top: 1134, right: 851, bottom: 1134, left: 1701 },
    }}, children: [
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
        children: [new TextRun({ text: `Перечень земельных участков в границах ${szzName}`, font: F, size: 24, bold: true })]
      }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 },
        children: [new TextRun({ text: `Всего: ${exportList.length} уч. (внутри: ${exportList.filter(p=>p.inP).length}, пересечение: ${exportList.filter(p=>!p.inP).length})`, font: F, size: 20, color: '555555' })]
      }),
      table,
      new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 200 },
        children: [new TextRun({ text: `Дата: ${new Date().toLocaleDateString('ru-RU')}`, font: F, size: 18, italics: true, color: '888888' })]
      }),
    ]}]});

    const blob = await Packer.toBlob(doc);
    const url  = URL.createObjectURL(blob);
    await _download(url, `szz_parcels_${_today()}.docx`);
    URL.revokeObjectURL(url);
    setSt(`Word экспортирован: ${exportList.length} участков`, 'ok');
  } catch(e) {
    console.error('Word export:', e);
    askNotice('Ошибка экспорта: ' + e.message);
  }
  btn.textContent = '⬇ Word'; btn.disabled = false;
}

async function exportGeoJSON() {
  if (!foundParcels.length) return;
  const features = foundParcels
    .filter(p => p.geometry && p.geometry.type && p.geometry.type !== 'Point')
    .map(p => ({
      type: 'Feature',
      geometry: p.geometry,
      properties: {
        cn:        p.cn        || '',
        address:   p.addr      || '',
        area:      p.area      || '',
        category:  p.cat       || '',
        use:       p.util      || '',
        ownership: p.ownership || '',
        cad_cost:  p.cad_cost  || '',
        cad_unit:  p.cad_unit  || '',
        date_cn:   p.date_cn   || '',
        status:    p.status    || '',
        zone:      p.zone      || '',
        position:  p.inP ? 'inside' : 'cross',
      },
    }));

  if (!features.length) {
    askNotice('Нет участков с геометрией для экспорта границ');
    return;
  }

  const fc = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
  await _download(
    'data:application/geo+json;charset=utf-8,' + encodeURIComponent(fc),
    `szz_parcels_${_today()}.geojson`
  );
}

async function _download(href, filename) {
  // В pywebview браузерные загрузки заблокированы — передаём данные через Python API
  if (window.pywebview && window.pywebview.api) {
    try {
      let b64;
      if (href.startsWith('blob:')) {
        const buf   = await (await fetch(href)).arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK)
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        b64 = btoa(bin);
      } else if (href.startsWith('data:')) {
        const meta    = href.split(',')[0];
        const rawData = href.split(',').slice(1).join(',');
        if (meta.endsWith(';base64')) {
          b64 = rawData;
        } else {
          // URL-encoded текст → UTF-8 байты → base64
          const text  = decodeURIComponent(rawData);
          const bytes = new TextEncoder().encode(text);
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK)
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          b64 = btoa(bin);
        }
      }
      await window.pywebview.api.save_file(filename, b64);
    } catch(e) {
      console.error('pywebview save_file error:', e);
      askNotice('Ошибка сохранения: ' + e.message);
    }
    return;
  }
  // Обычный браузер
  const a = document.createElement('a');
  a.href = href; a.download = filename; a.click();
}

function _today() {
  return new Date().toISOString().slice(0,10);
}
