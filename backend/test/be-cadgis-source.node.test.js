// Exercise CadGIS native exact identity, unchanged geometry, byte caps and companion relay scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCadgisParcelSource, CADGIS_ARCHIVE, CADGIS_LIVE_LAYER } from '../parcels/be-cadgis-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { adapter: 'be-cadgis', id: 'be-fps-finances-cadgis-cadastral-parcels',
    endpoint: CADGIS_ARCHIVE, liveEndpoint: CADGIS_LIVE_LAYER, idPrefix: 'BE-FPS-CADGIS:',
    idField: 'CaPaKey', objectIdField: 'OBJECTID', idType: 'string', sourceCrs: 'EPSG:3812',
    outFields: ['CaPaKey', 'OBJECTID'], pageSize: 250, maxFeatures: 2000 };
const native = '21803C1824/00A000', id = `${descriptor.idPrefix}${native}`;
const geometry = { type: 'Polygon', coordinates: [
    [[4.36, 50.84], [4.361, 50.84], [4.361, 50.841], [4.36, 50.841], [4.36, 50.84]],
    [[4.3602, 50.8402], [4.3602, 50.8404], [4.3604, 50.8404], [4.3604, 50.8402], [4.3602, 50.8402]]
] };
const feature = { type: 'Feature', geometry, properties: { CaPaKey: native, OBJECTID: 123 } };

test('backend and browser query the live companion and preserve exact native ID and every ring', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['be-cadgis']]) {
        let count = 0;
        const source = factory(descriptor, { fetchImpl: async url => {
            const u = new URL(url); count++;
            assert.equal(u.origin + u.pathname, `${CADGIS_LIVE_LAYER}/query`);
            assert.equal(u.searchParams.get('outFields'), 'CaPaKey,OBJECTID');
            assert.equal(u.searchParams.get('outSR'), '4326');
            assert.match(u.searchParams.get('where'), /21803C1824\/00A000/);
            assert.equal(u.searchParams.has('geometryPrecision'), false);
            return Response.json({ type: 'FeatureCollection', features: [feature] });
        } });
        for (let read = 0; read < 2; read++) {
            const result = await source.queryIds([id]);
            assert.equal(result.complete, true);
            assert.deepEqual(result.absentIds, []);
            assert.equal(result.features[0].id, id);
            assert.deepEqual(result.features[0].geometry, geometry);
        }
        assert.equal(count, 2);
        await assert.rejects(source.queryIds(['BE-FPS-CADGIS:invalid']), /Invalid/);
    }
});

test('over-limit chunked responses fail and cancel the stream', async () => {
    let cancelled = false;
    const source = createCadgisParcelSource(descriptor, { fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; }
    })) });
    await assert.rejects(source.queryIds([id]), /byte limit/);
    assert.equal(cancelled, true);
});

test('preserve the native underscore used for an absent cadastral letter in viewport and exact reads', async () => {
    const key = '21803C1353/00_000';
    const source = createCadgisParcelSource(descriptor, { fetchImpl: async () => Response.json({
        type: 'FeatureCollection', features: [{ ...feature, properties: { CaPaKey: key, OBJECTID: 456 } }]
    }) });
    const expected = descriptor.idPrefix + key;
    assert.equal((await source.queryBounds([4.36, 50.84, 4.361, 50.841])).features[0].id, expected);
    const result = await source.queryIds([expected]);
    assert.equal(result.features[0].properties.sourceParcelId, key);
    assert.deepEqual(result.features[0].geometry, geometry);
});

test('complete empty exact results report absence; HTTP denial remains an error', async () => {
    const empty = createCadgisParcelSource(descriptor, { fetchImpl: async () => Response.json({ type: 'FeatureCollection', features: [] }) });
    assert.deepEqual((await empty.queryIds([id])).absentIds, [id]);
    const denied = createCadgisParcelSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) });
    await assert.rejects(denied.queryIds([id]));
});

test('reject mismatched archive, unsafe fields and undocumented filtering', () => {
    for (const patch of [{ endpoint: CADGIS_ARCHIVE + '?different' }, { liveEndpoint: CADGIS_LIVE_LAYER + '/other' },
        { outFields: ['CaPaKey', 'OBJECTID', 'Editor'] }, { attributeFilters: { Status: 'UN' } }]) {
        assert.throws(() => createCadgisParcelSource({ ...descriptor, ...patch }), /Invalid/);
    }
});

test('relay permits only the pinned companion query path for the exact archive source', () => {
    const validate = (url, source = descriptor) => validateParcelProviderRelayRequest(source.id, { url }, { sources: [source] });
    assert.equal(validate(`${CADGIS_LIVE_LAYER}/query?f=geojson`).target.pathname, new URL(`${CADGIS_LIVE_LAYER}/query`).pathname);
    assert.throws(() => validate(CADGIS_LIVE_LAYER.replace('/11', '/9') + '/query'));
    assert.throws(() => validate(`${CADGIS_LIVE_LAYER}/query`, { ...descriptor, endpoint: CADGIS_ARCHIVE + '?other' }));
});
