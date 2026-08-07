self.onmessage = function(e) {
    var data = e.data;
    if (data.type !== 'applyBrush') return;

    var mask = new Uint8ClampedArray(data.maskData);
    var brush = new Uint8ClampedArray(data.brushData);
    var prot = data.protData ? new Uint8ClampedArray(data.protData) : null;

    var regionX = data.regionX;
    var regionY = data.regionY;
    var regionW = data.regionWidth;
    var regionH = data.regionHeight;

    for (var by = 0; by < data.brushHeight; by++) {
        var my = data.drawY + by;
        if (my < regionY || my >= regionY + regionH) continue;
        for (var bx = 0; bx < data.brushWidth; bx++) {
            var mx = data.drawX + bx;
            if (mx < regionX || mx >= regionX + regionW) continue;

            var brushAlpha = brush[(by * data.brushWidth + bx) * 4 + 3] / 255;
            if (brushAlpha <= 0) continue;

            var maskIdx = ((my - regionY) * regionW + (mx - regionX)) * 4 + 3;

            if (prot) {
                var protIdx = (by * data.brushWidth + bx) * 4 + 3;
                if (prot[protIdx] > 128) continue;
            }

            if (data.restore) {
                mask[maskIdx] = Math.min(255, mask[maskIdx] + brushAlpha * 255);
            } else {
                mask[maskIdx] = Math.max(0, mask[maskIdx] - brushAlpha * 255);
            }
        }
    }

    self.postMessage({
        type: 'brushDone',
        id: data.id,
        maskData: mask.buffer,
        regionX: regionX,
        regionY: regionY,
        regionWidth: regionW,
        regionHeight: regionH
    }, [mask.buffer]);
};
