import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');

function makeContext() {
    const fabric = createLiveParcelFabric();
    const context = {
        console,
        performance,
        Map,
        Set,
        setTimeout,
        clearTimeout,
        CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        dispatchEvent() {},
        convertGeoJSON: value => value,
        LiveParcelFabric: fabric
    };
    const repository = createCadastralParcelRepository({
        root: context,
        convertFeatures: value => value,
        transport: {
            fetchByIds: async ids => ({
                status: 'ready', complete: true, absentIds: [], returnsWGS84: true,
                features: ids.map(id => parcel(id))
            })
        },
        onFeatures: async (features, options = {}) => {
            if (options.mutation) {
                options.mutation.seedCadastre(features);
                return;
            }
            const mutation = fabric.beginMutation({ kind: 'test-cadastral-arrival' });
            mutation.seedCadastre(features);
            await mutation.prepare();
            mutation.publish();
        }
    });
    context.CadastralParcelRepository = repository;
    context.window = context;
    context.globalThis = context;
    return { context, fabric, repository };
}

function parcel(id, properties = {}) {
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: {
            type: 'Polygon',
            coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.8]]]
        }
    };
}

describe('cadastral ingest under a standing formation', () => {
    it('indexes claimed cadastral ground but keeps it hidden from the live partition', async () => {
        const { fabric, repository } = makeContext();
        const mutation = fabric.beginMutation({});
        mutation.upsertFeatures([
            parcel('HR-1#park-1', { cadastreParcelIds: ['HR-1'], producedByProposalId: 'park' })
        ]);
        await mutation.prepare();
        mutation.publish();

        await repository.ensureIds(['HR-1']);

        expect(fabric.get('HR-1')).toBeNull();
        expect(fabric.get('HR-1#park-1')).not.toBeNull();
    });

    it('shows unclaimed cadastral ground', async () => {
        const { fabric, repository } = makeContext();

        await repository.ensureIds(['HR-2']);

        expect(fabric.get('HR-2')).not.toBeNull();
    });
});
