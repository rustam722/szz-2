// ═══════════════════════════════════════════════════════════════════════════
//  Оценка риска здоровью населения (Р 2.1.10.3968-23)
//  ---------------------------------------------------------------------------
//  Перенесено из отдельной программы risk_app (templates/index.html + app.py).
//  Расчётная логика (HQ/HI/CR/TW/Wc, канонизация органов) не менялась —
//  перенесена как есть. Изменения при переносе:
//   • SERVER → RISK_API, читается из window.APP_CONFIG.riskApi (тот же приём,
//     что и у LOCAL_PROXY в js/search.js) — Flask risk_server теперь поднят
//     как отдельный поток внутри самого СЗЗ-Инструмента, на своём порту.
//   • Разметка и REFDB/health не грузятся на старте приложения, а строятся
//     один раз при первом входе в режим (enterRiskMode), по образцу
//     enterPdfMode()/_buildEditorUI() в pdf-editor.js.
//   • Скачивание файлов (шаблон Excel, экспорт Excel, экспорт Word) идёт
//     через _download() из export.js — под pywebview обычные a.click()
//     скачивания не работают (браузерные загрузки заблокированы), а
//     _download() уже умеет blob: через нативный диалог сохранения.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const RISK_API = (window.APP_CONFIG && window.APP_CONFIG.riskApi) || 'http://127.0.0.1:5000';

  // REFDB — загружается с сервера один раз при первом входе в режим
  let REFDB = {};

  // ══════════════════════════════════════════════════════════════════════════
  //  СОСТОЯНИЕ
  // ══════════════════════════════════════════════════════════════════════════
  const st = {
    subs: [],   // заполняется автоматически после загрузки файлов
    cmax:      {},   // {kodStr: {ptStr: val}}
    cavg:      {},   // {kodStr: {ptStr: val}}
    emissions: {},   // {kodStr: val}
    pts_acu:   [],
    pts_chr:   [],
    population: '', // численность населения P (для HRi = E×TW×P/10000)
    pts_xy:    {},  // {номер точки: {x,y,h,type}} — координаты из выгрузки УПРЗА
    pts_by_file: { zima: {}, leto: {}, sred: {} },  // {точка: число веществ} по каждому файлу
    raw_zima: {}, raw_leto: {}, raw_sred: {},  // {kodStr: {ptStr: val}} — сырые значения по файлам
  };
  const _expandedPts = new Set();  // какие точки раскрыты в таблице «РТ по файлам»

  const files = { zima: null, leto: null, sred: null };


  // ══════════════════════════════════════════════════════════════════════════
  //  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
  // ══════════════════════════════════════════════════════════════════════════
  // Экспоненциальный формат — для концентраций и HQ
  function fmt(v, digits=2) {
    if (v === null || v === undefined || isNaN(v) || v === '') return '—';
    if (v === 0) return '0.00E+00';
    return v.toExponential(digits).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2');
  }
  // Обычный формат — для ARFCi, RFC, HRI, выбросов, %
  function fmtR(v) {
    if (v === null || v === undefined || v === '' || isNaN(+v)) return '—';
    const n = +v;
    if (n === 0) return '0';
    if (Number.isInteger(n)) return String(n);
    return parseFloat(n.toPrecision(5)).toString();
  }
  // Форматирование процентов: >= 0.1% → 1 знак; 0.01–0.1% → 2 знака; < 0.01% → 3 знака
  function fmtPct(pct) {
    if (pct === null || pct === undefined || isNaN(pct)) return '—%';
    if (pct === 0) return '0.0%';
    if (pct >= 0.1) return pct.toFixed(1) + '%';
    if (pct >= 0.01) return pct.toFixed(2) + '%';
    return pct.toFixed(3) + '%';
  }
  // парсим число из строки — понимает и 0.018 и 1.8E-02 и 1,8E-02
  function pf(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
  }
  function clamp0(v) { return (v === null || isNaN(v)) ? 0 : Math.max(0, v); }

  // Таблицы рендерятся через innerHTML целиком — если в перестраиваемой
  // разметке живёт само редактируемое поле (ARFCi/RFC в таблицах «Острые МР»/
  // «Хронические СР», численность населения), оно пересоздаётся на каждую
  // цифру: фокус слетает, и приходится кликать в поле заново. Помечаем такие
  // поля атрибутом data-rk и после перерисовки возвращаем фокус и курсор —
  // в конец значения, т.к. type="number" не отдаёт selectionStart/End (всегда
  // null), и без explicit восстановления курсор после focus() уезжает в начало.
  function _keepFocusAcrossRerender(renderFn) {
    const active = document.activeElement;
    const key = (active && active.tagName === 'INPUT' && active.dataset) ? active.dataset.rk : null;
    renderFn();
    if (!key) return;
    const newInp = document.querySelector(`input[data-rk="${key}"]`);
    if (!newInp) return;
    newInp.focus();
    const t = newInp.type;
    newInp.type = 'text';
    try { newInp.setSelectionRange(newInp.value.length, newInp.value.length); } catch(e) {}
    newInp.type = t;
  }

  function getSub(kodStr) { return st.subs.find(s => String(s.kod) === kodStr); }
  function getArfci(kodStr) { const s = getSub(kodStr); return s ? pf(s.arfci) : null; }
  function getRfc(kodStr)   { const s = getSub(kodStr); return s ? pf(s.rfc)   : null; }
  // Канонические имена критических органов/систем.
  // Справочники пишут одно и то же по-разному ("Нервная сист." в CAS-базе против
  // "Нервная система" в таблице кодов) — без приведения к общему виду один орган
  // даёт две строки HI, и обе заниженные.
  const ORGAN_ALIASES = {
    'органы дыхания': 'Органы дыхания', 'орг. дыхания': 'Органы дыхания',
    'дыхательная система': 'Органы дыхания',
    'цнс': 'ЦНС', 'центральная нервная система': 'ЦНС',
    'нервная система': 'Нервная система', 'нервная сист': 'Нервная система',
    'нервная': 'Нервная система',
    'ссс': 'ССС', 'сердечно-сосудистая система': 'ССС', 'серд.-сос. сист': 'ССС',
    'серд.-сос. система': 'ССС', 'сердечно-сосудистая сист': 'ССС',
    'кровь': 'Кровь', 'кровеносная система': 'Кровь', 'система крови': 'Кровь',
    'системное': 'Системное действие', 'системное действие': 'Системное действие',
    'системное воздействие': 'Системное действие',
    'зубы': 'Зубы', 'печень': 'Печень', 'почки': 'Почки', 'глаза': 'Глаза',
    'развитие': 'Развитие', 'смертность': 'Смертность', 'жкт': 'ЖКТ',
    'костная система': 'Костная система', 'костная сист': 'Костная система',
    'иммунная система': 'Иммунная система', 'иммунная сист': 'Иммунная система',
    'репродуктивная система': 'Репродуктивная система',
    'репродуктивная сист': 'Репродуктивная система',
    'эндокринная система': 'Эндокринная система', 'эндокринная сист': 'Эндокринная система',
    'масса тела': 'Масса тела', 'кожа': 'Кожа',
    'гормональная система': 'Гормональная система',
  };
  function canonOrgan(raw) {
    if (!raw) return '';
    // отбрасываем уточнения в скобках: "Кровь (образование methb)" → "Кровь"
    let s = String(raw).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/[.\s]+$/, '');
    if (!s || s === '-' || s === '—') return '';
    const key = s.toLowerCase().replace(/ё/g, 'е').replace(/[.\s]+$/, '');
    if (ORGAN_ALIASES[key]) return ORGAN_ALIASES[key];
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // Разбирает поле органа в массив канонических имён: "ЦНС, развитие" → ['ЦНС','Развитие'].
  // Запятые внутри скобок разделителями не считаются.
  function getOrgans(str) {
    if (!str) return [];
    const parts = [];
    let buf = '', depth = 0;
    for (const ch of String(str)) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if ((ch === ',' || ch === ';') && depth === 0) { parts.push(buf); buf = ''; }
      else buf += ch;
    }
    parts.push(buf);
    const out = [];
    parts.forEach(p => {
      const c = canonOrgan(p);
      if (c && !out.includes(c)) out.push(c);
    });
    return out;
  }

  function hqAcu(kodStr, ptStr) {
    const arfci = getArfci(kodStr);
    if (!arfci) return null;
    const c = pf(st.cmax[kodStr]?.[ptStr]);
    return (c === null || isNaN(c)) ? null : c / arfci;
  }
  function hqChr(kodStr, ptStr) {
    const rfc = getRfc(kodStr);
    if (!rfc) return null;
    const c = pf(st.cavg[kodStr]?.[ptStr]);
    return (c === null || isNaN(c) || c === 0) ? 0 : c / rfc;
  }
  function maxHqAcu(kodStr) {
    return Math.max(0, ...st.pts_acu.map(pt => hqAcu(kodStr, String(pt)) ?? 0));
  }
  function maxHqChr(kodStr) {
    return Math.max(0, ...st.pts_chr.map(pt => hqChr(kodStr, String(pt)) ?? 0));
  }
  // HI по органу. Индекс опасности аддитивен ВНУТРИ расчётной точки: сначала
  // суммируем HQ всех веществ в точке, потом берём максимум по точкам. Сумма
  // максимумов, взятых из разных точек, дала бы HI, которого нет ни в одной точке.
  function hiOrganAt(organ, pt, mode) {
    const acu  = mode === 'acu';
    const key  = acu ? 'organ_acu' : 'organ_chr';
    const parm = acu ? 'arfci' : 'rfc';
    const hqFn = acu ? hqAcu : hqChr;
    return st.subs
      .filter(s => !s.skip_risk && pf(s[parm]) && getOrgans(s[key]).includes(organ))
      .reduce((sum, s) => sum + (hqFn(String(s.kod), String(pt)) || 0), 0);
  }
  function hiOrganMax(organ, mode) {
    const pts = mode === 'acu' ? st.pts_acu : st.pts_chr;
    return Math.max(0, ...pts.map(pt => hiOrganAt(organ, pt, mode)));
  }
  // Точка, в которой HI по органу максимален, — в ней и считаем вклады веществ,
  // иначе проценты не сложатся в 100 %.
  function hiOrganArgmax(organ, mode) {
    const pts = mode === 'acu' ? st.pts_acu : st.pts_chr;
    let best = null, bv = -1;
    pts.forEach(pt => { const v = hiOrganAt(organ, pt, mode); if (v > bv) { bv = v; best = pt; } });
    return best;
  }
  // Вклад вещества в HI по органу (в точке максимума HI), %
  function hqAtHiMax(kodStr, organ, mode) {
    const pt = hiOrganArgmax(organ, mode);
    if (pt === null) return 0;
    return (mode === 'acu' ? hqAcu : hqChr)(kodStr, String(pt)) || 0;
  }
  function hiOrgan(organ) { return hiOrganMax(organ, 'chr'); }
  // TW — весовой коэффициент влияния на здоровье, табл. 3.7 Р 2.1.10.3968-23
  // (в отчётах её нумеруют «таблица 4»; шкала по RfC, мг/м³, — не путать со
  // шкалой по RfD, мг/кг)
  function getTW(rfc) {
    if (!rfc || rfc <= 0) return 0;
    if (rfc > 1.75)     return 1;
    if (rfc > 0.175)    return 10;
    if (rfc > 0.0175)   return 100;
    if (rfc > 0.00175)  return 1000;
    if (rfc > 0.000175) return 10000;
    return 100000;
  }
  // HRi неканц. = E × TW × P / 10000  (Р 2.1.10.3968-23, раздел 1.7)
  function hri(kodStr) {
    const rfc = getRfc(kodStr);
    const em  = pf(st.emissions[kodStr]);
    const P   = pf(st.population) || 0;
    if (!rfc || !em || !P) return 0;
    return em * getTW(rfc) * P / 10000;
  }
  function totalHri() {
    return st.subs.filter(s => pf(s.rfc) !== null && !s.skip_risk).reduce((s, sub) => s + hri(String(sub.kod)), 0);
  }

  // ── Канцерогенный риск ────────────────────────────────────────────────────
  // CR_i(pt) = LADD × SFi = Cavg_i(pt) × URi   (индивидуальный канцерогенный риск)
  // URi (мг/м³)⁻¹ = SFi (мг/(кг·сут))⁻¹ × IR/BW = SFi × 20/70 = SFi / 3.5
  //   (Р 2.1.10.3968-23: масса тела 70 кг, суточное потребление воздуха 20 м³)
  // PCR = CR × P                                (популяционный)
  const BW_IR = 3.5;  // BW/IR = 70 кг / 20 м³·сут⁻¹
  // Единичный риск: берём готовый URi, иначе выводим из SFi
  function getUri(kodStr) {
    const s = getSub(kodStr);
    if (!s) return null;
    const ur = pf(s.uri_r);
    if (ur) return ur;
    const sfi = pf(s.uri);          // поле 'uri' хранит SFi
    return sfi ? sfi / BW_IR : null;
  }
  function crVal(kodStr, pt) {
    const uri = getUri(kodStr);
    if (!uri) return null;
    const c = pf((st.cavg[kodStr] || {})[String(pt)]);
    return (c != null) ? c * uri : null;
  }
  function crMax(kodStr) {
    if (!st.pts_chr.length) return null;
    const vals = st.pts_chr.map(p => crVal(kodStr, p)).filter(v => v != null);
    return vals.length ? Math.max(...vals) : null;
  }
  function crLevel(cr) {
    if (cr === null) return '';
    if (cr <= 1e-6)  return 'Минимальный';
    if (cr <= 1e-4)  return 'Допустимый';
    if (cr <= 1e-3)  return 'Настораживающий';
    return 'Высокий';
  }
  function crLevelColor(cr) {
    if (cr === null) return '';
    if (cr <= 1e-6)  return 'var(--cr-ok)';
    if (cr <= 1e-4)  return 'var(--cr-ok)';
    if (cr <= 1e-3)  return 'var(--cr-warn)';
    return 'var(--cr-high)';
  }

  // Обновляет SFi только если значение непустое (защита от исчезновения панели).
  // Ручной ввод SFi сбрасывает справочный URi — иначе правка не повлияла бы на CR.
  function updSubSfi(i, val) {
    if (val === '' || pf(val) === null) return;
    st.subs[i].uri_r = '';
    updSub(i, 'uri', val);
  }

  function renderCancer() {
    const CANC = st.subs.filter(s => getUri(String(s.kod)) && !s.skip_risk);
    if (!CANC.length) return '';

    const pts = st.pts_chr;
    const P   = pf(st.population) || 0;

    let h = `<h3 style="margin:28px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#7c3aed">
      Канцерогенный риск (CR = Cavg × URi,&nbsp; URi = SFi / 3.5)
    </h3>`;

    h += '<table class="rtable"><thead>';
    h += '<tr class="th1"><th rowspan="3">№ точки</th>';
    CANC.forEach(s => {
      h += `<th colspan="2" style="background:var(--th-sub)">${s.name || s.kod}<br><small>код ${s.kod}</small></th>`;
    });
    h += '<th colspan="2" rowspan="2" style="background:var(--th-sub-tot)">CR суммарный<br>ΣCRi</th></tr>';

    h += '<tr class="th2">';
    CANC.forEach(s => {
      const uriShown = getUri(String(s.kod));
      h += `<th>Cavg,<br>мг/м³</th>
            <th>CR = Cavg×URi<br>SFi=<input class="td-rfc" type="number" step="any" value="${s.uri||''}"
              onchange="RiskApp.updSubSfi(${st.subs.indexOf(s)}, this.value)"
              style="width:60px;background:var(--yel);border:1px solid var(--yel-b);border-radius:3px;padding:1px 4px;font-size:11px;text-align:center">
            <br><small style="font-weight:400">URi=${uriShown != null ? fmtR(uriShown) : '—'}</small></th>`;
    });
    h += '</tr>';
    h += '<tr class="th2">';
    CANC.forEach(() => { h += '<th>мг/м³</th><th>б/р</th>'; });
    h += '<th>б/р</th><th>Уровень риска</th></tr>';
    h += '</thead><tbody>';

    let maxCrTotal = 0;
    pts.forEach(pt => {
      const crTot = CANC.reduce((sum, s) => {
        const v = crVal(String(s.kod), pt);
        return sum + (v ?? 0);
      }, 0);
      if (crTot > maxCrTotal) maxCrTotal = crTot;
      const bg = crLevelColor(crTot || null);
      h += `<tr style="${bg ? 'background:'+bg : ''}">
        <td><b>${pt}</b></td>`;
      CANC.forEach(s => {
        const ks = String(s.kod);
        const c = pf((st.cavg[ks] || {})[String(pt)]);
        const cr = crVal(ks, pt);
        h += `<td class="td-inp"><input type="text" value="${c ?? ''}" placeholder="—"
                style="width:80px;border:none;background:transparent;text-align:center;font-size:12px"
                onchange="RiskApp.setCavg('${ks}','${pt}',this.value,0)">
              </td>
              <td class="td-calc">${cr != null ? fmt(cr) : '—'}</td>`;
      });
      h += `<td class="td-calc" style="font-weight:700">${crTot ? fmt(crTot) : '—'}</td>
            <td style="font-size:11px;font-weight:600">${crLevel(crTot || null)}</td>
          </tr>`;
    });

    h += `<tr class="td-max">
      <td class="td-max"><b>MAX (СЗЗ)</b></td>`;
    CANC.forEach(s => {
      const cm = crMax(String(s.kod));
      h += `<td class="td-max">—</td><td class="td-max"><b>${cm != null ? fmt(cm) : '—'}</b></td>`;
    });
    h += `<td class="td-max"><b>${maxCrTotal ? fmt(maxCrTotal) : '—'}</b></td>
          <td class="td-max" style="font-size:11px;font-weight:700">${crLevel(maxCrTotal || null)}</td>
        </tr>`;

    if (P) {
      const pcr = maxCrTotal * P;
      h += `<tr style="background:var(--pcr-row)">
        <td colspan="${1 + CANC.length*2}" style="text-align:right;font-size:12px">
          <b>PCR = CR_max × P = ${fmt(maxCrTotal)} × ${P} = ${fmt(pcr)} случаев</b>
        </td>
        <td colspan="2"></td>
      </tr>`;
    }

    const cancOrgs = [...new Set(CANC.flatMap(s => getOrgans(s.organ_chr)))];
    if (cancOrgs.length) {
      cancOrgs.forEach(org => {
        const hi = hiOrganMax(org, 'chr');
        h += `<tr><td class="td-pt" style="background:var(--organ)"></td>`;
        CANC.forEach(s => {
          if (getOrgans(s.organ_chr).includes(org)) {
            const subHq = hqAtHiMax(String(s.kod), org, 'chr');
            const pct   = hi > 0 ? (subHq / hi * 100) : 0;
            h += `<td class="td-organ" colspan="2"><b>${org}</b>&nbsp;&nbsp;HI = ${fmt(hi)}&nbsp;&nbsp;(${fmtPct(pct)})</td>`;
          } else {
            h += `<td colspan="2"></td>`;
          }
        });
        h += `<td colspan="2"></td></tr>`;
      });
    }

    h += '</tbody></table>';
    return h;
  }

  // Таблица HI по критическим органам по расчётным точкам (табл. 25/29 отчёта)
  function renderOrgansPerPoint(mode, subsOverride) {
    const orgKey = mode === 'acu' ? 'organ_acu' : 'organ_chr';
    const hqFn   = mode === 'acu' ? hqAcu : hqChr;
    const allSubs = subsOverride || st.subs;
    const subs   = allSubs.filter(s => pf(mode === 'acu' ? s.arfci : s.rfc));
    const getSubOrgans = s => { const o = getOrgans(s[orgKey]); return o.length ? o : ['Не определён']; };
    const organs = [...new Set(subs.flatMap(getSubOrgans))];
    const pts    = mode === 'acu' ? st.pts_acu : st.pts_chr;
    if (!subs.length || !pts.length) return '';

    const hiAt = (org, pt) =>
      subs.filter(s => getSubOrgans(s).includes(org))
          .reduce((sum, s) => sum + (hqFn(String(s.kod), String(pt)) || 0), 0);
    const maxHi = org => Math.max(0, ...pts.map(pt => hiAt(org, pt)));
    const argMaxPt = org => {
      let best = null, bv = -1;
      pts.forEach(pt => { const v = hiAt(org, pt); if (v > bv) { bv = v; best = pt; } });
      return best;
    };

    let h = `<div style="margin-top:24px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px">
        HI по критическим органам — по расчётным точкам
      </div>
      <table class="rtable"><thead>
      <tr><th class="td-pt">Точка</th>`;
    organs.forEach(o => { h += `<th style="min-width:90px">${o}</th>`; });
    h += `</tr></thead><tbody>`;

    pts.forEach(pt => {
      h += `<tr><td class="td-pt">${pt}</td>`;
      organs.forEach(o => {
        const v = hiAt(o, pt);
        h += `<td class="td-calc">${v > 0 ? fmt(v) : '—'}</td>`;
      });
      h += `</tr>`;
    });

    h += `<tr><td class="td-pt td-max sep" style="border-top:2px solid #94a3b8">СЗЗ MAX</td>`;
    organs.forEach(o => {
      const mx = maxHi(o);
      h += `<td class="td-max sep"><b>${mx > 0 ? fmt(mx) : '—'}</b></td>`;
    });
    h += `</tr></tbody></table>`;

    const sorted = organs.slice().sort((a, b) => maxHi(b) - maxHi(a));
    h += `<div style="margin-top:14px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:6px">
        HI макс по критическим органам (на границе СЗЗ)
      </div>
      <table class="rank-table"><thead><tr>
        <th style="width:40px">Ранг</th>
        <th style="min-width:140px;text-align:left">Критический орган/система</th>
        <th style="width:130px">HI макс (СЗЗ)</th>
      </tr></thead><tbody>`;
    sorted.forEach((o, idx) => {
      const mx = maxHi(o);
      h += `<tr>
        <td style="font-weight:700;color:var(--blue)">${idx + 1}</td>
        <td><b>${o}</b></td>
        <td class="td-calc">${mx > 0 ? fmt(mx) : '—'}</td>
      </tr>`;
    });
    h += `</tbody></table></div>`;

    h += `<div style="margin-top:18px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px">
        Вклад веществ по критическим органам (на границе СЗЗ)
      </div>`;
    sorted.forEach(org => {
      const hiOrg = maxHi(org);
      if (hiOrg <= 0) return;
      const ptMax = argMaxPt(org);
      const subsForOrg = subs
        .filter(s => getSubOrgans(s).includes(org))
        .map(s => ({ s, hqMax: (ptMax === null ? 0 : hqFn(String(s.kod), String(ptMax)) || 0) }))
        .filter(({ hqMax }) => hqMax > 0)
        .sort((a, b) => b.hqMax - a.hqMax);
      if (!subsForOrg.length) return;
      h += `<div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--blue);margin-bottom:4px">
          ${org} &nbsp;—&nbsp; HI = ${fmt(hiOrg)} &nbsp;<span style="font-weight:400;color:var(--muted)">(точка ${ptMax})</span>
        </div>
        <table class="rank-table"><thead><tr>
          <th style="width:40px">Ранг</th>
          <th style="min-width:160px;text-align:left">Вещество</th>
          <th style="width:110px">HQ в точке ${ptMax}</th>
          <th style="width:90px">Вклад, %</th>
        </tr></thead><tbody>`;
      subsForOrg.forEach(({ s, hqMax }, idx) => {
        const pct = hqMax / hiOrg * 100;
        h += `<tr>
          <td style="font-weight:700;color:var(--blue)">${idx + 1}</td>
          <td><b>${s.name || s.kod}</b> <small style="color:var(--muted)">код ${s.kod}</small></td>
          <td class="td-calc">${fmt(hqMax)}</td>
          <td class="td-calc">${fmtPct(pct)}</td>
        </tr>`;
      });
      h += `</tbody></table></div>`;
    });
    h += `</div></div>`;
    return h;
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  РЕНДЕР КОНФИГУРАЦИИ ВЕЩЕСТВ
  // ══════════════════════════════════════════════════════════════════════════
  function renderConfig() {
    const body = document.getElementById('cfgBody');
    if (!body) return;
    const inp = (i, key, w, placeholder='—', cls='') =>
      `<input value="${st.subs[i][key]??''}" placeholder="${placeholder}"
        style="width:${w}" oninput="RiskApp.updSub(${i},'${key}',this.value)" class="${cls}">`;
    body.innerHTML = st.subs.map((s, i) => `
      <tr>
        <td style="text-align:center">
          <button class="btn-del" onclick="RiskApp.delSub(${i})" title="Удалить">×</button>
        </td>
        <td>${inp(i,'kod','58px','','')}</td>
        <td class="td-name">${inp(i,'name','100%','')}</td>
        <td><input value="${s.cas??''}" placeholder="—"
          style="width:82px" oninput="RiskApp.updSub(${i},'cas',this.value);RiskApp.casLookup(${i},this.value)">
        </td>
        <td>${inp(i,'pdk_mr','62px')}</td>
        <td>${inp(i,'pdk_ss','62px')}</td>
        <td>${inp(i,'pdk_sg','62px')}</td>
        <td>${inp(i,'pdk_obv','62px')}</td>
        <td>${inp(i,'hazard_class','38px')}</td>
        <td class="td-yel">${inp(i,'arfci','82px','')}</td>
        <td class="td-yel">${inp(i,'rfc','72px','')}</td>
        <td class="td-yel">${inp(i,'uri','72px','')}</td>
        <td>${inp(i,'organ_acu','100px')}</td>
        <td>${inp(i,'organ_chr','100px')}</td>
        <td style="text-align:center">
          <input type="checkbox" title="Учитывать только выброс т/год, не включать в расчёт рисков"
            ${s.skip_risk ? 'checked' : ''}
            onchange="RiskApp.updSub(${i},'skip_risk',this.checked)">
        </td>
      </tr>`).join('');
  }

  function updSub(i, key, val) {
    if (key === 'kod') st.subs[i][key] = parseInt(val) || val;
    else if (key === 'skip_risk') st.subs[i][key] = !!val;
    else st.subs[i][key] = val;
    if (['arfci','rfc','uri','organ_acu','organ_chr','skip_risk'].includes(key)) _keepFocusAcrossRerender(refreshTables);
  }
  function delSub(i) { st.subs.splice(i,1); renderConfig(); refreshTables(); }
  // fallback по умолчанию '' — как в исходной таблице «Хронические СР»;
  // таблица «Канц. риск» в оригинале на пустое значение писала 0, а не '' —
  // сохраняем это различие явным параметром, иначе отображение пустой
  // ячейки после очистки отличалось бы от исходного поведения
  function setCavg(ks, pt, val, emptyFallback) {
    if (!st.cavg[ks]) st.cavg[ks] = {};
    st.cavg[ks][pt] = pf(val) ?? (emptyFallback !== undefined ? emptyFallback : '');
    refreshTables();
  }
  function setCmax(ks, pt, val) {
    if (!st.cmax[ks]) st.cmax[ks] = {};
    st.cmax[ks][pt] = pf(val) ?? '';
    refreshTables();
  }
  function setEmission(ks, val) { st.emissions[ks] = pf(val) ?? ''; refreshTables(); }
  function setPopulation(val) { st.population = val; _keepFocusAcrossRerender(renderRank); }

  // Автозаполнение RFC/ARFCi/SFi по CAS из П1.2+П1.3+П1.4 Р 2.1.10.3968-23
  function casLookup(i, cas) {
    cas = (cas || '').trim();
    if (!cas || !/^\d+-\d+-\d+$/.test(cas)) return;
    fetch(RISK_API + '/api/cas-lookup?cas=' + encodeURIComponent(cas))
      .then(r => r.json()).then(d => {
        if (!d || !Object.keys(d).length) return;
        let changed = false;
        const s = st.subs[i];
        if (!s.rfc   && d.rfc   != null) { s.rfc   = String(d.rfc);   changed = true; }
        if (!s.arfci && d.arfci != null) { s.arfci = String(d.arfci); changed = true; }
        if (!s.uri   && d.sfi   != null) { s.uri   = String(d.sfi);   changed = true; }
        if (!s.uri_r && d.uri   != null) { s.uri_r = String(d.uri);   changed = true; }
        if (!s.organ_chr && d.organ_chr) { s.organ_chr = getOrgans(d.organ_chr).join(', '); changed = true; }
        if (!s.organ_acu && d.organ_acu) { s.organ_acu = getOrgans(d.organ_acu).join(', '); changed = true; }
        if (!s.iarc && d.iarc) { s.iarc = d.iarc; changed = true; }
        if (!s.epa  && d.epa)  { s.epa  = d.epa;  changed = true; }
        if (changed) { renderConfig(); refreshTables(); }
      }).catch(() => {});
  }
  function addSubRow() {
    st.subs.push({kod:'', name:'', cas:'', pdk_mr:'', pdk_ss:'', pdk_sg:'', pdk_obv:'', hazard_class:'',
                  arfci:'', rfc:'', uri:'', uri_r:'', organ_acu:'', organ_chr:'', lim:'', iarc:'', epa:'', skip_risk: false});
    renderConfig();
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  РЕНДЕР ТАБЛИЦЫ «ОСТРЫЕ МР»
  // ══════════════════════════════════════════════════════════════════════════
  function renderAcute() {
    const el = document.getElementById('tableAcute');
    if (!el) return;
    const ACUTE = st.subs.filter(s => pf(s.arfci) !== null && !s.skip_risk);
    if (!ACUTE.length && !st.pts_acu.length) { el.innerHTML='<p style="padding:16px;color:var(--muted)">Нет веществ с ARFCi или не загружены файлы.</p>'; return; }

    const pts = st.pts_acu.length ? st.pts_acu : [];
    let h = '<table class="rtable"><thead>';

    h += '<tr><th rowspan="2" class="td-pt">Точка</th>';
    ACUTE.forEach(s => {
      h += `<th colspan="2">Код ${s.kod} — ${s.name}</th><th></th>`;
    });
    h += '</tr>';

    h += '<tr class="th2">';
    ACUTE.forEach(s => {
      h += `<th>Cmax, мг/м³</th>
            <th>HQ = Cmax/ARFCi<br>ARFCi = <input class="td-rfc" type="number" step="any" value="${s.arfci||''}"
              data-rk="arfci-${st.subs.indexOf(s)}"
              oninput="RiskApp.updSub(${st.subs.indexOf(s)},'arfci',this.value)"
              style="width:60px;background:var(--yel);border:1px solid var(--yel-b);border-radius:3px;padding:1px 4px;font-size:11px;text-align:center">
            </th><th></th>`;
    });
    h += '</tr></thead><tbody>';

    pts.forEach(pt => {
      h += `<tr><td class="td-pt">${pt}</td>`;
      ACUTE.forEach(s => {
        const ks = String(s.kod);
        const raw = st.cmax[ks]?.[String(pt)];
        const cv  = (raw !== undefined && raw !== null && raw !== '') ? fmt(pf(raw)) : '';
        const hq  = hqAcu(ks, String(pt));
        h += `<td class="td-inp"><input type="text" value="${cv}" placeholder="—"
                onchange="RiskApp.setCmax('${ks}','${pt}',this.value)"
              ></td>
              <td class="td-calc">${fmt(hq)}</td>
              <td></td>`;
      });
      h += '</tr>';
    });

    h += `<tr><td class="td-pt td-max sep" style="border-top:2px solid #94a3b8">СЗЗ MAX</td>`;
    ACUTE.forEach(s => {
      const mx = maxHqAcu(String(s.kod));
      h += `<td class="td-max sep"></td><td class="td-max sep"><b>${fmt(mx)}</b></td><td class="sep"></td>`;
    });
    h += '</tr>';

    const hiOrganAcu = org => hiOrganMax(org, 'acu');
    const organs = [...new Set(ACUTE.flatMap(s => getOrgans(s.organ_acu)))];
    organs.forEach(org => {
      const hi = hiOrganAcu(org);
      h += `<tr><td class="td-pt" style="background:var(--organ)"></td>`;
      ACUTE.forEach(s => {
        if (getOrgans(s.organ_acu).includes(org)) {
          const subHq = hqAtHiMax(String(s.kod), org, 'acu');
          const pct   = hi > 0 ? (subHq / hi * 100) : 0;
          h += `<td class="td-organ" colspan="2"><b>${org}</b>&nbsp;&nbsp;HI = ${fmt(hi)}&nbsp;&nbsp;(${fmtPct(pct)})</td><td></td>`;
        } else {
          h += `<td></td><td></td><td></td>`;
        }
      });
      h += '</tr>';
    });

    h += '</tbody></table>';
    el.innerHTML = h + renderOrgansPerPoint('acu');
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  РЕНДЕР ТАБЛИЦЫ «ХРОНИЧЕСКИЕ СР»
  // ══════════════════════════════════════════════════════════════════════════
  function renderChronic() {
    const el = document.getElementById('tableChronic');
    if (!el) return;
    const CHRON = st.subs.filter(s => pf(s.rfc) !== null && !s.skip_risk);
    if (!CHRON.length && !st.pts_chr.length) { el.innerHTML='<p style="padding:16px;color:var(--muted)">Нет веществ с RFC или не загружены файлы.</p>'; return; }

    const pts = st.pts_chr.length ? st.pts_chr : [];
    let h = '<table class="rtable"><thead>';

    h += '<tr><th rowspan="2" class="td-pt">Точка</th>';
    CHRON.forEach(s => {
      h += `<th colspan="2">Код ${s.kod} — ${s.name}</th><th></th>`;
    });
    h += '</tr>';

    h += '<tr class="th2">';
    CHRON.forEach(s => {
      h += `<th>Cavg, мг/м³</th>
            <th>HQ = Cavg/RFC<br>RFC = <input class="td-rfc" type="number" step="any" value="${s.rfc||''}"
              data-rk="rfc-${st.subs.indexOf(s)}"
              oninput="RiskApp.updSub(${st.subs.indexOf(s)},'rfc',this.value)"
              style="width:55px;background:var(--yel);border:1px solid var(--yel-b);border-radius:3px;padding:1px 4px;font-size:11px;text-align:center">
            </th><th></th>`;
    });
    h += '</tr></thead><tbody>';

    pts.forEach(pt => {
      h += `<tr><td class="td-pt">${pt}</td>`;
      CHRON.forEach(s => {
        const ks  = String(s.kod);
        const raw = st.cavg[ks]?.[String(pt)];
        const cv  = (raw !== undefined && raw !== null && raw !== '') ? fmt(pf(raw)) : '';
        const hq  = hqChr(ks, String(pt));
        h += `<td class="td-inp"><input type="text" value="${cv}" placeholder="—"
                onchange="RiskApp.setCavg('${ks}','${pt}',this.value)"
              ></td>
              <td class="td-calc">${fmt(hq)}</td>
              <td></td>`;
      });
      h += '</tr>';
    });

    h += `<tr><td class="td-pt td-max sep" style="border-top:2px solid #94a3b8">СЗЗ MAX</td>`;
    CHRON.forEach(s => {
      const mx = maxHqChr(String(s.kod));
      h += `<td class="td-max sep"></td><td class="td-max sep"><b>${fmt(mx)}</b></td><td class="sep"></td>`;
    });
    h += '</tr>';

    const organs = [...new Set(CHRON.flatMap(s => getOrgans(s.organ_chr)))];
    organs.forEach(org => {
      const hi = hiOrgan(org);
      h += `<tr><td class="td-pt" style="background:var(--organ)"></td>`;
      CHRON.forEach(s => {
        if (getOrgans(s.organ_chr).includes(org)) {
          const subHq = hqAtHiMax(String(s.kod), org, 'chr');
          const pct   = hi > 0 ? (subHq / hi * 100) : 0;
          h += `<td class="td-organ" colspan="2"><b>${org}</b>&nbsp;&nbsp;HI = ${fmt(hi)}&nbsp;&nbsp;(${fmtPct(pct)})</td><td></td>`;
        } else {
          h += `<td></td><td></td><td></td>`;
        }
      });
      h += '</tr>';
    });

    h += '</tbody></table>';
    el.innerHTML = h + renderOrgansPerPoint('chr');
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  РЕНДЕР «РАНЖИРОВАНИЕ»
  // ══════════════════════════════════════════════════════════════════════════
  function rankTable(subsArr, mode) {
    const total = totalHri();

    const rows = subsArr
      .map(s => ({ s, ks: String(s.kod), rfc: pf(s.rfc), em: pf(st.emissions[String(s.kod)]) }))
      .sort((a, b) => mode === 'hri'
        ? hri(b.ks) - hri(a.ks)
        : (Number(a.s.kod) || 0) - (Number(b.s.kod) || 0));

    let h = `<table class="rank-table"><thead><tr>`;
    if (mode === 'q') {
      h += `<th style="width:40px">Ранг</th>
            <th style="width:60px">Код</th>
            <th style="min-width:180px;text-align:left">Наименование</th>
            <th style="width:130px">Выброс Q, т/год</th>
            <th style="width:110px">Вклад ΣQ, %</th>`;
    } else {
      h += `<th style="width:40px">Ранг</th>
            <th style="width:60px">Код</th>
            <th style="min-width:180px;text-align:left">Наименование</th>
            <th style="width:130px">Выброс E, т/год</th>
            <th style="width:70px">RFCi</th>
            <th style="width:60px">TW</th>
            <th style="width:110px">HRi = E×TW×P/10000</th>
            <th style="width:90px">Вклад ΣHRI, %</th>`;
    }
    h += `</tr></thead><tbody>`;

    const totalQ = rows.reduce((s, r) => s + (r.em ?? 0), 0);
    let rank = 1;
    rows.forEach(({ s, ks, rfc, em }) => {
      const hriVal = hri(ks);
      const pctQ   = totalQ > 0 && em  ? em      / totalQ * 100 : 0;
      const pctH   = total  > 0 && hriVal ? hriVal / total  * 100 : 0;
      h += `<tr>
        <td style="font-weight:700;color:var(--blue)">${rank++}</td>
        <td><b>${s.kod}</b></td>
        <td class="td-name">${s.name}</td>
        <td class="td-inp"><input type="text" value="${em ?? ''}" placeholder="—"
          onchange="RiskApp.setEmission('${ks}',this.value)"></td>`;
      if (mode === 'q') {
        h += `<td class="td-calc">${em ? fmtPct(pctQ) : '—'}</td>`;
      } else {
        const tw = rfc ? getTW(rfc) : 0;
        h += `<td>${rfc ? fmtR(rfc) : '—'}</td>
              <td class="td-calc">${tw || '—'}</td>
              <td class="td-calc">${hriVal ? fmtR(hriVal) : '—'}</td>
              <td class="td-calc">${hriVal && total > 0 ? fmtPct(pctH) : '—'}</td>`;
      }
      h += `</tr>`;
    });

    if (mode === 'q') {
      h += `<tr>
        <td colspan="3" class="td-total" style="text-align:right"><b>ИТОГО</b></td>
        <td class="td-total"><b>${totalQ > 0 ? fmtR(totalQ) : '—'}</b></td>
        <td class="td-total"><b>${totalQ > 0 ? '100%' : '—'}</b></td>
      </tr>`;
    } else {
      h += `<tr>
        <td colspan="6" class="td-total" style="text-align:right"><b>ИТОГО</b></td>
        <td class="td-total"><b>${total > 0 ? fmtR(total) : '—'}</b></td>
        <td class="td-total"><b>${total > 0 ? '100%' : '—'}</b></td>
      </tr>`;
    }
    return h + '</tbody></table>';
  }

  function renderRank() {
    const el = document.getElementById('tableRank');
    if (!el) return;
    if (!st.subs.length) {
      el.innerHTML = '<p style="padding:16px;color:var(--muted)">Загрузите файлы и заполните параметры.</p>';
      return;
    }

    const withRfc = st.subs.filter(s => pf(s.rfc) !== null);
    const P = pf(st.population) || 0;

    let h = '';

    h += `<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:10px 14px;background:var(--bg2);border-radius:6px;border:1px solid var(--border)">
      <label style="font-size:12px;font-weight:600;white-space:nowrap">Численность населения P, чел.:</label>
      <input type="number" min="0" step="1" style="width:130px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px"
        value="${st.population || ''}" placeholder="напр. 29528" data-rk="population"
        oninput="RiskApp.setPopulation(this.value)">
      <span style="font-size:11px;color:var(--muted)">${P ? 'P = '+P+' чел.' : '⚠ введите численность населения'}</span>
    </div>`;

    h += `<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">
      Ранжирование по выбросам E (все вещества)
    </h3>`;
    h += rankTable(st.subs, 'q');

    if (withRfc.length) {
      h += `<h3 style="margin:24px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">
        Ранжирование по HRi неканц. = E × TW × P / 10000 (вещества с RFCi)
      </h3>`;
      h += rankTable(withRfc, 'hri');

      if (P) {
        const leader = withRfc.slice().sort((a,b) => hri(String(b.kod)) - hri(String(a.kod)))[0];
        const total  = totalHri();
        if (total > 0) {
          h += `<p style="margin-top:10px;font-size:12px;color:var(--muted)">
            Ведущее вещество: <b>${leader.name || leader.kod}</b> (код ${leader.kod}) —
            вклад ${fmtR(hri(String(leader.kod)) / total * 100)}%
          </p>`;
        }
      }
    }

    el.innerHTML = h;
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  ОБЩИЙ REFRESH
  // ══════════════════════════════════════════════════════════════════════════
  function renderCancerPanel() {
    const el = document.getElementById('tableCancer');
    if (!el) return;
    const CANC = st.subs.filter(s => pf(s.uri) !== null && !s.skip_risk);
    if (!CANC.length) {
      el.innerHTML = '<p style="padding:16px;color:var(--muted)">Нет веществ с SFi (фактор канцерогенного потенциала). Заполните столбец SFi в таблице веществ или загрузите файлы расчёта.</p>';
      return;
    }

    const totalMaxCR = CANC.reduce((sum, s) => sum + (crMax(String(s.kod)) || 0), 0);
    const sortedC = CANC.slice().sort((a, b) => (crMax(String(b.kod)) || 0) - (crMax(String(a.kod)) || 0));
    let contrib = `<div style="margin-top:24px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px">
        Вклад по веществам в суммарный CR (на границе СЗЗ)
      </div>
      <table class="rank-table"><thead><tr>
        <th style="width:40px">Ранг</th>
        <th style="min-width:180px;text-align:left">Вещество</th>
        <th style="width:120px">CR макс</th>
        <th style="width:90px">Вклад, %</th>
      </tr></thead><tbody>`;
    sortedC.forEach((s, idx) => {
      const cm = crMax(String(s.kod)) || 0;
      const pct = totalMaxCR > 0 ? fmtPct(cm / totalMaxCR * 100) : '—';
      contrib += `<tr>
        <td style="font-weight:700;color:#7c3aed">${idx + 1}</td>
        <td><b>${s.name || s.kod}</b> <small style="color:var(--muted)">код ${s.kod}</small></td>
        <td class="td-calc"><b>${cm ? fmt(cm) : '—'}</b></td>
        <td class="td-calc">${pct}</td>
      </tr>`;
    });
    contrib += '</tbody></table></div>';

    const orgSection = renderOrgansPerPoint('chr', CANC);
    const orgBlock = orgSection
      ? `<div style="margin-top:24px">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px">
            HI по органам (хронические эффекты канцерогенов)
          </div>${orgSection}</div>`
      : '';

    el.innerHTML = renderCancer() + contrib + orgBlock;
  }

  // ── Точки по файлам ──────────────────────────────────────────────────────
  // Диагностическая таблица: СКОЛЬКО веществ дало данные по каждой точке в
  // каждом из трёх загруженных файлов (зима/лето/сред) — не просто «есть
  // точка или нет», а число, по которому видно реальное расхождение между
  // файлами — ОТДЕЛЬНО для острых (Cmax = max(зима,лето)), хронических и
  // канцерогенных (Cavg = сред у обоих, но список веществ разный — ARFCi
  // против RFC против SFi/URi). Смешивать всё в одну таблицу было ошибкой:
  // число «сколько веществ дало данные» должно считаться по списку веществ
  // ИМЕННО этого вида риска, а не по всем веществам файла разом — иначе
  // число ничего не говорит о том, чего не хватает конкретно для острых
  // МР или конкретно для канцерогенного риска. Клик по строке раскрывает
  // разбивку по каждому веществу и что из неё реально попало в расчёт.
  function togglePtDetail(key) {
    if (_expandedPts.has(key)) _expandedPts.delete(key); else _expandedPts.add(key);
    renderPointsByFile();
  }

  function _countInFile(raw, kods, pt) {
    const ptS = String(pt);
    let n = 0;
    kods.forEach(k => { if ((raw[k] || {})[ptS] !== undefined) n++; });
    return n;
  }

  // fileLabels/rawMaps — 2 файла (Зима,Лето) для острых, 1 (Сред) для
  // хронических/канцерогенных; kods — список веществ ИМЕННО этой категории
  function _ptDetailRows(pt, kods, fileLabels, rawMaps) {
    const ptS = String(pt);
    const present = kods
      .filter(k => rawMaps.some(raw => (raw[k] || {})[ptS] !== undefined))
      .sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
    const cols = 2 + fileLabels.length;
    if (!present.length) {
      return `<tr><td colspan="${cols}" style="color:var(--muted);text-align:center">Нет данных по веществам для этой точки</td></tr>`;
    }
    const fval = (v) => v == null ? '—' : fmt(v);
    let rows = '';
    present.forEach(ks => {
      const s = getSub(ks);
      const name = s ? (s.name || ks) : ks;
      const vals = rawMaps.map(raw => (raw[ks] || {})[ptS]);
      const known = vals.filter(v => v != null);
      const maxV = known.length ? Math.max(...known) : null;
      const tds = vals.map(v => {
        const hi = (v != null && vals.length > 1 && v === maxV) ? 'font-weight:700;color:var(--green)' : '';
        return `<td style="${hi}">${fval(v)}</td>`;
      }).join('');
      const usedVal = fileLabels.length > 1 ? maxV : vals[0];
      rows += `<tr>
        <td style="text-align:left">${name} <small style="color:var(--muted)">код ${ks}</small></td>
        ${tds}
        <td style="color:var(--green)">${fval(usedVal)}</td>
      </tr>`;
    });
    const head = fileLabels.map(l => `<th>${l}</th>`).join('');
    const usedLabel = fileLabels.length > 1 ? 'Cmax' : 'Cavg';
    return `<tr><td colspan="${cols}" style="padding:0;background:var(--bg)">
      <table class="rtable" style="width:100%;margin:4px 0">
        <thead><tr><th style="text-align:left">Вещество</th>${head}<th>Использовано<br>(${usedLabel})</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </td></tr>`;
  }

  // Одна секция (острые/хронич/канц): своя таблица точек + раскрывающаяся
  // по клику повеществная разбивка
  function _fileSection(title, kods, pts, fileLabels, rawMaps, keyPrefix) {
    let h = `<div style="font-size:12.5px;font-weight:700;color:var(--tx2);margin:18px 0 6px;text-transform:uppercase;letter-spacing:.04em">
      ${title} — веществ: ${kods.length}, точек: ${pts.length}
    </div>`;
    if (!pts.length || !kods.length) {
      h += `<p style="color:var(--muted);font-size:12px">Нет точек или веществ для этой категории.</p>`;
      return h;
    }
    const cell = (n) => n ? n : '<span style="color:var(--muted)">—</span>';
    const used = (ok) => ok
      ? '<span style="color:var(--green);font-weight:700">✓</span>'
      : '<span style="color:var(--muted)">—</span>';
    h += '<table class="rtable"><thead><tr><th>№ точки</th>';
    fileLabels.forEach(l => { h += `<th>${l}</th>`; });
    h += '<th>Используется</th></tr></thead><tbody>';
    [...pts].sort((a, b) => a - b).forEach(pt => {
      const counts = rawMaps.map(raw => _countInFile(raw, kods, pt));
      const key = keyPrefix + pt;
      const open = _expandedPts.has(key);
      h += `<tr style="cursor:pointer" onclick="RiskApp.togglePtDetail('${key}')">
        <td class="td-pt">${open ? '▾' : '▸'} ${pt}</td>`;
      counts.forEach(n => { h += `<td>${cell(n)}</td>`; });
      h += `<td>${used(counts.some(n => n > 0))}</td></tr>`;
      if (open) h += _ptDetailRows(pt, kods, fileLabels, rawMaps);
    });
    h += '</tbody></table>';
    return h;
  }

  function renderPointsByFile() {
    const el = document.getElementById('tableByPts');
    if (!el) return;
    const ACUTE = st.subs.filter(s => pf(s.arfci) !== null && !s.skip_risk).map(s => String(s.kod));
    const CHRON = st.subs.filter(s => pf(s.rfc)   !== null && !s.skip_risk).map(s => String(s.kod));
    const CANC  = st.subs.filter(s => getUri(String(s.kod)) && !s.skip_risk).map(s => String(s.kod));

    if (!ACUTE.length && !CHRON.length && !CANC.length) {
      el.innerHTML = '<p style="padding:16px;color:var(--muted)">Нет загруженных веществ.</p>';
      return;
    }

    let h = `<div style="font-size:11.5px;color:var(--muted)">
      Число в ячейке — сколько веществ ЭТОЙ категории дало данные по точке в этом файле.
      Клик по строке — концентрации по каждому веществу и что из них взято в расчёт.
    </div>`;
    h += _fileSection('Острые МР', ACUTE, st.pts_acu || [], ['Зима', 'Лето'], [st.raw_zima, st.raw_leto], 'a');
    h += _fileSection('Хронические СР', CHRON, st.pts_chr || [], ['Сред'], [st.raw_sred], 'c');
    h += _fileSection('Канцерогенный риск', CANC, st.pts_chr || [], ['Сред'], [st.raw_sred], 'k');
    el.innerHTML = h;
  }

  function refreshTables() {
    renderAcute();
    renderChronic();
    renderPointsByFile();
    renderCancerPanel();
    renderRank();
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  ФАЙЛЫ — drag & drop
  // ══════════════════════════════════════════════════════════════════════════
  function dzDrag(e, el) { e.preventDefault(); el.classList.add('drag'); }
  function dzLeave(el)   { el.classList.remove('drag'); }
  function dzDrop(e, el, key) {
    e.preventDefault(); el.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) setFile(key, f);
  }
  function dzFile(inp, key) { if (inp.files[0]) setFile(key, inp.files[0]); }
  function setFile(key, f) {
    // accept=".docx" в <input> фильтрует только диалог выбора файла — при
    // перетаскивании (dzDrop) расширение никак не проверяется, и можно
    // случайно уронить в слот PDF/Excel той же выгрузки. Без этой проверки
    // ошибка всплывает только после отправки на сервер — сырым
    // "Package not found at '...tmp....docx'" с путём к временному файлу,
    // непонятным пользователю.
    if (!/\.docx$/i.test(f.name)) {
      const stat = document.getElementById('parseStatus');
      const ext = (f.name.split('.').pop() || '').toUpperCase();
      if (stat) showStatus(stat,
        `«${f.name}» — это ${ext || 'не'} .docx. Нужен файл выгрузки УПРЗА «Эколог» в формате Word (.docx), не ${ext || 'этот формат'}.`,
        'err');
      return;
    }
    files[key] = f;
    const el = document.getElementById('dz-' + key);
    el.classList.add('ok');
    document.getElementById('fn-' + key).textContent = f.name;
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  ПАРСИНГ (отправка файлов на сервер)
  // ══════════════════════════════════════════════════════════════════════════
  async function parseFiles() {
    const btn = document.getElementById('btnParse');
    const spin = document.getElementById('parseSpinner');
    const stat = document.getElementById('parseStatus');

    if (!files.zima || !files.leto || !files.sred) {
      showStatus(stat, 'Загрузите все три файла (.docx)', 'err'); return;
    }

    btn.disabled = true; spin.style.display = 'inline-block';
    showStatus(stat, 'Читаю Word файлы, извлекаю концентрации…', 'info');

    const fd = new FormData();
    fd.append('zima', files.zima);
    fd.append('leto', files.leto);
    fd.append('sred', files.sred);

    try {
      const r = await fetch(RISK_API + '/api/parse', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.error) { showStatus(stat, 'Ошибка: ' + d.error, 'err'); return; }

      Object.assign(st.cmax, d.cmax);
      Object.assign(st.cavg, d.cavg);
      st.pts_acu = d.points_acu;
      st.pts_chr = d.points_chr;
      st.pts_xy  = d.points_xy || {};
      st.pts_by_file = d.points_by_file || { zima: {}, leto: {}, sred: {} };
      st.raw_zima = d.raw_zima || {};
      st.raw_leto = d.raw_leto || {};
      st.raw_sred = d.raw_sred || {};

      const names = d.sub_names || {};
      (d.all_codes || []).forEach(kod => {
        const ks  = String(kod);
        const ref = REFDB[ks] || {};
        const nm  = names[ks] || ref.name || ks;
        const idx = st.subs.findIndex(s => String(s.kod) === ks);
        if (idx >= 0) {
          const s = st.subs[idx];
          if (!s.name)          s.name          = nm;
          if (!s.cas)           s.cas           = ref.cas           || '';
          if (!s.pdk_mr)        s.pdk_mr        = ref.pdk_mr        || '';
          if (!s.pdk_ss)        s.pdk_ss        = ref.pdk_ss        || '';
          if (!s.pdk_sg)        s.pdk_sg        = ref.pdk_sg        || '';
          if (!s.pdk_obv)       s.pdk_obv       = ref.pdk_obv       || '';
          if (!s.hazard_class)  s.hazard_class  = ref.hazard_class  || '';
          if (!s.arfci)         s.arfci         = ref.arfci         || '';
          if (ref.no_rfc)       s.rfc = '';
          else if (!s.rfc)      s.rfc           = ref.rfc           || '';
          if (!s.organ_acu)     s.organ_acu     = getOrgans(ref.organ_acu).join(', ');
          if (!s.organ_chr)     s.organ_chr     = getOrgans(ref.organ_chr).join(', ');
          if (!s.lim)           s.lim           = ref.lim           || '';
        } else {
          st.subs.push({
            kod, name: nm,
            cas:          ref.cas           || '',
            pdk_mr:       ref.pdk_mr        || '',
            pdk_ss:       ref.pdk_ss        || '',
            pdk_sg:       ref.pdk_sg        || '',
            pdk_obv:      ref.pdk_obv       || '',
            hazard_class: ref.hazard_class  || '',
            arfci:        ref.arfci         || '',
            rfc:          ref.rfc           || '',
            uri:          ref.uri           || '',
            organ_acu:    getOrgans(ref.organ_acu).join(', '),
            organ_chr:    getOrgans(ref.organ_chr).join(', '),
            lim:          ref.lim           || '',
            iarc:         ref.iarc          || '',
            epa:          ref.epa           || '',
            uri_r:        ref.uri_r         || '',
          });
        }
      });
      st.subs.sort((a, b) => (Number(a.kod) || 0) - (Number(b.kod) || 0));
      renderConfig();

      const base = `Готово. Веществ: ${d.all_codes.length}, точек (острый): ${d.points_acu.length}, точек (хронич.): ${d.points_chr.length}`;
      const warn = d.warnings || [];
      // Несогласованность данных не блокирует расчёт, но должна быть видна
      // сразу, а не только прочерками в готовом Word-отчёте — предупреждение
      // показываем жёлтым, поверх обычного «Готово»
      if (warn.length) showStatus(stat, base + '\n⚠ ' + warn.join('\n⚠ '), 'warn');
      else             showStatus(stat, base, 'ok');
      document.getElementById('resultsCard').style.display = '';
      document.getElementById('btnExport').style.display     = '';
      document.getElementById('btnExportWord').style.display = '';
      refreshTables();
    } catch(e) {
      showStatus(stat, 'Сетевая ошибка: ' + e.message, 'err');
    } finally {
      btn.disabled = false; spin.style.display = 'none';
    }
  }

  function showStatus(el, txt, type) {
    el.textContent = txt;
    el.className = 'status ' + type;
    el.style.display = '';
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  ИМПОРТ ВЫБРОСОВ ИЗ EXCEL
  // ══════════════════════════════════════════════════════════════════════════
  // Скачивание файлов — через _download() из export.js: под pywebview обычный
  // a.click() на blob/URL не вызывает диалог сохранения (браузерные загрузки
  // там заблокированы), а _download() уже умеет это через нативный мост.
  function downloadEmisTemplate(ev) {
    if (ev) ev.preventDefault();
    if (typeof _download === 'function') {
      _download(RISK_API + '/api/emissions_template', 'Шаблон_выбросы.xlsx');
    } else {
      const a = document.createElement('a');
      a.href = RISK_API + '/api/emissions_template';
      a.download = 'Шаблон_выбросы.xlsx';
      a.click();
    }
  }

  function subFromRef(kod, name) {
    const ks = String(kod);
    const ref = REFDB[ks] || {};
    return {
      kod: parseInt(ks) || ks,
      name: name || ref.name || ks,
      cas:          ref.cas          || '',
      pdk_mr:       ref.pdk_mr       || '',
      pdk_ss:       ref.pdk_ss       || '',
      pdk_sg:       ref.pdk_sg       || '',
      pdk_obv:      ref.pdk_obv      || '',
      hazard_class: ref.hazard_class || '',
      arfci:        ref.arfci        || '',
      rfc:          ref.no_rfc ? '' : (ref.rfc || ''),
      uri:          ref.uri          || '',
      organ_acu:    getOrgans(ref.organ_acu).join(', '),
      organ_chr:    getOrgans(ref.organ_chr).join(', '),
      lim:          ref.lim          || '',
      iarc:         ref.iarc         || '',
      epa:          ref.epa          || '',
      uri_r:        ref.uri_r        || '',
      skip_risk: false,
    };
  }

  async function importEmissions(inputEl) {
    const file = inputEl.files && inputEl.files[0];
    const stat = document.getElementById('emisImportStatus');
    if (!file) return;

    showStatus(stat, 'Читаю Excel…', 'info');
    const fd = new FormData();
    fd.append('file', file);

    try {
      const r = await fetch(RISK_API + '/api/parse_emissions', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.error) { showStatus(stat, 'Ошибка: ' + d.error, 'err'); return; }

      const em    = d.emissions || {};
      const names = d.names || {};
      const codes = Object.keys(em);
      if (!codes.length) { showStatus(stat, 'В файле нет распознанных выбросов', 'err'); return; }

      let added = 0;
      codes.forEach(ks => {
        st.emissions[ks] = em[ks];
        const s = getSub(ks);
        if (!s) {
          st.subs.push(subFromRef(ks, names[ks]));
          added++;
        } else if (!s.name && names[ks]) {
          s.name = names[ks];
        }
      });
      st.subs.sort((a, b) => (Number(a.kod) || 0) - (Number(b.kod) || 0));
      renderConfig();

      document.getElementById('resultsCard').style.display = '';
      document.getElementById('btnExport').style.display     = '';
      document.getElementById('btnExportWord').style.display = '';
      refreshTables();

      showStatus(stat,
        `Импортировано: ${codes.length} в-в${added ? ', новых: ' + added : ''}`, 'ok');
    } catch (e) {
      showStatus(stat, 'Сетевая ошибка: ' + e.message, 'err');
    } finally {
      inputEl.value = '';
    }
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  ЭКСПОРТ В EXCEL
  // ══════════════════════════════════════════════════════════════════════════
  async function exportExcel() {
    const payload = {
      subs: st.subs.map(s => ({
        ...s,
        arfci: pf(s.arfci) || null,
        rfc:   pf(s.rfc)   || null,
      })),
      cmax:       st.cmax,
      cavg:       st.cavg,
      emissions:  st.emissions,
      points_acu: st.pts_acu,
      points_chr: st.pts_chr,
      raw_zima: st.raw_zima, raw_leto: st.raw_leto, raw_sred: st.raw_sred,
    };

    const r = await fetch(RISK_API + '/api/export', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    if (!r.ok) { if (typeof askNotice === 'function') askNotice('Ошибка экспорта'); else alert('Ошибка экспорта'); return; }
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    try {
      if (typeof _download === 'function') await _download(url, 'Риски.xlsx');
      else { const a = document.createElement('a'); a.href = url; a.download = 'Риски.xlsx'; a.click(); }
    } finally {
      URL.revokeObjectURL(url);
    }
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  ЭКСПОРТ В WORD
  // ══════════════════════════════════════════════════════════════════════════
  async function exportWord() {
    const payload = {
      subs:       st.subs,
      cmax:       st.cmax,
      cavg:       st.cavg,
      emissions:  st.emissions,
      points_acu: st.pts_acu,
      points_chr: st.pts_chr,
      points_xy:  st.pts_xy,
      points_by_file: st.pts_by_file,
      raw_zima: st.raw_zima, raw_leto: st.raw_leto, raw_sred: st.raw_sred,
      population: st.population,
    };
    const btns = [document.getElementById('btnExportWord'), document.getElementById('btnExportWord2')].filter(Boolean);
    btns.forEach(b => { b.textContent = '⏳ Формирование…'; b.disabled = true; });
    try {
      const r = await fetch(RISK_API + '/api/export_report', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload),
      });
      if (!r.ok) { const t = await r.text(); if (typeof askNotice === 'function') askNotice('Ошибка: ' + t); else alert('Ошибка: ' + t); return; }
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      try {
        if (typeof _download === 'function') await _download(url, 'Таблицы_оценка_риска.docx');
        else { const a = document.createElement('a'); a.href = url; a.download = 'Таблицы_оценка_риска.docx'; a.click(); }
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch(e) {
      if (typeof askNotice === 'function') askNotice('Ошибка: ' + e.message); else alert('Ошибка: ' + e.message);
    } finally {
      btns.forEach(b => { b.textContent = '⬇ Скачать Word (таблицы)'; b.disabled = false; });
    }
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  TABS & CARDS
  // ══════════════════════════════════════════════════════════════════════════
  function switchTab(key, btn) {
    document.querySelectorAll('#risk-editor .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#risk-editor .tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + key).classList.add('active');
  }
  function toggleCard(head) {
    head.classList.toggle('collapsed');
    head.nextElementSibling.classList.toggle('hidden');
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  РАЗМЕТКА (строится один раз при первом входе в режим)
  // ══════════════════════════════════════════════════════════════════════════
  function _html() {
    return `
<header>
  <button class="pdf-back-btn" onclick="exitRiskMode()" style="margin-right:14px">← Карта</button>
  <div style="flex:1">
    <div class="sub">Р 2.1.10.3968-23</div>
    <h1>Оценка риска населения</h1>
  </div>
  <button id="btnExport"     onclick="RiskApp.exportExcel()">⬇ Скачать Excel</button>
  <button id="btnExportWord" onclick="RiskApp.exportWord()">⬇ Скачать Word (таблицы)</button>
</header>

<main>

<div class="card">
  <div class="card-head" onclick="RiskApp.toggleCard(this)">
    <span>📂</span> Загрузка файлов УПРЗА
    <span class="arrow" style="margin-left:auto">▼</span>
  </div>
  <div class="card-body">
    <div class="upload-grid">
      <div class="drop-zone" id="dz-zima" ondragover="RiskApp.dzDrag(event,this)" ondragleave="RiskApp.dzLeave(this)" ondrop="RiskApp.dzDrop(event,this,'zima')">
        <input type="file" accept=".docx" onchange="RiskApp.dzFile(this,'zima')">
        <div class="dz-icon">❄️</div>
        <div class="dz-label">Зима</div>
        <div class="dz-hint">МР зима на границе СЗЗ.docx</div>
        <div class="dz-name" id="fn-zima"></div>
      </div>
      <div class="drop-zone" id="dz-leto" ondragover="RiskApp.dzDrag(event,this)" ondragleave="RiskApp.dzLeave(this)" ondrop="RiskApp.dzDrop(event,this,'leto')">
        <input type="file" accept=".docx" onchange="RiskApp.dzFile(this,'leto')">
        <div class="dz-icon">☀️</div>
        <div class="dz-label">Лето</div>
        <div class="dz-hint">МР лето на границе СЗЗ.docx</div>
        <div class="dz-name" id="fn-leto"></div>
      </div>
      <div class="drop-zone" id="dz-sred" ondragover="RiskApp.dzDrag(event,this)" ondragleave="RiskApp.dzLeave(this)" ondrop="RiskApp.dzDrop(event,this,'sred')">
        <input type="file" accept=".docx" onchange="RiskApp.dzFile(this,'sred')">
        <div class="dz-icon">📊</div>
        <div class="dz-label">Средние концентрации</div>
        <div class="dz-hint">Сред конц на границе СЗЗ.docx</div>
        <div class="dz-name" id="fn-sred"></div>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn-primary" id="btnParse" onclick="RiskApp.parseFiles()">
        <span id="parseSpinner" class="spinner"></span>
        Рассчитать
      </button>
      <div id="parseStatus" class="status info" style="display:none"></div>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-head" onclick="RiskApp.toggleCard(this)">
    <span>⚗️</span> Вещества и параметры
    <span class="arrow" style="margin-left:auto">▼</span>
  </div>
  <div class="card-body">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;background:var(--bg2);border-radius:6px;border:1px solid var(--border)">
      <span style="font-size:12px;font-weight:600;white-space:nowrap">📥 Выбросы из Excel:</span>
      <label style="background:#2563eb;color:#fff;border-radius:6px;padding:6px 14px;font-weight:600;cursor:pointer;font-size:13px">
        Импорт выбросов
        <input type="file" accept=".xlsx,.xls" style="display:none" onchange="RiskApp.importEmissions(this)">
      </label>
      <a href="#" onclick="RiskApp.downloadEmisTemplate(event)" style="font-size:12px;color:var(--blue)">Скачать шаблон</a>
      <span id="emisImportStatus" class="status" style="display:none;margin:0;padding:4px 10px;font-size:12px"></span>
      <span style="font-size:11px;color:var(--muted);margin-left:auto">Столбцы: «Код вещества» + «Выброс, т/год». Строки с одинаковым кодом суммируются.</span>
    </div>
    <table class="cfg-table" id="cfgTable">
      <thead>
        <tr>
          <th style="width:36px"></th>
          <th style="width:60px">Код</th>
          <th style="min-width:150px;text-align:left">Наименование</th>
          <th style="width:90px">CAS</th>
          <th style="width:70px">ПДК мр<br><small>мг/м³</small></th>
          <th style="width:70px">ПДК с/с<br><small>мг/м³</small></th>
          <th style="width:70px">ПДК с/г<br><small>мг/м³</small></th>
          <th style="width:70px">ОБУВ<br><small>мг/м³</small></th>
          <th style="width:45px">Кл.<br>оп.</th>
          <th style="width:90px">ARFCi<br><small>мг/м³/сут</small></th>
          <th style="width:80px">RFC<br><small>мг/м³</small></th>
          <th style="width:80px">SFi<br><small>(мг/м³)⁻¹</small></th>
          <th style="width:110px">Орган<br>острый</th>
          <th style="width:110px">Орган<br>хронич.</th>
          <th style="width:60px" title="Только учёт выброса т/год, без расчёта рисков">Только<br>выброс</th>
        </tr>
      </thead>
      <tbody id="cfgBody"></tbody>
    </table>
    <button class="btn-add" onclick="RiskApp.addSubRow()">+ Добавить вещество</button>
    <p style="font-size:11px;color:var(--muted);margin-top:8px">
      Жёлтые ячейки — редактируемые. ARFCi / RFC пусто = вещество не участвует в расчёте. SFi — фактор канцерогенного потенциала при ингаляции (Р 2.1.10.3968-23, П1.4); если заполнен — вещество участвует в расчёте канцерогенного риска CR = Cavg × SFi.
    </p>
  </div>
</div>

<div id="resultsCard" style="display:none">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px">
    <div class="tabs" style="margin-bottom:0">
      <div class="tab active" onclick="RiskApp.switchTab('acute',this)">Острые МР</div>
      <div class="tab" onclick="RiskApp.switchTab('chronic',this)">Хронические СР</div>
      <div class="tab" onclick="RiskApp.switchTab('cancer',this)">Канц. риск</div>
      <div class="tab" onclick="RiskApp.switchTab('rank',this)">Ранжирование</div>
      <div class="tab" onclick="RiskApp.switchTab('bypts',this)">РТ по файлам</div>
    </div>
    <div style="display:flex;gap:8px">
      <button onclick="RiskApp.exportExcel()" style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:7px 16px;font-weight:600;cursor:pointer;font-size:13px">⬇ Excel</button>
      <button onclick="RiskApp.exportWord()" id="btnExportWord2" style="background:#166534;color:#fff;border:none;border-radius:6px;padding:7px 16px;font-weight:600;cursor:pointer;font-size:13px">⬇ Скачать Word (таблицы)</button>
    </div>
  </div>

  <div class="tab-panel active" id="panel-acute">
    <div class="legend">
      <div class="legend-item"><div class="legend-box" style="background:var(--yel)"></div> Cmax (из файла, редактируемый)</div>
      <div class="legend-item"><div class="legend-box" style="background:var(--calc)"></div> HQ = Cmax / ARFCi (рассчитывается)</div>
      <div class="legend-item"><div class="legend-box" style="background:var(--max)"></div> Максимум (СЗЗ)</div>
    </div>
    <div class="tab-content"><div id="tableAcute"></div></div>
  </div>

  <div class="tab-panel" id="panel-chronic">
    <div class="legend">
      <div class="legend-item"><div class="legend-box" style="background:var(--yel)"></div> Cavg (из файла, редактируемый)</div>
      <div class="legend-item"><div class="legend-box" style="background:var(--calc)"></div> HQ = Cavg / RFC (рассчитывается)</div>
      <div class="legend-item"><div class="legend-box" style="background:var(--organ)"></div> HI по органу</div>
    </div>
    <div class="tab-content"><div id="tableChronic"></div></div>
  </div>

  <div class="tab-panel" id="panel-cancer">
    <div class="legend">
      <div class="legend-item"><div class="legend-box" style="background:var(--yel)"></div> Cavg (средняя концентрация, мг/м³)</div>
      <div class="legend-item"><div class="legend-box" style="background:var(--calc)"></div> CR = Cavg × SFi (канцерогенный риск)</div>
      <div class="legend-item"><div class="legend-box" style="background:var(--max)"></div> Максимум (СЗЗ)</div>
    </div>
    <div class="tab-content" style="padding:16px"><div id="tableCancer"></div></div>
  </div>

  <div class="tab-panel" id="panel-rank">
    <div class="tab-content" style="padding:16px"><div id="tableRank"></div></div>
  </div>

  <div class="tab-panel" id="panel-bypts">
    <div class="tab-content" style="padding:16px"><div id="tableByPts"></div></div>
  </div>
</div>

</main>`;
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  ВХОД / ВЫХОД ИЗ РЕЖИМА (по образцу enterPdfMode()/exitPdfMode())
  // ══════════════════════════════════════════════════════════════════════════
  let _riskInited = false;

  window.enterRiskMode = function () {
    const editor = document.getElementById('risk-editor');
    if (!editor) return;
    editor.style.display = 'block';

    if (!_riskInited) {
      _riskInited = true;
      editor.innerHTML = _html();
      renderConfig();

      // REFDB и проверка сервера — один раз, при первом входе
      fetch(RISK_API + '/api/refdb').then(r => r.json()).then(db => {
        REFDB = db;
        console.log('REFDB загружен: ' + Object.keys(db).length + ' веществ');
      }).catch(e => console.warn('REFDB не загружен:', e));

      fetch(RISK_API + '/api/health').then(r => r.json()).then(d => {
        if (!d.ok) throw new Error('bad response');
      }).catch(() => {
        const stat = document.getElementById('parseStatus');
        if (stat) {
          stat.textContent = 'Сервер оценки риска не отвечает. Попробуйте перезапустить приложение.';
          stat.className = 'status err';
          stat.style.display = '';
        }
      });
    }
  };

  window.exitRiskMode = function () {
    const editor = document.getElementById('risk-editor');
    if (editor) editor.style.display = 'none';
  };


  // ══════════════════════════════════════════════════════════════════════════
  //  ПУБЛИЧНЫЙ ИНТЕРФЕЙС — разметка выше дёргает обработчики через RiskApp.*,
  //  чтобы не плодить глобальные имена (st/files и десятки чистых функций
  //  расчёта остаются приватными в замыкании модуля)
  // ══════════════════════════════════════════════════════════════════════════
  window.RiskApp = {
    toggleCard, dzDrag, dzLeave, dzDrop, dzFile, parseFiles,
    updSub, delSub, casLookup, addSubRow, setCavg, setCmax, setEmission, setPopulation,
    downloadEmisTemplate, importEmissions, exportExcel, exportWord,
    switchTab, updSubSfi, togglePtDetail,
  };
})();
