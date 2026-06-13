import json
import logging
import sys
import time
from pathlib import Path
from threading import Lock, Thread
from urllib.request import Request, urlopen

from version import __version__, APP_NAME, GITHUB_REPO

_logger = logging.getLogger(__name__)

if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s %(name)s %(levelname)s: %(message)s",
    )

if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).parent

_CHECK_INTERVAL_HOURS = 6


class _UpdateState:
    """Thread-safe container for update check / download state."""

    def __init__(self):
        self.lock = Lock()
        self.checked = False
        self.available = None
        self.url = None
        self.tag = None
        self.download_progress = -1
        self.download_done = False
        self.download_error = None
        self.download_path = None

    def snapshot(self):
        with self.lock:
            return {
                "update_checked": self.checked,
                "update_available": self.available,
                "update_url": self.url,
                "update_tag": self.tag,
                "current_version": __version__,
                "download_progress": self.download_progress,
                "download_done": self.download_done,
                "download_error": self.download_error,
                "download_path": self.download_path,
            }

    def complete_check(self, available, url=None, tag=None):
        with self.lock:
            self.checked = True
            self.available = available
            self.url = url
            self.tag = tag

    def get_url(self):
        with self.lock:
            return self.url

    def set_download_progress(self, pct):
        with self.lock:
            self.download_progress = pct

    def complete_download(self, error=None, path=None):
        with self.lock:
            self.download_done = True
            self.download_error = error
            self.download_path = path
            if error is None:
                self.download_progress = 100


_state = _UpdateState()


def _api_url(path):
    return f"https://api.github.com/repos/{GITHUB_REPO}/{path}"


def _releases_url():
    return f"https://github.com/{GITHUB_REPO}/releases"


def _parse_version(v):
    try:
        parts = str(v).split(".")
        return tuple(int(p) for p in parts[:3])
    except Exception:
        return (0, 0, 0)


def _check_throttle_file():
    path = BASE_DIR / ".last_update_check"
    try:
        if path.exists():
            age = time.time() - path.stat().st_mtime
            return age < _CHECK_INTERVAL_HOURS * 3600
    except OSError:
        pass
    return False


def _touch_throttle_file():
    try:
        (BASE_DIR / ".last_update_check").touch()
    except OSError:
        pass


def _find_exe_asset(assets):
    """Find the first .exe asset whose name contains APP_NAME."""
    for asset in assets:
        name = asset.get("name", "")
        if name.endswith(".exe") and APP_NAME.lower() in name.lower():
            return asset.get("browser_download_url")
    return None


def check_for_updates(force=False):
    try:
        if not GITHUB_REPO:
            _state.complete_check(False)
            return

        if not force and _check_throttle_file():
            _logger.info("Skipping update check (throttled)")
            _state.complete_check(False)
            return

        req = Request(_api_url("releases/latest"))
        req.add_header("Accept", "application/vnd.github.v3+json")
        req.add_header("User-Agent", f"{APP_NAME}/{__version__}")

        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))

        latest_tag = data.get("tag_name", "").lstrip("v")
        assets = data.get("assets", [])

        if _parse_version(latest_tag) <= _parse_version(__version__):
            _touch_throttle_file()
            _state.complete_check(False)
            return

        url = _find_exe_asset(assets)
        if not url:
            url = data.get("html_url", _releases_url())

        _touch_throttle_file()
        _state.complete_check(True, url, latest_tag)
        _logger.info("Update available: %s", latest_tag)

    except Exception as exc:
        _logger.warning("Update check failed: %s", exc)
        _state.complete_check(False)


def download_update():
    try:
        url = _state.get_url()
        if not url:
            raise ValueError("No download URL")

        ext = Path(url.split("?")[0]).suffix or ".exe"
        if ext != ".exe":
            raise ValueError(f"Unsupported asset type: {ext}")

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
                        _state.set_download_progress(int(downloaded * 100 / total))

        _state.complete_download(path=str(dest))
        _logger.info("Update downloaded to %s", dest)

    except Exception as exc:
        _logger.error("Download failed: %s", exc)
        _state.complete_download(error=str(exc))


def start_background_tasks(force=False):
    Thread(target=lambda: check_for_updates(force=force), daemon=True).start()


def get_status():
    return _state.snapshot()
