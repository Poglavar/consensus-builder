import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');
const source = readFileSync(new URL('../../frontend/js/parcels/ingest.js', import.meta.url), 'utf8');

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
    context.CadastralParcelRepository = createCadastralParcelRepository({
        root: context,
        convertFeatures: value => value,
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
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(source, context);
    return { context, fabric };
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
        const { context, fabric } = makeContext();
        const mutation = fabric.beginMutation({});
        mutation.upsertFeatures([
            parcel('HR-1#park-1', { cadastreParcelIds: ['HR-1'], producedByProposalId: 'park' })
        ]);
        await mutation.prepare();
        mutation.publish();

        await context.ingestCadastralParcelFeatures([parcel('HR-1')], { skipConversion: true });

        expect(fabric.get('HR-1')).toBeNull();
        expect(fabric.get('HR-1#park-1')).not.toBeNull();
    });

    it('shows unclaimed cadastral ground', async () => {
        const { context, fabric } = makeContext();

        await context.ingestCadastralParcelFeatures([parcel('HR-2')], { skipConversion: true });

        expect(fabric.get('HR-2')).not.toBeNull();
    });
});
