# -*- coding: utf-8 -*-
# Встроенный API-бэкенд для вкладки «Оценка риска» в СЗЗ-Инструменте.
# Раньше это была отдельная программа (templates/index.html сам же и отдавал
# через render_template) — здесь страницу отдаёт основной статик-сервер
# СЗЗ-Инструмента, этот Flask остаётся чистым JSON/файловым API, как
# proxy.py для НСПД. Расчётная часть (parse_word, _build_word, _build_excel,
# справочники RFC/CAS) не менялась.
import os, sys, re, io, tempfile
from flask import Flask, request, jsonify, send_file
from docx import Document
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB

# Папка с этим файлом и его данными (cas_rfc_full.json) — при заморозке
# PyInstaller лежит под sys._MEIPASS, как и остальные бандловые данные
# СЗЗ-Инструмента (см. STATIC_DIR в основном app.py)
_BASE_DIR = (os.path.join(sys._MEIPASS, 'risk_server') if getattr(sys, 'frozen', False)
             else os.path.dirname(os.path.abspath(__file__)))

# CORS — разрешаем запросы из любого источника (file://, localhost, etc.)
@app.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin']  = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

@app.route('/api/health')
def health():
    return jsonify({'ok': True})


# ── Word parser ──────────────────────────────────────────────────────────
def _num(s):
    """'4397898, 10' → 4397898.1; '3,766E-06' → 3.766e-06; '-' → None."""
    s = (s or '').replace('\n', '').replace(' ', '').replace(' ', '').replace(',', '.')
    if not s or s in ('-', '–', '—'):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_word(path):
    """Разбирает выгрузку УПРЗА «Эколог» и возвращает (conc_dict, names_dict):
       conc_dict  = {kod: {pt: mg_m3}}
       names_dict = {kod: 'название вещества'}

    Читаются только таблицы «Результаты расчета по расчетным точкам»; столбец
    концентрации определяется по шапке («Концентр. (мг/куб.м)»), а не по
    фиксированному номеру — набор столбцов зависит от настроек расчёта
    (наличие фона, долей ПДК). Маркер «Вещество:» встречается и в таблицах
    «Выбросы источников по веществам», где № площадки можно принять за номер
    точки, а графу F — за концентрацию; такие таблицы отключают разбор.
    """
    doc = Document(path)
    result = {}
    names  = {}
    points = {}       # {номер точки: {'x','y','h','type'}} из таблицы «Расчетные точки»
    current_kod = None
    conc_idx = None   # индекс столбца концентрации в мг/куб.м; None — не в таблице точек
    pt_cols  = None   # число столбцов в строке точки (из шапки) — см. ниже
    in_ptlist = False # идёт таблица со списком расчётных точек и координатами
    for tbl in doc.tables:
        for row in tbl.rows:
            # Объединённые ячейки python-docx отдаёт повторно — дедуплицируем
            # по ИДЕНТИЧНОСТИ ячейки (<w:tc>), а не по её тексту. Дедупликация
            # по тексту схлопывала разные столбцы с одинаковым значением
            # (например, два нуля) и сдвигала все последующие индексы.
            vals, seen = [], set()
            for cell in row.cells:
                tc_id = id(cell._tc)
                if tc_id in seen:
                    continue
                seen.add(tc_id)
                vals.append(cell.text.strip())
            if not any(vals):
                continue
            if len(vals) == 1 and 'Вещество:' in vals[0]:
                # "Вещество: 1052  \nМетиловый спирт"
                m = re.search(r'Вещество:\s*(\d+)\s*[\n\s]*(.*)', vals[0], re.DOTALL)
                if m:
                    current_kod = int(m.group(1))
                    name = re.sub(r'\s+', ' ', m.group(2)).strip()
                    result.setdefault(current_kod, {})
                    if current_kod not in names and name:
                        names[current_kod] = name
                continue
            joined = ' '.join(vals)
            # Word переносит заголовки внутри ячейки ('№\nист.', 'Код\nв-ва') —
            # сравнения ниже ищут слова через обычный пробел, поэтому перенос
            # строки внутри ячейки ломал совпадение и защитные проверки просто
            # никогда не срабатывали. Сравниваем по версии с пробелами вместо
            # переносов строк — переносы внутри слова (Word иногда переносит
            # и середину слова) не трогаем, re.sub схлопывает только пробельные
            # последовательности.
            joined_n = re.sub(r'\s+', ' ', joined)

            # Шапка списка расчётных точек: Код | X | Y | Высота | Тип точки | ...
            if vals[0] == 'Код' and 'X' in vals and 'Y' in vals and 'Тип точки' in joined_n:
                in_ptlist = True
                continue
            if in_ptlist:
                if len(vals) >= 5 and re.match(r'^\d{1,4}$', vals[0]):
                    x, y, h = _num(vals[1]), _num(vals[2]), _num(vals[3])
                    if x is not None and y is not None:
                        points[int(vals[0])] = {
                            'x': x, 'y': y, 'h': h,
                            'type': vals[4] if len(vals) > 4 else ''}
                        continue
                in_ptlist = False   # список кончился

            # Шапка таблицы расчётных точек — включает разбор и задаёт столбец
            if 'Коорд' in joined_n and 'Концентр' in joined_n:
                idx = None
                for i, v in enumerate(vals):
                    low = re.sub(r'\s+', '', v.lower())
                    if 'концентр' in low and ('мг/куб' in low or 'мг/м' in low):
                        idx = i
                        break
                if idx is not None:
                    conc_idx = idx
                    pt_cols  = len(vals)   # ширина строки точки — см. фильтр ниже
                continue

            # Шапка таблицы другого типа («Выбросы источников по веществам») —
            # выключает разбор до следующей таблицы точек. Эти таблицы нумеруют
            # строки КОДОМ ИСТОЧНИКА, а не точки — без этой проверки источник
            # принимается за точку, а его выброс (г/с) — за концентрацию
            # чужого вещества.
            if any(k in joined_n for k in ('№ ист.', 'Выброс (г/с)', 'Код в-ва',
                                           'Наименование источника', 'Тип источника')):
                conc_idx = None
                continue

            if current_kod is None or conc_idx is None or len(vals) <= conc_idx:
                continue
            if vals[0] in ('', 'Площадка', 'Цех', 'Источник', '№', 'Код в-ва'):
                continue
            # Внутри таблицы точек после каждой точки нередко идёт БЕЗ нового
            # заголовка короткая врезка «Площадка | Цех | Источник | Вклад
            # (д.ПДК) | Вклад (мг/куб.м) | Вклад %» — разбивка вклада каждого
            # источника в концентрацию ЭТОЙ точки, а не следующая точка. У неё
            # другое число столбцов, чем у строки точки (обычно меньше) — по
            # этому отличию и отсеиваем, не трогая conc_idx: в отличие от
            # постоянного выключения разбора, точки ПОСЛЕ такой врезки (в той
            # же таблице, без нового заголовка) этим не теряются.
            if pt_cols is not None and len(vals) != pt_cols:
                continue

            # строка точки: № точки | X | Y | высота | ... | концентрация
            try:
                pt = int(vals[0])
            except ValueError:
                continue
            if _num(vals[1]) is None or _num(vals[2]) is None:
                continue
            conc = _num(vals[conc_idx])
            if conc is None:
                continue
            if pt not in result[current_kod] or conc > result[current_kod][pt]:
                result[current_kod][pt] = conc
    return result, names, points


# ── Reference DB (POLL.jpol from УПРЗА Эколог) ───────────────────────────
_REFDB_CACHE = None  # сбрасывается при перезапуске сервера

# Приоритетные RFC/ARFCi/URi из Р 2.1.10.3968-23 (таблицы П1.2, П1.3, П1.4)
# Берут приоритет над автозаполнением из ПДК и над CAS-справочником
_RFC_DATA = {
    # ── Взвешенные частицы ──────────────────────────────────────────────────
    # RfC и критические органы — П1.3 Р 2.1.10.3968-23
    8:    {'cas':'',           'rfc':'0.04',     'arfci':'',     'organ_chr':'Органы дыхания, смертность, ССС, развитие', 'organ_acu':'',               'lim':'общесан.'},
    10:   {'cas':'',           'rfc':'0.025',    'arfci':'',     'organ_chr':'Органы дыхания',  'organ_acu':'',                                        'lim':'общесан.'},
    # ── Металлы ─────────────────────────────────────────────────────────────
    101:  {'cas':'1344-28-1',  'rfc':'0.005',    'arfci':'',     'organ_chr':'Органы дыхания, масса тела', 'organ_acu':'',                                'lim':'рез.'},
    104:  {'cas':'513-77-9',   'rfc':'0.0005',   'arfci':'',     'organ_chr':'Репродуктивная система, ССС', 'organ_acu':'',                            'lim':'рез.'},
    109:  {'cas':'7440-41-7',  'rfc':'0.00001',  'arfci':'',     'organ_chr':'Органы дыхания, иммунная система (сенсибилизация)', 'organ_acu':'',      'lim':'спец.'},
    110:  {'cas':'1314-62-1',  'rfc':'0.0001',   'arfci':'0.03', 'organ_chr':'Органы дыхания, ЖКТ', 'organ_acu':'Органы дыхания, глаза',              'lim':'рез.'},
    112:  {'cas':'13472-45-2', 'rfc':'',         'arfci':'',     'organ_chr':'',                'organ_acu':'',                                        'lim':''},
    118:  {'cas':'13463-67-7', 'rfc':'0.1',      'arfci':'',     'organ_chr':'Органы дыхания',  'organ_acu':'',                                        'lim':'орг.'},
    123:  {'cas':'1309-37-1',  'rfc':'0.075',    'arfci':'',     'organ_chr':'Органы дыхания, смертность', 'organ_acu':'',                             'lim':'рез.'},
    143:  {'cas':'1344-43-0',  'rfc':'0.00005',  'arfci':'',     'organ_chr':'Нервная система',  'organ_acu':'',                                       'lim':'рез.'},
    203:  {'cas':'18540-29-9', 'rfc':'0.0001',   'arfci':'',     'organ_chr':'Органы дыхания',  'organ_acu':'', 'uri':'42', 'iarc':'1', 'epa':'A',    'lim':'рез.'},
    207:  {'cas':'1314-13-2',  'rfc':'0.035',    'arfci':'',     'organ_chr':'ССС, кровь, органы дыхания', 'organ_acu':'',                            'lim':'рез.'},
    # ── Неорганические газы ─────────────────────────────────────────────────
    301:  {'cas':'10102-44-0', 'rfc':'0.04',     'arfci':'0.47', 'organ_chr':'Органы дыхания, кровь', 'organ_acu':'Органы дыхания', 'pdk_sg':'0.04',          'lim':'рефл.-рез.'},
    303:  {'cas':'7664-41-7',  'rfc':'0.04',     'arfci':'3.2',  'organ_chr':'Органы дыхания',  'organ_acu':'Органы дыхания, глаза',                  'lim':'рефл.-рез.'},
    304:  {'cas':'10102-43-9', 'rfc':'0.06',     'arfci':'',     'organ_chr':'Органы дыхания, кровь', 'organ_acu':'',                                  'lim':'рефл.'},
    316:  {'cas':'7647-01-0',  'rfc':'0.02',     'arfci':'2.1',  'organ_chr':'Органы дыхания',  'organ_acu':'Органы дыхания, глаза',                  'lim':'рефл.-рез.'},
    322:  {'cas':'7664-93-9',  'rfc':'0.001',    'arfci':'0.12', 'organ_chr':'Органы дыхания',  'organ_acu':'Органы дыхания',                          'lim':'рефл.-рез.'},
    325:  {'cas':'7440-38-2',  'rfc':'0.000015', 'arfci':'0.0002','organ_chr':'Развитие, ССС, нервная система, органы дыхания, кожа', 'organ_acu':'Репродуктивная система, развитие, ССС, нервная система', 'uri':'12.0', 'iarc':'1', 'epa':'A', 'lim':'рез.'},
    # RfC и органы — строка «Сажа (углерод)» П1.3; SFi 0,017 — «Углерод черный» П1.4
    328:  {'cas':'1333-86-4',  'rfc':'0.025',    'arfci':'',     'organ_chr':'Органы дыхания, системное действие, зубы', 'organ_acu':'', 'uri':'0.017', 'iarc':'2B', 'epa':'-',  'lim':'рез.'},
    330:  {'cas':'7446-09-5',  'rfc':'0.05',     'arfci':'0.66', 'organ_chr':'Органы дыхания',  'organ_acu':'Органы дыхания',                          'lim':'рефл.-рез.'},
    333:  {'cas':'7783-06-4',  'rfc':'0.002',    'arfci':'0.042','organ_chr':'Нервная система, органы дыхания', 'organ_acu':'ЦНС',                     'lim':'рефл.'},
    337:  {'cas':'630-08-0',   'rfc':'3',        'arfci':'23',   'organ_chr':'Кровь, ССС, развитие, ЦНС', 'organ_acu':'ССС',                           'lim':'рез.'},
    342:  {'cas':'7664-39-3',  'rfc':'0.005',    'arfci':'0.24', 'organ_chr':'Костная система, зубы, органы дыхания', 'organ_acu':'Органы дыхания, глаза', 'lim':'рефл.-рез.'},
    344:  {'cas':'',           'rfc':'0.013',    'arfci':'',     'organ_chr':'Костная система, зубы, органы дыхания', 'organ_acu':'',                   'lim':'рефл.'},
    349:  {'cas':'7782-50-5',  'rfc':'0.0002',   'arfci':'0.21', 'organ_chr':'Органы дыхания',  'organ_acu':'Органы дыхания, глаза',                  'lim':'рефл.-рез.'},
    410:  {'cas':'74-82-8',    'rfc':'50',       'arfci':'',     'organ_chr':'',                'organ_acu':'',                                        'lim':'орг.'},
    415:  {'cas':'',           'rfc':'',         'arfci':'',     'organ_chr':'',                'organ_acu':'', 'no_rfc': True,                        'lim':''},
    416:  {'cas':'',           'rfc':'',         'arfci':'',     'organ_chr':'',                'organ_acu':'', 'no_rfc': True,                        'lim':''},
    # ── Органические вещества ───────────────────────────────────────────────
    602:  {'cas':'71-43-2',    'rfc':'0.005',    'arfci':'0.027','organ_chr':'Иммунная система, кровь', 'organ_acu':'Репродуктивная система, развитие, иммунная система, кровь', 'uri':'0.027', 'iarc':'1',  'epa':'A',  'lim':'рез.'},
    616:  {'cas':'1330-20-7',  'rfc':'0.1',      'arfci':'22',   'organ_chr':'Нервная система',  'organ_acu':'Нервная система, органы дыхания, глаза', 'lim':'рефл.'},
    621:  {'cas':'108-88-3',   'rfc':'0.4',      'arfci':'5.0',  'organ_chr':'ЦНС',             'organ_acu':'Нервная система, глаза, органы дыхания',  'lim':'рефл.'},
    627:  {'cas':'100-41-4',   'rfc':'1.0',      'arfci':'',     'organ_chr':'Развитие',         'organ_acu':'',                                       'lim':'рефл.'},
    703:  {'cas':'50-32-8',    'rfc':'0.000001', 'arfci':'',     'organ_chr':'Развитие',         'organ_acu':'', 'uri':'3.9',          'iarc':'1',  'epa':'B2', 'lim':'рез.'},
    1052: {'cas':'67-56-1',    'rfc':'0.2',      'arfci':'28',   'organ_chr':'Развитие',         'organ_acu':'ЦНС',                                    'lim':'рефл.-рез.'},
    1061: {'cas':'64-17-5',    'rfc':'',         'arfci':'',     'organ_chr':'ЦНС',             'organ_acu':'',                                        'lim':'рефл.'},
    1071: {'cas':'108-95-2',   'rfc':'0.006',    'arfci':'5.8',  'organ_chr':'Печень, ССС, нервная система, почки', 'organ_acu':'Органы дыхания, глаза', 'lim':'рефл.-рез.'},
    1078: {'cas':'107-21-1',   'rfc':'0.4',      'arfci':'',     'organ_chr':'Органы дыхания, почки, развитие', 'organ_acu':'',                        'lim':'рез.'},
    1301: {'cas':'107-02-8',   'rfc':'0.001',    'arfci':'0.0025','organ_chr':'Органы дыхания', 'organ_acu':'Органы дыхания, глаза',                  'lim':'рефл.-рез.'},
    1325: {'cas':'50-00-0',    'rfc':'0.003',    'arfci':'0.05', 'organ_chr':'Органы дыхания',  'organ_acu':'Глаза', 'uri':'0.046', 'iarc':'1',  'epa':'B1', 'lim':'рефл.-рез.'},
    1401: {'cas':'67-64-1',    'rfc':'31',       'arfci':'',     'organ_chr':'Печень, почки, кровь, ЦНС', 'organ_acu':'',                              'lim':'рефл.'},
    1715: {'cas':'74-93-1',    'rfc':'0.0005',   'arfci':'',     'organ_chr':'Органы дыхания',  'organ_acu':'',                                        'lim':'рефл.'},
    1728: {'cas':'75-08-1',    'rfc':'0.001',    'arfci':'',     'organ_chr':'Органы дыхания',  'organ_acu':'',                                        'lim':'рефл.'},
    # ── Хлорорганика ────────────────────────────────────────────────────────
    827:  {'cas':'75-01-4',    'rfc':'0.1',      'arfci':'180',  'organ_chr':'Печень',           'organ_acu':'Нервная система, органы дыхания, глаза', 'uri':'0.0308', 'iarc':'1',  'epa':'A',  'lim':'спец.'},
    898:  {'cas':'67-66-3',    'rfc':'0.3',      'arfci':'0.15', 'organ_chr':'ЖКТ, почки, развитие', 'organ_acu':'Репродуктивная система, развитие, нервная система, органы дыхания', 'uri':'0.008', 'iarc':'2A', 'epa':'B2', 'lim':'рез.'},
    # ── Пыль ────────────────────────────────────────────────────────────────
    # RfC по строке «Взвешенные вещества» П1.3 (собственных значений у пылей нет)
    2902: {'cas':'',           'rfc':'0.075',    'arfci':'',     'organ_chr':'Органы дыхания, смертность', 'organ_acu':'',                             'lim':'общесан.'},
    2907: {'cas':'',           'rfc':'0.075',    'arfci':'',     'organ_chr':'Органы дыхания, смертность', 'organ_acu':'',                             'lim':'фиброг.'},
    2908: {'cas':'',           'rfc':'0.075',    'arfci':'',     'organ_chr':'Органы дыхания, смертность', 'organ_acu':'',                             'lim':'фиброг.'},
    2909: {'cas':'',           'rfc':'0.075',    'arfci':'',     'organ_chr':'Органы дыхания, смертность', 'organ_acu':'',                             'lim':'фиброг.'},
    2930: {'cas':'',           'rfc':'0.075',    'arfci':'',     'organ_chr':'Органы дыхания, смертность', 'organ_acu':'',                             'lim':'фиброг.'},
}

# Код ЗВ → CAS. В POLL.jpol поля CAS нет вообще, поэтому без этой таблицы
# CAS-справочник (cas_rfc_full.json) недостижим для всех веществ, которых нет
# в _RFC_DATA, и органы-мишени у них остаются пустыми.
# Перечислены только коды, сверенные с наименованиями из POLL.jpol; для
# остальных CAS можно ввести вручную — casLookup подтянет данные по нему.
_CODE_CAS = {
    122: '7705-08-0',  128: '1305-78-8',  133: '1306-19-0',  134: '7440-48-4',
    146: '1317-38-0',  150: '1310-73-2',  152: '7647-14-5',  155: '497-19-8',
    163: '7440-02-0',  164: '1313-99-1',  183: '7439-97-6',  184: '7439-92-1',
    203: '18540-29-9', 231: '513-77-9',   260: '1307-96-6',
    302: '7697-37-2',  314: '7784-42-1',  326: '10028-15-6', 347: '75-44-5',
    503: '106-99-0',   620: '100-42-5',   856: '107-06-2',   869: '75-09-2',
    882: '127-18-4',   902: '79-01-6',    906: '56-23-5',    915: '108-90-7',
    1210:'123-38-6',   1401:'67-64-1',    1555:'64-19-7',
}

# ── Канонические имена критических органов/систем ────────────────────────
# Справочники пишут одно и то же по-разному: "Нервная сист." в CAS-справочнике
# против "Нервная система" в таблице кодов. Без приведения к общему виду один
# орган даёт две строки HI, и обе заниженные.
_ORGAN_ALIASES = {
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
}

def _canon_organ(raw):
    """'Кровь (образование methb)' → 'Кровь'; 'нервная сист.' → 'Нервная система'."""
    if not raw:
        return ''
    s = re.sub(r'\([^)]*\)', ' ', str(raw))
    s = re.sub(r'\s+', ' ', s).strip().rstrip('. ')
    if not s or s in ('-', '—'):
        return ''
    # обрывки вида "Органы дыхания 0,000008" — числовой хвост отбрасываем
    s = re.sub(r'[\s,]*[\d.,]+\s*$', '', s).strip()
    if not s:
        return ''
    key = s.lower().replace('ё', 'е').rstrip('. ')
    if key in _ORGAN_ALIASES:
        return _ORGAN_ALIASES[key]
    return s[0].upper() + s[1:]

def _pfloat(v):
    try:
        return float(str(v).replace(',', '.'))
    except Exception:
        return None


# ── Общие расчётные константы и коэффициенты Р 2.1.10.3968-23 ────────────
# Одно определение на весь бэкенд: раньше TW/Wc/CR считались по-разному
# в веб-таблицах, Word-отчёте и Excel-выгрузке.
BW_IR = 3.5  # BW/IR = 70 кг / 20 м³·сут⁻¹; URi = SFi / BW_IR


def get_tw(rfc):
    """Табл. 3.7 Р 2.1.10.3968-23 (в отчётах её нумеруют «таблица 4») —
    весовой коэффициент TW по RfC, мг/м³. Шкала именно по RfC, не по RfD;
    нижняя ступень — 100 000."""
    rfc = _pfloat(rfc)
    if not rfc or rfc <= 0: return 0
    if rfc > 1.75:     return 1
    if rfc > 0.175:    return 10
    if rfc > 0.0175:   return 100
    if rfc > 0.00175:  return 1000
    if rfc > 0.000175: return 10000
    return 100000


def get_wc(sfi, iarc='', epa=''):
    """Табл. 3.6 Р 2.1.10.3968-23 (в отчётах — «таблица 3») — Wc по SFi
    мг/(кг·сут) и группе канцерогенности.
    Руководство требует брать НАИБОЛЕЕ ЖЁСТКУЮ группу из МАИР / CLP / U.S.EPA,
    поэтому смотрим обе классификации. При неизвестной группе берём мягкую
    (2B/2/C) — иначе Wc завышался бы в 10 раз на пустом поле."""
    sf = _pfloat(sfi)
    if not sf or sf <= 0: return 0
    ia = str(iarc or '').strip().upper()
    ep = str(epa  or '').strip().upper()
    high = ia in ('1', '1A', '1B', '2A') or ep in ('A', 'B1', 'B2', 'B')
    if sf < 0.005:  return 10      if high else 1
    if sf < 0.05:   return 100     if high else 10
    if sf < 0.5:    return 1000    if high else 100
    if sf < 5:      return 10000   if high else 1000
    if sf < 50:     return 100000  if high else 10000
    return 1000000  # > 50: обе группы


def get_uri(sub):
    """Единичный риск URi, (мг/м³)⁻¹. Поле 'uri' хранит SFi, 'uri_r' — готовый URi."""
    ur = _pfloat(sub.get('uri_r'))
    if ur: return ur
    sfi = _pfloat(sub.get('uri'))
    return sfi / BW_IR if sfi else None


def canon_organs(value):
    """Разбирает поле органов в список канонических имён.
    Запятые внутри скобок разделителями не считаются."""
    if not value:
        return []
    parts, buf, depth = [], '', 0
    for ch in str(value):
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth = max(0, depth - 1)
        if ch in ',;' and depth == 0:
            parts.append(buf); buf = ''
        else:
            buf += ch
    parts.append(buf)
    out = []
    for p in parts:
        c = _canon_organ(p)
        if c and c not in out:
            out.append(c)
    return out


# CAS-справочник (П1.2+П1.3+П1.4 из Р 2.1.10.3968-23) — fallback для веществ не в _RFC_DATA
_CAS_RFC_PATH = os.path.join(_BASE_DIR, 'cas_rfc_full.json')
_CAS_RFC_DATA = None  # загружается один раз

def _load_cas_rfc():
    global _CAS_RFC_DATA
    if _CAS_RFC_DATA is not None:
        return _CAS_RFC_DATA
    import json as _j
    try:
        with open(_CAS_RFC_PATH, encoding='utf-8') as f:
            _CAS_RFC_DATA = _j.load(f)
    except Exception:
        _CAS_RFC_DATA = {}
    return _CAS_RFC_DATA

_POLL_JPOL = r'C:\Users\User\AppData\Local\Integral\PEcoCross\POLL.jpol'

def _load_refdb():
    global _REFDB_CACHE
    if _REFDB_CACHE is not None:
        return _REFDB_CACHE
    import json as _json
    refdb = {}
    try:
        with open(_POLL_JPOL, 'rb') as f:
            raw = f.read()
        if raw.startswith(b'\xef\xbb\xbf'):
            raw = raw[3:]
        polls = _json.loads(raw.decode('utf-8'))['POLL']
        for key, v in polls.items():
            code = v.get('CODE')
            if not code:
                continue
            name = v.get('NAME', '')
            short = name.split('(')[0].strip() if '(' in name else name
            ext = _RFC_DATA.get(code, {})
            pdkm = v.get('PDKM') or 0
            pdks = v.get('PDKS') or 0
            pdkg = v.get('PDKG') or 0
            obuv = v.get('OBUV') or 0
            # CAS: сначала _RFC_DATA, затем таблица кодов — иначе CAS-справочник
            # для большинства веществ вообще не запрашивается (в POLL.jpol CAS нет)
            cas_str = ext.get('cas', '') or _CODE_CAS.get(code, '')
            cas_db  = _load_cas_rfc().get(cas_str, {}) if cas_str else {}
            # Приоритет: _RFC_DATA > CAS-справочник > авто из ПДК
            def _pick(key, cas_key=None):
                if key in ext and ext[key] != '':
                    return ext[key]
                ck = cas_key or key
                cv = cas_db.get(ck)
                if cv is not None:
                    return str(cv)
                return ''
            # RfC берётся ТОЛЬКО из П1.3 (_RFC_DATA / CAS-справочник).
            # ПДК и ОБУВ — гигиенические нормативы, а не референтные концентрации:
            # подставляя их, программа тянула в HQ/HI вещества, которые методика
            # прямо исключает («отсутствуют референтные концентрации»).
            # Значение можно ввести вручную в таблице конфигурации.
            rfc_val = '' if ext.get('no_rfc') else _pick('rfc')
            refdb[str(code)] = {
                'name': short,
                'name_full': name,
                'pdk_mr':  ext.get('pdk_mr', '') or (str(pdkm) if pdkm else ''),
                'pdk_ss':  ext.get('pdk_ss', '') or (str(pdks) if pdks else ''),
                'pdk_sg':  ext.get('pdk_sg', '') or (str(pdkg) if pdkg else ''),
                'pdk_obv': ext.get('pdk_obv', '') or (str(obuv) if obuv else ''),
                'hazard_class': str(v.get('CLASS', '')) if v.get('CLASS') else '',
                'cas':       cas_str,
                'rfc':       rfc_val,
                # Для arfci приоритет у cas_rfc_full.json (более точный источник)
                'arfci':     str(cas_db['arfci']) if cas_db.get('arfci') is not None else _pick('arfci'),
                # SFi (фактор канцерогенного потенциала, Р 2.1.10.3968-23, П1.4)
                # поле называется 'uri' в коде, но заполняется из sfi JSON
                'uri':       str(cas_db['sfi'])   if cas_db.get('sfi')   is not None else _pick('uri'),
                'organ_chr': ', '.join(canon_organs(_pick('organ_chr'))),
                'organ_acu': ', '.join(canon_organs(_pick('organ_acu'))),
                'lim':       ext.get('lim', ''),
                # Группы канцерогенности нужны для Wc: без них берётся мягкая
                # колонка табл. 3 и Wc занижается в 10 раз
                'iarc':      ext.get('iarc', '') or (cas_db.get('iarc') or ''),
                'epa':       ext.get('epa', '') or (cas_db.get('epa') or ''),
                'uri_r':     str(cas_db['uri']) if cas_db.get('uri') is not None else '',
                'no_rfc':    bool(ext.get('no_rfc')),
            }
    except Exception as e:
        pass
    _REFDB_CACHE = refdb
    return refdb


@app.route('/api/refdb')
def api_refdb():
    return jsonify(_load_refdb())

@app.route('/api/cas-lookup')
def api_cas_lookup():
    """Поиск RFC/ARFCi/URi по CAS номеру (из П1.2+П1.3+П1.4 Р 2.1.10.3968-23)"""
    cas = request.args.get('cas', '').strip()
    if not cas:
        return jsonify({})
    db = _load_cas_rfc()
    rec = db.get(cas)
    if not rec:
        return jsonify({})
    rec = dict(rec)
    rec['organ_chr'] = ', '.join(canon_organs(rec.get('organ_chr')))
    rec['organ_acu'] = ', '.join(canon_organs(rec.get('organ_acu')))
    return jsonify(rec)


# ── Routes ───────────────────────────────────────────────────────────────
# Страницу отдаёт основной статик-сервер СЗЗ-Инструмента (вкладка «Оценка
# риска» в index.html) — здесь своего HTML больше нет, только API.

@app.route('/api/parse', methods=['POST'])
def api_parse():
    tmps = {}
    names = {}
    season_name = {'zima': 'зима', 'leto': 'лето', 'sred': 'сред'}
    try:
        for key in ('zima', 'leto', 'sred'):
            f = request.files.get(key)
            if not f:
                return jsonify({'error': f'Файл «{key}» не загружен'}), 400
            names[key] = f.filename or key
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.docx')
            f.save(tmp.name); tmp.close(); tmps[key] = tmp.name

        # Разбираем каждый файл отдельно — если конкретный файл не Word
        # (чужое расширение, битый .docx, или вообще не выгрузка УПРЗА),
        # ошибка должна называть ЕГО по имени и по сезону, а не всплывать
        # как путь к безымянному временному файлу, непонятный пользователю
        parsed = {}
        for key in ('zima', 'leto', 'sred'):
            try:
                parsed[key] = parse_word(tmps[key])
            except Exception as e:
                return jsonify({'error':
                    f'Файл «{names[key]}» (слот «{season_name[key]}») не открылся как Word-документ '
                    f'(.docx) — проверьте, что выбран правильный файл выгрузки УПРЗА «Эколог», '
                    f'а не PDF/Excel или повреждённый .docx. ({e})'}), 400
        cz, nz, pz = parsed['zima']
        cl, nl, pl = parsed['leto']
        cs, ns, ps = parsed['sred']

        # координаты расчётных точек — из любого файла, где они есть
        points_xy = {}
        for pd in (ps, pl, pz):
            for k, v in pd.items():
                points_xy.setdefault(str(k), v)

        # объединяем названия из всех трёх файлов
        all_names = {}
        for nd in (nz, nl, ns):
            for k, v in nd.items():
                if k not in all_names and v:
                    all_names[k] = v

        # группы суммации (коды >= 6000) исключаем — это не отдельные вещества
        def is_substance(kod):
            try: return int(kod) < 6000
            except: return False

        cmax = {}
        for kod in set(list(cz) + list(cl)):
            if not is_substance(kod): continue
            pts = set(list(cz.get(kod, {})) + list(cl.get(kod, {})))
            cmax[str(kod)] = {
                str(p): max(cz.get(kod, {}).get(p, 0), cl.get(kod, {}).get(p, 0))
                for p in pts
            }
        cavg = {str(k): {str(p): v for p, v in d.items()}
                for k, d in cs.items() if is_substance(k)}
        pts_acu = sorted({int(p) for d in cmax.values() for p in d})
        pts_chr = sorted({int(p) for d in cavg.values() for p in d})

        # Сырые значения по каждому файлу отдельно (до объединения в cmax/
        # cavg) — чтобы можно было посмотреть, что именно было в зиме/лете/
        # сред по каждому веществу и точке, а не только итоговый результат
        raw_zima = {str(k): {str(p): v for p, v in d.items()} for k, d in cz.items() if is_substance(k)}
        raw_leto = {str(k): {str(p): v for p, v in d.items()} for k, d in cl.items() if is_substance(k)}
        raw_sred = {str(k): {str(p): v for p, v in d.items()} for k, d in cs.items() if is_substance(k)}

        # все коды из файлов, отсортированные (без групп суммации)
        all_codes = sorted({int(k) for k in list(cmax) + list(cavg)})

        # ── Проверки согласованности выгрузки ───────────────────────────
        # Три файла должны считаться по ОДНОМУ и тому же набору расчётных
        # точек — иначе их объединение (cmax = max(зима,лето), cavg = сред)
        # молча смешивает несопоставимые наборы. Расхождение почти всегда
        # значит: загружен не тот файл, либо один из сезонов пересчитывался
        # с другой конфигурацией точек. Предупреждение не блокирует расчёт —
        # он часто нужен и с неполными данными, но пользователь должен знать.
        warnings = []

        def _pts_of(d):
            return {int(p) for v in d.values() for p in v}
        # Не просто «есть/нет», а СКОЛЬКО веществ дало данные по точке в этом
        # файле — по голому факту присутствия точки не видно, одно вещество
        # за неё отвечает или все тридцать; расхождение в количестве между
        # файлами — куда более красноречивый сигнал, чем галочка
        def _pts_count(d):
            cnt = {}
            for kod_dict in d.values():
                for p in kod_dict:
                    pi = int(p)
                    cnt[pi] = cnt.get(pi, 0) + 1
            return cnt
        cnt_zima, cnt_leto, cnt_sred = _pts_count(cz), _pts_count(cl), _pts_count(cs)
        seasons = [('зима', _pts_of(cz)), ('лето', _pts_of(cl)), ('сред', _pts_of(cs))]
        all_seen = seasons[0][1] | seasons[1][1] | seasons[2][1]
        if all_seen and not (seasons[0][1] == seasons[1][1] == seasons[2][1]):
            for name, pts in seasons:
                missing = sorted(all_seen - pts)
                if not missing:
                    continue
                sample = ', '.join(str(p) for p in missing[:15])
                more = f' и ещё {len(missing) - 15}' if len(missing) > 15 else ''
                warnings.append(
                    f'Файл «{name}»: нет данных по {len(missing)} точкам, которые есть в других '
                    f'файлах ({sample}{more}). Похоже, файлы считаны по разным наборам точек — '
                    f'проверьте, что зима/лето/сред относятся к одному расчёту.')

        # Точки без координат в выгрузке — в отчёте у них будут прочерки
        all_pts = sorted(set(pts_acu) | set(pts_chr))
        no_coords = [p for p in all_pts if str(p) not in points_xy]
        if no_coords:
            sample = ', '.join(str(p) for p in no_coords[:15])
            more = f' и ещё {len(no_coords) - 15}' if len(no_coords) > 15 else ''
            warnings.append(
                f'У {len(no_coords)} из {len(all_pts)} точек нет координат в выгрузке '
                f'({sample}{more}) — в отчёте у них будут прочерки вместо X/Y.')

        return jsonify({
            'cmax': cmax, 'cavg': cavg,
            'points_acu': pts_acu, 'points_chr': pts_chr,
            'sub_names': {str(k): v for k, v in all_names.items()},
            'all_codes': all_codes,
            'points_xy': points_xy,
            'warnings': warnings,
            # Сколько веществ дало данные по каждой точке — отдельно по
            # зима/лето/сред, чтобы можно было сверить вручную, а не только
            # получить текст предупреждения о расхождении. {точка: число}
            'points_by_file': {
                'zima': {str(p): n for p, n in cnt_zima.items()},
                'leto': {str(p): n for p, n in cnt_leto.items()},
                'sred': {str(p): n for p, n in cnt_sred.items()},
            },
            # Сырые значения по каждому веществу и точке — отдельно по
            # зима/лето/сред, до объединения в cmax/cavg
            'raw_zima': raw_zima, 'raw_leto': raw_leto, 'raw_sred': raw_sred,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500
    finally:
        for p in tmps.values():
            try: os.unlink(p)
            except: pass


# ── Импорт выбросов из Excel ──────────────────────────────────────────────
def _xl_num(v):
    """Число из ячейки: понимает float, '1,8', '1.8E-02', пробелы/NBSP как разделители."""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace('\xa0', '').replace(' ', '').replace(',', '.')
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None


def _xl_code(v):
    """Код вещества (целое 1…5999). Коды ≥ 6000 — группы суммации, пропускаем."""
    n = _xl_num(v)
    if n is None:
        return None
    k = int(round(n))
    return k if 1 <= k < 6000 else None


@app.route('/api/parse_emissions', methods=['POST'])
def api_parse_emissions():
    """Импорт валовых выбросов (т/год) из Excel.
    Автоопределяет столбец кода вещества и столбец выброса по заголовкам.
    Строки с одинаковым кодом суммируются (несколько источников на одно вещество).
    Возвращает {emissions:{kod:т/год}, names:{kod:наименование}, rows:N, sheet:'…'}.
    """
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'Файл не загружен'}), 400
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx')
    try:
        f.save(tmp.name); tmp.close()
        wb = openpyxl.load_workbook(tmp.name, data_only=True, read_only=True)

        def find_code_col(cells):
            # приоритет: «код вещества/в-ва/ЗВ/загр.», затем любой «код» кроме источника
            for i, t in enumerate(cells):
                if 'код' in t and any(k in t for k in ('вещест', 'в-ва', 'зв', 'загр')):
                    return i
            for i, t in enumerate(cells):
                if 'код' in t and 'источник' not in t and 'выброс' not in t:
                    return i
            return None

        def find_emis_col(cells):
            # приоритет т/год; затем валовый; затем «выброс»/«масса»/«г/с»
            for kw in ('т/год', 'т/г', 'валов', 'выброс', 'масса', 'г/с'):
                for i, t in enumerate(cells):
                    if kw in t:
                        return i
            return None

        emissions, names, matched, used_sheet = {}, {}, 0, None
        for ws in wb.worksheets:
            rows = list(ws.iter_rows(values_only=True))
            if not rows:
                continue
            hdr_idx = c_code = c_emis = c_name = None
            for ri, row in enumerate(rows[:30]):
                cells = [str(c).lower() if c is not None else '' for c in row]
                cc = find_code_col(cells)
                ce = find_emis_col(cells)
                if cc is not None and ce is not None and cc != ce:
                    hdr_idx, c_code, c_emis = ri, cc, ce
                    c_name = next((i for i, t in enumerate(cells)
                                   if 'наимен' in t or 'вещество' in t), None)
                    break
            if hdr_idx is None:
                continue
            for row in rows[hdr_idx + 1:]:
                if c_code >= len(row) or c_emis >= len(row):
                    continue
                # пропускаем строку нумерации столбцов («1 2 3 … 9») и итоги:
                # у настоящего вещества наименование — текст, а не число/пусто
                if c_name is not None and c_name < len(row):
                    nm_cell = row[c_name]
                    if nm_cell is None or str(nm_cell).strip() == '' or _xl_num(nm_cell) is not None:
                        continue
                kod = _xl_code(row[c_code])
                if kod is None:
                    continue
                em = _xl_num(row[c_emis])
                if em is None:
                    continue
                ks = str(kod)
                emissions[ks] = emissions.get(ks, 0.0) + em
                if c_name is not None and c_name < len(row) and row[c_name]:
                    nm = re.sub(r'\s+', ' ', str(row[c_name])).strip()
                    if nm and ks not in names:
                        names[ks] = nm
                matched += 1
            if emissions:
                used_sheet = ws.title
                break  # берём первый лист с распознанными данными
        wb.close()
        if not emissions:
            return jsonify({'error': 'Не найдены столбцы «Код вещества» и «Выброс, т/год». '
                                     'Проверьте формат файла или скачайте шаблон.'}), 400
        return jsonify({'emissions': emissions, 'names': names,
                        'rows': matched, 'sheet': used_sheet})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500
    finally:
        try: os.unlink(tmp.name)
        except: pass


@app.route('/api/emissions_template')
def api_emissions_template():
    """Шаблон Excel для импорта выбросов."""
    wb = openpyxl.Workbook()
    ws = wb.active; ws.title = 'Выбросы'
    heads = ['Код вещества', 'Наименование', 'Выброс, т/год']
    for c, h in enumerate(heads, 1):
        cell = ws.cell(1, c, h)
        cell.font = Font(bold=True)
        cell.fill = PatternFill('solid', fgColor='D9D9D9')
        cell.alignment = Alignment(horizontal='center', vertical='center')
    for row in ([301, 'Азота диоксид (Азот (IV) оксид)', 12.5],
                [304, 'Азот (II) оксид (Азота оксид)', 2.031],
                [330, 'Сера диоксид', 5.14],
                [2908, 'Пыль неорганическая: 70-20% SiO2', 0.87]):
        ws.append(row)
    for col, w in (('A', 14), ('B', 34), ('C', 16)):
        ws.column_dimensions[col].width = w
    buf = io.BytesIO(); wb.save(buf); buf.seek(0)
    return send_file(buf, as_attachment=True, download_name='Шаблон_выбросы.xlsx',
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


@app.route('/api/export_report', methods=['POST'])
def api_export_report():
    try:
        data = request.get_json(force=True)
        buf  = io.BytesIO()
        _build_word(data).save(buf)
        buf.seek(0)
        return send_file(buf, as_attachment=True,
                         download_name='Таблицы_оценка_риска.docx',
                         mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/export', methods=['POST'])
def api_export():
    try:
        data = request.get_json(force=True)
        buf = io.BytesIO()
        _build_excel(data).save(buf)
        buf.seek(0)
        return send_file(buf, as_attachment=True, download_name='Риски.xlsx',
                         mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ── Word report builder ──────────────────────────────────────────────────
def _build_word(data):
    from docx import Document as DocxDoc
    from docx.shared import Pt, Cm
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL

    subs       = sorted(data.get('subs', []), key=lambda s: int(s.get('kod') or 0))
    cmax       = data.get('cmax', {})
    cavg       = data.get('cavg', {})
    emis       = data.get('emissions', {})
    pts_a      = [int(p) for p in data.get('points_acu', [])]
    pts_c      = [int(p) for p in data.get('points_chr', [])]
    population = float(data.get('population') or 0)

    def pf(v):
        try: return float(str(v).replace(',', '.'))
        except: return None

    def fe(v):
        n = pf(v)
        if n is None: return '-'
        if n == 0:    return '0.00E+00'
        return f'{n:.2E}'

    def fn(v, d=4):
        if v is None or str(v).strip() in ('', '-', '—'): return '-'
        n = pf(v)
        if n is None: return str(v)
        if n == 0:    return '0'
        return f'{float(f"{n:.{d}g}")}'

    def fmt_pct(pct):
        if pct is None: return '-'
        if pct >= 0.1:  return f'{pct:.1f}%'
        if pct >= 0.01: return f'{pct:.2f}%'
        if pct > 0:
            import math
            d = -int(math.floor(math.log10(pct)))  # знаков после запятой до первой значащей цифры
            return f'{pct:.{d}f}%'
        return '0%'

    ACUTE = sorted([s for s in subs if pf(s.get('arfci')) and not s.get('skip_risk')], key=lambda s: int(s.get('kod') or 0))
    CHRON = sorted([s for s in subs if pf(s.get('rfc'))   and not s.get('skip_risk')], key=lambda s: int(s.get('kod') or 0))
    CANC  = sorted([s for s in subs if get_uri(s)         and not s.get('skip_risk')], key=lambda s: int(s.get('kod') or 0))

    def get_organs(s, key):
        return canon_organs(s.get(key, ''))

    def hq_acu_v(kod, pt):
        s = next((x for x in subs if str(x['kod']) == str(kod)), None)
        a = pf(s['arfci']) if s else None
        if not a: return None
        c = pf(cmax.get(str(kod), {}).get(str(pt)))
        return c / a if c is not None else None

    def hq_chr_v(kod, pt):
        s = next((x for x in subs if str(x['kod']) == str(kod)), None)
        r = pf(s['rfc']) if s else None
        if not r: return None
        c = pf(cavg.get(str(kod), {}).get(str(pt)))
        return c / r if c else 0

    def cr_v(kod, pt):
        s = next((x for x in subs if str(x['kod']) == str(kod)), None)
        if not s: return None
        # CR = LADD × SFi = Cavg × URi, где URi = SFi / (BW/IR)
        uri_r = get_uri(s)
        if not uri_r: return None
        c = pf(cavg.get(str(kod), {}).get(str(pt)))
        return c * uri_r if c is not None else None

    def max_acu(kod):
        vals = [hq_acu_v(kod, pt) for pt in pts_a]
        vals = [v for v in vals if v is not None]
        return max(vals) if vals else None

    def max_chr(kod):
        vals = [hq_chr_v(kod, pt) for pt in pts_c]
        vals = [v for v in vals if v is not None]
        return max(vals) if vals else 0

    def max_cr(kod):
        vals = [cr_v(kod, pt) for pt in pts_c]
        vals = [v for v in vals if v is not None]
        return max(vals) if vals else None

    def hi_pt_acu(org, pt):
        return sum((hq_acu_v(str(s['kod']), pt) or 0)
                   for s in ACUTE if org in get_organs(s, 'organ_acu'))

    def hi_pt_chr(org, pt):
        return sum((hq_chr_v(str(s['kod']), pt) or 0)
                   for s in CHRON if org in get_organs(s, 'organ_chr'))

    # HRi = E × TW × P / 10000  (Р 2.1.10.3968-23, раздел 1.7)
    def hri_val(s):
        em  = pf(emis.get(str(s['kod'])))
        rfc = pf(s.get('rfc'))
        if not em or not rfc: return 0
        return em * get_tw(rfc) * population / 10000

    total_em  = sum(pf(emis.get(str(s['kod']))) or 0 for s in subs)
    total_hri = sum(hri_val(s) for s in CHRON)

    # ─── helpers ────────────────────────────────────────────────────────
    doc = DocxDoc()
    for sec in doc.sections:
        sec.top_margin    = Cm(2);  sec.bottom_margin = Cm(2)
        sec.left_margin   = Cm(2);  sec.right_margin  = Cm(1.5)
    doc.styles['Normal'].font.name = 'Times New Roman'
    doc.styles['Normal'].font.size = Pt(10)

    def shade(cell, color):
        tc   = cell._tc
        tcPr = tc.get_or_add_tcPr()
        shd  = OxmlElement('w:shd')
        shd.set(qn('w:val'),   'clear')
        shd.set(qn('w:color'), 'auto')
        shd.set(qn('w:fill'),  color)
        tcPr.append(shd)

    def sc(cell, text, bold=False, center=True, bg=None, sz=9, wrap=False):
        p = cell.paragraphs[0]
        p.clear()
        run = p.add_run('' if text is None else str(text))
        run.font.size = Pt(sz); run.font.bold = bold
        run.font.name = 'Times New Roman'
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER if center else WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_before = Pt(1)
        p.paragraph_format.space_after  = Pt(1)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        if bg: shade(cell, bg)

    def set_col_widths(tbl, widths_cm):
        for ci, w in enumerate(widths_cm):
            for cell in tbl.columns[ci].cells:
                cell.width = Cm(w)

    def make_row(tbl, cells_data, bg=None, bold=False):
        row = tbl.add_row()
        row.height_rule = 1  # exact
        for ci, v in enumerate(cells_data):
            kwargs = dict(bold=bold, center=True, bg=bg)
            if isinstance(v, dict):
                kwargs.update(v); v = kwargs.pop('text', '-')
            sc(row.cells[ci], v, **kwargs)
        return row

    def heading(text, lvl=3):
        p = doc.add_heading('', level=lvl)
        run = p.add_run(text)
        run.font.name = 'Times New Roman'
        run.font.size = Pt(11)
        run.bold = True
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after  = Pt(3)

    # ═══════════════════════════════════════════════════════════════════
    # ТАБЛИЦА 1 — Качественный и количественный состав выбросов
    # ═══════════════════════════════════════════════════════════════════
    from collections import defaultdict

    heading('Таблица 1.4.1 — Качественный и количественный состав выбросов загрязняющих веществ')
    t141 = doc.add_table(rows=0, cols=10)
    t141.style = 'Table Grid'; t141.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t141, ['код', 'наименование', 'ПДК м/р\nмг/м³', 'ПДК с/с\nмг/м³', 'ПДК с/г\nмг/м³',
                    'ОБУВ\nмг/м³', 'Класс\nопасности', 'Суммарный\nвыброс, т/год',
                    'Вклад, %', 'Ранг'], bg='D9D9D9', bold=True)
    # Ранжируются только вещества с ненулевым выбросом: иначе вещество без
    # данных получало номер в ранжировании при прочерке в графе выброса
    em_ranks = {s['kod']: rnk for rnk, s in enumerate(
        sorted([s for s in subs if pf(emis.get(str(s['kod'])))],
               key=lambda s: pf(emis.get(str(s['kod']))) or 0, reverse=True), 1)}
    for s in subs:
        em = pf(emis.get(str(s['kod'])))
        vk = fmt_pct(em / total_em * 100) if (em and total_em) else '-'
        make_row(t141, [str(s.get('kod','')), s.get('name',''), fn(s.get('pdk_mr')),
                        fn(s.get('pdk_ss')), fn(s.get('pdk_sg')),
                        fn(s.get('pdk_obv')), str(s.get('hazard_class','-')),
                        fn(em, 6) if em else '-', vk, str(em_ranks.get(s['kod'], '-'))])
    set_col_widths(t141, [1.1, 3.8, 1.2, 1.2, 1.2, 1.2, 1.1, 1.8, 1.3, 0.8])

    if CANC:
        doc.add_paragraph()
        heading('Таблица 1.5.1 — Сведения о показателях опасности развития канцерогенных эффектов')
        t151 = doc.add_table(rows=0, cols=7)
        t151.style = 'Table Grid'; t151.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t151, ['Код', 'Наименование вещества', 'CAS',
                        'МАИР', 'U.S.EPA', 'Россия',
                        'SFi\n(мг/(кг·сут))⁻¹'], bg='D9D9D9', bold=True)
        for s in CANC:
            make_row(t151, [str(s.get('kod','')), s.get('name',''), s.get('cas','-'),
                            s.get('iarc','-') or '-', s.get('epa','-') or '-', '-',
                            fn(s.get('uri'), 4)])
        set_col_widths(t151, [1.0, 4.0, 1.5, 1.0, 1.2, 1.2, 1.8])

    # ═══════════════════════════════════════════════════════════════════
    # ТАБЛИЦА 2 — Структура выбросов по классам опасности
    # ═══════════════════════════════════════════════════════════════════
    doc.add_paragraph()
    p_cap = doc.add_paragraph()
    run_cap = p_cap.add_run('Структура выбросов по классам опасности')
    run_cap.bold = True; run_cap.font.name = 'Times New Roman'; run_cap.font.size = Pt(10)
    t4cls = doc.add_table(rows=0, cols=4)
    t4cls.style = 'Table Grid'; t4cls.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t4cls, ['Класс опасности', 'Количество веществ', 'Валовый выброс, т/год', 'Вклад, %'],
             bg='D9D9D9', bold=True)
    cls_em = defaultdict(float); cls_cnt = defaultdict(int)
    for s in subs:
        cl = str(s.get('hazard_class', '') or 'Не установлен')
        em = pf(emis.get(str(s['kod']))) or 0
        cls_em[cl] += em; cls_cnt[cl] += 1
    for cl in sorted(cls_em.keys()):
        vk = fmt_pct(cls_em[cl] / total_em * 100) if total_em else '-'
        make_row(t4cls, [cl, str(cls_cnt[cl]), fn(cls_em[cl], 6), vk])
    set_col_widths(t4cls, [3.5, 3.0, 4.5, 3.0])

    # ═══════════════════════════════════════════════════════════════════
    # ТАБЛИЦА 3 — Показатели опасности (RFC и ARFCi)
    # ═══════════════════════════════════════════════════════════════════
    doc.add_paragraph()
    heading('Таблица 1.6.1 — Показатели опасности химических веществ')
    t161 = doc.add_table(rows=0, cols=8)
    t161.style = 'Table Grid'; t161.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t161, ['№', 'код', 'наименование', 'CAS', 'RFC,\nмг/м³', 'Критический эффект\n(хроническое)',
                    'ARFC,\nмг/м³', 'Критический эффект\n(острое)'], bg='D9D9D9', bold=True)
    for i, s in enumerate(subs, 1):
        make_row(t161, [str(i), str(s.get('kod','')), s.get('name',''), s.get('cas','-'),
                        fn(s.get('rfc')), ', '.join(get_organs(s, 'organ_chr')) or '-',
                        fn(s.get('arfci')), ', '.join(get_organs(s, 'organ_acu')) or '-'])
    set_col_widths(t161, [0.6, 1.0, 3.5, 1.4, 1.2, 2.8, 1.2, 2.8])

    all_organs_c = list(dict.fromkeys(o for s in CHRON for o in (get_organs(s, 'organ_chr') or [])))
    all_organs_a = list(dict.fromkeys(o for s in ACUTE for o in (get_organs(s, 'organ_acu') or [])))
    all_organs   = list(dict.fromkeys(all_organs_c + all_organs_a))
    if all_organs:
        doc.add_paragraph()
        heading('Таблица 1.6.2 — Критические органы/системы')
        t162 = doc.add_table(rows=0, cols=4)
        t162.style = 'Table Grid'; t162.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t162, ['Критические органы/системы',
                        'Хроническое воздействие\n(перечень веществ)', 'Кол-во',
                        'Острое воздействие\n(перечень веществ)'],
                 bg='D9D9D9', bold=True)
        for org in all_organs:
            chr_subs = [s.get('name','') for s in CHRON if org in get_organs(s, 'organ_chr') and s.get('name','').strip()]
            acu_subs = [s.get('name','') for s in ACUTE if org in get_organs(s, 'organ_acu') and s.get('name','').strip()]
            if not chr_subs and not acu_subs:
                continue  # не показываем строку без веществ
            make_row(t162, [org,
                            ', '.join(chr_subs) if chr_subs else '-',
                            str(len(chr_subs)) if chr_subs else '-',
                            ', '.join(acu_subs) if acu_subs else '-'])
        set_col_widths(t162, [3.5, 6.0, 0.8, 4.0])

    doc.add_paragraph()
    heading('Таблица 3 — Весовые коэффициенты для оценки канцерогенных эффектов (Wc) (Р 2.1.10.3968-23)')
    t3wc = doc.add_table(rows=0, cols=3)
    t3wc.style = 'Table Grid'; t3wc.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t3wc, ['Фактор канцерогенного потенциала SF,\nмг/(кг·сут)',
                    'Wc (группы 1, 2А по МАИР;\n1А, 1В по CLP; А, В1/В2 по U.S.EPA)',
                    'Wc (группа 2В по МАИР;\n2 по CLP; С по U.S.EPA)'], bg='D9D9D9', bold=True)
    for sf, wc_hi, wc_lo in [('< 0,005',       '10',        '1'),
                               ('0,005 – 0,05',  '100',       '10'),
                               ('0,05 – 0,5',    '1 000',     '100'),
                               ('0,5 – 5',       '10 000',    '1 000'),
                               ('5 – 50',        '100 000',   '10 000'),
                               ('> 50',          '1 000 000', '1 000 000')]:
        make_row(t3wc, [sf, wc_hi, wc_lo])
    set_col_widths(t3wc, [4.5, 5.5, 4.0])

    doc.add_paragraph()
    heading('Таблица 4 — Весовые коэффициенты для расчёта индекса опасности HRi (Р 2.1.10.3968-23)')
    t3tw = doc.add_table(rows=0, cols=3)
    t3tw.style = 'Table Grid'; t3tw.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t3tw, ['Референтная доза RfD,\nмг/кг', 'Референтная концентрация RfC,\nмг/м³',
                    'Весовой коэффициент TW'], bg='D9D9D9', bold=True)
    for rfd, rfc_r, tw_v in [('< 0,00005',          '< 0,000175',            '100 000'),
                              ('0,00005 – 0,0005',   '0,000175 – 0,00175',   '10 000'),
                              ('0,0005 – 0,005',     '0,00175 – 0,0175',     '1 000'),
                              ('0,005 – 0,05',       '0,0175 – 0,175',       '100'),
                              ('0,05 – 0,5',         '0,175 – 1,75',         '10'),
                              ('> 0,5',              '> 1,75',               '1')]:
        make_row(t3tw, [rfd, rfc_r, tw_v])
    set_col_widths(t3tw, [4.5, 5.5, 4.0])

    doc.add_paragraph()
    p_label = f' (P = {int(population)} чел.)' if population else ''
    heading(f'Таблица 1.7.1 — Ранжирование выбросов по степени токсических свойств (HRi){p_label}')
    t171 = doc.add_table(rows=0, cols=13)
    t171.style = 'Table Grid'; t171.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t171, ['№', 'Код', 'CAS', 'Наименование', 'ПДКм.р\nмг/м³', 'ПДКсс\nмг/м³',
                    'ПДКсг\nмг/м³', 'ОБУВ\nмг/м³', 'RFCi\nмг/м³', 'Выброс\nт/год',
                    'HRIн', 'Вклад\nΣHRIн,%', 'Ранг'], bg='D9D9D9', bold=True)
    hri_ranked = {s['kod']: rnk for rnk, s in enumerate(
        sorted([s for s in subs if pf(s.get('rfc')) and not s.get('skip_risk') and pf(emis.get(str(s['kod'])))],
               key=hri_val, reverse=True), 1)}
    def hric_val(s):
        em = pf(emis.get(str(s['kod'])))
        wc = get_wc(s.get('uri'), s.get('iarc'), s.get('epa'))
        if not em or not wc: return 0
        return em * wc * population / 10000

    canc_score = hric_val  # для совместимости
    canc_ranked = {s['kod']: rnk for rnk, s in enumerate(
        sorted([s for s in subs if pf(s.get('uri')) and not s.get('skip_risk') and pf(emis.get(str(s['kod'])))],
               key=hric_val, reverse=True), 1)}
    for nn, s in enumerate(subs, 1):
        em = pf(emis.get(str(s['kod']))); rfc = pf(s.get('rfc')); hv = hri_val(s)
        vk = fmt_pct(hv / total_hri * 100) if (hv and total_hri) else '-'
        rnk_str = str(hri_ranked[s['kod']]) if s['kod'] in hri_ranked else '-'
        # «№» — порядковый номер строки, «Ранг» — место по величине HRi;
        # раньше в обеих графах печаталось одно и то же
        make_row(t171, [str(nn), str(s.get('kod','')), s.get('cas','-'), s.get('name',''),
                        fn(s.get('pdk_mr')), fn(s.get('pdk_ss')),
                        fn(s.get('pdk_sg')), fn(s.get('pdk_obv')),
                        fn(rfc) if rfc else '-', fn(em, 6) if em else '-',
                        fn(hv, 4) if hv else '-', vk, rnk_str])
    set_col_widths(t171, [0.6, 1.0, 1.3, 3.0, 1.1, 1.1, 1.1, 1.1, 1.1, 1.5, 1.3, 1.3, 0.8])

    doc.add_paragraph()
    heading('Таблица 1.7.2 — Ранжирование выбросов химических веществ в атмосферный воздух по индексам сравнительной канцерогенной опасности (HRIc)')
    canc_subs = [s for s in subs if pf(s.get('uri')) and not s.get('skip_risk') and pf(emis.get(str(s['kod'])))]
    total_hric = sum(hric_val(s) for s in canc_subs)
    t172 = doc.add_table(rows=0, cols=10)
    t172.style = 'Table Grid'; t172.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t172, ['Ранг', 'Код', 'CAS', 'Наименование', 'МАИР / U.S.EPA',
                    'SFi\n(мг/(кг·сут))⁻¹', 'Wc', 'Выброс\nт/год',
                    'HRIc', 'Вклад\nΣHRIc,%'],
             bg='D9D9D9', bold=True)
    for s in sorted(canc_subs, key=hric_val, reverse=True):
        em   = pf(emis.get(str(s['kod'])))
        sfi  = pf(s.get('uri'))
        wc   = get_wc(sfi, s.get('iarc'), s.get('epa'))
        hric = hric_val(s)
        vk   = fmt_pct(hric / total_hric * 100) if total_hric else '-'
        rnk  = str(canc_ranked.get(s['kod'], '-'))
        grp  = ' / '.join(x for x in (s.get('iarc'), s.get('epa')) if x) or '-'
        make_row(t172, [rnk, str(s.get('kod','')), s.get('cas','-'), s.get('name',''), grp,
                        fn(sfi, 4), str(wc) if wc else '-', fn(em, 6), fn(hric, 4), vk])
    set_col_widths(t172, [0.7, 1.0, 1.5, 3.3, 1.3, 1.3, 1.0, 1.3, 1.3, 1.3])

    doc.add_paragraph()
    heading('Таблица 1.8.1 — Приоритетные химические вещества, загрязняющие окружающую среду')
    t181 = doc.add_table(rows=0, cols=4)
    t181.style = 'Table Grid'; t181.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t181, ['Вещество', 'CAS',
                    'Принадлежность к\nперечням U.S.EPA',
                    'Принадлежность к\nперечням РФ'], bg='D9D9D9', bold=True)
    for s in subs:
        # Перечней приоритетных веществ в справочнике нет — оставляем пусто.
        # Печатать «-» нельзя: это утверждение «вещество не входит ни в один
        # перечень», что для NO2, аммиака, бенз/а/пирена и др. неверно.
        make_row(t181, [s.get('name',''), s.get('cas','-'), '', ''])
    set_col_widths(t181, [5.5, 1.8, 3.5, 3.5])
    note = doc.add_paragraph()
    nr = note.add_run('Примечание: принадлежность к перечням приоритетных и особо '
                      'опасных веществ заполняется вручную по действующим перечням '
                      'U.S.EPA и РФ.')
    nr.font.size = Pt(8); nr.font.italic = True; nr.font.name = 'Times New Roman'

    doc.add_paragraph()
    heading('Таблица 1.8.2 — Обоснование выбора приоритетных химических веществ для оценки риска')
    t182 = doc.add_table(rows=0, cols=7)
    t182.style = 'Table Grid'; t182.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t182, ['Код', 'Наименование вещества', 'CAS',
                    'Канцерогены\n(+/-)', 'Ранг канц\n(HRIc)',
                    'Неканцерогены\n(ранг HRI)', 'Валовый\nвыброс (ранг)'],
             bg='D9D9D9', bold=True)
    for s in subs:
        is_canc  = bool(pf(s.get('uri')) and not s.get('skip_risk'))
        canc_mark = '+' if is_canc else '-'
        cr_rank  = str(canc_ranked[s['kod']]) if s['kod'] in canc_ranked else '-'
        nk_rank  = str(hri_ranked[s['kod']]) if s['kod'] in hri_ranked else '-'
        em_rank  = str(em_ranks.get(s['kod'], '-'))
        make_row(t182, [str(s.get('kod','')), s.get('name',''), s.get('cas','-'),
                        canc_mark, cr_rank, nk_rank, em_rank])
    set_col_widths(t182, [1.0, 4.0, 1.5, 1.2, 1.8, 2.0, 1.8])

    doc.add_paragraph()
    heading('Таблица 2.1.1 — Гигиеническая характеристика химических веществ')
    t211 = doc.add_table(rows=0, cols=9)
    t211.style = 'Table Grid'; t211.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t211, ['Код', 'CAS', 'Наименование', 'ПДКмр\nмг/м³', 'ПДКсс\nмг/м³', 'ПДКсг\nмг/м³',
                    'ОБУВ\nмг/м³', 'Класс\nопасности', 'Лимитирующий\nпоказатель'],
             bg='D9D9D9', bold=True)
    for s in subs:
        make_row(t211, [str(s.get('kod','')), s.get('cas','-'), s.get('name',''),
                        fn(s.get('pdk_mr')), fn(s.get('pdk_ss')),
                        fn(s.get('pdk_sg')), fn(s.get('pdk_obv')),
                        str(s.get('hazard_class','-')), s.get('lim','-') or '-'])
    set_col_widths(t211, [1.1, 1.4, 3.5, 1.2, 1.2, 1.2, 1.2, 1.1, 2.6])

    # ═══════════════════════════════════════════════════════════════════
    # ТАБЛИЦА 7 — Острый риск: HQ по веществам на СЗЗ
    # ═══════════════════════════════════════════════════════════════════
    if all_organs_c and CHRON:
        doc.add_paragraph()
        heading('Таблица 2.2.1 — Показатели опасности хронического ингаляционного воздействия (RfC)')
        t221 = doc.add_table(rows=0, cols=6)
        t221.style = 'Table Grid'; t221.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t221, ['№', 'код', 'наименование', 'CAS', 'RFC, мг/м³', 'Критический эффект'],
                 bg='D9D9D9', bold=True)
        for i, s in enumerate(CHRON, 1):
            make_row(t221, [str(i), str(s.get('kod','')), s.get('name',''), s.get('cas','-'),
                            fn(s.get('rfc')), ', '.join(get_organs(s, 'organ_chr')) or '-'])
        set_col_widths(t221, [0.6, 1.0, 4.0, 1.5, 1.3, 6.1])

        doc.add_paragraph()
        heading('Таблица 2.2.2 — Критические органы/системы при хроническом воздействии')
        t222 = doc.add_table(rows=0, cols=3)
        t222.style = 'Table Grid'; t222.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t222, ['Критические органы/системы', 'Хроническое воздействие\n(наименование вещества)',
                        'Количество веществ с\nоднонаправленным действием'], bg='D9D9D9', bold=True)
        for org in all_organs_c:
            o_subs = [s.get('name','') for s in CHRON if org in (get_organs(s, 'organ_chr') or [])]
            make_row(t222, [org, ', '.join(o_subs), str(len(o_subs))])
        set_col_widths(t222, [4.0, 7.5, 2.5])

    if CANC:
        doc.add_paragraph()
        heading('Таблица 2.3.4 — Сведения о параметрах опасности для оценки канцерогенного риска')
        t234 = doc.add_table(rows=0, cols=7)
        t234.style = 'Table Grid'; t234.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t234, ['Код', 'Наименование вещества', 'CAS',
                        'МАИР', 'U.S.EPA',
                        'SFi\n(мг/(кг·сут))⁻¹', 'URi\n(риск на\n1 мг/м³)'],
                 bg='D9D9D9', bold=True)
        for s in CANC:
            make_row(t234, [str(s.get('kod','')), s.get('name',''), s.get('cas','-'),
                            s.get('iarc','-') or '-', s.get('epa','-') or '-',
                            fn(s.get('uri'), 4), fn(s.get('uri_r'), 4)])
        set_col_widths(t234, [1.0, 4.0, 1.5, 1.0, 1.2, 1.8, 1.8])

    # Таблица 2.4.1 — Максимальные дозы канцерогенов D = Cavg × IR/BW × 1000
    # IR=20 м³/сут, BW=70 кг → 20/70×1000 = 285.71 мкг/кг·сут на 1 мг/м³
    DOSE_FACTOR = 20 / 70 * 1000  # мкг/кг·сут на 1 мг/м³
    if CANC and pts_c:
        doc.add_paragraph()
        heading('Таблица 2.4.1 — Максимальные дозы химических веществ (канцерогенов) '
                'при ингаляционном воздействии, мкг/(кг·сут)')
        n_ca2 = 1 + len(CANC)
        t241 = doc.add_table(rows=0, cols=n_ca2)
        t241.style = 'Table Grid'; t241.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t241, ['№ точки'] + [f'{s["kod"]}\n{s.get("name","")}' for s in CANC],
                 bg='D9D9D9', bold=True)
        for pt in pts_c:
            row_vals = []
            for s in CANC:
                c = pf(cavg.get(str(s['kod']), {}).get(str(pt)))
                row_vals.append(fe(c * DOSE_FACTOR) if c is not None else '-')
            make_row(t241, [str(pt)] + row_vals)
        max_dose = []
        for s in CANC:
            vals = [pf(cavg.get(str(s['kod']), {}).get(str(pt))) for pt in pts_c]
            mv = max((v for v in vals if v is not None), default=None)
            max_dose.append(fe(mv * DOSE_FACTOR) if mv is not None else '-')
        make_row(t241, ['СЗЗ MAX'] + max_dose, bold=True)
        set_col_widths(t241, [2.0] + [max(1.8, 12 / max(len(CANC), 1))] * len(CANC))

    doc.add_paragraph()
    heading('Таблица 3.2.1 — Классификация уровней риска (Р 2.1.10.3968-23)')
    t321 = doc.add_table(rows=0, cols=4)
    t321.style = 'Table Grid'; t321.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t321, ['Уровень риска', 'Индивидуальный\nпожизненный риск',
                    'HQ для отдельных\nвеществ',
                    'HI для группы веществ\nс однонаправленным действием'],
             bg='D9D9D9', bold=True)
    for lvl, cr_r, hq_r, hi_r in [
        ('Высокий',                '> 1×10⁻³',              '> 3',       '> 6'),
        ('Настораживающий',        '1,1×10⁻⁴ – 1,0×10⁻³',   '1,1 – 3',   '3,1 – 6'),
        ('Допустимый (приемлемый)', '1,1×10⁻⁶ – 1,0×10⁻⁴',  'менее 1,0', '1,1 – 3,0'),
        ('Минимальный',            '1,0×10⁻⁶ и менее',      '0,1 и менее', '1,0 и менее'),
    ]:
        make_row(t321, [lvl, cr_r, hq_r, hi_r])
    set_col_widths(t321, [4.0, 3.6, 2.7, 3.7])

    all_pts = sorted(set(pts_a + pts_c))
    doc.add_paragraph()
    heading('Таблица 3.2.2 — Расчётные точки')
    t322 = doc.add_table(rows=0, cols=5)
    t322.style = 'Table Grid'; t322.alignment = WD_TABLE_ALIGNMENT.CENTER
    make_row(t322, ['№', 'X, м', 'Y, м', 'Высота, м', 'Тип точки'], bg='D9D9D9', bold=True)
    coords = data.get('points_xy') or {}
    for pt in all_pts:
        c = coords.get(str(pt)) or coords.get(pt) or {}
        # «на границе СЗЗ» по умолчанию подставлять нельзя — это утверждение
        # о типе точки, а не просто дырка в данных. Если координат для точки
        # не нашлось в выгрузке, честно показываем, что тип неизвестен,
        # а не додумываем классификацию
        make_row(t322, [str(pt), fn(c.get('x'), 9), fn(c.get('y'), 9),
                        fn(c.get('h'), 4), c.get('type') or 'нет данных в файле'])
    set_col_widths(t322, [1.0, 2.5, 2.5, 2.5, 5.0])

    # Таблица 3.2.3 — СКОЛЬКО веществ дало данные по каждой точке в каждом из
    # трёх файлов, и вошла ли точка в итоговый расчёт (острые/хронич.). Число,
    # а не галочка — по нему видно не просто «есть точка или нет», а реальное
    # расхождение между зима/лето/сред (29 веществ в одном файле и 12 в
    # другом на той же точке — повод проверить файлы руками).
    pbf = data.get('points_by_file') or {}
    cnt_zima = {int(p): int(n) for p, n in pbf.get('zima', {}).items()}
    cnt_leto = {int(p): int(n) for p, n in pbf.get('leto', {}).items()}
    cnt_sred = {int(p): int(n) for p, n in pbf.get('sred', {}).items()}
    if cnt_zima or cnt_leto or cnt_sred:
        doc.add_paragraph()
        heading('Таблица 3.2.3 — Расчётные точки по файлам: число веществ, давших '
                'данные по точке (зима / лето / сред)')
        all_pts2 = sorted(set(cnt_zima) | set(cnt_leto) | set(cnt_sred) | set(pts_a) | set(pts_c))
        t323 = doc.add_table(rows=0, cols=6)
        t323.style = 'Table Grid'; t323.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t323, ['№', 'Зима', 'Лето', 'Сред', 'Острые МР', 'Хронич. СР'],
                 bg='D9D9D9', bold=True)
        mark = lambda ok: '✓' if ok else '—'
        num  = lambda n: str(n) if n else '—'
        for pt in all_pts2:
            make_row(t323, [str(pt), num(cnt_zima.get(pt, 0)), num(cnt_leto.get(pt, 0)),
                            num(cnt_sred.get(pt, 0)), mark(pt in pts_a), mark(pt in pts_c)])
        set_col_widths(t323, [1.5, 2.0, 2.0, 2.0, 2.5, 2.5])

    # Таблица 3.2.4 — построчно по каждой точке и каждому веществу: что было
    # в зиме/лете/сред и что из этого реально попало в расчёт (Cmax = max
    # (зима,лето), Cavg = сред). Самая подробная из диагностических таблиц —
    # по ней видно конкретное число, а не только то, что точка «есть».
    raw_zima = {str(k): {str(p): v for p, v in d.items()} for k, d in (data.get('raw_zima') or {}).items()}
    raw_leto = {str(k): {str(p): v for p, v in d.items()} for k, d in (data.get('raw_leto') or {}).items()}
    raw_sred = {str(k): {str(p): v for p, v in d.items()} for k, d in (data.get('raw_sred') or {}).items()}
    if raw_zima or raw_leto or raw_sred:
        name_by_kod = {str(s.get('kod')): s.get('name', '') for s in subs}
        all_kods = sorted(set(raw_zima) | set(raw_leto) | set(raw_sred), key=lambda k: int(k) if k.isdigit() else 0)
        doc.add_paragraph()
        heading('Таблица 3.2.4 — Концентрации по веществам и точкам: зима / лето / сред '
                'и что взято в расчёт')
        t324 = doc.add_table(rows=0, cols=7)
        t324.style = 'Table Grid'; t324.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t324, ['№ точки', 'Код', 'Вещество', 'Зима', 'Лето', 'Сред',
                        'Cmax / Cavg\n(использовано)'], bg='D9D9D9', bold=True)
        for kod in all_kods:
            z, l, s = raw_zima.get(kod, {}), raw_leto.get(kod, {}), raw_sred.get(kod, {})
            pts_k = sorted({int(p) for p in list(z) + list(l) + list(s)})
            for pt in pts_k:
                zv, lv, sv = z.get(str(pt)), l.get(str(pt)), s.get(str(pt))
                cmax_v = max(v for v in (zv, lv) if v is not None) if (zv is not None or lv is not None) else None
                make_row(t324, [str(pt), kod, name_by_kod.get(kod, kod),
                                fe(zv) if zv is not None else '-', fe(lv) if lv is not None else '-',
                                fe(sv) if sv is not None else '-',
                                f'{fe(cmax_v)} / {fe(sv)}'])
        set_col_widths(t324, [1.2, 1.0, 3.5, 1.8, 1.8, 1.8, 2.5])

    # ═══════════════════════════════════════════════════════════════════
    # РАЗДЕЛ 4.2 — Канцерогенный риск
    # ═══════════════════════════════════════════════════════════════════
    if CANC and pts_c:
        max_vals   = [max_cr(str(s['kod'])) for s in CANC]
        tcr_max    = sum(v or 0 for v in max_vals)
        cr_ranks   = {s['kod']: rnk for rnk, s in enumerate(
            sorted(CANC, key=lambda s: max_cr(str(s['kod'])) or 0, reverse=True), 1)}

        # Table 4.2.1 — максимальные значения CR на границе СЗЗ + суммарный риск
        n_ca  = 2 + len(CANC)  # +1 для «Суммарный риск»
        col_w = [2.5] + [max(1.6, 11 / max(len(CANC), 1))] * len(CANC) + [2.2]

        doc.add_paragraph()
        heading('Таблица 4.2.1 — Максимальные значения индивидуального канцерогенного риска '
                'в расчётных точках')
        t421c = doc.add_table(rows=0, cols=n_ca)
        t421c.style = 'Table Grid'; t421c.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t421c,
                 ['Расчётные\nточки'] + [f'{s["kod"]}\n{s.get("cas","-")}' for s in CANC] + ['Суммарный\nриск'],
                 bg='D9D9D9', bold=True)
        make_row(t421c, [''] + [s.get('name','') for s in CANC] + [''], bg='D9D9D9', bold=False)
        make_row(t421c,
                 ['На границе СЗЗ'] + [fe(max_cr(str(s['kod']))) for s in CANC] + [fe(tcr_max)],
                 bold=True)
        set_col_widths(t421c, col_w)

        # Table 4.2.2 — CR по всем расчётным точкам + суммарный риск
        doc.add_paragraph()
        heading('Таблица 4.2.2 — Значения индивидуального канцерогенного риска в расчётных точках')
        t422c = doc.add_table(rows=0, cols=n_ca)
        t422c.style = 'Table Grid'; t422c.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t422c,
                 ['Расчётные\nточки'] + [f'{s["kod"]}\n{s.get("cas","-")}' for s in CANC] + ['Суммарный\nриск'],
                 bg='D9D9D9', bold=True)
        make_row(t422c, [''] + [s.get('name','') for s in CANC] + [''], bg='D9D9D9', bold=False)
        for pt in pts_c:
            cr_pt = [cr_v(str(s['kod']), pt) for s in CANC]
            cr_sum = sum(v for v in cr_pt if v is not None)
            make_row(t422c, [str(pt)] + [fe(v) for v in cr_pt] + [fe(cr_sum)])
        make_row(t422c,
                 ['СЗЗ MAX'] + [fe(v) for v in max_vals] + [fe(tcr_max)],
                 bold=True)
        set_col_widths(t422c, col_w)

        doc.add_paragraph()
        heading('Таблица 4.2.3 — Ранжирование веществ по канцерогенному риску')
        t423c = doc.add_table(rows=0, cols=7)
        t423c.style = 'Table Grid'; t423c.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t423c, ['Ранг', 'Код', 'CAS', 'Наименование', 'URi, (мг/м³)⁻¹',
                         'CR на границе СЗЗ', 'Вклад в ΣCR,%'], bg='D9D9D9', bold=True)
        # таблица ранжирования — строки по убыванию риска, а не по коду
        for s in sorted(CANC, key=lambda x: max_cr(str(x['kod'])) or 0, reverse=True):
            mv     = max_cr(str(s['kod'])) or 0
            vk     = fmt_pct(mv / tcr_max * 100) if tcr_max else '-'
            uri_rv = get_uri(s)
            make_row(t423c, [str(cr_ranks.get(s['kod'], '-')), str(s.get('kod','')),
                             s.get('cas','-'), s.get('name',''),
                             fn(uri_rv, 6), fe(mv), vk])
        set_col_widths(t423c, [0.7, 1.0, 1.3, 4.0, 1.8, 2.0, 1.7])

        # Таблица 4.2.4 — Популяционный канцерогенный риск (только если задано население)
        if population:
            doc.add_paragraph()
            heading(f'Таблица 4.2.4 — Популяционный канцерогенный риск '
                    f'(P = {int(population)} чел.)')
            t424c = doc.add_table(rows=0, cols=5)
            t424c.style = 'Table Grid'; t424c.alignment = WD_TABLE_ALIGNMENT.CENTER
            make_row(t424c, ['Код', 'Наименование вещества', 'CAS',
                             'CR индивид.\n(на границе СЗЗ)',
                             'Популяционный\nканцерогенный риск\n(CR × P)'],
                     bg='D9D9D9', bold=True)
            for s in CANC:
                mv  = max_cr(str(s['kod'])) or 0
                pcr = mv * population
                make_row(t424c, [str(s.get('kod','')), s.get('name',''), s.get('cas','-'),
                                 fe(mv), fn(pcr, 4)])
            make_row(t424c, ['', 'ИТОГО', '', fe(tcr_max), fn(tcr_max * population, 4)],
                     bold=True)
            set_col_widths(t424c, [1.0, 4.5, 1.5, 2.5, 3.5])

    # ═══════════════════════════════════════════════════════════════════
    # РАЗДЕЛ 4.3 — Острое ингаляционное воздействие
    # ═══════════════════════════════════════════════════════════════════
    if ACUTE and pts_a:
        doc.add_paragraph()
        heading('Таблица 4.3.1 — Коэффициенты опасности острого ингаляционного воздействия на границе СЗЗ')
        t431a = doc.add_table(rows=0, cols=6)
        t431a.style = 'Table Grid'; t431a.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t431a, ['№', 'Код', 'Наименование', 'CAS', 'ARFC, мг/м³', 'На границе СЗЗ'],
                 bg='D9D9D9', bold=True)
        for i, s in enumerate(ACUTE, 1):
            make_row(t431a, [str(i), str(s.get('kod','')), s.get('name',''), s.get('cas','-'),
                             fn(s.get('arfci')), fe(max_acu(str(s['kod'])))])
        set_col_widths(t431a, [0.6, 1.0, 4.0, 1.5, 1.8, 2.0])

        doc.add_paragraph()
        heading('Таблица 4.3.2 — Коэффициенты опасности (HQ) по расчётным точкам (острое воздействие)')
        n_a  = 1 + len(ACUTE)
        t432a = doc.add_table(rows=0, cols=n_a)
        t432a.style = 'Table Grid'; t432a.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t432a, ['№ точки'] + [f'{s["kod"]}\n{s.get("name","")}' for s in ACUTE],
                 bg='D9D9D9', bold=True)
        for pt in pts_a:
            make_row(t432a, [str(pt)] + [fe(hq_acu_v(str(s['kod']), pt)) for s in ACUTE])
        make_row(t432a, ['СЗЗ MAX'] + [fe(max_acu(str(s['kod']))) for s in ACUTE], bold=True)
        set_col_widths(t432a, [1.5] + [max(1.8, 12 / max(len(ACUTE), 1))] * len(ACUTE))

        organs_a  = list(dict.fromkeys(o for s in ACUTE for o in get_organs(s, 'organ_acu')))
        if organs_a:
            doc.add_paragraph()
            heading('Таблица 4.3.3 — Коэффициенты опасности (HQ) по критическим органам/системам (острое воздействие)')
            t433a = doc.add_table(rows=0, cols=1 + len(organs_a))
            t433a.style = 'Table Grid'; t433a.alignment = WD_TABLE_ALIGNMENT.CENTER
            make_row(t433a, ['№ точки'] + organs_a, bg='D9D9D9', bold=True)
            for pt in pts_a:
                make_row(t433a, [str(pt)] + [fe(hi_pt_acu(o, pt)) for o in organs_a])
            hi_max_a = {o: max(hi_pt_acu(o, pt) for pt in pts_a) for o in organs_a}
            make_row(t433a, ['СЗЗ MAX'] + [fe(hi_max_a[o]) for o in organs_a], bold=True)
            set_col_widths(t433a, [1.5] + [max(2.5, 12 / max(len(organs_a), 1))] * len(organs_a))

            doc.add_paragraph()
            heading('Таблица 4.3.4 — Индексы опасности (HI) на границе СЗЗ (острое воздействие)')
            t434a = doc.add_table(rows=0, cols=3)
            t434a.style = 'Table Grid'; t434a.alignment = WD_TABLE_ALIGNMENT.CENTER
            make_row(t434a, ['Критические органы/системы', 'На границе СЗЗ', 'Ранг'],
                     bg='D9D9D9', bold=True)
            for rnk2, o in enumerate(sorted(organs_a, key=lambda x: hi_max_a[x], reverse=True), 1):
                make_row(t434a, [o, fe(hi_max_a[o]), str(rnk2)])
            set_col_widths(t434a, [8.0, 3.5, 1.5])

    # ═══════════════════════════════════════════════════════════════════
    # РАЗДЕЛ 4.4 — Хроническое ингаляционное воздействие
    # ═══════════════════════════════════════════════════════════════════
    if CHRON and pts_c:
        doc.add_paragraph()
        heading('Таблица 4.4.1 — Коэффициенты опасности хронического ингаляционного воздействия на границе СЗЗ')
        t441c = doc.add_table(rows=0, cols=7)
        t441c.style = 'Table Grid'; t441c.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t441c, ['№', 'Код', 'Наименование', 'CAS', 'RFC, мг/м³',
                         'Критический эффект', 'На границе СЗЗ'], bg='D9D9D9', bold=True)
        for i, s in enumerate(CHRON, 1):
            eff = ', '.join(get_organs(s, 'organ_chr')) or '-'
            make_row(t441c, [str(i), str(s.get('kod','')), s.get('name',''), s.get('cas','-'),
                             fn(s.get('rfc')), eff, fe(max_chr(str(s['kod'])))])
        set_col_widths(t441c, [0.6, 1.0, 3.2, 1.4, 1.2, 3.2, 2.0])

        doc.add_paragraph()
        heading('Таблица 4.4.2 — Коэффициенты опасности (HQ) по расчётным точкам (хроническое воздействие)')
        n_c  = 1 + len(CHRON)
        t442c = doc.add_table(rows=0, cols=n_c)
        t442c.style = 'Table Grid'; t442c.alignment = WD_TABLE_ALIGNMENT.CENTER
        make_row(t442c, ['№ точки'] + [f'{s["kod"]}\n{s.get("name","")}' for s in CHRON],
                 bg='D9D9D9', bold=True)
        for pt in pts_c:
            make_row(t442c, [str(pt)] + [fe(hq_chr_v(str(s['kod']), pt)) for s in CHRON])
        make_row(t442c, ['СЗЗ MAX'] + [fe(max_chr(str(s['kod']))) for s in CHRON], bold=True)
        set_col_widths(t442c, [1.5] + [max(1.8, 12 / max(len(CHRON), 1))] * len(CHRON))

        organs_c = list(dict.fromkeys(o for s in CHRON for o in get_organs(s, 'organ_chr')))
        if organs_c:
            doc.add_paragraph()
            heading('Таблица 4.4.3 — Коэффициенты опасности (HQ) по критическим органам/системам (хроническое воздействие)')
            t443c = doc.add_table(rows=0, cols=1 + len(organs_c))
            t443c.style = 'Table Grid'; t443c.alignment = WD_TABLE_ALIGNMENT.CENTER
            make_row(t443c, ['№ точки'] + organs_c, bg='D9D9D9', bold=True)
            for pt in pts_c:
                make_row(t443c, [str(pt)] + [fe(hi_pt_chr(o, pt)) for o in organs_c])
            hi_max_c = {o: max(hi_pt_chr(o, pt) for pt in pts_c) for o in organs_c}
            make_row(t443c, ['СЗЗ MAX'] + [fe(hi_max_c[o]) for o in organs_c], bold=True)
            set_col_widths(t443c, [1.5] + [max(2.5, 12 / max(len(organs_c), 1))] * len(organs_c))

            doc.add_paragraph()
            heading('Таблица 4.4.4 — Индексы опасности (HI) на границе СЗЗ (хроническое воздействие)')
            t444c = doc.add_table(rows=0, cols=3)
            t444c.style = 'Table Grid'; t444c.alignment = WD_TABLE_ALIGNMENT.CENTER
            make_row(t444c, ['Критические органы/системы', 'На границе СЗЗ', 'Ранг'],
                     bg='D9D9D9', bold=True)
            for rnk3, o in enumerate(sorted(organs_c, key=lambda x: hi_max_c[x], reverse=True), 1):
                make_row(t444c, [o, fe(hi_max_c[o]), str(rnk3)])
            set_col_widths(t444c, [8.0, 3.5, 1.5])

    return doc


# ── Excel builder ────────────────────────────────────────────────────────
def _brd():
    s = Side(style='thin', color='000000')
    return Border(left=s, right=s, top=s, bottom=s)

_YEL = PatternFill('solid', fgColor='FFFF00')
_GRY = PatternFill('solid', fgColor='D9D9D9')
_WHT = PatternFill('solid', fgColor='FFFFFF')
_GRN = PatternFill('solid', fgColor='E2EFDA')


def _cell(ws, r, c, v=None, fill=None, bold=False, fmt=None, ha='center'):
    fill = fill or _WHT
    cc = ws.cell(r, c, v)
    cc.border = _brd(); cc.fill = fill
    cc.alignment = Alignment(horizontal=ha, vertical='center')
    cc.font = Font(bold=bold, size=10)
    if fmt and isinstance(v, (int, float)):
        cc.number_format = fmt
    return cc


def _fcell(ws, r, c, f, fill=None, bold=False, fmt='0.00E+00'):
    fill = fill or _WHT
    cc = ws.cell(r, c, f)
    cc.border = _brd(); cc.fill = fill
    cc.alignment = Alignment(horizontal='center', vertical='center')
    cc.font = Font(bold=bold, size=10); cc.number_format = fmt
    return cc


def _cw(ws, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _hi_block(ws, items, cols, first_row, pts, base, hq_slot, organ_key):
    """Дописывает справа блок «HI по критическим органам».

    items    — кортежи (код, имя, RfC/ARfC, поле органов)
    cols     — {код: кортеж номеров столбцов вещества}
    hq_slot  — индекс столбца HQ внутри этого кортежа
    first_row— строка первой расчётной точки
    base     — первый свободный столбец справа от блоков веществ

    Орган берётся как отдельная позиция из поля (вещество влияет на несколько),
    HI = сумма HQ в пределах ОДНОЙ точки, затем максимум по точкам.
    """
    organs = []
    for it in items:
        for o in canon_organs(it[organ_key]):
            if o not in organs:
                organs.append(o)
    if not organs or not pts:
        return

    _cell(ws, first_row - 1, base, 'Точка', _GRY, bold=True)
    for oi, org in enumerate(organs):
        _cell(ws, first_row - 1, base + 1 + oi, org, _GRY, bold=True)
    _cw_from(ws, base, [7] + [max(11, min(20, len(o) + 2)) for o in organs])

    for i, pt in enumerate(pts):
        r = first_row + i
        _cell(ws, r, base, pt, _GRY)
        for oi, org in enumerate(organs):
            refs = [f'{get_column_letter(cols[it[0]][hq_slot])}{r}'
                    for it in items if org in canon_organs(it[organ_key])]
            _fcell(ws, r, base + 1 + oi,
                   '=SUM(%s)' % ','.join(refs) if refs else '=0')

    r_max = first_row + len(pts)
    _cell(ws, r_max, base, 'СЗЗ MAX', _GRN, bold=True)
    for oi, org in enumerate(organs):
        col = get_column_letter(base + 1 + oi)
        _fcell(ws, r_max, base + 1 + oi,
               f'=MAX({col}{first_row}:{col}{first_row + len(pts) - 1})',
               _GRN, bold=True)


def _cw_from(ws, start_col, widths):
    for i, w in enumerate(widths):
        ws.column_dimensions[get_column_letter(start_col + i)].width = w


def _build_excel(data):
    subs   = data.get('subs', [])
    cmax   = data.get('cmax', {})
    cavg   = data.get('cavg', {})
    emis   = data.get('emissions', {})
    pts_a  = data.get('points_acu', [])
    pts_c  = data.get('points_chr', [])

    ACUTE = [(s['kod'], s['name'], float(s['arfci']), s.get('organ_acu'))
             for s in subs if s.get('arfci')]
    CHRON = [(s['kod'], s['name'], float(s['rfc']),   s.get('organ_chr'))
             for s in subs if s.get('rfc')]

    wb = openpyxl.Workbook()

    # ── лист: острые мр ─────────────────────────────────────────────────
    wsA = wb.active; wsA.title = 'острые мр'
    col_a = {}; base = 2
    for kod, nm, arfci, oa in ACUTE:
        col_a[kod] = (base, base+1, base+2, base+3); base += 4
    _cw(wsA, [5] + [8, 14, 14, 3] * len(ACUTE))

    _cell(wsA, 1, 1, None, _GRY)
    for kod, nm, arfci, oa in ACUTE:
        cp, cc2, ch, cg = col_a[kod]
        _cell(wsA, 1, cp,  kod,   _GRY, bold=True)
        _cell(wsA, 1, cc2, arfci, _YEL, fmt='0.0')
        _cell(wsA, 1, ch,  None,  _GRY)
        _cell(wsA, 1, cg,  None,  _GRY)

    for i, pt in enumerate(pts_a):
        r = 2 + i
        _cell(wsA, r, 1, None, _WHT)
        for kod, nm, arfci, oa in ACUTE:
            cp, cc2, ch, cg = col_a[kod]
            raw = cmax.get(str(kod), {}).get(str(pt))
            v = float(raw) if raw is not None else None
            _cell(wsA, r, cp,  pt, _GRY)
            _cell(wsA, r, cc2, v,  _YEL, fmt='0.000E+00')
            ar = f'{get_column_letter(cc2)}1'
            cr = f'{get_column_letter(cc2)}{r}'
            _fcell(wsA, r, ch, f'=IF({cr}="","",{cr}/{ar})', fmt='0.00E+00')
            _cell(wsA, r, cg, None)

    # ── HI по критическим органам (острое воздействие) ──────────────────
    # Вещество может влиять на несколько органов: поле разбирается в список,
    # а не сравнивается целой строкой. HI аддитивен ВНУТРИ расчётной точки,
    # максимум берётся по точкам — сумма максимумов из разных точек не HI.
    _hi_block(wsA, ACUTE, col_a, 2, pts_a, base, hq_slot=2, organ_key=3)

    # ── лист: хронические ср ────────────────────────────────────────────
    wsH = wb.create_sheet('Хронические ср')
    col_h = {}; base = 2
    for kod, nm, rfc, oh in CHRON:
        col_h[kod] = (base, base+1, base+2); base += 3
    _cw(wsH, [7] + [14, 14, 3] * len(CHRON))

    _cell(wsH, 1, 1, 'По средним', _GRY, bold=True)
    for c in range(2, base): _cell(wsH, 1, c, None, _GRY)
    _cell(wsH, 2, 1, None, _GRY)
    for kod, nm, rfc, oh in CHRON:
        cv, ch, cg = col_h[kod]
        _cell(wsH, 2, cv, kod, _GRY, bold=True)
        _cell(wsH, 2, ch, rfc, _YEL, fmt='0.0###')
        _cell(wsH, 2, cg, None, _GRY)

    for i, pt in enumerate(pts_c):
        r = 3 + i
        _cell(wsH, r, 1, pt, _GRY)
        for kod, nm, rfc, oh in CHRON:
            cv, ch, cg = col_h[kod]
            raw = cavg.get(str(kod), {}).get(str(pt))
            v = float(raw) if raw is not None else None
            _cell(wsH, r, cv, v, _YEL, fmt='0.00E+00')
            rf = f'{get_column_letter(ch)}2'
            cf = f'{get_column_letter(cv)}{r}'
            _fcell(wsH, r, ch, f'=IF(OR({cf}="",{cf}=0),0,{cf}/{rf})', fmt='0.00E+00')
            _cell(wsH, r, cg, None)

    n = len(pts_c)
    r_max = 3 + n
    _cell(wsH, r_max, 1, 'HQ макс', _GRY, bold=True)
    for kod, nm, rfc, oh in CHRON:
        cv, ch, cg = col_h[kod]
        col = get_column_letter(ch)
        _cell(wsH, r_max, cv, None, _GRY)
        _fcell(wsH, r_max, ch, f'=MAX({col}3:{col}{2+n})', _GRN, bold=True)
        _cell(wsH, r_max, cg, None, _GRY)

    # ── HI по критическим органам (хроническое воздействие) ─────────────
    _hi_block(wsH, CHRON, col_h, 3, pts_c, base, hq_slot=1, organ_key=3)

    # ── лист: канцерогенный риск ─────────────────────────────────────────
    # Раньше этого листа не было вообще — CR считался только в вебе и в
    # Word, в Excel посчитать/проверить было нельзя. CR = Cavg × URi,
    # URi = SFi / 3.5 (П1.4 Р 2.1.10.3968-23) — в отличие от HQ, здесь
    # УМНОЖЕНИЕ, а не деление.
    CANC = [(s['kod'], s['name'], get_uri(s), s.get('organ_chr'))
            for s in subs if get_uri(s) and not s.get('skip_risk')]
    if CANC and pts_c:
        wsC = wb.create_sheet('Канц. риск')
        col_c = {}; base = 2
        for kod, nm, uri, oc in CANC:
            col_c[kod] = (base, base+1, base+2); base += 3
        _cw(wsC, [7] + [14, 14, 3] * len(CANC))

        _cell(wsC, 1, 1, 'По средним (URi)', _GRY, bold=True)
        for c in range(2, base): _cell(wsC, 1, c, None, _GRY)
        _cell(wsC, 2, 1, None, _GRY)
        for kod, nm, uri, oc in CANC:
            cv, ch, cg = col_c[kod]
            _cell(wsC, 2, cv, kod, _GRY, bold=True)
            _cell(wsC, 2, ch, uri, _YEL, fmt='0.000###')
            _cell(wsC, 2, cg, None, _GRY)

        for i, pt in enumerate(pts_c):
            r = 3 + i
            _cell(wsC, r, 1, pt, _GRY)
            for kod, nm, uri, oc in CANC:
                cv, ch, cg = col_c[kod]
                raw = cavg.get(str(kod), {}).get(str(pt))
                v = float(raw) if raw is not None else None
                _cell(wsC, r, cv, v, _YEL, fmt='0.00E+00')
                rf = f'{get_column_letter(ch)}2'
                cf = f'{get_column_letter(cv)}{r}'
                _fcell(wsC, r, ch, f'=IF(OR({cf}="",{cf}=0),0,{cf}*{rf})', fmt='0.00E+00')
                _cell(wsC, r, cg, None)

        n = len(pts_c)
        r_max = 3 + n
        _cell(wsC, r_max, 1, 'CR макс', _GRY, bold=True)
        for kod, nm, uri, oc in CANC:
            cv, ch, cg = col_c[kod]
            col = get_column_letter(ch)
            _cell(wsC, r_max, cv, None, _GRY)
            _fcell(wsC, r_max, ch, f'=MAX({col}3:{col}{2+n})', _GRN, bold=True)
            _cell(wsC, r_max, cg, None, _GRY)

        # ΣCR по критическим органам — та же логика, что и ΣHI: сумма
        # ВНУТРИ точки, максимум по точкам (не сумма максимумов)
        _hi_block(wsC, CANC, col_c, 3, pts_c, base, hq_slot=1, organ_key=3)

    # ── лист: ранжирование ──────────────────────────────────────────────
    # HRi неканц. = E × TW × P / 10000 (Р 2.1.10.3968-23, раздел 1.7).
    # Раньше здесь считалось E / RfC — другая величина и другие ранги.
    wsR = wb.create_sheet('Ранжирование выб')
    _cw(wsR, [5, 8, 28, 16, 14, 8, 16, 10, 8])
    for c, h in enumerate(['№', 'Код', 'Наименование', 'Выброс E, т/год', 'RFCi, мг/м³',
                           'TW', 'HRi = E×TW×P/10000', 'Вклад ΣHRi, %', 'Ранг'], 1):
        cc = wsR.cell(1, c, h); cc.fill = _GRY; cc.border = _brd()
        cc.font = Font(bold=True, size=10)
        cc.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    wsR.row_dimensions[1].height = 40

    pop = _pfloat(data.get('population')) or 0
    # численность населения — в отдельной ячейке, чтобы формулы пересчитывались
    rp = 2 + len(subs) + 2
    _cell(wsR, rp, 3, 'Численность популяции P, чел.', _GRY, bold=True, ha='left')
    _cell(wsR, rp, 4, pop or None, _YEL, fmt='0')
    pref = f'$D${rp}'

    hri_refs = []
    hri_vals = {}
    for i, s in enumerate(subs):
        kod = s['kod']; r = 2 + i
        rfc = _pfloat(s.get('rfc')) if not s.get('skip_risk') else None
        _cell(wsR, r, 1, i+1, _GRY); _cell(wsR, r, 2, kod, _GRY)
        _cell(wsR, r, 3, s['name'], _GRY, ha='left')
        em_v = _pfloat(emis.get(str(kod)))
        _cell(wsR, r, 4, em_v, _YEL, fmt='0.000')
        if rfc:
            tw = get_tw(rfc)
            _cell(wsR, r, 5, rfc, _YEL, fmt='0.000000')
            _cell(wsR, r, 6, tw, _GRY, fmt='0')
            _fcell(wsR, r, 7, f'=IF(D{r}="","",D{r}*F{r}*{pref}/10000)', fmt='0.000')
            hri_refs.append(f'G{r}')
            hri_vals[kod] = (em_v or 0) * tw * pop / 10000
        else:
            _cell(wsR, r, 5, '-', _GRY); _cell(wsR, r, 6, '-', _GRY)
            _cell(wsR, r, 7, '-', _GRY)

    rs = 2 + len(subs)
    _cell(wsR, rs, 1, 'ИТОГО', _GRY, bold=True)
    for c in range(2, 7): _cell(wsR, rs, c, None, _GRY)
    if hri_refs:
        _fcell(wsR, rs, 7, f'=SUM({",".join(hri_refs)})', _GRN, bold=True, fmt='0.000')
    else:
        _cell(wsR, rs, 7, 0, _GRN, bold=True, fmt='0.000')
    for c in (8, 9): _cell(wsR, rs, c, None, _GRY)

    ranks = {kod: rnk for rnk, (kod, _v) in enumerate(
        sorted(hri_vals.items(), key=lambda kv: kv[1], reverse=True), 1)}
    for i, s in enumerate(subs):
        kod = s['kod']; r = 2 + i
        if kod in hri_vals:
            _fcell(wsR, r, 8, f'=IF($G${rs}=0,0,G{r}/$G${rs}*100)', fmt='0.000')
            _cell(wsR, r, 9, ranks.get(kod), _GRY, fmt='0')
        else:
            _cell(wsR, r, 8, '-', _GRY); _cell(wsR, r, 9, '-', _GRY)

    # ── лист: РТ по файлам (острые/хронич/канц — РАЗДЕЛЬНО) ─────────────
    # Раньше этого листа не было вообще — диагностика «что в каком файле»
    # существовала только в Word. Три отдельные секции, а не одна общая
    # таблица: у каждого вида риска свой список веществ (ARFCi/RFC/SFi) и
    # свои файлы (острые — зима+лето → Cmax; хронич./канц. — только сред →
    # Cavg), смешивать их в одной таблице бессмысленно.
    raw_zima = {str(k): {str(p): v for p, v in dd.items()} for k, dd in (data.get('raw_zima') or {}).items()}
    raw_leto = {str(k): {str(p): v for p, v in dd.items()} for k, dd in (data.get('raw_leto') or {}).items()}
    raw_sred = {str(k): {str(p): v for p, v in dd.items()} for k, dd in (data.get('raw_sred') or {}).items()}
    if raw_zima or raw_leto or raw_sred:
        wsP = wb.create_sheet('РТ по файлам')
        acu_kods  = [str(s['kod']) for s in subs if _pfloat(s.get('arfci')) and not s.get('skip_risk')]
        chr_kods  = [str(s['kod']) for s in subs if _pfloat(s.get('rfc'))   and not s.get('skip_risk')]
        canc_kods = [str(s['kod']) for s in subs if get_uri(s)         and not s.get('skip_risk')]

        def _count_in(raw, kods, pt):
            ptS = str(pt)
            return sum(1 for k in kods if ptS in raw.get(k, {}))

        _cw(wsP, [10, 10, 10, 14])
        row = 1
        def _pbf_section(title, kods, pts, file_labels, raws):
            nonlocal row
            _cell(wsP, row, 1, f'{title} — веществ: {len(kods)}', _GRY, bold=True)
            for c in range(2, 2 + len(file_labels) + 1):
                _cell(wsP, row, c, None, _GRY)
            row += 1
            _cell(wsP, row, 1, '№ точки', _GRY, bold=True)
            for i, lbl in enumerate(file_labels):
                _cell(wsP, row, 2 + i, lbl, _GRY, bold=True)
            _cell(wsP, row, 2 + len(file_labels), 'Используется', _GRY, bold=True)
            row += 1
            if not pts or not kods:
                _cell(wsP, row, 1, 'нет точек/веществ', _WHT)
                row += 2
                return
            for pt in sorted(pts):
                _cell(wsP, row, 1, pt, _WHT)
                any_present = False
                for i, raw in enumerate(raws):
                    n = _count_in(raw, kods, pt)
                    if n: any_present = True
                    _cell(wsP, row, 2 + i, n or None, _WHT, fmt='0')
                _cell(wsP, row, 2 + len(file_labels), '✓' if any_present else '—', _WHT)
                row += 1
            row += 1

        _pbf_section('Острые МР', acu_kods, pts_a, ['Зима', 'Лето'], [raw_zima, raw_leto])
        _pbf_section('Хронические СР', chr_kods, pts_c, ['Сред'], [raw_sred])
        _pbf_section('Канцерогенный риск', canc_kods, pts_c, ['Сред'], [raw_sred])

    return wb


# Запускается потоком из основного app.py СЗЗ-Инструмента (по образцу
# start_proxy_server/proxy.py) — use_reloader=False обязателен: штатный
# перезапуск Flask через os.execv порвал бы процесс приложения на части.
def run_server(port, host='127.0.0.1'):
    # app.run() не отдаёт объект сервера, а без daemon_threads=True поток
    # keep-alive соединения (WebView2 их держит) блокирует выход из
    # процесса на чтении сокета — окно не закрывается нормально, только
    # через диспетчер задач. make_server() — то же, что делает app.run()
    # внутри, но с доступом к серверу до serve_forever().
    from werkzeug.serving import make_server
    srv = make_server(host, port, app, threaded=True)
    srv.daemon_threads = True
    srv.serve_forever()


if __name__ == '__main__':
    # Для разработки вне СЗЗ-Инструмента — отдельным процессом на фикс. порту
    print('\n  Risk API: http://127.0.0.1:5000\n')
    run_server(5000)
