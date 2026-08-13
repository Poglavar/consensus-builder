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
import vm from 'node:vm';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const ui = read('../../frontend/js/ui-helpers.js');
const buildings = read('../../frontend/js/building-blocks.js');
const structures = read('../../frontend/js/structures.js');
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
        expect(manager).toContain('if (typeof holdBuildings === \'function\') await holdBuildings(runWithStructuresHeld);');
        expect(batch).toContain('await global.withProposedBuildingsRefreshHeld(createEach);');
    });
});

describe('structure layers are drawn once per replay, not once per structure', () => {
    it('holds park/square/lake refreshes and remembers every kind it skipped', () => {
        expect(structures).toContain('let structureLayersRefreshHeld = 0;');
        expect(structures).toContain('const missedStructureLayerRefreshes = new Set();');
        expect(structures).toContain("missedStructureLayerRefreshes.add(kind);");
        expect(structures).toContain('async function withStructureLayersRefreshHeld(run)');
        expect(structures).toContain('window.withStructureLayersRefreshHeld = withStructureLayersRefreshHeld;');
    });

    it('guards before any structure-layer or building-outcome refresh', () => {
        for (const [name, kind] of [
            ['updateParksLayer', 'parks'],
            ['updateSquaresLayer', 'squares'],
            ['updateLakesLayer', 'lakes']
        ]) {
            const fn = structures.slice(structures.indexOf(`function ${name}() {`));
            const guard = fn.indexOf(`if (deferStructureLayerRefresh('${kind}')) return;`);
            const redraw = fn.indexOf('refreshBuildingsAfterStructureChange();');
            expect(guard, `${name} has no hold guard`).toBeGreaterThan(-1);
            expect(guard).toBeLessThan(redraw);
        }
    });

    it('flushes each affected structure layer and the local building outcomes once', () => {
        const hold = structures.slice(
            structures.indexOf('async function withStructureLayersRefreshHeld(run)'),
            structures.indexOf('function bindStructureClaimClick')
        );
        expect(hold).toContain("if (pending.includes('parks')) updateParksLayer();");
        expect(hold).toContain("if (pending.includes('squares')) updateSquaresLayer();");
        expect(hold).toContain("if (pending.includes('lakes')) updateLakesLayer();");
        expect(hold).toContain('structureBuildingRefreshMissed = false;\n                        refreshBuildingsAfterStructureChange();');
    });

    it('wraps the complete canonical replay', () => {
        expect(manager).toContain('window.withStructureLayersRefreshHeld');
        expect(manager).toContain('holdStructures(runPasses)');
    });

    it('actually coalesces repeated structure updates and releases after an error', async () => {
        const context = {
            console,
            document: { readyState: 'complete', getElementById: () => null },
            PersistentStorage: {
                getItem: () => null,
                setItem: () => { },
                ensureReady: callback => callback()
            }
        };
        context.window = context;
        vm.createContext(context);
        vm.runInContext(structures, context);

        let buildingOutcomeRefreshes = 0;
        context.refreshBuildingOutcomesFromRecords = () => { buildingOutcomeRefreshes += 1; };

        await context.withStructureLayersRefreshHeld(async () => {
            context.updateParksLayer();
            context.updateParksLayer();
            context.updateSquaresLayer();
            context.updateLakesLayer();
            expect(buildingOutcomeRefreshes).toBe(0);
        });
        expect(buildingOutcomeRefreshes).toBe(1);

        await expect(context.withStructureLayersRefreshHeld(async () => {
            context.updateParksLayer();
            throw new Error('stop');
        })).rejects.toThrow('stop');
        expect(buildingOutcomeRefreshes).toBe(2);

        context.updateParksLayer();
        expect(buildingOutcomeRefreshes).toBe(3);
    });

    it('never rebuilds the surveyed city layer as a local structure side effect', () => {
        const refresh = structures.slice(
            structures.indexOf('function refreshBuildingsAfterStructureChange()'),
            structures.indexOf('async function withStructureLayersRefreshHeld(run)')
        );
        expect(refresh).toContain('window.refreshBuildingOutcomesFromRecords();');
        expect(refresh).not.toContain('rebuildBuildingLayerFromPool');
    });
});

// Yielding BETWEEN proposals does nothing for a block inside one. A replay hands
// _addFeaturesToMap 3,672 derived pieces in a SINGLE call — every Leaflet layer built, added and
// indexed as one task — which is long enough to freeze a pan on its own.
describe('the bulk insert is chunked, not one task', () => {
    const manager = readFileSync(fileURLToPath(new URL('../../frontend/js/proposal-manager.js', import.meta.url)), 'utf8');
    const insert = manager.slice(
        manager.indexOf('    async _addFeaturesToMap(features'),
        manager.indexOf('    _addBulkSlice(featureCollection')
    );

    it('is async, so it can hand a frame back mid-insert', () => {
        expect(manager).toContain('async _addFeaturesToMap(features, useNormalStyle = false, proposalData = null) {');
        expect(insert.length, 'slice markers did not match').toBeGreaterThan(100);
    });

    it('slices the candidates and breathes between slices', () => {
        expect(insert).toContain('const BULK_SLICE = 100;');
        expect(insert).toContain('bulkCandidates.slice(cursor, cursor + BULK_SLICE)');
        expect(insert).toContain('await window.yieldToBrowser();');
    });

    it('breathes on the CLOCK, not on a slice count', () => {
        // A slice of a hundred simple pieces is nothing; a hundred complex ones is a frame. Only
        // the clock knows which this was.
        expect(insert).toContain('if (sliceStartedAt() - heldSince >= 12) {');
    });

    it('every caller awaits it — an un-awaited insert would race the apply that follows', () => {
        const callers = [
            '../../frontend/js/proposal-manager.js',
            '../../frontend/js/proposals/apply/structures.js',
            '../../frontend/js/proposals/apply/parcels.js',
            '../../frontend/js/proposals/apply/buildings.js'
        ];
        callers.forEach(rel => {
            const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
            const calls = src.match(/(?<!await )this\._addFeaturesToMap\(/g) || [];
            expect(calls, `${rel} has an un-awaited _addFeaturesToMap`).toHaveLength(0);
        });
    });

    it('still reports the whole insert, not half of it', () => {
        // The count is taken in the method that read `beforeCount`; the per-feature half cannot
        // see it, and a count covering half the insert is worse than none.
        expect(insert).toContain('added ${afterCount - beforeCount}');
    });
});
