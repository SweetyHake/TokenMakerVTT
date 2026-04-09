var TokenCanvas = {
    canvas: null,
    ctx: null,
    wrapper: null,
    _debouncedSave: null,

    eraserCursor: null,
    eraserBrush: null,
    _imageBrushCache: null,
    _imageBrushCacheSize: -1,

    _compositedImageCache: null,
    _compositedImageDirty: true,

    _ccImageCache: null,
    _ccDirty: true,
    _shadowCache: null,
    _shadowDirty: true,
    _isErasing: false,

    _worker: null,
    _workerPending: false,
    _workerQueue: [],

    _zonesCanvas: null,
    _zonesDirty: true,

    isErasing: false,
    pendingErasePoints: [],
    eraseAnimationId: null,

    get internalSize() {
        return CONFIG.SCALE_SIZES[state.canvasScale] || CONFIG.BASE_SIZE;
    },

    init: function() {
        this.canvas = $('tokenCanvas');
        this.ctx = this.canvas.getContext('2d', { alpha: true });
        this.wrapper = $('canvasWrapper');
        this.area = this.canvas.closest('.canvas-area') || this.wrapper;
        this.eraserCursor = $('eraserCursor');

        this._applyCanvasSize();
        this._fixCanvasDisplay();

        this._tempCanvas = document.createElement('canvas');
        this._tempCanvas.width = this.internalSize;
        this._tempCanvas.height = this.internalSize;
        this._tempCtx = this._tempCanvas.getContext('2d');

        this._cachedRect = null;
        this._rectDirty = true;

        this._debouncedSave = debounce(function() { TokenHistory.save(); }, CONFIG.DEBOUNCE_DELAY);

        this._initWorker();

        this.createMask();
        this.createImageMask();
        this.createEraserBrush();
        this.setupEvents();

        window.addEventListener('resize', this._fixCanvasDisplay.bind(this));
    },

    _initWorker: function() {
        if (this._workerUrl) {
            URL.revokeObjectURL(this._workerUrl);
            this._workerUrl = null;
        }
        try {
            this._worker = new Worker('/static/js/eraserWorker.js');
            this._worker.onmessage = this._onWorkerBrushDone.bind(this);
            this._worker.onerror = function() {
                TokenCanvas._worker = null;
            };
        } catch(e) {
            this._worker = null;
        }
    },

    _onWorkerBrushDone: function(e) {
        this._workerPending = false;
        if (!state.imageMaskCanvas) return;

        var ctx = state.imageMaskCanvas.getContext('2d');
        var imageData = new ImageData(
            new Uint8ClampedArray(e.data.maskData),
            state.imageMaskCanvas.width,
            state.imageMaskCanvas.height
        );
        ctx.putImageData(imageData, 0, 0);

        this._invalidateComposite();

        if (this._workerQueue.length > 0) {
            var next = this._workerQueue.shift();
            this._sendToWorker(next);
        }

        this.render();
    },

    _sendToWorker: function(task) {
        if (!this._worker || !state.imageMaskCanvas) {
            this._fallbackBrushToImageMask(task.cx, task.cy, task.restore);
            return;
        }

        this._workerPending = true;

        var maskCtx = state.imageMaskCanvas.getContext('2d');
        var maskImageData = maskCtx.getImageData(0, 0, state.imageMaskCanvas.width, state.imageMaskCanvas.height);

        var imgBrush = this._getImageBrush();
        if (!imgBrush) { this._workerPending = false; return; }

        var brushCtx = imgBrush.canvas.getContext('2d');
        var brushImageData = brushCtx.getImageData(0, 0, imgBrush.canvas.width, imgBrush.canvas.height);

        var imgPos = this._canvasPosToImagePos(task.cx, task.cy);
        if (!imgPos) { this._workerPending = false; return; }

        var drawX = Math.round(imgPos.x - imgBrush.fullSize / 2);
        var drawY = Math.round(imgPos.y - imgBrush.fullSize / 2);

        var protData = null, protWidth = 0, protHeight = 0;
        if (state.erasableCanvas) {
            var internalSize = this.internalSize;
            var scale = internalSize / 1024;
            var effectiveScale = state.imageScale * scale;

            var protSampler = document.createElement('canvas');
            protSampler.width = imgBrush.fullSize;
            protSampler.height = imgBrush.fullSize;
            var psCtx = protSampler.getContext('2d');
            var invScale = 1 / effectiveScale;
            psCtx.save();
            psCtx.translate(imgBrush.fullSize / 2, imgBrush.fullSize / 2);
            psCtx.rotate(-state.imageRotation * Math.PI / 180);
            psCtx.scale(invScale, invScale);
            psCtx.translate(-task.cx, -task.cy);
            psCtx.drawImage(state.erasableCanvas, 0, 0);
            psCtx.restore();

            var pImageData = psCtx.getImageData(0, 0, imgBrush.fullSize, imgBrush.fullSize);
            protData = pImageData.data.buffer.slice(0);
            protWidth = imgBrush.fullSize;
            protHeight = imgBrush.fullSize;
        }

        var maskBuffer = maskImageData.data.buffer.slice(0);
        var brushBuffer = brushImageData.data.buffer.slice(0);
        var transferList = [maskBuffer, brushBuffer];
        if (protData) transferList.push(protData);

        this._worker.postMessage({
            type: 'applyBrush',
            id: Date.now(),
            maskData: maskBuffer,
            maskWidth: state.imageMaskCanvas.width,
            maskHeight: state.imageMaskCanvas.height,
            brushData: brushBuffer,
            brushWidth: imgBrush.canvas.width,
            brushHeight: imgBrush.canvas.height,
            drawX: drawX,
            drawY: drawY,
            protData: protData,
            protWidth: protWidth,
            protHeight: protHeight,
            restore: task.restore
        }, transferList);
    },

    _fixCanvasDisplay: function() {
        var area = this.canvas.parentElement;
        if (!area) return;
        var w = area.clientWidth;
        var h = area.clientHeight;
        var side = Math.min(w, h);
        this.canvas.style.width = side + 'px';
        this.canvas.style.height = side + 'px';
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = Math.round((w - side) / 2) + 'px';
        this.canvas.style.top = Math.round((h - side) / 2) + 'px';
        this._rectDirty = true;
    },

    _applyCanvasSize: function() {
        var size = this.internalSize;
        this.canvas.width = size;
        this.canvas.height = size;
        if (this._tempCanvas) {
            this._tempCanvas.width = size;
            this._tempCanvas.height = size;
        }
        this._compositedImageDirty = true;
        this._zonesDirty = true;
        this._rectDirty = true;
        this._ccDirty = true;
        this._shadowDirty = true;
    },

    setCanvasScale: function(scale) {
        if (![1, 2, 3].includes(scale)) return;
        state.canvasScale = scale;
        this._applyCanvasSize();
        this._fixCanvasDisplay();
        this.createMask();
        this.createEraserBrush();
        TokenPresets.reloadProtectionMaskForScale();
        this.render();
        toast('Масштаб канваса: ' + scale + '×');
    },

    createEraserBrush: function() {
        this.updateEraserBrush(state.eraserSize);
    },

    updateEraserBrush: function(size) {
        var internalScale = this.internalSize / 1024;
        var scaledRadius = Math.ceil(size * internalScale);
        var brushSize = scaledRadius * 2 + 4;

        var brush = document.createElement('canvas');
        brush.width = brushSize;
        brush.height = brushSize;
        var ctx = brush.getContext('2d');

        var cx = brushSize / 2;
        var cy = brushSize / 2;

        var gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, scaledRadius);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.7, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.85, 'rgba(255,255,255,0.5)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, brushSize, brushSize);

        this.eraserBrush = { canvas: brush, size: scaledRadius, fullSize: brushSize };
        this._imageBrushCache = null;
        this._imageBrushCacheSize = -1;
    },

    _getImageBrush: function() {
        if (!state.userImage || !this.eraserBrush) return null;

        var internalScale = this.internalSize / 1024;
        var effectiveScale = state.imageScale * internalScale;

        if (this._imageBrushCache && this._imageBrushCacheSize === effectiveScale) {
            return this._imageBrushCache;
        }

        var brushRadiusInImagePx = this.eraserBrush.size / effectiveScale;
        var brushSize = Math.ceil(brushRadiusInImagePx * 2 + 4);

        var brush = document.createElement('canvas');
        brush.width = brushSize;
        brush.height = brushSize;
        var ctx = brush.getContext('2d');

        var cx = brushSize / 2;
        var cy = brushSize / 2;

        var gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, brushRadiusInImagePx);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.7, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.85, 'rgba(255,255,255,0.5)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, brushSize, brushSize);

        this._imageBrushCache = { canvas: brush, size: brushRadiusInImagePx, fullSize: brushSize };
        this._imageBrushCacheSize = effectiveScale;
        return this._imageBrushCache;
    },

    invalidateEffectsCache: function() {
        this._ccDirty = true;
        this._shadowDirty = true;
        this._compositedImageDirty = true;
    },

    _invalidateComposite: function() {
        this._compositedImageDirty = true;
        this._zonesDirty = true;
        this._shadowDirty = true;
    },

    _invalidateZones: function() {
        this._zonesDirty = true;
    },

    _buildCCImage: function() {
        if (!state.userImage) return null;
        var canvas = document.createElement('canvas');
        canvas.width = state.userImage.width;
        canvas.height = state.userImage.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(state.userImage, 0, 0);
        return applyColorCorrection(canvas);
    },

    _buildCompositedImage: function() {
        if (!state.userImage) return;
        if (!this._compositedImageDirty && this._compositedImageCache) return;

        var iw = state.userImage.width;
        var ih = state.userImage.height;

        if (!this._compositedImageCache || this._compositedImageCache.width !== iw || this._compositedImageCache.height !== ih) {
            this._compositedImageCache = document.createElement('canvas');
            this._compositedImageCache.width = iw;
            this._compositedImageCache.height = ih;
        }

        var ctx = this._compositedImageCache.getContext('2d');
        ctx.clearRect(0, 0, iw, ih);

        var baseImg = state.userImage;
        if (state.colorCorrectionEnabled) {
            if (this._ccDirty || !this._ccImageCache) {
                this._ccImageCache = this._buildCCImage();
                this._ccDirty = false;
            }
            if (this._ccImageCache) baseImg = this._ccImageCache;
        }

        ctx.drawImage(baseImg, 0, 0);

        if (state.imageMaskCanvas) {
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(state.imageMaskCanvas, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
        }

        this._compositedImageDirty = false;
    },

    updateEraserCursor: function(e) {
        if (!this.eraserCursor) return;
        var internalScale = this.internalSize / 1024;
        var displaySide = parseFloat(this.canvas.style.width) || this.canvas.offsetWidth;
        if (!displaySide) return;
        var pixelsPerInternalUnit = (displaySide / this.internalSize) * state.viewZoom;
        var brushInternalRadius = state.eraserSize * internalScale;
        var displayDiameter = brushInternalRadius * 2 * pixelsPerInternalUnit;
        this.eraserCursor.style.width = displayDiameter + 'px';
        this.eraserCursor.style.height = displayDiameter + 'px';
        this.eraserCursor.style.left = e.clientX + 'px';
        this.eraserCursor.style.top = e.clientY + 'px';
        this.eraserCursor.style.borderColor = state.currentEraserMode === 'blue'
            ? 'rgba(100, 180, 255, 0.85)'
            : 'rgba(255, 100, 180, 0.85)';
    },

    showEraserCursor: function() {
        if (this.eraserCursor) this.eraserCursor.classList.add('visible');
    },

    hideEraserCursor: function() {
        if (this.eraserCursor) this.eraserCursor.classList.remove('visible');
    },

    createMask: function() {
        var size = this.internalSize;
        if (state.maskCanvas && state.maskCanvas.width === size) return;

        var newMask = document.createElement('canvas');
        newMask.width = size;
        newMask.height = size;
        var newCtx = newMask.getContext('2d');

        if (state.maskCanvas) {
            newCtx.drawImage(state.maskCanvas, 0, 0, size, size);
        } else {
            newCtx.fillStyle = 'white';
            newCtx.fillRect(0, 0, size, size);
        }

        state.maskCanvas = newMask;
    },

    createImageMask: function() {
        if (!state.userImage) return;
        if (state.imageMaskCanvas && state.imageMaskCanvas.width === state.userImage.width && state.imageMaskCanvas.height === state.userImage.height) return;

        var newMask = document.createElement('canvas');
        newMask.width = state.userImage.width;
        newMask.height = state.userImage.height;
        var ctx = newMask.getContext('2d');

        if (state.imageMaskCanvas) {
            ctx.drawImage(state.imageMaskCanvas, 0, 0, newMask.width, newMask.height);
        } else {
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, newMask.width, newMask.height);
        }

        state.imageMaskCanvas = newMask;
        this._invalidateComposite();
    },

    render: function() {
        if (!this.ctx) return;
        var size = this.internalSize;
        var scale = size / 1024;

        this.ctx.clearRect(0, 0, size, size);

        var ringSize = CONFIG.SCALE_SIZES[1];
        var ringOffset = (size - ringSize) / 2;
        var ringImage = state.ringImages[2048] || state.ringImages[1024];
        if (ringImage) {
            this.ctx.drawImage(ringImage, ringOffset, ringOffset, ringSize, ringSize);
        }

        if (state.userImage) {
            this._buildCompositedImage();

            var tc = this._tempCanvas;
            var tempCtx = this._tempCtx;
            tempCtx.clearRect(0, 0, size, size);
            tempCtx.imageSmoothingEnabled = true;
            tempCtx.imageSmoothingQuality = 'high';

            var w = state.userImage.width * state.imageScale * scale;
            var h = state.userImage.height * state.imageScale * scale;
            var cx = size / 2 + state.imageX * scale;
            var cy = size / 2 + state.imageY * scale;

            tempCtx.save();
            tempCtx.translate(cx, cy);
            tempCtx.rotate(state.imageRotation * Math.PI / 180);
            tempCtx.drawImage(this._compositedImageCache, -w / 2, -h / 2, w, h);
            tempCtx.restore();

            tempCtx.globalCompositeOperation = 'destination-in';
            tempCtx.drawImage(state.maskCanvas, 0, 0);
            tempCtx.globalCompositeOperation = 'source-over';

            if (state.effectsEnabled && state.dropShadowEnabled) {
                if (!this._isErasing && (this._shadowDirty || !this._shadowCache)) {
                    this._shadowCache = createDropShadow(tc);
                    this._shadowDirty = false;
                }
                if (this._shadowCache) {
                    this.ctx.drawImage(this._shadowCache, 0, 0);
                }
            }

            this.ctx.drawImage(tc, 0, 0);

            if (state.showErasedZones) {
                this._renderErasedZonesCached(size, scale, w, h, cx, cy);
            }
        }

        if (state.presetOverlayActive && state.presetOverlayCanvas) {
            var alpha = state._presetOverlayAlpha !== undefined ? state._presetOverlayAlpha : 0.6;
            this.ctx.globalAlpha = alpha;
            this.ctx.drawImage(state.presetOverlayCanvas, 0, 0);
            this.ctx.globalAlpha = 1;
        }

        if (state.showProtectionMask && state.erasableCanvas) {
            this._renderProtectionMaskOverlay(size);
        }

        if (state.showScaleBorders) {
            var s3 = CONFIG.SCALE_SIZES[3];
            this.ctx.save();
            var dashLen = 20 * (size / s3);
            var gapLen = 12 * (size / s3);
            this.ctx.setLineDash([dashLen, gapLen]);
            this.ctx.lineWidth = 6 * (size / s3);

            var b1 = CONFIG.SCALE_SIZES[1] * (size / s3);
            var off1 = (size - b1) / 2;
            this.ctx.strokeStyle = 'rgba(255, 200, 0, 0.9)';
            this.ctx.strokeRect(off1, off1, b1, b1);

            var b2 = CONFIG.SCALE_SIZES[2] * (size / s3);
            var off2 = (size - b2) / 2;
            this.ctx.strokeStyle = 'rgba(100, 200, 255, 0.9)';
            this.ctx.strokeRect(off2, off2, b2, b2);

            this.ctx.strokeStyle = 'rgba(100, 255, 140, 0.9)';
            this.ctx.strokeRect(3, 3, size - 6, size - 6);
            this.ctx.restore();
        }

        var overlay = $('canvasOverlay');
        if (overlay) overlay.style.display = state.userImage ? 'none' : 'flex';
    },

    _renderErasedZonesCached: function(size, scale, w, h, cx, cy) {
        if (!this._zonesCanvas || this._zonesCanvas.width !== size || this._zonesCanvas.height !== size) {
            this._zonesCanvas = document.createElement('canvas');
            this._zonesCanvas.width = size;
            this._zonesCanvas.height = size;
            this._zonesDirty = true;
        }

        if (this._zonesDirty) {
            var zCtx = this._zonesCanvas.getContext('2d');
            zCtx.clearRect(0, 0, size, size);

            if (state.imageMaskCanvas) {
                var invImgMask = document.createElement('canvas');
                invImgMask.width = state.imageMaskCanvas.width;
                invImgMask.height = state.imageMaskCanvas.height;
                var invImgCtx = invImgMask.getContext('2d');
                invImgCtx.fillStyle = 'white';
                invImgCtx.fillRect(0, 0, invImgMask.width, invImgMask.height);
                invImgCtx.globalCompositeOperation = 'destination-out';
                invImgCtx.drawImage(state.imageMaskCanvas, 0, 0);

                zCtx.save();
                zCtx.fillStyle = 'rgba(80, 160, 255, 0.5)';
                zCtx.translate(cx, cy);
                zCtx.rotate(state.imageRotation * Math.PI / 180);
                zCtx.globalCompositeOperation = 'source-over';

                var blueTemp = document.createElement('canvas');
                blueTemp.width = size;
                blueTemp.height = size;
                var bCtx = blueTemp.getContext('2d');
                bCtx.fillStyle = 'rgba(80, 160, 255, 0.5)';
                bCtx.fillRect(0, 0, size, size);

                var invScaled = document.createElement('canvas');
                invScaled.width = size;
                invScaled.height = size;
                var isCtx = invScaled.getContext('2d');
                isCtx.save();
                isCtx.translate(cx, cy);
                isCtx.rotate(state.imageRotation * Math.PI / 180);
                isCtx.drawImage(invImgMask, -w / 2, -h / 2, w, h);
                isCtx.restore();

                bCtx.globalCompositeOperation = 'destination-in';
                bCtx.drawImage(invScaled, 0, 0);

                zCtx.restore();
                zCtx.drawImage(blueTemp, 0, 0);
            }

            var invMask = document.createElement('canvas');
            invMask.width = size;
            invMask.height = size;
            var invCtx = invMask.getContext('2d');
            invCtx.fillStyle = 'white';
            invCtx.fillRect(0, 0, size, size);
            invCtx.globalCompositeOperation = 'destination-out';
            invCtx.drawImage(state.maskCanvas, 0, 0);

            var pinkLayer = document.createElement('canvas');
            pinkLayer.width = size;
            pinkLayer.height = size;
            var pCtx = pinkLayer.getContext('2d');
            pCtx.fillStyle = 'rgba(255, 80, 160, 0.5)';
            pCtx.fillRect(0, 0, size, size);
            pCtx.globalCompositeOperation = 'destination-in';
            pCtx.drawImage(invMask, 0, 0);

            zCtx.drawImage(pinkLayer, 0, 0);
            this._zonesDirty = false;
        }

        this.ctx.drawImage(this._zonesCanvas, 0, 0);
    },

    renderForSave: function(withRing) {
        var scaleMode = state.saveScaleMode;
        var usedScale = scaleMode === 'auto' ? this.detectUsedScale() : (parseInt(scaleMode) || 1);

        var qualityBase = state.saveQuality;
        var scale3Size = qualityBase * 3;
        var internalSize = this.internalSize;
        var coordScale = scale3Size / internalSize;

        var fullRender = document.createElement('canvas');
        fullRender.width = scale3Size;
        fullRender.height = scale3Size;
        var fullCtx = fullRender.getContext('2d');
        fullCtx.imageSmoothingEnabled = true;
        fullCtx.imageSmoothingQuality = 'high';

        var ringSize = qualityBase;
        var ringOffset = (scale3Size - ringSize) / 2;
        var ringImage = state.ringImages[2048] || state.ringImages[1024];
        if (withRing && ringImage) {
            fullCtx.drawImage(ringImage, ringOffset, ringOffset, ringSize, ringSize);
        }

        if (state.userImage) {
            this._buildCompositedImage();

            var tempCanvas = document.createElement('canvas');
            tempCanvas.width = scale3Size;
            tempCanvas.height = scale3Size;
            var tempCtx = tempCanvas.getContext('2d');
            tempCtx.imageSmoothingEnabled = true;
            tempCtx.imageSmoothingQuality = 'high';

            var imgRenderScale = internalSize / 1024;
            var w = state.userImage.width * state.imageScale * imgRenderScale * coordScale;
            var h = state.userImage.height * state.imageScale * imgRenderScale * coordScale;
            var cx = scale3Size / 2 + state.imageX * imgRenderScale * coordScale;
            var cy = scale3Size / 2 + state.imageY * imgRenderScale * coordScale;

            tempCtx.save();
            tempCtx.translate(cx, cy);
            tempCtx.rotate(state.imageRotation * Math.PI / 180);
            tempCtx.drawImage(this._compositedImageCache, -w / 2, -h / 2, w, h);
            tempCtx.restore();

            var maskForSave = document.createElement('canvas');
            maskForSave.width = scale3Size;
            maskForSave.height = scale3Size;
            maskForSave.getContext('2d').drawImage(state.maskCanvas, 0, 0, internalSize, internalSize, 0, 0, scale3Size, scale3Size);

            tempCtx.globalCompositeOperation = 'destination-in';
            tempCtx.drawImage(maskForSave, 0, 0);
            tempCtx.globalCompositeOperation = 'source-over';

            if (state.dropShadowEnabled && state.effectsEnabled) {
                var shadowCanvas = createDropShadow(tempCanvas);
                fullCtx.drawImage(shadowCanvas, 0, 0);
            }
            fullCtx.drawImage(tempCanvas, 0, 0);
        }

        var finalSize = qualityBase * usedScale;
        var cropOffset = (scale3Size - finalSize) / 2;

        var croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = finalSize;
        croppedCanvas.height = finalSize;
        var croppedCtx = croppedCanvas.getContext('2d');
        croppedCtx.imageSmoothingEnabled = true;
        croppedCtx.imageSmoothingQuality = 'high';
        croppedCtx.drawImage(fullRender, cropOffset, cropOffset, finalSize, finalSize, 0, 0, finalSize, finalSize);

        return { canvas: croppedCanvas, finalSize: finalSize };
    },

    detectUsedScale: function() {
        if (!state.userImage) return 1;

        var internalSize = this.internalSize;
        var scale = internalSize / 1024;
        var w = state.userImage.width * state.imageScale * scale;
        var h = state.userImage.height * state.imageScale * scale;
        var cx = internalSize / 2 + state.imageX * scale;
        var cy = internalSize / 2 + state.imageY * scale;
        var left = cx - w / 2;
        var top = cy - h / 2;
        var right = cx + w / 2;
        var bottom = cy + h / 2;

        for (var s = 3; s >= 2; s--) {
            var limitSize = CONFIG.SCALE_SIZES[s] * (internalSize / CONFIG.SCALE_SIZES[3]);
            var limitOffset = (internalSize - limitSize) / 2;
            if (left < limitOffset || top < limitOffset || right > limitOffset + limitSize || bottom > limitOffset + limitSize) {
                return s;
            }
        }
        return 1;
    },

    updateViewTransform: function() {
        if (!this.canvas) return;

        var displaySide = parseFloat(this.canvas.style.width) || this.canvas.offsetWidth || 800;
        var area = this.canvas.parentElement;
        var areaW = area ? area.clientWidth : displaySide;
        var areaH = area ? area.clientHeight : displaySide;

        var maxPanX = (areaW / 2) / state.viewZoom;
        var maxPanY = (areaH / 2) / state.viewZoom;

        state.viewPanX = clamp(state.viewPanX, -maxPanX, maxPanX);
        state.viewPanY = clamp(state.viewPanY, -maxPanY, maxPanY);

        this.canvas.style.transform = 'scale(' + state.viewZoom + ') translate(' + state.viewPanX + 'px, ' + state.viewPanY + 'px)';
        var indicator = $('zoomIndicator');
        if (indicator) {
            indicator.textContent = Math.round(state.viewZoom * 100) + '%';
            indicator.classList.toggle('show', state.viewZoom !== 1 || state.viewPanX !== 0 || state.viewPanY !== 0);
        }
    },

    resetView: function() {
        state.viewZoom = 1;
        state.viewPanX = 0;
        state.viewPanY = 0;
        this.updateViewTransform();
    },

    updateScaleUI: function() {
        var slider = $('scaleSlider');
        var input = $('scaleInput');
        var val = Math.round(state.imageScale * 100);
        if (slider) slider.value = val;
        if (input) input.value = val;
    },

    updateRotationUI: function() {
        var slider = $('rotationSlider');
        var input = $('rotationInput');
        var val = Math.round(state.imageRotation);
        if (slider) slider.value = val;
        if (input) input.value = val;
    },

    scheduleEffects: function() {
        var self = this;
        state.effectsEnabled = false;
        this._shadowDirty = true;
        if (state.effectsTimeout) clearTimeout(state.effectsTimeout);
        state.effectsTimeout = setTimeout(function() {
            state.effectsEnabled = true;
            state.effectsTimeout = null;
            self._shadowDirty = true;
            self.render();
        }, CONFIG.EFFECTS_DELAY);
    },

    getCanvasPos: function(e) {
        if (this._rectDirty || !this._cachedRect) {
            this._cachedRect = this.canvas.getBoundingClientRect();
            this._rectDirty = false;
        }
        var rect = this._cachedRect;
        var scaleX = this.internalSize / rect.width;
        var scaleY = this.internalSize / rect.height;
        var clientX = e.touches ? e.touches[0].clientX : e.clientX;
        var clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY
        };
    },

    _canvasPosToImagePos: function(canvasX, canvasY) {
        if (!state.userImage) return null;
        var size = this.internalSize;
        var scale = size / 1024;
        var cx = size / 2 + state.imageX * scale;
        var cy = size / 2 + state.imageY * scale;
        var cos = Math.cos(-state.imageRotation * Math.PI / 180);
        var sin = Math.sin(-state.imageRotation * Math.PI / 180);
        var dx = canvasX - cx;
        var dy = canvasY - cy;
        var lx = cos * dx - sin * dy;
        var ly = sin * dx + cos * dy;
        var px = lx / (state.imageScale * scale) + state.userImage.width / 2;
        var py = ly / (state.imageScale * scale) + state.userImage.height / 2;
        return { x: px, y: py };
    },

    applyEraserBrushToPinkMask: function(cx, cy, restore) {
        if (!this.eraserBrush || !state.maskCanvas) return;
        var brush = this.eraserBrush;
        var maskCtx = state.maskCanvas.getContext('2d');
        var drawX = Math.round(cx - brush.fullSize / 2);
        var drawY = Math.round(cy - brush.fullSize / 2);

        var workCanvas = document.createElement('canvas');
        workCanvas.width = brush.fullSize;
        workCanvas.height = brush.fullSize;
        var workCtx = workCanvas.getContext('2d');
        workCtx.drawImage(brush.canvas, 0, 0);

        if (state.erasableCanvas) {
            workCtx.globalCompositeOperation = 'destination-out';
            workCtx.drawImage(
                state.erasableCanvas,
                drawX, drawY, brush.fullSize, brush.fullSize,
                0, 0, brush.fullSize, brush.fullSize
            );
            workCtx.globalCompositeOperation = 'source-over';
        }

        if (restore) {
            maskCtx.globalCompositeOperation = 'source-over';
        } else {
            maskCtx.globalCompositeOperation = 'destination-out';
        }
        maskCtx.drawImage(workCanvas, drawX, drawY);
        maskCtx.globalCompositeOperation = 'source-over';

        this._zonesDirty = true;
        this._shadowDirty = true;
    },

    applyEraserBrushToImageMask: function(cx, cy, restore) {
        if (!state.userImage || !state.imageMaskCanvas) return;

        if (this._worker && !this._workerPending) {
            this._sendToWorker({ cx, cy, restore });
            return;
        }

        if (this._worker && this._workerPending) {
            if (this._workerQueue.length < 4) {
                this._workerQueue.push({ cx, cy, restore });
            }
            return;
        }

        this._fallbackBrushToImageMask(cx, cy, restore);
    },

    _fallbackBrushToImageMask: function(cx, cy, restore) {
        var imgPos = this._canvasPosToImagePos(cx, cy);
        if (!imgPos) return;

        var imgBrush = this._getImageBrush();
        if (!imgBrush) return;

        var maskCtx = state.imageMaskCanvas.getContext('2d');
        var drawX = Math.round(imgPos.x - imgBrush.fullSize / 2);
        var drawY = Math.round(imgPos.y - imgBrush.fullSize / 2);

        var workCanvas = document.createElement('canvas');
        workCanvas.width = imgBrush.fullSize;
        workCanvas.height = imgBrush.fullSize;
        var workCtx = workCanvas.getContext('2d');
        workCtx.drawImage(imgBrush.canvas, 0, 0);

        if (state.erasableCanvas) {
            var internalSize = this.internalSize;
            var scale = internalSize / 1024;
            var effectiveScale = state.imageScale * scale;

            var protSampler = document.createElement('canvas');
            protSampler.width = imgBrush.fullSize;
            protSampler.height = imgBrush.fullSize;
            var psCtx = protSampler.getContext('2d');
            var invScale = 1 / effectiveScale;
            psCtx.save();
            psCtx.translate(imgBrush.fullSize / 2, imgBrush.fullSize / 2);
            psCtx.rotate(-state.imageRotation * Math.PI / 180);
            psCtx.scale(invScale, invScale);
            psCtx.translate(-cx, -cy);
            psCtx.drawImage(state.erasableCanvas, 0, 0);
            psCtx.restore();

            workCtx.globalCompositeOperation = 'destination-out';
            workCtx.drawImage(protSampler, 0, 0);
            workCtx.globalCompositeOperation = 'source-over';
        }

        if (restore) {
            maskCtx.globalCompositeOperation = 'source-over';
        } else {
            maskCtx.globalCompositeOperation = 'destination-out';
        }
        maskCtx.drawImage(workCanvas, drawX, drawY);
        maskCtx.globalCompositeOperation = 'source-over';

        this._invalidateComposite();
    },

    processErasePoints: function() {
        var self = this;

        if (this.pendingErasePoints.length === 0) {
            this.eraseAnimationId = null;
            this.render();
            return;
        }

        var batchSize = Math.min(8, this.pendingErasePoints.length);

        if (state.currentEraserMode === 'pink') {
            for (var i = 0; i < batchSize; i++) {
                var point = this.pendingErasePoints.shift();
                this.applyEraserBrushToPinkMask(point.x, point.y, point.restore);
            }
        } else {
            for (var j = 0; j < batchSize; j++) {
                var pt = this.pendingErasePoints.shift();
                this.applyEraserBrushToImageMask(pt.x, pt.y, pt.restore);
            }
        }

        this.render();

        if (this.pendingErasePoints.length > 0 || this.isErasing) {
            this.eraseAnimationId = requestAnimationFrame(function() { self.processErasePoints(); });
        } else {
            this.eraseAnimationId = null;
        }
    },

    addErasePoint: function(cx, cy, restore) {
        var point = { x: cx, y: cy, restore: !!restore };

        if (state.lastErasePos) {
            var dx = cx - state.lastErasePos.x;
            var dy = cy - state.lastErasePos.y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var step = this.eraserBrush.size * 0.35;
            if (dist > step) {
                var steps = Math.ceil(dist / step);
                for (var i = 1; i <= steps; i++) {
                    var t = i / steps;
                    this.pendingErasePoints.push({
                        x: state.lastErasePos.x + dx * t,
                        y: state.lastErasePos.y + dy * t,
                        restore: !!restore
                    });
                }
            } else {
                this.pendingErasePoints.push(point);
            }
        } else {
            this.pendingErasePoints.push(point);
        }

        state.lastErasePos = { x: cx, y: cy };

        if (!this.eraseAnimationId) {
            var self = this;
            this.eraseAnimationId = requestAnimationFrame(function() { self.processErasePoints(); });
        }
    },

    startErasing: function(pos, restore) {
        this.isErasing = true;
        this._isErasing = true;
        state.isRestoring = !!restore;
        state.lastErasePos = null;
        this.pendingErasePoints = [];
        this.scheduleEffects();
        this.addErasePoint(pos.x, pos.y, state.isRestoring);
    },

    stopErasing: function() {
        this.isErasing = false;
        this._isErasing = false;
        state.lastErasePos = null;
        this._shadowDirty = true;
        
        var self = this;
        setTimeout(function() {
            if (self.pendingErasePoints.length === 0 && !self.eraseAnimationId) {
                TokenHistory.save();
                self.render();
            }
        }, 50);
    },

    setupEvents: function() {
        var self = this;
        var target = this.area;

        var invalidateRect = function() { self._rectDirty = true; };
        window.addEventListener('resize', invalidateRect);
        window.addEventListener('scroll', invalidateRect, true);

        target.onmouseenter = function(e) {
            self._rectDirty = true;
            if (state.currentTool === 'eraser') {
                self.showEraserCursor();
                self.updateEraserCursor(e);
            }
        };target.onmouseleave = function(e) {
            self.hideEraserCursor();
            if (state.isPanning) {
                state.isPanning = false;
                target.style.cursor = state.currentTool === 'eraser' ? 'none' : 'grab';
            }
            if (state.isDragging && (state.dragStartPos.x !== state.imageX || state.dragStartPos.y !== state.imageY)) {
                TokenHistory.save();
            }
            if (self.isErasing) self.stopErasing();
            state.isDragging = false;
        };

        target.onmousedown = function(e) {
            self._rectDirty = true;
            if (e.button === 1 || e.button === 2) {
                e.preventDefault();
                state.isPanning = true;
                state.panStart = { x: e.clientX, y: e.clientY };
                state.panStartView = { x: state.viewPanX, y: state.viewPanY };
                target.style.cursor = 'grabbing';
                self.hideEraserCursor();
                return;
            }
            if (e.button === 0 && e.altKey) {
                e.preventDefault();
                state.isPanning = true;
                state.panStart = { x: e.clientX, y: e.clientY };
                state.panStartView = { x: state.viewPanX, y: state.viewPanY };
                target.style.cursor = 'grabbing';
                self.hideEraserCursor();
                return;
            }
            e.preventDefault();
            var pos = self.getCanvasPos(e);
            if (state.currentTool === 'move') {
                state.isDragging = true;
                var sc = self.internalSize / 1024;
                state.dragStart = { x: pos.x / sc - state.imageX, y: pos.y / sc - state.imageY };
                state.dragStartPos = { x: state.imageX, y: state.imageY };
            } else if (state.currentTool === 'eraser') {
                self.startErasing(pos, e.shiftKey);
            }
        };

        target.onmousemove = function(e) {
            if (state.currentTool === 'eraser' && !state.isPanning) self.updateEraserCursor(e);
            if (state.isPanning) {
                var dx = (e.clientX - state.panStart.x) / state.viewZoom;
                var dy = (e.clientY - state.panStart.y) / state.viewZoom;
                state.viewPanX = state.panStartView.x + dx;
                state.viewPanY = state.panStartView.y + dy;
                self.updateViewTransform();
                return;
            }
            e.preventDefault();
            var pos = self.getCanvasPos(e);
            if (state.currentTool === 'move' && state.isDragging) {
                var sc = self.internalSize / 1024;
                state.imageX = pos.x / sc - state.dragStart.x;
                state.imageY = pos.y / sc - state.dragStart.y;
                self.scheduleEffects();
                self.render();
            } else if (state.currentTool === 'eraser' && self.isErasing) {
                self.addErasePoint(pos.x, pos.y, state.isRestoring);
            }
        };

        target.onmouseup = function(e) {
            if (state.isPanning) {
                state.isPanning = false;
                if (state.currentTool === 'eraser') {
                    target.style.cursor = 'none';
                    self.showEraserCursor();
                    self.updateEraserCursor(e);
                } else {
                    target.style.cursor = 'grab';
                }
                return;
            }
            if (state.isDragging && (state.dragStartPos.x !== state.imageX || state.dragStartPos.y !== state.imageY)) {
                TokenHistory.save();
            }
            if (self.isErasing) self.stopErasing();
            state.isDragging = false;
        };

        target.ontouchstart = function(e) {
            e.preventDefault();
            self._rectDirty = true;
            var pos = self.getCanvasPos(e);
            if (state.currentTool === 'move') {
                state.isDragging = true;
                var sc = self.internalSize / 1024;
                state.dragStart = { x: pos.x / sc - state.imageX, y: pos.y / sc - state.imageY };
                state.dragStartPos = { x: state.imageX, y: state.imageY };
            } else if (state.currentTool === 'eraser') {
                self.startErasing(pos, false);
            }
        };

        target.ontouchmove = function(e) {
            e.preventDefault();
            var pos = self.getCanvasPos(e);
            if (state.currentTool === 'move' && state.isDragging) {
                var sc = self.internalSize / 1024;
                state.imageX = pos.x / sc - state.dragStart.x;
                state.imageY = pos.y / sc - state.dragStart.y;
                self.scheduleEffects();
                self.render();
            } else if (state.currentTool === 'eraser' && self.isErasing) {
                self.addErasePoint(pos.x, pos.y, state.isRestoring);
            }
        };

        target.ontouchend = function() {
            if (state.isDragging && (state.dragStartPos.x !== state.imageX || state.dragStartPos.y !== state.imageY)) {
                TokenHistory.save();
            }
            if (self.isErasing) self.stopErasing();
            state.isDragging = false;
        };

        target.oncontextmenu = function(e) { e.preventDefault(); };

        target.onwheel = function(e) {
            e.preventDefault();
            if (!state.userImage && !e.ctrlKey) return;
            if (e.ctrlKey) {
                var canvasRect = self.canvas.getBoundingClientRect();
                var mouseX = e.clientX - canvasRect.left - canvasRect.width / 2;
                var mouseY = e.clientY - canvasRect.top - canvasRect.height / 2;
                var zoomFactor = e.deltaY > 0 ? 0.95 : 1.05;
                var newZoom = clamp(state.viewZoom * zoomFactor, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
                var zoomRatio = newZoom / state.viewZoom;
                state.viewPanX = state.viewPanX - mouseX * (zoomRatio - 1) / newZoom;
                state.viewPanY = state.viewPanY - mouseY * (zoomRatio - 1) / newZoom;
                state.viewZoom = newZoom;
                self.updateViewTransform();
                if (state.currentTool === 'eraser') self.updateEraserCursor(e);
            } else if (e.altKey && state.userImage) {
                var delta = e.deltaY > 0 ? -1 : 1;
                var newScale = clamp(state.imageScale * 100 + delta, CONFIG.MIN_SCALE, CONFIG.MAX_SCALE);
                state.imageScale = newScale / 100;
                self._imageBrushCache = null;
                self.updateScaleUI();
                self.scheduleEffects();
                self.render();
                if (self._debouncedSave) self._debouncedSave();
            } else if (e.shiftKey) {
                var panAmount = CONFIG.PAN_AMOUNT / state.viewZoom;
                state.viewPanX -= e.deltaY > 0 ? panAmount : -panAmount;
                self.updateViewTransform();
            } else {
                var panAmount2 = CONFIG.PAN_AMOUNT / state.viewZoom;
                state.viewPanY -= e.deltaY > 0 ? panAmount2 : -panAmount2;
                self.updateViewTransform();
            }
        };

        if (this.wrapper) {
            this.wrapper.ondblclick = function(e) {
                self.resetView();
            };
        }

        this.canvas.oncontextmenu = function(e) { e.preventDefault(); };
    },

    cleanupUserImage: function() {
        if (state.userImageUrl) {
            URL.revokeObjectURL(state.userImageUrl);
            state.userImageUrl = null;
        }
    },

    loadImage: function(file) {
        var self = this;

        if (state.userImageUrl) {
            URL.revokeObjectURL(state.userImageUrl);
            state.userImageUrl = null;
        }

        this._clearCanvasCache();

        if (state.maskCanvas) {
            var mCtx = state.maskCanvas.getContext('2d');
            mCtx.clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
            state.maskCanvas = null;
        }
        if (state.imageMaskCanvas) {
            var imCtx = state.imageMaskCanvas.getContext('2d');
            imCtx.clearRect(0, 0, state.imageMaskCanvas.width, state.imageMaskCanvas.height);
            state.imageMaskCanvas = null;
        }

        state.userImage = null;
        state.userImageOriginal = null;
        state.userImageWithoutBg = null;
        state.history = [];
        state.historyIndex = -1;

        state.tokenFileName = getFileBaseName(file.name);
        var fileNameInput = $('tokenFileName');
        if (fileNameInput) fileNameInput.value = state.tokenFileName;

        var reader = new FileReader();
        reader.onload = function(e) {
            var img = new Image();
            img.onload = function() {
                state.userImage = img;
                state.userImageOriginal = img;
                state.userImageWithoutBg = null;
                state.backgroundRemoved = false;
                state.showingOriginal = false;
                TokenEditor.updateRemoveBgButton();

                var internalSize = self.internalSize;
                var scale = internalSize / 1024;
                var maxDisplayPx = CONFIG.SCALE_SIZES[1] * scale;
                var imgMaxDim = Math.max(img.width, img.height);
                state.imageScale = (maxDisplayPx / imgMaxDim) / scale;

                self.updateScaleUI();
                state.imageX = 0;
                state.imageY = 0;
                state.imageRotation = 0;
                self.updateRotationUI();
                self.resetView();

                self.createMask();
                self.createImageMask();
                state.currentPreset = -1;
                TokenPresets.updateButtons();
                TokenHistory.init();
                self.render();

                if (typeof PortraitGenerator !== 'undefined' && PortraitGenerator.canvas) {
                    PortraitGenerator.onImageLoaded();
                }

                var saveWithoutRing = $('saveWithoutRing');
                var saveWithRing = $('saveWithRing');
                if (saveWithoutRing) saveWithoutRing.disabled = false;
                if (saveWithRing) saveWithRing.disabled = false;
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    },

    _clearCanvasCache: function() {
        if (this._compositedImageCache) {
            var ctx = this._compositedImageCache.getContext('2d');
            ctx.clearRect(0, 0, this._compositedImageCache.width, this._compositedImageCache.height);
            this._compositedImageCache = null;
        }
        if (this._ccImageCache) {
            var ccCtx = this._ccImageCache.getContext('2d');
            ccCtx.clearRect(0, 0, this._ccImageCache.width, this._ccImageCache.height);
            this._ccImageCache = null;
        }
        if (this._shadowCache) {
            var shCtx = this._shadowCache.getContext('2d');
            shCtx.clearRect(0, 0, this._shadowCache.width, this._shadowCache.height);
            this._shadowCache = null;
        }
        if (this._zonesCanvas) {
            var zCtx = this._zonesCanvas.getContext('2d');
            zCtx.clearRect(0, 0, this._zonesCanvas.width, this._zonesCanvas.height);
            this._zonesCanvas = null;
        }
        if (this._tempCanvas) {
            var tCtx = this._tempCtx;
            if (tCtx) tCtx.clearRect(0, 0, this._tempCanvas.width, this._tempCanvas.height);
        }
        this._compositedImageDirty = true;
        this._ccDirty = true;
        this._shadowDirty = true;
        this._zonesDirty = true;
        this._imageBrushCache = null;
        this._imageBrushCacheSize = -1;
        this._workerQueue = [];
        this._workerPending = false;
    },
    resetMask: function() {
        var maskCtx = state.maskCanvas.getContext('2d');
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.fillStyle = 'white';
        maskCtx.fillRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
        state.currentPreset = -1;
        this._zonesDirty = true;
        this._shadowDirty = true;
        TokenPresets.updateButtons();
        TokenHistory.save();
        this.render();
        toast('Маска сброшена');
    },

    _renderProtectionMaskOverlay: function(size) {
        if (!state.erasableCanvas) return;

        var internalSize = this.internalSize;
        var maskSize = CONFIG.SCALE_SIZES[1];
        var offset = Math.round((internalSize - maskSize) / 2);

        var overlayCanvas = document.createElement('canvas');
        overlayCanvas.width = internalSize;
        overlayCanvas.height = internalSize;
        var oCtx = overlayCanvas.getContext('2d');

        var eData = state.erasableCanvas.getContext('2d').getImageData(0, 0, internalSize, internalSize);
        var oData = oCtx.createImageData(internalSize, internalSize);
        var ed = eData.data;
        var od = oData.data;

        for (var i = 0; i < ed.length; i += 4) {
            var isBlocked = ed[i + 3] < 128;
            od[i]     = isBlocked ? 255 : 0;
            od[i + 1] = isBlocked ? 80  : 0;
            od[i + 2] = isBlocked ? 80  : 0;
            od[i + 3] = isBlocked ? 120 : 0;
        }

        oCtx.putImageData(oData, 0, 0);
        this.ctx.drawImage(overlayCanvas, 0, 0);
    },
    
    resetImageMask: function() {
        if (!state.imageMaskCanvas) return;
        var ctx = state.imageMaskCanvas.getContext('2d');
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, state.imageMaskCanvas.width, state.imageMaskCanvas.height);
        this._invalidateComposite();
        TokenHistory.save();
        this.render();
        toast('Ластик сброшен');
    },

    save: function(withRing) {
        if (!state.userImage) {
            toast('Сначала загрузите изображение', true);
            return;
        }

        var result = this.renderForSave(withRing);
        var fileName = (state.tokenFileName.trim() || 'token') + '.webp';

        result.canvas.toBlob(async function(blob) {

            if (state.quickSaveEnabled && state.quickSaveFolder) {
                const ok = await saveToFolder(blob, fileName, state.quickSaveFolder);
                if (ok) toast('Сохранено: ' + fileName);
            } else {
                await saveFileWithPicker(blob, fileName);
            }
        }, 'image/webp', 0.95);
    },

    setEraserSize: function(size) {
        state.eraserSize = size;
        this._imageBrushCache = null;
        this._imageBrushCacheSize = -1;
        this.updateEraserBrush(size);
    }
};
