import json
import os
import sys
import threading
import tempfile
from pathlib import Path
from urllib.request import urlopen, Request

from version import __version__, APP_NAME, GITHUB_REPO

if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).parent

UPDATE_CHECK_DONE = False
UPDATE_AVAILABLE = None
UPDATE_URL = None
UPDATE_TAG = None
UPDATE_DOWNLOAD_PROGRESS = -1
UPDATE_DOWNLOAD_DONE = False
UPDATE_DOWNLOAD_ERROR = None
UPDATE_DOWNLOAD_PATH = None


def _api_url(path):
    return f"https://api.github.com/repos/{GITHUB_REPO}/{path}"


def _releases_url():
    return f"https://github.com/{GITHUB_REPO}/releases"


def check_for_updates():
    global UPDATE_CHECK_DONE, UPDATE_AVAILABLE, UPDATE_URL, UPDATE_TAG
    try:
        if not GITHUB_REPO:
            UPDATE_CHECK_DONE = True
            UPDATE_AVAILABLE = False
            return

        req = Request(_api_url("releases/latest"))
        req.add_header("Accept", "application/vnd.github.v3+json")
        req.add_header("User-Agent", f"{APP_NAME}/{__version__}")

        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))

        latest_tag = data.get("tag_name", "").lstrip("v")
        assets = data.get("assets", [])

        UPDATE_TAG = latest_tag

        if _parse_version(latest_tag) > _parse_version(__version__):
            UPDATE_AVAILABLE = True
            for asset in assets:
                name = asset.get("name", "")
                if name.endswith(".exe") and APP_NAME.lower() in name.lower():
                    UPDATE_URL = asset.get("browser_download_url")
                    break
            if not UPDATE_URL:
                for asset in assets:
                    if asset.get("name", "").endswith((".7z", ".zip")):
                        UPDATE_URL = asset.get("browser_download_url")
                        break
            if not UPDATE_URL:
                UPDATE_URL = data.get("html_url", _releases_url())
        else:
            UPDATE_AVAILABLE = False

    except Exception:
        UPDATE_AVAILABLE = False
    finally:
        UPDATE_CHECK_DONE = True


def _parse_version(v):
    try:
        parts = str(v).split(".")
        return tuple(int(p) for p in parts[:3])
    except Exception:
        return (0, 0, 0)


def download_update():
    global UPDATE_DOWNLOAD_PROGRESS, UPDATE_DOWNLOAD_DONE, UPDATE_DOWNLOAD_ERROR, UPDATE_DOWNLOAD_PATH
    UPDATE_DOWNLOAD_PROGRESS = 0
    UPDATE_DOWNLOAD_DONE = False
    UPDATE_DOWNLOAD_ERROR = None

    try:
        url = UPDATE_URL
        if not url:
            raise ValueError("URL не найден")

        ext = Path(url.split("?")[0]).suffix or ".exe"
        dest = BASE_DIR / f"{APP_NAME}_new{ext}"

        req = Request(url)
        req.add_header("User-Agent", f"{APP_NAME}/{__version__}")

        with urlopen(req, timeout=300) as r:
            total = int(r.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 65536

            with open(dest, "wb") as f:
                while True:
                    chunk = r.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        UPDATE_DOWNLOAD_PROGRESS = int(downloaded * 100 / total)

        UPDATE_DOWNLOAD_PATH = str(dest)
        UPDATE_DOWNLOAD_PROGRESS = 100

    except Exception as e:
        UPDATE_DOWNLOAD_ERROR = str(e)
    finally:
        UPDATE_DOWNLOAD_DONE = True


def _replace_bat():
    if not UPDATE_DOWNLOAD_PATH:
        return ""
    src = UPDATE_DOWNLOAD_PATH
    dst = sys.executable if getattr(sys, 'frozen', False) else str(BASE_DIR / f"{APP_NAME}.exe")
    return f"""@echo off
choice /C YN /N /T 5 /D Y /M "Update {APP_NAME}? (Y/N, auto in 5s)"
if errorlevel 2 exit /b
ping 127.0.0.1 -n 2 > nul
copy /Y "{src}" "{dst}"
if exist "{src}" del "{src}"
start "" "{dst}"
"""


def start_background_tasks():
    threading.Thread(target=check_for_updates, daemon=True).start()


def get_status():
    return {
        "update_checked": UPDATE_CHECK_DONE,
        "update_available": UPDATE_AVAILABLE,
        "update_url": UPDATE_URL,
        "update_tag": UPDATE_TAG,
        "current_version": __version__,
        "download_progress": UPDATE_DOWNLOAD_PROGRESS,
        "download_done": UPDATE_DOWNLOAD_DONE,
        "download_error": UPDATE_DOWNLOAD_ERROR,
        "download_path": UPDATE_DOWNLOAD_PATH,
    }
