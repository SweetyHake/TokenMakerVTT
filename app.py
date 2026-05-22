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


# Ядерный выход — TerminateProcess через WinAPI
kernel32 = ctypes.windll.kernel32


def _nuclear_exit():
    """Убивает процесс мгновенно, без оглядки на потоки и clean-up."""
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

    # SetConsoleCtrlHandler — ловит Ctrl+C и закрытие консоли
    kernel32.SetConsoleCtrlHandler(
        ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_uint)(lambda event: (kernel32.TerminateProcess(kernel32.GetCurrentProcess(), 0), True)[1]),
        1
    )

    PID_FILE = BASE_DIR / 'app.pid'

    # Убить предыдущую копию по PID-файлу
    if PID_FILE.exists():
        try:
            old_pid = int(PID_FILE.read_text())
            if old_pid != _os.getpid():
                subprocess.run(['taskkill', '/F', '/PID', str(old_pid)], capture_output=True)
                time.sleep(0.3)
        except Exception:
            pass

    # Убить процесс на порту (страховка)
    _kill_process_on_port(PORT)

    # Записать свой PID
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

    window = webview.create_window(
        title='Token Maker',
        url=SPLASH_URL,
        width=1280,
        height=800,
        min_size=(800, 600),
        resizable=True,
        text_select=False,
    )

    def _set_icon():
        try:
            icon_path = str(BASE_DIR / 'icon.ico')
            ctypes.windll.user32.LoadImageW.restype = ctypes.c_void_p
            ctypes.windll.user32.SendMessageW.restype = ctypes.c_void_p
            hwnd = window.native
            if not hwnd:
                return
            hwnd = ctypes.c_void_p(hwnd)
            hicon = ctypes.windll.user32.LoadImageW(
                None, ctypes.c_wchar_p(icon_path),
                1, 0, 0, 0x00000010
            )
            if not hicon:
                return
            ctypes.windll.user32.SendMessageW(hwnd, 0x0080, 0, hicon)
            ctypes.windll.user32.SendMessageW(hwnd, 0x0080, 1, hicon)
            ctypes.windll.user32.SetClassLongPtrW(hwnd, -14, hicon)
            ctypes.windll.user32.SetClassLongPtrW(hwnd, -34, hicon)
        except Exception:
            pass
    window.events.shown += _set_icon

    # --- Тройная гарантия завершения ---

    # 1) При закрытии окна (fires reliably на edgechromium)
    window.events.closing += _nuclear_exit

    # 2) После того как окно закрылось (backup)
    window.events.closed += _nuclear_exit

    webview.start(gui='edgechromium', debug=False)

    # 3) Если webview.start() вернулся — ядерный выход
    _nuclear_exit()


if __name__ == '__main__':
    if any(a in sys.argv for a in ('--remove-bg', '--to-webp', '--folder-to-webp')):
        from context_menu_helper import main as helper_main
        helper_main()
    else:
        main()
