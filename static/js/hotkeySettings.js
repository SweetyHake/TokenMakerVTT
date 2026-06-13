const HOTKEY_CATEGORIES = {
    'Инструменты': ['toolMove', 'toolEraser', 'toolMask', 'toolRemoveBg', 'toolAutoFrame'],
    'История': ['undo', 'redo'],
    'Трансформация': ['rotateLeft', 'rotateRight'],
    'Файлы': ['openFile', 'saveAll']
};

const HotkeySettings = {
    _listeningAction: null,
    _listeningEl: null,

    init() {
        this._renderTable();
        this._setupResetAll();
        this._setupSearch();
        document.addEventListener('keydown', e => this._onKey(e), true);
    },

    _renderTable(filterText) {
        const container = $('hotkeysEditorTable');
        if (!container) return;
        container.innerHTML = '';

        const search = (filterText || '').toLowerCase().trim();

        Object.entries(HOTKEY_CATEGORIES).forEach(([category, actions]) => {
            const items = actions
                .map(action => {
                    const meta = HOTKEYS_META[action];
                    if (!meta) return null;
                    const label = meta.label.toLowerCase();
                    const key = codeToLabel(AppConfig.hotkeys[action]).toLowerCase();
                    if (search && !label.includes(search) && !key.includes(search) && !category.toLowerCase().includes(search)) return null;
                    return { action, meta, label: meta.label, keyLabel: codeToLabel(AppConfig.hotkeys[action]) };
                })
                .filter(Boolean);

            if (search && items.length === 0) return;

            const sectionTitle = document.createElement('div');
            sectionTitle.className = 'hotkey-section-title';
            sectionTitle.textContent = category;
            container.appendChild(sectionTitle);

            items.forEach(({ action, meta, label, keyLabel }) => {
                const row = document.createElement('div');
                row.className = 'hotkey-editor-row';

                const labelEl = document.createElement('span');
                labelEl.className = 'hotkey-editor-label';
                if (meta.ctrl) {
                    const ctrlKbd = document.createElement('kbd');
                    ctrlKbd.textContent = 'Ctrl';
                    labelEl.appendChild(ctrlKbd);
                    labelEl.appendChild(document.createTextNode(' + '));
                }
                labelEl.appendChild(document.createTextNode(meta.label));

                const btn = document.createElement('button');
                btn.className = 'hotkey-bind-btn';
                btn.dataset.action = action;
                btn.textContent = keyLabel;
                btn.onclick = () => this._startListening(action, btn);

                row.appendChild(labelEl);
                row.appendChild(btn);
                container.appendChild(row);
            });
        });
    },

    _setupSearch() {
        const input = $('hotkeysSearch');
        if (!input) return;
        input.oninput = () => this._renderTable(input.value);
    },

    _startListening(action, btn) {
        if (this._listeningEl) {
            this._listeningEl.classList.remove('listening');
            this._listeningEl.textContent = codeToLabel(AppConfig.hotkeys[this._listeningAction]);
        }
        this._listeningAction = action;
        this._listeningEl = btn;
        btn.classList.add('listening');
        btn.textContent = '...';
    },

    _stopListening() {
        if (this._listeningEl) { this._listeningEl.classList.remove('listening'); this._listeningEl = null; }
        this._listeningAction = null;
    },

    _onKey(e) {
        if (!this._listeningAction) return;
        if (e.code === 'Escape') { this._stopListening(); return; }
        if (['Control','Shift','Alt','Meta'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        AppConfig.setHotkey(this._listeningAction, e.code);
        this._listeningEl.textContent = codeToLabel(e.code);
        this._stopListening();
        TokenEditor.updateToolHotkeys();
        toast('Клавиша назначена: ' + codeToLabel(e.code));
    },

    _setupResetAll() {
        const btn = $('hotkeysResetAllBtn');
        if (!btn) return;
        btn.onclick = () => {
            AppConfig.resetHotkeys();
            this._renderTable();
            TokenEditor.updateToolHotkeys();
            toast('Горячие клавиши сброшены');
        };
    }
};
