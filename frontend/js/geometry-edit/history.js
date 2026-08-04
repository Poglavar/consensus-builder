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
    //   restore(snap)    -> void
    //   limit            -> max depth (default 50)
    //   onChange(canUndo)-> void, for button state
    //   isEqual(a, b)    -> optional; when given, record() skips a snapshot identical to the top
    function create(opts) {
        const options = opts || {};
        const capture = typeof options.capture === 'function' ? options.capture : null;
        const restore = typeof options.restore === 'function' ? options.restore : null;
        const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
        const stack = [];
        let unbindKeyboard = null;
        let boundButtons = [];

        function announce() {
            if (typeof options.onChange === 'function') {
                try { options.onChange(stack.length > 0); } catch (_) { }
            }
            boundButtons.forEach(btn => {
                try {
                    btn.disabled = stack.length === 0;
                    btn.setAttribute('aria-disabled', stack.length === 0 ? 'true' : 'false');
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
            stack.push(snapshot);
            while (stack.length > limit) stack.shift();
            announce();
            return true;
        }

        function undo() {
            if (!stack.length || !restore) return false;
            const snapshot = stack.pop();
            try { restore(snapshot); } catch (_) { announce(); return false; }
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
            announce();
        }

        function canUndo() { return stack.length > 0; }
        function depth() { return stack.length; }

        // Cmd/Ctrl+Z on a target (window or a modal element). Typing in a field is left alone —
        // undo there belongs to the field. Shift+Cmd+Z is swallowed rather than surprising the
        // user with an undo, since none of these editors has redo.
        function bindKeyboard(target, keyOpts) {
            const el = target || (typeof window !== 'undefined' ? window : null);
            if (!el || typeof el.addEventListener !== 'function') return () => { };
            const settings = keyOpts || {};
            const handler = event => {
                if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
                if (String(event.key).toLowerCase() !== 'z') return;
                const tag = (event.target && event.target.tagName) || '';
                if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
                if (event.target && event.target.isContentEditable) return;
                if (typeof settings.enabled === 'function' && !settings.enabled()) return;
                event.preventDefault();
                if (event.shiftKey) return;   // no redo anywhere yet
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

        function destroy() {
            if (unbindKeyboard) { try { unbindKeyboard(); } catch (_) { } unbindKeyboard = null; }
            boundButtons = [];
            stack.length = 0;
        }

        return { record, undo, discardLast, clear, canUndo, depth, bindKeyboard, bindButton, destroy };
    }

    return { create, DEFAULT_LIMIT };
});
