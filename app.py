"""
СЗЗ Инструмент — точка входа для нативного приложения.
Запускает статический HTTP-сервер (порт 8080) + прокси НСПД (порт 8767),
затем открывает окно pywebview.
"""
import sys
import os
import json
import threading
import time
import socket
import traceback
import ctypes
import ctypes.wintypes

# ── Пути ────────────────────────────────────────────────────────────────────
if getattr(sys, 'frozen', False):
    STATIC_DIR = sys._MEIPASS                        # html/css/js внутри бандла
    APP_DIR    = os.path.dirname(sys.executable)     # папка установки
    # Кэш и логи — в профиле пользователя: папка установки может быть без прав на запись
    DATA_DIR   = os.path.join(os.environ.get('LOCALAPPDATA') or APP_DIR, 'SZZ-Tool')
else:
    STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
    APP_DIR    = STATIC_DIR
    DATA_DIR   = STATIC_DIR

try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    DATA_DIR = APP_DIR

ICON_PATH = os.path.join(STATIC_DIR, 'main_icon.ico')

def _read_version() -> str:
    try:
        with open(os.path.join(STATIC_DIR, 'version.txt'), 'r', encoding='utf-8') as f:
            return f.read().strip() or '?'
    except Exception:
        return '?'

APP_VERSION = _read_version()

# Путь к кэшу НСПД — должен быть задан ДО импорта proxy
os.environ['NSPD_CACHE_DB'] = os.path.join(DATA_DIR, 'nspd_cache.db')

# ── Порты ────────────────────────────────────────────────────────────────────
# Назначаются динамически в main(): фиксированный порт может быть занят чужим
# приложением, и окно молча откроет чужой сервер
STATIC_PORT = 0
PROXY_PORT  = 0
RISK_PORT   = 0

# ── Лог ──────────────────────────────────────────────────────────────────────
_LOG = os.path.join(DATA_DIR, 'SZZ-Tool.log')

# Ротация: разросшийся лог уходит в .old (одно поколение)
try:
    if os.path.isfile(_LOG) and os.path.getsize(_LOG) > 2 * 1024 * 1024:
        os.replace(_LOG, _LOG + '.old')
except Exception:
    pass

def log(msg: str):
    try:
        with open(_LOG, 'a', encoding='utf-8') as f:
            f.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")}  {msg}\n')
    except Exception:
        pass


# ── Утилиты ──────────────────────────────────────────────────────────────────
def _get_free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_for_port(port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', port)) == 0:
                return True
        time.sleep(0.15)
    return False


# ── Статический сервер (HTML/CSS/JS) ─────────────────────────────────────────
def _make_static_server():
    """Создаёт сервер на свободном порту (bind 0) — фактический порт в server_address."""
    from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=STATIC_DIR, **kwargs)
        def log_message(self, *a):
            pass
        def do_GET(self):
            # app-config.js генерируется на лету: фактический адрес прокси и версия
            if self.path.split('?', 1)[0] == '/app-config.js':
                body = (f"window.APP_CONFIG={{proxy:'http://127.0.0.1:{PROXY_PORT}',"
                        f"riskApi:'http://127.0.0.1:{RISK_PORT}',"
                        f"version:'{APP_VERSION}'}};").encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

    # ThreadingHTTPServer: js/css/либы грузятся параллельно, а не по одному.
    # daemon_threads=True обязателен: по умолчанию False, и поток-обработчик
    # keep-alive соединения (WebView2 их держит открытыми) блокирует выход
    # из процесса на чтении сокета — закрыть окно нормально нельзя, только
    # через диспетчер задач.
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    srv.daemon_threads = True
    return srv


# ── Прокси НСПД ──────────────────────────────────────────────────────────────
def start_proxy_server():
    try:
        # Python 3.10+ требует явного event loop в не-главных потоках
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        from http.server import ThreadingHTTPServer
        import proxy as _proxy

        log(f'Proxy server: 127.0.0.1:{PROXY_PORT}')
        log(f'Cache DB: {_proxy.CACHE_DB}')
        server = ThreadingHTTPServer(('127.0.0.1', PROXY_PORT), _proxy.ProxyHandler)
        server.daemon_threads = True   # см. комментарий у _make_static_server
        server.serve_forever()
    except Exception:
        log('Proxy server FAILED:\n' + traceback.format_exc())


# ── API оценки риска (risk_server) ────────────────────────────────────────────
def start_risk_server():
    try:
        # risk_server — пакет рядом со STATIC_DIR; импортируем как risk_server.app,
        # а не голым "app" — у самого СЗЗ-Инструмента точка входа тоже app.py,
        # и голое имя рисковало бы столкнуться с ней при заморозке PyInstaller
        if STATIC_DIR not in sys.path:
            sys.path.insert(0, STATIC_DIR)
        from risk_server.app import run_server as _run_risk

        log(f'Risk server: 127.0.0.1:{RISK_PORT}')
        _run_risk(RISK_PORT)
    except Exception:
        log('Risk server FAILED:\n' + traceback.format_exc())


# Путь к файлу .szz, переданному через аргумент командной строки (открытие двойным кликом)
_STARTUP_FILE = (sys.argv[1]
                 if len(sys.argv) > 1 and os.path.isfile(sys.argv[1])
                 else None)

WINDOW_TITLE = 'СЗЗ Инструмент'

# ── Автосохранение и недавние проекты ────────────────────────────────────────
AUTOSAVE_PATH = os.path.join(DATA_DIR, 'autosave.json')
RECENT_PATH   = os.path.join(DATA_DIR, 'recent.json')
PROJECT_FILTER = ('Проект СЗЗ (*.szz)', 'Все файлы (*.*)')

# write_project() пишет файл по пути, который ей передаёт JS, без диалога.
# Чтобы вставленный в имя слоя/источника HTML (если он когда-нибудь проскочит
# мимо экранирования на странице) не смог записать файл в произвольное место
# на диске, write_project принимает только пути, которые сама Python-сторона
# до этого выдала через нативный диалог/открытие файла — т.е. уже из
# _ALLOWED_WRITE_PATHS, а не любую строку, присланную JS.
_ALLOWED_WRITE_PATHS = set()

def _allow_write_path(path: str):
    try:
        _ALLOWED_WRITE_PATHS.add(os.path.normcase(os.path.normpath(os.path.abspath(path))))
    except Exception:
        pass

def _is_allowed_write_path(path: str) -> bool:
    try:
        return os.path.normcase(os.path.normpath(os.path.abspath(path))) in _ALLOWED_WRITE_PATHS
    except Exception:
        return False


def _atomic_write(path: str, text: str):
    """Пишем во временный файл и подменяем — обрыв не портит прошлую копию."""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def _load_recent() -> list:
    try:
        with open(RECENT_PATH, 'r', encoding='utf-8') as f:
            items = json.load(f)
        return items if isinstance(items, list) else []
    except Exception:
        return []


def _add_recent(path: str, name: str = ''):
    try:
        path = os.path.abspath(path)
        items = [i for i in _load_recent()
                 if (i.get('path') or '').lower() != path.lower()]
        items.insert(0, {
            'path': path,
            'name': name or os.path.splitext(os.path.basename(path))[0],
            'ts':   int(time.time() * 1000),
        })
        _atomic_write(RECENT_PATH, json.dumps(items[:10], ensure_ascii=False))
    except Exception as ex:
        log(f'_add_recent: {ex}')


def _project_name_from(content: str, path: str) -> str:
    try:
        return json.loads(content).get('name') or ''
    except Exception:
        return os.path.splitext(os.path.basename(path))[0]


# ── Single instance ──────────────────────────────────────────────────────────
class _COPYDATASTRUCT(ctypes.Structure):
    _fields_ = [('dwData', ctypes.c_void_p),
                ('cbData', ctypes.c_uint32),
                ('lpData', ctypes.c_void_p)]

_mutex_handle = None  # держим ссылку до конца процесса

def _acquire_single_instance() -> bool:
    """True — мы первая копия. Мьютекс живёт до завершения процесса."""
    global _mutex_handle
    try:
        k32 = ctypes.windll.kernel32
        _mutex_handle = k32.CreateMutexW(None, False, 'Local\\SZZ-Tool-SingleInstance')
        return k32.GetLastError() != 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return True


def _activate_running_instance() -> bool:
    """Фокусирует окно первой копии и передаёт ей файл (WM_COPYDATA)."""
    u32 = ctypes.windll.user32
    hwnd = 0
    deadline = time.time() + 3.0   # первая копия могла ещё не создать окно
    while time.time() < deadline:
        hwnd = u32.FindWindowW(None, WINDOW_TITLE)
        if hwnd:
            break
        time.sleep(0.3)
    if not hwnd:
        return False
    u32.ShowWindow(hwnd, 9)  # SW_RESTORE
    u32.SetForegroundWindow(hwnd)
    if _STARTUP_FILE:
        try:
            buf = ctypes.create_unicode_buffer(os.path.abspath(_STARTUP_FILE))
            cds = _COPYDATASTRUCT(1, ctypes.sizeof(buf),
                                  ctypes.cast(buf, ctypes.c_void_p))
            u32.SendMessageW(hwnd, 0x004A, 0, ctypes.byref(cds))  # WM_COPYDATA
        except Exception as ex:
            log(f'_activate_running_instance send: {ex}')
    return True


def _move_loop():
    """Двигает окно за курсором, пока зажата левая кнопка мыши."""
    try:
        u32 = ctypes.windll.user32
        pt = ctypes.wintypes.POINT()
        u32.GetCursorPos(ctypes.byref(pt))
        if u32.IsZoomed(_app_hwnd):
            # Перетаскивание развёрнутого окна — сначала восстановить
            u32.PostMessageW(_app_hwnd, 0x0112, 0xF120, 0)  # SC_RESTORE
            time.sleep(0.08)
        r = ctypes.wintypes.RECT()
        u32.GetWindowRect(_app_hwnd, ctypes.byref(r))
        w = r.right - r.left
        ox = pt.x - r.left
        oy = pt.y - r.top
        # После restore курсор мог оказаться вне окна — ставим окно под курсор
        if ox < 0 or ox > w:
            ox = w // 2
        if oy < 0 or oy > 40:
            oy = 20
        while u32.GetAsyncKeyState(0x01) & 0x8000:  # VK_LBUTTON зажата
            u32.GetCursorPos(ctypes.byref(pt))
            u32.SetWindowPos(_app_hwnd, None, pt.x - ox, pt.y - oy, 0, 0,
                             0x0001 | 0x0004 | 0x0010)  # NOSIZE|NOZORDER|NOACTIVATE
            time.sleep(0.01)
    except Exception as ex:
        log(f'_move_loop: {ex}')


def _open_project_file(path: str):
    """Открывает .szz, переданный второй копией, в работающем окне."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        import webview
        _add_recent(path, _project_name_from(content, path))
        webview.windows[0].evaluate_js(
            f'window._openProjectJson && window._openProjectJson({json.dumps(content)}, true)')
        log(f'Открыт файл из второй копии: {path}')
    except Exception as ex:
        log(f'_open_project_file: {ex}')

# HWND главного окна — заполняется в _setup_frameless, используется в Api
_app_hwnd: int = 0
_resize_info: dict = {}

# ── Python API для JS ─────────────────────────────────────────────────────────
class Api:
    def get_version(self) -> str:
        return APP_VERSION

    def get_startup_project(self) -> str:
        if not _STARTUP_FILE:
            return ''
        try:
            with open(_STARTUP_FILE, 'r', encoding='utf-8') as f:
                content = f.read()
            _add_recent(_STARTUP_FILE, _project_name_from(content, _STARTUP_FILE))
            _allow_write_path(_STARTUP_FILE)
            log(f'Открытие файла при запуске: {_STARTUP_FILE}')
            return content
        except Exception as e:
            log(f'get_startup_project error: {e}')
            return ''

    # ── Автосохранение ────────────────────────────────────────────────────
    def autosave(self, payload: str) -> bool:
        try:
            _atomic_write(AUTOSAVE_PATH, payload)
            return True
        except Exception as ex:
            log(f'autosave: {ex}')
            return False

    def get_autosave(self) -> str:
        try:
            with open(AUTOSAVE_PATH, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception:
            return ''

    def clear_autosave(self) -> bool:
        try:
            if os.path.isfile(AUTOSAVE_PATH):
                os.remove(AUTOSAVE_PATH)
        except Exception as ex:
            log(f'clear_autosave: {ex}')
        return True

    # ── Недавние проекты ──────────────────────────────────────────────────
    def get_recent(self) -> list:
        return [i for i in _load_recent()
                if os.path.isfile(i.get('path') or '')]

    def open_recent(self, path: str) -> dict:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            _add_recent(path, _project_name_from(content, path))
            _allow_write_path(path)
            # path возвращаем, чтобы «Сохранить» писал в тот же файл без диалога
            return {'content': content, 'path': str(path)}
        except Exception as ex:
            log(f'open_recent: {ex}')
            return {'error': str(ex)}

    # ── Открытие/сохранение проекта через нативные диалоги ───────────────
    def open_project_dialog(self):
        import webview
        try:
            result = webview.windows[0].create_file_dialog(
                webview.OPEN_DIALOG, allow_multiple=False,
                file_types=PROJECT_FILTER)
        except Exception as ex:
            log(f'open_project_dialog: {ex}')
            return None
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        return self.open_recent(str(path))

    def choose_save_path(self, suggested: str) -> str:
        import webview
        try:
            result = webview.windows[0].create_file_dialog(
                webview.SAVE_DIALOG,
                directory=os.path.expanduser('~'),
                save_filename=suggested,
                file_types=PROJECT_FILTER)
        except Exception as ex:
            log(f'choose_save_path: {ex}')
            return ''
        if not result:
            return ''
        path = result[0] if isinstance(result, (list, tuple)) else result
        path = str(path)
        if not os.path.splitext(path)[1]:
            path += '.szz'
        _allow_write_path(path)
        return path

    def write_project(self, path: str, content: str) -> bool:
        try:
            if not os.path.splitext(path)[1]:
                path += '.szz'
            if not _is_allowed_write_path(path):
                log(f'write_project: путь не прошёл через диалог/открытие, отказ — {path}')
                return False
            _atomic_write(path, content)
            _add_recent(path, _project_name_from(content, path))
            log(f'Проект сохранён: {path}')
            return True
        except Exception as ex:
            log(f'write_project: {ex}')
            return False

    def begin_resize(self, direction: str, sx: float, sy: float):
        """JS передаёт screenX/Y * devicePixelRatio — уже физические пиксели."""
        global _resize_info
        if not _app_hwnd:
            return
        try:
            u32 = ctypes.windll.user32
            r = ctypes.wintypes.RECT()
            u32.GetWindowRect(_app_hwnd, ctypes.byref(r))
            _resize_info = {
                'd': str(direction),
                'l': int(r.left), 't': int(r.top), 'r': int(r.right), 'b': int(r.bottom),
                'x0': int(sx), 'y0': int(sy),
            }
        except Exception as e:
            log(f'begin_resize: {e}')

    def step_resize(self, sx: float, sy: float):
        """JS передаёт текущее screenX/Y * devicePixelRatio на каждый mousemove."""
        if not _app_hwnd or not _resize_info:
            return
        try:
            u32 = ctypes.windll.user32
            dx = int(sx) - _resize_info['x0']
            dy = int(sy) - _resize_info['y0']
            d  = _resize_info['d']
            l  = _resize_info['l']; t = _resize_info['t']
            r  = _resize_info['r']; b = _resize_info['b']
            if 'e' in d: r += dx
            if 'w' in d: l += dx
            if 's' in d: b += dy
            if 'n' in d: t += dy
            if r - l < 500:
                if 'w' in d: l = r - 500
                else:        r = l + 500
            if b - t < 350:
                if 'n' in d: t = b - 350
                else:        b = t + 350
            u32.SetWindowPos(_app_hwnd, None, l, t, r - l, b - t, 0x0004)
        except Exception as e:
            log(f'step_resize: {e}')

    # ── Перетаскивание окна ───────────────────────────────────────────────
    # WM_NCLBUTTONDOWN не работает: WebView2 держит mouse capture в своём
    # потоке. Поэтому двигаем сами: цикл в Python следит за курсором
    # (GetCursorPos) и кнопкой мыши (GetAsyncKeyState) — JS-события не нужны
    def start_move(self):
        if not _app_hwnd:
            return False
        threading.Thread(target=_move_loop, daemon=True).start()
        return True

    def is_maximized(self) -> bool:
        try:
            return bool(_app_hwnd and ctypes.windll.user32.IsZoomed(_app_hwnd))
        except Exception:
            return False

    def minimize(self):
        import webview
        webview.windows[0].minimize()

    def toggle_maximize(self):
        # Реальное состояние берём у окна (IsZoomed): Aero Snap может
        # развернуть/восстановить окно мимо нашего флага
        import webview
        if self.is_maximized():
            try:
                webview.windows[0].restore()
            except Exception:
                if _app_hwnd:
                    ctypes.windll.user32.PostMessageW(_app_hwnd, 0x0112, 0xF120, 0)
        else:
            webview.windows[0].maximize()

    def close_win(self):
        import webview
        webview.windows[0].destroy()

    def save_file(self, filename: str, data_b64: str) -> bool:
        """Вызывается из JS: показывает диалог сохранения и записывает файл."""
        import base64
        import webview
        win = webview.windows[0]
        try:
            result = win.create_file_dialog(
                webview.SAVE_DIALOG,
                directory=os.path.join(os.path.expanduser('~'), 'Downloads'),
                save_filename=filename,
            )
        except Exception as e:
            log(f'save_file dialog error: {e}')
            return False
        if not result:
            return False
        path = result[0] if isinstance(result, (list, tuple)) else result
        try:
            with open(path, 'wb') as f:
                f.write(base64.b64decode(data_b64))
            log(f'Saved: {path}')
            return True
        except Exception as e:
            log(f'save_file write error: {e}')
            return False



# ── Вспомогательные диалоги ──────────────────────────────────────────────────
def _msgbox(title: str, msg: str, icon: int = 0x10):
    """Нативный MessageBox Windows — работает даже без webview."""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, title, icon)
    except Exception:
        pass


def _check_webview2() -> bool:
    """Проверяет наличие WebView2 Runtime в реестре Windows."""
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for path in (
                r'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
                r'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
            ):
                try:
                    winreg.OpenKey(hive, path)
                    return True
                except OSError:
                    pass
    except Exception:
        pass
    return False


# ── Точка входа ───────────────────────────────────────────────────────────────
def main():
    global STATIC_PORT, PROXY_PORT, RISK_PORT

    # Вторая копия: фокусируем уже открытое окно (и передаём ему файл), выходим
    if not _acquire_single_instance():
        if _activate_running_instance():
            log('Вторая копия — активировано существующее окно')
            return
        # окно первой копии не нашли — работаем как обычная копия

    log(f'=== СЗЗ Инструмент v{APP_VERSION} запуск ===')
    log(f'frozen={getattr(sys, "frozen", False)}')
    log(f'APP_DIR={APP_DIR}')
    log(f'DATA_DIR={DATA_DIR}')
    log(f'STATIC_DIR={STATIC_DIR}')

    # Ранняя проверка WebView2
    if not _check_webview2():
        log('WebView2 не найден — показываем подсказку')
        _msgbox(
            'СЗЗ Инструмент — требуется компонент',
            'Не найден Microsoft Edge WebView2 Runtime.\n\n'
            'Скачайте и установите (бесплатно, ~2 МБ):\n'
            'https://developer.microsoft.com/ru-ru/microsoft-edge/webview2/\n\n'
            'Нажмите "Evergreen Standalone Installer" → x64\n'
            'После установки запустите приложение снова.',
            0x40,  # information icon
        )
        return

    # Порты выдаёт ОС: никаких конфликтов с чужими приложениями на 8080/8767
    PROXY_PORT = _get_free_port()
    threading.Thread(target=start_proxy_server, daemon=True).start()

    RISK_PORT = _get_free_port()
    threading.Thread(target=start_risk_server, daemon=True).start()

    static_srv  = _make_static_server()
    STATIC_PORT = static_srv.server_address[1]
    threading.Thread(target=static_srv.serve_forever, daemon=True).start()
    log(f'Static server: 127.0.0.1:{STATIC_PORT}  dir={STATIC_DIR}')

    static_ok = wait_for_port(STATIC_PORT)
    proxy_ok  = wait_for_port(PROXY_PORT)
    risk_ok   = wait_for_port(RISK_PORT)
    log(f'Готовность: static={static_ok}  proxy={proxy_ok}  risk={risk_ok}')

    if not static_ok:
        log('КРИТИЧНО: статический сервер не запустился!')

    try:
        import webview

        def _get_hwnd(win, timeout: float = 10.0) -> int:
            """pywebview 6.x убрал get_window_handle — пробуем все варианты.
            Функция готовности вызывается раньше создания окна, поэтому ждём."""
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    return int(win.get_window_handle())
                except Exception:
                    pass
                try:
                    return int(win.native.Handle.ToInt64())   # WinForms IntPtr
                except Exception:
                    pass
                try:
                    hwnd = ctypes.windll.user32.FindWindowW(None, WINDOW_TITLE)
                    if hwnd:
                        return hwnd
                except Exception:
                    pass
                time.sleep(0.2)
            return 0

        def _dark_titlebar(win):
            try:
                hwnd = _get_hwnd(win)
                if not hwnd:
                    return
                val  = ctypes.c_int(1)
                for attr in (20, 19):
                    ctypes.windll.dwmapi.DwmSetWindowAttribute(
                        hwnd, attr, ctypes.byref(val), ctypes.sizeof(val)
                    )
            except Exception as ex:
                log(f'dark titlebar: {ex}')

        def _setup_frameless(win):
            """Subclass WndProc: resize по краям. HWND хранится глобально."""
            global _app_hwnd
            try:
                WndProcType = ctypes.WINFUNCTYPE(
                    ctypes.c_longlong,
                    ctypes.wintypes.HWND,
                    ctypes.c_uint,
                    ctypes.wintypes.WPARAM,
                    ctypes.wintypes.LPARAM,
                )
                user32 = ctypes.windll.user32
                user32.CallWindowProcW.restype  = ctypes.c_longlong
                user32.CallWindowProcW.argtypes = [
                    ctypes.c_void_p, ctypes.wintypes.HWND,
                    ctypes.c_uint, ctypes.wintypes.WPARAM, ctypes.wintypes.LPARAM,
                ]
                user32.GetWindowLongPtrW.restype  = ctypes.c_void_p
                user32.GetWindowLongPtrW.argtypes = [ctypes.wintypes.HWND, ctypes.c_int]
                user32.SetWindowLongPtrW.restype  = ctypes.c_void_p
                user32.SetWindowLongPtrW.argtypes = [ctypes.wintypes.HWND, ctypes.c_int, ctypes.c_void_p]

                hwnd = _get_hwnd(win)
                if not hwnd:
                    log('_setup_frameless: HWND не получен')
                    return
                _app_hwnd = hwnd

                # WS_MINIMIZEBOX | WS_MAXIMIZEBOX — нужны для WM_SYSCOMMAND
                # WS_THICKFRAME — без него DefWindowProc не запускает resize-loop
                # даже если WM_NCHITTEST возвращает HTLEFT/HTRIGHT/etc.
                # WS_MINIMIZEBOX|WS_MAXIMIZEBOX — для WM_SYSCOMMAND
                # Без SWP_FRAMECHANGED — WinForms не переназначает client area
                style = user32.GetWindowLongPtrW(hwnd, -16)
                user32.SetWindowLongPtrW(hwnd, -16,
                    style | 0x00040000 | 0x00020000 | 0x00010000)

                user32.IsZoomed.argtypes      = [ctypes.wintypes.HWND]
                user32.IsZoomed.restype       = ctypes.c_bool
                user32.GetWindowRect.argtypes = [ctypes.wintypes.HWND, ctypes.c_void_p]
                user32.GetWindowRect.restype  = ctypes.c_bool
                user32.SetWindowPos.argtypes  = [
                    ctypes.wintypes.HWND, ctypes.wintypes.HWND,
                    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                ]
                user32.SetWindowPos.restype   = ctypes.c_bool

                old_proc = user32.GetWindowLongPtrW(hwnd, -4)

                def wndproc(hwnd, msg, wparam, lparam):
                    if msg == 0x004A and lparam:  # WM_COPYDATA — вторая копия передала путь к .szz
                        try:
                            cds  = _COPYDATASTRUCT.from_address(lparam)
                            path = ctypes.wstring_at(cds.lpData, cds.cbData // 2).rstrip('\x00')
                            if path and os.path.isfile(path):
                                threading.Thread(target=_open_project_file,
                                                 args=(path,), daemon=True).start()
                        except Exception as ex:
                            log(f'WM_COPYDATA: {ex}')
                        return 1
                    if msg == 0x0084:  # WM_NCHITTEST (до WebView2 не доходит, но оставим)
                        if not user32.IsZoomed(hwnd):
                            x = ctypes.c_short(lparam & 0xFFFF).value
                            y = ctypes.c_short((lparam >> 16) & 0xFFFF).value
                            r2 = ctypes.wintypes.RECT()
                            user32.GetWindowRect(hwnd, ctypes.byref(r2))
                            BORDER = 10
                            top    = y < r2.top    + BORDER
                            bottom = y > r2.bottom - BORDER
                            left   = x < r2.left   + BORDER
                            right  = x > r2.right  - BORDER
                            if top    and left:  return 13
                            if top    and right: return 14
                            if bottom and left:  return 16
                            if bottom and right: return 17
                            if top:              return 12
                            if bottom:           return 15
                            if left:             return 10
                            if right:            return 11
                    return user32.CallWindowProcW(old_proc, hwnd, msg, wparam, lparam)

                cb = WndProcType(wndproc)
                user32.SetWindowLongPtrW(hwnd, -4, cb)
                win._wndproc_cb  = cb
                win._old_wndproc = old_proc
                log(f'_setup_frameless OK hwnd={hwnd}')
            except Exception as ex:
                log(f'_setup_frameless: {ex}')

        def _on_window_ready(win):
            _dark_titlebar(win)
            _setup_frameless(win)

        win = webview.create_window(
            title     = WINDOW_TITLE,
            url       = f'http://127.0.0.1:{STATIC_PORT}/index.html',
            width     = 1440,
            height    = 900,
            min_size  = (900, 600),
            frameless = True,
            easy_drag = False,   # отключаем drag со всего окна
            js_api    = Api(),
        )

        # Автосохранение при закрытии раньше делали отдельным хендлером на
        # win.events.closing, который синхронно звал evaluate_js — тот ждёт
        # ответа от страницы через тот же GUI-поток, на котором выполняется
        # сам обработчик closing. Поток ждал сам себя: по логам evaluate_js
        # НИ РАЗУ не успевал за 3 с (100% случаев), так что каждое закрытие
        # гарантированно стояло все 3 секунды и автосохранение всё равно не
        # записывалось — чистый минус без всякой пользы. Правильный путь уже
        # есть в JS: window.addEventListener('beforeunload', ...) в main.js
        # сам вызывает _autosaveNow() → Api.autosave() при закрытии окна —
        # это обычный вызов ИЗ JS В Python через js_api мост, а не наоборот,
        # поэтому реентрантности и блокировки GUI-потока тут нет.
        icon = ICON_PATH if os.path.isfile(ICON_PATH) else None
        webview.start(func=_on_window_ready, args=[win], icon=icon)
    except Exception:
        err = traceback.format_exc()
        log('webview FAILED:\n' + err)
        _msgbox(
            'СЗЗ Инструмент — ошибка запуска',
            f'Не удалось открыть окно приложения.\n\n'
            f'Попробуйте установить WebView2 Runtime:\n'
            f'https://developer.microsoft.com/ru-ru/microsoft-edge/webview2/\n\n'
            f'Подробности в файле SZZ-Tool.log рядом с .exe\n\n'
            f'Ошибка: {err[:300]}',
        )

    log('=== СЗЗ Инструмент завершён ===')


if __name__ == '__main__':
    main()
