// Checks ANDF's native NUP identity and safe sorted WFS reads with unchanged Whydah polygons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/bj-andf-whydah-safe.json', import.meta.url)));
const descriptor = {
    id: 'bj-andf-efoncier-geoserver', adapter: 'wfs',
    endpoint: 'https://geoserver.andf.bj/geoserver/efb/wfs',
    version: '2.0.0', featureType: 'efb:efb_parcel', geometryField: 'boundary',
    idField: 'nup', idType: 'string', idPattern: '^[0-9]+$', idPrefix: 'BJ-ANDF-',
    requestProperties: true, outFields: ['nup'], parcelNumberField: 'nup',
    pageSize: 100, maxFeatures: 3000, maxBboxKm2: 25
};
const ids = sample.features.map(feature => `${descriptor.idPrefix}${feature.properties.nup}`);
function source(payloads, overrides = {}) {
    const requests = [];
    const adapter = createParcelSource({ ...descriptor, ...overrides }, { fetchImpl: async url => {
        requests.push(new URL(url));
        assert.ok(payloads.length, 'Unexpected additional WFS request');
        return Response.json(payloads.shift());
    } });
    return { adapter, requests };
}

test('native NUPs survive changing GeoServer transport IDs and preserve full geometry', async () => {
    const changed = structuredClone(sample);
    changed.features.forEach((feature, index) => { feature.id = `efb_parcel.fid-different_${index}`; });
    const { adapter, requests } = source([sample, changed]);
    const first = await adapter.queryIds(ids);
    const second = await adapter.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features, second.features);
    assert.deepEqual(first.features.map(feature => feature.id), ids);
    assert.deepEqual(first.features.map(feature => feature.geometry), sample.features.map(feature => feature.geometry));
    for (const feature of first.features) {
        assert.deepEqual(feature.properties.sourceProperties, { nup: feature.properties.sourceParcelId });
        assert.equal(feature.properties.sourceId, descriptor.id);
    }
    for (const request of requests) {
        const params = request.searchParams;
        assert.equal(params.get('propertyName'), 'boundary,nup');
        assert.equal(params.get('sortBy'), 'nup');
        assert.equal(params.get('srsName'), 'CRS:84');
        assert.equal(params.get('cql_filter'), "nup IN ('101236307','101356959','101407321')");
    }
});

test('bounded reads page with explicit NUP ordering and canonical IDs', async () => {
    const pages = sample.features.map(feature => ({ ...sample, features: [feature], numberReturned: 1 }));
    const { adapter, requests } = source(pages, { pageSize: 1 });
    const result = await adapter.queryBounds([2.05, 6.35, 2.09, 6.395]);
    assert.deepEqual(result.features.map(feature => feature.id), ids);
    assert.deepEqual(result.features.map(feature => feature.geometry), sample.features.map(feature => feature.geometry));
    assert.equal(result.complete, true);
    assert.deepEqual(requests.map(request => request.searchParams.get('startIndex')), ['0', '1', '2']);
    assert.ok(requests.every(request => request.searchParams.get('sortBy') === 'nup'));
    assert.ok(requests.every(request => request.searchParams.get('bbox') === '2.05,6.35,2.09,6.395,CRS:84'));
});

test('conflicting geometries for one native NUP fail closed', async () => {
    const conflict = structuredClone(sample);
    conflict.features[1].properties.nup = conflict.features[0].properties.nup;
    const { adapter } = source([conflict]);
    await assert.rejects(adapter.queryIds(ids), /conflicting geometry/);
});

test('incomplete counts and projected coordinates cannot masquerade as complete WGS84 reads', async () => {
    const incomplete = source([{ ...sample, numberReturned: 2 }]);
    await assert.rejects(incomplete.adapter.queryIds(ids), /match counts/);
    const projected = source([{ ...sample, crs: { type: 'name', properties: { name: 'EPSG:32631' } } }]);
    await assert.rejects(projected.adapter.queryIds(ids), /mismatched response CRS/);
});

test('malformed and foreign canonical IDs are rejected before a provider request', async () => {
    const { adapter, requests } = source([]);
    await assert.rejects(adapter.queryIds(['BJ-ANDF-101236307 OR 1=1']), /Invalid parcel ID/);
    await assert.rejects(adapter.queryIds(['OTHER-101236307']), /different source/);
    assert.equal(requests.length, 0);
});
