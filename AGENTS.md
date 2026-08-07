# Token Maker — AGENTS.md

## Commands

```bat
start.bat              # auto-installs deps + launches desktop app (pywebview, no console)
launch.vbs             # launches start.bat completely hidden (no window at all)
python app.py          # launches with console (for debugging)
python server.py       # standalone Flask on :7878 (no GUI window)
python server.py --remove-bg <file>   # CLI: remove background, saves <stem>_nobg.webp
python server.py --to-webp <file>     # CLI: convert to WebP, deletes original
```

## Build

```bat
build_installer.bat       # Step 1: PyInstaller -> Step 2: Inno Setup installer
build.bat                 # PyInstaller only (portable folder)
```

PyInstaller output: `dist/TokenMaker/TokenMaker.exe`
Installer output: `dist/installer/TokenMaker_Setup_v*.exe`

### GitHub Releases: только установщик

В релизы загружается ТОЛЬКО `TokenMaker_Setup_v*.exe`. Голый `dist/TokenMaker/TokenMaker.exe` (~9 МБ) — это тонкий загрузчик PyInstaller без папки `_internal` (его нельзя качать отдельно, без `_internal` он не запустится). Если снова понадобится портативная версия — заливать ZIP всей папки `dist/TokenMaker/`.

ВНИМАНИЕ: автообновление (`updater.py:_find_exe_asset`) пропускает установщики (имена с "setup"/"installer") — их нельзя копировать поверх exe приложения. Пока в релизе один ассет (установщик), в приложении показывается «доступна новая версия» со ссылкой на GitHub, автоскачивание недоступно. Если вернётся автообновление — нужен ассет с именем `TokenMaker.exe` (без "setup"), либо доработка апдейтера под установщик (`/SILENT`).

Model files (`*.onnx`) are NOT bundled — user places them into the `models/` folder next to the exe and picks one in Settings (только `.onnx`).

### Inno Setup

To build the installer, install Inno Setup from https://jrsoftware.org/isdl.php
and run `build_installer.bat`. Or manually:

```bat
python -m PyInstaller build.spec
iscc installer.iss
```

## Bundled assets (included in .exe build)

- `templates/` — Jinja2 HTML templates
- `static/` — JS, CSS, workers
- `token_rings/` — ring overlay images
- `presets/` — preset mask images
- `version.py` — version & repo config

## Dependencies

`start.bat` auto-installs: `onnxruntime-directml`, `numpy`, `Pillow`, `flask`, `pywebview`, `psutil`

No `requirements.txt` — the batch file is the source of truth.

## Version & updates

- `version.py:GITHUB_REPO` — set to `"username/TokenMakerVTT"` before building
- On startup, `updater.py` checks GitHub Releases for newer version
- If newer version found, splash screen shows download button
- `model.onnx` is NOT auto-downloaded — the user places it into `models/` and selects it in Settings (see "External assets")

## Architecture

- **Desktop shell**: pywebview (edgechromium) → `app.py:138-148`
- **Web server**: Flask on `127.0.0.1:7878` → `server.py`
- **AI inference**: ONNX Runtime with a model from `models/` folder (BiRefNet **или** RMBG-2.0/IS-Net — обе поддерживаются), выбор модели в настройках (`/models_list`, `/select_model`). `get_providers()` in `server.py` detects physical GPUs via WMI (virtual/Parsec/RDP adapters are filtered), then picks CUDA (NVIDIA) → ROCm → DirectML → CPU. Runtime fallback to CPU if the GPU provider fails to load.
- **Frontend**: Vanilla JS, global `state` object mutated directly by all modules
- **Canvas**: internal 2048×2048 px, logical coords in 1024 px space (scale factor = 2)

## Critical file: `server.py` gotchas

- **Duplicate route functions**: Several `@app.route` functions have orphaned duplicates below them as plain `def` (no decorator) — these are dead code but harmless. Example: `def index()` at line 333, `def process()` at line 469, `def preset()` at line 396.
- Every `@app.route` must be declared exactly once with the decorator.
- Models live in `BASE_DIR/models/` (`get_selected_model_path()`: config `selected_model` → первый `*.onnx`). При первом запуске `model.onnx` из `BASE_DIR` автоматически перемещается в `models/`.

## JS load order (strict, from `index.html` lines 713-725)

```
config.js → state.js → utils.js → urlManager.js → tokenEffects.js →
tokenHistory.js → tokenPresets.js → tokenCanvas.js → tokenEditor.js →
portraitGenerator.js → hotkeySettings.js → remover.js → main.js
```

Breaking this order causes runtime errors because objects reference each other.

## Frontend conventions

- ObjectURLs must use `urlManager.create()` / `urlManager.revoke()` — never `URL.createObjectURL()` directly
- `$(id)` = `document.getElementById(id)` from `utils.js`
- `debounce(fn, ms)` from `utils.js` for expensive history saves
- No frameworks, no inline CSS (except dynamic `.style.display`), CSS custom properties in `:root`
- All ObjectURLs in `state.userImage*` freed via `urlManager.revokeAll()` on new image load

## Server routes (non-obvious)

## Face detection cascade

Haar → heuristic

If OpenCV DNN model files (`opencv_face_detector_uint8.pb` + `.pbtxt`) exist in OpenCV's data dir, DNN is tried before Haar.

External models (`.gitignore`d):
- `model.onnx` — BiRefNet или RMBG-2.0/IS-Net (background removal)

### `model.onnx` требования

- Вход: 1024×1024×3 RGB, ImageNet-нормализация (mean 0.485/0.456/0.406, std 0.229/0.224/0.225) — всё это делает `server.py` сам
- Выход: одноканальная маска 1024×1024. Если выход уже в [0,1] (RMBG-2.0 `alphas` содержит sigmoid в графе) — sigmoid повторно НЕ применяется (`server.py` detect: `mask.min() >= 0 and mask.max() <= 1`); для сырых logits (BiRefNet) — применяется
- Вход/выход могут быть объявлены как `dynamic` (напр. `[1,3,'height','width']`), но фактически модель может требовать ровно 1024×1024 (фикс. split в декодере)
- Источник: HuggingFace, напр. `briaai/RMBG-2.0` (`onnx/model_fp16.onnx`, ~514 МБ) или `DanielLavric/BiRefNet-ONNX`
- `server.py` грузит с `ORT_ENABLE_EXTENDED`, при падении (`InsertedPrecisionFreeCast` — известный баг ORT на LayerNorm-fusion) откатывается на `ORT_ENABLE_BASIC`

| Route | Note |
|-------|------|
| `/save_file` POST | Opens native Windows file dialog via tkinter. Expects `file` + `filename` in form. |
| `/pick_folder` GET | Native folder picker via tkinter. |
| `/save_to_folder` POST | Write file to a given folder path. |
| `/config` GET/POST | Reads/writes `config.json` in BASE_DIR (`.gitignore`d). |
| `/presets_list` | Reads from `presets/` subfolder (not BASE_DIR root). |
| `/preset_file/<filename>` | Serves from `presets/` subfolder. |
| `/process` POST | Background removal. Accepts `image` (file), `format` (webp/png/jpg), `quality` (int 10-100), `edge_blur` (float 0-10). |
| `/detect_face` POST | Face detection via MediaPipe/OpenCV/heuristic. Returns `{face_cx, face_cy, face_size, image_width, image_height}`. |
| `/create_token` POST | Full Foundry token creation: face detection + circular crop + fade + drop shadow. Accepts same as `/process` plus `canvas_size` (256-2048), `head_scale` (2.0-5.0), `feather` (0-30), `add_drop_shadow` (true/false). |

## New features (v2 integration)

### Token Editor — "Auto Token" button (hotkey: H)
Calls `/create_token` to produce a ready-made Foundry token (face detection → circular crop + fade + shadow) and loads it into the editor. One-click token creation.

### Remover — "Режим токена" toggle
When enabled, sends images to `/create_token` instead of `/process`. Produces ready-made Foundry-style tokens with circular crop, fade, and shadow in one step. Toggle is next to the quality slider.

## Hotkeys

Stored in `config.json`, managed by `AppConfig` (JS) with a rebindable UI in `hotkeySettings.js`. Defaults in `config.js:DEFAULT_HOTKEYS`. Hardcoded secondary bindings in `config.js:MOVE_KEYS`, `ROTATE_KEYS`, `ERASER_SIZE_KEYS`.

## New modules (beyond old CLAUDE.md)

- `portraitGenerator.js` — separate canvas for portrait-oriented token creation
- `hotkeySettings.js` — UI for rebinding keyboard shortcuts
- `eraserWorker.js` — Web Worker for performant eraser brush application on mask canvas
- `context_menu_helper.py` — Windows context menu handler (registered/unregistered by `app.py`)

## Common pitfalls

| Symptom | Likely cause |
|---------|-------------|
| /process returns 500 | Модель missing в `models/` (баннер + выбор в настройках) |
| Rings don't load | Syntax error in `tokenPresets.js` prevents parsing |
| Image doesn't render | `state.userImage` or `state.maskCanvas` is null |
| ObjectURL leak | `urlManager` bypassed |
| Route 404 | Duplicate `def` without `@app.route` shadowing the real one |
| Flask won't start | Port 7878 already in use |

## External assets

- `model.onnx` — BiRefNet или RMBG-2.0/IS-Net, кладётся вручную в `models/` (не в репозитории, в `.gitignore`)
- `token_rings/` — folder with ring PNG/WebP files (optional)
- `presets/` — folder with preset mask images (optional)
- Images loaded from clipboard/files are never stored on disk
