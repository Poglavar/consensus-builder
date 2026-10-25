import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'test-layer-family', adapter: 'wfs', wfsProfile: 'native-feature-id-layers-v1',
    endpoint: 'https://example.org/geoserver/wfs', version: '1.0.0',
    featureType: 'zambia:First_Parcels', featureTypes: ['zambia:First_Parcels', 'zambia:Second_Parcels'],
    geometryField: 'the_geom', nativeIdMode: 'feature-id', featureIdParameter: 'featureID',
    idField: null, idType: 'string', idPrefix: 'TEST-', outFields: [], requestProperties: true,
    pageSize: 1, idBatchSize: 1, maxFeatures: 10, maxBboxKm2: 4
};
const geometry = { type: 'MultiPolygon', coordinates: [[
    [[28.245,-12.565],[28.246,-12.565],[28.246,-12.564],[28.245,-12.564],[28.245,-12.565]]
]] };
const raw = (layer, id) => ({ type: 'Feature', id: `${layer}.${id}`, properties: {}, geometry });
function fixture(factory = createWfsParcelSource, failLayer = null, override = {}) {
    const requests = [];
    const source = factory({ ...descriptor, ...override }, { fetchImpl: async url => {
        const query = new URL(url).searchParams;
        requests.push(query);
        assert.equal(query.get('propertyName'), 'the_geom');
        assert.equal(query.get('srsName'), 'EPSG:4326');
        assert.equal(query.has('cql_filter'), false);
        const layer = query.get('typeName').split(':')[1];
        if (layer === failLayer) return new Response('', { status: 503 });
        const requested = query.get('featureID');
        const ids = requested ? requested.split(',').filter(id => !id.endsWith('.999')).map(id => Number(id.split('.').at(-1))) : [1,2];
        const start = Number(query.get('startIndex') || 0);
        const features = ids.slice(start, start + Number(query.get('maxFeatures'))).map(id => raw(layer, id));
        return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: ids.length,
            features, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } } }));
    } });
    return { source, requests };
}

for (const [name, factory] of [['backend', createWfsParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${name} routes cross-layer exact reads and preserves geometry and explicit absence`, async () => {
        const { source, requests } = fixture(factory);
        const result = await source.queryIds(['TEST-Second_Parcels.1','TEST-First_Parcels.1','TEST-First_Parcels.999']);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(feature => feature.id), ['TEST-Second_Parcels.1','TEST-First_Parcels.1']);
        assert.deepEqual(result.absentIds, ['TEST-First_Parcels.999']);
        assert.deepEqual(result.features[0].geometry, geometry);
        assert.deepEqual(result.features[0].properties.sourceProperties, {});
        assert.equal(requests.length, 3);
        assert.equal(requests[0].get('featureID'), 'Second_Parcels.1');
        assert.equal(requests[1].get('featureID'), 'First_Parcels.1');
    });
}

test('bounds pages every configured layer, verifies IDs and keeps coincident distinct parcels', async () => {
    const { source, requests } = fixture();
    const result = await source.queryBounds([28.245,-12.565,28.246,-12.564]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(feature => feature.id),
        ['TEST-First_Parcels.1','TEST-First_Parcels.2','TEST-Second_Parcels.1','TEST-Second_Parcels.2']);
    assert.ok(result.features.every(feature => JSON.stringify(feature.geometry) === JSON.stringify(geometry)));
    assert.equal(requests.filter(query => query.get('startIndex') === '1').length, 2);
    assert.equal(requests.filter(query => query.has('featureID')).length, 4);
});

test('rejects a mixed invalid batch before I/O and propagates a layer failure without partial results', async () => {
    const { source, requests } = fixture();
    await assert.rejects(source.queryIds(['TEST-First_Parcels.1','TEST-NoRef_Parcels.1']), { status: 400 });
    assert.equal(requests.length, 0);
    const failing = fixture(createWfsParcelSource, 'Second_Parcels').source;
    await assert.rejects(failing.queryBounds([28.245,-12.565,28.246,-12.564]), { status: 502 });
    await assert.rejects(failing.queryIds(['TEST-First_Parcels.1','TEST-Second_Parcels.1']), { status: 502 });
});

test('rejects ambiguous namespaces and enforces the combined family parcel limit', async () => {
    assert.throws(() => fixture(createWfsParcelSource, null,
        { featureTypes: ['zambia:First_Parcels','other:First_Parcels'] }), /ambiguous/);
    const { source } = fixture(createWfsParcelSource, null, { maxFeatures: 3 });
    await assert.rejects(source.queryBounds([28.245,-12.565,28.246,-12.564]), /parcel limit/);
});

test('geometry reads filter whole returned polygons without clipping', async () => {
    const { source } = fixture();
    const result = await source.queryGeometry(geometry);
    assert.equal(result.features.length, 4);
    assert.deepEqual(result.features[0].geometry, geometry);
});
