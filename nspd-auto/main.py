"""
НСПД — Автоматическая расстановка точек зоны
=============================================
Читает координаты из coords.csv и автоматически
расставляет точки на сайте НСПД для создания СЗЗ.

Запуск:  python main.py
         python main.py coords.csv
         python main.py coords.csv --slow   (медленный режим для отладки)
"""

import sys
import csv
import json
import asyncio
import argparse
from pathlib import Path

# ── pip install playwright  +  playwright install chromium ──
try:
    from playwright.async_api import async_playwright, Page
except ImportError:
    print("ОШИБКА: установите Playwright командой:")
    print("  pip install playwright")
    print("  playwright install chromium")
    sys.exit(1)


NSPD_URL = "https://nspd.gov.ru"


# ═══════════════════════════════════════════════════════════════
#  ЗАГРУЗКА КООРДИНАТ
# ═══════════════════════════════════════════════════════════════

def load_coords(path: str) -> list[dict]:
    """
    Поддерживаемые форматы:
      CSV  — колонки lat,lon  или  longitude,latitude  или  x,y
      JSON — массив [[lat,lon], ...]  или  [{lat:..., lon:...}, ...]
      GeoJSON — FeatureCollection / Polygon / LineString
    """
    p = Path(path)
    if not p.exists():
        print(f"ОШИБКА: файл не найден — {path}")
        sys.exit(1)

    ext = p.suffix.lower()

    if ext in (".json", ".geojson"):
        return _load_json(p)
    else:
        return _load_csv(p)


def _load_csv(p: Path) -> list[dict]:
    coords = []
    with open(p, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        # нормализуем имена колонок
        headers = [h.strip().lower() for h in (reader.fieldnames or [])]
        lat_col = _find_col(headers, ["lat", "latitude", "широта", "y"])
        lon_col = _find_col(headers, ["lon", "lng", "longitude", "долгота", "x"])

        if lat_col is None or lon_col is None:
            # попытка прочитать как два столбца без заголовка
            f.seek(0)
            raw = csv.reader(f)
            for row in raw:
                row = [c.strip() for c in row if c.strip()]
                if len(row) >= 2:
                    try:
                        coords.append({"lat": float(row[0]), "lon": float(row[1])})
                    except ValueError:
                        pass  # пропускаем заголовок
        else:
            orig_headers = reader.fieldnames or []
            real_lat = orig_headers[headers.index(lat_col)]
            real_lon = orig_headers[headers.index(lon_col)]
            for row in reader:
                try:
                    coords.append({
                        "lat": float(row[real_lat].replace(",", ".")),
                        "lon": float(row[real_lon].replace(",", "."))
                    })
                except (ValueError, KeyError):
                    pass

    return coords


def _load_json(p: Path) -> list[dict]:
    with open(p, encoding="utf-8") as f:
        data = json.load(f)

    # GeoJSON
    if isinstance(data, dict) and data.get("type"):
        return _parse_geojson(data)

    # Массив пар [[lat,lon], ...]
    if isinstance(data, list):
        if data and isinstance(data[0], (list, tuple)):
            return [{"lat": float(c[0]), "lon": float(c[1])} for c in data]
        if data and isinstance(data[0], dict):
            return [_norm_point(c) for c in data]

    print("ОШИБКА: неподдерживаемый формат JSON")
    sys.exit(1)


def _parse_geojson(obj: dict) -> list[dict]:
    coords = []

    def extract(geom):
        t = geom.get("type", "")
        if t == "Point":
            c = geom["coordinates"]
            coords.append({"lat": float(c[1]), "lon": float(c[0])})
        elif t in ("LineString", "MultiPoint"):
            for c in geom["coordinates"]:
                coords.append({"lat": float(c[1]), "lon": float(c[0])})
        elif t in ("Polygon", "MultiLineString"):
            ring = geom["coordinates"][0]
            for c in ring:
                coords.append({"lat": float(c[1]), "lon": float(c[0])})
        elif t == "MultiPolygon":
            ring = geom["coordinates"][0][0]
            for c in ring:
                coords.append({"lat": float(c[1]), "lon": float(c[0])})
        elif t == "GeometryCollection":
            for g in geom.get("geometries", []):
                extract(g)

    if obj["type"] == "FeatureCollection":
        for feat in obj.get("features", []):
            extract(feat.get("geometry", {}))
    elif obj["type"] == "Feature":
        extract(obj.get("geometry", {}))
    else:
        extract(obj)

    return coords


def _norm_point(d: dict) -> dict:
    lat = d.get("lat") or d.get("latitude") or d.get("y") or d.get("широта")
    lon = d.get("lon") or d.get("lng") or d.get("longitude") or d.get("x") or d.get("долгота")
    return {"lat": float(lat), "lon": float(lon)}


def _find_col(headers: list, variants: list):
    for v in variants:
        if v in headers:
            return v
    return None


# ═══════════════════════════════════════════════════════════════
#  КОНВЕРТАЦИЯ КООРДИНАТ → ПИКСЕЛИ
# ═══════════════════════════════════════════════════════════════

# Формулы Меркатора (Web Mercator / EPSG:3857)
import math

def latlon_to_pixel(lat: float, lon: float,
                    map_bounds: dict, map_size: dict) -> tuple[int, int]:
    """
    map_bounds = {north, south, east, west}  — видимые границы карты в WGS84
    map_size   = {width, height}             — размер элемента карты в px
    """
    def merc_y(lat_deg):
        lat_r = math.radians(lat_deg)
        return math.log(math.tan(math.pi / 4 + lat_r / 2))

    west, east = map_bounds["west"], map_bounds["east"]
    north, south = map_bounds["north"], map_bounds["south"]

    x_frac = (lon - west) / (east - west)
    y_top = merc_y(north)
    y_bot = merc_y(south)
    y_frac = (merc_y(lat) - y_top) / (y_bot - y_top)

    px = int(x_frac * map_size["width"])
    py = int(y_frac * map_size["height"])
    return px, py


# ═══════════════════════════════════════════════════════════════
#  ПОЛУЧЕНИЕ ГРАНИЦ КАРТЫ СО СТРАНИЦЫ
# ═══════════════════════════════════════════════════════════════

GET_MAP_BOUNDS_JS = """
() => {
  // Попытка 1: Leaflet
  try {
    for (const key of Object.keys(window)) {
      const v = window[key];
      if (v && typeof v === 'object' && typeof v.getBounds === 'function') {
        const b = v.getBounds();
        if (b && typeof b.getNorth === 'function') {
          const el = v.getContainer ? v.getContainer() : document.querySelector('.leaflet-container');
          const r = el ? el.getBoundingClientRect() : {left:0,top:0,width:0,height:0};
          return {
            type: 'leaflet',
            north: b.getNorth(), south: b.getSouth(),
            east:  b.getEast(),  west:  b.getWest(),
            rect: {left: r.left, top: r.top, width: r.width, height: r.height}
          };
        }
      }
    }
  } catch(e) {}

  // Попытка 2: OpenLayers
  try {
    if (window.ol) {
      const maps = window._olMaps || [];
      if (maps.length) {
        const map = maps[0];
        const ext = map.getView().calculateExtent(map.getSize());
        const ll = ol.proj.toLonLat([ext[0], ext[1]]);
        const ur = ol.proj.toLonLat([ext[2], ext[3]]);
        const el = map.getTargetElement();
        const r = el.getBoundingClientRect();
        return {
          type: 'openlayers',
          west: ll[0], south: ll[1], east: ur[0], north: ur[1],
          rect: {left: r.left, top: r.top, width: r.width, height: r.height}
        };
      }
    }
  } catch(e) {}

  // Попытка 3: Mapbox GL
  try {
    const canvases = document.querySelectorAll('.mapboxgl-canvas');
    for (const canvas of canvases) {
      const container = canvas.closest('.mapboxgl-map');
      if (container && container._map) {
        const map = container._map;
        const b = map.getBounds();
        const r = container.getBoundingClientRect();
        return {
          type: 'mapboxgl',
          north: b.getNorth(), south: b.getSouth(),
          east: b.getEast(),   west: b.getWest(),
          rect: {left: r.left, top: r.top, width: r.width, height: r.height}
        };
      }
    }
  } catch(e) {}

  return null;
}
"""


# ═══════════════════════════════════════════════════════════════
#  КЛИК НА КАРТУ ПО КООРДИНАТАМ
# ═══════════════════════════════════════════════════════════════

async def click_coord(page: Page, lat: float, lon: float,
                      bounds: dict, rect: dict, pause_ms: int = 400):
    """Вычисляет пиксельные координаты и кликает на карту."""
    map_size = {"width": rect["width"], "height": rect["height"]}
    px, py = latlon_to_pixel(lat, lon, bounds, map_size)

    abs_x = int(rect["left"] + px)
    abs_y = int(rect["top"]  + py)

    # Защита от выхода за пределы экрана
    vp = page.viewport_size or {"width": 1400, "height": 900}
    abs_x = max(0, min(abs_x, vp["width"]  - 1))
    abs_y = max(0, min(abs_y, vp["height"] - 1))

    await page.mouse.click(abs_x, abs_y)
    await page.wait_for_timeout(pause_ms)
    print(f"  ✓ ({lat:.6f}, {lon:.6f})  →  px({abs_x}, {abs_y})")


# ═══════════════════════════════════════════════════════════════
#  ГЛАВНАЯ ФУНКЦИЯ
# ═══════════════════════════════════════════════════════════════

async def run(coords_file: str, slow: bool):
    coords = load_coords(coords_file)
    print(f"Загружено точек: {len(coords)}")
    if not coords:
        print("ОШИБКА: список координат пуст")
        sys.exit(1)

    pause = 800 if slow else 350

    async with async_playwright() as pw:
        # Открываем браузер в видимом режиме — пользователь видит всё
        browser = await pw.chromium.launch(headless=False, slow_mo=100 if slow else 0)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            locale="ru-RU"
        )
        page = await context.new_page()

        # ── Шаг 1: Открыть НСПД ──
        print(f"\n[1/4] Открываю {NSPD_URL} ...")
        await page.goto(NSPD_URL, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(2000)

        # ── Шаг 2: Ждём действий пользователя ──
        print("\n[2/4] ИНСТРУКЦИЯ:")
        print("  → В браузере: перейдите в режим создания зоны / СЗЗ")
        print("  → Активируйте инструмент 'Нарисовать полигон' (обычно карандаш или аналогичная кнопка)")
        print("  → Убедитесь что карта показывает нужный район")
        print()
        print("  Когда будете готовы — нажмите ENTER здесь ↓")
        input("  > ")

        # ── Шаг 3: Получаем границы карты ──
        print("\n[3/4] Определяю границы карты ...")
        map_info = await page.evaluate(GET_MAP_BOUNDS_JS)

        if map_info is None:
            print("\nНЕ УДАЛОСЬ автоматически определить тип карты.")
            print("Введите текущие границы видимой области карты (из адресной строки или инструментов браузера):")
            try:
                north = float(input("  Север (max широта): "))
                south = float(input("  Юг   (min широта): "))
                east  = float(input("  Восток (max долгота): "))
                west  = float(input("  Запад  (min долгота): "))
            except ValueError:
                print("ОШИБКА ввода")
                await browser.close()
                sys.exit(1)

            # Найти элемент карты
            map_el = await page.query_selector(
                "canvas, .leaflet-container, .mapboxgl-canvas, #map, [class*='map']"
            )
            if map_el:
                r = await map_el.bounding_box()
                rect = {"left": r["x"], "top": r["y"],
                        "width": r["width"], "height": r["height"]}
            else:
                vp = page.viewport_size or {"width": 1440, "height": 900}
                rect = {"left": 0, "top": 0, "width": vp["width"], "height": vp["height"]}

            bounds = {"north": north, "south": south, "east": east, "west": west}
        else:
            bounds = {k: map_info[k] for k in ("north", "south", "east", "west")}
            rect   = map_info["rect"]
            print(f"  Тип карты: {map_info['type']}")
            print(f"  Границы:  N={bounds['north']:.5f}  S={bounds['south']:.5f}")
            print(f"            E={bounds['east']:.5f}  W={bounds['west']:.5f}")
            print(f"  Размер:   {rect['width']:.0f} × {rect['height']:.0f} px")

        # Проверка — все ли точки попадают в видимую область
        out_of_bounds = [
            c for c in coords
            if not (bounds["south"] <= c["lat"] <= bounds["north"] and
                    bounds["west"]  <= c["lon"] <= bounds["east"])
        ]
        if out_of_bounds:
            print(f"\nВНИМАНИЕ: {len(out_of_bounds)} точек выходят за пределы видимой области карты!")
            print("  Приблизьте карту так, чтобы все точки были видны, и нажмите ENTER.")
            input("  > ")
            # Повторно получаем границы
            map_info2 = await page.evaluate(GET_MAP_BOUNDS_JS)
            if map_info2:
                bounds = {k: map_info2[k] for k in ("north", "south", "east", "west")}
                rect   = map_info2["rect"]

        # ── Шаг 4: Расставляем точки ──
        print(f"\n[4/4] Расставляю {len(coords)} точек ...")
        for i, c in enumerate(coords, 1):
            print(f"  [{i}/{len(coords)}]", end=" ")
            await click_coord(page, c["lat"], c["lon"], bounds, rect, pause_ms=pause)

        # Замкнуть полигон — кликнуть на первую точку ещё раз
        print("\n  Замыкаю полигон (клик на первую точку) ...")
        await click_coord(page, coords[0]["lat"], coords[0]["lon"],
                          bounds, rect, pause_ms=pause)

        print("\n✅ Готово! Все точки расставлены.")
        print("   Теперь в браузере подтвердите создание зоны / сохраните.")
        print("   (Браузер останется открытым — закройте это окно когда закончите)")

        # Держим браузер открытым
        try:
            await page.wait_for_event("close", timeout=0)
        except Exception:
            pass

        await browser.close()


# ═══════════════════════════════════════════════════════════════
#  ТОЧКА ВХОДА
# ═══════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Авторасстановка точек на НСПД")
    parser.add_argument("coords", nargs="?", default="coords.csv",
                        help="Файл координат (CSV/JSON/GeoJSON). По умолчанию: coords.csv")
    parser.add_argument("--slow", action="store_true",
                        help="Медленный режим — для отладки")
    args = parser.parse_args()

    asyncio.run(run(args.coords, args.slow))


if __name__ == "__main__":
    main()
