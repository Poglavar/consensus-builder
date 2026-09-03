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
            proposalId: 'legacy-owner',
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
        expect(live.properties).not.toHaveProperty('proposalId');
    });
});
