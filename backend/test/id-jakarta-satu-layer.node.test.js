// Exercises service-bound ArcGIS layer selection, safe fields and complete non-paged ID reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const endpoint = 'https://jakartasatu.jakarta.go.id/server/rest/services/BPN/Persil_BPN_2021_map/MapServer';
const descriptor = {
    adapter: 'arcgis', id: 'id-jakarta-satu-bpn-persil-2021-map', endpoint, layerId: 9,
    idField: 'FID', objectIdField: 'FID', outFields: ['FID'], idPrefix: 'ID-JAKARTA-BPN-L9-',
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', pageSize: 2, maxFeatures: 10
};
const geometry = { type: 'Polygon', coordinates: [[[106.8274501234567, -6.3186],
    [106.8275, -6.3186], [106.8275, -6.3185], [106.8274501234567, -6.3186]]] };
const reply = body => ({ ok: true, status: 200, json: async () => body });
function provider({ omit = false, truncate = false } = {}) {
    const calls = [];
    return { calls, fetchImpl: async url => {
        const u = new URL(url), p = u.searchParams;
        calls.push(u);
        assert.equal(u.pathname, new URL(endpoint).pathname + '/9/query');
        for (const field of ['resultOffset', 'resultRecordCount', 'orderByFields']) assert.equal(p.has(field), false);
        if (p.get('returnCountOnly') === 'true') return reply({ count: 2 });
        if (p.get('returnIdsOnly') === 'true') return reply({ objectIdFieldName: 'FID', objectIds: [20534, 20535] });
        assert.equal(p.get('outFields'), 'FID');
        assert.equal(p.get('outSR'), '4326');
        assert.equal(p.get('returnGeometry'), 'true');
        return reply({ type: 'FeatureCollection', features: (omit ? [20534] : [20534, 20535]).map(FID =>
            ({ type: 'Feature', id: FID, properties: { FID }, geometry })), exceededTransferLimit: truncate });
    } };
}

test('root endpoint selects layer 9, retains native precision, and repeats exact IDs', async () => {
    const p = provider(), source = createArcgisParcelSource(descriptor, p);
    const ids = [20534, 20535].map(id => descriptor.idPrefix + id);
    const first = await source.queryIds(ids), second = await source.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features.map(f => f.id), ids);
    assert.deepEqual(first.features[0].geometry, geometry);
    assert.deepEqual(second, first);
    assert.equal(p.calls.length, 6);
    assert.equal(descriptor.endpoint, endpoint);
    assert.deepEqual(Object.keys(first.features[0].properties.sourceProperties), ['FID']);
});

test('bounded reads use count and object-ID manifest without unsupported paging', async () => {
    const p = provider(), source = createArcgisParcelSource(descriptor, p);
    assert.equal((await source.queryBounds([106.827, -6.319, 106.828, -6.318])).features.length, 2);
    assert.equal(p.calls[0].searchParams.get('inSR'), '4326');
    assert.equal(p.calls[0].searchParams.get('geometryType'), 'esriGeometryEnvelope');
});

for (const opts of [{ omit: true }, { truncate: true }]) test(`rejects incomplete object reads ${JSON.stringify(opts)}`, async () => {
    const source = createArcgisParcelSource(descriptor, provider(opts));
    await assert.rejects(source.queryIds([descriptor.idPrefix + '20534', descriptor.idPrefix + '20535']), /incomplete object-ID/);
});

test('rejects invalid selectors and IDs from other layers before network access', async () => {
    for (const layerId of [-1, 1.5, '9', null]) assert.throws(() => createArcgisParcelSource({ ...descriptor, layerId }), /layer selector/);
    assert.throws(() => createArcgisParcelSource({ ...descriptor, endpoint: endpoint + '/9' }), /layer selector/);
    const source = createArcgisParcelSource(descriptor, { fetchImpl: () => assert.fail('unexpected network') });
    await assert.rejects(source.queryIds(['ID-JAKARTA-BPN-L8-20534']), /different source/);
});
