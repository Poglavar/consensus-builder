import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

async function oneParcelFabric() {
    const fabric = createLiveParcelFabric();
    await commit(fabric, mutation => mutation.seedCadastre([
        box('HR-A', 15, 45, 15.001, 45.001)
    ]), { kind: 'ground-load' });
    return fabric;
}

const generated = (id, west, south, east, north, properties = {}) => box(
    id, west, south, east, north,
    { cadastreParcelIds: ['HR-A'], producedByProposalId: 'proposal-1', ...properties }
);

describe('strict cadastral scope replacement', () => {
    it('accepts an exact connected partition', async () => {
        const fabric = await oneParcelFabric();

        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [
            generated('HR-A#left', 15, 45, 15.0005, 45.001),
            generated('HR-A#right', 15.0005, 45, 15.001, 45.001)
        ]), { kind: 'proposal-apply' })).resolves.toEqual(expect.any(Array));

        expect(fabric.snapshot().parcelIds.sort()).toEqual(['HR-A#left', 'HR-A#right']);
    });

    it.each([
        ['empty', [], 'live-fabric-empty-replacement'],
        ['holed', [generated('HR-A#half', 15, 45, 15.0005, 45.001)], 'live-fabric-replacement-hole'],
        ['outside', [generated('HR-A#outside', 15, 45, 15.0012, 45.001)], 'live-fabric-replacement-outside'],
        ['overlapping', [
            generated('HR-A#left', 15, 45, 15.0006, 45.001),
            generated('HR-A#right', 15.0005, 45, 15.001, 45.001)
        ], 'live-fabric-replacement-overlap']
    ])('refuses an %s replacement without changing the committed revision', async (_name, replacements, code) => {
        const fabric = await oneParcelFabric();
        const before = fabric.snapshot();

        await expect(commit(fabric, mutation => {
            mutation.replaceCadastreScope(['HR-A'], replacements);
        }, { kind: 'proposal-apply' })).rejects.toMatchObject({ code });

        expect(fabric.snapshot()).toEqual(before);
        expect(fabric.get('HR-A')).not.toBeNull();
    });

    it('refuses disconnected output and provenance outside the closed scope', async () => {
        const fabric = await oneParcelFabric();
        const disconnected = generated('HR-A#pieces', 15, 45, 15.001, 45.001);
        disconnected.geometry = {
            type: 'MultiPolygon',
            coordinates: [
                box('x', 15, 45, 15.0004, 45.001).geometry.coordinates,
                box('y', 15.0006, 45, 15.001, 45.001).geometry.coordinates
            ]
        };

        await expect(commit(fabric, mutation => {
            mutation.replaceCadastreScope(['HR-A'], [disconnected]);
        }, { kind: 'proposal-apply' })).rejects.toMatchObject({ code: 'live-parcel-disconnected' });

        await expect(commit(fabric, mutation => {
            mutation.replaceCadastreScope(['HR-A'], [generated(
                'HR-A#wrong', 15, 45, 15.001, 45.001,
                { cadastreParcelIds: ['HR-B'] }
            )]);
        }, { kind: 'proposal-apply' })).rejects.toMatchObject({ code: 'live-fabric-scope-violation' });
    });

    it.each(['parentParcelIds', 'ancestorProposal', 'proposalId'])(
        'rejects retired %s provenance instead of cleaning it up',
        async field => {
            const fabric = await oneParcelFabric();
            await expect(commit(fabric, mutation => {
                mutation.replaceCadastreScope(['HR-A'], [generated(
                    'HR-A#wrong-shape', 15, 45, 15.001, 45.001,
                    { [field]: field === 'parentParcelIds' ? ['HR-A'] : 'proposal-old' }
                )]);
            }, { kind: 'proposal-apply' })).rejects.toMatchObject({
                code: 'live-parcel-retired-provenance',
                field
            });
        }
    );

    it('reserves intentional ground removal for repository reset/unload mutations', async () => {
        const fabric = await oneParcelFabric();

        await expect(commit(fabric, mutation => {
            mutation.releaseCadastreScope(['HR-A'], 'proposal cleanup', { unloadFacts: true });
        }, { kind: 'proposal-unapply' })).rejects.toMatchObject({ code: 'live-fabric-release-forbidden' });

        await commit(fabric, mutation => {
            mutation.releaseCadastreScope(['HR-A'], 'repository unload', { unloadFacts: true });
        }, { kind: 'repository-unload' });
        expect(fabric.snapshot().parcelIds).toEqual([]);
    });
});

describe('fabric deltas and live provenance', () => {
    it('publishes ID-only deltas and canonical producer/formation metadata', async () => {
        const fabric = await oneParcelFabric();
        const deltas = [];
        fabric.subscribe(delta => deltas.push(delta));
        const replacement = generated('HR-A#formed', 15, 45, 15.001, 45.001, {
            formedByProposalIds: ['corridor-2', 'corridor-1', 'corridor-2']
        });

        await commit(fabric, mutation => {
            mutation.replaceCadastreScope(['HR-A'], [replacement]);
        }, { kind: 'proposal-apply' });

        expect(deltas).toHaveLength(1);
        expect(Object.keys(deltas[0]).sort()).toEqual([
            'addedIds', 'changedCadastreIds', 'fromRevision', 'removedIds', 'revision', 'updatedIds'
        ]);
        expect(deltas[0]).toMatchObject({
            addedIds: ['HR-A#formed'],
            removedIds: ['HR-A'],
            changedCadastreIds: ['HR-A']
        });
        expect(deltas[0]).not.toHaveProperty('features');

        const live = fabric.get('HR-A#formed');
        expect(live.properties.producedByProposalId).toBe('proposal-1');
        expect(live.properties.formedByProposalIds).toEqual(['corridor-2', 'corridor-1']);
    });
});

// The coverage invariant must not depend on polygon boolean operations: unioning a corridor scope
// of hundreds of adjacent parcels crashed turf's clipper on real ground ("Unable to find segment in
// SweepLine tree") and pairwise intersects overflowed the stack. Area accounting per parcel plus a
// per-vertex boundary test gives the same verdicts without the clipper.
describe('coverage validation without polygon boolean operations', () => {
    const turf = require('@turf/turf');
    const throwing = () => { throw new Error('polygon clipper must not be called by the coverage invariant'); };
    const geometry = { ...turf, union: throwing, intersect: throwing, difference: throwing };

    it('accepts an exact partition while union, intersect and difference throw', async () => {
        const fabric = createLiveParcelFabric({ geometry });
        await commit(fabric, mutation => mutation.seedCadastre([box('HR-A', 15, 45, 15.001, 45.001)]), { kind: 'ground-load' });

        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [
            generated('HR-A#left', 15, 45, 15.0005, 45.001),
            generated('HR-A#right', 15.0005, 45, 15.001, 45.001)
        ]), { kind: 'proposal-apply' })).resolves.toEqual(expect.any(Array));
    });

    it('still refuses holes, overlaps and outside pieces while the clipper throws', async () => {
        const cases = [
            [[generated('HR-A#half', 15, 45, 15.0005, 45.001)], 'live-fabric-replacement-hole'],
            [[generated('HR-A#outside', 15, 45, 15.0012, 45.001)], 'live-fabric-replacement-outside'],
            [[generated('HR-A#left', 15, 45, 15.0006, 45.001), generated('HR-A#right', 15.0005, 45, 15.001, 45.001)], 'live-fabric-replacement-overlap']
        ];
        for (const [replacements, code] of cases) {
            const fabric = createLiveParcelFabric({ geometry });
            await commit(fabric, mutation => mutation.seedCadastre([box('HR-A', 15, 45, 15.001, 45.001)]), { kind: 'ground-load' });
            await expect(commit(fabric, mutation => {
                mutation.replaceCadastreScope(['HR-A'], replacements);
            }, { kind: 'proposal-apply' })).rejects.toMatchObject({ code });
        }
    });

    it('validates a 300-parcel corridor scope split into two pieces each in well under a second', async () => {
        const fabric = createLiveParcelFabric({ geometry });
        const ids = Array.from({ length: 300 }, (_, i) => `HR-S-${i}`);
        await commit(fabric, mutation => mutation.seedCadastre(
            ids.map((id, i) => box(id, 15 + i * 0.001, 45, 15 + (i + 1) * 0.001, 45.001))
        ), { kind: 'ground-load' });
        const pieces = ids.flatMap((id, i) => [
            box(`${id}#a`, 15 + i * 0.001, 45, 15 + i * 0.001 + 0.0004, 45.001, { cadastreParcelIds: [id], producedByProposalId: 'road' }),
            box(`${id}#b`, 15 + i * 0.001 + 0.0004, 45, 15 + (i + 1) * 0.001, 45.001, { cadastreParcelIds: [id], producedByProposalId: 'road' })
        ]);
        const started = performance.now();
        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(ids, pieces), { kind: 'proposal-apply' }))
            .resolves.toEqual(expect.any(Array));
        expect(performance.now() - started).toBeLessThan(1500);
        expect(fabric.snapshot().featureCount).toBe(600);
    });
});

// An untouched cadastral parcel that the corridor arrangement hands back whole may have several
// parts. Replacing a scope with it must split it like a seed, not refuse the whole replacement.
describe('replacement with a whole multipart cadastral parcel', () => {
    it('splits the original parcel into cadastral parts instead of refusing the scope', async () => {
        const fabric = createLiveParcelFabric();
        const twoParts = {
            type: 'Feature',
            properties: { parcelId: 'HR-M' },
            geometry: { type: 'MultiPolygon', coordinates: [
                box('x', 15, 45, 15.001, 45.001).geometry.coordinates,
                box('x', 15.002, 45, 15.003, 45.001).geometry.coordinates
            ] }
        };
        await commit(fabric, mutation => mutation.seedCadastre([twoParts]), { kind: 'ground-load' });
        expect(fabric.snapshot().parcelIds.sort()).toEqual(['HR-M#cadastre-1', 'HR-M#cadastre-2']);

        await expect(commit(fabric, mutation => mutation.replaceCadastreScope(['HR-M'], [
            { ...twoParts, properties: { parcelId: 'HR-M', cadastreParcelIds: ['HR-M'] } }
        ]), { kind: 'proposal-apply' })).resolves.toEqual(expect.any(Array));
        expect(fabric.snapshot().parcelIds.sort()).toEqual(['HR-M#cadastre-1', 'HR-M#cadastre-2']);
    });
});
