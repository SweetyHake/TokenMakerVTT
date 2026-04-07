function $(id) {
    return document.getElementById(id);
}

function debounce(func, wait) {
    var timeout;
    return function() {
        var args = arguments;
        var context = this;
        clearTimeout(timeout);
        timeout = setTimeout(function() {
            func.apply(context, args);
        }, wait);
    };
}

function toast(msg, isError) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 2500);
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function getFileBaseName(filename) {
    return filename.replace(/\.[^.]+$/, '');
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function saveFileWithPicker(blob, suggestedName, mimeType) {
    if (window.showSaveFilePicker) {
        var ext = suggestedName.split('.').pop().toLowerCase();
        var mimeMap = {
            'webp': 'image/webp',
            'png':  'image/png',
            'jpg':  'image/jpeg',
            'jpeg': 'image/jpeg'
        };
        var mime = mimeMap[ext] || mimeType || 'application/octet-stream';
        var extLabel = ext.toUpperCase() + ' Image';

        return window.showSaveFilePicker({
            suggestedName: suggestedName,
            types: [{ description: extLabel, accept: { [mime]: ['.' + ext] } }]
        }).then(function(fileHandle) {
            return fileHandle.createWritable();
        }).then(function(writable) {
            return writable.write(blob).then(function() { return writable.close(); });
        }).then(function() {
            toast('Сохранено: ' + suggestedName);
        }).catch(function(err) {
            if (err.name !== 'AbortError') toast('Ошибка: ' + err.message, true);
        });
    }

    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = suggestedName;
    a.click();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    toast('Сохранено: ' + suggestedName);
    return Promise.resolve();
}
