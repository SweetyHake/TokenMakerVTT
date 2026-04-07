function createDropShadow(sourceCanvas) {
    const size = sourceCanvas.width;
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = size;
    shadowCanvas.height = size;
    const shadowCtx = shadowCanvas.getContext('2d');

    const scale = size / 1024;
    const s = state.dropShadowSettings;
    const angleRad = s.angle * Math.PI / 180;
    const distance = s.distance * scale;
    const offsetX = Math.cos(angleRad) * distance;
    const offsetY = -Math.sin(angleRad) * distance;
    const blurRadius = s.blur * scale;
    const opacity = s.opacity;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = size;
    tempCanvas.height = size;
    const tempCtx = tempCanvas.getContext('2d');

    tempCtx.drawImage(sourceCanvas, offsetX, offsetY);

    const imgData = tempCtx.getImageData(0, 0, size, size);
    const data = imgData.data;

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = Math.round(data[i + 3] * opacity);
        }
    }

    tempCtx.putImageData(imgData, 0, 0);

    shadowCtx.filter = `blur(${blurRadius}px)`;
    shadowCtx.drawImage(tempCanvas, 0, 0);
    shadowCtx.filter = 'none';

    return shadowCanvas;
}

function applyColorCorrection(canvas) {
    const correctedCanvas = document.createElement('canvas');
    correctedCanvas.width = canvas.width;
    correctedCanvas.height = canvas.height;
    const correctedCtx = correctedCanvas.getContext('2d');

    correctedCtx.drawImage(canvas, 0, 0);

    const imgData = correctedCtx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;

    const s = state.colorCorrectionSettings;
    const saturationAdjust = s.saturation / 100;
    const lightnessAdjust = s.lightness / 100;

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;

        let r = data[i] / 255;
        let g = data[i + 1] / 255;
        let b = data[i + 2] / 255;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        let l = (max + min) / 2;

        let h = 0;
        let sat = 0;

        if (d !== 0) {
            sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) {
                h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            } else if (max === g) {
                h = ((b - r) / d + 2) / 6;
            } else {
                h = ((r - g) / d + 4) / 6;
            }
        }

        sat = sat + saturationAdjust * (1 - sat);
        sat = Math.max(0, Math.min(1, sat));

        l = l + lightnessAdjust * (lightnessAdjust > 0 ? (1 - l) : l);
        l = Math.max(0, Math.min(1, l));

        let r1, g1, b1;

        if (sat === 0) {
            r1 = g1 = b1 = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
            const p = 2 * l - q;
            r1 = hue2rgb(p, q, h + 1 / 3);
            g1 = hue2rgb(p, q, h);
            b1 = hue2rgb(p, q, h - 1 / 3);
        }

        data[i] = Math.round(r1 * 255);
        data[i + 1] = Math.round(g1 * 255);
        data[i + 2] = Math.round(b1 * 255);
    }

    correctedCtx.putImageData(imgData, 0, 0);
    return correctedCanvas;
}

function downscaleCanvas(source, targetWidth, targetHeight) {
    if (source.width === targetWidth && source.height === targetHeight) {
        return source;
    }
    
    let current = source;
    let currentWidth = source.width;
    let currentHeight = source.height;
    
    while (currentWidth > targetWidth * 2 || currentHeight > targetHeight * 2) {
        const nextWidth = Math.max(Math.ceil(currentWidth / 2), targetWidth);
        const nextHeight = Math.max(Math.ceil(currentHeight / 2), targetHeight);
        
        const next = document.createElement('canvas');
        next.width = nextWidth;
        next.height = nextHeight;
        const nextCtx = next.getContext('2d');
        nextCtx.imageSmoothingEnabled = true;
        nextCtx.imageSmoothingQuality = 'high';
        nextCtx.drawImage(current, 0, 0, nextWidth, nextHeight);
        
        current = next;
        currentWidth = nextWidth;
        currentHeight = nextHeight;
    }
    
    if (currentWidth !== targetWidth || currentHeight !== targetHeight) {
        const final = document.createElement('canvas');
        final.width = targetWidth;
        final.height = targetHeight;
        const finalCtx = final.getContext('2d');
        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = 'high';
        finalCtx.drawImage(current, 0, 0, targetWidth, targetHeight);
        return final;
    }
    
    return current;
}