#!/usr/bin/env python3
import io
import sys
import base64
import warnings
import argparse
import numpy as np
from pathlib import Path
from flask import Flask, request, render_template, jsonify, send_file
from PIL import Image, ImageFilter, ImageDraw
import onnxruntime as ort
import os

warnings.filterwarnings('ignore')

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

BASE_DIR = Path(os.environ.get('TOKENMAKER_DIR', Path(__file__).parent))
ONNX_PATH = BASE_DIR / "model.onnx"
RING_DIR = BASE_DIR / "token_rings"
MASK_PATH = BASE_DIR / "mask.png"
PRESET_DIR = BASE_DIR

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'}
MAX_IMAGE_DIMENSION = 8192

SESSION = None
DEVICE_NAME = "Определение..."


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
    global SESSION
    if SESSION is None:
        if not ONNX_PATH.exists():
            raise FileNotFoundError(f"Файл не найден: {ONNX_PATH}")
        providers = get_providers()
        print(f"Загрузка на {DEVICE_NAME}...")

        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = max(1, os.cpu_count() // 2)
        opts.enable_mem_pattern = True
        opts.enable_mem_reuse = True
        opts.add_session_config_entry("session.disable_prepacking", "0")

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
    from PIL import ImageFilter
    import numpy as np

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


def create_default_ring(size, color=(100, 100, 100), width=40):
    scale = size / 1024
    w = int(width * scale)
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([w//2, w//2, size-w//2, size-w//2], outline=(*color, 255), width=w)
    return img


@app.route('/')
def index():
    return render_template('index.html')


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
def index():
    return render_template('index.html')


@app.route('/device')
def device():
    return jsonify({'device': DEVICE_NAME})


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
def preset():
    name = request.args.get('name', 'preset1')
    if not name.replace('_', '').replace('-', '').isalnum():
        return jsonify({'error': 'Invalid preset name'}), 400
    for ext in ['.png', '.webp', '.jpg']:
        preset_path = PRESET_DIR / f"{name}{ext}"
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
def process():
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
        image = validate_image(image)
        result = remove_background(image, edge_blur)
        buffer, mime = save_image(result, format_type, quality)
        return send_file(buffer, mimetype=mime, as_attachment=False, download_name=f'result.{format_type}')
    except Exception as e:
        app.logger.error('process error: %s', e, exc_info=True)
        return jsonify({'error': 'Ошибка обработки изображения'}), 500


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


if __name__ == '__main__':
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
        load_session()
        print(f"Device: {DEVICE_NAME}")
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
