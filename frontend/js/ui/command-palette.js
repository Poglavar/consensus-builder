// ui/command-palette.js — the command palette: Ctrl/Cmd-K (or Settings → Command palette, or the
// search box's "Commands…" row) opens a centred list of every UiCommands capability, grouped,
// filtered as you type, keyboard navigable; unavailable commands are shown greyed with the reason
// when the registry knows it. A bottom sheet under 768px. groupPaletteItems is pure and exported
// for backend/test/frontend-command-palette.test.js; window.CommandPalette in the browser.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CommandPalette = api;
})(typeof window !== 'undefined' ? window : null, function (win) {
    'use strict';

    // Group ranked commands ([{ entry, label, rank, available, reason }], best first, as
    // UiCommands.rankCommands returns them) for display. Groups keep the registry's order
    // (`groupOrder`) until there is a query; then the group holding the best available match comes
    // first. Unavailable commands stay in their group, after the available ones.
    function groupPaletteItems(ranked, groupOrder, options = {}) {
        const order = new Map((groupOrder || []).map((group, index) => [group, index]));
        const byGroup = new Map();
        (ranked || []).forEach(item => {
            const group = item.entry.group;
            if (!byGroup.has(group)) byGroup.set(group, []);
            byGroup.get(group).push(item);
        });
        const groups = Array.from(byGroup.entries()).map(([group, items]) => {
            const sorted = items.slice().sort((a, b) => (b.available - a.available) || (a.rank - b.rank) || a.label.localeCompare(b.label));
            const availableRanks = sorted.filter(item => item.available).map(item => item.rank);
            return { group, items: sorted, best: availableRanks.length ? Math.min(...availableRanks) : Infinity };
        });
        const position = group => (order.has(group) ? order.get(group) : order.size);
        groups.sort((a, b) => (options.query ? (a.best - b.best) : 0) || (position(a.group) - position(b.group)));
        return groups.map(({ group, items }) => ({ group, items }));
    }

    // The registry's groups in the order their first command appears.
    function registryGroupOrder(commands) {
        const out = [];
        (commands || []).forEach(entry => { if (!out.includes(entry.group)) out.push(entry.group); });
        return out;
    }

    // Whether a toggle command's layer is on: true / false for a checkbox-backed toggle, null for
    // anything else (buttons, inputs, a control that is not in the page). The palette shows "On"
    // beside a toggle that is on — otherwise "Show parcel ids" read the same before and after.
    function toggleStateOf(entry, getElementById) {
        if (!entry || entry.kind !== 'toggle' || !entry.control || typeof getElementById !== 'function') return null;
        const el = getElementById(entry.control);
        return el && typeof el.checked === 'boolean' ? el.checked : null;
    }

    const pure = { groupPaletteItems, registryGroupOrder, toggleStateOf };
    if (!win || !win.document) return pure;

    const doc = win.document;
    const state = { initialized: false, backdrop: null, input: null, list: null, selectable: [], activeIndex: -1, returnFocus: null };

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (value && value !== key) return value;
        }
        return fallback;
    };
    const tKey = key => (win.i18n && typeof win.i18n.t === 'function' ? win.i18n.t(key) : key);
    const isMac = () => /Mac|iPhone|iPad/.test((win.navigator && (win.navigator.platform || win.navigator.userAgent)) || '');
    const searchModel = () => win.SearchModel;

    function el(tag, className, attrs) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (attrs) Object.keys(attrs).forEach(name => node.setAttribute(name, attrs[name]));
        return node;
    }

    function isOpen() {
        return !!(state.backdrop && !state.backdrop.hidden);
    }

    function render() {
        const commands = win.UiCommands;
        const query = state.input.value;
        const ranked = commands.rankCommands(query, commands.createBrowserContext(win), tKey);
        const groups = groupPaletteItems(ranked, registryGroupOrder(commands.listCommands()), { query: query.trim() });
        state.selectable = [];
        state.list.textContent = '';
        if (!groups.length) {
            const empty = el('div', 'command-palette__empty', { role: 'status' });
            empty.textContent = t('commandPalette.empty', 'No matching command');
            state.list.appendChild(empty);
        }
        let optionIndex = 0;
        groups.forEach(({ group, items }) => {
            const section = el('div', 'command-palette__group', { role: 'group' });
            const headingId = `command-palette-group-${group}`;
            const heading = el('div', 'command-palette__group-title', { id: headingId });
            heading.textContent = t(`commandPalette.groups.${group}`, group);
            section.setAttribute('aria-labelledby', headingId);
            section.appendChild(heading);
            items.forEach(item => {
                const option = el('div', 'command-palette__item', { id: `command-palette-option-${optionIndex++}`, role: 'option', 'aria-selected': 'false' });
                const iconNode = el('i', `command-palette__icon ${item.entry.icon}`, { 'aria-hidden': 'true' });
                const text = el('div', 'command-palette__text');
                const label = el('div', 'command-palette__label');
                label.textContent = item.label;
                text.appendChild(label);
                if (!item.available) {
                    option.setAttribute('aria-disabled', 'true');
                    option.classList.add('is-disabled');
                    if (item.reason && item.reason !== 'missing') {
                        const reason = el('div', 'command-palette__reason');
                        reason.textContent = t(`commandPalette.reason.${item.reason}`, '');
                        text.appendChild(reason);
                    }
                } else {
                    const index = state.selectable.length;
                    state.selectable.push(item);
                    option.addEventListener('mousedown', event => event.preventDefault());
                    option.addEventListener('mousemove', () => { if (state.activeIndex !== index) setActive(index); });
                    option.addEventListener('click', () => run(item));
                    option.dataset.index = String(index);
                }
                option.appendChild(iconNode);
                option.appendChild(text);
                const on = toggleStateOf(item.entry, id => doc.getElementById(id));
                if (on !== null) {
                    option.setAttribute('aria-checked', on ? 'true' : 'false');
                    if (on) {
                        const badge = el('span', 'command-palette__state');
                        badge.textContent = t('commandPalette.state.on', 'On');
                        option.appendChild(badge);
                    }
                }
                section.appendChild(option);
            });
            state.list.appendChild(section);
        });
        setActive(state.selectable.length ? 0 : -1);
    }

    function setActive(index) {
        state.activeIndex = index;
        const options = Array.from(state.list.querySelectorAll('[role="option"][data-index]'));
        options.forEach(option => option.setAttribute('aria-selected', option.dataset.index === String(index) ? 'true' : 'false'));
        const active = options.find(option => option.dataset.index === String(index));
        if (active) {
            state.input.setAttribute('aria-activedescendant', active.id);
            try { active.scrollIntoView({ block: 'nearest' }); } catch (_) { }
        } else {
            state.input.removeAttribute('aria-activedescendant');
        }
    }

    function run(item) {
        if (!item || !item.available) return;
        close({ restoreFocus: false });
        const commands = win.UiCommands;
        try {
            commands.runCommand(item.entry.id, commands.createBrowserContext(win));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [command-palette] ${item.entry.id} failed`, error);
            if (typeof win.updateStatus === 'function') win.updateStatus(`${item.label}: ${error.message}`);
        }
    }

    function onKeyDown(event) {
        if (event.isComposing) return;
        const action = searchModel().keyAction(event.key, state.activeIndex, state.selectable.length);
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if (action.type === 'move') setActive(action.index);
        else if (action.type === 'run') run(state.selectable[action.index]);
        else close({ restoreFocus: true });
    }

    function build() {
        const backdrop = el('div', 'command-palette-backdrop');
        backdrop.hidden = true;
        const dialog = el('div', 'command-palette', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'command-palette-title' });
        const title = el('h2', 'map-shell-sr-only', { id: 'command-palette-title' });
        const field = el('div', 'command-palette__field');
        field.appendChild(el('i', 'fas fa-terminal', { 'aria-hidden': 'true' }));
        const input = el('input', 'command-palette__input', {
            type: 'text', role: 'combobox', autocomplete: 'off', spellcheck: 'false',
            'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': 'command-palette-list'
        });
        field.appendChild(input);
        const list = el('div', 'command-palette__list', { id: 'command-palette-list', role: 'listbox' });
        const footer = el('div', 'command-palette__footer');
        dialog.appendChild(title);
        dialog.appendChild(field);
        dialog.appendChild(list);
        dialog.appendChild(footer);
        backdrop.appendChild(dialog);
        doc.body.appendChild(backdrop);
        Object.assign(state, { backdrop, input, list, title, footer });
        input.addEventListener('input', render);
        input.addEventListener('keydown', onKeyDown);
        backdrop.addEventListener('mousedown', event => {
            if (event.target === backdrop) close({ restoreFocus: true });
        });
        // A press anywhere in the dialog (a greyed command, a group title, the footer) keeps the
        // caret in the input, so ↑↓/Enter/Esc keep working and map hotkeys never see the keys.
        dialog.addEventListener('mousedown', event => {
            if (event.target !== input) event.preventDefault();
        });
    }

    function syncTexts() {
        const shortcut = isMac() ? '⌘K' : 'Ctrl K';
        doc.querySelectorAll('[data-command-palette-shortcut]').forEach(node => { node.textContent = shortcut; });
        if (!state.input) return;
        state.title.textContent = t('commandPalette.title', 'Command palette');
        state.input.placeholder = t('commandPalette.placeholder', 'Type a command…');
        state.input.setAttribute('aria-label', t('commandPalette.title', 'Command palette'));
        state.footer.textContent = t('commandPalette.hint', '↑↓ to move · Enter to run · Esc to close');
        if (isOpen()) render();
    }

    function open(query) {
        if (!state.initialized) throw new Error('CommandPalette: not initialized');
        if (!isOpen()) state.returnFocus = doc.activeElement;
        if (win.MapShell && typeof win.MapShell.closeSheets === 'function') win.MapShell.closeSheets();
        state.backdrop.hidden = false;
        doc.body.classList.add('command-palette-open');
        state.input.value = typeof query === 'string' ? query : '';
        render();
        state.input.focus();
    }

    function close(options = {}) {
        if (!isOpen()) return;
        state.backdrop.hidden = true;
        doc.body.classList.remove('command-palette-open');
        const back = state.returnFocus;
        state.returnFocus = null;
        if (options.restoreFocus && back && typeof back.focus === 'function' && doc.contains(back)) {
            try { back.focus({ preventScroll: true }); } catch (_) { }
        }
    }

    function isTypingTarget(target) {
        if (!target) return false;
        if (target.isContentEditable) return true;
        const tag = (target.tagName || '').toLowerCase();
        if (tag === 'textarea' || tag === 'select') return true;
        if (tag !== 'input') return false;
        const type = (target.getAttribute('type') || 'text').toLowerCase();
        return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file', 'reset'].includes(type);
    }

    // Ctrl/Cmd-K toggles the palette — except while typing in some other text field, where the
    // keystroke belongs to that field. The search box and the palette's own input are ours.
    function onDocumentKeyDown(event) {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
        if (String(event.key).toLowerCase() !== 'k') return;
        const target = event.target;
        const ours = target && (target.id === 'map-search-input' || target === state.input);
        if (!ours && isTypingTarget(target)) return;
        if (isOpen()) {
            event.preventDefault();
            close({ restoreFocus: true });
            return;
        }
        // Not over a modal, a confirm or the globe (it would open underneath and take the focus),
        // and not in share-plan mode, where the map is pan/zoom only.
        if (win.sharePlanMode) return;
        if (win.MapShell && typeof win.MapShell.isBlockingDialogOpen === 'function' && win.MapShell.isBlockingDialogOpen(state.backdrop)) return;
        event.preventDefault();
        let query = '';
        if (target && target.id === 'map-search-input') {
            const typed = String(target.value || '').trim();
            query = typed.startsWith('>') ? typed.slice(1).trim() : '';
            if (win.MapSearch) win.MapSearch.close();
        }
        open(query);
    }

    function initialize() {
        if (state.initialized) return;
        if (!win.UiCommands || !win.SearchModel) throw new Error('CommandPalette: js/ui/commands.js and js/ui/search-model.js must load first');
        state.initialized = true;
        build();
        syncTexts();
        doc.addEventListener('keydown', onDocumentKeyDown);
        // The translations arriving after boot, and a live language switch.
        win.addEventListener('i18n:translationsLoaded', syncTexts);
        if (win.i18n && typeof win.i18n.onChange === 'function') win.i18n.onChange(syncTexts);
        const button = doc.getElementById('command-palette-button');
        if (button) button.addEventListener('click', () => open(''));
    }

    return Object.assign({}, pure, { initialize, open, close: () => close({ restoreFocus: true }), isOpen });
});
