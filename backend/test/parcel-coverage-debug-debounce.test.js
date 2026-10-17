// The parcel coverage debug modal redraws once per settled map move while it is open, and a close
// cancels a pending redraw: a zoom fires zoomend and moveend, and a pan can end several times in a row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcel-coverage-debug.js', import.meta.url), 'utf8');

// Every redraw starts with computeCoverageData, which takes a repository snapshot: the snapshots count the redraws.
function load() {
    const mapHandlers = {};
    const clicks = {};
    const element = id => ({
        id, hidden: id === 'parcel-coverage-modal', innerHTML: '', textContent: '',
        querySelector: () => null,
        addEventListener: (name, fn) => { clicks[id] = fn; }
    });
    const elements = new Map(['parcel-coverage-modal', 'showParcelCoverageButton', 'parcel-coverage-close-btn',
        'parcel-coverage-legend', 'parcel-coverage-summary'].map(id => [id, element(id)]));
    let snapshots = 0;
    const scope = {
        console, setTimeout, clearTimeout,
        map: {
            on: (name, fn) => { (mapHandlers[name] ||= []).push(fn); },
            off: (name, fn) => { mapHandlers[name] = (mapHandlers[name] || []).filter(h => h !== fn); }
        },
        CadastralParcelRepository: { snapshot: () => { snapshots += 1; return { cells: [] }; } },
        document: { getElementById: id => elements.get(id) || null, readyState: 'complete', addEventListener() {} },
        addEventListener() {}, removeEventListener() {}
    };
    scope.window = scope;
    runInContext(source, createContext(scope));
    return {
        open: () => clicks.showParcelCoverageButton(),
        close: () => clicks['parcel-coverage-close-btn'](),
        fire: name => (mapHandlers[name] || []).forEach(fn => fn()),
        snapshots: () => snapshots
    };
}

describe('parcel coverage debug modal', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('redraws once after a zoom and a burst of moveends, not once per event', () => {
        const page = load();
        page.open();
        const before = page.snapshots();
        page.fire('zoomend'); page.fire('moveend'); page.fire('moveend'); page.fire('moveend');
        expect(page.snapshots()).toBe(before);
        vi.advanceTimersByTime(149);
        expect(page.snapshots()).toBe(before);
        vi.advanceTimersByTime(1);
        expect(page.snapshots()).toBe(before + 1);
    });

    it('drops a pending redraw when the modal closes', () => {
        const page = load();
        page.open();
        const before = page.snapshots();
        page.fire('moveend');
        page.close();
        vi.advanceTimersByTime(1000);
        expect(page.snapshots()).toBe(before);
    });
});
