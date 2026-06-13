import ctypes
import sys

REG_ENTRIES = [
    (r'Software\Classes\*\shell\TokenMaker_RemoveBg', 'Удалить фон (Token Maker)', '--remove-bg'),
    (r'Software\Classes\*\shell\TokenMaker_ToWebp', 'Конвертировать в WebP (Token Maker)', '--to-webp'),
]

DIR_REG_ENTRIES = [
    (r'Software\Classes\Directory\shell\TokenMaker_FolderToWebp', 'Конвертировать все изображения в WebP (Token Maker)', '--folder-to-webp'),
    (r'Software\Classes\Directory\Background\shell\TokenMaker_FolderToWebp', 'Конвертировать все изображения в WebP (Token Maker)', '--folder-to-webp'),
]


def _context_menu_entry():
    from pathlib import Path
    if getattr(sys, 'frozen', False):
        return sys.executable, sys.executable
    base_dir = Path(__file__).parent
    cmd = f'"{sys.executable}" "{base_dir / "context_menu_helper.py"}"'
    return cmd, str(base_dir / 'icon.ico')


def _register_context_menu():
    import winreg
    try:
        cmd_prefix, icon_path = _context_menu_entry()
        for reg_path, label, flag in REG_ENTRIES:
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path)
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, label)
            winreg.SetValueEx(key, 'Icon', 0, winreg.REG_SZ, icon_path)
            winreg.CloseKey(key)
            cmd_key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path + r'\command')
            winreg.SetValueEx(cmd_key, '', 0, winreg.REG_SZ, f'{cmd_prefix} {flag} "%1"')
            winreg.CloseKey(cmd_key)
        for reg_path, label, flag in DIR_REG_ENTRIES:
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path)
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, label)
            winreg.SetValueEx(key, 'Icon', 0, winreg.REG_SZ, icon_path)
            winreg.CloseKey(key)
            cmd_key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path + r'\command')
            arg = '"%V"' if 'Background' in reg_path else '"%1"'
            winreg.SetValueEx(cmd_key, '', 0, winreg.REG_SZ, f'{cmd_prefix} {flag} {arg}')
            winreg.CloseKey(cmd_key)
    except Exception as e:
        print(f'Ошибка регистрации меню: {e}')


def _unregister_context_menu():
    import winreg
    try:
        for reg_path, _, _ in REG_ENTRIES + DIR_REG_ENTRIES:
            for subkey in [reg_path + r'\command', reg_path]:
                try:
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, subkey)
                except FileNotFoundError:
                    pass
    except Exception as e:
        print(f'Ошибка удаления меню: {e}')


PID_FILE = None


def _kill_process_on_port(port):
    import subprocess
    try:
        r = subprocess.run(['netstat', '-ano'], capture_output=True, text=True)
        for line in r.stdout.splitlines():
            if f':{port}' in line and 'LISTENING' in line:
                pid = line.strip().split()[-1]
                if pid and pid != '0':
                    import os as _os
                    if pid != str(_os.getpid()):
                        subprocess.run(['taskkill', '/F', '/PID', pid], capture_output=True)
    except Exception:
        pass


kernel32 = ctypes.windll.kernel32

# Keep WNDPROC callback objects alive (prevent GC)
_wndproc_refs = []


def _nuclear_exit():
    if PID_FILE and PID_FILE.exists():
        try:
            PID_FILE.unlink()
        except Exception:
            pass
    _unregister_context_menu()
    kernel32.TerminateProcess(kernel32.GetCurrentProcess(), 0)


def main():
    import os as _os
    import signal
    import subprocess
    import threading
    import time
    import webview
    from server import app, BASE_DIR
    from updater import start_background_tasks

    global PID_FILE

    PORT = 7878
    URL = f'http://localhost:{PORT}'
    SPLASH_URL = f'http://localhost:{PORT}/splash'

    kernel32.SetConsoleCtrlHandler(
        ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_uint)(lambda event: (kernel32.TerminateProcess(kernel32.GetCurrentProcess(), 0), True)[1]),
        1
    )

    PID_FILE = BASE_DIR / 'app.pid'

    if PID_FILE.exists():
        try:
            old_pid = int(PID_FILE.read_text())
            if old_pid != _os.getpid():
                subprocess.run(['taskkill', '/F', '/PID', str(old_pid)], capture_output=True)
                time.sleep(0.3)
        except Exception:
            pass

    _kill_process_on_port(PORT)

    try:
        PID_FILE.write_text(str(_os.getpid()))
    except Exception:
        pass

    _register_context_menu()
    start_background_tasks()

    flask_thread = threading.Thread(
        target=lambda: app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True, use_reloader=False),
        daemon=True
    )
    flask_thread.start()

    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            import urllib.request
            urllib.request.urlopen(SPLASH_URL, timeout=1)
            break
        except Exception:
            time.sleep(0.1)

    class WindowApi:
        def minimize(self):
            _window.minimize()
        def maximize(self):
            _window.maximize()
        def restore(self):
            _window.restore()
        def destroy(self):
            _window.destroy()

    window = webview.create_window(
        title='Token Maker',
        url=SPLASH_URL,
        width=1280,
        height=800,
        min_size=(800, 600),
        resizable=True,
        text_select=False,
        frameless=False,
        hidden=True,
        js_api=WindowApi(),
    )

    _window = window
    app.window_ref = window

    def _set_icon():
        try:
            icon_path = str(BASE_DIR / 'icon.ico')
            native = window.native
            if not native or not hasattr(native, 'Handle'):
                return
            hwnd_int = native.Handle.ToInt64() if hasattr(native.Handle, 'ToInt64') else native.Handle.ToInt32()
            hwnd = ctypes.c_void_p(hwnd_int)
            ctypes.windll.user32.LoadImageW.restype = ctypes.c_void_p
            ctypes.windll.user32.SendMessageW.restype = ctypes.c_void_p
            hicon = ctypes.windll.user32.LoadImageW(None, ctypes.c_wchar_p(icon_path), 1, 0, 0, 0x00000010)
            if not hicon:
                return
            ctypes.windll.user32.SendMessageW(hwnd, 0x0080, 0, hicon)
            ctypes.windll.user32.SendMessageW(hwnd, 0x0080, 1, hicon)
            ctypes.windll.user32.SetClassLongPtrW(hwnd, -14, hicon)
            ctypes.windll.user32.SetClassLongPtrW(hwnd, -34, hicon)
        except Exception:
            pass

    def _on_loaded():
        _set_icon()
        try:
            native = window.native
            if native and hasattr(native, 'Handle'):
                hwnd_int = native.Handle.ToInt64() if hasattr(native.Handle, 'ToInt64') else native.Handle.ToInt32()
                hwnd = ctypes.c_void_p(hwnd_int)

                # Dark title bar
                try:
                    ctypes.windll.dwmapi.DwmSetWindowAttribute(
                        hwnd, 20, ctypes.byref(ctypes.c_int(1)), 4
                    )
                except Exception:
                    pass

                # Hide DWM NC rendering so our content shows through
                try:
                    ctypes.windll.dwmapi.DwmSetWindowAttribute(
                        hwnd, 2, ctypes.byref(ctypes.c_int(1)), 4
                    )
                except Exception:
                    pass

                # Install WndProc to handle NCCALCSIZE only
                NC_TOP = 0
                NC_EDGE = 0
                WNDPROC = ctypes.WINFUNCTYPE(
                    ctypes.c_long, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p
                )
                _CallWindowProc = ctypes.windll.user32.CallWindowProcW
                _CallWindowProc.restype = ctypes.c_long
                _CallWindowProc.argtypes = [
                    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p
                ]
                _DefWindowProc = ctypes.windll.user32.DefWindowProcW
                _DefWindowProc.restype = ctypes.c_long
                _DefWindowProc.argtypes = [
                    ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p
                ]

                try:
                    _SetWindowLong = ctypes.windll.user32.SetWindowLongPtrW
                    _SetWindowLong.restype = ctypes.c_void_p
                    _SetWindowLong.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
                except AttributeError:
                    _SetWindowLong = ctypes.windll.user32.SetWindowLongW
                    _SetWindowLong.restype = ctypes.c_long

                @WNDPROC
                def _hook(h, msg, wp, lp):
                    if msg == 0x0083:  # WM_NCCALCSIZE
                        try:
                            r = ctypes.cast(lp, ctypes.POINTER(ctypes.wintypes.RECT))
                            r[0].top += NC_TOP
                            r[0].left += NC_EDGE
                            r[0].right -= NC_EDGE
                            r[0].bottom -= NC_EDGE
                            return 0
                        except Exception:
                            pass
                    if msg == 0x8001:  # WM_APP+1 — drag from Flask
                        try:
                            ctypes.windll.user32.ReleaseCapture()
                            ctypes.windll.user32.SendMessageW(h, 0x00A1, 2, 0)
                        except Exception:
                            pass
                        return 0
                    return _CallWindowProc(orig, h, msg, wp, lp)

                @WNDPROC
                def _dummy(h, msg, wp, lp):
                    return _DefWindowProc(h, msg, wp, lp)
                orig = _SetWindowLong(hwnd, -4, ctypes.cast(_dummy, ctypes.c_void_p))
                _SetWindowLong(hwnd, -4, ctypes.cast(_hook, ctypes.c_void_p))
                _wndproc_refs.append((_hook, _dummy))

                ctypes.windll.user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                    0x0020 | 0x0002 | 0x0004 | 0x0001)
        except Exception:
            import traceback
            traceback.print_exc()
        try:
            window.show()
        except Exception:
            pass
    window.events.loaded += _on_loaded

    window.events.closing += _nuclear_exit
    window.events.closed += _nuclear_exit

    webview.start(gui='edgechromium', debug=False)

    _nuclear_exit()


if __name__ == '__main__':
    if any(a in sys.argv for a in ('--remove-bg', '--to-webp', '--folder-to-webp')):
        from context_menu_helper import main as helper_main
        helper_main()
    else:
        main()
