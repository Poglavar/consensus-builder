// The live fabric's step functions (frontend/js/parcels/live-fabric.js seedCadastreSteps and
// replaceCadastreScopeSteps) run in the boot replay's slices and give exactly what the one-shot
// seedCadastre / replaceCadastreScope give, refusals included; the cadastre check yields after
// every piece and vertex it tests, so no slice holds a whole city's validation.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const workSlicer = require('../../frontend/js/work-slicer.js');

function box(id, west, south, east, north, properties = {}) {
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }
    };
}

const STEP = 0.001;
// A 4 × 3 grid of cadastral parcels, ids chosen so a numeric sort differs from a plain one.
const GRID = [];
for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
        const n = [9, 10, 100, 2][col] + row * 1000;
        GRID.push(box(`HR-1-${n}`, 15 + col * STEP, 45 + row * STEP, 15 + (col + 1) * STEP, 45 + (row + 1) * STEP));
    }
}

// What a corridor derivation hands back: each parcel of the middle row cut in two (a road strip
// and a remainder), one merge piece over two parcels of the top row, everything else untouched.
function replacementFor(grid) {
    const out = [];
    grid.forEach((fact, index) => {
        const id = fact.properties.parcelId;
        const ring = fact.geometry.coordinates[0];
        const [west, south] = ring[0];
        const [east, north] = ring[2];
        const row = Math.floor(index / 4);
        if (row === 1) {
            const mid = south + (north - south) * 0.4;
            out.push(box(`${id}#road-1`, west, south, east, mid, { cadastreParcelIds: [id], producedByProposalId: 'road', isCorridor: true }));
            out.push(box(`${id}#road-2`, west, mid, east, north, { cadastreParcelIds: [id] }));
        } else if (row === 2 && index % 4 === 0) {
            const next = grid[index + 1];
            const [nextEast] = next.geometry.coordinates[0][2];
            out.push(box(`${id}+${next.properties.parcelId}#merge-1`, west, south, nextEast, north,
                { cadastreParcelIds: [id, next.properties.parcelId], producedByProposalId: 'merge' }));
        } else if (row === 2 && index % 4 === 1) {
            // covered by the merge piece above
        } else {
            out.push({ ...structuredClone(fact), properties: { ...fact.properties, cadastreParcelIds: [id] } });
        }
    });
    return out;
}

async function seededFabric() {
    const fabric = createLiveParcelFabric();
    const mutation = fabric.beginMutation({ kind: 'ground-load' });
    mutation.seedCadastre(GRID);
    await mutation.prepare();
    mutation.publish();
    return fabric;
}

// A slicer whose every unit exhausts the budget: it pauses after each step and counts the pauses.
function pausingSlicer() {
    let t = 0;
    return workSlicer.createSlicer({ budgetMs: 1, now: () => (t += 1), yieldNow: async () => {} });
}

// The draft as readers see it, then the delta its prepare publishes.
async function stateOf(mutation) {
    const snapshot = mutation.snapshot();
    const state = {
        ids: snapshot.parcelIds.slice().sort(),
        features: snapshot.parcelIds.slice().sort().map(id => mutation.get(id)),
        occupied: mutation.occupiedCadastreIds().slice().sort()
    };
    state.delta = await mutation.prepare();
    return state;
}

async function oneShot(operation) {
    const fabric = await seededFabric();
    const mutation = fabric.beginMutation({ kind: 'rebuild-applied-fabric' });
    const returned = operation.sync(mutation);
    const state = await stateOf(mutation);
    mutation.rollback();
    return { returned, state, diagnostics: fabric.diagnostics() };
}

async function sliced(operation) {
    const fabric = await seededFabric();
    const mutation = fabric.beginMutation({ kind: 'rebuild-applied-fabric' });
    const slicer = pausingSlicer();
    const returned = await workSlicer.runSliced(operation.steps(mutation), slicer);
    const state = await stateOf(mutation);
    mutation.rollback();
    return { returned, state, diagnostics: fabric.diagnostics(), pauses: slicer.pauses };
}

describe('replaceCadastreScopeSteps', () => {
    const ids = GRID.map(fact => fact.properties.parcelId);
    const operation = {
        sync: mutation => mutation.replaceCadastreScope(ids, replacementFor(GRID)),
        steps: mutation => mutation.replaceCadastreScopeSteps(ids, replacementFor(GRID))
    };

    it('in slices gives the same draft, delta and checks as in one go', async () => {
        const expected = await oneShot(operation);
        const actual = await sliced(operation);
        expect(actual.returned).toEqual(expected.returned);
        expect(actual.state).toEqual(expected.state);
        expect(actual.diagnostics.coverageChecks).toBe(expected.diagnostics.coverageChecks);
        expect(actual.diagnostics.identityReplacements).toBe(expected.diagnostics.identityReplacements);
        // The fixture really is a change: road pieces, remainders and a merge are in, facts out.
        expect(expected.state.ids).toContain('HR-1-1009#road-1');
        expect(expected.state.ids).toContain('HR-1-2009+HR-1-2010#merge-1');
        expect(expected.state.delta.addedIds).toEqual([...expected.state.delta.addedIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    });

    it('yields after every vertex it tests against the cadastre, not once per scope', async () => {
        const replacement = replacementFor(GRID);
        const testedVertices = replacement
            .filter(feature => feature.properties.cadastreParcelIds)
            .reduce((sum, feature) => sum + feature.geometry.coordinates[0].length - 1, 0);
        const actual = await sliced(operation);
        expect(actual.pauses).toBeGreaterThanOrEqual(testedVertices);
    });

    it('refuses in slices exactly what it refuses in one go', async () => {
        const bad = replacementFor(GRID);
        bad[4].geometry.coordinates[0][1] = [15.5, 45.0011];
        const refusal = {
            sync: mutation => mutation.replaceCadastreScope(ids, bad),
            steps: mutation => mutation.replaceCadastreScopeSteps(ids, bad)
        };
        const syncError = await oneShot(refusal).catch(error => error);
        const slicedError = await sliced(refusal).catch(error => error);
        expect(syncError.code).toBe('live-fabric-replacement-outside');
        expect(slicedError.code).toBe(syncError.code);
        expect(slicedError.parcelId).toBe(syncError.parcelId);
        expect(slicedError.vertex).toEqual(syncError.vertex);
    });

    it('stops writing into a draft that was rolled back while it was paused', async () => {
        const fabric = await seededFabric();
        const mutation = fabric.beginMutation({ kind: 'rebuild-applied-fabric' });
        let paused = 0;
        let t = 0;
        const slicer = workSlicer.createSlicer({
            budgetMs: 1,
            now: () => (t += 1),
            yieldNow: async () => { paused += 1; if (paused === 5) mutation.rollback(); }
        });
        await expect(workSlicer.runSliced(mutation.replaceCadastreScopeSteps(ids, replacementFor(GRID)), slicer))
            .rejects.toMatchObject({ code: 'live-fabric-mutation-inactive' });
        expect(fabric.snapshot().parcelIds.slice().sort()).toEqual(ids.slice().sort());
    });
});

describe('seedCadastreSteps', () => {
    it('in slices registers the same facts and live parcels as in one go, re-seeding included', async () => {
        const fresh = GRID.slice(0, 6);
        const operation = {
            sync: mutation => { mutation.seedCadastre(fresh); return mutation.seedCadastre(GRID); },
            steps: mutation => (function* () { yield* mutation.seedCadastreSteps(fresh); return yield* mutation.seedCadastreSteps(GRID); })()
        };
        const run = async useSlices => {
            const fabric = createLiveParcelFabric();
            const mutation = fabric.beginMutation({ kind: 'ground-load' });
            const returned = useSlices
                ? await workSlicer.runSliced(operation.steps(mutation), pausingSlicer())
                : operation.sync(mutation);
            return { returned, state: await stateOf(mutation) };
        };
        const expected = await run(false);
        expect(expected.state.ids).toHaveLength(GRID.length);
        expect(await run(true)).toEqual(expected);
    });

    it('refuses conflicting geometry for a fact it already holds, in slices as in one go', async () => {
        const moved = structuredClone(GRID[0]);
        moved.geometry.coordinates[0][2] = [15.0011, 45.0011];
        const fabric = await seededFabric();
        const one = fabric.beginMutation({ kind: 'ground-load' });
        expect(() => one.seedCadastre([moved])).toThrow(expect.objectContaining({ code: 'cadastral-geometry-conflict' }));
        one.rollback();
        const two = fabric.beginMutation({ kind: 'ground-load' });
        await expect(workSlicer.runSliced(two.seedCadastreSteps([moved]), pausingSlicer()))
            .rejects.toMatchObject({ code: 'cadastral-geometry-conflict' });
        two.rollback();
    });
});
