const PortraitGenerator = {
    canvas: null,
    ctx: null,
    SIZE: 2048,
    DISPLAY_SIZE: 480,

    imageX: 0,
    imageY: 0,
    imageScale: 1,
    imageRotation: 0,

    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartImgX: 0,
    dragStartImgY: 0,

    saveFolder: null,

    init() {
        this.canvas = $('portraitCanvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.canvas.width = this.SIZE;
        this.canvas.height = this.SIZE;

        this._applyDisplaySize();
        this.setupEvents();
        this.setupControls();
        this.render();
    },

    _applyDisplaySize() {
        const wrap = this.canvas.parentElement;
        if (!wrap) return;
        const availW = wrap.clientWidth || this.DISPLAY_SIZE;
        const side = Math.min(availW, this.DISPLAY_SIZE);
        this.canvas.style.width = side + 'px';
        this.canvas.style.height = side + 'px';
    },

    setupControls() {
        const folderBtn = $('portraitFolderBtn');
        if (folderBtn) folderBtn.onclick = () => this.pickFolder();

        const saveBtn = $('portraitSaveBtn');
        if (saveBtn) saveBtn.onclick = () => this.save();

        const resetBtn = $('portraitResetBtn');
        if (resetBtn) resetBtn.onclick = () => this.resetTransform();

        const scaleSlider = $('portraitScaleSlider');
        const scaleInput = $('portraitScaleInput');
        if (scaleSlider) {
            scaleSlider.oninput = e => {
                this.imageScale = parseInt(e.target.value) / 100;
                if (scaleInput) scaleInput.value = e.target.value;
                this.render();
            };
            scaleSlider.addEventListener('wheel', ev => {
                ev.preventDefault();
                const step = 1;
                scaleSlider.value = clamp(parseInt(scaleSlider.value) + (ev.deltaY < 0 ? step : -step), 10, 500);
                scaleSlider.dispatchEvent(new Event('input'));
            }, { passive: false });
        }
        if (scaleInput) {
            scaleInput.onchange = e => {
                const v = clamp(parseInt(e.target.value) || 100, 10, 500);
                this.imageScale = v / 100;
                if (scaleSlider) scaleSlider.value = v;
                scaleInput.value = v;
                this.render();
            };
        }

        const rotSlider = $('portraitRotationSlider');
        const rotInput = $('portraitRotationInput');
        if (rotSlider) {
            rotSlider.oninput = e => {
                this.imageRotation = parseInt(e.target.value);
                if (rotInput) rotInput.value = e.target.value;
                this.render();
            };
            rotSlider.addEventListener('wheel', ev => {
                ev.preventDefault();
                const step = 1;
                rotSlider.value = clamp(parseInt(rotSlider.value) + (ev.deltaY < 0 ? step : -step), -180, 180);
                rotSlider.dispatchEvent(new Event('input'));
            }, { passive: false });
        }
        if (rotInput) {
            rotInput.onchange = e => {
                const v = clamp(parseInt(e.target.value) || 0, -180, 180);
                this.imageRotation = v;
                if (rotSlider) rotSlider.value = v;
                rotInput.value = v;
                this.render();
            };
        }
    },

    setupEvents() {
        const c = this.canvas;

        c.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            this.isDragging = true;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.dragStartImgX = this.imageX;
            this.dragStartImgY = this.imageY;
            c.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', e => {
            if (!this.isDragging) return;
            const displaySide = parseFloat(c.style.width) || this.DISPLAY_SIZE;
            const ratio = this.SIZE / displaySide;
            this.imageX = this.dragStartImgX + (e.clientX - this.dragStartX) * ratio;
            this.imageY = this.dragStartImgY + (e.clientY - this.dragStartY) * ratio;
            this.render();
        });

        window.addEventListener('mouseup', () => {
            if (!this.isDragging) return;
            this.isDragging = false;
            c.style.cursor = 'grab';
        });

        c.addEventListener('wheel', e => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -2 : 2;
            const scaleSlider = $('portraitScaleSlider');
            const scaleInput = $('portraitScaleInput');
            const newVal = clamp(Math.round(this.imageScale * 100) + delta, 10, 500);
            this.imageScale = newVal / 100;
            if (scaleSlider) scaleSlider.value = newVal;
            if (scaleInput) scaleInput.value = newVal;
            this.render();
        }, { passive: false });

        c.addEventListener('contextmenu', e => e.preventDefault());
    },

    getImage() {
        return state.userImage || null;
    },

    render() {
        if (!this.ctx) return;
        const size = this.SIZE;

        this.ctx.fillStyle = '#1a1a1a';
        this.ctx.fillRect(0, 0, size, size);

        const img = this.getImage();
        if (!img) {
            this.ctx.fillStyle = '#555';
            this.ctx.font = `${size * 0.022}px Inter, sans-serif`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText('Загрузите изображение', size / 2, size / 2);
            return;
        }

        this.ctx.save();
        this.ctx.translate(size / 2 + this.imageX, size / 2 + this.imageY);
        this.ctx.rotate(this.imageRotation * Math.PI / 180);
        const w = img.width * this.imageScale;
        const h = img.height * this.imageScale;
        this.ctx.drawImage(img, -w / 2, -h / 2, w, h);
        this.ctx.restore();
    },

    renderForSave() {
        const size = this.SIZE;
        const out = document.createElement('canvas');
        out.width = size;
        out.height = size;
        const ctx = out.getContext('2d', { alpha: false });

        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, size, size);

        const img = this.getImage();
        if (!img) return out;

        if (state.userImage && TokenCanvas._compositedImageCache && !TokenCanvas._compositedImageDirty) {
            const src = TokenCanvas._compositedImageCache;
            ctx.save();
            ctx.translate(size / 2 + this.imageX, size / 2 + this.imageY);
            ctx.rotate(this.imageRotation * Math.PI / 180);
            ctx.drawImage(src, -src.width * this.imageScale / 2, -src.height * this.imageScale / 2, src.width * this.imageScale, src.height * this.imageScale);
            ctx.restore();
        } else {
            ctx.save();
            ctx.translate(size / 2 + this.imageX, size / 2 + this.imageY);
            ctx.rotate(this.imageRotation * Math.PI / 180);
            ctx.drawImage(img, -img.width * this.imageScale / 2, -img.height * this.imageScale / 2, img.width * this.imageScale, img.height * this.imageScale);
            ctx.restore();
        }

        return out;
    },

    resetTransform() {
        const img = this.getImage();
        if (img) {
            const maxDim = Math.max(img.width, img.height);
            this.imageScale = this.SIZE / maxDim;
        } else {
            this.imageScale = 1;
        }
        this.imageX = 0;
        this.imageY = 0;
        this.imageRotation = 0;
        const v = Math.round(this.imageScale * 100);
        const scaleSlider = $('portraitScaleSlider');
        const scaleInput = $('portraitScaleInput');
        const rotSlider = $('portraitRotationSlider');
        const rotInput = $('portraitRotationInput');
        if (scaleSlider) scaleSlider.value = v;
        if (scaleInput) scaleInput.value = v;
        if (rotSlider) rotSlider.value = 0;
        if (rotInput) rotInput.value = 0;
        this.render();
    },

    onImageLoaded() {
        this.resetTransform();
    },

    async pickFolder() {
        if (!window.showDirectoryPicker) { toast('Браузер не поддерживает выбор папки', true); return; }
        try {
            const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
            this.saveFolder = dir;
            const nameEl = $('portraitFolderName');
            if (nameEl) nameEl.textContent = dir.name;
            toast('Папка выбрана: ' + dir.name);
        } catch (e) {
            if (e.name !== 'AbortError') toast('Ошибка выбора папки', true);
        }
    },

    async save() {
        const out = this.renderForSave();
        const fileName = (state.tokenFileName || 'token').trim() + '_portrait.webp';
        const blob = await new Promise(resolve => out.toBlob(resolve, 'image/webp', 0.95));

        if (this.saveFolder) {
            try {
                const fh = await this.saveFolder.getFileHandle(fileName, { create: true });
                const w = await fh.createWritable();
                await w.write(blob);
                await w.close();
                toast('Сохранено: ' + fileName);
            } catch (e) {
                toast('Ошибка сохранения: ' + e.message, true);
            }
        } else {
            await saveFileWithPicker(blob, fileName, 'image/webp');
        }
    }
};
