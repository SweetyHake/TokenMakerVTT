#!/usr/bin/env python3
import sys
import os
import urllib.request
import time
from pathlib import Path

PORT = 7878
BASE_URL = f'http://localhost:{PORT}'

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff', '.tif'}


def server_running():
    try:
        urllib.request.urlopen(f'{BASE_URL}/device', timeout=2)
        return True
    except Exception:
        return False


def remove_bg(file_path: str):
    file_path = Path(file_path)
    if not file_path.exists():
        sys.exit(1)

    if not server_running():
        _notify('Token Maker is not running. Open the app first.')
        sys.exit(1)

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
        out_path = file_path.with_suffix('.webp')
        out_path.write_bytes(result_data)
    except Exception:
        sys.exit(1)


def to_webp(file_path: str):
    from PIL import Image
    import io

    file_path = Path(file_path)
    if not file_path.exists():
        sys.exit(1)

    if file_path.suffix.lower() == '.webp':
        sys.exit(0)

    try:
        image = Image.open(file_path)
        out_path = file_path.with_suffix('.webp')
        buf = io.BytesIO()
        image.save(buf, format='WEBP', quality=90)
        out_path.write_bytes(buf.getvalue())
        if out_path != file_path:
            file_path.unlink()
    except Exception:
        sys.exit(1)


def folder_to_webp(folder_path: str):
    from PIL import Image
    import io

    folder = Path(folder_path)
    if not folder.exists() or not folder.is_dir():
        sys.exit(1)

    files = [
        f for f in folder.iterdir()
        if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS and f.suffix.lower() != '.webp'
    ]

    if not files:
        _notify('Нет изображений для конвертации.')
        sys.exit(0)

    converted = 0
    failed = 0

    for f in files:
        try:
            image = Image.open(f)
            out_path = f.with_suffix('.webp')
            buf = io.BytesIO()
            image.save(buf, format='WEBP', quality=90)
            out_path.write_bytes(buf.getvalue())
            image.close()
            f.unlink()
            converted += 1
        except Exception:
            failed += 1

    if failed:
        _notify(f'Конвертировано: {converted}, ошибок: {failed}')
    else:
        _notify(f'Готово! Конвертировано {converted} файлов в WebP.')


def _notify(message: str):
    try:
        import subprocess
        subprocess.Popen(
            [
                'powershell', '-WindowStyle', 'Hidden', '-Command',
                f'[System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null;'
                f'$n = New-Object System.Windows.Forms.NotifyIcon;'
                f'$n.Icon = [System.Drawing.SystemIcons]::Information;'
                f'$n.Visible = $true;'
                f'$n.ShowBalloonTip(4000, "Token Maker", "{message}", [System.Windows.Forms.ToolTipIcon]::Info);'
                f'Start-Sleep -Milliseconds 4500;'
                f'$n.Dispose()'
            ],
            creationflags=0x08000000
        )
    except Exception:
        pass


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(1)

    flag = sys.argv[1]
    file_arg = sys.argv[2]

    if flag == '--remove-bg':
        remove_bg(file_arg)
    elif flag == '--to-webp':
        to_webp(file_arg)
    elif flag == '--folder-to-webp':
        folder_to_webp(file_arg)
    else:
        sys.exit(1)
