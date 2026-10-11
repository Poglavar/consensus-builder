// Exercise the shared compare-divider controller without a browser so its input and cleanup rules stay reliable.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const control = require('../../frontend/js/ui/map-compare-control.js');

class FakeTarget {
    listeners = new Map();
    attributes = new Map();

    addEventListener(type, listener) {
        const group = this.listeners.get(type) || new Set();
        group.add(listener);
        this.listeners.set(type, group);
    }

    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }

    dispatch(type, event = {}) {
        const enriched = { type, cancelable: true, preventDefault: vi.fn(), ...event };
        for (const listener of [...(this.listeners.get(type) || [])]) listener(enriched);
        return enriched;
    }
}

describe('MapCompareControl', () => {
    it('clamps percentages and maps keyboard keys to bounded values', () => {
        expect(control.clampPercent(-10)).toBe(0);
        expect(control.clampPercent(150)).toBe(100);
        expect(control.clampPercent('nope')).toBe(0);
        expect(control.keyboardPercent(50, 'ArrowRight')).toBe(52);
        expect(control.keyboardPercent(99, 'ArrowRight')).toBe(100);
        expect(control.keyboardPercent(50, 'Home')).toBe(0);
        expect(control.keyboardPercent(50, 'End')).toBe(100);
        expect(control.keyboardPercent(50, 'PageUp')).toBe(60);
        expect(control.keyboardPercent(50, 'Enter')).toBeNull();
    });

    it('publishes drag/keyboard/resize values and removes every listener on dispose', () => {
        const doc = new FakeTarget();
        const win = new FakeTarget();
        doc.defaultView = win;
        const container = new FakeTarget();
        container.ownerDocument = doc;
        container.getBoundingClientRect = () => ({ left: 20, width: 200 });
        const handle = new FakeTarget();
        handle.ownerDocument = doc;
        handle.focus = vi.fn();
        const onChange = vi.fn();
        const instance = control.create({ container, handle, onChange, value: 50, label: 'Compare parcel layouts' });

        expect(handle.getAttribute('role')).toBe('slider');
        expect(handle.getAttribute('tabindex')).toBe('0');
        expect(handle.getAttribute('aria-label')).toBe('Compare parcel layouts');
        expect(handle.getAttribute('aria-valuemin')).toBe('0');
        expect(handle.getAttribute('aria-valuemax')).toBe('100');
        expect(handle.getAttribute('aria-valuenow')).toBe('50');

        handle.dispatch('pointerdown', { pointerId: 7, button: 0 });
        expect(handle.focus).toHaveBeenCalledWith({ preventScroll: true });
        handle.dispatch('pointerdown', { pointerId: 9, button: 0 });
        doc.dispatch('pointermove', { pointerId: 8, clientX: 100 });
        doc.dispatch('pointermove', { pointerId: 9, clientX: 20 });
        expect(instance.getValue()).toBe(50);
        doc.dispatch('pointermove', { pointerId: 7, clientX: 170 });
        expect(instance.getValue()).toBe(75);
        expect(handle.getAttribute('aria-valuenow')).toBe('75');
        doc.dispatch('pointerup', { pointerId: 7 });
        doc.dispatch('pointermove', { pointerId: 7, clientX: 220 });
        expect(instance.getValue()).toBe(75);

        handle.dispatch('keydown', { key: 'ArrowLeft' });
        expect(instance.getValue()).toBe(73);
        win.dispatch('resize');
        expect(onChange).toHaveBeenLastCalledWith(73);
        onChange.mockClear();
        instance.setValue(200);
        expect(instance.getValue()).toBe(100);
        expect(onChange).toHaveBeenCalledExactlyOnceWith(100);
        instance.setValue(100);
        expect(onChange).toHaveBeenCalledExactlyOnceWith(100);
        instance.dispose();
        instance.dispose();
        handle.dispatch('keydown', { key: 'Home' });
        win.dispatch('resize');
        handle.dispatch('pointerdown', { pointerId: 11, button: 0 });
        doc.dispatch('pointermove', { pointerId: 11, clientX: 20 });
        expect(instance.getValue()).toBe(100);
        expect(handle.listeners.get('pointerdown').size).toBe(0);
        expect(handle.listeners.get('keydown').size).toBe(0);
        expect(doc.listeners.get('pointermove')?.size || 0).toBe(0);
        expect(doc.listeners.get('pointerup')?.size || 0).toBe(0);
        expect(doc.listeners.get('pointercancel')?.size || 0).toBe(0);
        expect(win.listeners.get('resize').size).toBe(0);
    });
});
