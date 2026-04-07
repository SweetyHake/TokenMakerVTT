const TokenPresets = {
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

                pd[oi]   = 255;
                pd[oi+1] = 255;
                pd[oi+2] = 255;
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
            const c = document.createElement('canvas');
            c.width = internalSize;
            c.height = internalSize;
            const ctx = c.getContext('2d');
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, internalSize, internalSize);
            state.erasableCanvas = null;
            state.protectionMask = null;
            return;
        }

        const protCanvas = this.buildProtectionCanvasFromImg(img, internalSize);
        state.protectionMask = protCanvas;
        state.erasableCanvas = protCanvas;
    },

    loadPresets() {
        const presetNames = ['preset1', 'preset2', 'preset3'];
        presetNames.forEach((name, index) => {
            fetch(`/preset?name=${name}`).then(r => {
                if (r.ok) return r.blob();
                throw new Error('Not found');
            }).then(blob => {
                const img = new Image();
                const url = URL.createObjectURL(blob);
                img.onload = () => {
                    state.eraserPresets[index] = this.processMaskImage(img, TokenCanvas.internalSize);
                    this.updateButtons();
                };
                img.src = url;
            }).catch(() => {
                state.eraserPresets[index] = null;
                this.updateButtons();
            });
        });
    },

    updateButtons() {
        const container = $('presetButtons');
        if (!container) return;
        container.innerHTML = '';
        state.eraserPresets.forEach((preset, index) => {
            if (preset) {
                const btn = document.createElement('button');
                btn.className = 'preset-btn' + (state.currentPreset === index ? ' active' : '');
                btn.textContent = `Пресет ${index + 1}`;
                btn.onclick = () => this.apply(index);
                container.appendChild(btn);
            }
        });
    },

    apply(index) {
        if (!state.eraserPresets[index] || !state.maskCanvas) return;
        const maskCtx = state.maskCanvas.getContext('2d');
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.fillStyle = 'white';
        maskCtx.fillRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
        maskCtx.globalCompositeOperation = 'destination-in';
        maskCtx.drawImage(state.eraserPresets[index], 0, 0);
        maskCtx.globalCompositeOperation = 'source-over';
        state.currentPreset = index;
        this.updateButtons();
        TokenHistory.save();
        TokenCanvas.render();
        toast(`Пресет ${index + 1} применён`);
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
