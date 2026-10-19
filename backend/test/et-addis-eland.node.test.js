// Qualify Addis through the production WFS reader using only safe native IDs and full geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const { descriptor, response } = JSON.parse(readFileSync(new URL('./fixtures/et-addis-eland.json', import.meta.url)));
const rows = response.features;
const ids = rows.map(row => descriptor.idPrefix + row.properties.uniqueparcelid);
const page = (features, total = features.length) => ({
    ...response, features, totalFeatures: total, numberMatched: total, numberReturned: features.length
});
function sourceWith(pages, overrides = {}) {
    const requests = [];
    const source = createParcelSource({ ...descriptor, ...overrides }, { fetchImpl: async url => {
        requests.push(new URL(url));
        assert.ok(pages.length, 'Unexpected provider request');
        return new Response(JSON.stringify(pages.shift()));
    } });
    return { source, requests };
}

test('Addis exact reads preserve native identity and all source geometry despite changing transport IDs', async () => {
    const changedTransportIds = rows.map((row, i) => ({ ...row, id: `v_1_parcel_cadaster_publish.fid-other_${i}` }));
    const { source, requests } = sourceWith([page(rows), page(changedTransportIds)]);
    const first = await source.queryIds(ids);
    const second = await source.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(second, first);
    assert.deepEqual(first.features.map(f => f.id), ids);
    assert.deepEqual(first.features.map(f => f.geometry), rows.map(row => row.geometry));
    for (const feature of first.features) {
        assert.deepEqual(Object.keys(feature.properties.sourceProperties), ['uniqueparcelid']);
    }
    for (const url of requests) {
        assert.equal(url.origin + url.pathname, 'https://geos.addiscadaster.gov.et/geoserver/ows');
        assert.equal(url.searchParams.get('typeName'), 'ncrprs_cadaster:v_1_parcel_cadaster_publish');
        assert.equal(url.searchParams.get('version'), '1.0.0');
        assert.equal(url.searchParams.get('sortBy'), 'uniqueparcelid');
        assert.equal(url.searchParams.get('propertyName'), 'geometry,uniqueparcelid');
        assert.equal(url.searchParams.get('srsName'), 'EPSG:4326');
        assert.equal(url.searchParams.get('cql_filter'), `uniqueparcelid IN (${rows.map(row => `'${row.properties.uniqueparcelid}'`).join(',')})`);
    }
});

test('Addis page-size-one reads use explicit native sort and longitude/latitude bounds', async () => {
    const { source, requests } = sourceWith(rows.map(row => page([row], rows.length)), { pageSize: 1 });
    const bbox = [38.748, 9.005, 38.750, 9.007];
    const result = await source.queryBounds(bbox);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(f => f.geometry), rows.map(row => row.geometry));
    assert.deepEqual(requests.map(url => url.searchParams.get('startIndex')), ['0', '1', '2']);
    for (const url of requests) {
        assert.equal(url.searchParams.get('bbox'), `${bbox.join(',')},EPSG:4326`);
        assert.equal(url.searchParams.get('sortBy'), 'uniqueparcelid');
        assert.equal(url.searchParams.get('count'), '1');
        assert.equal(url.searchParams.get('maxFeatures'), '1');
    }
});

test('Addis rejects malformed IDs before fetching and reports complete absence explicitly', async () => {
    const { source, requests } = sourceWith([page([])]);
    for (const id of ['OTHER-AA000040601276', 'ET-ADDIS-ELAND-AA1', "ET-ADDIS-ELAND-AA000040601276' OR 1=1"]) {
        await assert.rejects(source.queryIds([id]), { status: 400 });
    }
    assert.equal(requests.length, 0);
    const absentId = 'ET-ADDIS-ELAND-AA999999999999';
    const result = await source.queryIds([absentId]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [absentId]);
});

test('Addis incomplete pages, conflicting native identity, foreign results and unusable geometry fail closed', async () => {
    const collision = { ...rows[1], properties: rows[0].properties };
    for (const pages of [
        [page([{ ...rows[0], geometry: null }])],
        [page([rows[1]])],
        [page([rows[0]], 2), page([], 2)],
        [page([rows[0]], 2), page([rows[0]], 2)],
        [page([rows[0]], 2), page([collision], 2)],
        [{ ...page([rows[0]]), crs: { type: 'name', properties: { name: 'EPSG:3857' } } }]
    ]) {
        const { source } = sourceWith(pages, { pageSize: 1 });
        await assert.rejects(source.queryIds([ids[0]]), { status: 502 });
    }
});
