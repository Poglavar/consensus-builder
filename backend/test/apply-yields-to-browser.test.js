// A long apply must not be one frame.
//
// Every function in the apply chain is `async`, which reads like it yields — but `await` on a
// promise that is already settled schedules a MICROTASK, and microtasks run to exhaustion BEFORE the
// browser paints or handles input. So a replay of 180 proposals whose ground is already cached never
// hands control back once, and the map is frozen from the first member to the last while the log
// cheerfully reports progress.
//
// Two costs, two fixes, both pinned here:
//   * no macrotask boundary between members  → yieldToBrowser() between them;
//   * the proposed-buildings layer is thrown away and redrawn from every applied proposal ONCE PER
//     APPLY, which makes a replay quadratic in its own output → held for the run, drawn once.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const ui = read('../../frontend/js/ui-helpers.js');
const buildings = read('../../frontend/js/building-blocks.js');
const manager = read('../../frontend/js/proposal-manager.js');
const batch = read('../../frontend/js/block-batch.js');

describe('yielding is a macrotask, not an await', () => {
    it('prefers scheduler.yield and falls back to a real task', () => {
        expect(ui).toContain('function yieldToBrowser()');
        expect(ui).toContain("typeof scheduler.yield === 'function'");
        // NOT Promise.resolve() or queueMicrotask: neither lets the browser paint.
        expect(ui).toContain('setTimeout(resolve, 0);');
        expect(ui).toContain('window.yieldToBrowser = yieldToBrowser;');
    });

    it('is taken between replay members', () => {
        const loop = manager.slice(
            manager.indexOf('        for (const proposal of appliedList) {'),
            manager.indexOf('        this._lastRebuildProfile = {')
        );
        expect(loop).toContain('await window.yieldToBrowser();');
    });

    it('is taken between batch-created blocks', () => {
        expect(batch).toContain("if (typeof global.yieldToBrowser === 'function') await global.yieldToBrowser();");
    });
});

describe('the proposed-buildings layer is drawn once per run, not once per proposal', () => {
    it('can be held, and remembers a refresh it skipped', () => {
        expect(buildings).toContain('let proposedBuildingsRefreshHeld = 0;');
        expect(buildings).toContain('async function withProposedBuildingsRefreshHeld(run)');
        // The missed flag is the whole safety of the pattern: a refresh skipped while held must
        // still happen, or the map ends up showing fewer buildings than are applied.
        expect(buildings).toContain('proposedBuildingsRefreshMissed = true;');
        expect(buildings).toContain('proposedBuildingsRefreshMissed = false;\n            updateProposedBuildingsLayer();');
    });

    it('releases in a finally, so a throw mid-run cannot leave it held for ever', () => {
        const hold = buildings.slice(
            buildings.indexOf('async function withProposedBuildingsRefreshHeld(run)'),
            buildings.indexOf('function updateProposedBuildingsLayer()')
        );
        expect(hold).toContain('} finally {');
        expect(hold.slice(hold.indexOf('} finally {'))).toContain('proposedBuildingsRefreshHeld -= 1;');
    });

    it('checks the hold before doing any work', () => {
        const fn = buildings.slice(buildings.indexOf('function updateProposedBuildingsLayer() {'));
        const guard = fn.indexOf('if (proposedBuildingsRefreshHeld) {');
        const work = fn.indexOf('map.removeLayer(proposedBuildingLayer);');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(work);
    });

    it('wraps the whole replay and the whole batch', () => {
        expect(manager).toContain('window.withProposedBuildingsRefreshHeld');
        expect(manager).toContain('if (typeof holdBuildings === \'function\') await holdBuildings(runPasses);');
        expect(batch).toContain('await global.withProposedBuildingsRefreshHeld(createEach);');
    });
});
