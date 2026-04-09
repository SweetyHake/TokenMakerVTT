function initTabs() {
    document.querySelectorAll('.title-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.title-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const panel = $(tab.dataset.mode + 'Panel');
            if (panel) panel.classList.add('active');
        };
    });
}

function initSectionCollapse() {
    document.querySelectorAll('.section-header[data-toggle]').forEach(header => {
        header.onclick = () => {
            const body = header.nextElementSibling;
            const chevron = header.querySelector('.chevron');
            if (!body) return;
            const isCollapsed = body.classList.contains('collapsed');
            body.classList.toggle('collapsed', !isCollapsed);
            if (chevron) chevron.classList.toggle('collapsed', !isCollapsed);
        };
    });
}

function initGlobalShortcuts() {
    document.addEventListener('keydown', e => {
        const code = e.code;
        const hk = AppConfig.hotkeys;

        if (e.ctrlKey && code === hk.openFile) {
            e.preventDefault();
            const tokenPanel = $('tokenPanel');
            if (tokenPanel?.classList.contains('active')) {
                $('tokenFileInput')?.click();
            } else {
                $('fileInput')?.click();
            }
            return;
        }

        if (e.ctrlKey && code === hk.saveAll) {
            e.preventDefault();
            const removerPanel = $('removerPanel');
            if (removerPanel?.classList.contains('active')) Remover.downloadAll();
            return;
        }

        const tokenPanel = $('tokenPanel');
        if (!tokenPanel?.classList.contains('active')) return;

        const tag = e.target.tagName.toLowerCase();
        const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
        if (isInput) return;

        if (!e.ctrlKey) {
            if (code === hk.toolMove) {
                const btn = document.querySelector('.tool-card-top[data-tool="move"]');
                if (btn && !btn.classList.contains('active')) btn.click();
            }
            if (code === hk.toolEraser) {
                const btn = document.querySelector('.eraser-mode-btn.eraser-blue');
                if (btn) btn.click();
            }
            if (code === hk.toolMask) {
                const btn = document.querySelector('.eraser-mode-btn.eraser-pink');
                if (btn) btn.click();
            }
            if (code === hk.toolRemoveBg) {
                const btn = $('removeBgBtn');
                if (btn) btn.click();
            }
        }
    });
}

function initPasteHandler() {
    document.addEventListener('paste', e => {
        const tag = e.target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;

        e.preventDefault();
        const items = e.clipboardData?.items;
        if (!items) return;

        const files = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
                const blob = item.getAsFile();
                if (blob) files.push(new File([blob], `paste_${Date.now()}.png`, { type: item.type }));
            }
        }

        if (files.length === 0) return;

        const tokenPanel = $('tokenPanel');
        if (tokenPanel?.classList.contains('active')) {
            TokenCanvas.loadImage(files[0]);
            toast('Изображение вставлено');
        } else {
            Remover.handleFiles(files);
            toast('Вставлено из буфера');
        }
    });
}

function initSliderWheels() {
    const configs = [
        { slider: 'scaleSlider',            input: 'scaleInput',            valEl: null },
        { slider: 'rotationSlider',          input: 'rotationInput',         valEl: null },
        { slider: 'eraserSize',              input: 'eraserSizeInput',       valEl: null },
        { slider: 'portraitScaleSlider',     input: 'portraitScaleInput',    valEl: null },
        { slider: 'portraitRotationSlider',  input: 'portraitRotationInput', valEl: null },
    ];

    configs.forEach(({ slider, input, valEl }) => {
        const sl = $(slider);
        if (!sl) return;
        sl.addEventListener('wheel', e => {
            e.preventDefault();
            const step = parseFloat(sl.step) || 1;
            sl.value = clamp(parseFloat(sl.value) + (e.deltaY < 0 ? step : -step), parseFloat(sl.min), parseFloat(sl.max));
            sl.dispatchEvent(new Event('input', { bubbles: true }));
        }, { passive: false });
    });
}

async function init() {
    await AppConfig.load();
    initTabs();
    initSectionCollapse();
    initGlobalShortcuts();
    initPasteHandler();
    initSliderWheels();
    Remover.init();
    TokenEditor.init();
    HotkeySettings.init();
    window.addEventListener('beforeunload', () => urlManager.revokeAll());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
