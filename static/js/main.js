function initTabs() {
    document.querySelectorAll('.nav-btn[data-mode]').forEach(tab => {
        tab.onclick = () => {
            const mode = tab.dataset.mode;
            document.querySelectorAll('.nav-btn[data-mode]').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
            const panel = $(mode + 'Panel');
            if (panel) panel.classList.add('active');
        };
    });
}

function initZoomControls() {
    const zoomIn = $('zoomInBtn');
    const zoomOut = $('zoomOutBtn');
    const zoomReset = $('zoomResetBtn');
    const zoomLabel = $('zoomLabel');

    function updateLabel() {
        if (zoomLabel && state.viewZoom !== undefined) zoomLabel.textContent = Math.round(state.viewZoom * 100) + '%';
    }

    if (zoomIn) zoomIn.onclick = () => {
        if (!TokenCanvas) return;
        state.viewZoom = Math.min(state.viewZoom * 1.25, CONFIG.MAX_ZOOM || 20);
        TokenCanvas.updateViewTransform();
        updateLabel();
    };
    if (zoomOut) zoomOut.onclick = () => {
        if (!TokenCanvas) return;
        state.viewZoom = Math.max(state.viewZoom * 0.8, CONFIG.MIN_ZOOM || 0.5);
        TokenCanvas.updateViewTransform();
        updateLabel();
    };
    if (zoomReset) zoomReset.onclick = () => {
        if (!TokenCanvas) return;
        TokenCanvas.resetView();
        updateLabel();
    };

    document.addEventListener('keydown', e => {
        if (e.ctrlKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
            e.preventDefault(); zoomIn?.click();
        }
        if (e.ctrlKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
            e.preventDefault(); zoomOut?.click();
        }
        if (e.ctrlKey && e.code === 'Digit0') {
            e.preventDefault(); zoomReset?.click();
        }
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

        if (e.ctrlKey && code === 'KeyR') {
            e.preventDefault();
            location.reload();
            return;
        }

        const tokenPanel = $('tokenPanel');
        if (!tokenPanel?.classList.contains('active')) return;

        const tag = e.target.tagName.toLowerCase();
        const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
        if (isInput) return;

        if (!e.ctrlKey) {
            if (code === hk.toolMove) {
                const btn = document.querySelector('.tool-btn[data-tool="move"]');
                if (btn && !btn.classList.contains('active')) btn.click();
            }
            if (code === hk.toolEraser) {
                const btn = document.querySelector('.tool-btn[data-tool="eraser"]');
                if (btn) btn.click();
            }
            if (code === hk.toolMask) {
                const btn = document.querySelector('.tool-btn[data-tool="mask"]');
                if (btn) btn.click();
            }
            if (code === hk.toolRemoveBg) {
                const btn = $('removeBgBtn');
                if (btn) btn.click();
            }
            if (code === hk.toolAutoFrame) {
                const btn = $('autoFrameBtn');
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

function initTheme() {
    function applyTheme(val) {
        document.documentElement.classList.remove('theme-neon', 'theme-warm', 'theme-dark', 'theme-light');
        if (val && val !== 'indigo') document.documentElement.classList.add('theme-' + val);
    }
    applyTheme(AppConfig.theme);
    document.querySelectorAll('input[name="theme"]').forEach(r => {
        r.checked = (r.value === AppConfig.theme);
        r.addEventListener('change', function() {
            if (!this.checked) return;
            applyTheme(this.value);
            AppConfig.setTheme(this.value);
        });
    });
}

function initDefaultSettings() {
    var defQ = $('defQualitySelect');
    if (defQ) {
        defQ.value = AppConfig.saveSettings.quality || 512;
        defQ.onchange = function() {
            AppConfig.setSaveSetting('quality', parseInt(this.value));
        };
    }
    var defFmt = $('defRemoverFormat');
    if (defFmt) {
        defFmt.value = AppConfig.remover.format || 'webp';
        defFmt.onchange = function() {
            AppConfig.setRemover('format', this.value);
        };
    }
}

function initResizeHandles() {
    var leftPanel = document.querySelector('.context-panel-left');
    var leftHandle = $('leftPanelHandle');
    var savedLeft = AppConfig.panelWidths.left || 320;
    if (leftPanel) leftPanel.style.width = savedLeft + 'px';

    var rightPanel = document.querySelector('.context-panel-right');
    var rightHandle = $('rightPanelHandle');
    var savedRight = AppConfig.panelWidths.right || 320;
    if (rightPanel) rightPanel.style.width = savedRight + 'px';

    function makeResize(handle, panel, side) {
        if (!handle || !panel) return;
        var startX, startW;
        function onStart(e) {
            startX = e.clientX;
            startW = panel.offsetWidth;
            handle.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        }
        function onMove(e) {
            var dx = side === 'left' ? (e.clientX - startX) : (startX - e.clientX);
            var newW = Math.max(180, Math.min(480, startW + dx));
            panel.style.width = newW + 'px';
        }
        function onEnd() {
            handle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            AppConfig.setPanelWidth(side, panel.offsetWidth);
        }
        handle.addEventListener('mousedown', onStart);
    }

    makeResize(leftHandle, leftPanel, 'left');
    makeResize(rightHandle, rightPanel, 'right');
}

function initWindowControls() {
    const flask = (action) => fetch('/api/window/' + action, { method: 'POST' }).catch(() => {});
    const api = window.pywebview?.api;

    $('wcMinimize')?.addEventListener('click', () => {
        if (api && api.minimize) api.minimize();
        else flask('minimize');
    });
    $('wcClose')?.addEventListener('click', () => {
        if (api && api.destroy) api.destroy();
        else flask('close');
    });

    const maxBtn = $('wcMaximize');
    if (maxBtn) {
        const setIcon = () => {
            const isMax = document.documentElement.classList.contains('is-maximized');
            maxBtn.innerHTML = isMax
                ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="14" height="14" rx="1"/><rect x="3" y="3" width="14" height="14" rx="1"/></svg>'
                : '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
        };
        maxBtn.addEventListener('click', () => {
            if (document.documentElement.classList.contains('is-maximized')) {
                document.documentElement.classList.remove('is-maximized');
                if (api && api.restore) api.restore();
                else flask('restore');
            } else {
                document.documentElement.classList.add('is-maximized');
                if (api && api.maximize) api.maximize();
                else flask('maximize');
            }
            setIcon();
        });
    }

    $('titleBar')?.addEventListener('dblclick', e => {
        if (e.target.closest('.tb-nav, .window-controls')) return;
        maxBtn?.click();
    });

    $('titleBar')?.addEventListener('mousedown', e => {
        if (e.target.closest('.tb-nav, .window-controls')) return;
        flask('move');
    });
}

function initModelCheck() {
    fetch('/model_status').then(function(r) { return r.json(); }).then(function(d) {
        if (d && !d.exists) {
            const banner = $('modelBanner');
            if (banner) {
                const pathEl = $('modelPath');
                if (pathEl && d.models_dir) pathEl.textContent = d.models_dir;
                banner.hidden = false;
                const close = $('modelBannerClose');
                if (close) close.onclick = () => { banner.hidden = true; };
            }
            toast('Модель не найдена: положите файл .onnx в папку models', true);
        }
    }).catch(function() {});
}

function initModelSelector() {
    const sel = $('modelSelect');
    const dirLabel = $('modelsDirLabel');
    if (!sel) return;
    fetch('/models_list').then(function(r) { return r.json(); }).then(function(d) {
        if (dirLabel && d.models_dir) dirLabel.textContent = d.models_dir;
        sel.innerHTML = '';
        if (!d.models || d.models.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Нет моделей (.onnx)';
            sel.appendChild(opt);
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        d.models.forEach(function(m) {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = m.selected ? m.name + ' (текущая)' : m.name;
            if (m.selected) opt.selected = true;
            sel.appendChild(opt);
        });
    }).catch(function() {});
    sel.onchange = function() {
        if (!sel.value) return;
        fetch('/select_model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: sel.value })
        }).then(function(r) { return r.json(); }).then(function(d) {
            if (d && d.ok) {
                toast('Модель "' + d.name + '" — будет применена к следующей обработке');
            } else {
                toast('Ошибка: ' + (d.error || 'не удалось выбрать модель'), true);
            }
            initModelSelector();
        }).catch(function() {
            toast('Ошибка выбора модели', true);
        });
    };
}

let aboutUpdating = false;
let aboutDownloading = false;

function openAboutTab() {
    document.querySelectorAll('.nav-btn[data-mode]').forEach(function(t) { t.classList.remove('active'); });
    const btn = document.querySelector('.nav-btn[data-mode="about"]');
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
    const panel = $('aboutPanel');
    if (panel) panel.classList.add('active');
}

function initUpdateNotify() {
    const banner = $('updateNotifyBanner');
    const badge = $('tbUpdateBadge');
    if (!banner) return;
    const open = $('updateNotifyOpen');
    const close = $('updateNotifyClose');
    banner.addEventListener('click', function(e) {
        if (e.target === close) return;
        openAboutTab();
    });
    if (open) open.addEventListener('click', function(e) { e.stopPropagation(); openAboutTab(); });
    if (close) close.addEventListener('click', function(e) { e.stopPropagation(); banner.hidden = true; });

    // Фоновая проверка обновлений уже запущена сервером при старте — опрашиваем её
    let tries = 0;
    function poll() {
        fetch('/update_status').then(function(r) { return r.json(); }).then(function(d) {
            if (d && d.update_available && !d.download_done && d.update_tag) {
                const v = $('updateNotifyVersion');
                if (v) v.textContent = 'v' + d.update_tag;
                banner.hidden = false;
                if (badge) {
                    badge.hidden = false;
                    badge.dataset.tooltip = 'Доступно обновление v' + d.update_tag;
                }
                return;
            }
            if (tries++ < 20) setTimeout(poll, 2000);
        }).catch(function() {
            if (tries++ < 20) setTimeout(poll, 2000);
        });
    }
    setTimeout(poll, 3000);
}

function initAboutUpdate() {
    fetch('/version').then(r => r.json()).then(d => {
        const v = $('aboutVersion');
        if (v) v.textContent = 'Версия ' + (d.version || '?');
        const tv = $('titleVersion');
        if (tv) tv.textContent = d.version || '';
    }).catch(() => {});
    fetch('/device').then(r => r.json()).then(d => {
        const el = $('aboutDeviceValue');
        if (el) el.textContent = (d.device || 'CPU').replace('DirectML', 'DirectML');
    }).catch(() => {});

    const btn = $('checkUpdatesBtn');
    if (btn) btn.onclick = () => checkForUpdatesManual();

    // Клик по версии слева сверху открывает раздел «О программе»
    const brand = $('tbBrand');
    if (brand) {
        brand.addEventListener('click', e => {
            if (e.target.closest('.tb-update-badge, .wc-btn, .nav-btn')) return;
            openAboutTab();
        });
    }
    const badge = $('tbUpdateBadge');
    if (badge) badge.addEventListener('click', () => openAboutTab());
}

function aboutUpdateSetStatus(html) {
    const st = $('aboutUpdateStatus');
    if (st) st.innerHTML = html;
}

function aboutUpdateShowProgress(pct) {
    const box = $('aboutUpdateBox');
    if (!box) return;
    box.hidden = false;
    const prog = $('aboutUpdateProgress');
    const bar = $('aboutUpdateBarFill');
    const pctEl = $('aboutUpdatePct');
    const actions = $('aboutUpdateActions');
    if (prog) prog.hidden = false;
    if (bar) { bar.classList.remove('indeterminate'); bar.style.width = pct + '%'; }
    if (pctEl) pctEl.textContent = pct + '%';
    if (actions) actions.innerHTML = '';
    aboutUpdateSetStatus('Скачивание обновления...');
}

function aboutUpdateShowIndeterminate() {
    const box = $('aboutUpdateBox');
    if (!box) return;
    box.hidden = false;
    const prog = $('aboutUpdateProgress');
    const bar = $('aboutUpdateBarFill');
    const pctEl = $('aboutUpdatePct');
    const actions = $('aboutUpdateActions');
    if (prog) prog.hidden = false;
    if (bar) { bar.classList.add('indeterminate'); bar.style.width = '40%'; }
    if (pctEl) pctEl.textContent = '...';
    if (actions) actions.innerHTML = '';
    aboutUpdateSetStatus('Скачивание обновления...');
}

function hideAboutUpdate() {
    const box = $('aboutUpdateBox');
    if (box) box.hidden = true;
    const prog = $('aboutUpdateProgress');
    if (prog) prog.hidden = true;
    const bar = $('aboutUpdateBarFill');
    if (bar) { bar.classList.remove('indeterminate'); bar.style.width = '0%'; }
    const actions = $('aboutUpdateActions');
    if (actions) actions.innerHTML = '';
    const btn = $('checkUpdatesBtn');
    if (btn) btn.disabled = false;
    aboutUpdating = false;
    aboutDownloading = false;
}

function checkForUpdatesManual() {
    if (aboutUpdating) return;
    aboutUpdating = true;
    const box = $('aboutUpdateBox');
    const btn = $('checkUpdatesBtn');
    const actions = $('aboutUpdateActions');
    if (box) box.hidden = false;
    if (actions) actions.innerHTML = '';
    if (btn) btn.disabled = true;
    aboutUpdateSetStatus('Проверка обновлений...');
    fetch('/check_update', { method: 'POST' }).catch(() => {});
    pollAboutUpdate(40);
}

function pollAboutUpdate(retries) {
    fetch('/update_status').then(r => r.json()).then(d => {
        const actions = $('aboutUpdateActions');
        if (d.download_done) {
            aboutUpdateSetStatus('Обновление <b>' + (d.update_tag || '') + '</b> скачано! Установить сейчас?');
            if (actions) actions.innerHTML =
                '<button class="accent-btn accent-btn-compact" onclick="applyAboutUpdate()">Установить</button>' +
                '<button class="about-link" onclick="hideAboutUpdate()">Позже</button>';
            return;
        }
        if (d.download_active && !d.download_error) {
            if (d.download_progress >= 0) {
                aboutUpdateShowProgress(d.download_progress);
            } else {
                aboutUpdateShowIndeterminate();
            }
            setTimeout(() => pollAboutUpdate(retries), 1000);
            return;
        }
        if (d.download_error) {
            aboutUpdateSetStatus('<span style="color:#ef4444">Ошибка скачивания: ' + d.download_error + '</span>');
            if (actions) actions.innerHTML = '<button class="about-link" onclick="hideAboutUpdate()">Закрыть</button>';
            aboutUpdating = false;
            aboutDownloading = false;
            if ($('checkUpdatesBtn')) $('checkUpdatesBtn').disabled = false;
            return;
        }
        if (d.update_available && d.update_url) {
            aboutUpdateSetStatus('Доступна версия <b>' + (d.update_tag || '') + '</b> (текущая: ' + d.current_version + ')');
            if (actions) actions.innerHTML =
                '<button class="accent-btn accent-btn-compact" onclick="startAboutDownload()">Скачать</button>' +
                '<button class="about-link" onclick="hideAboutUpdate()">Закрыть</button>';
            aboutUpdating = false;
            if ($('checkUpdatesBtn')) $('checkUpdatesBtn').disabled = false;
            // Если загрузка уже стартовала, но флаг ещё не доехал — продолжаем опрашивать
            if (aboutDownloading) setTimeout(() => pollAboutUpdate(retries), 1000);
            return;
        }
        if (d.update_checked) {
            aboutUpdateSetStatus('Обновлений нет — у вас последняя версия');
            if (actions) actions.innerHTML = '<button class="about-link" onclick="hideAboutUpdate()">Закрыть</button>';
            aboutUpdating = false;
            if ($('checkUpdatesBtn')) $('checkUpdatesBtn').disabled = false;
            return;
        }
        if (retries > 0) setTimeout(() => pollAboutUpdate(retries - 1), 500);
        else {
            aboutUpdateSetStatus('Не удалось проверить обновления');
            if (actions) actions.innerHTML = '<button class="about-link" onclick="hideAboutUpdate()">Закрыть</button>';
            aboutUpdating = false;
            if ($('checkUpdatesBtn')) $('checkUpdatesBtn').disabled = false;
        }
    }).catch(() => {
        if (retries > 0) setTimeout(() => pollAboutUpdate(retries - 1), 500);
        else {
            aboutUpdateSetStatus('Не удалось проверить обновления');
            const actions = $('aboutUpdateActions');
            if (actions) actions.innerHTML = '<button class="about-link" onclick="hideAboutUpdate()">Закрыть</button>';
            aboutUpdating = false;
            if ($('checkUpdatesBtn')) $('checkUpdatesBtn').disabled = false;
        }
    });
}

function startAboutDownload() {
    if (aboutDownloading) {
        pollAboutUpdate(600);
        return;
    }
    aboutDownloading = true;
    aboutUpdating = true;
    if ($('checkUpdatesBtn')) $('checkUpdatesBtn').disabled = true;
    const actions = $('aboutUpdateActions');
    if (actions) actions.innerHTML = '';
    aboutUpdateShowProgress(0);
    fetch('/start_update_download', { method: 'POST' }).catch(() => {});
    pollAboutUpdate(600);
}

function applyAboutUpdate() {
    aboutUpdateSetStatus('Установка обновления... Приложение закроется');
    const actions = $('aboutUpdateActions');
    if (actions) actions.innerHTML = '';
    fetch('/apply_update', { method: 'POST' }).catch(() => {});
    fetch('/api/window/destroy', { method: 'POST' }).catch(() => {});
    setTimeout(() => { try { window.location.href = '/'; } catch (e) {} }, 2000);
}

async function init() {
    await AppConfig.load();
    initTheme();
    initDefaultSettings();
    initResizeHandles();
    initTabs();
    initZoomControls();
    initWindowControls();
    initGlobalShortcuts();
    initPasteHandler();
    initSliderWheels();
    initTooltips();
    initModelCheck();
    initModelSelector();
    initUpdateNotify();
    initAboutUpdate();
    Remover.init();
    Converter.init();
    TokenEditor.init();
    HotkeySettings.init();
    window.addEventListener('beforeunload', () => urlManager.revokeAll());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
