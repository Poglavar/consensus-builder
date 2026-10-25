import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const projection = '+proj=tmerc +lat_0=0 +lon_0=36 +k=1 +x_0=-1009.35 +y_0=-5526802.42 +ellps=krass +towgs84=24,-121,-76 +units=m +no_defs';
const descriptor = {
    id: 'ua-khmr-address-plots', adapter: 'arcgis',
    endpoint: 'https://ar.khmr.gov.ua/arcgis/rest/services/ARAddressPlots/MapServer/0',
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idPrefix: 'UA-KHMR-PLOT-', outFields: ['OBJECTID'],
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', queryFormat: 'geojson',
    responseSrid: 28467, responseProjection: projection, boundsSrid: 28467, boundsProjection: projection,
    maxResponseBytes: 16777216, pageSize: 80, maxFeatures: 1000
};
// Synthetic ring, not a retained research parcel. Expected coordinates computed independently
// with PROJ/pyproj, always_xy=True, using the published municipal definition.
const ring = [[18000, 12500], [18010, 12500], [18010, 12510], [18000, 12510], [18000, 12500]];
const expected = [[36.263493783836125, 49.98487892866126], [36.26363321650946, 49.98487861192276],
    [36.263633707874625, 49.98496851550854], [36.263494274941415, 49.984968832248065],
    [36.263493783836125, 49.98487892866126]];
const collection = crs => ({ type: 'FeatureCollection', crs,
    features: [{ type: 'Feature', properties: { OBJECTID: 1 }, geometry: { type: 'Polygon', coordinates: [ring] } }] });
const nativeCrs = { type: 'name', properties: { name: 'EPSG:28467' } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: municipal projection preserves full rings and repeats native IDs`, async () => {
        const calls = [];
        const fetchImpl = async input => {
            const url = new URL(input), q = url.searchParams;
            calls.push(url);
            assert.equal(q.get('outFields'), 'OBJECTID');
            if (q.has('returnCountOnly')) return json({ count: 1 });
            if (q.has('returnIdsOnly')) return json({ objectIdFieldName: 'OBJECTID', objectIds: [1] });
            assert.equal(q.get('objectIds'), '1');
            assert.equal(q.get('outSR'), '28467');
            assert.equal(q.has('geometry'), false);
            return json(collection(nativeCrs));
        };
        const adapter = factory(descriptor, { fetchImpl });
        const viewport = await adapter.queryBounds([36.26350, 49.98488, 36.26354, 49.98490]);
        const exact = await adapter.queryIds(['UA-KHMR-PLOT-1']);
        const repeat = await adapter.queryIds(['UA-KHMR-PLOT-1']);
        assert.equal(viewport.complete, true);
        assert.deepEqual(viewport.features, exact.features);
        assert.deepEqual(repeat.features, exact.features);
        const actual = exact.features[0].geometry.coordinates[0];
        assert.equal(actual.length, ring.length);
        actual.forEach((point, i) => point.forEach((v, axis) => assert.ok(Math.abs(v - expected[i][axis]) < 1e-8)));
        assert.ok(actual[0][0] < 36.26350, 'crossing-boundary geometry is not clipped');
        assert.equal(calls[0].searchParams.get('inSR'), '28467');
        const nativeBounds = calls[0].searchParams.get('geometry').split(',').map(Number);
        assert.ok(nativeBounds[0] > 17900 && nativeBounds[2] < 18100);
        assert.equal(JSON.stringify(ring), '[[18000,12500],[18010,12500],[18010,12510],[18000,12510],[18000,12500]]');
    });
}

test('custom projection rejects absent or changed native response labels', async () => {
    for (const crs of [undefined, { type: 'name', properties: { name: 'EPSG:4326' } }]) {
        const adapter = createParcelSource(descriptor, { fetchImpl: async input => {
            const q = new URL(input).searchParams;
            return json(q.has('returnCountOnly') ? { count: 1 } : q.has('returnIdsOnly')
                ? { objectIds: [1] } : collection(crs));
        } });
        await assert.rejects(adapter.queryIds(['UA-KHMR-PLOT-1']), /projected response CRS/);
    }
    for (const change of [{ responseSrid: undefined }, { responseProjection: undefined },
        { responseProjection: '' }, { queryFormat: 'esri-json' }, { maxResponseBytes: 0 }]) {
        assert.throws(() => createParcelSource({ ...descriptor, ...change }));
    }
});

test('configured streamed byte cap rejects and cancels an oversized chunked response', async () => {
    let cancelled = false;
    const adapter = createParcelSource({ ...descriptor, maxResponseBytes: 32 }, { fetchImpl: async () => new Response(
        new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33)); },
            cancel() { cancelled = true; } })) });
    await assert.rejects(adapter.queryIds(['UA-KHMR-PLOT-1']), /byte limit/);
    assert.equal(cancelled, true);
});
