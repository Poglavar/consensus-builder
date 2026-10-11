// Reusable accessible controller for a horizontal before/after divider. DOM listeners are installed
// only by create(); clamp/keyboard math is pure so it can be tested headlessly.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__MapCompareControl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function clampPercent(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
    }

    function keyboardPercent(value, key, options = {}) {
        const current = clampPercent(value);
        const step = Math.max(0.1, Number(options.step) || 2);
        const pageStep = Math.max(step, Number(options.pageStep) || 10);
        switch (key) {
            case 'ArrowLeft': case 'ArrowDown': return clampPercent(current - step);
            case 'ArrowRight': case 'ArrowUp': return clampPercent(current + step);
            case 'PageDown': return clampPercent(current - pageStep);
            case 'PageUp': return clampPercent(current + pageStep);
            case 'Home': return 0;
            case 'End': return 100;
            default: return null;
        }
    }

    function create(options = {}) {
        const { container, handle, onChange } = options;
        if (!container || !handle || typeof onChange !== 'function') {
            throw new TypeError('MapCompareControl.create requires container, handle, and onChange');
        }
        const doc = container.ownerDocument || handle.ownerDocument;
        const win = doc && doc.defaultView;
        if (!doc || typeof doc.addEventListener !== 'function') {
            throw new TypeError('MapCompareControl requires an attached DOM container');
        }

        let value = clampPercent(options.value === undefined ? 50 : options.value);
        let pointerId = null;
        let pointerActive = false;
        let disposed = false;
        const label = String(options.label || 'Before and after comparison');

        handle.setAttribute('role', 'slider');
        handle.setAttribute('tabindex', '0');
        handle.setAttribute('aria-label', label);
        handle.setAttribute('aria-valuemin', '0');
        handle.setAttribute('aria-valuemax', '100');
        handle.setAttribute('aria-valuenow', String(value));

        function setValue(next) {
            const before = value;
            value = clampPercent(next);
            handle.setAttribute('aria-valuenow', String(value));
            if (value !== before) onChange(value);
            return value;
        }

        function publish(next) {
            setValue(next);
        }

        function onPointerDown(event) {
            if (pointerActive) return;
            if (event.button !== undefined && event.button !== 0) return;
            pointerActive = true;
            pointerId = event.pointerId === undefined ? null : event.pointerId;
            if (event.cancelable && typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof handle.focus === 'function') {
                try { handle.focus({ preventScroll: true }); }
                catch (_) { handle.focus(); }
            }
            doc.addEventListener('pointermove', onPointerMove);
            doc.addEventListener('pointerup', onPointerEnd);
            doc.addEventListener('pointercancel', onPointerEnd);
        }

        function onPointerMove(event) {
            if (pointerId !== null && event.pointerId !== pointerId) return;
            const rect = container.getBoundingClientRect();
            if (!Number.isFinite(rect.width) || rect.width <= 0) return;
            publish(((event.clientX - rect.left) / rect.width) * 100);
        }

        function onPointerEnd(event) {
            if (!pointerActive) return;
            if (pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId) return;
            pointerActive = false;
            pointerId = null;
            doc.removeEventListener('pointermove', onPointerMove);
            doc.removeEventListener('pointerup', onPointerEnd);
            doc.removeEventListener('pointercancel', onPointerEnd);
        }

        function onKeyDown(event) {
            const next = keyboardPercent(value, event.key, options);
            if (next === null) return;
            if (event.cancelable && typeof event.preventDefault === 'function') event.preventDefault();
            publish(next);
        }

        function onResize() { onChange(value); }

        handle.addEventListener('pointerdown', onPointerDown);
        handle.addEventListener('keydown', onKeyDown);
        if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);

        return {
            getValue: () => value,
            setValue,
            dispose() {
                if (disposed) return;
                disposed = true;
                onPointerEnd({});
                handle.removeEventListener('pointerdown', onPointerDown);
                handle.removeEventListener('keydown', onKeyDown);
                if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', onResize);
            }
        };
    }

    return { clampPercent, keyboardPercent, create, mount: create };
});
