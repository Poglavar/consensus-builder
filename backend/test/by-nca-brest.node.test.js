// Brest Belarus must route by native cadastral key and bounded viewport in both runtimes.
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter, PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { NCA_BREST_SCOPE } from '../parcels/by-nca-source.js';

const layer = '294b19b9-3259-44e5-b8e8-000000000001';
const descriptor = {
    id: 'by-nca-public-cadastral-map', adapter: 'vector-tiles',
    endpoint: `https://map.nca.by/tiles/${layer}/{z}/{x}/{y}.pbf`,
    layer, zoom: 14, extent: 4096, identityKind: 'native', geometryMode: 'interior-only',
    idField: 'cad_num', idType: 'string', parcelNumberField: 'cad_num', idPrefix: 'BY-NCA-',
    outFields: ['cad_num'],
    idLookupBounds: [27.57568359375, 53.891391285752874, 27.59765625, 53.90433815627469]
};
function tile(id) {
    const writer = new PbfWriter();
    writer.writeMessage(3, (_, out) => {
        out.writeStringField(1, layer);
        out.writeVarintField(15, 2);
        out.writeVarintField(5, 4096);
        out.writeStringField(3, 'cad_num');
        out.writeMessage(4, (_, value) => value.writeStringField(1, id));
        out.writeMessage(2, (_, row) => {
            row.writePackedVarint(2, [0, 0]);
            row.writeVarintField(3, 3);
            row.writePackedVarint(4, [9, 2000, 2000, 26, 200, 0, 0, 200, 199, 0, 15]);
        });
    });
    return writer.finish();
}

it('Brest exact IDs, bounds and geometry work without replacing the Minsk window', async () => {
    const brestId = '140100000001016843', minskId = '500000000009000082';
    const bytes = tile(brestId), before = structuredClone(descriptor);
    const fetchImpl = mock.fn(async url => new Response(url.endsWith('/14/9271/5404.pbf') ? bytes : tile(minskId)));
    for (const create of [createParcelSource, browserParcelFactories['vector-tiles']]) {
        const source = create(descriptor, { fetchImpl });
        const result = await source.queryIds(['BY-NCA-' + brestId, 'BY-NCA-' + minskId]);
        assert.deepEqual(result.features.map(f => f.id).sort(), [brestId, minskId].map(id => 'BY-NCA-' + id));
        const parcel = result.features.find(f => f.properties.sourceParcelId === brestId);
        const native = new VectorTile(new PbfReader(bytes)).layers[layer].feature(0).toGeoJSON(9271, 5404, 14);
        assert.deepEqual(parcel.geometry, native.geometry);
        assert.deepEqual(parcel.properties.sourceProperties, { cad_num: brestId });
        const view = await source.queryBounds([23.713, 52.102, 23.715, 52.104]);
        assert.equal(view.complete, true);
        assert.equal(view.citywideComplete, false);
        assert.deepEqual(view.features, [parcel]);
        assert.deepEqual((await source.queryGeometry(parcel.geometry)).features, [parcel]);
        assert.deepEqual((await create(descriptor, { fetchImpl }).queryIds([parcel.id])).features, [parcel]);
        await assert.rejects(source.queryIds(['BY-NCA-140100999999999999']), /unresolved/);
        assert.equal((await source.queryBounds([23.713, 52.105, 23.715, 52.108])).complete, false);
    }
    assert.deepEqual(descriptor, before);
    assert.deepEqual(NCA_BREST_SCOPE.point, [23.7148717432269, 52.1048113105078]);
    assert.equal(fetchImpl.mock.calls.filter(call => call.arguments[0].endsWith('/14/9271/5404.pbf')).length, 4);
    assert.equal(fetchImpl.mock.calls.filter(call => call.arguments[0].endsWith('/14/9447/5268.pbf')).length, 2);
});
