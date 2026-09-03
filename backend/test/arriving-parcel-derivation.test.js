// Late cadastral arrivals enter through one repository acceptance path. The repository owns
// request/cache deduplication. Every consumer separately asks it to provision the immutable fact
// into that consumer's transaction; transport is still performed only once.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');

const parcel = id => ({
    type: 'Feature',
    properties: { parcelId: id },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
});

function repository({ onFeatures = vi.fn(), transport } = {}) {
    return createCadastralParcelRepository({
        root: {},
        convertFeatures: collection => collection,
        onFeatures,
        transport
    });
}

describe('cadastral arrival publication', () => {
    it('joins concurrent consumers onto one transport and provisions each consumer', async () => {
        const onFeatures = vi.fn();
        const fetchByIds = vi.fn(async ids => ({
            status: 'ready', complete: true, absentIds: [], returnsWGS84: true,
            features: ids.map(parcel)
        }));
        const ground = repository({ onFeatures, transport: { fetchByIds } });

        const [first, second] = await Promise.all([
            ground.ensureIds(['HR-A']),
            ground.ensureIds(['HR-A'])
        ]);

        expect(first.features.map(f => f.properties.parcelId)).toEqual(['HR-A']);
        expect(second.features.map(f => f.properties.parcelId)).toEqual(['HR-A']);
        expect(fetchByIds).toHaveBeenCalledTimes(1);
        expect(onFeatures).toHaveBeenCalledTimes(2);
    });

    it('serves subsequent consumers from retained facts and provisions each consumer without refetching', async () => {
        const onFeatures = vi.fn();
        const fetchByIds = vi.fn(async () => ({
            status: 'ready', complete: true, absentIds: [], returnsWGS84: true,
            features: [parcel('HR-A')]
        }));
        const ground = repository({ onFeatures, transport: { fetchByIds } });

        await ground.ensureIds(['HR-A']);
        await ground.ensureIds(['HR-A']);

        expect(fetchByIds).toHaveBeenCalledTimes(1);
        expect(onFeatures).toHaveBeenCalledTimes(2);
    });

    it('treats parcel ids as opaque and asks the cadastral transport for the exact id', async () => {
        const fetchByIds = vi.fn(async ids => ({
            status: 'ready', complete: true, absentIds: [], returnsWGS84: true,
            features: ids.map(parcel)
        }));
        const ground = repository({ transport: { fetchByIds } });

        await expect(ground.ensureIds(['HR-A#piece']))
            .resolves.toMatchObject({ foundIds: ['HR-A#piece'] });
        expect(fetchByIds).toHaveBeenCalledWith(['HR-A#piece'], expect.any(Object));
    });

    it('retains an immutable fact when live-fabric provisioning fails, then retries provisioning without transport', async () => {
        const onFeatures = vi.fn()
            .mockRejectedValueOnce(new Error('fabric commit failed'))
            .mockResolvedValueOnce(undefined);
        const ground = repository({ onFeatures });

        await expect(ground.acceptFeatures([parcel('HR-A')], { skipConversion: true }))
            .rejects.toThrow('fabric commit failed');
        expect(ground.get('HR-A')).not.toBeNull();

        await ground.acceptFeatures([parcel('HR-A')], { skipConversion: true });
        expect(ground.get('HR-A')).not.toBeNull();
        expect(onFeatures).toHaveBeenCalledTimes(2);
    });
});
