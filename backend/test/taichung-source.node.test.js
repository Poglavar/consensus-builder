import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { createTaichungParcelSource, taichungNativeGeometry, TAICHUNG_PROJECTION, TAICHUNG_ENDPOINT, TAICHUNG_SPATIAL_ENDPOINT } from '../parcels/taichung-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/taichung-safe.json', import.meta.url)));
const descriptor = { id: 'tw-taichung-gismap-cadastral-parcels', adapter: 'taichung-gismap',
    endpoint: TAICHUNG_ENDPOINT, spatialEndpoint: TAICHUNG_SPATIAL_ENDPOINT, idPrefix: 'TW-TC-GISMAP-G67:',
    sourceCrs: 'EPSG:3826', outFields: ['地段號'], parcelNumberField: '地段號', sectionCodes: ['040710','040755','051000'] };
const id = 'TW-TC-GISMAP-G67:051000:0001-0000';
const response = data => new Response(JSON.stringify(data));
const clone = value => structuredClone(value);
const bounds = [120.67147, 24.14514, 120.67160, 24.14525];
function make(fetchImpl, config = descriptor) { return createParcelSource(config, { fetchImpl }); }

test('backend and browser factories independently read exact composites with safe output and all vertices', async () => {
    for (const factory of [make, (fetchImpl, config = descriptor) => browserParcelFactories['taichung-gismap'](config, {
        fetchImpl: async (url, init) => fetchParcelProviderRelay(validateParcelProviderRelayRequest(descriptor.id,
            { url, method:init.method, body:init.body, headers:init.headers, redirect:init.redirect }, {sources:[config]}),
        { providerFetch:(target, options) => fetchImpl(target.href, options) }) })]) {
        const calls = [];
        const adapter = factory(async (url, init) => {
            calls.push([url, new URLSearchParams(init.body).get('key_no')]);
            assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
            return response(fixture.exact);
        });
        const first = await adapter.queryIds([id]), second = await adapter.queryIds([id]);
        assert.deepEqual(calls, [[TAICHUNG_ENDPOINT,'05100000010000'],[TAICHUNG_ENDPOINT,'05100000010000']]);
        assert.equal(first.complete, true); assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features, second.features);
        const row = first.features[0];
        assert.equal(row.id, id); assert.equal(row.properties.sourceParcelId, '051000:0001-0000');
        assert.deepEqual(row.properties.sourceProperties, { '地段號': '文正段1-0地號' });
        const expected = taichungNativeGeometry(fixture.exact.features[0].geometry).coordinates[0]
            .map(point => proj4(TAICHUNG_PROJECTION, 'EPSG:4326', point));
        assert.deepEqual(row.geometry.coordinates[0], expected);
        assert.ok(Math.abs(expected[0][0] - 120.67157) < 0.0001);
    }
});

test('spatial identity is resolved independently of both response array orders', async () => {
    const spatial = clone(fixture.spatial);
    spatial.DATA.reverse();
    const expectedIds = spatial.DATA.map(row => `TW-TC-GISMAP-G67:${descriptor.sectionCodes.find(code => code.endsWith(row.AA48))}:${row.AA49.slice(0,4)}-${row.AA49.slice(4)}`);
    const nativeRows = new Map(fixture.spatial.DATA.map((row, index) => [row.AA48 + row.AA49, fixture.spatial.features[index].geometry]));
    const calls = [];
    const adapter = make(async (url, init) => {
        calls.push(url);
        if (url === TAICHUNG_SPATIAL_ENDPOINT) return response(spatial);
        const key = new URLSearchParams(init.body).get('key_no'), parcel = key.slice(6);
        return response({ type:'FeatureCollection', features:[{ properties: { '地段號': `段${Number(parcel.slice(0,4))}-${Number(parcel.slice(4))}地號` },
            geometry: nativeRows.get(key.slice(2)) }] });
    });
    const read = await adapter.queryBounds(bounds);
    assert.equal(read.complete, true); assert.equal(read.areaComplete, false);
    assert.deepEqual(read.features.map(row => row.id), expectedIds);
    assert.equal(calls.filter(url => url === TAICHUNG_ENDPOINT).length, 5);
    assert.equal(JSON.stringify(read).includes('AA16'), false);
    await adapter.queryBounds(bounds);
    assert.equal(calls.filter(url => url === TAICHUNG_ENDPOINT).length, 5, 'fresh spatial polygons may reuse independently verified identities');
    await adapter.queryIds([id]);
    assert.equal(calls.filter(url => url === TAICHUNG_ENDPOINT).length, 6, 'exact reads must never use the identity cache');
});

test('overlapping parcels with identical geometry keep distinct source composites', async () => {
    const geometry = fixture.exact.features[0].geometry;
    const adapter = make(async (url, init) => url === TAICHUNG_SPATIAL_ENDPOINT ? response({ type:'FeatureCollection', CNT:2,
        DATA:[{AA48:'1000',AA49:'00010000'},{AA48:'1000',AA49:'00020000'}], features:[{geometry},{geometry}] })
        : response({ type:'FeatureCollection', features:[{ geometry, properties:{ '地段號': `段${Number(new URLSearchParams(init.body).get('key_no').slice(6,10))}-0地號` } }] }));
    const read = await adapter.queryBounds(bounds);
    assert.equal(read.features.length, 2); assert.notEqual(read.features[0].id, read.features[1].id);
    assert.deepEqual(read.features[0].geometry, read.features[1].geometry);
});

test('empty exact lookup stays unresolved and does not claim authoritative absence', async () => {
    const read = await make(async () => response({ type:'FeatureCollection', features:[] })).queryIds([id]);
    assert.equal(read.complete, false); assert.deepEqual(read.unresolvedIds, [id]); assert.deepEqual(read.absentIds, []);
});

test('identity mismatch, wrong geometry, unknown section and capped/inconsistent responses fail', async () => {
    const wrongLabel = clone(fixture.exact); wrongLabel.features[0].properties['地段號'] = '文正段2-0地號';
    await assert.rejects(() => make(async () => response(wrongLabel)).queryIds([id]), /disagrees/);
    for (const change of [data => data.CNT++, data => data.DATA[0].AA48 = '9999', data => data.DATA[1] = data.DATA[0]]) {
        const data = clone(fixture.spatial); change(data);
        await assert.rejects(() => make(async () => response(data)).queryBounds(bounds));
    }
    await assert.rejects(() => make(async () => response(fixture.spatial), { ...descriptor, maxFeatures:5 }).queryBounds(bounds), /transfer cap/);
    const changed = clone(fixture.exact);
    changed.features[0].geometry.coordinates[0] = changed.features[0].geometry.coordinates[0].map(([x,y]) => [Number(x)+1,Number(y)]);
    await assert.rejects(() => make(async url => response(url === TAICHUNG_SPATIAL_ENDPOINT
        ? { type:'FeatureCollection', CNT:1, DATA:[{AA48:'1000',AA49:'00010000'}], features:fixture.exact.features }
        : changed)).queryBounds(bounds), /correspondence/);
});

test('mixed scalar parsing preserves holes and multiparts; missing or open coordinates are rejected', () => {
    const ring = fixture.exact.features[0].geometry.coordinates[0];
    const multi = taichungNativeGeometry({type:'MultiPolygon',coordinates:[[ring,ring],[ring]]});
    assert.equal(multi.coordinates.length, 2); assert.equal(multi.coordinates[0].length, 2);
    assert.equal(multi.coordinates[0][0].length, ring.length);
    for (const value of [null, '', false, 'NaN', 'Infinity']) {
        const bad = clone(fixture.exact.features[0].geometry); bad.coordinates[0][1][0] = value;
        assert.throws(() => taichungNativeGeometry(bad));
    }
    const open = clone(fixture.exact.features[0].geometry); open.coordinates[0].pop();
    assert.throws(() => taichungNativeGeometry(open), /open ring/);
});

test('invalid descriptors and IDs fail before making requests', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return response(fixture.exact); };
    const adapter = make(fetchImpl);
    for (const ids of [[], [id,id], ['foreign'], ['TW-TC-GISMAP-G67:051000:1-0']]) await assert.rejects(() => adapter.queryIds(ids), {status:400});
    for (const config of [{ ...descriptor, outFields:['owner'] }, { ...descriptor, sectionCodes:['051000','041000'] }]) {
        assert.throws(() => createTaichungParcelSource(config, { fetchImpl }), /descriptor/);
    }
    await assert.rejects(() => adapter.queryBounds([120,24,121,25]), {status:400});
    assert.equal(calls, 0);
});

test('relay batches fresh native exact reads without forwarding the local envelope or changing source coordinates', async () => {
    const input = { url:TAICHUNG_ENDPOINT, method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({_parcelIds:JSON.stringify([id])}).toString() };
    const request = validateParcelProviderRelayRequest(descriptor.id, input, {sources:[descriptor]});
    let calls = 0;
    const providerFetch = async (url, options) => {
        calls++;
        assert.ok(options.headers instanceof Headers);
        assert.equal(url.href, TAICHUNG_ENDPOINT);
        assert.equal(options.body, 'key_no=05100000010000');
        const original = clone(fixture.exact); original.features[0].properties.unsolicited = 'discard';
        return response(original);
    };
    const result = await (await fetchParcelProviderRelay(request, {providerFetch})).json();
    assert.equal(calls, 1);
    assert.deepEqual(result.results[0].geometry, fixture.exact.features[0].geometry);
    assert.deepEqual(result.results[0].properties, {'地段號':'文正段1-0地號'});
    const bad = validateParcelProviderRelayRequest(descriptor.id,
        {...input,body:new URLSearchParams({_parcelIds:JSON.stringify(['foreign'])}).toString()}, {sources:[descriptor]});
    await assert.rejects(() => fetchParcelProviderRelay(bad, {providerFetch}), {status:400});
    assert.equal(calls, 1);
    const spatial = validateParcelProviderRelayRequest(descriptor.id,
        {...input,url:TAICHUNG_SPATIAL_ENDPOINT,body:'gtype=Polygon&wkt=POINT(1+2)'}, {sources:[descriptor]});
    assert.equal(spatial.target.href, TAICHUNG_SPATIAL_ENDPOINT);
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id,
        {...input,url:'https://gismap.taichung.gov.tw/gismap/CFM/private.cfm'}, {sources:[descriptor]}));
});
