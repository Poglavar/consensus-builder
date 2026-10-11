import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');

function polygon(id, west = 0, properties = {}) {
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [west, 0], [west + 1, 0], [west + 1, 1], [west, 1], [west, 0]
            ]]
        }
    };
}

async function mutate(fabric, operation, meta = {}) {
    const mutation = fabric.beginMutation(meta);
    try {
        const result = await operation(mutation);
        if (result === false) { mutation.rollback(); return false; }
        await mutation.prepare();
        mutation.publish();
        return result;
    } catch (error) {
        mutation.rollback();
        throw error;
    }
}

describe('live parcel fabric', () => {
    it('keeps a mutation draft invisible to ordinary readers until commit', async () => {
        const fabric = createLiveParcelFabric();
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]), { kind: 'seed' });

        const mutation = fabric.beginMutation({ kind: 'replace' });
        mutation.replaceCadastreScope(['HR-A'], [polygon('HR-A#park-1', 0, {
            cadastreParcelIds: ['HR-A'],
            producedByProposalId: 'park'
        })]);

        expect(fabric.get('HR-A')).not.toBeNull();
        expect(fabric.get('HR-A#park-1')).toBeNull();
        expect(mutation.get('HR-A')).toBeNull();
        expect(mutation.get('HR-A#park-1')).not.toBeNull();

        await mutation.prepare();
        mutation.publish();
        expect(fabric.get('HR-A')).toBeNull();
        expect(fabric.get('HR-A#park-1')).not.toBeNull();
    });

    it('returns defensive copies instead of mutable fabric records', async () => {
        const fabric = createLiveParcelFabric();
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));

        const read = fabric.get('HR-A');
        read.properties.parcelId = 'CORRUPTED';
        read.geometry.coordinates[0][0][0] = 999;

        expect(fabric.get('HR-A').properties.parcelId).toBe('HR-A');
        expect(fabric.get('HR-A').geometry.coordinates[0][0][0]).toBe(0);
    });

    it('exposes immutable draft peeks to prepared participants while keeping get defensive', async () => {
        const fabric = createLiveParcelFabric();
        let peeked;
        let copied;
        fabric.addCommitParticipant({
            prepare: (_delta, view) => {
                peeked = view.peek('HR-A');
                copied = view.get('HR-A');
                return null;
            }
        });
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));

        expect(peeked).not.toBeNull();
        expect(Object.isFrozen(peeked)).toBe(true);
        expect(Object.isFrozen(peeked.geometry.coordinates[0])).toBe(true);
        expect(copied).not.toBe(peeked);
        copied.properties.parcelId = 'CORRUPTED';
        expect(peeked.properties.parcelId).toBe('HR-A');
        expect(fabric.get('HR-A').properties.parcelId).toBe('HR-A');
    });

    it('checks cadastral presence from its index without cloning parcel geometry', async () => {
        const fabric = createLiveParcelFabric();
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));
        const cloneSpy = vi.spyOn(globalThis, 'structuredClone');

        try {
            expect(fabric.hasCadastreEntries(['HR-A'])).toBe(true);
            expect(fabric.hasCadastreEntries(['HR-MISSING'])).toBe(false);
            expect(cloneSpy).not.toHaveBeenCalled();
        } finally {
            cloneSpy.mockRestore();
        }
    });

    it('returns normalized absent cadastral IDs in one clone-free batch and can count corridor representation', async () => {
        const fabric = createLiveParcelFabric();
        await mutate(fabric, mutation => {
            mutation.seedCadastre([polygon('HR-A')]);
            mutation.upsertFeatures([polygon('road:HR-C', 2, {
                cadastreParcelIds: ['HR-C'], producedByProposalId: 'road', isCorridor: true
            })]);
        });
        const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
        try {
            expect(fabric.absentCadastreIds([' HR-A ', ' HR-C ', 'HR-MISSING', 'HR-MISSING']))
                .toEqual(['HR-C', 'HR-MISSING']);
            expect(fabric.absentCadastreIds([' HR-A ', ' HR-C ', 'HR-MISSING'], { includeCorridors: true }))
                .toEqual(['HR-MISSING']);
            expect(cloneSpy).not.toHaveBeenCalled();
        } finally {
            cloneSpy.mockRestore();
        }
    });

    it('counts bounds with queryBounds corridor semantics without cloning geometries', async () => {
        const fabric = createLiveParcelFabric();
        await mutate(fabric, mutation => {
            mutation.seedCadastre([polygon('HR-A'), polygon('HR-B', 4)]);
            mutation.upsertFeatures([polygon('road:HR-C', 2, {
                cadastreParcelIds: ['HR-C'], producedByProposalId: 'road', isCorridor: true
            })]);
        });

        const defaultCount = fabric.countBounds([-1, -1, 5, 2]);
        expect(defaultCount).toBe(fabric.queryBounds([-1, -1, 5, 2]).length);
        const inclusiveCount = fabric.countBounds([-1, -1, 5, 2], { includeCorridors: true });
        expect(inclusiveCount).toBe(fabric.queryBounds([-1, -1, 5, 2], { includeCorridors: true }).length);

        const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
        try {
            expect(fabric.countBounds([-1, -1, 5, 2])).toBe(defaultCount);
            expect(cloneSpy).not.toHaveBeenCalled();
        } finally {
            cloneSpy.mockRestore();
        }
    });

    it('splits disconnected raw cadastral geometry deterministically', async () => {
        const fabric = createLiveParcelFabric();
        const raw = polygon('HR-A');
        raw.geometry = {
            type: 'MultiPolygon',
            coordinates: [polygon('unused', 10).geometry.coordinates, polygon('unused', 0).geometry.coordinates]
        };

        await mutate(fabric, mutation => mutation.seedCadastre([raw]));

        expect(fabric.snapshot().parcelIds).toEqual(['HR-A#cadastre-1', 'HR-A#cadastre-2']);
        expect(fabric.get('HR-A#cadastre-1').geometry.coordinates[0][0][0]).toBe(0);
        expect(fabric.get('HR-A#cadastre-2').geometry.coordinates[0][0][0]).toBe(10);
        expect(fabric.cadastreIdsForParcelIds(['HR-A#cadastre-1'])).toEqual(['HR-A']);
    });

    it('rejects disconnected generated parcels and missing provenance', async () => {
        const fabric = createLiveParcelFabric();
        const disconnected = polygon('HR-A#proposal-1', 0, {
            cadastreParcelIds: ['HR-A'],
            producedByProposalId: 'proposal'
        });
        disconnected.geometry = {
            type: 'MultiPolygon',
            coordinates: [polygon('unused', 0).geometry.coordinates, polygon('unused', 2).geometry.coordinates]
        };

        await expect(mutate(fabric, mutation => {
            mutation.upsertFeatures([disconnected]);
        })).rejects.toMatchObject({ code: 'live-parcel-disconnected' });

        await expect(mutate(fabric, mutation => {
            mutation.upsertFeatures([polygon('HR-A#proposal-2')]);
        })).rejects.toMatchObject({ code: 'live-parcel-provenance-missing' });
    });

    it('refuses a replacement scope that cuts through one connected live parcel', async () => {
        const fabric = createLiveParcelFabric();
        await mutate(fabric, mutation => {
            mutation.seedCadastre([polygon('HR-A'), polygon('HR-B', 1)]);
        });
        await mutate(fabric, mutation => {
            const merged = polygon('HR-AB#merge-1', 0, {
                cadastreParcelIds: ['HR-A', 'HR-B'],
                producedByProposalId: 'merge'
            });
            merged.geometry.coordinates = [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]];
            mutation.replaceCadastreScope(['HR-A', 'HR-B'], [merged]);
        });

        await expect(mutate(fabric, mutation => {
            mutation.replaceCadastreScope(['HR-A'], [polygon('HR-A')]);
        })).rejects.toMatchObject({
            code: 'live-fabric-scope-not-closed',
            requiredCadastreIds: ['HR-A', 'HR-B']
        });
        expect(fabric.snapshot().parcelIds).toEqual(['HR-AB#merge-1']);
    });

    it('rolls fabric and prepared participants back when a commit participant fails', async () => {
        const fabric = createLiveParcelFabric();
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));
        const events = [];
        const subscriber = vi.fn();
        fabric.addCommitParticipant({
            prepare: change => { events.push('first:prepare'); return change; },
            commit: () => events.push('first:commit'),
            rollback: () => events.push('first:rollback')
        });
        fabric.addCommitParticipant({
            prepare: change => { events.push('second:prepare'); return change; },
            commit: () => { events.push('second:commit'); throw new Error('projection failed'); },
            rollback: () => events.push('second:rollback')
        });
        fabric.subscribe(subscriber);

        await expect(mutate(fabric, mutation => {
            mutation.replaceCadastreScope(['HR-A'], [polygon('HR-A#park-1', 0, {
                cadastreParcelIds: ['HR-A'], producedByProposalId: 'park'
            })]);
        })).rejects.toThrow('projection failed');

        expect(events).toEqual([
            'first:prepare', 'second:prepare',
            'first:commit', 'second:commit',
            'second:rollback', 'first:rollback'
        ]);
        expect(fabric.get('HR-A')).not.toBeNull();
        expect(fabric.get('HR-A#park-1')).toBeNull();
        expect(subscriber).not.toHaveBeenCalled();
    });

    it('notifies subscribers only after every participant sees the committed revision', async () => {
        const fabric = createLiveParcelFabric();
        const events = [];
        fabric.addCommitParticipant({
            prepare: change => change,
            commit: () => {
                expect(fabric.get('HR-A')).not.toBeNull();
                events.push('participant');
            }
        });
        fabric.subscribe(() => events.push('subscriber'));

        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));
        expect(events).toEqual(['participant', 'subscriber']);
    });
});
