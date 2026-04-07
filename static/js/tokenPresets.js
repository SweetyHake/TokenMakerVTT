const TokenPresets = {
    _presetOverlayTimer: null,
    _presetOverlayPhase: 0,
    _presetOverlayRaf: null,

    buildProtectionCanvasFromImg(img, internalSize) {
        const maskDisplaySize = CONFIG.SCALE_SIZES[1];
        const offset = Math.round((internalSize - maskDisplaySize) / 2);
        const srcW = img.naturalWidth || img.width;
        const srcH = img.naturalHeight || img.height;

        const scaledMask = document.createElement('canvas');
        scaledMask.width = maskDisplaySize;
        scaledMask.height = maskDisplaySize;
        const sCtx = scaledMask.getContext('2d');
        sCtx.drawImage(img, 0, 0, srcW, srcH, 0, 0, maskDisplaySize, maskDisplaySize);
        const srcData = sCtx.getImageData(0, 0, maskDisplaySize, maskDisplaySize);
        const sd = srcData.data;

        const protCanvas = document.createElement('canvas');
        protCanvas.width = internalSize;
        protCanvas.height = internalSize;
        const pCtx = protCanvas.getContext('2d');
        const protData = pCtx.createImageData(internalSize, internalSize);
        const pd = protData.data;

        for (let y = 0; y < internalSize; y++) {
            for (let x = 0; x < internalSize; x++) {
                const mx = x - offset;
                const my = y - offset;
                const oi = (y * internalSize + x) * 4;
                if (mx < 0 || my < 0 || mx >= maskDisplaySize || my >= maskDisplaySize) {
                    pd[oi] = 0; pd[oi+1] = 0; pd[oi+2] = 0; pd[oi+3] = 0;
                    continue;
                }
                const si = (my * maskDisplaySize + mx) * 4;
                const a = sd[si + 3];
                const brightness = (sd[si] + sd[si+1] + sd[si+2]) / 3;
                const isProtected = a > 16 && brightness < 220;
                pd[oi] = 255; pd[oi+1] = 255; pd[oi+2] = 255;
                pd[oi+3] = isProtected ? 255 : 0;
            }
        }

        pCtx.putImageData(protData, 0, 0);
        return protCanvas;
    },

    processMaskImage(img, size) {
        if (!size) size = TokenCanvas.internalSize;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const imgData = ctx.getImageData(0, 0, size, size);
        const result = ctx.createImageData(size, size);
        const d = imgData.data;
        const r = result.data;
        for (let i = 0; i < d.length; i += 4) {
            const a = d[i+3];
            const brightness = (d[i] + d[i+1] + d[i+2]) / 3;
            const isProtected = a > 16 && brightness < 220;
            r[i] = 255; r[i+1] = 255; r[i+2] = 255;
            r[i+3] = isProtected ? 0 : 255;
        }
        ctx.putImageData(result, 0, 0);
        return canvas;
    },

    loadProtectionMask() {
        fetch('/mask').then(r => r.blob()).then(blob => {
            const img = new Image();
            const maskUrl = urlManager.create(blob, 'protection-mask');
            img.onload = () => {
                state._rawProtectionMaskImg = img;
                this._rebuildErasableCanvas();
            };
            img.src = maskUrl;
        }).catch(() => {
            state._rawProtectionMaskImg = null;
            this._rebuildErasableCanvas();
        });
    },

    reloadProtectionMaskForScale() {
        this._rebuildErasableCanvas();
        TokenCanvas._imageBrushCache = null;
    },

    _rebuildErasableCanvas() {
        const img = state._rawProtectionMaskImg;
        const internalSize = TokenCanvas.internalSize;
        if (!img) {
            state.erasableCanvas = null;
            state.protectionMask = null;
            return;
        }
        const protCanvas = this.buildProtectionCanvasFromImg(img, internalSize);
        state.protectionMask = protCanvas;
        state.erasableCanvas = protCanvas;
    },

    loadPresets() {
        fetch('/presets_list')
            .then(r => r.json())
            .then(presets => {
                state.eraserPresets = [];
                const loads = presets.map((preset, index) => {
                    return fetch(`/preset_file/${encodeURIComponent(preset.file)}`)
                        .then(r => r.blob())
                        .then(blob => {
                            const img = new Image();
                            const url = URL.createObjectURL(blob);
                            return new Promise(resolve => {
                                img.onload = () => {
                                    state.eraserPresets[index] = {
                                        canvas: this.processMaskImage(img, TokenCanvas.internalSize),
                                        rawImg: img,
                                        name: preset.name,
                                        file: preset.file
                                    };
                                    resolve();
                                };
                                img.onerror = () => resolve();
                                img.src = url;
                            });
                        })
                        .catch(() => {});
                });
                Promise.all(loads).then(() => this.updateButtons());
            })
            .catch(() => {});
    },

    _buildPresetOverlay(presetIndex) {
        const preset = state.eraserPresets[presetIndex];
        if (!preset || !preset.canvas) return null;

        const internalSize = TokenCanvas.internalSize;
        const overlay = document.createElement('canvas');
        overlay.width = internalSize;
        overlay.height = internalSize;
        const ctx = overlay.getContext('2d');

        const srcData = preset.canvas.getContext('2d').getImageData(0, 0, internalSize, internalSize);
        const outData = ctx.createImageData(internalSize, internalSize);
        const sd = srcData.data;
        const od = outData.data;

        for (let i = 0; i < sd.length; i += 4) {
            const isErased = sd[i+3] < 128;
            od[i]   = isErased ? 255 : 0;
            od[i+1] = isErased ? 80  : 0;
            od[i+2] = isErased ? 160 : 0;
            od[i+3] = isErased ? 200 : 0;
        }

        ctx.putImageData(outData, 0, 0);
        return overlay;
    },

    showPresetOverlay(presetIndex) {
        state.presetOverlayCanvas = this._buildPresetOverlay(presetIndex);
        state.presetOverlayActive = true;
        state._presetOverlayAlpha = 0.6;
        this._presetOverlayPhase = 0;
        if (this._presetOverlayRaf) {
            cancelAnimationFrame(this._presetOverlayRaf);
            this._presetOverlayRaf = null;
        }
        this._animateOverlay();
    },

    hidePresetOverlay() {
        state.presetOverlayActive = false;
        state.presetOverlayCanvas = null;
        state._presetOverlayAlpha = 0.6;
        if (this._presetOverlayRaf) {
            cancelAnimationFrame(this._presetOverlayRaf);
            this._presetOverlayRaf = null;
        }
        TokenCanvas.render();
    },

    _animateOverlay() {
        if (!state.presetOverlayActive) return;
        this._presetOverlayPhase += 0.004;
        state._presetOverlayAlpha = 0.35 + Math.sin(this._presetOverlayPhase * Math.PI * 2) * 0.3;
        TokenCanvas.render();
        this._presetOverlayRaf = requestAnimationFrame(() => this._animateOverlay());
    },

    updateButtons() {
        const container = $('presetButtons');
        if (!container) return;
        container.innerHTML = '';

        if (state.eraserPresets.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'font-size:11px;color:var(--text-muted);padding:4px 0;';
            empty.textContent = 'Нет пресетов в папке presets/';
            container.appendChild(empty);
            return;
        }

        state.eraserPresets.forEach((preset, index) => {
            if (!preset) return;
            const btn = document.createElement('button');
            btn.className = 'preset-btn' + (state.currentPreset === index ? ' active' : '');
            btn.textContent = preset.name;
            btn.onclick = () => this.apply(index);
            btn.addEventListener('mouseenter', () => this.showPresetOverlay(index));
            btn.addEventListener('mouseleave', () => this.hidePresetOverlay());
            container.appendChild(btn);
        });
    },

    apply(index) {
        const preset = state.eraserPresets[index];
        if (!preset || !preset.canvas || !state.maskCanvas) return;

        this.hidePresetOverlay();

        const maskCtx = state.maskCanvas.getContext('2d');
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.fillStyle = 'white';
        maskCtx.fillRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
        maskCtx.globalCompositeOperation = 'destination-in';
        maskCtx.drawImage(preset.canvas, 0, 0);
        maskCtx.globalCompositeOperation = 'source-over';

        state.currentPreset = index;
        this.updateButtons();
        TokenHistory.save();
        TokenCanvas.render();
        toast(`Пресет "${preset.name}" применён`);

        const pinkBtn = document.querySelector('.eraser-mode-btn[data-mode="pink"]');
        if (pinkBtn) pinkBtn.click();
    },

    loadRings() {
        return fetch('/rings_list')
            .then(r => r.json())
            .then(rings => {
                const container = $('ringSelectorList');
                if (!container) return;
                container.innerHTML = '';
                if (rings.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'ring-empty';
                    empty.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">Файлы не найдены в папке token_rings</span>`;
                    container.appendChild(empty);
                    return;
                }
                rings.forEach((ring, index) => {
                    const item = document.createElement('div');
                    item.className = 'ring-item';
                    if (index === 0) item.classList.add('active');
                    item.dataset.ringName = ring.name;
                    const img = document.createElement('img');
                    img.src = `/ring_file/${encodeURIComponent(ring.file)}`;
                    img.alt = ring.name;
                    const label = document.createElement('span');
                    label.textContent = ring.name;
                    item.appendChild(img);
                    item.appendChild(label);
                    item.onclick = () => {
                        document.querySelectorAll('.ring-item, .ring-item-none').forEach(i => i.classList.remove('active'));
                        item.classList.add('active');
                        this.loadSingleRing(ring.file);
                    };
                    container.appendChild(item);
                    if (index === 0) this.loadSingleRing(ring.file);
                });
            })
            .catch(() => {});
    },

    loadSingleRing(filename) {
        fetch(`/ring_file/${encodeURIComponent(filename)}`)
            .then(r => r.blob())
            .then(blob => {
                const img = new Image();
                const url = URL.createObjectURL(blob);
                img.onload = () => {
                    state.ringImages = { 2048: img, 1024: img, 512: img };
                    TokenCanvas.render();
                };
                img.src = url;
            })
            .catch(() => {});
    },

    loadRingForSize(size) {
        return new Promise((resolve) => {
            fetch(`/ring?size=${size}`).then(r => r.blob()).then(blob => {
                const img = new Image();
                const url = URL.createObjectURL(blob);
                img.onload = () => { state.ringImages[size] = img; resolve(img); };
                img.onerror = () => resolve(null);
                img.src = url;
            }).catch(() => resolve(null));
        });
    },

    loadExample() {}
};
