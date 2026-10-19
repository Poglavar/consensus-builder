// Exercise the shared compare-divider controller without a browser so its input and cleanup rules stay reliable.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const control = require('../../frontend/js/ui/map-compare-control.js');

class FakeTarget {
    listeners = new Map();
    attributes = new Map();
    capturedPointers = new Set();

    setPointerCapture(id) { this.capturedPointers.add(id); }
    hasPointerCapture(id) { return this.capturedPointers.has(id); }
    releasePointerCapture(id) { this.capturedPointers.delete(id); }

    addEventListener(type, listener) {
        const group = this.listeners.get(type) || new Set();
        group.add(listener);
        this.listeners.set(type, group);
    }

    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }

    dispatch(type, event = {}) {
        const enriched = { type, target: this, cancelable: true, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...event };
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
    it('keeps divider clicks out of the host without swallowing ordinary document clicks', () => {
        const doc = new FakeTarget();
        const container = new FakeTarget();
        container.ownerDocument = doc;
        container.getBoundingClientRect = () => ({ left: 0, width: 200 });
        const handle = new FakeTarget();
        const instance = control.create({ container, handle, onChange: vi.fn() });

        expect(handle.dispatch('pointerdown', { pointerId: 3, button: 2 }).stopPropagation).not.toHaveBeenCalled();
        expect(handle.dispatch('pointerdown', { pointerId: 3, button: 0 }).stopPropagation).toHaveBeenCalledOnce();
        doc.dispatch('pointermove', { pointerId: 3, clientX: 150 });
        doc.dispatch('pointerup', { pointerId: 3 });
        expect(instance.getValue()).toBe(75);
        expect(handle.dispatch('click').stopPropagation).toHaveBeenCalledOnce();
        expect(doc.dispatch('click').stopPropagation).not.toHaveBeenCalled();
        instance.dispose();
        expect(handle.dispatch('click').stopPropagation).not.toHaveBeenCalled();
    });

    it('captures the active pointer and releases it on cancel and disposal', () => {
        const doc = new FakeTarget();
        const container = new FakeTarget();
        container.ownerDocument = doc;
        container.getBoundingClientRect = () => ({ left: 0, width: 200 });
        const handle = new FakeTarget();
        const instance = control.create({ container, handle, onChange: vi.fn() });

        handle.dispatch('pointerdown', { pointerId: 4, pointerType: 'touch', button: 0 });
        expect(handle.hasPointerCapture(4)).toBe(true);
        doc.dispatch('pointercancel', { pointerId: 5 });
        expect(handle.hasPointerCapture(4)).toBe(true);
        doc.dispatch('pointercancel', { pointerId: 4 });
        expect(handle.hasPointerCapture(4)).toBe(false);
        doc.dispatch('pointermove', { pointerId: 4, clientX: 0 });
        expect(instance.getValue()).toBe(50);
        handle.dispatch('pointerdown', { pointerId: 6, button: 0 });
        instance.dispose();
        expect(handle.hasPointerCapture(6)).toBe(false);
        expect(handle.listeners.get('lostpointercapture')?.size || 0).toBe(0);
    });

    it('ends a drag when capture is lost and tolerates synthetic pointers without native capture', () => {
        const doc = new FakeTarget();
        const container = new FakeTarget();
        container.ownerDocument = doc;
        container.getBoundingClientRect = () => ({ left: 0, width: 200 });
        const handle = new FakeTarget();
        const instance = control.create({ container, handle, onChange: vi.fn() });
        handle.dispatch('pointerdown', { pointerId: 1, button: 0 });
        handle.dispatch('lostpointercapture', { pointerId: 1 });
        doc.dispatch('pointermove', { pointerId: 1, clientX: 0 });
        expect(instance.getValue()).toBe(50);
        handle.setPointerCapture = () => { throw new Error('No active native pointer'); };
        handle.dispatch('pointerdown', { pointerId: 2, button: 0 });
        doc.dispatch('pointermove', { pointerId: 2, clientX: 150 });
        expect(instance.getValue()).toBe(75);
        doc.dispatch('pointerup', { pointerId: 2 });
        expect(handle.hasPointerCapture(2)).toBe(false);
        instance.dispose();
    });

});
