// Verify Aplahoué NUP identity, safe WFS requests and unchanged source parcel geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/bj-andf-aplahoue-safe.json', import.meta.url)));
const descriptor = {
    id: 'bj-andf-efoncier-geoserver', adapter: 'wfs',
    endpoint: 'https://geoserver.andf.bj/geoserver/efb/wfs',
    version: '2.0.0', featureType: 'efb:efb_parcel', geometryField: 'boundary',
    idField: 'nup', idType: 'string', idPattern: '^[0-9]+$', idPrefix: 'BJ-ANDF-',
    requestProperties: true, outFields: ['nup'], parcelNumberField: 'nup',
    pageSize: 100, idBatchSize: 80, maxFeatures: 10000, maxBboxKm2: 25
};
const ids = sample.features.map(feature => `${descriptor.idPrefix}${feature.properties.nup}`);

function source(payloads, overrides = {}) {
    const requests = [];
    const adapter = createParcelSource({ ...descriptor, ...overrides }, { fetchImpl: async url => {
        requests.push(new URL(url));
        assert.ok(payloads.length, 'Unexpected additional provider request');
        return Response.json(payloads.shift());
    } });
    return { adapter, requests };
}

test('Aplahoué exact reads preserve native NUPs and boundaries across changing transport IDs', async () => {
    const repeated = structuredClone(sample);
    repeated.features.forEach((feature, index) => { feature.id = `efb_parcel.fid-changed_${index}`; });
    const { adapter, requests } = source([sample, repeated]);
    const first = await adapter.queryIds(ids);
    const second = await adapter.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features, second.features);
    assert.deepEqual(first.features.map(feature => feature.id), ids);
    assert.deepEqual(first.features.map(feature => feature.geometry), sample.features.map(feature => feature.geometry));
    for (const feature of first.features) {
        assert.equal(feature.properties.sourceId, descriptor.id);
        assert.deepEqual(feature.properties.sourceProperties, { nup: feature.properties.sourceParcelId });
    }
    for (const { searchParams: params } of requests) {
        assert.equal(params.get('propertyName'), 'boundary,nup');
        assert.equal(params.get('srsName'), 'CRS:84');
        assert.equal(params.get('sortBy'), 'nup');
        assert.equal(params.get('cql_filter'), "nup IN ('101399138','101399139','101399146')");
    }
});

test('Aplahoué WFS 2.0 bounded pages use explicit counts, sorting and longitude,latitude', async () => {
    // This checks adapter behavior with discovery geometries; it is not live paging evidence.
    const pages = sample.features.map(feature => ({ ...sample, features: [feature], numberReturned: 1 }));
    const { adapter, requests } = source(pages, { pageSize: 1 });
    const bounds = [1.711, 6.94675, 1.7112, 6.94695];
    const result = await adapter.queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(feature => feature.id), ids);
    assert.deepEqual(result.features.map(feature => feature.geometry), sample.features.map(feature => feature.geometry));
    assert.deepEqual(requests.map(url => url.searchParams.get('startIndex')), ['0', '1', '2']);
    assert.ok(requests.every(url => url.searchParams.get('bbox') === `${bounds.join(',')},CRS:84`));
    assert.ok(requests.every(url => url.searchParams.get('count') === '1'));
    assert.ok(requests.every(url => url.searchParams.get('propertyName') === 'boundary,nup'));
});

test('Aplahoué changed CRS, inconsistent counts and conflicting NUP boundaries fail closed', async () => {
    const projected = source([{ ...sample, crs: { type: 'name', properties: { name: 'EPSG:32631' } } }]);
    await assert.rejects(projected.adapter.queryIds(ids), /mismatched response CRS/);
    const incomplete = source([{ ...sample, numberReturned: 2 }]);
    await assert.rejects(incomplete.adapter.queryIds(ids), /match counts/);
    const conflict = structuredClone(sample);
    conflict.features[1].properties.nup = conflict.features[0].properties.nup;
    await assert.rejects(source([conflict]).adapter.queryIds(ids), /conflicting geometry/);
});

test('Aplahoué foreign, generated and malformed IDs are rejected before fetching', async () => {
    const { adapter, requests } = source([]);
    for (const id of ['OTHER-101399138', 'BJ-ANDF-efb_parcel.fid-generated', 'BJ-ANDF-101399138 OR 1=1']) {
        await assert.rejects(adapter.queryIds([id]), /different source|Invalid parcel ID/);
    }
    assert.equal(requests.length, 0);
});
