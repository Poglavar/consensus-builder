// Closing an untouched Block / Freeform-building dialog must not ask "Discard this design?".
// The dialogs decide via frontend/js/design-change-tracker.js: baseline = design signature just
// before the first user input, changed = signature differs at close. This pins that contract.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDesignChangeTracker, featuresSignature } = require('../../frontend/js/design-change-tracker.js');

// Minimal capture-aware target: Node's EventTarget does not remove capture listeners reliably
// (removeEventListener(type, fn, true) leaves them attached), unlike browsers.
function fakeTarget() {
    const listeners = new Map();
    return {
        addEventListener(type, fn, capture) { listeners.set(`${type}|${!!capture}|`, [...(listeners.get(`${type}|${!!capture}|`) || []), fn]); },
        removeEventListener(type, fn, capture) {
            const key = `${type}|${!!capture}|`;
            listeners.set(key, (listeners.get(key) || []).filter(f => f !== fn));
        },
        dispatchEvent(event) {
            [true, false].forEach(capture => (listeners.get(`${event.type}|${capture}|`) || []).forEach(fn => fn(event)));
        }
    };
}

function setup(initial) {
    let design = initial;
    const target = fakeTarget();
    const tracker = createDesignChangeTracker({ signature: () => featuresSignature(design) });
    tracker.start(target);
    return { tracker, target, set: next => { design = next; } };
}

const square = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { floors: 4 } };

describe('design change tracker', () => {
    it('reports no change when the user never interacted, even after auto-generation', () => {
        const { tracker, set } = setup(null);
        set([square]); // the dialog's own first generation
        expect(tracker.changed()).toBe(false);
    });

    it('reports no change when the close click itself is the first input', () => {
        const { tracker, target } = setup([square]);
        target.dispatchEvent(new Event('pointerdown'));
        expect(tracker.changed()).toBe(false);
    });

    it('reports a change made after the first input', () => {
        const { tracker, target, set } = setup([square]);
        target.dispatchEvent(new Event('input'));
        set([{ ...square, properties: { floors: 6 } }]);
        target.dispatchEvent(new Event('pointerdown')); // the × click
        expect(tracker.changed()).toBe(true);
    });

    it('treats an edit reverted to the original as unchanged', () => {
        const { tracker, target, set } = setup([square]);
        target.dispatchEvent(new Event('keydown'));
        set([{ ...square, properties: { floors: 6 } }]);
        set([square]);
        expect(tracker.changed()).toBe(false);
    });

    it('stops listening after stop() and resets on start()', () => {
        const { tracker, target, set } = setup([square]);
        tracker.stop();
        target.dispatchEvent(new Event('input'));
        set([]);
        expect(tracker.changed()).toBe(false);
        tracker.start(target);
        target.dispatchEvent(new Event('input'));
        set([square]);
        expect(tracker.changed()).toBe(true);
    });
});
