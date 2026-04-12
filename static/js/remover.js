const Remover = {
    init() {
        this.setupDeviceInfo();
        this.setupFormatControls();
        this.setupDropzone();
        this.setupResultsControls();
        this.setupCompareModal();
    },
    
    setupDeviceInfo() {
        fetch('/device').then(r => r.json()).then(d => {
            const info = $('deviceInfo');
            const badge = $('deviceBadge');
            if (info) info.textContent = d.device;
            if (badge && (d.device.includes('GPU') || d.device.includes('DirectML') || d.device.includes('CUDA'))) {
                badge.classList.add('gpu');
            }
        }).catch(() => {
            const info = $('deviceInfo');
            if (info) info.textContent = 'CPU';
        });
    },
    
    setupFormatControls() {
        const formatSelect = $('formatSelect');
        if (formatSelect) {
            formatSelect.onchange = e => {
                state.selectedFormat = e.target.value;
                toast(`Формат: ${state.selectedFormat.toUpperCase()}`);
            };
        }

        const qualitySlider = $('qualitySlider');
        const qualityValue = $('qualityValue');
        if (qualitySlider) {
            qualitySlider.oninput = e => {
                state.selectedQuality = parseInt(e.target.value);
                if (qualityValue) qualityValue.textContent = state.selectedQuality + '%';
            };
        }
    },
    
    setupDropzone() {
        const dropzone = $('dropzone');
        const fileInput = $('fileInput');
        if (!dropzone || !fileInput) return;

        dropzone.onclick = e => {
            e.stopPropagation();
            fileInput.click();
        };

        dropzone.ondragover = e => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        };

        dropzone.ondragleave = () => dropzone.classList.remove('dragover');

        dropzone.ondrop = e => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            this.handleFiles(Array.from(e.dataTransfer.files));
        };

        fileInput.onchange = e => {
            this.handleFiles(Array.from(e.target.files));
            fileInput.value = '';
        };
    },
    
    setupResultsControls() {
        const clearAllBtn = $('clearAllBtn');
        if (clearAllBtn) clearAllBtn.onclick = () => this.clearAll();

        const downloadAllBtn = $('downloadAllBtn');
        if (downloadAllBtn) downloadAllBtn.onclick = () => this.downloadAll();
    },
    
    setupCompareModal() {
        const closeCompare = $('closeCompare');
        if (closeCompare) {
            closeCompare.onclick = () => {
                $('compareModal').classList.remove('show');
                if (this._compareMouseMove) {
                    document.removeEventListener('mousemove', this._compareMouseMove);
                    document.removeEventListener('mouseup', this._compareMouseUp);
                    this._compareMouseMove = null;
                    this._compareMouseUp = null;
                }
            };
        }

        const compareModal = $('compareModal');
        if (compareModal) {
            compareModal.onclick = e => {
                if (e.target === compareModal) {
                    compareModal.classList.remove('show');
                    if (this._compareMouseMove) {
                        document.removeEventListener('mousemove', this._compareMouseMove);
                        document.removeEventListener('mouseup', this._compareMouseUp);
                        this._compareMouseMove = null;
                        this._compareMouseUp = null;
                    }
                }
            };
        }
    },
    
    handleFiles(files) {
        const imageFiles = files.filter(f => f.type.startsWith('image/'));
        if (imageFiles.length === 0) return;

        const emptyState = $('emptyState');
        if (emptyState) emptyState.style.display = 'none';

        const resultsHeader = $('resultsHeader');
        if (resultsHeader) resultsHeader.classList.add('show');

        imageFiles.forEach(file => {
            const id = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            this.createResultCard(id, file);
            state.processingQueue.push({ id, file });
        });

        this.updateResultsCount();
        this.processQueue();
    },
    
    createResultCard(id, file) {
        const card = document.createElement('div');
        card.className = 'result-card';
        card.id = id;

        const reader = new FileReader();
        reader.onload = e => {
            state.originalImages.set(id, e.target.result);

            const preview = document.createElement('div');
            preview.className = 'result-preview';

            const img = document.createElement('img');
            img.src = e.target.result;
            img.alt = '';

            const overlay = document.createElement('div');
            overlay.className = 'loading-overlay';

            const spinner = document.createElement('div');
            spinner.className = 'spinner';

            const label = document.createElement('div');
            label.style.cssText = 'font-size: 0.7rem; color: #9ca3af;';
            label.textContent = 'Обработка...';

            overlay.appendChild(spinner);
            overlay.appendChild(label);
            preview.appendChild(img);
            preview.appendChild(overlay);

            const safeName = file.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const info = document.createElement('div');
            info.className = 'result-info';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'result-name';
            nameSpan.title = safeName;
            nameSpan.textContent = file.name;

            const dlBtn = document.createElement('button');
            dlBtn.className = 'download-btn';
            dlBtn.disabled = true;
            dlBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`;

            info.appendChild(nameSpan);
            info.appendChild(dlBtn);
            card.appendChild(preview);
            card.appendChild(info);
        };
        reader.readAsDataURL(file);

        $('resultsGrid').insertBefore(card, $('resultsGrid').firstChild);
    },
    
    async processQueue() {
        if (state.isProcessing || state.processingQueue.length === 0) return;
        
        state.isProcessing = true;
        const total = state.processingQueue.length + state.results.size;
        
        $('batchProgress').classList.add('show');
        
        while (state.processingQueue.length > 0) {
            const { id, file } = state.processingQueue.shift();
            const done = state.results.size;
            
            $('progressFill').style.width = `${(done / total) * 100}%`;
            $('progressText').textContent = `${done} / ${total}`;
            
            await this.processFile(id, file);
        }
        
        $('progressFill').style.width = '100%';
        $('progressText').textContent = `${state.results.size} / ${state.results.size}`;
        
        setTimeout(() => {
            $('batchProgress').classList.remove('show');
        }, 1000);
        
        state.isProcessing = false;
    },
    
    async processFile(id, file) {
        const fd = new FormData();
        fd.append('image', file);
        fd.append('format', state.selectedFormat);
        fd.append('quality', state.selectedQuality);

        const start = Date.now();

        try {
            const res = await fetch('/process', { method: 'POST', body: fd });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: 'Ошибка сервера' }));
                throw new Error(errData.error || 'Ошибка');
            }

            const blob = await res.blob();
            const time = ((Date.now() - start) / 1000).toFixed(1);

            const ext = state.selectedFormat === 'jpg' ? 'jpg' : state.selectedFormat;
            const baseName = file.name.replace(/\.[^.]+$/, '');
            const newName = baseName + '.' + ext;
            state.results.set(id, { blob, name: newName, format: state.selectedFormat });

            const card = $(id);
            if (!card) return;
            const preview = card.querySelector('.result-preview');
            const info = card.querySelector('.result-info');

            urlManager.revoke(id);
            const imgUrl = urlManager.create(blob, id);

            const img = document.createElement('img');
            img.src = imgUrl;
            img.alt = '';
            preview.innerHTML = '';
            preview.appendChild(img);
            preview.onclick = () => this.showCompare(id);
            preview.style.cursor = 'pointer';
            preview.title = 'Нажмите для сравнения';

            const safeNewName = newName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeBlobSize = formatSize(blob.size);

            const infoText = document.createElement('div');
            infoText.className = 'result-info-text';
            infoText.innerHTML = `
                <span class="result-name" title="${safeNewName}">${safeNewName}</span>
                <div class="result-stats">
                    <span>${safeBlobSize}</span> • ${time}s
                </div>
            `;

            const btnWrap = document.createElement('div');
            btnWrap.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'download-btn';
            copyBtn.title = 'Копировать в буфер';
            copyBtn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
            copyBtn.onclick = () => this.copyToClipboard(id);

            const dlBtn = document.createElement('button');
            dlBtn.className = 'download-btn';
            dlBtn.title = 'Скачать';
            dlBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`;
            dlBtn.onclick = () => this.downloadOne(id);

            btnWrap.appendChild(copyBtn);
            btnWrap.appendChild(dlBtn);

            info.innerHTML = '';
            info.appendChild(infoText);
            info.appendChild(btnWrap);

            this.updateDownloadAllBtn();
            this.updateResultsCount();

        } catch (err) {
            const card = $(id);
            if (card) {
                const overlay = card.querySelector('.loading-overlay');
                if (overlay) {
                    const errDiv = document.createElement('div');
                    errDiv.style.color = '#f87171';
                    errDiv.textContent = 'Ошибка';
                    const msgDiv = document.createElement('div');
                    msgDiv.style.cssText = 'font-size: 0.65rem; color: #6b7280;';
                    msgDiv.textContent = err.message;
                    overlay.innerHTML = '';
                    overlay.appendChild(errDiv);
                    overlay.appendChild(msgDiv);
                }
            }
        }
    },
    
    showCompare(id) {
        const original = state.originalImages.get(id);
        const result = state.results.get(id);
        if (!original || !result) return;
        
        const resultUrl = urlManager.create(result.blob, id + '_compare');
        
        $('compareBefore').style.backgroundImage = `url(${original})`;
        $('compareAfter').style.backgroundImage = `url(${resultUrl})`;
        $('compareModal').classList.add('show');
        
        this.initCompareSlider();
    },
    
    initCompareSlider() {
        const slider = $('compareSlider');
        const handle = $('compareHandle');
        const before = $('compareBefore');
        let isDragging = false;

        function updatePosition(x) {
            const rect = slider.getBoundingClientRect();
            let pos = (x - rect.left) / rect.width;
            pos = Math.max(0, Math.min(1, pos));
            handle.style.left = `${pos * 100}%`;
            before.style.clipPath = `inset(0 ${(1 - pos) * 100}% 0 0)`;
        }

        const onMouseMove = e => { if (isDragging) updatePosition(e.clientX); };
        const onMouseUp = () => { isDragging = false; };

        handle.onmousedown = () => { isDragging = true; };

        if (this._compareMouseMove) {
            document.removeEventListener('mousemove', this._compareMouseMove);
            document.removeEventListener('mouseup', this._compareMouseUp);
        }

        this._compareMouseMove = onMouseMove;
        this._compareMouseUp = onMouseUp;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        slider.onclick = e => updatePosition(e.clientX);

        updatePosition(slider.getBoundingClientRect().left + slider.offsetWidth / 2);
    },
    
    downloadOne(id) {
        const data = state.results.get(id);
        if (!data) return;
        saveFileWithPicker(data.blob, data.name);
    },
    
    async downloadAll() {
        if (state.results.size === 0) return;
        const entries = Array.from(state.results.entries());

        const folderPath = await pickFolder();
        if (!folderPath) return;

        AppConfig.setLastFolder('remover', folderPath);

        let saved = 0;
        for (const [id, data] of entries) {
            const ok = await saveToFolder(data.blob, data.name, folderPath);
            if (ok) saved++;
        }
        toast('Сохранено ' + saved + ' файлов');
    },
    
    clearAll() {
        urlManager.revokeAll();
        state.results.clear();
        state.originalImages.clear();
        state.processingQueue = [];

        const grid = $('resultsGrid');
        grid.innerHTML = '';

        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.id = 'emptyState';
        emptyState.innerHTML = `
            <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            <p>Результаты появятся здесь</p>
        `;
        grid.appendChild(emptyState);

        const resultsHeader = $('resultsHeader');
        if (resultsHeader) resultsHeader.classList.remove('show');

        this.updateDownloadAllBtn();
        toast('Очищено');
    },
    
    updateDownloadAllBtn() {
        const dlBtn = $('downloadAllBtn');
        const clearBtn = $('clearAllBtn');
        if (state.results.size > 0) {
            dlBtn.style.display = 'inline-flex';
            dlBtn.innerHTML = `
                <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                Скачать все (${state.results.size})
            `;
            clearBtn.style.display = 'inline-flex';
        } else {
            dlBtn.style.display = 'none';
            clearBtn.style.display = 'none';
        }
    },
    
    async copyToClipboard(id) {
        const data = state.results.get(id);
        if (!data) return;

        try {
            let pngBlob = data.blob;
            if (data.format !== 'png') {
                const bitmap = await createImageBitmap(data.blob);
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
                pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            }
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': pngBlob })
            ]);
            toast('Скопировано в буфер');
        } catch {
            toast('Не удалось скопировать', true);
        }
    },
    
    updateResultsCount() {
        const cards = document.querySelectorAll('.result-card').length;
        const el = $('resultsCount');
        if (el) el.textContent = cards > 0 ? `${cards} файлов` : '';
    }
};