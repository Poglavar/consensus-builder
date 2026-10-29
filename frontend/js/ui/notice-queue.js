// The order of notices (design-language.md, Messages): one on screen at a time, never a stack. A new notice
// replaces the current one once that has been readable for a minimum time, else waits its turn;
// a notice that repeats the one showing or waiting is dropped. A held notice (the pointer is on it,
// to click and copy it) does not expire; released, it stays the minimum time more. Pure state and
// timers; the DOM work (make the pill, remove it) is the host's `show` and `hide`.
//
//   createNoticeQueue({ minDisplayMs, now, setTimer, clearTimer, show, hide }) ->
//     { push(entry), current(), pending(), clear(), hold(), release() }
//   entry: { message, duration, type }; show(entry) returns a handle that hide(handle, entry) gets back.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__NoticeQueue = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const DEFAULT_MIN_DISPLAY_MS = 1200;
    const DEFAULT_DURATION_MS = 5000;

    function sameNotice(a, b) {
        return !!a && !!b && a.message === b.message && (a.type || 'info') === (b.type || 'info');
    }

    function createNoticeQueue(options = {}) {
        const minDisplayMs = Number.isFinite(options.minDisplayMs) ? options.minDisplayMs : DEFAULT_MIN_DISPLAY_MS;
        const now = typeof options.now === 'function' ? options.now : () => Date.now();
        const setTimer = typeof options.setTimer === 'function' ? options.setTimer : (fn, ms) => setTimeout(fn, ms);
        const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : id => clearTimeout(id);
        const show = typeof options.show === 'function' ? options.show : () => null;
        const hide = typeof options.hide === 'function' ? options.hide : () => {};

        let current = null;   // { entry, handle, shownAt, timer }
        let waiting = [];
        let pumpTimer = null;

        function dismissCurrent() {
            if (!current) return;
            clearTimer(current.timer);
            const done = current;
            current = null;
            hide(done.handle, done.entry);
        }

        function expireAfter(entry, ms) {
            return setTimer(() => {
                if (current && current.entry === entry) dismissCurrent();
                pump();
            }, ms);
        }

        function present(entry) {
            const handle = show(entry);
            current = { entry, handle, shownAt: now(), timer: null };
            current.timer = expireAfter(entry, entry.duration);
        }

        function hold() {
            if (!current || current.held) return;
            clearTimer(current.timer);
            current.timer = null;
            current.held = true;
        }

        function release() {
            if (!current || !current.held) return;
            current.held = false;
            current.timer = expireAfter(current.entry, minDisplayMs);
        }

        function pump() {
            if (pumpTimer) { clearTimer(pumpTimer); pumpTimer = null; }
            if (!waiting.length) return;
            if (current) {
                const left = minDisplayMs - (now() - current.shownAt);
                if (left > 0) { pumpTimer = setTimer(pump, left); return; }
                dismissCurrent();
            }
            present(waiting.shift());
        }

        function push(input) {
            const message = input && input.message != null ? String(input.message).trim() : '';
            if (!message) return false;
            const duration = Number.isFinite(Number(input.duration)) && Number(input.duration) > 0 ? Number(input.duration) : DEFAULT_DURATION_MS;
            const entry = { message, duration, type: input.type || 'info' };
            if ((current && sameNotice(current.entry, entry)) || waiting.some(w => sameNotice(w, entry))) return false;
            waiting.push(entry);
            pump();
            return true;
        }

        function clear() {
            waiting = [];
            if (pumpTimer) { clearTimer(pumpTimer); pumpTimer = null; }
            dismissCurrent();
        }

        return {
            push,
            clear,
            hold,
            release,
            current: () => (current ? current.entry : null),
            pending: () => waiting.slice()
        };
    }

    return Object.freeze({ createNoticeQueue, DEFAULT_MIN_DISPLAY_MS, DEFAULT_DURATION_MS });
});
