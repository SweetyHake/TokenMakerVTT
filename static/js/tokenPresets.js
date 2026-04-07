const TokenPresets = {
    processMaskImage(img, size) {
        if (!size) size = TokenCanvas.internalSize;

        const src = document.createElement('canvas');
        src.width = img.naturalWidth || img.width;
        src.height = img.naturalHeight || img.height;
        const srcCtx = src.getContext('2d');
        srcCtx.drawImage(img, 0, 0);
        const srcData = srcCtx.getImageData(0, 0, src.width, src.height);
        const sd = srcData.data;

        const out = document.createElement('canvas');
        out.width = size;
        out.height = size;
        const outCtx = out.getContext('2d');

        const result = outCtx.createImageData(size, size);
        const rd = result.data;

        const scaleX = src.width / size;
        const scaleY = src.height / size;

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const sx = Math.min(Math.floor(x * scaleX), src.width - 1);
                const sy = Math.min(Math.floor(y * scaleY), src.height - 1);
                const si = (sy * src.width + sx) * 4;

                const alpha = sd[si + 3];
                const r = sd[si];
                const g = sd[si + 1];
                const b = sd[si + 2];
                const brightness = (r + g + b) / 3;

                const isProtected = alpha > 16 && brightness < 220;

                const oi = (y * size + x) * 4;
                rd[oi]     = 255;
                rd[oi + 1] = 255;
                rd[oi + 2] = 255;
                rd[oi + 3] = isProtected ? 0 : 255;
            }
        }

        outCtx.putImageData(result, 0, 0);
        return out;
    },

    loadProtectionMask() {
        fetch('/mask').then(r => r.blob()).then(blob => {
            const img = new Image();
            const maskUrl = urlManager.create(blob, 'protection-mask');
            img.onload = () => {
                state._rawProtectionMaskImg = img;
                this._buildErasableCanvas();
            };
            img.src = maskUrl;
        }).catch(() => {});
    },

    reloadProtectionMaskForScale() {
        this._buildErasableCanvas();
        TokenCanvas._imageBrushCache = null;
    },

    _buildErasableCanvas() {
        const img = state._rawProtectionMaskImg;
        const internalSize = TokenCanvas.internalSize;

        const erasable = document.createElement('canvas');
        erasable.width = internalSize;
        erasable.height = internalSize;
        const ctx = erasable.getContext('2d');

        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, internalSize, internalSize);

        if (img) {
            const maskDisplaySize = CONFIG.SCALE_SIZES[1];
            const maskOffset = Math.round((internalSize - maskDisplaySize) / 2);
            const processed = this.processMaskImage(img, maskDisplaySize);
            ctx.drawImage(processed, maskOffset, maskOffset);
        }

        state.protectionMask = erasable;
        state.erasableCanvas = erasable;
        state._erasableMaskOffset = img ? Math.round((internalSize - CONFIG.SCALE_SIZES[1]) / 2) : 0;
        state._erasableMaskSize = img ? CONFIG.SCALE_SIZES[1] : internalSize;

        this._buildImageMaskProtection(img);
    },
    
    _buildImageMaskProtection(img) {
        if (!state.userImage || !img) {
            state.imageMaskProtection = null;
            return;
        }

        const imgW = state.userImage.width;
        const imgH = state.userImage.height;
        const internalSize = TokenCanvas.internalSize;
        const scale = internalSize / 1024;
        const effectiveScale = state.imageScale * scale;

        const cx = internalSize / 2 + state.imageX * scale;
        const cy = internalSize / 2 + state.imageY * scale;
        const maskDisplaySize = CONFIG.SCALE_SIZES[1];
        const maskOffset = Math.round((internalSize - maskDisplaySize) / 2);

        const protection = document.createElement('canvas');
        protection.width = imgW;
        protection.height = imgH;
        const ctx = protection.getContext('2d');

        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, imgW, imgH);

        const processedMask = this.processMaskImage(img, maskDisplaySize);

        const mCanvas = document.createElement('canvas');
        mCanvas.width = imgW;
        mCanvas.height = imgH;
        const mCtx = mCanvas.getContext('2d');

        mCtx.save();
        mCtx.translate(imgW / 2, imgH / 2);
        mCtx.rotate(-state.imageRotation * Math.PI / 180);
        mCtx.scale(1 / effectiveScale, 1 / effectiveScale);
        mCtx.translate(-cx, -cy);
        mCtx.drawImage(processedMask, maskOffset, maskOffset);
        mCtx.restore();

        const mData = mCtx.getImageData(0, 0, imgW, imgH);
        const pData = ctx.getImageData(0, 0, imgW, imgH);
        const md = mData.data;
        const pd = pData.data;

        for (let i = 0; i < md.length; i += 4) {
            const isErasable = md[i + 3] > 128;
            pd[i]     = 255;
            pd[i + 1] = 255;
            pd[i + 2] = 255;
            pd[i + 3] = isErasable ? 255 : 0;
        }

        ctx.putImageData(pData, 0, 0);
        state.imageMaskProtection = protection;
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

                    if (index === 0) {
                        this.loadSingleRing(ring.file);
                    }
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
                img.onload = () => {
                    state.ringImages[size] = img;
                    resolve(img);
                };
                img.onerror = () => resolve(null);
                img.src = url;
            }).catch(() => resolve(null));
        });
    },

    loadExample() {}
};
