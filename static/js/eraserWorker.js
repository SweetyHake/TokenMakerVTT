self.onmessage = function(e) {
    var data = e.data;
    if (data.type !== 'applyBrush') return;

    var mask = new Uint8ClampedArray(data.maskData);
    var brush = new Uint8ClampedArray(data.brushData);
    var prot = data.protData ? new Uint8ClampedArray(data.protData) : null;

    for (var by = 0; by < data.brushHeight; by++) {
        var my = data.drawY + by;
        if (my < 0 || my >= data.maskHeight) continue;
        for (var bx = 0; bx < data.brushWidth; bx++) {
            var mx = data.drawX + bx;
            if (mx < 0 || mx >= data.maskWidth) continue;

            var brushAlpha = brush[(by * data.brushWidth + bx) * 4 + 3] / 255;
            if (brushAlpha <= 0) continue;

            var maskIdx = (my * data.maskWidth + mx) * 4 + 3;

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

    self.postMessage({ type: 'brushDone', id: data.id, maskData: mask.buffer }, [mask.buffer]);
};
