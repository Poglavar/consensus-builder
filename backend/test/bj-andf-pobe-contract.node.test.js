// Exercises safe WFS 1.0.0 NUP reads, paging and unchanged real Pobè parcel geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWfsParcelSource } from '../parcels/wfs-source.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/bj-andf-pobe-safe.json', import.meta.url)));
const descriptor = {
    id: 'bj-andf-efoncier-geoserver', adapter: 'wfs',
    endpoint: 'https://geoserver.andf.bj/geoserver/efb/wfs',
    featureType: 'efb:efb_parcel', version: '1.0.0', geometryField: 'boundary',
    idField: 'nup', idType: 'string', idPrefix: 'BJ-ANDF-', idPattern: '^[0-9]+$',
    outFields: ['nup'], requestProperties: true, parcelNumberField: 'nup',
    pageSize: 100, idBatchSize: 80, maxFeatures: 10000, maxBboxKm2: 25
};
const ids = sample.features.map(feature => `${descriptor.idPrefix}${feature.properties.nup}`);

function source(payloads, overrides = {}) {
    const requests = [];
    const adapter = createWfsParcelSource({ ...descriptor, ...overrides }, { fetchImpl: async url => {
        requests.push(new URL(url));
        assert.ok(payloads.length, 'Unexpected extra provider request');
        return Response.json(payloads.shift());
    } });
    return { adapter, requests };
}

test('Pobè exact NUP reads preserve full geometry despite changing generated transport IDs', async () => {
    const repeated = structuredClone(sample);
    repeated.features.forEach((feature, index) => { feature.id = `efb_parcel.fid-other_${index}`; });
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
        assert.equal(params.get('version'), '1.0.0');
        assert.equal(params.get('typeName'), 'efb:efb_parcel');
        assert.equal(params.get('propertyName'), 'boundary,nup');
        assert.equal(params.get('sortBy'), 'nup');
        assert.equal(params.get('srsName'), 'EPSG:4326');
        assert.equal(params.get('cql_filter'), "nup IN ('100417654','100417655','100417663')");
    }
});

test('Pobè bounded paging uses longitude,latitude and explicit WFS 1.0 limits', async () => {
    const pages = sample.features.map(feature => ({ ...sample, features: [feature], numberReturned: 1 }));
    const { adapter, requests } = source(pages, { pageSize: 1 });
    const bounds = [2.6566185386098, 6.9760206823812005, 2.6576185386098, 6.9770206823812];
    const result = await adapter.queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(feature => feature.id), ids);
    assert.deepEqual(result.features.map(feature => feature.geometry), sample.features.map(feature => feature.geometry));
    assert.deepEqual(requests.map(url => url.searchParams.get('startIndex')), ['0', '1', '2']);
    for (const { searchParams: params } of requests) {
        assert.equal(params.get('bbox'), `${bounds.join(',')},EPSG:4326`);
        assert.equal(params.get('maxFeatures'), '1');
        assert.equal(params.get('count'), '1');
        assert.equal(params.get('propertyName'), 'boundary,nup');
        assert.equal(params.get('sortBy'), 'nup');
    }
});

test('Pobè incomplete pages, changed CRS and conflicting NUP geometry fail closed', async () => {
    const incomplete = source([{ ...sample, numberReturned: 2 }]);
    await assert.rejects(incomplete.adapter.queryIds(ids), /match counts/);
    const projected = source([{ ...sample, crs: { type: 'name', properties: { name: 'EPSG:32631' } } }]);
    await assert.rejects(projected.adapter.queryIds(ids), /mismatched response CRS/);
    const conflict = structuredClone(sample);
    conflict.features[1].properties.nup = conflict.features[0].properties.nup;
    const conflicting = source([conflict]);
    await assert.rejects(conflicting.adapter.queryIds(ids), /conflicting geometry/);
});

test('Pobè invalid, transport and foreign IDs never reach the provider', async () => {
    const { adapter, requests } = source([]);
    await assert.rejects(adapter.queryIds(['BJ-ANDF-100417654 OR 1=1']), /Invalid parcel ID/);
    await assert.rejects(adapter.queryIds(['BJ-ANDF-efb_parcel.fid-generated']), /Invalid parcel ID/);
    await assert.rejects(adapter.queryIds(['OTHER-100417654']), /different source/);
    assert.equal(requests.length, 0);
});
