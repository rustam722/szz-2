"""
Выпуск лицензионного ключа (аренда) для СЗЗ-Инструмента.
Запускается ТОЛЬКО у разработчика: использует приватный ключ, который в
сборку программы не входит.

Использование:
    py tools\make_license.py <КОД_ПК> <ДАТА_ОКОНЧАНИЯ> [имя_клиента]

Примеры:
    py tools\make_license.py A1B2C-D3E4F-G5H6I-J7K8L 2027-01-31
    py tools\make_license.py A1B2C-D3E4F-G5H6I-J7K8L 2027-01-31 "ООО Ромашка"

«КОД ПК» клиент видит в окне активации и присылает вам.
Дата окончания — в формате ГГГГ-ММ-ДД (аренда всегда со сроком).
Результат — длинная строка-ключ; отправьте её клиенту, он вставит в окно активации.
"""
import os
import sys
import json
import base64
import datetime
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization

APP_ID = 'SZZ-Tool'
HERE   = os.path.dirname(os.path.abspath(__file__))
PRIV   = os.path.join(HERE, 'keys', 'ed25519_private.pem')


def _b64u(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    mid  = sys.argv[1].strip().upper()
    exp  = sys.argv[2].strip()
    name = sys.argv[3].strip() if len(sys.argv) > 3 else ''

    # Проверка даты
    try:
        d = datetime.datetime.strptime(exp, '%Y-%m-%d').date()
    except ValueError:
        print('Ошибка: дата должна быть в формате ГГГГ-ММ-ДД, например 2027-01-31')
        sys.exit(1)
    if d < datetime.date.today():
        print(f'Внимание: дата {exp} уже в прошлом — ключ будет сразу просрочен.')

    if not os.path.exists(PRIV):
        print(f'Не найден приватный ключ: {PRIV}')
        print('Сначала выполните: py tools\\make_keys.py')
        sys.exit(1)

    with open(PRIV, 'rb') as f:
        priv = serialization.load_pem_private_key(f.read(), password=None)

    payload = {
        'app': APP_ID,
        'mid': mid,                 # привязка к конкретному ПК
        'exp': exp,                 # аренда: дата окончания
        'ed':  'rent',
        'name': name,
        'iss': datetime.date.today().strftime('%Y-%m-%d'),
    }
    payload_bytes = json.dumps(payload, ensure_ascii=False,
                               separators=(',', ':')).encode()
    sig = priv.sign(payload_bytes)
    key = _b64u(payload_bytes) + ':' + _b64u(sig)

    print('=' * 60)
    print(f'  Клиент:      {name or "—"}')
    print(f'  Код ПК:      {mid}')
    print(f'  Действует до: {exp}')
    print('=' * 60)
    print('КЛЮЧ (отправьте клиенту целиком):')
    print()
    print(key)
    print()


if __name__ == '__main__':
    main()
