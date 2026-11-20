# -*- coding: utf-8 -*-
"""Генерация чёткой многоразмерной иконки main_icon.ico для СЗЗ Инструмент.

Рисуем в 2048 px и уменьшаем LANCZOS'ом под каждый размер — так остаются
резкими и крупный ярлык (256), и мелкий список файлов (16).
"""
import sys
from PIL import Image, ImageDraw, ImageFilter

S = 2048                      # рабочий холст
OUT_ICO = sys.argv[1] if len(sys.argv) > 1 else 'main_icon.ico'
OUT_PNG = sys.argv[2] if len(sys.argv) > 2 else 'preview.png'

# Палитра — синий как в прежней иконке, но насыщеннее
BLUE_LIGHT = (86, 148, 255)
BLUE_DARK  = (26, 76, 200)
TILE       = (252, 253, 255)
TILE_EDGE  = (214, 222, 236)

img  = Image.new('RGBA', (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# ── Плитка: скруглённый квадрат ────────────────────────────────
pad = int(S * 0.055)
rad = int(S * 0.22)
draw.rounded_rectangle([pad, pad, S - pad, S - pad], radius=rad,
                       fill=TILE, outline=TILE_EDGE, width=int(S * 0.006))

# ── Шар: вертикальный градиент через горизонтальные полосы ─────
cx = cy = S // 2
R = int(S * 0.335)
sphere = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(sphere)
for y in range(cy - R, cy + R + 1):
    t = (y - (cy - R)) / (2 * R)
    t = t ** 0.85                      # свет смещён вверх
    col = tuple(int(BLUE_LIGHT[i] + (BLUE_DARK[i] - BLUE_LIGHT[i]) * t) for i in range(3))
    sd.line([(cx - R, y), (cx + R, y)], fill=col + (255,))

# маска круга
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).ellipse([cx - R, cy - R, cx + R, cy + R], fill=255)
sphere.putalpha(mask)

# ── Полосы-параллели: дуги, обрезанные по шару ─────────────────
stripes = Image.new('RGBA', (S, S), (0, 0, 0, 0))
st = ImageDraw.Draw(stripes)
w = int(R * 0.20)
for dy, squash, alpha in ((-0.46, 0.34, 235), (0.02, 0.30, 245), (0.50, 0.34, 225)):
    ry = int(R * squash)
    y0 = cy + int(R * dy) - ry
    st.arc([cx - int(R * 1.45), y0, cx + int(R * 1.45), y0 + 2 * ry],
           start=185, end=355, fill=(255, 255, 255, alpha), width=w)
stripes = stripes.rotate(-22, resample=Image.BICUBIC, center=(cx, cy))
stripes.putalpha(Image.composite(stripes.getchannel('A'),
                                 Image.new('L', (S, S), 0), mask))
sphere.alpha_composite(stripes)

# ── Блик сверху-слева ──────────────────────────────────────────
gloss = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(gloss)
gd.ellipse([cx - int(R * 0.78), cy - int(R * 0.92),
            cx + int(R * 0.18), cy - int(R * 0.18)],
           fill=(255, 255, 255, 46))
gloss = gloss.filter(ImageFilter.GaussianBlur(S * 0.02))
gloss.putalpha(Image.composite(gloss.getchannel('A'),
                               Image.new('L', (S, S), 0), mask))
sphere.alpha_composite(gloss)

# лёгкая тень под шаром
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).ellipse([cx - R, cy - R + int(R * 0.10),
                                cx + R, cy + R + int(R * 0.10)],
                               fill=(30, 60, 130, 60))
shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.018))
img.alpha_composite(shadow)
img.alpha_composite(sphere)

# ── Экспорт ────────────────────────────────────────────────────
# Полный набор размеров Windows: 100 %, 125 %, 150 %, 175 %, 200 %
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
base = img.resize((256, 256), Image.LANCZOS)
base.save(OUT_PNG)
# Сохраняем из 256-й версии: Pillow сам сделает кадр под каждый размер
# (BMP для мелких, PNG для 256). Сохранение из мелкого кадра всё обрезало бы.
base.save(OUT_ICO, format='ICO', sizes=[(n, n) for n in SIZES])
print('OK:', OUT_ICO, '|', ','.join(str(n) for n in SIZES))
