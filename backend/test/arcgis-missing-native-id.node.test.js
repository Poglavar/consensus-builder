// Keeps explicitly unkeyed cadastral polygons without replacing valid native identities or source geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    adapter: 'arcgis', id: 'test-mixed-boundaries', endpoint: 'https://example.test/MapServer/9',
    idField: 'REGISTRY_PIN', idType: 'string', idPattern: '^[0-9]{9}$',
    objectIdField: 'OBJECTID', idPrefix: 'TEST-PIN-', outFields: ['OBJECTID', 'REGISTRY_PIN'],
    missingIdIdentityKind: 'geometry-sha256-v1', pageSize: 200, maxFeatures: 10000
};
const native = { type: 'Feature', properties: { OBJECTID: 1, REGISTRY_PIN: '000000001' },
    geometry: { type: 'Polygon', coordinates: [[[-80.500000000123, 43.45], [-80.4999, 43.45],
        [-80.4999, 43.4501], [-80.500000000123, 43.45]]] } };
const unkeyed = { ...structuredClone(native), properties: { OBJECTID: 2, REGISTRY_PIN: null } };

function provider(rows = [native, unkeyed]) {
    const calls = [];
    return { calls, fetchImpl: async input => {
        const params = new URL(input).searchParams;
        calls.push(params);
        const features = params.has('objectIds') ? rows.filter(row => params.get('objectIds').split(',').includes(String(row.properties.OBJECTID)))
            : params.get('where') === '1=1' ? rows : rows.filter(row => row.properties.REGISTRY_PIN === '000000001');
        const body = params.has('returnCountOnly') ? { count: features.length }
            : params.has('returnIdsOnly') ? { objectIdFieldName: 'OBJECTID', objectIds: features.map(row => row.properties.OBJECTID) }
                : { type: 'FeatureCollection', features, exceededTransferLimit: false };
        assert.ok(['OBJECTID', 'OBJECTID,REGISTRY_PIN'].includes(params.get('outFields')));
        return new Response(JSON.stringify(body));
    } };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: native and unkeyed polygons retain geometry and support fresh mixed exact reads`, async () => {
        const initialProvider = provider();
        const initial = await factory(descriptor, initialProvider).queryBounds([-80.501, 43.449, -80.499, 43.451]);
        assert.equal(initial.complete, true);
        assert.equal(initial.features.length, 2);
        assert.equal(initial.features[0].id, 'TEST-PIN-000000001');
        assert.equal(initial.features[0].properties.sourceParcelId, '000000001');
        const outline = initial.features[1];
        assert.match(outline.id, /^TEST-PIN-g1~.*~[0-9a-f]{64}$/);
        assert.equal(outline.properties.sourceParcelId, null);
        assert.equal(outline.properties.parcelIdentityKind, 'geometry-sha256-v1');
        assert.deepEqual(outline.geometry, unkeyed.geometry);
        assert.equal(outline.geometry.type, 'Polygon');
        const fresh = await factory(descriptor, provider()).queryIds(initial.features.map(row => row.id));
        assert.equal(fresh.complete, true);
        assert.deepEqual(fresh.absentIds, []);
        assert.deepEqual(fresh.features, initial.features);
        const changed = structuredClone(unkeyed);
        changed.geometry.coordinates[0][1][0] += 0.00001;
        const missing = await factory(descriptor, provider([native, changed])).queryIds([outline.id]);
        assert.deepEqual(missing.features, []);
        assert.deepEqual(missing.absentIds, [outline.id]);
    });
    test(`${name}: repeated PINs and NULL PINs preserve every shape with independent exact reads`, async () => {
        const repeated = structuredClone(native);
        repeated.properties.OBJECTID = 3;
        repeated.geometry.coordinates[0][1][0] += 0.00001;
        const rows = [native, repeated, unkeyed];
        const shaped = { ...descriptor, identityKind: 'native-key-geometry-sha256-v1',
            boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', queryFormat: 'geojson' };
        const initial = await factory(shaped, provider(rows)).queryBounds([-80.501, 43.449, -80.499, 43.451]);
        assert.equal(initial.features.length, 3);
        assert.equal(new Set(initial.features.map(row => row.id)).size, 3);
        assert.deepEqual(initial.features.slice(0, 2).map(row => row.properties.sourceNativeParcelId), ['000000001', '000000001']);
        assert.deepEqual(initial.features.map(row => row.geometry), rows.map(row => row.geometry));
        const reread = await factory(shaped, provider(rows)).queryIds(initial.features.map(row => row.id));
        assert.equal(reread.complete, true);
        assert.deepEqual(reread.absentIds, []);
        assert.deepEqual(reread.features, initial.features);
    });
}

test('only explicit NULL keys opt in; omitted, blank and malformed keys still fail', async () => {
    for (const value of [undefined, '', 'invalid']) {
        const row = structuredClone(unkeyed);
        row.properties.REGISTRY_PIN = value;
        await assert.rejects(createParcelSource(descriptor, provider([row]))
            .queryBounds([-80.501, 43.449, -80.499, 43.451]), /missing or invalid native parcel ID/);
    }
    const strict = { ...descriptor };
    delete strict.missingIdIdentityKind;
    await assert.rejects(createParcelSource(strict, provider([unkeyed]))
        .queryBounds([-80.501, 43.449, -80.499, 43.451]), /missing or invalid native parcel ID/);
});

test('missing-key references reject incompatible descriptors and malformed exact references', async () => {
    for (const extra of [{ missingIdIdentityKind: 'other' }, { idType: 'integer' }, { lookupCellSize: 0.001 }]) {
        assert.throws(() => createParcelSource({ ...descriptor, ...extra }, provider()), /missing-key geometry identity/);
    }
    const observed = provider();
    await assert.rejects(createParcelSource(descriptor, observed).queryIds(['TEST-PIN-g1~broken']), /Invalid geometry-derived/);
    assert.equal(observed.calls.length, 0);
});
