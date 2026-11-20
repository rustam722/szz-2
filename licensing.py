"""
Лицензирование СЗЗ-Инструмента: пробный период + ключ активации (аренда).

Схема (офлайн, без сервера):
  • «Код ПК» (machine_id) — отпечаток железа, его клиент присылает разработчику.
  • Пробный период 14 дней. Дата первого запуска дублируется в реестр и в
    несколько папок, привязана к machine_id; берётся самая ранняя найденная.
    Защита от перевода системных часов назад.
  • Ключ активации подписан Ed25519. В программе зашит только ПУБЛИЧНЫЙ ключ;
    подделать ключ без приватного (он только у разработчика) нельзя.
  • Лицензия — аренда: всегда с датой окончания, привязана к конкретному ПК.

Никакая офлайн-защита не абсолютна (код исполняется на чужом ПК), но эта схема
отсекает переустановку ради сброса пробного, копирование на другой ПК и выпуск
«своих» ключей клиентами.
"""
import os
import sys
import json
import time
import base64
import hashlib
import datetime
import traceback

APP_ID       = 'SZZ-Tool'
TRIAL_DAYS   = 14
_SALT        = b'SZZ-Tool/2026/\x91\x37\xacZ-licensing-v1'   # соль для производных ключей
_REG_PATH    = r'Software\SZZ-Tool'

# Публичный ключ Ed25519 (hex, 64 симв.). Генерируется tools/make_keys.py.
# Приватный ключ в сборку НЕ ПОПАДАЕТ — хранится только у разработчика.
PUBLIC_KEY_HEX = 'fd60652d6e4c0c6ac86bfddff899fa71571d6ca6d16c1a0758892a7151ad7952'

_LOG_CB = None
def set_logger(fn):
    """app.py передаёт свою функцию log(), чтобы писать в общий журнал."""
    global _LOG_CB
    _LOG_CB = fn

def _log(msg):
    try:
        if _LOG_CB:
            _LOG_CB('[lic] ' + msg)
    except Exception:
        pass


# ── Криптопримитивы (cryptography) ───────────────────────────────────────────
try:
    from cryptography.hazmat.primitives.asymmetric import ed25519
    from cryptography.exceptions import InvalidSignature
    from cryptography.fernet import Fernet
    _CRYPTO_OK = True
except Exception as _e:                        # в норме не случается: пакет в сборке
    _CRYPTO_OK = False
    _log('cryptography недоступна: ' + repr(_e))


def _fernet():
    """Симметричный ключ для шифрования локальных записей — производный от
    machine_id, поэтому запись, скопированная на другой ПК, не расшифруется."""
    seed = (machine_id() + '|' + base64.b16encode(_SALT).decode()).encode()
    key  = base64.urlsafe_b64encode(hashlib.sha256(seed).digest())
    return Fernet(key)


# ── Отпечаток ПК ─────────────────────────────────────────────────────────────
_MID_CACHE = None

def _machine_guid():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r'SOFTWARE\Microsoft\Cryptography', 0,
                            winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            return winreg.QueryValueEx(k, 'MachineGuid')[0]
    except Exception:
        return ''

def _volume_serial():
    try:
        import ctypes
        vsn = ctypes.c_uint(0)
        drive = (os.environ.get('SystemDrive') or 'C:') + '\\'
        ctypes.windll.kernel32.GetVolumeInformationW(
            ctypes.c_wchar_p(drive), None, 0, ctypes.byref(vsn),
            None, None, None, 0)
        return str(vsn.value)
    except Exception:
        return ''

def machine_id():
    """Стабильный «код ПК» — короткая строка, которую клиент присылает."""
    global _MID_CACHE
    if _MID_CACHE:
        return _MID_CACHE
    raw = '|'.join([_machine_guid(), _volume_serial(),
                    os.environ.get('COMPUTERNAME', '')]).encode()
    digest = hashlib.sha256(raw + _SALT).hexdigest().upper()
    short  = digest[:20]
    _MID_CACHE = '-'.join(short[i:i+5] for i in range(0, 20, 5))   # XXXXX-XXXXX-XXXXX-XXXXX
    return _MID_CACHE


# ── Места хранения (чем больше, тем труднее сбросить переустановкой) ─────────
def _store_files():
    out = []
    for env in ('LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA'):
        base = os.environ.get(env)
        if base:
            out.append(os.path.join(base, APP_ID, '.license'))
    return out

def _read_all(reg_value):
    """Читает запись из реестра и всех файлов; возвращает список расшифрованных dict."""
    blobs = []
    # реестр
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _REG_PATH, 0, winreg.KEY_READ) as k:
            blobs.append(winreg.QueryValueEx(k, reg_value)[0])
    except Exception:
        pass
    # файлы
    for p in _store_files():
        fp = p + ('.t' if reg_value == 's' else '.k')
        try:
            with open(fp, 'r', encoding='utf-8') as f:
                blobs.append(f.read().strip())
        except Exception:
            pass
    out = []
    if _CRYPTO_OK:
        fe = _fernet()
        for b in blobs:
            try:
                out.append(json.loads(fe.decrypt(b.encode()).decode()))
            except Exception:
                pass
    return out

def _write_all(reg_value, data):
    try:
        enc = _fernet().encrypt(json.dumps(data, ensure_ascii=False).encode()).decode()
    except Exception as e:
        _log('encrypt failed: ' + repr(e)); return
    # реестр
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _REG_PATH) as k:
            winreg.SetValueEx(k, reg_value, 0, winreg.REG_SZ, enc)
    except Exception as e:
        _log('reg write: ' + repr(e))
    # файлы
    for p in _store_files():
        fp = p + ('.t' if reg_value == 's' else '.k')
        try:
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, 'w', encoding='utf-8') as f:
                f.write(enc)
            try:                               # пометить скрытым
                import ctypes
                ctypes.windll.kernel32.SetFileAttributesW(fp, 0x2)
            except Exception:
                pass
        except Exception:
            pass


# ── Пробный период ───────────────────────────────────────────────────────────
def _today():
    return datetime.date.today()

def _parse_d(s):
    return datetime.datetime.strptime(s, '%Y-%m-%d').date()

def _trial_state():
    """Возвращает (days_left, tampered). days_left<=0 — пробный истёк."""
    mid = machine_id()
    recs = [r for r in _read_all('s') if r.get('mid') == mid]
    now  = _today()
    tampered = False

    if recs:
        firsts = [_parse_d(r['first']) for r in recs if r.get('first')]
        lasts  = [_parse_d(r['last'])  for r in recs if r.get('last')]
        first  = min(firsts) if firsts else now
        last   = max(lasts)  if lasts  else now
        # Часы перевели назад? Не продлеваем пробный, считаем от last.
        if now < last:
            tampered = True
            now = last
    else:
        first = now
        last  = now

    rec = {'mid': mid, 'first': first.strftime('%Y-%m-%d'),
           'last': max(last, now).strftime('%Y-%m-%d')}
    _write_all('s', rec)

    used = (now - first).days
    days_left = TRIAL_DAYS - used
    return days_left, tampered


# ── Лицензия (аренда) ────────────────────────────────────────────────────────
def _b64u_dec(s):
    pad = '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def _verify_key(key_str):
    """Проверяет подпись и содержимое ключа. Возвращает payload dict или None."""
    if not _CRYPTO_OK:
        _log('verify: нет cryptography'); return None
    try:
        data_b64, sig_b64 = key_str.strip().split(':', 1)
        payload_bytes = _b64u_dec(data_b64)
        sig           = _b64u_dec(sig_b64)
        pub = ed25519.Ed25519PublicKey.from_public_bytes(bytes.fromhex(PUBLIC_KEY_HEX))
        pub.verify(sig, payload_bytes)         # бросит InvalidSignature при подделке
        payload = json.loads(payload_bytes.decode())
        if payload.get('app') != APP_ID:
            return None
        return payload
    except Exception as e:
        _log('verify: ' + repr(e))
        return None

def _license_payload():
    """Сохранённая лицензия, прошедшая проверку подписи и привязки к ПК; иначе None."""
    for r in _read_all('k'):
        key = r.get('key')
        if not key:
            continue
        p = _verify_key(key)
        if p and p.get('mid') in (machine_id(), 'ANY'):
            return p
    return None

def activate(key_str):
    """Активация ключа. Возвращает (ok: bool, сообщение: str)."""
    p = _verify_key(key_str)
    if not p:
        return False, 'Ключ недействителен или повреждён. Проверьте, что скопировали его полностью.'
    if p.get('mid') not in (machine_id(), 'ANY'):
        return False, 'Этот ключ выписан для другого компьютера.'
    exp = p.get('exp')
    if exp:
        try:
            if _parse_d(exp) < _today():
                return False, f'Срок действия ключа истёк ({exp}).'
        except Exception:
            return False, 'Ключ повреждён (дата).'
    _write_all('k', {'key': key_str.strip()})
    return True, 'Лицензия активирована.' + (f' Действует до {exp}.' if exp else '')


# ── Главная проверка при запуске ─────────────────────────────────────────────
def check():
    """
    Возвращает dict:
      state:      'licensed' | 'trial' | 'trial_expired' | 'license_expired'
      ok:         можно ли запускать (bool)
      days_left:  сколько дней осталось (пробный или лицензия)
      machine_id: код ПК
      exp:        дата окончания лицензии ('YYYY-MM-DD') или None
      msg:        текст для пользователя
    """
    mid = machine_id()
    base = {'machine_id': mid, 'exp': None, 'days_left': 0}

    # 1) Действующая лицензия?
    p = _license_payload()
    if p:
        exp = p.get('exp')
        if exp:
            try:
                left = (_parse_d(exp) - _today()).days
            except Exception:
                left = -1
            if left < 0:
                return {**base, 'state': 'license_expired', 'ok': False, 'exp': exp,
                        'msg': f'Срок лицензии истёк ({exp}). Введите новый ключ продления.'}
            return {**base, 'state': 'licensed', 'ok': True, 'exp': exp, 'days_left': left,
                    'msg': f'Лицензия активна. Действует до {exp} (осталось {left} дн.).'}
        # бессрочная (на будущее) — сейчас не выдаётся, но поддержим
        return {**base, 'state': 'licensed', 'ok': True,
                'msg': 'Лицензия активна (бессрочная).'}

    # 2) Пробный период
    if not _CRYPTO_OK:
        # Подсистема сломана — не блокируем платящих, но помечаем в лог
        _log('check: cryptography недоступна, пропускаю без проверки')
        return {**base, 'state': 'trial', 'ok': True, 'days_left': TRIAL_DAYS,
                'msg': 'Пробный режим.'}

    days_left, tampered = _trial_state()
    if days_left > 0:
        note = ' (обнаружен перевод часов)' if tampered else ''
        return {**base, 'state': 'trial', 'ok': True, 'days_left': days_left,
                'msg': f'Пробный период: осталось {days_left} дн.{note}'}
    return {**base, 'state': 'trial_expired', 'ok': False, 'days_left': 0,
            'msg': 'Пробный период (14 дней) закончился. Введите лицензионный ключ.'}


# Самопроверка из консоли: py licensing.py
if __name__ == '__main__':
    print('machine_id:', machine_id())
    print('crypto_ok :', _CRYPTO_OK)
    import pprint; pprint.pprint(check())
