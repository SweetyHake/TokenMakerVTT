import threading
import time
import sys
import winreg
import webview
from server import app, load_session, DEVICE_NAME, BASE_DIR

PORT = 7878
URL = f'http://localhost:{PORT}'

HELPER_PATH = str(BASE_DIR / 'context_menu_helper.py')

REG_ENTRIES = [
    (
        r'Software\Classes\*\shell\TokenMaker_RemoveBg',
        'Удалить фон (Token Maker)',
        '--remove-bg'
    ),
    (
        r'Software\Classes\*\shell\TokenMaker_ToWebp',
        'Конвертировать в WebP (Token Maker)',
        '--to-webp'
    ),
]


def register_context_menu():
    try:
        python_exe = sys.executable
        for reg_path, label, flag in REG_ENTRIES:
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path)
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, label)
            winreg.SetValueEx(key, 'Icon', 0, winreg.REG_SZ, python_exe)
            winreg.CloseKey(key)

            cmd_key = winreg.CreateKey(
                winreg.HKEY_CURRENT_USER, reg_path + r'\command'
            )
            cmd = f'"{python_exe}" "{HELPER_PATH}" {flag} "%1"'
            winreg.SetValueEx(cmd_key, '', 0, winreg.REG_SZ, cmd)
            winreg.CloseKey(cmd_key)
        print('Контекстное меню зарегистрировано.')
    except Exception as e:
        print(f'Не удалось зарегистрировать контекстное меню: {e}')


def unregister_context_menu():
    try:
        for reg_path, _, _ in REG_ENTRIES:
            for subkey in [reg_path + r'\command', reg_path]:
                try:
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, subkey)
                except FileNotFoundError:
                    pass
        print('Контекстное меню удалено.')
    except Exception as e:
        print(f'Не удалось удалить контекстное меню: {e}')


def run_flask():
    app.run(
        host='127.0.0.1', port=PORT,
        debug=False, threaded=True, use_reloader=False
    )


def wait_for_server(timeout=15):
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(URL, timeout=1)
            return True
        except Exception:
            time.sleep(0.1)
    return False


def main():
    print('Загрузка модели...')
    try:
        load_session()
        print(f'Устройство: {DEVICE_NAME}')
    except Exception as e:
        print(f'Ошибка загрузки модели: {e}')

    register_context_menu()

    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()

    print('Ожидание сервера...')
    if not wait_for_server():
        print('Сервер не запустился за 15 секунд')
        unregister_context_menu()
        sys.exit(1)

    print(f'Открытие: {URL}')
    window = webview.create_window(
        title='Token Maker',
        url=URL,
        width=1280,
        height=800,
        min_size=(800, 600),
        resizable=True,
        text_select=False,
    )

    webview.start(gui='edgechromium', debug=False)

    unregister_context_menu()


if __name__ == '__main__':
    main()
