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

describe('live parcel fabric', () => {
    it('keeps a mutation draft invisible to ordinary readers until commit', async () => {
        const fabric = createLiveParcelFabric();
        await fabric.transact({ kind: 'seed' }, token => {
            fabric.seedCadastre([polygon('HR-A')], { transaction: token });
        });

        const token = fabric.beginTransaction({ kind: 'replace' });
        fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#park-1', 0, {
            cadastreParcelIds: ['HR-A'],
            producedByProposalId: 'park'
        })], { transaction: token });

        expect(fabric.get('HR-A')).not.toBeNull();
        expect(fabric.get('HR-A#park-1')).toBeNull();
        expect(fabric.get('HR-A', { transaction: token })).toBeNull();
        expect(fabric.get('HR-A#park-1', { transaction: token })).not.toBeNull();

        await fabric.commit(token);
        expect(fabric.get('HR-A')).toBeNull();
        expect(fabric.get('HR-A#park-1')).not.toBeNull();
    });

    it('returns defensive copies instead of mutable fabric records', async () => {
        const fabric = createLiveParcelFabric();
        await fabric.transact({}, token => fabric.seedCadastre([polygon('HR-A')], { transaction: token }));

        const read = fabric.get('HR-A');
        read.properties.parcelId = 'CORRUPTED';
        read.geometry.coordinates[0][0][0] = 999;

        expect(fabric.get('HR-A').properties.parcelId).toBe('HR-A');
        expect(fabric.get('HR-A').geometry.coordinates[0][0][0]).toBe(0);
    });

    it('splits disconnected raw cadastral geometry deterministically', async () => {
        const fabric = createLiveParcelFabric();
        const raw = polygon('HR-A');
        raw.geometry = {
            type: 'MultiPolygon',
            coordinates: [polygon('unused', 10).geometry.coordinates, polygon('unused', 0).geometry.coordinates]
        };

        await fabric.transact({}, token => fabric.seedCadastre([raw], { transaction: token }));

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

        await expect(fabric.transact({}, token => {
            fabric.upsertFeatures([disconnected], { transaction: token });
        })).rejects.toMatchObject({ code: 'live-parcel-disconnected' });

        await expect(fabric.transact({}, token => {
            fabric.upsertFeatures([polygon('HR-A#proposal-2')], { transaction: token });
        })).rejects.toMatchObject({ code: 'live-parcel-provenance-missing' });
    });

    it('refuses a replacement scope that cuts through one connected live parcel', async () => {
        const fabric = createLiveParcelFabric();
        await fabric.transact({}, token => {
            fabric.seedCadastre([polygon('HR-A'), polygon('HR-B', 1)], { transaction: token });
        });
        await fabric.transact({}, token => {
            fabric.replaceCadastreScope(['HR-A', 'HR-B'], [polygon('HR-AB#merge-1', 0, {
                cadastreParcelIds: ['HR-A', 'HR-B'],
                producedByProposalId: 'merge'
            })], { transaction: token });
        });

        await expect(fabric.transact({}, token => {
            fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A')], { transaction: token });
        })).rejects.toMatchObject({
            code: 'live-fabric-scope-not-closed',
            requiredCadastreIds: ['HR-A', 'HR-B']
        });
        expect(fabric.snapshot().parcelIds).toEqual(['HR-AB#merge-1']);
    });

    it('rolls fabric and prepared participants back when a commit participant fails', async () => {
        const fabric = createLiveParcelFabric();
        await fabric.transact({}, token => fabric.seedCadastre([polygon('HR-A')], { transaction: token }));
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

        await expect(fabric.transact({}, token => {
            fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#park-1', 0, {
                cadastreParcelIds: ['HR-A'], producedByProposalId: 'park'
            })], { transaction: token });
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

        await fabric.transact({}, token => fabric.seedCadastre([polygon('HR-A')], { transaction: token }));
        expect(events).toEqual(['participant', 'subscriber']);
    });
});
