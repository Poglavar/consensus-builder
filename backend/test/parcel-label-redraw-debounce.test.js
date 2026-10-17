// Parcel-number and owner-count labels redraw once per settled map move: a zoom fires zoomend and
// moveend, and a pan can end several times in a row, so the redraw waits until the events stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(`../../frontend/js/parcels/ui/${path}`, import.meta.url), 'utf8');

// Loads one label module against a map that records its listeners and a checkbox that counts reads:
// every redraw starts by reading the checkbox, so the reads count the redraws.
function load(file, checkboxId) {
    const handlers = {};
    const checkbox = { checked: false };
    let reads = 0;
    const scope = {
        console, setTimeout, clearTimeout,
        map: { on: (name, fn) => { (handlers[name] ||= []).push(fn); } },
        document: {
            getElementById: id => { if (id === checkboxId) { reads += 1; return checkbox; } return null; },
            addEventListener() {}, readyState: 'complete'
        },
        addEventListener() {}
    };
    scope.window = scope;
    runInContext(read(file), createContext(scope));
    return { scope, handlers, fire: name => (handlers[name] || []).forEach(fn => fn()), reads: () => reads };
}

describe.each([
    ['labels.js', 'showParcelNumbers', 'toggleParcelNumbers'],
    ['owner-counts.js', 'showOwnerCounts', 'toggleOwnerCounts']
])('%s', (file, checkboxId, toggle) => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('redraws once after a zoom and a burst of moveends, not once per event', () => {
        const page = load(file, checkboxId);
        page.scope[toggle](); // checkbox unchecked: attaches nothing, clears labels
        expect(page.handlers.moveend).toBeUndefined();
        // Attach the listeners the way the app does: through a toggle with the box checked.
        const box = page.scope.document.getElementById(checkboxId);
        box.checked = true;
        try { page.scope[toggle](); } catch (_) { /* drawing needs a real map; only the listeners matter here */ }
        box.checked = false;
        expect(page.handlers.moveend).toHaveLength(1);
        expect(page.handlers.zoomend).toHaveLength(1);

        const before = page.reads();
        page.fire('zoomend'); page.fire('moveend'); page.fire('moveend'); page.fire('moveend');
        expect(page.reads()).toBe(before);
        vi.advanceTimersByTime(149);
        expect(page.reads()).toBe(before);
        vi.advanceTimersByTime(1);
        expect(page.reads()).toBe(before + 1);
    });
});
