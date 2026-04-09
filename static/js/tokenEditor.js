const TokenEditor = {
    pressedKeys: new Set(),
    moveInterval: null,
    moveTimeout: null,
    initialMoveDone: false,
    rotateInterval: null,
    rotateTimeout: null,
    initialRotateDone: false,

    init() {
        TokenCanvas.init();
        TokenPresets.loadProtectionMask();
        TokenPresets.loadPresets();
        TokenPresets.loadRings();

        this.setupDropzone();
        this.setupToolButtons();
        this.setupSliders();
        this.setupCheckboxes();
        this.setupSaveButtons();
        this.setupKeyboardControls();
        this.setupPortraitVisibility();
        this.updateToolHotkeys();
    },

    updateToolHotkeys() {
        const hk = AppConfig.hotkeys;
        const map = {
            '[data-tool="move"] kbd':              codeToLabel(hk.toolMove),
            '[data-tool="removebg"] kbd':           codeToLabel(hk.toolRemoveBg),
            '.eraser-mode-btn.eraser-blue kbd':     codeToLabel(hk.toolEraser),
            '.eraser-mode-btn.eraser-pink kbd':     codeToLabel(hk.toolMask),
        };
        Object.entries(map).forEach(([sel, label]) => {
            document.querySelectorAll(sel).forEach(el => { el.textContent = label; });
        });
    },

    setupDropzone() {
        const tokenDropzone = $('tokenDropzone');
        const tokenFileInput = $('tokenFileInput');
        if (tokenDropzone && tokenFileInput) {
            tokenDropzone.onclick = e => { e.stopPropagation(); tokenFileInput.click(); };
            tokenDropzone.ondragover = e => { e.preventDefault(); tokenDropzone.style.borderColor = 'var(--accent)'; };
            tokenDropzone.ondragleave = () => { tokenDropzone.style.borderColor = ''; };
            tokenDropzone.ondrop = e => {
                e.preventDefault();
                tokenDropzone.style.borderColor = '';
                const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                if (files.length > 0) TokenCanvas.loadImage(files[0]);
            };
        }
        if (tokenFileInput) {
            tokenFileInput.onchange = e => {
                if (e.target.files.length > 0) TokenCanvas.loadImage(e.target.files[0]);
                tokenFileInput.value = '';
            };
        }
        const tokenFileNameInput = $('tokenFileName');
        if (tokenFileNameInput) {
            tokenFileNameInput.oninput = e => { state.tokenFileName = e.target.value || 'token'; };
        }
    },

    setupToolButtons() {
        document.querySelectorAll('.tool-card-top[data-tool]').forEach(btn => {
            btn.onclick = () => {
                const tool = btn.dataset.tool;
                if (tool === 'removebg') { this.handleRemoveBackground(btn); return; }
                document.querySelectorAll('.tool-card-top[data-tool]').forEach(b => {
                    if (b.dataset.tool !== 'removebg') b.classList.remove('active');
                });
                btn.classList.add('active');
                state.currentTool = tool;
                const tokenCanvas = $('tokenCanvas');
                if (tokenCanvas) tokenCanvas.classList.remove('eraser-mode');
                const eraserRow = $('eraserRow');
                if (eraserRow) eraserRow.style.display = 'none';
                TokenCanvas.hideEraserCursor();
            };
        });

        document.querySelectorAll('.eraser-mode-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.tool-card-top[data-tool]').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.eraser-mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.currentEraserMode = btn.dataset.mode;
                state.currentTool = 'eraser';
                const tokenCanvas = $('tokenCanvas');
                if (tokenCanvas) tokenCanvas.classList.add('eraser-mode');
                const eraserRow = $('eraserRow');
                if (eraserRow) eraserRow.style.display = 'flex';
                TokenCanvas.showEraserCursor();
            };
        });

        const eraserSizeSlider = $('eraserSize');
        const eraserSizeInput = $('eraserSizeInput');
        function applyEraserSize(val) {
            val = clamp(parseInt(val) || 50, 1, 300);
            state.eraserSize = val;
            TokenCanvas.setEraserSize(val);
            if (eraserSizeSlider) eraserSizeSlider.value = val;
            if (eraserSizeInput) eraserSizeInput.value = val;
        }
        if (eraserSizeSlider) eraserSizeSlider.oninput = e => applyEraserSize(e.target.value);
        if (eraserSizeInput) {
            eraserSizeInput.onchange = e => applyEraserSize(e.target.value);
            eraserSizeInput.oninput = e => applyEraserSize(e.target.value);
        }

        const resetMaskBtn = $('resetMask');
        if (resetMaskBtn) resetMaskBtn.onclick = () => TokenCanvas.resetMask();
        const resetImageMaskBtn = $('resetImageMask');
        if (resetImageMaskBtn) resetImageMaskBtn.onclick = () => TokenCanvas.resetImageMask();
    },

    async handleRemoveBackground(btn) {
        if (!state.userImageOriginal && !state.userImageWithoutBg) {
            toast('Сначала загрузите изображение', true); return;
        }
        if (state.backgroundRemoved && state.userImageWithoutBg) {
            state.showingOriginal = !state.showingOriginal;
            if (state.showingOriginal) {
                state.userImage = state.userImageOriginal;
                btn.querySelector('span').textContent = 'Показать без фона';
                btn.classList.remove('active');
                toast('Показан оригинал');
            } else {
                state.userImage = state.userImageWithoutBg;
                btn.querySelector('span').textContent = 'Показать оригинал';
                btn.classList.add('active');
                toast('Показан без фона');
            }
            TokenCanvas._compositedImageDirty = true;
            TokenCanvas._ccDirty = true;
            TokenCanvas.render();
            if (typeof PortraitGenerator !== 'undefined' && PortraitGenerator.canvas) PortraitGenerator.render();
            return;
        }
        if (!state.userImageOriginal) return;

        toast('Удаление фона...');
        btn.disabled = true;
        const kbd = btn.querySelector('kbd');
        const kbdText = kbd ? kbd.outerHTML : '';
        const originalSpanText = btn.querySelector('span')?.textContent || 'Вырезать фон';
        btn.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div><span>Обработка...</span>${kbdText}`;

        try {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = state.userImageOriginal.width;
            tempCanvas.height = state.userImageOriginal.height;
            tempCanvas.getContext('2d').drawImage(state.userImageOriginal, 0, 0);
            const blob = await new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));
            tempCanvas.getContext('2d').clearRect(0, 0, tempCanvas.width, tempCanvas.height);

            const fd = new FormData();
            fd.append('image', blob, 'image.png');
            fd.append('format', 'png');
            const res = await fetch('/process', { method: 'POST', body: fd });
            if (!res.ok) throw new Error('Ошибка обработки');
            const resultBlob = await res.blob();

            if (state.userImageUrl) {
                URL.revokeObjectURL(state.userImageUrl);
                state.userImageUrl = null;
            }

            const url = URL.createObjectURL(resultBlob);
            const newImage = new Image();

            newImage.onload = () => {
                state.userImageUrl = url;
                state.userImageWithoutBg = newImage;
                state.userImage = newImage;
                state.backgroundRemoved = true;
                state.showingOriginal = false;

                if (state.imageMaskCanvas) {
                    const ctx = state.imageMaskCanvas.getContext('2d');
                    ctx.clearRect(0, 0, state.imageMaskCanvas.width, state.imageMaskCanvas.height);
                    ctx.fillStyle = 'white';
                    ctx.fillRect(0, 0, state.imageMaskCanvas.width, state.imageMaskCanvas.height);
                }

                TokenCanvas._compositedImageDirty = true;
                TokenCanvas._ccDirty = true;
                TokenCanvas._imageBrushCache = null;

                btn.disabled = false;
                btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg><span>Показать оригинал</span>${kbdText}`;
                btn.classList.add('active');
                this.updateRemoveBgButton();
                TokenHistory.save();
                TokenCanvas.render();
                if (typeof PortraitGenerator !== 'undefined' && PortraitGenerator.canvas) PortraitGenerator.render();
                toast('Фон удалён!');
            };

            newImage.onerror = () => {
                URL.revokeObjectURL(url);
                throw new Error('Не удалось загрузить результат');
            };

            newImage.src = url;
        } catch (err) {
            toast('Ошибка: ' + err.message, true);
            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg><span>${originalSpanText}</span>${kbdText}`;
        }
    },

    updateRemoveBgButton() {
        const btn = $('removeBgBtn');
        if (!btn) return;
        const span = btn.querySelector('span');
        if (!span) return;
        if (state.backgroundRemoved && state.userImageWithoutBg) {
            btn.disabled = false;
            if (state.showingOriginal) { span.textContent = 'Показать без фона'; btn.classList.remove('active'); }
            else { span.textContent = 'Показать оригинал'; btn.classList.add('active'); }
        } else {
            btn.disabled = false;
            span.textContent = 'Вырезать фон';
            btn.classList.remove('active');
        }
    },

    setupSliders() {
        const debouncedSave = debounce(() => TokenHistory.save(), CONFIG.DEBOUNCE_DELAY);
        const scaleSlider = $('scaleSlider');
        if (scaleSlider) {
            scaleSlider.oninput = e => {
                state.imageScale = parseInt(e.target.value) / 100;
                const input = $('scaleInput');
                if (input) input.value = e.target.value;
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.scheduleEffects();
                TokenCanvas.render();
            };
            scaleSlider.onchange = debouncedSave;
        }
        const scaleInput = $('scaleInput');
        if (scaleInput) {
            scaleInput.onchange = e => {
                let val = clamp(parseInt(e.target.value) || CONFIG.DEFAULT_SCALE, CONFIG.MIN_SCALE, CONFIG.MAX_SCALE);
                state.imageScale = val / 100;
                const slider = $('scaleSlider');
                if (slider) slider.value = val;
                e.target.value = val;
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.scheduleEffects();
                TokenCanvas.render();
                TokenHistory.save();
            };
        }
        const rotationSlider = $('rotationSlider');
        if (rotationSlider) {
            rotationSlider.oninput = e => {
                state.imageRotation = parseInt(e.target.value);
                const input = $('rotationInput');
                if (input) input.value = e.target.value;
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.scheduleEffects();
                TokenCanvas.render();
            };
            rotationSlider.onchange = debouncedSave;
        }
        const rotationInput = $('rotationInput');
        if (rotationInput) {
            rotationInput.onchange = e => {
                let val = clamp(parseInt(e.target.value) || 0, -180, 180);
                state.imageRotation = val;
                const slider = $('rotationSlider');
                if (slider) slider.value = val;
                e.target.value = val;
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.scheduleEffects();
                TokenCanvas.render();
                TokenHistory.save();
            };
        }
        const resetTransformBtn = $('resetTransformBtn');
        if (resetTransformBtn) {
            resetTransformBtn.onclick = () => {
                state.imageScale = 1;
                state.imageRotation = 0;
                TokenCanvas.updateScaleUI();
                TokenCanvas.updateRotationUI();
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.render();
                TokenHistory.save();
                toast('Transform reset');
            };
        }
    },

    setupCheckboxes() {
        const dropShadowCheck = $('dropShadowCheck');
        if (dropShadowCheck) {
            dropShadowCheck.onchange = e => {
                state.dropShadowEnabled = e.target.checked;
                const settings = $('dropShadowSettings');
                if (settings) settings.style.display = state.dropShadowEnabled ? 'flex' : 'none';
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.render();
            };
        }
        const colorCorrectionCheck = $('colorCorrectionCheck');
        if (colorCorrectionCheck) {
            colorCorrectionCheck.onchange = e => {
                state.colorCorrectionEnabled = e.target.checked;
                const settings = $('colorCorrectionSettings');
                if (settings) settings.style.display = state.colorCorrectionEnabled ? 'flex' : 'none';
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.render();
            };
        }
        this._setupDropShadowSettings();
        this._setupColorCorrectionSettings();

        const showErasedCheck = $('showErasedCheck');
        if (showErasedCheck) showErasedCheck.onchange = e => { state.showErasedZones = e.target.checked; TokenCanvas.render(); };

        const showProtectionCheck = $('showProtectionCheck');
        if (showProtectionCheck) showProtectionCheck.onchange = e => { state.showProtectionMask = e.target.checked; TokenCanvas.render(); };

        const showBordersCheck = $('showBordersCheck');
        if (showBordersCheck) showBordersCheck.onchange = e => { state.showScaleBorders = e.target.checked; TokenCanvas.render(); };

        const saveQualitySelect = $('saveQualitySelect');
        if (saveQualitySelect) saveQualitySelect.onchange = e => { state.saveQuality = parseInt(e.target.value); toast('Качество: ' + state.saveQuality + 'px'); };

        const saveScaleSelect = $('saveScaleSelect');
        if (saveScaleSelect) {
            saveScaleSelect.onchange = e => {
                state.saveScaleMode = e.target.value;
                const labels = { 'auto': 'Авто', '1': 'х1', '2': 'х2', '3': 'х3' };
                toast('Масштаб сохранения: ' + (labels[state.saveScaleMode] || state.saveScaleMode));
            };
        }

        const quickSaveCheck = $('quickSaveCheck');
        const quickSaveFolderRow = $('quickSaveFolderRow');
        const quickSaveFolderBtn = $('quickSaveFolderBtn');
        const quickSaveFolderName = $('quickSaveFolderName');
        if (quickSaveCheck) {
            quickSaveCheck.onchange = e => {
                state.quickSaveEnabled = e.target.checked;
                if (quickSaveFolderRow) quickSaveFolderRow.style.display = state.quickSaveEnabled ? 'flex' : 'none';
                if (state.quickSaveEnabled && !state.quickSaveFolder) this._pickSaveFolder(quickSaveFolderName);
                this.updatePortraitVisibility();
            };
        }
        if (quickSaveFolderBtn) quickSaveFolderBtn.onclick = () => this._pickSaveFolder(quickSaveFolderName);
    },

    _setupDropShadowSettings() {
        const sliders = [
            { id: 'shadowAngle',    valId: 'shadowAngleVal',    key: 'angle',   factor: 1    },
            { id: 'shadowDistance', valId: 'shadowDistanceVal', key: 'distance',factor: 1    },
            { id: 'shadowBlur',     valId: 'shadowBlurVal',     key: 'blur',    factor: 1    },
            { id: 'shadowOpacity',  valId: 'shadowOpacityVal',  key: 'opacity', factor: 0.01 },
        ];
        const ds = AppConfig.dropShadow;
        const initVals = { shadowAngle: ds.angle, shadowDistance: ds.distance, shadowBlur: ds.blur, shadowOpacity: Math.round(ds.opacity * 100) };
        sliders.forEach(({ id, valId, key, factor }) => {
            const el = $(id); const valEl = $(valId);
            if (!el) return;
            el.value = initVals[id];
            if (valEl) valEl.textContent = el.value;
            el.oninput = () => { 
                AppConfig.setDropShadow(key, parseFloat(el.value) * factor); 
                if (valEl) valEl.textContent = el.value; 
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.render(); 
            };
            el.addEventListener('wheel', ev => { ev.preventDefault(); const step = parseFloat(el.step)||1; el.value = clamp(parseFloat(el.value)+(ev.deltaY<0?step:-step),parseFloat(el.min),parseFloat(el.max)); el.dispatchEvent(new Event('input')); }, { passive: false });
        });
        const resetBtn = $('shadowResetBtn');
        if (resetBtn) {
            resetBtn.onclick = () => {
                AppConfig.resetDropShadow();
                const ds2 = AppConfig.dropShadow;
                $('shadowAngle').value = ds2.angle; $('shadowDistance').value = ds2.distance;
                $('shadowBlur').value = ds2.blur; $('shadowOpacity').value = Math.round(ds2.opacity * 100);
                sliders.forEach(({ id, valId }) => { const valEl = $(valId); if (valEl) valEl.textContent = $(id).value; });
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.render(); 
                toast('Тень сброшена');
            };
        }
    },

    _setupColorCorrectionSettings() {
        const sliders = [
            { id: 'ccSaturation', valId: 'ccSaturationVal', key: 'saturation' },
            { id: 'ccLightness',  valId: 'ccLightnessVal',  key: 'lightness'  },
        ];
        const cc = AppConfig.colorCorrection;
        const initVals = { ccSaturation: cc.saturation, ccLightness: cc.lightness };
        sliders.forEach(({ id, valId, key }) => {
            const el = $(id); const valEl = $(valId);
            if (!el) return;
            el.value = initVals[id];
            if (valEl) valEl.textContent = el.value;
            el.oninput = () => { 
                AppConfig.setColorCorrection(key, parseFloat(el.value)); 
                if (valEl) valEl.textContent = el.value; 
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.render(); 
            };
            el.addEventListener('wheel', ev => { ev.preventDefault(); const step = parseFloat(el.step)||1; el.value = clamp(parseFloat(el.value)+(ev.deltaY<0?step:-step),parseFloat(el.min),parseFloat(el.max)); el.dispatchEvent(new Event('input')); }, { passive: false });
        });
        const resetBtn = $('ccResetBtn');
        if (resetBtn) {
            resetBtn.onclick = () => {
                AppConfig.resetColorCorrection();
                const cc2 = AppConfig.colorCorrection;
                $('ccSaturation').value = cc2.saturation; $('ccLightness').value = cc2.lightness;
                sliders.forEach(({ id, valId }) => { const valEl = $(valId); if (valEl) valEl.textContent = $(id).value; });
                TokenCanvas.invalidateEffectsCache();
                TokenCanvas.render(); 
                toast('Цветокоррекция сброшена');
            };
        }
    },

    setupSaveButtons() {
        const saveWithoutRingBtn = $('saveWithoutRing');
        if (saveWithoutRingBtn) saveWithoutRingBtn.onclick = () => TokenCanvas.save(false);
        const saveWithRingBtn = $('saveWithRing');
        if (saveWithRingBtn) saveWithRingBtn.onclick = () => TokenCanvas.save(true);
        this.updateRemoveBgButton();
    },

    setupPortraitVisibility() {
        const quickSaveCheck = $('quickSaveCheck');
        if (quickSaveCheck) quickSaveCheck.addEventListener('change', () => this.updatePortraitVisibility());
        this.updatePortraitVisibility();
    },

    updatePortraitVisibility() {
        const section = $('sec-portrait');
        if (!section) return;
        const enabled = $('quickSaveCheck')?.checked || false;
        section.style.display = enabled ? '' : 'none';
        if (enabled && !PortraitGenerator.canvas) PortraitGenerator.init();
    },

    setupKeyboardControls() {
        document.addEventListener('keydown', e => this.handleKeyDown(e));
        document.addEventListener('keyup', e => this.handleKeyUp(e));
    },

    handleKeyDown(e) {
        const isTokenMode = $('tokenPanel')?.classList.contains('active');
        if (!isTokenMode) return;
        const tag = e.target.tagName.toLowerCase();
        const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
        const code = e.code;
        const hk = AppConfig.hotkeys;
        if (e.ctrlKey && code === hk.undo && !e.shiftKey) { e.preventDefault(); TokenHistory.undo(); return; }
        if ((e.ctrlKey && code === hk.redo) || (e.ctrlKey && e.shiftKey && code === hk.undo)) { e.preventDefault(); TokenHistory.redo(); return; }
        if (!isInput && state.userImage && ROTATE_KEYS.includes(code) && !e.ctrlKey) { e.preventDefault(); this.handleRotateKey(code); return; }
        if (!isInput && state.userImage && MOVE_KEYS.includes(code)) { e.preventDefault(); this.handleMoveKey(code); }
    },

    handleKeyUp(e) {
        const code = e.code;
        if (ROTATE_KEYS.includes(code)) {
            this.pressedKeys.delete(code);
            if (!this.pressedKeys.has('KeyQ') && !this.pressedKeys.has('KeyE')) {
                this.clearRotateTimers(); this.initialRotateDone = false;
                if (state.userImage) TokenHistory.save();
            }
        }
        if (MOVE_KEYS.includes(code)) {
            this.pressedKeys.delete(code);
            const hasMovementKeys = MOVE_KEYS.some(k => this.pressedKeys.has(k));
            if (!hasMovementKeys) { this.clearMoveTimers(); this.initialMoveDone = false; if (state.userImage) TokenHistory.save(); }
        }
    },

    handleRotateKey(code) {
        if (!this.pressedKeys.has(code)) {
            this.pressedKeys.add(code);
            if (!this.initialRotateDone) {
                this.rotateByKey(code, CONFIG.ROTATE_STEP);
                this.initialRotateDone = true;
                this.rotateTimeout = setTimeout(() => {
                    if (this.pressedKeys.has('KeyQ') || this.pressedKeys.has('KeyE')) {
                        this.rotateInterval = setInterval(() => {
                            if (this.pressedKeys.has('KeyQ')) this.rotateByKey('KeyQ', CONFIG.ROTATE_STEP);
                            if (this.pressedKeys.has('KeyE')) this.rotateByKey('KeyE', CONFIG.ROTATE_STEP);
                        }, 50);
                    }
                }, 500);
            }
        }
    },

    handleMoveKey(code) {
        if (!this.pressedKeys.has(code)) {
            this.pressedKeys.add(code);
            if (!this.initialMoveDone) {
                this.moveByKeys(1);
                this.initialMoveDone = true;
                this.moveTimeout = setTimeout(() => {
                    if (this.pressedKeys.size > 0) this.moveInterval = setInterval(() => this.moveByKeys(CONFIG.MOVE_STEP), 50);
                }, 500);
            }
        }
    },

    rotateByKey(code, step) {
        if (!state.userImage) return;
        const direction = code === 'KeyQ' ? -1 : 1;
        state.imageRotation += direction * step;
        if (state.imageRotation > 180) state.imageRotation -= 360;
        if (state.imageRotation < -180) state.imageRotation += 360;
        TokenCanvas.updateRotationUI(); TokenCanvas.scheduleEffects(); TokenCanvas.render();
    },

    moveByKeys(step = CONFIG.MOVE_STEP) {
        if (!state.userImage) return;
        let moved = false;
        if (this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp'))    { state.imageY -= step; moved = true; }
        if (this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown'))  { state.imageY += step; moved = true; }
        if (this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft'))  { state.imageX -= step; moved = true; }
        if (this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight')) { state.imageX += step; moved = true; }
        if (moved) { TokenCanvas.scheduleEffects(); TokenCanvas.render(); }
    },

    clearRotateTimers() {
        if (this.rotateTimeout)  { clearTimeout(this.rotateTimeout);  this.rotateTimeout  = null; }
        if (this.rotateInterval) { clearInterval(this.rotateInterval); this.rotateInterval = null; }
    },

    clearMoveTimers() {
        if (this.moveTimeout)  { clearTimeout(this.moveTimeout);  this.moveTimeout  = null; }
        if (this.moveInterval) { clearInterval(this.moveInterval); this.moveInterval = null; }
    },

    async _pickSaveFolder(nameEl) {
        const path = await pickFolder();
        if (!path) return;
        state.quickSaveFolder = path;
        if (nameEl) nameEl.textContent = path.split(/[\\/]/).pop() || path;
        toast('Папка выбрана: ' + path);
    }
};
