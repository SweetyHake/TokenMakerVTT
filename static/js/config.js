const CONFIG = {
    SCALE_SIZES: { 1: 2048, 2: 4096, 3: 6144 },
    BASE_SIZE: 2048,
    EFFECTS_DELAY: 750,
    MAX_HISTORY: 75,
    DEFAULT_SCALE: 100,
    MIN_SCALE: 10,
    MAX_SCALE: 300,
    MIN_ZOOM: 0.5,
    MAX_ZOOM: 20,
    MOVE_STEP: 2,
    ROTATE_STEP: 1,
    PAN_AMOUNT: 30,
    DEBOUNCE_DELAY: 300,
    MIN_ERASER_SIZE: 1,
    MAX_ERASER_SIZE: 300,
    ERASER_SIZE_STEP: 5
};

const DEFAULT_HOTKEYS = {
    toolMove:        'KeyV',
    toolEraser:      'KeyF',
    toolMask:        'KeyG',
    toolRemoveBg:    'KeyR',
    undo:            'KeyZ',
    redo:            'KeyY',
    rotateLeft:      'KeyQ',
    rotateRight:     'KeyE',
    openFile:        'KeyO',
    saveAll:         'KeyS'
};

const HOTKEYS_META = {
    toolMove:     { label: 'Инструмент перемещения',        ctrl: false },
    toolEraser:   { label: 'Ластик (синий)',                 ctrl: false },
    toolMask:     { label: 'Маска (розовая)',                ctrl: false },
    toolRemoveBg: { label: 'Удалить / восстановить фон',     ctrl: false },
    undo:         { label: 'Отменить действие',              ctrl: true  },
    redo:         { label: 'Повторить действие',             ctrl: true  },
    rotateLeft:   { label: 'Повернуть влево',                ctrl: false },
    rotateRight:  { label: 'Повернуть вправо',               ctrl: false },
    openFile:     { label: 'Открыть файл',                   ctrl: true  },
    saveAll:      { label: 'Скачать все (вырезатель)',        ctrl: true  }
};

const AppConfig = {
    STORAGE_KEY: 'tokenmaker_config',
    _data: null,

    _defaults() {
        return {
            hotkeys: { ...DEFAULT_HOTKEYS },
            dropShadow: { angle: -45, distance: 10, blur: 10, opacity: 0.75 },
            colorCorrection: { saturation: 5, lightness: -5 }
        };
    },

    load() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                const def = this._defaults();
                this._data = {
                    hotkeys: { ...def.hotkeys, ...(parsed.hotkeys || {}) },
                    dropShadow: { ...def.dropShadow, ...(parsed.dropShadow || {}) },
                    colorCorrection: { ...def.colorCorrection, ...(parsed.colorCorrection || {}) }
                };
            } else {
                this._data = this._defaults();
            }
        } catch {
            this._data = this._defaults();
        }
        return this;
    },

    save() {
        try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._data)); } catch {}
    },

    get hotkeys() { return this._data.hotkeys; },
    get dropShadow() { return this._data.dropShadow; },
    get colorCorrection() { return this._data.colorCorrection; },

    setHotkey(action, code) { this._data.hotkeys[action] = code; this.save(); },
    setDropShadow(key, val) { this._data.dropShadow[key] = val; this.save(); },
    setColorCorrection(key, val) { this._data.colorCorrection[key] = val; this.save(); },
    resetHotkeys() { this._data.hotkeys = { ...DEFAULT_HOTKEYS }; this.save(); },
    resetDropShadow() { this._data.dropShadow = this._defaults().dropShadow; this.save(); },
    resetColorCorrection() { this._data.colorCorrection = this._defaults().colorCorrection; this.save(); }
};

AppConfig.load();

const MOVE_KEYS = ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
const ROTATE_KEYS = ['KeyQ','KeyE'];
const ERASER_SIZE_KEYS = ['BracketLeft','BracketRight'];

function codeToLabel(code) {
    if (!code) return '—';
    return code
        .replace('ArrowUp','↑').replace('ArrowDown','↓')
        .replace('ArrowLeft','←').replace('ArrowRight','→')
        .replace('Key','')
        .replace('Digit','')
        .replace('Space','Пробел').replace('Escape','Esc')
        .replace('BracketLeft','[').replace('BracketRight',']')
        .replace('Backslash','\\').replace('Slash','/')
        .replace('Semicolon',';').replace('Quote',"'")
        .replace('Comma',',').replace('Period','.')
        .replace('Minus','-').replace('Equal','=');
}
