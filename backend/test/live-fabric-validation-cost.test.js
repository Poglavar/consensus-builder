// The cadastral-replacement validator's shortcuts (frontend/js/parcels/live-fabric.js
// validateReplacement): an identity replacement skips the per-vertex test, a vertex outside a
// fact's widened bbox skips point-in-polygon, and merge groups list their members correctly.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');

function box(id, west, south, east, north, properties = {}) {
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: {
            type: 'Polygon',
            coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
        }
    };
}

// turf, with booleanPointInPolygon counted and its vertices recorded.
function spiedGeometry() {
    const calls = [];
    const geometry = {
        ...turf,
        booleanPointInPolygon(point, polygon, options) {
            calls.push(point);
            return turf.booleanPointInPolygon(point, polygon, options);
        }
    };
    return { geometry, calls };
}

async function commit(fabric, operation, meta = {}) {
    const mutation = fabric.beginMutation(meta);
    try {
        const result = await operation(mutation);
        await mutation.prepare();
        mutation.publish();
        return result;
    } catch (error) {
        mutation.rollback();
        throw error;
    }
}

async function seeded(features) {
    const spy = spiedGeometry();
    const fabric = createLiveParcelFabric({ geometry: spy.geometry });
    await commit(fabric, mutation => mutation.seedCadastre(features), { kind: 'ground-load' });
    spy.calls.length = 0;
    return { fabric, calls: spy.calls };
}

describe('identity replacement', () => {
    it('replacing a fact by its own geometry tests no vertex', async () => {
        const { fabric, calls } = await seeded([box('HR-A', 15, 45, 15.001, 45.001)]);

        await commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'],
            [box('HR-A', 15, 45, 15.001, 45.001, { cadastreParcelIds: ['HR-A'] })]), { kind: 'rebuild-applied-fabric' });

        expect(calls).toHaveLength(0);
        expect(fabric.diagnostics().identityReplacements).toBe(1);
        expect(fabric.snapshot().parcelIds).toEqual(['HR-A']);
    });

    it('treats each component of a two-part cadastral fact as identity', async () => {
        const raw = box('HR-M', 15, 45, 15.001, 45.001);
        raw.geometry = {
            type: 'MultiPolygon',
            coordinates: [
                box('x', 15, 45, 15.0004, 45.001).geometry.coordinates,
                box('y', 15.0006, 45, 15.001, 45.001).geometry.coordinates
            ]
        };
        const { fabric, calls } = await seeded([raw]);

        await commit(fabric, mutation => mutation.replaceCadastreScope(['HR-M'], [raw]),
            { kind: 'rebuild-applied-fabric' });

        expect(calls).toHaveLength(0);
        expect(fabric.diagnostics().identityReplacements).toBe(2);
    });

    it('still tests every vertex of a real replacement, even one with the same id and provenance', async () => {
        const { fabric, calls } = await seeded([box('HR-A', 15, 45, 15.001, 45.001)]);
        // One corner pulled in by a hair: inside the fact, but not the fact's own coordinates.
        const nearly = box('HR-A', 15, 45, 15.001, 45.001, { cadastreParcelIds: ['HR-A'] });
        nearly.geometry.coordinates[0][2] = [15.000999, 45.000999];

        await commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [nearly]),
            { kind: 'rebuild-applied-fabric' }).catch(() => {});

        expect(calls.length).toBeGreaterThanOrEqual(4);
        expect(fabric.diagnostics().identityReplacements).toBe(0);
    });

    it('refuses a replacement that leaves the fact even when its id and provenance match', async () => {
        const { fabric } = await seeded([box('HR-A', 15, 45, 15.001, 45.001)]);
        const outside = box('HR-A', 15, 45, 15.0012, 45.001, { cadastreParcelIds: ['HR-A'] });

        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [outside]),
            { kind: 'rebuild-applied-fabric' })).rejects.toMatchObject({ code: 'live-fabric-replacement-outside' });
    });
});

describe('bbox prefilter', () => {
    it('rejects a far vertex without a point-in-polygon test', async () => {
        const { fabric, calls } = await seeded([box('HR-A', 15, 45, 15.001, 45.001)]);
        const far = [15.01, 45.0005];
        const piece = box('HR-A#far', 15, 45, 15.001, 45.001,
            { cadastreParcelIds: ['HR-A'], producedByProposalId: 'p1' });
        piece.geometry.coordinates[0].splice(2, 0, far);

        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [piece]),
            { kind: 'proposal-apply' })).rejects.toMatchObject({ code: 'live-fabric-replacement-outside', vertex: far });

        expect(calls.some(point => point[0] === far[0] && point[1] === far[1])).toBe(false);
    });

    it('accepts a vertex on the boundary within tolerance', async () => {
        const { fabric } = await seeded([box('HR-A', 15, 45, 15.001, 45.001)]);
        // ~0.4 mm east of the eastern edge: outside the polygon, inside VERTEX_TOLERANCE_M (NOISE_M, 1 mm).
        const piece = box('HR-A#edge', 15, 45, 15.001 + 5e-9, 45.001,
            { cadastreParcelIds: ['HR-A'], producedByProposalId: 'p1' });

        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [piece]),
            { kind: 'proposal-apply' })).resolves.toEqual(expect.any(Array));
    });

    it('refuses ground missing beyond a noise-wide strip along the edges (the old 1 m² budget passed it)', async () => {
        const { fabric } = await seeded([box('HR-A', 15, 45, 15.001, 45.001)]);
        // Stops ~6.7 mm short of the north edge: ~0.52 m² missing, over NOISE_M × the ~379 m boundary.
        const piece = box('HR-A#short', 15, 45, 15.001, 45.001 - 6e-8,
            { cadastreParcelIds: ['HR-A'], producedByProposalId: 'p1' });
        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [piece]),
            { kind: 'proposal-apply' })).rejects.toMatchObject({ code: 'live-fabric-replacement-hole' });
    });

    it('refuses a vertex a centimetre past the boundary (the old 2 cm tolerance accepted it)', async () => {
        const { fabric } = await seeded([box('HR-A', 15, 45, 15.001, 45.001)]);
        const piece = box('HR-A#edge', 15, 45, 15.001 + 1e-7, 45.001,
            { cadastreParcelIds: ['HR-A'], producedByProposalId: 'p1' });
        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [piece]),
            { kind: 'proposal-apply' })).rejects.toMatchObject({ code: 'live-fabric-replacement-outside' });
    });
});

describe('merge groups', () => {
    it('names every member of a merged group in a coverage refusal', async () => {
        const { fabric } = await seeded([
            box('HR-A', 15, 45, 15.001, 45.001),
            box('HR-B', 15.001, 45, 15.002, 45.001),
            box('HR-C', 15.002, 45, 15.003, 45.001)
        ]);
        // A merge of A and B that covers only half of them; C is replaced exactly.
        const merged = box('AB#1', 15, 45, 15.001, 45.001,
            { cadastreParcelIds: ['HR-A', 'HR-B'], producedByProposalId: 'p1' });
        const c = box('HR-C#1', 15.002, 45, 15.003, 45.001,
            { cadastreParcelIds: ['HR-C'], producedByProposalId: 'p1' });

        const refusal = await commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A', 'HR-B', 'HR-C'], [c, merged]),
            { kind: 'proposal-apply' }).catch(error => error);

        expect(refusal.code).toBe('live-fabric-replacement-hole');
        expect(refusal.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
    });
});
