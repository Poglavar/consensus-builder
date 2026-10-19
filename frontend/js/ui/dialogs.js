// The one dialog: every blocking box in the app is built here on the cb-dialog primitive
// (css/primitives.css, docs/design-language.md). open() returns the box for a surface to fill;
// confirm / alert / choice / prompt are the message forms every script uses instead of the
// browser's own. One chrome, one close button, one stacking rung, one phone behaviour (a bottom
// sheet), focus kept inside and given back on close, Escape through the modal router.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CbDialog = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const SIZES = new Set(['sm', 'md', 'lg', 'xl']);
    const ROLE_CLASS = {
        primary: 'btn btn-primary',
        success: 'btn btn-success',
        danger: 'btn btn-danger',
        quiet: 'btn btn-quiet',
        secondary: 'btn'
    };
    let sequence = 0;

    function doc() {
        return root && root.document ? root.document : null;
    }

    function translate(key, fallback) {
        try {
            const value = root.i18n && typeof root.i18n.t === 'function' ? root.i18n.t(key) : null;
            return value && value !== key ? value : fallback;
        } catch (_) {
            return fallback;
        }
    }

    /** A message with newlines becomes lines separated by <br>; never HTML. */
    function renderLines(container, message) {
        const lines = String(message == null ? '' : message).split('\n');
        lines.forEach((line, index) => {
            container.appendChild(doc().createTextNode(line));
            if (index < lines.length - 1) container.appendChild(doc().createElement('br'));
        });
    }

    function appendBody(container, node) {
        if (node == null) return;
        if (typeof node === 'string') {
            const wrapper = doc().createElement('div');
            wrapper.innerHTML = node;
            while (wrapper.firstChild) container.appendChild(wrapper.firstChild);
            return;
        }
        if (Array.isArray(node)) {
            node.forEach(item => appendBody(container, item));
            return;
        }
        if (typeof node === 'object' && typeof node.nodeType === 'number') container.appendChild(node);
    }

    /** The box's classes: its size, the message form, a fixed height, the surface's identity. */
    function dialogClassName(options, size) {
        return `cb-dialog cb-dialog--${size}`
            + (options.message ? ' cb-dialog--message' : '')
            + (options.fixedHeight ? ' cb-dialog--fixed' : '')
            + (options.className ? ' ' + options.className : '');
    }

    function focusable(dialog) {
        return Array.from(dialog.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(el => !el.hidden && el.getClientRects().length > 0);
    }

    /**
     * Opens a dialog. Returns { overlay, dialog, modal, header, body, footer, close(result),
     * getActionButton(id), setTitle(text), closed: Promise<result> }.
     *
     * options: title (text), size ('sm'|'md'|'lg'|'xl'), className (identity class for the
     * surface's own inner rules), overlayClassName, body (Node | HTML string | array of them),
     * actions ([{ id, label, role, onClick(api), keepOpen, disabled, autofocus }]), message (bool:
     * no header, the body is the message), role ('dialog'|'alertdialog'), top (bool: over another
     * dialog), confirm (bool: the confirm rung, over everything), closeOnBackdrop, closeOnEscape,
     * showClose, closeLabel, autoCloseActions, onClose(result), stackActions (bool), fixedHeight
     * (bool: content that changes while open keeps one box, the body scrolls; see dialogClassName).
     */
    function open(options = {}) {
        const d = doc();
        if (!d) return null;
        const id = ++sequence;
        const size = SIZES.has(options.size) ? options.size : 'md';
        const closeOnBackdrop = options.closeOnBackdrop !== false;
        const closeOnEscape = options.closeOnEscape !== false;
        const autoCloseActions = options.autoCloseActions !== false;
        const closeLabel = options.closeLabel || translate('modal.common.close', 'Close');
        const previousFocus = d.activeElement;

        const overlay = d.createElement('div');
        overlay.className = 'cb-dialog-overlay'
            + (options.confirm ? ' cb-dialog-overlay--confirm' : options.top ? ' cb-dialog-overlay--top' : '')
            + (options.overlayClassName ? ' ' + options.overlayClassName : '');

        const dialog = d.createElement('div');
        dialog.className = dialogClassName(options, size);
        dialog.setAttribute('role', options.role === 'alertdialog' ? 'alertdialog' : 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.tabIndex = -1;

        let header = null;
        let titleEl = null;
        if (!options.message) {
            header = d.createElement('div');
            header.className = 'cb-dialog__header';
            titleEl = d.createElement('h2');
            titleEl.className = 'cb-dialog__title';
            titleEl.id = `cb-dialog-title-${id}`;
            titleEl.textContent = options.title || '';
            header.appendChild(titleEl);
            dialog.setAttribute('aria-labelledby', titleEl.id);
            if (options.showClose !== false) {
                const closeBtn = d.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'close-circle-btn';
                closeBtn.setAttribute('aria-label', closeLabel);
                closeBtn.innerHTML = '&times;';
                closeBtn.addEventListener('click', () => close(null));
                header.appendChild(closeBtn);
            }
            dialog.appendChild(header);
        }

        const body = d.createElement('div');
        body.className = 'cb-dialog__body' + (options.bodyClassName ? ' ' + options.bodyClassName : '');
        body.id = `cb-dialog-body-${id}`;
        appendBody(body, options.body);
        dialog.appendChild(body);
        if (options.message) dialog.setAttribute('aria-describedby', body.id);

        const actions = Array.isArray(options.actions) ? options.actions.filter(Boolean) : [];
        let footer = null;
        const buttons = [];
        if (actions.length) {
            footer = d.createElement('div');
            footer.className = 'cb-dialog__footer'
                + (options.stackActions || actions.length > 2 ? ' cb-dialog__footer--stack'
                    : options.message ? ' cb-dialog__footer--split' : '')
                + (options.footerClassName ? ' ' + options.footerClassName : '');
            actions.forEach(action => {
                const button = d.createElement('button');
                button.type = 'button';
                const role = action.role || (action.primary ? 'primary' : 'secondary');
                button.className = ROLE_CLASS[role] || ROLE_CLASS.secondary;
                if (action.className) button.className += ' ' + action.className;
                button.textContent = action.label || closeLabel;
                if (action.id != null) button.setAttribute('data-action-id', String(action.id));
                if (action.disabled) button.disabled = true;
                button.addEventListener('click', event => {
                    if (button.disabled) { event.preventDefault(); return; }
                    const result = action.value !== undefined ? action.value : (action.id != null ? action.id : true);
                    if (autoCloseActions && action.keepOpen !== true) close(result);
                    if (typeof action.onClick === 'function') action.onClick(api, event);
                });
                footer.appendChild(button);
                buttons.push({ action, button });
            });
            dialog.appendChild(footer);
        }

        overlay.appendChild(dialog);
        d.body.appendChild(overlay);

        let closed = false;
        let resolveClosed = null;
        const closedPromise = new Promise(resolve => { resolveClosed = resolve; });

        function onKeydown(event) {
            if (event.key !== 'Tab') return;
            const targets = focusable(dialog);
            if (!targets.length) { event.preventDefault(); return; }
            const current = targets.indexOf(d.activeElement);
            if (current === -1) {
                event.preventDefault();
                targets[event.shiftKey ? targets.length - 1 : 0].focus({ preventScroll: true });
                return;
            }
            if (!event.shiftKey && current === targets.length - 1) {
                event.preventDefault();
                targets[0].focus({ preventScroll: true });
            } else if (event.shiftKey && current === 0) {
                event.preventDefault();
                targets[targets.length - 1].focus({ preventScroll: true });
            }
        }

        function onOverlayClick(event) {
            if (closeOnBackdrop && event.target === overlay) close(null);
        }

        // A message dialog (confirm, alert, choice, prompt) owns the keyboard while it is up: Tab
        // stays inside even when the focus was stolen, Enter from outside the box takes the primary
        // answer, and no key reaches the page behind (drawing hotkeys listen on document too).
        function onDocumentKeydown(event) {
            if (event.key === 'Tab' && !dialog.contains(d.activeElement)) {
                event.preventDefault();
                const targets = focusable(dialog);
                if (targets.length) targets[event.shiftKey ? targets.length - 1 : 0].focus({ preventScroll: true });
            } else if (event.key === 'Enter' && !dialog.contains(d.activeElement)) {
                event.preventDefault();
                const primary = buttons.find(entry => entry.action.autofocus) || buttons.find(entry => /btn-primary|btn-success/.test(entry.button.className));
                if (primary && !primary.button.disabled) primary.button.click();
            }
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        }

        function close(result) {
            if (closed) return;
            closed = true;
            try { unregisterEscape && unregisterEscape(); } catch (_) { /* already gone */ }
            overlay.removeEventListener('click', onOverlayClick);
            dialog.removeEventListener('keydown', onKeydown);
            if (ownsKeyboard) d.removeEventListener('keydown', onDocumentKeydown, true);
            try { overlay.remove(); } catch (_) { /* detached */ }
            if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
                try { previousFocus.focus({ preventScroll: true }); } catch (_) { /* fine */ }
            }
            try { if (typeof options.onClose === 'function') options.onClose(result); } catch (_) { /* the caller's */ }
            resolveClosed(result);
        }

        const unregisterEscape = closeOnEscape && root.ModalEscape && typeof root.ModalEscape.register === 'function'
            ? root.ModalEscape.register(overlay, () => close(null))
            : null;
        overlay.addEventListener('click', onOverlayClick);
        dialog.addEventListener('keydown', onKeydown);
        const ownsKeyboard = !!(options.message || options.confirm);
        if (ownsKeyboard) d.addEventListener('keydown', onDocumentKeydown, true);

        const api = {
            overlay,
            dialog,
            modal: dialog,
            header,
            body,
            footer,
            close,
            closed: closedPromise,
            getActionButton(actionId) {
                const hit = buttons.find(entry => String(entry.action.id) === String(actionId));
                return hit ? hit.button : null;
            },
            setTitle(text) { if (titleEl) titleEl.textContent = text || ''; }
        };

        // Focus after layout: a synchronous focus from inside another handler loses to whatever
        // refocuses afterwards (the map container does).
        const autofocusEntry = buttons.find(entry => entry.action.autofocus) || buttons.find(entry => /primary|success|danger/.test(entry.button.className) && !entry.button.disabled);
        const focusTarget = options.autofocus === false ? null : (options.initialFocus || (autofocusEntry ? autofocusEntry.button : (focusable(dialog)[0] || dialog)));
        const raf = typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame.bind(root) : (fn => setTimeout(fn, 0));
        raf(() => { if (!closed && focusTarget) try { focusTarget.focus({ preventScroll: true }); } catch (_) { /* fine */ } });
        return api;
    }

    /**
     * The two answers of a confirm. A destructive confirm ("Discard") must not be the inviting
     * primary: the safe choice (cancel, keep editing) becomes the primary and the OK reads as
     * destructive. Pure, so the ordering is unit-tested (backend/test/dialogs-helper.test.js).
     */
    function confirmActions(options = {}, t = translate) {
        const okText = options.okText || t('common.ok', 'OK');
        const cancelText = options.cancelText || t('common.cancel', 'Cancel');
        return options.destructive
            ? [{ id: 'cancel', value: false, label: cancelText, role: 'primary', autofocus: true }, { id: 'ok', value: true, label: okText, role: 'danger' }]
            : [{ id: 'cancel', value: false, label: cancelText, role: 'secondary' }, { id: 'ok', value: true, label: okText, role: 'primary', autofocus: true }];
    }

    /**
     * A message with a {{txLink}} placeholder, split into parts: { text } runs, { link } marks and
     * { br } line breaks, in order. Pure; alert() renders it.
     */
    function linkedMessageParts(message, placeholder = '{{txLink}}') {
        const parts = [];
        String(message == null ? '' : message).split('\n').forEach((line, lineIndex, lines) => {
            line.split(placeholder).forEach((part, partIndex, pieces) => {
                if (part) parts.push({ text: part });
                if (partIndex < pieces.length - 1) parts.push({ link: true });
            });
            if (lineIndex < lines.length - 1) parts.push({ br: true });
        });
        return parts;
    }

    /** confirm(message, { okText, cancelText, destructive, title }) → Promise<boolean> */
    function confirm(message, options = {}) {
        const actions = confirmActions(options);
        const body = doc().createElement('div');
        renderLines(body, message);
        const api = open({
            message: !options.title, title: options.title, size: 'sm', confirm: true, role: 'alertdialog',
            className: 'cb-dialog--confirm' + (options.className ? ' ' + options.className : ''),
            body, actions
        });
        return api ? api.closed.then(result => result === true) : Promise.resolve(false);
    }

    /** alert(message, { okText, title, linkUrl, linkText }) → Promise<void> */
    function alert(message, options = {}) {
        const body = doc().createElement('div');
        const text = String(message == null ? '' : message);
        if (options.linkUrl && text.includes('{{txLink}}')) {
            linkedMessageParts(text).forEach(part => {
                if (part.br) { body.appendChild(doc().createElement('br')); return; }
                if (part.link) {
                    const link = doc().createElement('a');
                    link.href = options.linkUrl;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.className = 'cb-link cb-link--external';
                    link.textContent = options.linkText || translate('common.seeTransaction', 'See the transaction');
                    body.appendChild(link);
                    return;
                }
                body.appendChild(doc().createTextNode(part.text));
            });
        } else {
            renderLines(body, message);
        }
        const api = open({
            message: !options.title, title: options.title, size: 'sm', confirm: true, role: 'alertdialog',
            className: 'cb-dialog--alert' + (options.className ? ' ' + options.className : ''),
            body,
            actions: [{ id: 'ok', value: true, label: options.okText || translate('common.ok', 'OK'), role: 'primary', autofocus: true }]
        });
        return api ? api.closed.then(() => undefined) : Promise.resolve();
    }

    /**
     * choice(message, [{ value, label, primary, role }], { title }) → Promise<value | null>.
     * Arrow keys move between the answers; Enter takes the primary one even when nothing in the
     * dialog has focus.
     */
    function choice(message, choices = [], options = {}) {
        const body = doc().createElement('div');
        renderLines(body, message);
        const list = Array.isArray(choices) ? choices : [];
        const api = open({
            message: !options.title, title: options.title, size: 'sm', confirm: true, role: 'alertdialog',
            className: 'cb-dialog--choice' + (options.className ? ' ' + options.className : ''),
            body, stackActions: true,
            actions: list.map(item => ({ id: String(item.value), value: item.value, label: item.label, role: item.role || (item.primary ? 'primary' : 'secondary'), autofocus: !!item.primary }))
        });
        if (!api) return Promise.resolve(null);
        const buttons = Array.from(api.footer ? api.footer.querySelectorAll('button') : []);
        // Arrow keys move between the answers (open() already keeps Tab and Enter inside the box).
        function onKeydown(event) {
            if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return;
            event.preventDefault();
            const current = buttons.indexOf(doc().activeElement);
            const delta = (event.key === 'ArrowDown' || event.key === 'ArrowRight') ? 1 : -1;
            const next = current === -1 ? 0 : (current + delta + buttons.length) % buttons.length;
            if (buttons[next]) buttons[next].focus();
        }
        api.dialog.addEventListener('keydown', onKeydown);
        return api.closed.then(result => (result === null || result === undefined ? null : result));
    }

    /** prompt(message, { defaultValue, placeholder, inputType, okText, cancelText, title, validate }) → Promise<string | null> */
    function prompt(message, options = {}) {
        const body = doc().createElement('div');
        renderLines(body, message);
        const input = doc().createElement('input');
        input.type = options.inputType || 'text';
        input.className = 'cb-dialog__prompt';
        if (options.defaultValue != null) input.value = String(options.defaultValue);
        if (options.placeholder) input.placeholder = options.placeholder;
        if (options.min != null) input.min = options.min;
        if (options.max != null) input.max = options.max;
        input.setAttribute('aria-label', String(message == null ? '' : message).split('\n')[0]);
        body.appendChild(input);
        let api = null;
        function submit() {
            const value = input.value;
            if (typeof options.validate === 'function' && !options.validate(value)) {
                input.setAttribute('aria-invalid', 'true');
                input.focus();
                return;
            }
            api.close(value);
        }
        api = open({
            message: !options.title, title: options.title, size: 'sm', confirm: true,
            className: 'cb-dialog--prompt' + (options.className ? ' ' + options.className : ''),
            body, initialFocus: input,
            actions: [
                { id: 'cancel', value: null, label: options.cancelText || translate('common.cancel', 'Cancel'), role: 'secondary' },
                { id: 'ok', label: options.okText || translate('common.ok', 'OK'), role: 'primary', keepOpen: true, onClick: submit }
            ]
        });
        if (!api) return Promise.resolve(null);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); submit(); }
        });
        return api.closed.then(result => (typeof result === 'string' ? result : null));
    }

    return Object.freeze({ open, confirm, alert, choice, prompt, renderLines, appendBody, confirmActions, linkedMessageParts, dialogClassName });
});
