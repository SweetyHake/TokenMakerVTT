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

async function saveFileWithPicker(blob, suggestedName) {
    const fd = new FormData();
    fd.append('file', blob, suggestedName);
    fd.append('filename', suggestedName);

    try {
        const res = await fetch('/save_file', { method: 'POST', body: fd });
        const json = await res.json();
        if (json.cancelled) return;
        if (json.error) { toast('Ошибка: ' + json.error, true); return; }
        toast('Сохранено: ' + suggestedName);
    } catch(e) {
        toast('Ошибка сохранения', true);
    }
}

async function pickFolder() {
    try {
        const res = await fetch('/pick_folder');
        const json = await res.json();
        if (json.cancelled || !json.path) return null;
        return json.path;
    } catch(e) {
        toast('Ошибка выбора папки', true);
        return null;
    }
}

async function saveToFolder(blob, filename, folderPath) {
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('filename', filename);
    fd.append('folder', folderPath);

    try {
        const res = await fetch('/save_to_folder', { method: 'POST', body: fd });
        const json = await res.json();
        if (json.error) { toast('Ошибка: ' + json.error, true); return false; }
        toast('Сохранено: ' + filename);
        return true;
    } catch(e) {
        toast('Ошибка сохранения', true);
        return false;
    }
}
