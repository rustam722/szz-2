"""
Генерация пары ключей Ed25519 для лицензирования СЗЗ-Инструмента.
Запускается ОДИН раз. Приватный ключ остаётся только у разработчика и
в сборку программы НЕ попадает. Публичный ключ вставляется в licensing.py.

    py tools\make_keys.py

Создаёт:
  tools/keys/ed25519_private.pem   — СЕКРЕТНО, хранить только у себя, не терять
  tools/keys/ed25519_public.hex    — вставить в licensing.py (PUBLIC_KEY_HEX)
"""
import os
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = os.path.join(HERE, 'keys')
os.makedirs(KEYS, exist_ok=True)

PRIV = os.path.join(KEYS, 'ed25519_private.pem')
PUBH = os.path.join(KEYS, 'ed25519_public.hex')

if os.path.exists(PRIV):
    raise SystemExit(
        f'Приватный ключ уже существует: {PRIV}\n'
        'Повторная генерация СДЕЛАЕТ НЕДЕЙСТВИТЕЛЬНЫМИ все выданные ключи.\n'
        'Если точно нужно пересоздать — удалите файл вручную и запустите снова.')

priv = ed25519.Ed25519PrivateKey.generate()
pub  = priv.public_key()

with open(PRIV, 'wb') as f:
    f.write(priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()))

pub_raw = pub.public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw)
pub_hex = pub_raw.hex()

with open(PUBH, 'w', encoding='utf-8') as f:
    f.write(pub_hex)

print('Готово.')
print(f'  Приватный ключ (СЕКРЕТНО): {PRIV}')
print(f'  Публичный ключ (hex):      {PUBH}')
print()
print('Вставьте эту строку в licensing.py, в PUBLIC_KEY_HEX:')
print(pub_hex)
