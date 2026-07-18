#!/usr/bin/env python3
import io
import subprocess
import sys
import base64
import warnings
import argparse
import threading
import numpy as np
from pathlib import Path
from flask import Flask, request, render_template, jsonify, send_file, current_app
from PIL import Image, ImageFilter, ImageDraw
import onnxruntime as ort
import os
from version import __version__, APP_NAME, GITHUB_REPO
from updater import (
    get_status as updater_status,
    start_background_tasks,
    download_update,
    check_for_updates,
)

warnings.filterwarnings('ignore')

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(os.environ.get('TOKENMAKER_DIR', Path(__file__).parent))
ONNX_PATH = BASE_DIR / "model.onnx"
RING_DIR = BASE_DIR / "token_rings"
MASK_PATH = BASE_DIR / "mask.png"
PRESET_DIR = BASE_DIR

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'}
MAX_IMAGE_DIMENSION = 8192

SESSION = None
DEVICE_NAME = "Определение..."
_PROVIDERS = None


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def validate_image(image):
    if image.width > MAX_IMAGE_DIMENSION or image.height > MAX_IMAGE_DIMENSION:
        ratio = min(MAX_IMAGE_DIMENSION / image.width, MAX_IMAGE_DIMENSION / image.height)
        new_size = (int(image.width * ratio), int(image.height * ratio))
        image = image.resize(new_size, Image.LANCZOS)
    return image


def get_providers():
    global DEVICE_NAME
    available = ort.get_available_providers()

    VIRTUAL_ADAPTER_KEYWORDS = [
        'parsec', 'virtual', 'microsoft', 'basic', 'remote',
        'indirect', 'display only', 'rdp', 'teamviewer', 'anydesk'
    ]

    def is_real_gpu(name):
        name_lower = name.lower()
        return not any(kw in name_lower for kw in VIRTUAL_ADAPTER_KEYWORDS)

    def get_gpu_name_windows():
        try:
            import subprocess
            result = subprocess.run(
                ['powershell', '-Command',
                 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'],
                capture_output=True, text=True, timeout=5
            )
            names = [l.strip() for l in result.stdout.splitlines() if l.strip()]
            real = [n for n in names if is_real_gpu(n)]
            return real[0] if real else None
        except Exception:
            return None

    if 'DmlExecutionProvider' in available:
        gpu_name = get_gpu_name_windows()
        DEVICE_NAME = f'DirectML ({gpu_name})' if gpu_name else 'DirectML GPU'
        return ['DmlExecutionProvider', 'CPUExecutionProvider']

    elif 'ROCMExecutionProvider' in available:
        try:
            import subprocess
            result = subprocess.run(
                ['rocm-smi', '--showproductname'],
                capture_output=True, text=True, timeout=5
            )
            lines = [l.strip() for l in result.stdout.splitlines() if l.strip() and is_real_gpu(l)]
            gpu_name = lines[0] if lines else None
            DEVICE_NAME = f'ROCm ({gpu_name})' if gpu_name else 'ROCm GPU'
        except Exception:
            DEVICE_NAME = 'ROCm GPU'
        return ['ROCMExecutionProvider', 'CPUExecutionProvider']

    elif 'CUDAExecutionProvider' in available:
        try:
            import subprocess
            result = subprocess.run(
                ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                capture_output=True, text=True, timeout=5
            )
            gpu_name = result.stdout.strip().splitlines()[0].strip()
            DEVICE_NAME = f'CUDA ({gpu_name})' if gpu_name else 'NVIDIA GPU'
        except Exception:
            DEVICE_NAME = 'NVIDIA GPU'
        return ['CUDAExecutionProvider', 'CPUExecutionProvider']

    else:
        try:
            import platform
            cpu = platform.processor()
            if not cpu:
                import subprocess
                if sys.platform == 'win32':
                    result = subprocess.run(
                        ['powershell', '-Command',
                         '(Get-CimInstance Win32_Processor | Select-Object -First 1).Name'],
                        capture_output=True, text=True, timeout=5
                    )
                    cpu = result.stdout.strip()
                else:
                    result = subprocess.run(
                        ['grep', '-m1', 'model name', '/proc/cpuinfo'],
                        capture_output=True, text=True, timeout=5
                    )
                    cpu = result.stdout.split(':')[-1].strip() if ':' in result.stdout else ''
            DEVICE_NAME = cpu if cpu else 'CPU'
        except Exception:
            DEVICE_NAME = 'CPU'
        return ['CPUExecutionProvider']


def load_session():
    global SESSION, _PROVIDERS
    if SESSION is None:
        if not ONNX_PATH.exists():
            raise FileNotFoundError(f"Файл не найден: {ONNX_PATH}")
        providers = _PROVIDERS
        print(f"Загрузка на {DEVICE_NAME}...")

        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = max(1, os.cpu_count() // 2)
        opts.enable_mem_pattern = True
        opts.enable_mem_reuse = True
        opts.add_session_config_entry("session.disable_prepacking", "0")

        try:
            SESSION = ort.InferenceSession(
                str(ONNX_PATH),
                sess_options=opts,
                providers=providers
            )
        except Exception:
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
            SESSION = ort.InferenceSession(
                str(ONNX_PATH),
                sess_options=opts,
                providers=providers
            )

        print(f" Прогрев модели...")
        try:
            dummy = np.zeros((1, 3, 1024, 1024), dtype=np.float32)
            input_name = SESSION.get_inputs()[0].name
            SESSION.run(None, {input_name: dummy})
            del dummy
            import gc
            gc.collect()
            print(f" Прогрев завершён.")
        except Exception as e:
            print(f" Прогрев не удался: {e}")

        print(f" Готово!\n")
    return SESSION


def refine_mask(mask_pil, edge_blur=1, threshold_low=10, threshold_high=245):
    mask_np = np.array(mask_pil).astype(np.float32) / 255.0

    low = threshold_low / 255.0
    high = threshold_high / 255.0
    mask_np = np.clip((mask_np - low) / (high - low + 1e-8), 0.0, 1.0)
    mask_np = mask_np ** 1.2

    mask_pil = Image.fromarray((mask_np * 255).astype(np.uint8), mode='L')

    mask_pil = mask_pil.filter(ImageFilter.MinFilter(3))

    mask_np = np.array(mask_pil).astype(np.float32) / 255.0
    mask_np = np.where(mask_np < 0.15, 0.0, mask_np)
    mask_np = np.where(mask_np > 0.92, 1.0, mask_np)
    mask_pil = Image.fromarray((mask_np * 255).astype(np.uint8), mode='L')

    if edge_blur > 0:
        mask_pil = mask_pil.filter(ImageFilter.GaussianBlur(edge_blur * 0.35))

    return mask_pil


def remove_background(image, edge_blur=1):
    import psutil, os as _os, gc
    proc = psutil.Process(_os.getpid())

    def mem():
        return proc.memory_info().rss / 1024 / 1024

    session = load_session()
    orig_size = image.size
    print(f"  [RAM] старт обработки: {mem():.0f} МБ | размер входа: {image.size}")

    if image.mode != 'RGB':
        image = image.convert('RGB')

    img_resized = image.resize((1024, 1024), Image.LANCZOS)
    print(f"  [RAM] после resize: {mem():.0f} МБ")

    arr = np.array(img_resized, dtype=np.float32) / 255.0
    del img_resized
    gc.collect()
    print(f"  [RAM] после numpy arr: {mem():.0f} МБ")

    arr -= np.array([0.485, 0.456, 0.406], dtype=np.float32)
    arr /= np.array([0.229, 0.224, 0.225], dtype=np.float32)
    arr = arr.transpose(2, 0, 1)

    tensor = arr[np.newaxis]
    input_name = session.get_inputs()[0].name

    print(f"  [RAM] перед инференсом: {mem():.0f} МБ")
    output = session.run(None, {input_name: tensor})
    print(f"  [RAM] после инференса: {mem():.0f} МБ")

    del tensor, arr
    gc.collect()
    print(f"  [RAM] после del tensor: {mem():.0f} МБ")

    mask = output[0]
    del output
    gc.collect()
    print(f"  [RAM] после del output: {mem():.0f} МБ")

    while mask.ndim > 2:
        mask = mask.squeeze(0)
    if mask.ndim == 3:
        mask = mask[0]

    mask = 1.0 / (1.0 + np.exp(-mask))
    mn, mx = mask.min(), mask.max()
    mask = ((mask - mn) / (mx - mn + 1e-8) * 255).astype(np.uint8)

    mask_pil = Image.fromarray(mask, mode='L')
    del mask
    gc.collect()

    mask_pil = mask_pil.resize(orig_size, Image.LANCZOS)
    mask_pil = refine_mask(mask_pil, edge_blur)

    result = image.convert('RGBA')
    rgba_np = np.array(result)
    alpha_np = np.array(mask_pil)

    white_penalty = (rgba_np[:, :, 0].astype(np.float32) * 0.299 +
                     rgba_np[:, :, 1].astype(np.float32) * 0.587 +
                     rgba_np[:, :, 2].astype(np.float32) * 0.114)
    alpha_f = alpha_np.astype(np.float32)
    suppress = (white_penalty > 220) & (alpha_f < 180)
    alpha_f[suppress] = np.maximum(0, alpha_f[suppress] - (white_penalty[suppress] - 220) * 3.5)
    rgba_np[:, :, 3] = np.clip(alpha_f, 0, 255).astype(np.uint8)

    result = Image.fromarray(rgba_np, mode='RGBA')
    del rgba_np, alpha_np, mask_pil
    gc.collect()

    print(f"  [RAM] финал: {mem():.0f} МБ")
    return result


def save_image(image, format_type, quality=90):
    buffer = io.BytesIO()
    if format_type == 'webp':
        image.save(buffer, format='WEBP', quality=quality, lossless=False)
        mime = 'image/webp'
    elif format_type == 'png':
        image.save(buffer, format='PNG', optimize=True, compress_level=6)
        mime = 'image/png'
    elif format_type == 'jpg':
        if image.mode == 'RGBA':
            bg = Image.new('RGB', image.size, (255, 255, 255))
            bg.paste(image, mask=image.split()[3])
            image = bg
        image.save(buffer, format='JPEG', quality=quality)
        mime = 'image/jpeg'
    else:
        image.save(buffer, format='PNG', optimize=True)
        mime = 'image/png'
    buffer.seek(0)
    return buffer, mime


# ──────────────────────────────────────────────
#  ДЕТЕКЦИЯ ЛИЦА
# ──────────────────────────────────────────────

class FaceDetector:
    """Детекция лица: Haar Cascade (sf=1.3, mn=3, ms=5%)"""

    def __init__(self):
        self.haar = None
        if HAS_CV2:
            try:
                cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
                self.haar = cv2.CascadeClassifier(cascade_path)
            except Exception:
                self.haar = None

    def detect(self, pil_image):
        """
        Haar-детекция лица.
        Сначала пробует sf=1.3 (фулл-тело), затем sf=1.05 (поясные/портреты).
        Возвращает (face_cx, face_cy, face_size) или None.
        """
        if self.haar is None or not HAS_CV2:
            return None
        try:
            w, h = pil_image.size
            rgb = np.array(pil_image.convert('RGB'))
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            gray = cv2.equalizeHist(gray)
            min_sz = int(min(w, h) * 0.05)

            for sf, label in [(1.3, 'sf=1.3'), (1.05, 'sf=1.05')]:
                faces = self.haar.detectMultiScale(
                    gray, scaleFactor=sf, minNeighbors=3,
                    minSize=(min_sz, min_sz)
                )
                if len(faces) > 0:
                    faces_sorted = sorted(faces, key=lambda f: f[1])
                    x, y, fw, fh = faces_sorted[0]
                    cx = x + fw // 2
                    cy = y + fh // 2
                    sz = max(fw, fh)
                    print(f"  [Haar {label}] лицо: center=({cx},{cy}), size={sz}px")
                    return cx, cy, sz
        except Exception as e:
            print(f"  [FaceDetector] ошибка детекции: {e}")
        return None


# ──────────────────────────────────────────────
#  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ──────────────────────────────────────────────

def find_character_bounds(pil_image, threshold=15):
    """Находит bbox не-фонового содержимого"""
    arr = np.array(pil_image.convert('RGBA'))
    alpha = arr[:, :, 3]
    if alpha.max() < 200:
        gray = np.mean(arr[:, :, :3], axis=2)
        mask = gray < (255 - threshold)
    else:
        mask = alpha > threshold
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any():
        return 0, 0, pil_image.width, pil_image.height
    top    = int(np.argmax(rows))
    bottom = int(len(rows) - np.argmax(rows[::-1]) - 1)
    left   = int(np.argmax(cols))
    right  = int(len(cols) - np.argmax(cols[::-1]) - 1)
    return left, top, right, bottom


def make_circle_mask(size, feather=10):
    """Создаёт круговую L-маску с мягкими краями"""
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    m = feather
    draw.ellipse([m, m, size - m - 1, size - m - 1], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=feather * 0.6))
    return mask


def add_shadow(base_img, circle_cx, circle_cy, radius, shadow_blur=18, shadow_alpha=90):
    """Добавляет мягкую тень под кругом"""
    shadow_layer = Image.new('RGBA', base_img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(shadow_layer)
    offset = int(radius * 0.04)
    r = radius
    draw.ellipse(
        [circle_cx - r, circle_cy - r + offset,
         circle_cx + r, circle_cy + r + offset],
        fill=(0, 0, 0, shadow_alpha)
    )
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=shadow_blur))
    return Image.alpha_composite(shadow_layer, base_img)


def create_foundry_token(
    image,
    canvas_size=512,
    circle_ratio=0.55,
    head_scale=3.5,
    feather=12,
    add_drop_shadow=True,
):
    """
    Создаёт Foundry-токен: круг центрирован на лице,
    элементы снаружи — с fade-переходом.
    """
    W, H = image.size
    detector = FaceDetector()
    result = detector.detect(image)
    if result is None:
        raise RuntimeError("Лицо не найдено")
    face_cx, face_cy, face_size = result

    char_left, char_top, char_right, char_bottom = find_character_bounds(image)
    char_w = char_right - char_left
    char_h = char_bottom - char_top

    R_orig = int(face_size / 2 * head_scale)
    R_max = int(min(char_w, char_h) * 0.55)
    R_orig = min(R_orig, R_max)
    R_orig = max(R_orig, int(char_h * 0.2))

    circle_diameter = int(canvas_size * circle_ratio)
    R_canvas = circle_diameter // 2
    scale = circle_diameter / (2 * R_orig)

    face_offset_ratio = 0.28
    face_cy_canvas = int(R_canvas * (1.0 - face_offset_ratio))
    circle_cx_canvas = canvas_size // 2
    circle_cy_canvas = int(face_cy_canvas + R_canvas * face_offset_ratio +
                           (canvas_size - circle_diameter) * 0.18)

    final = Image.new('RGBA', (canvas_size, canvas_size), (255, 255, 255, 0))

    new_W = int(W * scale)
    new_H = int(H * scale)
    img_scaled = image.resize((new_W, new_H), Image.LANCZOS)

    face_cx_scaled = int(face_cx * scale)
    face_cy_scaled = int(face_cy * scale)
    paste_x = circle_cx_canvas - face_cx_scaled
    paste_y = circle_cy_canvas - face_cy_scaled - int(R_canvas * face_offset_ratio)

    # Внешний слой с fade
    outer_layer = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
    outer_layer.paste(img_scaled, (paste_x, paste_y), img_scaled)

    outer_mask = Image.new('L', (canvas_size, canvas_size), 255)
    draw_outer = ImageDraw.Draw(outer_mask)
    inner_r = R_canvas - feather
    draw_outer.ellipse(
        [circle_cx_canvas - inner_r, circle_cy_canvas - inner_r,
         circle_cx_canvas + inner_r, circle_cy_canvas + inner_r],
        fill=0
    )
    outer_mask = outer_mask.filter(ImageFilter.GaussianBlur(radius=feather * 1.5))

    r_ch, g_ch, b_ch, a_ch = outer_layer.split()
    a_new = Image.fromarray(
        (np.array(a_ch).astype(np.float32) *
         np.array(outer_mask).astype(np.float32) / 255).astype(np.uint8)
    )
    outer_layer.putalpha(a_new)

    # Тень
    if add_drop_shadow:
        final = add_shadow(final, circle_cx_canvas, circle_cy_canvas,
                           R_canvas, shadow_blur=int(R_canvas * 0.08))

    # Круговой вырез
    circle_layer = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
    circle_layer.paste(img_scaled, (paste_x, paste_y), img_scaled)

    mask_resized = make_circle_mask(R_canvas * 2, feather=feather)
    full_mask = Image.new('L', (canvas_size, canvas_size), 0)
    mask_offset_x = circle_cx_canvas - R_canvas
    mask_offset_y = circle_cy_canvas - R_canvas
    full_mask.paste(mask_resized, (mask_offset_x, mask_offset_y))

    r_ch, g_ch, b_ch, a_ch = circle_layer.split()
    a_new = Image.fromarray(
        (np.array(a_ch).astype(np.float32) *
         np.array(full_mask).astype(np.float32) / 255).astype(np.uint8)
    )
    circle_layer.putalpha(a_new)

    final = Image.alpha_composite(final, outer_layer)
    final = Image.alpha_composite(final, circle_layer)

    return final


# ──────────────────────────────────────────────
#  END — Face Detection & Token Creation
# ──────────────────────────────────────────────


def create_default_ring(size, color=(100, 100, 100), width=40):
    scale = size / 1024
    w = int(width * scale)
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([w//2, w//2, size-w//2, size-w//2], outline=(*color, 255), width=w)
    return img


@app.route('/')
def index():
    theme = 'indigo'
    config_path = BASE_DIR / 'config.json'
    if config_path.exists():
        try:
            import json
            cfg = json.loads(config_path.read_text(encoding='utf-8'))
            theme = cfg.get('theme', 'indigo')
        except Exception:
            pass
    return render_template('index.html', github_repo=GITHUB_REPO, theme=theme)

@app.route('/version')
def version_info():
    return jsonify({'version': __version__, 'name': APP_NAME})

@app.route('/icon')
def app_icon():
    return send_file(BASE_DIR / 'icon.ico', mimetype='image/x-icon')


@app.route('/splash')
def splash():
    return render_template('splash.html')


@app.route('/api/window/<action>', methods=['POST'])
def window_action(action):
    win = getattr(current_app, 'window_ref', None)
    if not win:
        return jsonify({'ok': False, 'error': 'no window'})
    try:
        if action == 'minimize':
            win.minimize()
        elif action == 'maximize':
            win.maximize()
        elif action == 'restore':
            win.restore()
        elif action in ('close', 'destroy'):
            win.destroy()
        elif action == 'move':
            import ctypes
            native = win.native
            if native:
                hwnd = native.Handle.ToInt64() if hasattr(native.Handle, 'ToInt64') else int(native.Handle)
                ctypes.windll.user32.PostMessageW(ctypes.c_void_p(hwnd), 0x8001, 0, 0)
            return jsonify({'ok': True})
        else:
            return jsonify({'ok': False, 'error': 'unknown action'})
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})


@app.route('/presets_list')
def presets_list():
    extensions = {'.png', '.webp', '.jpg', '.jpeg'}
    preset_dir = BASE_DIR / 'presets'
    if not preset_dir.exists():
        preset_dir.mkdir(exist_ok=True)
    presets = []
    for f in sorted(preset_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in extensions:
            presets.append({'name': f.stem, 'file': f.name})
    return jsonify(presets)


@app.route('/preset_file/<filename>')
def preset_file(filename):
    safe = Path(filename).name
    preset_dir = BASE_DIR / 'presets'
    path = preset_dir / safe
    if not path.exists() or not path.is_file():
        return jsonify({'error': 'Not found'}), 404
    ext = path.suffix.lower()
    mime_map = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
    mime = mime_map.get(ext, 'image/octet-stream')
    response = send_file(str(path), mimetype=mime)
    response.headers['Cache-Control'] = 'public, max-age=86400'
    return response


@app.route('/device')
def device():
    return jsonify({'device': DEVICE_NAME})


@app.route('/update_status')
def update_status():
    return jsonify(updater_status())


@app.route('/start_update_download', methods=['POST'])
def start_update_download():
    threading.Thread(target=download_update, daemon=True).start()
    return jsonify({'ok': True})


@app.route('/check_update', methods=['POST'])
def check_update():
    threading.Thread(target=lambda: check_for_updates(force=True), daemon=True).start()
    return jsonify({'ok': True})


@app.route('/apply_update', methods=['POST'])
def apply_update():
    try:
        s = updater_status()
        src = s.get('download_path', '')
        if not src:
            return jsonify({'error': 'No update file'}), 400

        dst = sys.executable if getattr(sys, 'frozen', False) else str(BASE_DIR / 'TokenMaker.exe')
        exe_name = os.path.basename(dst)

        bat = BASE_DIR / '_update.bat'
        bat.write_text(
            f'@echo off\n'
            f':loop\n'
            f'tasklist /FI "IMAGENAME eq {exe_name}" 2>nul | find /I "{exe_name}" >nul\n'
            f'if not errorlevel 1 (\n'
            f'    ping 127.0.0.1 -n 2 > nul\n'
            f'    goto loop\n'
            f')\n'
            f'copy /Y "{src}" "{dst}" > nul\n'
            f'if exist "{src}" del "{src}" > nul\n'
            f'start "" "{dst}"\n'
            f'del "%~f0"\n',
            encoding='utf-8'
        )
        subprocess.Popen(
            ['cmd', '/c', str(bat)],
            shell=True, close_fds=True,
            creationflags=0x08000000
        )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/ring')
def ring():
    size = request.args.get('size', '1024')
    if size not in ('512', '1024', '2048'):
        size = '1024'
    ring_files = {
        '512': RING_DIR / 'token512.webp',
        '1024': RING_DIR / 'token1024.webp',
        '2048': RING_DIR / 'token2048.webp'
    }
    ring_path = ring_files.get(size)
    if ring_path and ring_path.exists():
        response = send_file(str(ring_path), mimetype='image/webp')
        response.headers['Cache-Control'] = 'public, max-age=86400'
        return response
    size_int = int(size)
    img = create_default_ring(size_int)
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    buffer.seek(0)
    response = send_file(buffer, mimetype='image/png')
    response.headers['Cache-Control'] = 'public, max-age=86400'
    return response


@app.route('/mask')
def mask():
    if MASK_PATH.exists():
        response = send_file(str(MASK_PATH), mimetype='image/png')
        response.headers['Cache-Control'] = 'public, max-age=86400'
        return response
    img = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    buffer.seek(0)
    response = send_file(buffer, mimetype='image/png')
    response.headers['Cache-Control'] = 'public, max-age=86400'
    return response


@app.route('/preset')
def preset():
    name = request.args.get('name', 'preset1')
    if not name.replace('_', '').replace('-', '').isalnum():
        return jsonify({'error': 'Invalid preset name'}), 400
    preset_dir = BASE_DIR / 'presets'
    for ext in ['.png', '.webp', '.jpg']:
        preset_path = preset_dir / f"{name}{ext}"
        if preset_path.exists():
            mime = 'image/png' if ext == '.png' else 'image/webp' if ext == '.webp' else 'image/jpeg'
            response = send_file(str(preset_path), mimetype=mime)
            response.headers['Cache-Control'] = 'public, max-age=86400'
            return response
    return jsonify({'error': 'Preset not found'}), 404


@app.route('/example')
def example():
    example_path = PRESET_DIR / 'example.png'
    if example_path.exists():
        response = send_file(str(example_path), mimetype='image/png')
        response.headers['Cache-Control'] = 'public, max-age=86400'
        return response
    for ext in ['.webp', '.jpg']:
        alt_path = PRESET_DIR / f'example{ext}'
        if alt_path.exists():
            mime = 'image/webp' if ext == '.webp' else 'image/jpeg'
            response = send_file(str(alt_path), mimetype=mime)
            response.headers['Cache-Control'] = 'public, max-age=86400'
            return response
    return jsonify({'error': 'Example not found'}), 404


@app.route('/process', methods=['POST'])
def process():
    import gc

    if 'image' not in request.files:
        return jsonify({'error': 'Нет изображения'}), 400
    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
    if not allowed_file(file.filename):
        return jsonify({'error': 'Недопустимый формат файла'}), 400

    format_type = request.form.get('format', 'webp')
    if format_type not in ('webp', 'png', 'jpg'):
        format_type = 'webp'
    try:
        quality = min(100, max(10, int(request.form.get('quality', 90))))
    except (ValueError, TypeError):
        quality = 90
    try:
        edge_blur = min(10, max(0, float(request.form.get('edge_blur', 1))))
    except (ValueError, TypeError):
        edge_blur = 1.0

    try:
        image = Image.open(file.stream)
        image.load()
        image = validate_image(image)
        result = remove_background(image, edge_blur)
        del image
        gc.collect()

        buffer, mime = save_image(result, format_type, quality)
        del result
        gc.collect()

        return send_file(buffer, mimetype=mime, as_attachment=False,
                        download_name=f'result.{format_type}')
    except Exception as e:
        gc.collect()
        app.logger.error('process error: %s', e, exc_info=True)
        return jsonify({'error': 'Ошибка обработки изображения'}), 500


@app.route('/convert', methods=['POST'])
def convert_file():
    if 'image' not in request.files:
        return jsonify({'error': 'Нет изображения'}), 400
    file = request.files['image']

    format_type = request.form.get('format', 'webp')
    if format_type not in ('webp', 'png', 'jpg', 'bmp', 'gif', 'tiff'):
        format_type = 'webp'
    try:
        quality = min(100, max(10, int(request.form.get('quality', 90))))
    except (ValueError, TypeError):
        quality = 90

    try:
        image = Image.open(file.stream)
        image.load()

        buffer, mime = save_image(image, format_type, quality)
        del image

        return send_file(buffer, mimetype=mime, as_attachment=False,
                        download_name=f'converted.{format_type}')
    except Exception as e:
        app.logger.error('convert error: %s', e, exc_info=True)
        return jsonify({'error': 'Ошибка конвертации изображения'}), 500


@app.route('/detect_face', methods=['POST'])
def detect_face():
    """Принимает изображение, возвращает координаты лица"""
    if 'image' not in request.files:
        return jsonify({'error': 'Нет изображения'}), 400
    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
    if not allowed_file(file.filename):
        return jsonify({'error': 'Недопустимый формат файла'}), 400

    try:
        image = Image.open(file.stream).convert('RGBA')
        image.load()
        detector = FaceDetector()
        result = detector.detect(image)
        if result is None:
            return jsonify({'error': 'Лицо не найдено'}), 404
        cx, cy, size = result
        return jsonify({
            'face_cx': int(cx),
            'face_cy': int(cy),
            'face_size': int(size),
            'image_width': int(image.width),
            'image_height': int(image.height),
            'detection_method': 'haar',
        })
    except Exception as e:
        app.logger.error('detect_face error: %s', e, exc_info=True)
        return jsonify({'error': 'Ошибка определения лица'}), 500


@app.route('/create_token', methods=['POST'])
def create_token():
    """Создаёт Foundry-токен: детекция лица + круговая обрезка + тень"""
    import gc

    if 'image' not in request.files:
        return jsonify({'error': 'Нет изображения'}), 400
    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
    if not allowed_file(file.filename):
        return jsonify({'error': 'Недопустимый формат файла'}), 400

    format_type = request.form.get('format', 'webp')
    if format_type not in ('webp', 'png', 'jpg'):
        format_type = 'webp'
    try:
        quality = min(100, max(10, int(request.form.get('quality', 90))))
    except (ValueError, TypeError):
        quality = 90
    try:
        canvas_size = min(2048, max(256, int(request.form.get('canvas_size', 512))))
    except (ValueError, TypeError):
        canvas_size = 512
    try:
        head_scale = min(5.0, max(2.0, float(request.form.get('head_scale', 3.5))))
    except (ValueError, TypeError):
        head_scale = 3.5
    try:
        feather = min(30, max(0, int(request.form.get('feather', 12))))
    except (ValueError, TypeError):
        feather = 12
    add_shadow = request.form.get('add_drop_shadow', 'true').lower() in ('true', '1', 'yes')

    try:
        image = Image.open(file.stream)
        image.load()
        image = validate_image(image).convert('RGBA')
        result = create_foundry_token(
            image,
            canvas_size=canvas_size,
            circle_ratio=0.55,
            head_scale=head_scale,
            feather=feather,
            add_drop_shadow=add_shadow,
        )
        del image
        gc.collect()

        buffer, mime = save_image(result, format_type, quality)
        del result
        gc.collect()

        return send_file(buffer, mimetype=mime, as_attachment=False,
                        download_name=f'token.{format_type}')
    except Exception as e:
        gc.collect()
        app.logger.error('create_token error: %s', e, exc_info=True)
        return jsonify({'error': 'Ошибка создания токена'}), 500


@app.route('/rings_list')
def rings_list():
    extensions = {'.webp', '.png', '.jpg', '.jpeg'}
    if not RING_DIR.exists():
        RING_DIR.mkdir(exist_ok=True)
    rings = []
    for f in sorted(RING_DIR.iterdir()):
        if f.is_file() and f.suffix.lower() in extensions:
            mime_map = {'.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
            rings.append({'name': f.stem, 'file': f.name, 'mime': mime_map.get(f.suffix.lower(), 'image/png')})
    return jsonify(rings)


@app.route('/ring_file/<filename>')
def ring_file(filename):
    safe = Path(filename).name
    path = RING_DIR / safe
    if not path.exists() or not path.is_file():
        return jsonify({'error': 'Not found'}), 404
    ext = path.suffix.lower()
    mime_map = {'.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
    mime = mime_map.get(ext, 'image/octet-stream')
    response = send_file(str(path), mimetype=mime)
    response.headers['Cache-Control'] = 'public, max-age=86400'
    return response


def cli_remove_bg(input_path: str):
    input_path = Path(input_path)
    if not input_path.exists():
        print(f"Файл не найден: {input_path}", file=sys.stderr)
        sys.exit(1)
    print(f"Удаление фона: {input_path.name}")
    load_session()
    image = Image.open(input_path)
    image = validate_image(image)
    result = remove_background(image)
    out_path = input_path.with_name(input_path.stem + '_nobg.webp')
    buf, _ = save_image(result, 'webp', 90)
    out_path.write_bytes(buf.read())
    print(f"Сохранено: {out_path}")


def cli_to_webp(input_path: str):
    input_path = Path(input_path)
    if not input_path.exists():
        print(f"Файл не найден: {input_path}", file=sys.stderr)
        sys.exit(1)
    print(f"Конвертация в WebP: {input_path.name}")
    image = Image.open(input_path)
    out_path = input_path.with_suffix('.webp')
    buf, _ = save_image(image, 'webp', 90)
    out_path.write_bytes(buf.read())
    print(f"Сохранено: {out_path}")


if __name__ == '__main__' and not getattr(sys, 'frozen', False):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--remove-bg', metavar='FILE')
    parser.add_argument('--to-webp', metavar='FILE')
    args, _ = parser.parse_known_args()

    if args.remove_bg:
        cli_remove_bg(args.remove_bg)
    elif args.to_webp:
        cli_to_webp(args.to_webp)
    else:
        print("\n" + "=" * 50)
        print("Background Remover & Token Maker")
        print("=" * 50)
        try:
            load_session()
            print(f"Device: {DEVICE_NAME}")
        except Exception as e:
            print(f"Model: {e}")
        print("http://localhost:7878")
        print("=" * 50 + "\n")
        app.run(host='0.0.0.0', port=7878, debug=False, threaded=True)

@app.route('/save_file', methods=['POST'])
def save_file():
    import tkinter as tk
    from tkinter import filedialog

    suggested = request.form.get('filename', 'file.webp')
    ext = suggested.rsplit('.', 1)[-1].lower() if '.' in suggested else 'webp'
    mime_map = {'webp': 'WebP Image', 'png': 'PNG Image', 'jpg': 'JPEG Image'}
    label = mime_map.get(ext, 'File')

    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400

    data = request.files['file'].read()

    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    path = filedialog.asksaveasfilename(
        initialfile=suggested,
        defaultextension='.' + ext,
        filetypes=[(label, '*.' + ext), ('All files', '*.*')]
    )
    root.destroy()

    if not path:
        return jsonify({'cancelled': True})

    try:
        Path(path).write_bytes(data)
        return jsonify({'saved': True, 'path': path})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500

@app.route('/pick_folder', methods=['GET'])
def pick_folder():
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    path = filedialog.askdirectory()
    root.destroy()

    if not path:
        return jsonify({'cancelled': True})

    return jsonify({'path': path})

@app.route('/save_to_folder', methods=['POST'])
def save_to_folder():
    folder = request.form.get('folder', '')
    filename = request.form.get('filename', 'file.webp')

    if not folder:
        return jsonify({'error': 'No folder'}), 400
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400

    folder_path = Path(folder)
    if not folder_path.exists() or not folder_path.is_dir():
        return jsonify({'error': 'Invalid folder'}), 400

    data = request.files['file'].read()
    out = folder_path / Path(filename).name

    try:
        out.write_bytes(data)
        return jsonify({'saved': True, 'path': str(out)})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500

@app.route('/pick_image_to_open', methods=['GET'])
def pick_image_to_open():
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    path = filedialog.askopenfilename(
        title='Выберите изображение',
        filetypes=[('Images', '*.webp *.png *.jpg *.jpeg'), ('All files', '*.*')]
    )
    root.destroy()

    if not path:
        return jsonify({'cancelled': True})

    path_obj = Path(path)
    ext = path_obj.suffix.lower()
    mime_map = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
    mime = mime_map.get(ext, 'image/octet-stream')

    with open(path_obj, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('utf-8')

    return jsonify({
        'path': str(path_obj.resolve()),
        'mime': mime,
        'data': b64
    })


@app.route('/list_images', methods=['POST'])
def list_images():
    data = request.get_json(force=True, silent=True) or {}
    path_str = data.get('path', '')
    if not path_str:
        return jsonify({'error': 'No path provided'}), 400
    path = Path(path_str)
    parent = path.parent
    if not parent.exists():
        return jsonify({'error': 'Directory not found'}), 404

    extensions = {'.webp', '.png', '.jpg', '.jpeg'}
    files = []
    for f in sorted(parent.iterdir()):
        if f.is_file() and f.suffix.lower() in extensions:
            files.append(str(f.resolve()))

    current_name = path.resolve().name
    current_index = -1
    for i, fp in enumerate(files):
        if Path(fp).name == current_name:
            current_index = i
            break

    return jsonify({
        'folder': str(parent.resolve()),
        'files': files,
        'currentIndex': current_index,
        'total': len(files)
    })


@app.route('/get_image_by_path')
def get_image_by_path():
    path_str = request.args.get('path', '')
    if not path_str:
        return jsonify({'error': 'No path'}), 400
    path = Path(path_str)
    if not path.exists() or not path.is_file():
        return jsonify({'error': 'File not found'}), 404
    ext = path.suffix.lower()
    mime_map = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
    mime = mime_map.get(ext, 'image/octet-stream')
    return send_file(str(path), mimetype=mime)


@app.route('/config', methods=['GET'])
def get_config():
    config_path = BASE_DIR / 'config.json'
    if not config_path.exists():
        return jsonify({})
    try:
        import json
        return jsonify(json.loads(config_path.read_text(encoding='utf-8')))
    except Exception:
        return jsonify({})

@app.route('/config', methods=['POST'])
def save_config():
    import json
    config_path = BASE_DIR / 'config.json'
    try:
        data = request.get_json(force=True, silent=True) or {}
        config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


@app.route('/shutdown', methods=['POST'])
def shutdown():
    """Остановить Flask-сервер"""
    try:
        func = request.environ.get('werkzeug.server.shutdown')
        if func:
            func()
        return 'ok'
    except Exception:
        return 'error', 500


# Detect device at import time (without loading the model)
try:
    _PROVIDERS = get_providers()
except Exception:
    _PROVIDERS = ['CPUExecutionProvider']
