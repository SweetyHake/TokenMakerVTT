const HotkeySettings = {
    _listeningAction: null,
    _listeningEl: null,

    init() {
        this._renderTable();
        this._setupResetAll();
        document.addEventListener('keydown', e => this._onKey(e), true);
    },

    _renderTable() {
        const container = $('hotkeysEditorTable');
        if (!container) return;
        container.innerHTML = '';

        Object.entries(HOTKEYS_META).forEach(([action, meta]) => {
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
            btn.textContent = codeToLabel(AppConfig.hotkeys[action]);
            btn.onclick = () => this._startListening(action, btn);

            row.appendChild(labelEl);
            row.appendChild(btn);
            container.appendChild(row);
        });
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
        if (this._listeningEl) {
            this._listeningEl.classList.remove('listening');
            this._listeningEl = null;
        }
        this._listeningAction = null;
    },

    _onKey(e) {
        if (!this._listeningAction) return;
        if (e.code === 'Escape') { this._stopListening(); return; }
        if (['Control','Shift','Alt','Meta'].includes(e.key)) return;

        e.preventDefault();
        e.stopPropagation();

        const action = this._listeningAction;
        const btn = this._listeningEl;

        AppConfig.setHotkey(action, e.code);
        btn.textContent = codeToLabel(e.code);
        this._stopListening();
        toast('Клавиша назначена: ' + codeToLabel(e.code));
    },

    _setupResetAll() {
        const btn = $('hotkeysResetAllBtn');
        if (!btn) return;
        btn.onclick = () => {
            AppConfig.resetHotkeys();
            this._renderTable();
            toast('Горячие клавиши сброшены');
        };
    }
};
