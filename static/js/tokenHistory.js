const TokenHistory = {
    cloneMask(canvas) {
        if (!canvas) return null;
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext('2d').drawImage(canvas, 0, 0);
        return copy;
    },

    save() {
        if (!state.maskCanvas) return;

        if (state.historyIndex < state.history.length - 1) {
            const removed = state.history.splice(state.historyIndex + 1);
            removed.forEach(entry => {
                if (entry.mask) {
                    entry.mask.getContext('2d').clearRect(0, 0, entry.mask.width, entry.mask.height);
                }
                if (entry.imageMask) {
                    entry.imageMask.getContext('2d').clearRect(0, 0, entry.imageMask.width, entry.imageMask.height);
                }
            });
        }

        state.history.push({
            mask: this.cloneMask(state.maskCanvas),
            imageMask: this.cloneMask(state.imageMaskCanvas),
            x: state.imageX,
            y: state.imageY,
            scale: state.imageScale,
            rotation: state.imageRotation
        });

        if (state.history.length > CONFIG.MAX_HISTORY) {
            const old = state.history.shift();
            if (old.mask) old.mask.getContext('2d').clearRect(0, 0, old.mask.width, old.mask.height);
            if (old.imageMask) old.imageMask.getContext('2d').clearRect(0, 0, old.imageMask.width, old.imageMask.height);
            state.historyIndex = state.history.length - 1;
        } else {
            state.historyIndex++;
        }
    },

    restore(entry) {
        if (!entry || !entry.mask) return;

        const maskCtx = state.maskCanvas.getContext('2d');
        maskCtx.clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
        maskCtx.drawImage(entry.mask, 0, 0, state.maskCanvas.width, state.maskCanvas.height);

        if (entry.imageMask && state.imageMaskCanvas) {
            const imgMaskCtx = state.imageMaskCanvas.getContext('2d');
            imgMaskCtx.clearRect(0, 0, state.imageMaskCanvas.width, state.imageMaskCanvas.height);
            imgMaskCtx.drawImage(entry.imageMask, 0, 0, state.imageMaskCanvas.width, state.imageMaskCanvas.height);
        } else if (!entry.imageMask && state.imageMaskCanvas) {
            const imgMaskCtx = state.imageMaskCanvas.getContext('2d');
            imgMaskCtx.fillStyle = 'white';
            imgMaskCtx.fillRect(0, 0, state.imageMaskCanvas.width, state.imageMaskCanvas.height);
        }

        state.imageX = entry.x;
        state.imageY = entry.y;
        state.imageScale = entry.scale;
        state.imageRotation = entry.rotation !== undefined ? entry.rotation : 0;

        TokenCanvas._compositedImageDirty = true;
        TokenCanvas._zonesDirty = true;
        TokenCanvas.pendingErasePoints = [];
        if (TokenCanvas.eraseAnimationId) {
            cancelAnimationFrame(TokenCanvas.eraseAnimationId);
            TokenCanvas.eraseAnimationId = null;
        }
        TokenCanvas.isErasing = false;

        TokenCanvas.updateScaleUI();
        TokenCanvas.updateRotationUI();
        TokenCanvas.render();
    },

    undo() {
        if (state.historyIndex > 0) {
            state.historyIndex--;
            this.restore(state.history[state.historyIndex]);
            toast('Отмена');
        } else {
            toast('Нечего отменять', true);
        }
    },

    redo() {
        if (state.historyIndex < state.history.length - 1) {
            state.historyIndex++;
            this.restore(state.history[state.historyIndex]);
            toast('Повтор');
        } else {
            toast('Нечего повторять', true);
        }
    },

    init() {
        state.history.forEach(entry => {
            if (entry.mask) entry.mask.getContext('2d').clearRect(0, 0, entry.mask.width, entry.mask.height);
            if (entry.imageMask) entry.imageMask.getContext('2d').clearRect(0, 0, entry.imageMask.width, entry.imageMask.height);
        });
        state.history = [];
        state.historyIndex = -1;
        this.save();
    }
};
