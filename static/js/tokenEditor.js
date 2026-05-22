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
        this.setupFaceDebug();
        this.updateToolHotkeys();
    },

    updateToolHotkeys() {
        const hk = AppConfig.hotkeys;
        const map = {
            '[data-tool="move"] kbd':              codeToLabel(hk.toolMove),
            '[data-tool="removebg"] kbd':           codeToLabel(hk.toolRemoveBg),
            '[data-tool="autoframe"] kbd':          codeToLabel(hk.toolAutoFrame),
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
            tokenDropzone.onclick = e => {
                e.stopPropagation();
                this.pickImageViaServer();
            };
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
                if (e.target.files.length > 0) {
                    TokenCanvas.loadImage(e.target.files[0]);
                }
                tokenFileInput.value = '';
            };
        }
        this.setupNavButtons();
        const tokenFileNameInput = $('tokenFileName');
        if (tokenFileNameInput) {
            tokenFileNameInput.oninput = e => {
                state.tokenFileName = e.target.value || 'token';
                this.updateDropzoneLabel();
            };
        }
    },

    async pickImageViaServer() {
        try {
            const res = await fetch('/pick_image_to_open');
            const data = await res.json();
            if (data.cancelled) return;

            const byteString = atob(data.data);
            const ab = new ArrayBuffer(byteString.length);
            const ia = new Uint8Array(ab);
            for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
            const blob = new Blob([ab], { type: data.mime });
            const fileName = data.path.split(/[\\/]/).pop();
            const file = new File([blob], fileName, { type: data.mime });
            TokenCanvas.loadImage(file, data.path);
        } catch (err) {
            toast('Ошибка: ' + err.message, true);
        }
    },

    setupNavButtons() {
        const prevBtn = $('navPrev');
        const nextBtn = $('navNext');
        if (prevBtn) prevBtn.onclick = () => this.navigateTo(-1);
        if (nextBtn) nextBtn.onclick = () => this.navigateTo(1);
    },

    updateDropzoneLabel() {
        const label = $('dropzoneLabel');
        const dz = $('tokenDropzone');
        if (!label || !dz) return;
        if (state.userImage) {
            label.textContent = state.tokenFileName || 'token';
            dz.classList.add('has-image');
        } else {
            label.textContent = 'Нажмите или перетащите';
            dz.classList.remove('has-image');
        }
    },

    updateNavState() {
        this.updateDropzoneLabel();

        const el = $('navArrows');
        const infoEl = $('navInfo');
        if (!el || !infoEl) return;

        if (!state.currentFilePath) {
            el.style.display = 'none';
            return;
        }

        fetch('/list_images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: state.currentFilePath })
        })
        .then(r => r.json())
        .then(data => {
            if (data.error || !data.files || data.total <= 1) {
                el.style.display = 'none';
                state.imageFileList = [];
                state.imageFileIndex = -1;
                return;
            }
            state.imageFileList = data.files;
            state.imageFileIndex = data.currentIndex;
            el.style.display = 'flex';
            this.updateNavFileName();
        })
        .catch(() => {
            el.style.display = 'none';
        });
    },

    updateNavFileName() {
        const infoEl = $('navInfo');
        if (!infoEl) return;
        if (state.imageFileIndex >= 0 && state.imageFileIndex < state.imageFileList.length) {
            infoEl.textContent = (state.imageFileIndex + 1) + ' / ' + state.imageFileList.length;
        } else {
            infoEl.textContent = '';
        }
    },

    navigateTo(direction) {
        const newIndex = state.imageFileIndex + direction;
        if (newIndex < 0 || newIndex >= state.imageFileList.length) return;
        const newPath = state.imageFileList[newIndex];
        if (!newPath) return;
        state.imageFileIndex = newIndex;
        TokenCanvas.loadImageByPath(newPath);
    },

    setupToolButtons() {
        document.querySelectorAll('.tool-card-top[data-tool]').forEach(btn => {
            btn.onclick = () => {
                const tool = btn.dataset.tool;
                if (tool === 'removebg') { this.handleRemoveBackground(btn); return; }
                if (tool === 'autoframe') { this.handleAutoFrame(btn); return; }
                document.querySelectorAll('.tool-card-top[data-tool]').forEach(b => {
                    if (b.dataset.tool !== 'removebg' && b.dataset.tool !== 'autoframe') b.classList.remove('active');
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

        const applyFaceBtn = $('applyFaceBtn');
        if (applyFaceBtn) {
            applyFaceBtn.onclick = () => this.handleApplyFace();
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

    async handleAutoFrame(btn) {
        if (!state.userImageOriginal && !state.userImage) {
            toast('Сначала загрузите изображение', true); return;
        }

        toast('Определение лица...');
        btn.disabled = true;
        var kbd = btn.querySelector('kbd');
        var kbdText = kbd ? kbd.outerHTML : '';
        btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div><span>Обработка...</span>' + kbdText;

        try {
            var img = state.userImageOriginal || state.userImage;
            var tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            tempCanvas.getContext('2d').drawImage(img, 0, 0);
            var blob = await new Promise(function(resolve) { tempCanvas.toBlob(resolve, 'image/png'); });

            var fdDetect = new FormData();
            fdDetect.append('image', blob, 'image.png');
            var detectRes = await fetch('/detect_face', { method: 'POST', body: fdDetect });
            if (detectRes.ok) {
                var detectData = await detectRes.json();
                state.faceOverlay = {
                    cx: detectData.face_cx,
                    cy: detectData.face_cy,
                    size: detectData.face_size,
                    imageWidth: detectData.image_width,
                    imageHeight: detectData.image_height,
                    detectionMethod: detectData.detection_method
                };
                TokenEditor.showFaceDebug(true);
                var applyBtn = $('applyFaceBtn');
                if (applyBtn) applyBtn.style.display = '';
                var methodNames = { mediapipe: 'MediaPipe', dnn: 'OpenCV DNN', haar: 'Haar', heuristic: 'эвристика' };
                var methodLabel = methodNames[detectData.detection_method] || detectData.detection_method;
                toast('Лицо найдено (' + methodLabel + '). Нажмите "Применить" или J для автопозиционирования');
            } else {
                toast('Не удалось определить лицо', true);
            }
            TokenCanvas.render();
        } catch (err) {
            state.faceOverlay = null;
            toast('Ошибка: ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg><span>Авто-токен</span>' + kbdText;
        }
    },

    handleApplyFace() {
        var fo = state.faceOverlay;
        if (!fo || !state.userImage) {
            toast('Сначала найдите лицо через "Авто-токен"', true); return;
        }
        state._lastFaceOverlay = { cx: fo.cx, cy: fo.cy, size: fo.size, detectionMethod: fo.detectionMethod };
        TokenEditor._setCanvasFaceTarget(fo, { cx: 3119, cy: 2179, size: 476 });
        state.faceOverlay = null;
        TokenEditor.showFaceDebug(false);
        TokenEditor.hideApplyBtn();
        TokenCanvas.updateScaleUI();
        TokenCanvas.updateRotationUI();
        TokenCanvas.resetView();
        TokenCanvas.invalidateEffectsCache();
        TokenCanvas.render();
        TokenHistory.save();
        toast('Позиция применена');
    },

    hideApplyBtn() {
        var btn = $('applyFaceBtn');
        if (btn) btn.style.display = 'none';
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
                toast('Трансформация сброшена');
            };
        }
    },

    // Получить положение лица на канвасе (пиксели canvas)
    // с учётом калибровочного оверлея (fo) + текущего состояния канваса
    _getCanvasFacePos(fo) {
        if (!fo || !state.userImage) return null;
        var img = state.userImage;
        var size = TokenCanvas.internalSize;
        var scale = size / 1024;
        return {
            cx: size / 2 + state.imageX * scale + (fo.cx - img.width / 2) * state.imageScale * scale,
            cy: size / 2 + state.imageY * scale + (fo.cy - img.height / 2) * state.imageScale * scale,
            size: fo.size * state.imageScale * scale
        };
    },

    // Установить позицию изображения так, чтобы лицо из fo оказалось
    // в target-координатах на канвасе
    _setCanvasFaceTarget(fo, target) {
        if (!fo || !state.userImage || !target) return;
        var img = state.userImage;
        var size = TokenCanvas.internalSize;
        var scale = size / 1024;
        state.imageScale = target.size / (fo.size * scale);
        state.imageX = (target.cx - size / 2) / scale - (fo.cx - img.width / 2) * state.imageScale;
        state.imageY = (target.cy - size / 2) / scale - (fo.cy - img.height / 2) * state.imageScale;
        state.imageRotation = 0;
    },

    _updateCanvasDisplay(fo) {
        var cxD = $('canvasXDisplay');
        var cyD = $('canvasYDisplay');
        var scD = $('canvasScaleDisplay');
        var pos = fo ? this._getCanvasFacePos(fo) : null;
        if (pos) {
            if (cxD) cxD.textContent = pos.cx.toFixed(1);
            if (cyD) cyD.textContent = pos.cy.toFixed(1);
            if (scD) scD.textContent = pos.size.toFixed(1);
        } else {
            if (cxD) cxD.textContent = '—';
            if (cyD) cyD.textContent = '—';
            if (scD) scD.textContent = '—';
        }
    },

    setupFaceDebug() {
        function updateFromSliders() {
            var fo = state.faceOverlay;
            if (!fo) return;
            fo.cx = parseInt($('faceCxSlider').value);
            fo.cy = parseInt($('faceCySlider').value);
            fo.size = parseInt($('faceSizeSlider').value);
            var cxI = $('faceCxInput'), cyI = $('faceCyInput'), szI = $('faceSizeInput');
            if (cxI) cxI.value = fo.cx;
            if (cyI) cyI.value = fo.cy;
            if (szI) szI.value = fo.size;
            TokenEditor._updateCanvasDisplay(fo);
            TokenCanvas.render();
        }

        ['Cx', 'Cy', 'Size'].forEach(function(prop) {
            var slider = $('face' + prop + 'Slider');
            var input = $('face' + prop + 'Input');
            if (slider) slider.oninput = updateFromSliders;
            if (input) {
                input.onchange = function() {
                    var fo = state.faceOverlay;
                    if (!fo) return;
                    var max = parseInt(input.max);
                    var min = parseInt(input.min);
                    var val = clamp(parseInt(input.value) || 0, min, max);
                    input.value = val;
                    var s = $('face' + prop + 'Slider');
                    if (s) s.value = val;
                    if (prop === 'Cx') fo.cx = val;
                    else if (prop === 'Cy') fo.cy = val;
                    else fo.size = val;
                    TokenEditor._updateCanvasDisplay(fo);
                    TokenCanvas.render();
                };
            }
        });

        var copyBtn = $('copyCanvasCoords');
        if (copyBtn) {
            copyBtn.onclick = function() {
                var fo = state.faceOverlay || state._lastFaceOverlay;
                if (!fo) { toast('Нет данных о лице. Сначала нажмите "Авто-токен"', true); return; }
                var pos = TokenEditor._getCanvasFacePos(fo);
                if (!pos) { toast('Ошибка вычисления позиции', true); return; }
                var text = JSON.stringify({ canvasCx: Math.round(pos.cx), canvasCy: Math.round(pos.cy), canvasSize: Math.round(pos.size) });
                navigator.clipboard.writeText(text).then(function() {
                    toast('Позиция лица на канвасе: ' + text);
                }).catch(function() {
                    toast('Ошибка копирования', true);
                });
            };
        }

        var pasteBtn = $('pasteCanvasBtn');
        var pasteInput = $('pasteCanvasInput');
        if (pasteBtn && pasteInput) {
            function applyPaste() {
                try {
                    var data = JSON.parse(pasteInput.value);
                    if (typeof data.canvasCx !== 'number' || typeof data.canvasCy !== 'number' || typeof data.canvasSize !== 'number') {
                        toast('Неверный формат. Нужно: {"canvasCx":...,"canvasCy":...,"canvasSize":...}', true);
                        return;
                    }
                    var target = { cx: data.canvasCx, cy: data.canvasCy, size: data.canvasSize };
                    var fo = state.faceOverlay;
                    if (!fo) {
                        // Если оверлея нет — сначала детектируем лицо
                        toast('Сначала нажмите "Авто-токен" для детекции лица', true);
                        return;
                    }
                    TokenEditor._setCanvasFaceTarget(fo, target);
                    state.faceOverlay = null;
                    TokenEditor.showFaceDebug(false);
                    var applyBtn = $('applyFaceBtn');
                    if (applyBtn) applyBtn.style.display = 'none';
                    TokenCanvas.updateScaleUI();
                    TokenCanvas.updateRotationUI();
                    TokenCanvas.resetView();
                    TokenCanvas.invalidateEffectsCache();
                    TokenCanvas.render();
                    TokenHistory.save();
                    toast('Позиция лица применена');
                } catch (e) {
                    toast('Ошибка: ' + e.message, true);
                }
            }
            pasteBtn.onclick = applyPaste;
            pasteInput.onkeydown = function(e) {
                if (e.key === 'Enter') applyPaste();
            };
        }

        var clearBtn = $('clearFaceOverlay');
        if (clearBtn) {
            clearBtn.onclick = function() {
                state.faceOverlay = null;
                var sec = $('sec-facedebug');
                if (sec) sec.style.display = 'none';
                var applyBtn = $('applyFaceBtn');
                if (applyBtn) applyBtn.style.display = 'none';
                TokenCanvas.render();
            };
        }
    },

    showFaceDebug(show) {
        var sec = $('sec-facedebug');
        if (!sec) return;
        sec.style.display = show ? '' : 'none';
        if (show && state.faceOverlay) {
            var fo = state.faceOverlay;
            var cxS = $('faceCxSlider'), cxI = $('faceCxInput');
            var cyS = $('faceCySlider'), cyI = $('faceCyInput');
            var szS = $('faceSizeSlider'), szI = $('faceSizeInput');
            if (cxS) cxS.max = Math.max(state.userImage ? state.userImage.width : 2048, 2048);
            if (cxS) cxS.value = fo.cx;
            if (cxI) { cxI.max = cxS.max; cxI.value = fo.cx; }
            if (cyS) cyS.max = Math.max(state.userImage ? state.userImage.height : 2048, 2048);
            if (cyS) cyS.value = fo.cy;
            if (cyI) { cyI.max = cyS.max; cyI.value = fo.cy; }
            if (szS) { szS.value = fo.size; }
            if (szI) { szI.value = fo.size; }
            var methodDisp = $('detectionMethodDisplay');
            if (methodDisp) {
                var names = { mediapipe: 'MediaPipe', dnn: 'OpenCV DNN', haar: 'Haar', heuristic: 'эвристика' };
                methodDisp.textContent = names[fo.detectionMethod] || fo.detectionMethod || '—';
            }
            this._updateCanvasDisplay(fo);
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
                TokenCanvas.invalidateAllCaches();
                TokenCanvas.render();
            };
        }
        this._setupDropShadowSettings();
        this._setupColorCorrectionSettings();
        this._setupExampleOverlay();

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
                TokenCanvas.invalidateAllCaches();
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
                TokenCanvas.invalidateAllCaches();
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

        const lastQuickSave = AppConfig.lastFolders.quickSave;
        if (lastQuickSave) {
            state.quickSaveFolder = lastQuickSave;
            const nameEl = $('quickSaveFolderName');
            if (nameEl) nameEl.textContent = lastQuickSave.split(/[\\/]/).pop() || lastQuickSave;
        }
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
        if (!isInput && code === 'KeyJ' && state.faceOverlay) { e.preventDefault(); this.handleApplyFace(); return; }
        if (!isInput && e.ctrlKey && code === 'ArrowLeft' && state.imageFileList.length > 1) { e.preventDefault(); this.navigateTo(-1); }
        if (!isInput && e.ctrlKey && code === 'ArrowRight' && state.imageFileList.length > 1) { e.preventDefault(); this.navigateTo(1); }
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

    _loadDefaultExample(fileNameEl) {
        fetch('/example')
            .then(r => {
                if (!r.ok) throw new Error('not found');
                return r.blob();
            })
            .then(blob => {
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    state.exampleImage = img;
                    if (fileNameEl) fileNameEl.textContent = 'example.png';
                    TokenCanvas.render();
                };
                img.onerror = () => URL.revokeObjectURL(url);
                img.src = url;
            })
            .catch(() => {
                toast('Файл example.png не найден', true);
            });
    },

    _setupExampleOverlay() {
        const cfg = AppConfig.example;

        const check = $('exampleCheck');
        const settings = $('exampleSettings');
        const opacitySlider = $('exampleOpacitySlider');
        const opacityVal = $('exampleOpacityVal');
        const scaleSelect = $('exampleScaleSelect');
        const fileInput = $('exampleFileInput');
        const fileBtn = $('exampleFileBtn');
        const fileName = $('exampleFileName');

        state.exampleEnabled = cfg.enabled;
        state.exampleOpacity = cfg.opacity / 100;
        state.exampleScaleMode = cfg.scaleMode;

        if (check) check.checked = cfg.enabled;
        if (settings) settings.style.display = cfg.enabled ? 'flex' : 'none';
        if (opacitySlider) opacitySlider.value = cfg.opacity;
        if (opacityVal) opacityVal.textContent = cfg.opacity;
        if (scaleSelect) scaleSelect.value = cfg.scaleMode;

        if (cfg.enabled && !state.exampleImage) {
            this._loadDefaultExample(fileName);
        }

        const applyOpacity = val => {
            val = clamp(parseInt(val), 0, 100);
            state.exampleOpacity = val / 100;
            if (opacitySlider) opacitySlider.value = val;
            if (opacityVal) opacityVal.textContent = val;
            AppConfig.setExample('opacity', val);
            TokenCanvas.render();
        };

        if (check) {
            check.onchange = e => {
                state.exampleEnabled = e.target.checked;
                if (settings) settings.style.display = state.exampleEnabled ? 'flex' : 'none';
                if (state.exampleEnabled && !state.exampleImage) {
                    this._loadDefaultExample(fileName);
                }
                AppConfig.setExample('enabled', state.exampleEnabled);
                TokenCanvas.render();
            };
        }

        if (opacitySlider) {
            opacitySlider.oninput = e => applyOpacity(e.target.value);
            opacitySlider.addEventListener('wheel', ev => {
                ev.preventDefault();
                opacitySlider.value = clamp(parseInt(opacitySlider.value) + (ev.deltaY < 0 ? 1 : -1), 0, 100);
                opacitySlider.dispatchEvent(new Event('input'));
            }, { passive: false });
        }

        if (scaleSelect) {
            scaleSelect.onchange = e => {
                state.exampleScaleMode = parseInt(e.target.value);
                AppConfig.setExample('scaleMode', state.exampleScaleMode);
                TokenCanvas.render();
            };
        }

        if (fileBtn && fileInput) {
            fileBtn.onclick = () => fileInput.click();
            fileInput.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const url = URL.createObjectURL(file);
                const img = new Image();
                img.onload = () => {
                    if (state._exampleCustomUrl) URL.revokeObjectURL(state._exampleCustomUrl);
                    state._exampleCustomUrl = url;
                    state.exampleImage = img;
                    if (fileName) fileName.textContent = file.name;
                    TokenCanvas.render();
                };
                img.onerror = () => { URL.revokeObjectURL(url); toast('Не удалось загрузить файл', true); };
                img.src = url;
                fileInput.value = '';
            };
        }

        const resetBtn = $('exampleResetBtn');
        if (resetBtn) {
            resetBtn.onclick = () => {
                if (state._exampleCustomUrl) {
                    URL.revokeObjectURL(state._exampleCustomUrl);
                    state._exampleCustomUrl = null;
                }
                state.exampleImage = null;
                if (fileName) fileName.textContent = 'example.png';
                this._loadDefaultExample(fileName);
            };
        }
    },

    async _pickSaveFolder(nameEl) {
        const path = await pickFolder();
        if (!path) return;
        state.quickSaveFolder = path;
        AppConfig.setLastFolder('quickSave', path);
        if (nameEl) nameEl.textContent = path.split(/[\\/]/).pop() || path;
        toast('Папка выбрана: ' + path);

    }
};
