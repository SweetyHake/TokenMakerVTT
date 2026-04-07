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
    if 'DmlExecutionProvider' in available:
        DEVICE_NAME = "DirectML (AMD GPU)"
        return ['DmlExecutionProvider', 'CPUExecutionProvider']
    elif 'ROCMExecutionProvider' in available:
        DEVICE_NAME = "ROCm (AMD GPU)"
        return ['ROCMExecutionProvider', 'CPUExecutionProvider']
    elif 'CUDAExecutionProvider' in available:
        DEVICE_NAME = "CUDA (NVIDIA GPU)"
        return ['CUDAExecutionProvider', 'CPUExecutionProvider']
    else:
        DEVICE_NAME = "CPU"
        return ['CPUExecutionProvider']


def load_session():
    global SESSION
    if SESSION is None:
        if not ONNX_PATH.exists():
            raise FileNotFoundError(f"Файл не найден: {ONNX_PATH}")
        providers = get_providers()
        print(f"Загрузка на {DEVICE_NAME}...")
        SESSION = ort.InferenceSession(str(ONNX_PATH), providers=providers)
        print(" Готово!\n")
    return SESSION


def refine_mask(mask_pil, edge_blur=1, threshold_low=10, threshold_high=245):
    mask_np = np.array(mask_pil).astype(np.float32)
    mask_np[mask_np < threshold_low] = 0
    mask_np[mask_np > threshold_high] = 255
    mask_pil = Image.fromarray(mask_np.astype(np.uint8), mode='L')
    mask_pil = mask_pil.filter(ImageFilter.MinFilter(3))
    if edge_blur > 0:
        mask_pil = mask_pil.filter(ImageFilter.GaussianBlur(edge_blur))
    return mask_pil


def remove_background(image, edge_blur=1):
    session = load_session()
    orig_size = image.size
    if image.mode != 'RGB':
        image = image.convert('RGB')
    img = image.resize((1024, 1024), Image.LANCZOS)
    arr = np.array(img).astype(np.float32) / 255.0
    arr = (arr - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    arr = arr.transpose(2, 0, 1)
    tensor = np.expand_dims(arr, 0).astype(np.float32)
    input_name = session.get_inputs()[0].name
    output = session.run(None, {input_name: tensor})
    mask = output[0]
    while mask.ndim > 2:
        mask = mask.squeeze(0)
    if mask.ndim == 3:
        mask = mask[0]
    mask = 1 / (1 + np.exp(-mask))
    mask = ((mask - mask.min()) / (mask.max() - mask.min() + 1e-8) * 255).astype(np.uint8)
    mask_pil = Image.fromarray(mask, mode='L')
    mask_pil = mask_pil.resize(orig_size, Image.LANCZOS)
    mask_pil = refine_mask(mask_pil, edge_blur)
    result = image.convert('RGBA')
    result.putalpha(mask_pil)
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
