#!/usr/bin/env python3
import sys
import os
import urllib.request
import urllib.parse
import json
import time
from pathlib import Path

PORT = 7878
BASE_URL = f'http://localhost:{PORT}'


def server_running():
    try:
        urllib.request.urlopen(f'{BASE_URL}/device', timeout=2)
        return True
    except Exception:
        return False


def remove_bg(file_path: str):
    file_path = Path(file_path)
    if not file_path.exists():
        print(f'Файл не найден: {file_path}', file=sys.stderr)
        sys.exit(1)

    if not server_running():
        print('Token Maker не запущен. Откройте приложение и попробуйте снова.')
        input('Нажмите Enter для выхода...')
        sys.exit(1)

    print(f'Удаление фона: {file_path.name}')

    with open(file_path, 'rb') as f:
        file_data = f.read()

    boundary = 'TokenMakerBoundary'
    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="image"; filename="{file_path.name}"\r\n'
        f'Content-Type: application/octet-stream\r\n\r\n'
    ).encode() + file_data + (
        f'\r\n--{boundary}\r\n'
        f'Content-Disposition: form-data; name="format"\r\n\r\nwebp'
        f'\r\n--{boundary}--\r\n'
    ).encode()

    req = urllib.request.Request(
        f'{BASE_URL}/process',
        data=body,
        headers={
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'Content-Length': str(len(body))
        },
        method='POST'
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result_data = resp.read()
        out_path = file_path.with_name(file_path.stem + '_nobg.webp')
        out_path.write_bytes(result_data)
        print(f'Сохранено: {out_path}')
    except Exception as e:
        print(f'Ошибка: {e}', file=sys.stderr)
        input('Нажмите Enter для выхода...')
        sys.exit(1)


def to_webp(file_path: str):
    from PIL import Image
    import io

    file_path = Path(file_path)
    if not file_path.exists():
        print(f'Файл не найден: {file_path}', file=sys.stderr)
        sys.exit(1)

    print(f'Конвертация в WebP: {file_path.name}')

    try:
        image = Image.open(file_path)
        out_path = file_path.with_suffix('.webp')
        buf = io.BytesIO()
        image.save(buf, format='WEBP', quality=90)
        out_path.write_bytes(buf.getvalue())
        print(f'Сохранено: {out_path}')
    except Exception as e:
        print(f'Ошибка: {e}', file=sys.stderr)
        input('Нажмите Enter для выхода...')
        sys.exit(1)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Использование: context_menu_helper.py --remove-bg <file>')
        print('               context_menu_helper.py --to-webp <file>')
        sys.exit(1)

    flag = sys.argv[1]
    file_arg = sys.argv[2]

    if flag == '--remove-bg':
        remove_bg(file_arg)
    elif flag == '--to-webp':
        to_webp(file_arg)
    else:
        print(f'Неизвестный флаг: {flag}', file=sys.stderr)
        sys.exit(1)
