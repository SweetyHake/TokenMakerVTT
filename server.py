#!/usr/bin/env python3
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import warnings
import argparse
import threading
import numpy as np
from pathlib import Path
from flask import Flask, request, render_template, jsonify, send_file, current_app
from PIL import Image, ImageFilter, ImageDraw
import onnxruntime as ort
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


@app.before_request
def _guard_localhost_only():
    """Защита от CSRF/DNS-rebinding: API доступен только с localhost.
    Внешние страницы (Origin != localhost) и чужие Host отклоняются."""
    try:
        host = (request.host or '').lower()
        host_name = host.split(':')[0] if ':' in host else host
        if host_name not in ('127.0.0.1', 'localhost', '[::1]'):
            return jsonify({'error': 'Forbidden'}), 403
        origin = request.headers.get('Origin', '')
        if origin:
            from urllib.parse import urlparse
            oh = urlparse(origin).netloc.lower()
            oh_name = oh.split(':')[0] if ':' in oh else oh
            if oh_name not in ('127.0.0.1', 'localhost', '[::1]', ''):
                return jsonify({'error': 'Forbidden'}), 403
    except Exception:
        pass
    return None

if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(os.environ.get('TOKENMAKER_DIR', Path(__file__).parent))
MODELS_DIR = BASE_DIR / "models"
RING_DIR = BASE_DIR / "token_rings"
MASK_PATH = BASE_DIR / "mask.png"
PRESET_DIR = BASE_DIR


def _migrate_legacy_model():
    """Если model.onnx лежит в папке приложения — перемещаем в models/ (разово)."""
    legacy = BASE_DIR / "model.onnx"
    if not legacy.exists():
        return
    try:
        MODELS_DIR.mkdir(exist_ok=True)
        dest = MODELS_DIR / "model.onnx"
        if not dest.exists():
            os.replace(str(legacy), str(dest))
            print(f" Модель перемещена: model.onnx -> {MODELS_DIR.name}/")
        else:
            legacy.unlink(missing_ok=True)
    except Exception as e:
        print(f" Не удалось переместить модель: {e}")


def get_selected_model_path():
    """Путь к выбранной модели: config selected_model -> первая .onnx в models/."""
    try:
        cfg_path = BASE_DIR / 'config.json'
        if cfg_path.exists():
            cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
            sel = cfg.get('selected_model')
            if sel:
                p = MODELS_DIR / Path(str(sel)).name
                if p.exists():
                    return p
    except Exception:
        pass
    try:
        onnx_files = sorted(MODELS_DIR.glob('*.onnx'))
        if onnx_files:
            return onnx_files[0]
    except Exception:
        pass
    return MODELS_DIR / "model.onnx"


_migrate_legacy_model()
ONNX_PATH = get_selected_model_path()

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'}
MAX_IMAGE_DIMENSION = 8192
# Рабочее разрешение для фоновой обработки: маска, композитинг и кодирование
# держат по несколько полноразмерных буферов — на 8K пик памяти ~6 ГБ.
# Токены и вырезатель работают с 4096 без потери качества.
MAX_PROCESS_DIM = 4096

SESSION = None
SESSION_LOCK = threading.Lock()
CONFIG_LOCK = threading.Lock()
DEVICE_NAME = "Определение..."
_PROVIDERS = None
_PROVIDER_OPTIONS = None


def _load_config():
    try:
        cfg_path = BASE_DIR / 'config.json'
        return json.loads(cfg_path.read_text(encoding='utf-8')) if cfg_path.exists() else {}
    except Exception:
        return {}


def _save_config(cfg):
    with CONFIG_LOCK:
        (BASE_DIR / 'config.json').write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def validate_image(image):
    if image.width > MAX_IMAGE_DIMENSION or image.height > MAX_IMAGE_DIMENSION:
        ratio = min(MAX_IMAGE_DIMENSION / image.width, MAX_IMAGE_DIMENSION / image.height)
        new_size = (int(image.width * ratio), int(image.height * ratio))
        image = image.resize(new_size, Image.LANCZOS)
    return image


def cap_process_size(image):
    """Уменьшает рабочее изображение до MAX_PROCESS_DIM (BILINEAR — быстро).
    Возвращает новое изображение; исходное освобождается по refcount."""
    import gc
    w, h = image.size
    if max(w, h) > MAX_PROCESS_DIM:
        ratio = MAX_PROCESS_DIM / max(w, h)
        image = image.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.BILINEAR)
        gc.collect()
    return image


def _enumerate_dxgi_adapters():
    """Перечисляет DXGI-адаптеры через ctypes (без лишних зависимостей).
    Возвращает [(device_id, description), ...]; device_id = индекс DXGI-адаптера,
    он же device_id для DmlExecutionProvider."""
    adapters = []
    try:
        import ctypes
        from ctypes import wintypes, POINTER, byref, cast, Structure, c_void_p, c_uint, c_ulong, c_long, c_wchar, c_size_t, c_int64, WINFUNCTYPE

        class GUID(Structure):
            _fields_ = [
                ("Data1", c_uint),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        class DXGI_ADAPTER_DESC(Structure):
            _fields_ = [
                ("Description", c_wchar * 128),
                ("VendorId", c_uint),
                ("DeviceId", c_uint),
                ("SubSysId", c_uint),
                ("Revision", c_uint),
                ("DedicatedVideoMemory", c_size_t),
                ("DedicatedSystemMemory", c_size_t),
                ("SharedSystemMemory", c_size_t),
                ("AdapterLuid", c_int64),
            ]

        DXGI_ERROR_NOT_FOUND = 0x887A0027
        # IID_IDXGIFactory: 7B7166EC-21C7-44AE-B21A-C9AE321AE369
        # (CreateDXGIFactory1 на некоторых системах возвращает E_NOINTERFACE,
        # поэтому используем IDXGIFactory — EnumAdapters у него тот же слот vtable)
        IID_IDXGIFactory = GUID(0x7B7166EC, 0x21C7, 0x44AE,
                                (ctypes.c_ubyte * 8)(0xB2, 0x1A, 0xC9, 0xAE, 0x32, 0x1A, 0xE3, 0x69))

        dxgi = ctypes.WinDLL('dxgi.dll')
        CreateDXGIFactory = dxgi.CreateDXGIFactory
        CreateDXGIFactory.argtypes = [POINTER(GUID), POINTER(c_void_p)]
        CreateDXGIFactory.restype = c_long

        factory = c_void_p()
        if CreateDXGIFactory(byref(IID_IDXGIFactory), byref(factory)) != 0 or not factory:
            return []

        EnumAdaptersFn = WINFUNCTYPE(c_long, c_void_p, c_uint, POINTER(c_void_p))
        GetDescFn = WINFUNCTYPE(c_long, c_void_p, POINTER(DXGI_ADAPTER_DESC))
        ReleaseFn = WINFUNCTYPE(c_ulong, c_void_p)

        fvt = cast(factory, POINTER(POINTER(c_void_p))).contents
        EnumAdapters = EnumAdaptersFn(fvt[3])  # IDXGIFactory::EnumAdapters

        i = 0
        while i < 32:
            adapter = c_void_p()
            hr = EnumAdapters(factory, i, byref(adapter))
            if hr == DXGI_ERROR_NOT_FOUND:
                break
            if hr != 0 or not adapter:
                i += 1
                continue
            avt = cast(adapter, POINTER(POINTER(c_void_p))).contents
            desc = DXGI_ADAPTER_DESC()
            if GetDescFn(avt[4])(adapter, byref(desc)) == 0:  # IDXGIAdapter::GetDesc
                name = (desc.Description or '').strip()
                if name:
                    adapters.append((i, name))
            ReleaseFn(avt[2])(adapter)
            i += 1

        ReleaseFn(fvt[2])(factory)
    except Exception:
        return []
    return adapters


def _classify_adapter(name):
    """Классифицирует адаптер: 'discrete' | 'integrated' | 'virtual' | None."""
    low = name.lower()
    if any(k in low for k in ('microsoft', 'basic', 'remote', 'warp', 'parsec',
                              'virtual', 'rdp', 'indirect', 'software', 'teamviewer', 'anydesk')):
        return 'virtual'
    if any(k in low for k in ('nvidia', 'geforce', 'rtx', 'gtx', 'quadro', 'tesla')):
        return 'discrete'
    if 'arc' in low:
        return 'discrete'
    if 'intel' in low:
        return 'integrated'
    if 'radeon' in low or 'amd' in low:
        # Встроенные AMD заканчиваются на "Graphics" или содержат Vega/Ryzen/APU
        if low.endswith('graphics') or 'vega' in low or 'ryzen' in low or 'apu' in low:
            return 'integrated'
        return 'discrete'
    if 'graphics' in low or 'adreno' in low or 'mali' in low:
        return 'integrated'
    return None


def _pick_discrete_adapter(adapter_list):
    """Из списка [(idx, name)] выбирает дискретный GPU (минимальный индекс)."""
    best = None
    for idx, name in adapter_list:
        if _classify_adapter(name) == 'discrete':
            if best is None or idx < best[0]:
                best = (idx, name)
    return best if best else (None, None)


def _detect_discrete_dml_adapter():
    """Ищет дискретную видеокарту для DirectML (гибридные ноутбуки).
    Возвращает (device_id, description) или (None, None) при неоднозначности."""
    try:
        return _pick_discrete_adapter(_enumerate_dxgi_adapters())
    except Exception:
        return (None, None)


def get_providers():
    global DEVICE_NAME, _PROVIDER_OPTIONS
    try:
        available = ort.get_available_providers()
    except AttributeError:
        print(" WARNING: onnxruntime повреждён или установлен не полностью.")
        print(" Выполните: pip install --force-reinstall onnxruntime-directml")
        DEVICE_NAME = 'CPU (onnxruntime повреждён)'
        return ['CPUExecutionProvider']

    VIRTUAL_ADAPTER_KEYWORDS = [
        'parsec', 'virtual', 'microsoft', 'basic', 'remote',
        'indirect', 'display only', 'rdp', 'teamviewer', 'anydesk',
        'warp', 'software renderer'
    ]

    def is_real_gpu(name):
        name_lower = name.lower()
        return not any(kw in name_lower for kw in VIRTUAL_ADAPTER_KEYWORDS)

    def run_cmd(cmd):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            return result.stdout or ''
        except Exception:
            return ''

    def get_real_gpus():
        """Список физических видеокарт (виртуальные адаптеры отсеиваются)."""
        if sys.platform == 'win32':
            out = run_cmd(['powershell', '-Command',
                           'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'])
            names = [l.strip() for l in out.splitlines() if l.strip()]
        else:
            out = run_cmd(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'])
            names = [l.strip() for l in out.splitlines() if l.strip()]
            if not names:
                out = run_cmd(['rocm-smi', '--showproductname'])
                names = [l.strip() for l in out.splitlines() if l.strip()]
        return [n for n in names if is_real_gpu(n)]

    def get_cpu_name():
        cpu = ''
        try:
            import platform
            cpu = platform.processor()
        except Exception:
            cpu = ''
        if not cpu:
            if sys.platform == 'win32':
                cpu = run_cmd(['powershell', '-Command',
                               '(Get-CimInstance Win32_Processor | Select-Object -First 1).Name']).strip()
            else:
                cpu = run_cmd(['grep', '-m1', 'model name', '/proc/cpuinfo'])
                cpu = cpu.split(':')[-1].strip() if ':' in cpu else ''
        return cpu

    real_gpus = get_real_gpus()
    gpu_name = real_gpus[0] if real_gpus else None
    nvidia_gpu = next((g for g in real_gpus if 'nvidia' in g.lower()), None)
    has_nvidia = nvidia_gpu is not None

    def device_options():
        """device_id для выбора дискретной карты на ноутбуках (гибридная графика).
        Задаётся в config.json ключом gpu_device_id (0, 1, ...)."""
        try:
            cfg_path = BASE_DIR / 'config.json'
            if cfg_path.exists():
                import json
                cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
                dev = cfg.get('gpu_device_id')
                if isinstance(dev, int) and dev >= 0:
                    return [{'device_id': dev}] + [{}] * (len(available) - 1)
        except Exception:
            pass
        return None

    if has_nvidia and 'CUDAExecutionProvider' in available:
        DEVICE_NAME = f'CUDA ({nvidia_gpu})'
        _PROVIDER_OPTIONS = device_options()
        return ['CUDAExecutionProvider', 'CPUExecutionProvider']

    if 'ROCMExecutionProvider' in available and gpu_name:
        DEVICE_NAME = f'ROCm ({gpu_name})'
        return ['ROCMExecutionProvider', 'CPUExecutionProvider']

    if 'DmlExecutionProvider' in available and gpu_name:
        _PROVIDER_OPTIONS = device_options()
        name_to_show = gpu_name
        if not _PROVIDER_OPTIONS:
            # На гибридных ноутбуках адаптер 0 может быть встроенной картой —
            # ищем дискретную через DXGI и указываем её device_id напрямую.
            dml_id, dml_name = _detect_discrete_dml_adapter()
            if dml_id is not None:
                _PROVIDER_OPTIONS = [{'device_id': dml_id}] + [{}] * (len(available) - 1)
                name_to_show = dml_name
                print(f"  Дискретная видеокарта: {dml_name} (адаптер #{dml_id})")
        DEVICE_NAME = f'DirectML ({name_to_show})'
        return ['DmlExecutionProvider', 'CPUExecutionProvider']

    # Нет физической видеокарты: DirectML уйдёт на WARP (софт) — это медленнее CPU
    cpu_name = get_cpu_name()
    DEVICE_NAME = cpu_name if cpu_name else 'CPU'
    return ['CPUExecutionProvider']


# Detect device at import time (without loading the model).
# Выполняется сразу после определения get_providers — ДО любого вызова load_session()
# (включая блок __main__ ниже), иначе сессия создаётся с providers=None → CPU.
try:
    _PROVIDERS = get_providers()
except Exception:
    _PROVIDERS = ['CPUExecutionProvider']


def load_session():
    global SESSION, _PROVIDERS, _PROVIDER_OPTIONS, DEVICE_NAME
    if SESSION is None:
        # Создание сессии и прогрев — под блокировкой: параллельные DML-сессии
        # ломают инференс (ExecuteKernel 80070057)
        with SESSION_LOCK:
            if SESSION is not None:
                return SESSION
            model_path = get_selected_model_path()
            if not model_path.exists():
                raise FileNotFoundError(f"Модель не найдена: {model_path}")
            if not hasattr(ort, 'InferenceSession'):
                raise RuntimeError(
                    "onnxruntime повреждён или установлен не полностью. "
                    "Выполните: pip install --force-reinstall onnxruntime-directml"
                )
            providers = _PROVIDERS
            print(f"Модель: {model_path.name} | Загрузка на {DEVICE_NAME}...")

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
                    str(model_path),
                    sess_options=opts,
                    providers=providers,
                    provider_options=_PROVIDER_OPTIONS
                )
            except Exception as e:
                # Авто-выбранный device_id мог не подойти (DML) — пробуем дефолтный адаптер,
                # и только потом откатываемся на CPU.
                if _PROVIDER_OPTIONS and providers != ['CPUExecutionProvider']:
                    try:
                        print(f"  Адаптер #{_PROVIDER_OPTIONS[0].get('device_id')} не запустился ({e})")
                        print("  Пробуем дефолтный адаптер...")
                        SESSION = ort.InferenceSession(
                            str(model_path),
                            sess_options=opts,
                            providers=providers,
                            provider_options=None
                        )
                        _PROVIDER_OPTIONS = None
                        print("  Дефолтный адаптер работает.")
                    except Exception:
                        SESSION = None

                if SESSION is None:
                    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
                    print(f"  Оптимизация EXTENDED не загрузилась ({e})")
                    print("  Откат на BASIC...")
                    try:
                        SESSION = ort.InferenceSession(
                            str(model_path),
                            sess_options=opts,
                            providers=providers,
                            provider_options=_PROVIDER_OPTIONS
                        )
                    except Exception:
                        if providers != ['CPUExecutionProvider']:
                            print(f"  GPU-провайдер не запустился ({e})")
                            print("  Откат на CPU...")
                            DEVICE_NAME = 'CPU (fallback)'
                        SESSION = ort.InferenceSession(
                            str(model_path),
                            sess_options=opts,
                            providers=['CPUExecutionProvider']
                        )

            print(f" Прогрев модели...")
            warmup_time = None
            try:
                dummy = np.zeros((1, 3, 1024, 1024), dtype=np.float32)
                input_name = SESSION.get_inputs()[0].name
                t0 = time.time()
                SESSION.run(None, {input_name: dummy})
                warmup_time = time.time() - t0
                del dummy
                import gc
                gc.collect()
                print(f" Прогрев завершён ({warmup_time:.2f} с).")
            except Exception as e:
                print(f" Прогрев не удался: {e}")

            print(f" Готово!\n")
            _spawn_tune_child()
    return SESSION


def _spawn_tune_child():
    """Запускает подбор адаптера DirectML в ОТДЕЛЬНОМ процессе (--tune-gpu).
    Параллельные DML-сессии в одном процессе ломают основной инференс
    (баг onnxruntime-directml: ExecuteKernel 80070057), поэтому изолируем пробу.
    Запуск отложен на 5 с и с пониженным приоритетом, чтобы не конкурировать
    с приложением за GPU/CPU на слабых ноутбуках."""
    try:
        if 'DmlExecutionProvider' not in _PROVIDERS or _PROVIDER_OPTIONS:
            return
        cfg_path = BASE_DIR / 'config.json'
        cfg = json.loads(cfg_path.read_text(encoding='utf-8')) if cfg_path.exists() else {}
        if isinstance(cfg.get('gpu_device_id'), int):
            return

        def _spawn():
            if getattr(sys, 'frozen', False):
                args = [sys.executable, '--tune-gpu']
            else:
                args = [sys.executable, str(BASE_DIR / 'server.py'), '--tune-gpu']
            # 0x08000000 = CREATE_NO_WINDOW, 0x00004000 = BELOW_NORMAL_PRIORITY_CLASS
            subprocess.Popen(args, creationflags=0x08000000 | 0x00004000, close_fds=True)
            print(" Запущен фоновый подбор адаптера DirectML (отдельный процесс)...")

        t = threading.Timer(5.0, _spawn)
        t.daemon = True
        t.start()
    except Exception as e:
        print(f" Не удалось запустить подбор адаптера: {e}")


def cli_tune_gpu():
    """CLI-подбор самого быстрого адаптера DirectML (гибридные ноутбуки).
    Вызывается в отдельном процессе с флагом --tune-gpu.
    Результат пишется в config.json (gpu_device_id) и применится после перезапуска."""
    import time as _t
    try:
        if 'DmlExecutionProvider' not in ort.get_available_providers():
            return

        def bench(device_id):
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
            opts.intra_op_num_threads = 2
            model_path = str(get_selected_model_path())
            if device_id is None:
                sess = ort.InferenceSession(
                    model_path, sess_options=opts,
                    providers=['DmlExecutionProvider', 'CPUExecutionProvider']
                )
            else:
                sess = ort.InferenceSession(
                    model_path, sess_options=opts,
                    providers=['DmlExecutionProvider', 'CPUExecutionProvider'],
                    provider_options=[{'device_id': device_id}, {}]
                )
            input_name = sess.get_inputs()[0].name
            x = np.zeros((1, 3, 1024, 1024), dtype=np.float32)
            t0 = _t.time()
            sess.run(None, {input_name: x})
            dt = _t.time() - t0
            del sess, x
            return dt

        default_t = bench(None)
        print(f"  [tune] дефолтный адаптер: {default_t:.2f} с")
        best_id, best_time = None, None
        # Тестируем столько адаптеров, сколько реально есть (но не больше 4),
        # чтобы дискретная карта на гибридных ноутбуках не оказалась за пределами списка.
        try:
            adapter_count = len(_enumerate_dxgi_adapters())
        except Exception:
            adapter_count = 2
        limit = max(2, min(adapter_count, 4))
        for did in range(limit):
            try:
                dt = bench(did)
                print(f"  [tune] адаптер #{did}: {dt:.2f} с")
                if best_time is None or dt < best_time:
                    best_id, best_time = did, dt
            except Exception as e:
                print(f"  [tune] адаптер #{did}: не доступен ({e})")
                break
        if best_id is None or best_time is None:
            return
        if best_time >= default_t * 0.85:
            print(f"  [tune] текущий адаптер оптимален ({default_t:.2f} с) — оставляем")
            return
        cfg = _load_config()
        cfg['gpu_device_id'] = best_id
        _save_config(cfg)
        print(f"  [tune] выбран адаптер #{best_id} ({best_time:.2f} с), сохранено в config.json")
    except Exception as e:
        print(f"  [tune] ошибка: {e}")


def refine_mask(mask_pil, edge_blur=1, threshold_low=10, threshold_high=245, work_size=1024, target_size=None):
    """Маска рефайнится на уменьшенной копии (work_size), чтобы не жечь RAM на больших картинках.
    Результат возвращается в размере target_size (или в исходном размере маски)."""
    orig_size = target_size or mask_pil.size
    w, h = orig_size
    if work_size and max(w, h) > work_size:
        ratio = work_size / max(w, h)
        work = mask_pil.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.BILINEAR)
    else:
        work = mask_pil

    mask_np = np.array(work).astype(np.float32) / 255.0

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

    if mask_pil.size != orig_size:
        mask_pil = mask_pil.resize(orig_size, Image.LANCZOS)

    return mask_pil


def remove_background(image, edge_blur=1):
    import psutil, os as _os, gc
    proc = psutil.Process(_os.getpid())

    def mem():
        return proc.memory_info().rss / 1024 / 1024

    session = load_session()
    image = cap_process_size(image)
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
    t_infer = time.time()
    output = session.run(None, {input_name: tensor})
    print(f"  Инференс: {time.time() - t_infer:.2f} с")
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

    if mask.min() >= 0.0 and mask.max() <= 1.0:
        mask = np.clip(mask, 0.0, 1.0)
    else:
        mask = 1.0 / (1.0 + np.exp(-mask))
    mn, mx = mask.min(), mask.max()
    mask = ((mask - mn) / (mx - mn + 1e-8) * 255).astype(np.uint8)

    mask_pil = Image.fromarray(mask, mode='L')
    del mask
    gc.collect()

    mask_pil = refine_mask(mask_pil, edge_blur, target_size=image.size)

    # White-penalty считается на уменьшенной копии (1024), поправка затем масштабируется.
    small = image.resize((1024, 1024), Image.BILINEAR)
    small_arr = np.array(small, dtype=np.float32)
    del small
    wp = (small_arr[:, :, 0] * 0.299 + small_arr[:, :, 1] * 0.587 + small_arr[:, :, 2] * 0.114)
    alpha_small = np.array(mask_pil.resize((1024, 1024), Image.BILINEAR)).astype(np.float32)
    suppress = (wp > 220) & (alpha_small < 180)
    corr = np.zeros_like(wp)
    corr[suppress] = np.minimum((wp[suppress] - 220) * 3.5, 255.0)
    corr_img = Image.fromarray(corr.astype(np.uint8)).resize(image.size, Image.BILINEAR)
    del small_arr, wp, alpha_small, corr
    corr_u8 = np.array(corr_img)
    del corr_img
    gc.collect()

    # Композитинг: одна RGBA-копия исходника + uint8-маска; арифметика — in-place.
    result = image.convert('RGBA')
    rgba_np = np.array(result)
    del result
    alpha_np = np.array(mask_pil)
    del mask_pil
    del image
    gc.collect()

    alpha16 = alpha_np.astype(np.int16)
    del alpha_np
    alpha16 -= corr_u8
    del corr_u8
    np.clip(alpha16, 0, 255, out=alpha16)
    rgba_np[:, :, 3] = alpha16.astype(np.uint8)
    del alpha16
    gc.collect()

    result = Image.fromarray(rgba_np, mode='RGBA')
    del rgba_np
    gc.collect()

    print(f"  [RAM] финал: {mem():.0f} МБ")
    return result


def save_image(image, format_type, quality=90):
    buffer = io.BytesIO()
    if format_type == 'webp':
        image.save(buffer, format='WEBP', quality=quality, lossless=False)
        mime = 'image/webp'
    elif format_type == 'avif':
        image.save(buffer, format='AVIF', quality=quality)
        mime = 'image/avif'
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

def find_character_bounds(pil_image, threshold=15, work_max=1024):
    """Находит bbox не-фонового содержимого. Считается на уменьшенной копии (work_max),
    координаты возвращаются в координатах исходника."""
    ow, oh = pil_image.size
    ratio = 1.0
    work = pil_image
    if max(ow, oh) > work_max:
        ratio = work_max / max(ow, oh)
        work = pil_image.resize((max(1, int(ow * ratio)), max(1, int(oh * ratio))), Image.BILINEAR)

    arr = np.array(work.convert('RGBA'))
    alpha = arr[:, :, 3]
    if alpha.max() < 200:
        gray = np.mean(arr[:, :, :3], axis=2)
        mask = gray < (255 - threshold)
    else:
        mask = alpha > threshold
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any():
        return 0, 0, ow, oh
    top    = int(np.argmax(rows) / ratio)
    bottom = int((len(rows) - np.argmax(rows[::-1]) - 1) / ratio)
    left   = int(np.argmax(cols) / ratio)
    right  = int((len(cols) - np.argmax(cols[::-1]) - 1) / ratio)
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


@app.route('/model_status')
def model_status():
    p = get_selected_model_path()
    exists = p.exists()
    return jsonify({
        'exists': exists,
        'size': p.stat().st_size if exists else 0,
        'path': str(p),
        'models_dir': str(MODELS_DIR)
    })


@app.route('/models_list')
def models_list():
    try:
        MODELS_DIR.mkdir(exist_ok=True)
    except Exception:
        pass
    selected = get_selected_model_path()
    models = []
    for f in sorted(MODELS_DIR.glob('*.onnx')):
        if not f.is_file():
            continue
        try:
            size = f.stat().st_size
        except OSError:
            size = 0
        models.append({
            'name': f.name,
            'size': size,
            'selected': f.resolve() == selected.resolve(),
        })
    return jsonify({
        'models': models,
        'models_dir': str(MODELS_DIR),
        'selected': selected.name if selected.exists() else None,
    })


@app.route('/select_model', methods=['POST'])
def select_model():
    global SESSION
    data = request.get_json(force=True, silent=True) or {}
    filename = str(data.get('name', ''))
    p = MODELS_DIR / Path(filename).name
    if p.suffix.lower() != '.onnx' or not p.exists() or not p.is_file():
        return jsonify({'error': 'Модель не найдена'}), 404

    try:
        cfg = _load_config()
        cfg['selected_model'] = p.name
        _save_config(cfg)
    except Exception as e:
        return jsonify({'error': f'Не удалось сохранить настройку: {e}'}), 500

    # Сбрасываем сессию — следующая обработка загрузит новую модель.
    # Под блокировкой, чтобы не создать вторую DML-сессию параллельно с инференсом.
    with SESSION_LOCK:
        SESSION = None
    return jsonify({'ok': True, 'name': p.name})

@app.route('/icon')
def app_icon():
    return send_file(BASE_DIR / 'icon.ico', mimetype='image/x-icon')


@app.route('/logo')
def app_logo():
    logo = BASE_DIR / 'logo.png'
    if logo.exists():
        return send_file(logo, mimetype='image/png')
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
    mime_map = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.avif': 'image/avif'}
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
        kind = s.get('download_kind', 'bare')
        if not src or not os.path.exists(src):
            return jsonify({'error': 'No update file'}), 400

        dst = sys.executable if getattr(sys, 'frozen', False) else str(BASE_DIR / 'TokenMaker.exe')
        exe_name = os.path.basename(dst)
        dst_dir = os.path.dirname(dst)

        # bat пишем в LOCALAPPDATA: в Program Files запись запрещена
        upd_dir = Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir())) / 'TokenMaker' / 'update'
        upd_dir.mkdir(parents=True, exist_ok=True)
        bat = upd_dir / '_update.bat'

        if kind == 'installer':
            # Установщик: дождаться выхода приложения (и снятия блокировки файлов),
            # тихая установка (/SILENT), перезапуск. UAC-запрос покажет сам установщик.
            lines = [
                '@echo off',
                'setlocal',
                f'set "SRC={src}"',
                f'set "DST={dst}"',
                f'set "DSTDIR={dst_dir}"',
                f'set "EXE={exe_name}"',
                'set /a tries=0',
                ':waitloop',
                'tasklist /FI "IMAGENAME eq %EXE%" 2>nul | find /I "%EXE%" >nul',
                'if errorlevel 1 goto settle',
                'set /a tries+=1',
                'if %tries% geq 30 (',
                '    taskkill /F /IM "%EXE%" >nul 2>&1',
                '    goto settle',
                ')',
                'ping 127.0.0.1 -n 2 > nul',
                'goto waitloop',
                ':settle',
                'ping 127.0.0.1 -n 3 > nul',
                ':run',
                'start "" /wait "%SRC%" /SILENT /SP- /SUPPRESSMSGBOXES /NORESTART',
                'if exist "%SRC%" del "%SRC%" >nul 2>&1',
                'if exist "%DST%" start "" /D "%DSTDIR%" "%DST%" >nul 2>&1',
                'del "%~f0" >nul 2>&1',
                'exit /b 0',
            ]
        else:
            # Голый exe приложения: копируем поверх (работает только если _internal на месте)
            lines = [
                '@echo off',
                'setlocal',
                f'set "SRC={src}"',
                f'set "DST={dst}"',
                f'set "DSTDIR={dst_dir}"',
                f'set "EXE={exe_name}"',
                'set /a tries=0',
                ':waitloop',
                'tasklist /FI "IMAGENAME eq %EXE%" 2>nul | find /I "%EXE%" >nul',
                'if errorlevel 1 goto copy',
                'set /a tries+=1',
                'if %tries% geq 30 (',
                '    taskkill /F /IM "%EXE%" >nul 2>&1',
                '    goto copy',
                ')',
                'ping 127.0.0.1 -n 2 > nul',
                'goto waitloop',
                ':copy',
                'set /a ctries=0',
                ':copyloop',
                'copy /Y "%SRC%" "%DST%.new" >nul 2>&1',
                'if exist "%DST%.new" goto moveit',
                'set /a ctries+=1',
                'if %ctries% geq 10 goto fail',
                'ping 127.0.0.1 -n 2 > nul',
                'goto copyloop',
                ':moveit',
                'set /a mtries=0',
                ':moveloop',
                'move /Y "%DST%.new" "%DST%" >nul 2>&1',
                'if exist "%DST%" goto done',
                'set /a mtries+=1',
                'if %mtries% geq 10 goto fail',
                'ping 127.0.0.1 -n 2 > nul',
                'goto moveloop',
                ':done',
                'if exist "%SRC%" del "%SRC%" >nul 2>&1',
                'start "" /D "%DSTDIR%" "%DST%" >nul 2>&1',
                'del "%~f0" >nul 2>&1',
                'exit /b 0',
                ':fail',
                'if exist "%DST%.new" del "%DST%.new" >nul 2>&1',
                'if exist "%SRC%" del "%SRC%" >nul 2>&1',
                'del "%~f0" >nul 2>&1',
                'exit /b 1',
            ]

        bat.write_text('\r\n'.join(lines) + '\r\n', encoding='cp866', errors='replace')
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
        with Image.open(MASK_PATH) as img:
            if img.mode != 'RGBA':
                img = img.convert('RGBA')
            buffer = io.BytesIO()
            img.save(buffer, format='PNG')
            buffer.seek(0)
            response = send_file(buffer, mimetype='image/png')
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
    if format_type not in ('webp', 'png', 'jpg', 'avif'):
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
        # Даунскейл до MAX_PROCESS_DIM сразу после декода — освобождает оригинал
        # до модели/композитинга (иначе 8K держит ~200-270 МБ лишних).
        image = cap_process_size(image)
        result = remove_background(image, edge_blur)
        del image
        gc.collect()

        buffer, mime = save_image(result, format_type, quality)
        del result
        gc.collect()

        return send_file(buffer, mimetype=mime, as_attachment=False,
                        download_name=f'result.{format_type}')
    except FileNotFoundError:
        return jsonify({'error': 'Файл модели model.onnx не найден. Положите его рядом с приложением'}), 500
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
    if format_type not in ('webp', 'png', 'jpg', 'avif', 'bmp', 'gif', 'tiff'):
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
        with Image.open(file.stream) as _im:
            image = _im.convert('RGBA')
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
    if format_type not in ('webp', 'png', 'jpg', 'avif'):
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
        image = validate_image(image)
        image = cap_process_size(image)
        image = image.convert('RGBA')
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
    except FileNotFoundError:
        return jsonify({'error': 'Файл модели model.onnx не найден. Положите его рядом с приложением'}), 500
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
    with Image.open(input_path) as image:
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
    with Image.open(input_path) as image:
        out_path = input_path.with_suffix('.webp')
        buf, _ = save_image(image, 'webp', 90)
        out_path.write_bytes(buf.read())
    print(f"Сохранено: {out_path}")

@app.route('/save_file', methods=['POST'])
def save_file():
    import tkinter as tk
    from tkinter import filedialog

    suggested = request.form.get('filename', 'file.webp')
    ext = suggested.rsplit('.', 1)[-1].lower() if '.' in suggested else 'webp'
    mime_map = {'webp': 'WebP Image', 'png': 'PNG Image', 'jpg': 'JPEG Image', 'avif': 'AVIF Image'}
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
    mime_map = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.avif': 'image/avif'}
    mime = mime_map.get(ext, 'image/octet-stream')

    return jsonify({
        'path': str(path_obj.resolve()),
        'mime': mime
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
    mime_map = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.avif': 'image/avif'}
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
    config_path = BASE_DIR / 'config.json'
    try:
        data = request.get_json(force=True, silent=True) or {}
        # Серверные ключи (выбор модели, GPU) не должны затираться клиентским снапшотом
        existing = _load_config()
        for key in ('selected_model', 'gpu_device_id'):
            if key not in data and key in existing:
                data[key] = existing[key]
        _save_config(data)
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


if __name__ == '__main__' and not getattr(sys, 'frozen', False):
    # Блок обязан быть в КОНЦЕ файла: иначе маршруты ниже не зарегистрируются
    # при запуске `python server.py` (app.run() блокирует выполнение модуля).
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--remove-bg', metavar='FILE')
    parser.add_argument('--to-webp', metavar='FILE')
    parser.add_argument('--tune-gpu', action='store_true')
    args, _ = parser.parse_known_args()

    if args.remove_bg:
        cli_remove_bg(args.remove_bg)
    elif args.to_webp:
        cli_to_webp(args.to_webp)
    elif args.tune_gpu:
        cli_tune_gpu()
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

