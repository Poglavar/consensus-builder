// One undo stack for every place the user edits geometry on the map. Each editor was growing its
// own (or, more often, none at all), so "undo" meant something different in each tool and usually
// nothing. This owns the stack, the keyboard shortcut and the button state; the editor only says
// how to capture and restore its own state.
//
// Snapshots are taken BEFORE a change and only when something actually changes, so an undo step
// always corresponds to something the user did — an action that changed nothing must never leave a
// step that appears to do nothing when used.
(function (global, factory) {
    'use strict';
    const api = factory();
    if (typeof window !== 'undefined') window.GeometryEditHistory = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const DEFAULT_LIMIT = 50;

    // opts:
    //   capture()        -> snapshot (any value; deep-copied by the caller if it must be)
    //   restore(snap, direction) -> void   (direction is 'undo' or 'redo')
    //   limit            -> max depth (default 50)
    //   onChange(canUndo[, canRedo]) -> void, for button state (canRedo only when redo is on)
    //   isEqual(a, b)    -> optional; when given, record() skips a snapshot identical to the top
    //   redo             -> true to keep undone steps for redo (Shift+Cmd/Ctrl+Z, Ctrl+Y). Off by
    //                       default: an editor whose restore() is not the exact inverse of capture()
    //                       would replay a state it never had.
    function create(opts) {
        const options = opts || {};
        const capture = typeof options.capture === 'function' ? options.capture : null;
        const restore = typeof options.restore === 'function' ? options.restore : null;
        const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
        const redoEnabled = options.redo === true;
        const stack = [];
        const redoStack = [];
        let unbindKeyboard = null;
        let boundButtons = [];
        let boundRedoButtons = [];
        const inputCleanups = [];

        function announce() {
            if (typeof options.onChange === 'function') {
                try {
                    if (redoEnabled) options.onChange(stack.length > 0, redoStack.length > 0);
                    else options.onChange(stack.length > 0);
                } catch (_) { }
            }
            boundButtons.forEach(btn => {
                try {
                    btn.disabled = stack.length === 0;
                    btn.setAttribute('aria-disabled', stack.length === 0 ? 'true' : 'false');
                } catch (_) { }
            });
            boundRedoButtons.forEach(btn => {
                try {
                    btn.disabled = redoStack.length === 0;
                    btn.setAttribute('aria-disabled', redoStack.length === 0 ? 'true' : 'false');
                } catch (_) { }
            });
        }

        // Take a snapshot of the CURRENT state. Call before mutating.
        function record() {
            if (!capture) return false;
            let snapshot;
            try { snapshot = capture(); } catch (_) { return false; }
            if (snapshot === undefined) return false;
            if (typeof options.isEqual === 'function' && stack.length) {
                try { if (options.isEqual(stack[stack.length - 1], snapshot)) return false; } catch (_) { }
            }
            return appendSnapshot(snapshot);
        }

        function appendSnapshot(snapshot) {
            stack.push(snapshot);
            while (stack.length > limit) stack.shift();
            // A new edit starts a new branch: what was undone before it can no longer be redone.
            redoStack.length = 0;
            announce();
            return true;
        }

        // Group range drags and held adjustment keys, while retaining ordinary input events
        // (including assistive technology). Compare captured model state so rejected/no-op values
        // never enable Undo. Text entry groups until change or blur.
        function bindInput(element, apply) {
            if (!element) return () => {};
            let recorded = false;
            let pointer = false;
            let key = false;
            const finish = () => { recorded = false; pointer = false; key = false; };
            const handlers = {
                pointerdown: () => { finish(); pointer = true; },
                pointerup: finish,
                pointercancel: finish,
                keydown: event => {
                    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
                    if (!key) recorded = false;
                    key = true;
                },
                keyup: event => { if (key) finish(); },
                blur: finish,
                change: () => { if (!pointer && !key) finish(); },
                input: event => {
                    const before = recorded ? undefined : capture();
                    apply(event);
                    if (!recorded && before !== undefined && JSON.stringify(before) !== JSON.stringify(capture())) {
                        appendSnapshot(before);
                        recorded = true;
                    }
                }
            };
            Object.entries(handlers).forEach(([type, handler]) => element.addEventListener(type, handler));
            const cleanup = () => Object.entries(handlers).forEach(([type, handler]) => element.removeEventListener(type, handler));
            inputCleanups.push(cleanup);
            return cleanup;
        }

        function undo() {
            if (!stack.length || !restore) return false;
            let current;
            if (redoEnabled && capture) {
                try { current = capture(); } catch (_) { current = undefined; }
            }
            const snapshot = stack.pop();
            try { restore(snapshot, 'undo'); } catch (_) { announce(); return false; }
            if (current !== undefined) redoStack.push(current);
            announce();
            return true;
        }

        function redo() {
            if (!redoEnabled || !redoStack.length || !restore || !capture) return false;
            let current;
            try { current = capture(); } catch (_) { return false; }
            const snapshot = redoStack.pop();
            try { restore(snapshot, 'redo'); } catch (_) { announce(); return false; }
            stack.push(current);
            while (stack.length > limit) stack.shift();
            announce();
            return true;
        }

        // For an action that recorded up-front and then failed: leave no phantom step.
        function discardLast() {
            if (!stack.length) return false;
            stack.pop();
            announce();
            return true;
        }

        function clear() {
            stack.length = 0;
            redoStack.length = 0;
            announce();
        }

        function canUndo() { return stack.length > 0; }
        function canRedo() { return redoStack.length > 0; }
        function depth() { return stack.length; }

        // Cmd/Ctrl+Z on a target (window or a modal element). Typing in a field is left alone —
        // undo there belongs to the field. Shift+Cmd+Z (and Ctrl+Y) redo where redo is enabled;
        // elsewhere Shift is swallowed rather than surprising the user with an undo.
        function bindKeyboard(target, keyOpts) {
            const el = target || (typeof window !== 'undefined' ? window : null);
            if (!el || typeof el.addEventListener !== 'function') return () => { };
            const settings = keyOpts || {};
            const handler = event => {
                if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
                const ctrlY = redoEnabled && event.ctrlKey && !event.metaKey && !event.shiftKey
                    && String(event.key).toLowerCase() === 'y';
                if (String(event.key).toLowerCase() !== 'z' && !ctrlY) return;
                const tag = (event.target && event.target.tagName) || '';
                if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
                if (event.target && event.target.isContentEditable) return;
                if (typeof settings.enabled === 'function' && !settings.enabled()) return;
                event.preventDefault();
                if (ctrlY || (event.shiftKey && redoEnabled)) { redo(); return; }
                if (event.shiftKey) return;   // this editor has no redo
                undo();
            };
            el.addEventListener('keydown', handler, true);
            unbindKeyboard = () => el.removeEventListener('keydown', handler, true);
            return unbindKeyboard;
        }

        // Wire one or more undo buttons: click undoes, disabled state follows the stack.
        function bindButton(button) {
            if (!button || typeof button.addEventListener !== 'function') return () => { };
            const handler = () => { undo(); };
            button.addEventListener('click', handler);
            boundButtons.push(button);
            announce();
            return () => {
                button.removeEventListener('click', handler);
                boundButtons = boundButtons.filter(b => b !== button);
            };
        }

        // Wire a redo button the same way: click redoes, disabled state follows the redo stack.
        function bindRedoButton(button) {
            if (!button || typeof button.addEventListener !== 'function') return () => { };
            const handler = () => { redo(); };
            button.addEventListener('click', handler);
            boundRedoButtons.push(button);
            announce();
            return () => {
                button.removeEventListener('click', handler);
                boundRedoButtons = boundRedoButtons.filter(b => b !== button);
            };
        }

        function destroy() {
            if (unbindKeyboard) { try { unbindKeyboard(); } catch (_) { } unbindKeyboard = null; }
            inputCleanups.splice(0).forEach(cleanup => cleanup());
            boundButtons = [];
            boundRedoButtons = [];
            stack.length = 0;
            redoStack.length = 0;
        }

        return { record, undo, redo, discardLast, clear, canUndo, canRedo, depth, bindInput, bindKeyboard, bindButton, bindRedoButton, destroy };
    }

    return { create, DEFAULT_LIMIT };
});
