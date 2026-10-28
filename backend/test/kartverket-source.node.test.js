// Exercises durable native references, safe requests, unchanged polygons and fail-closed limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createKartverketParcelSource, kartverketNativeReference } from '../parcels/kartverket-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { id: 'no-kartverket-eiendom-api-omrader', adapter: 'kartverket-eiendom',
    endpoint: 'https://api.kartverket.no/eiendom/v1/punkt/omrader', idPrefix: 'NO-KARTVERKET-LOKALID:',
    idField: 'lokalid', outFields: ['lokalid', 'kommunenummer', 'gardsnummer', 'bruksnummer', 'festenummer', 'seksjonsnummer', 'objekttype'] };
const geometry = { type: 'Polygon', coordinates: [
    [[10.77, 59.92], [10.771, 59.92], [10.771, 59.921], [10.77, 59.921], [10.77, 59.92]],
    [[10.7702, 59.9202], [10.7702, 59.9204], [10.7704, 59.9204], [10.7704, 59.9202], [10.7702, 59.9202]]
] };
const properties = { lokalid: 291486407, kommunenummer: '0301', gardsnummer: 229, bruksnummer: 86,
    festenummer: 0, seksjonsnummer: 0, objekttype: 'Teig' };
const feature = { type: 'Feature', properties, geometry };
const id = `${descriptor.idPrefix}291486407@0301.229.86.0.0`;
const response = features => new Response(JSON.stringify({ type: 'FeatureCollection', features }), { headers: { 'Content-Type': 'application/json' } });

test('browser relay admits only this source and its fixed exact-read endpoint', () => {
    const url = 'https://api.kartverket.no/eiendom/v1/geokoding?kommunenummer=0301&gardsnummer=229&bruksnummer=86&omrade=true';
    assert.equal(validateParcelProviderRelayRequest(descriptor.id, { url }, { sources: [descriptor] }).target.href, url);
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url: url.replace('/geokoding', '/admin') }, { sources: [descriptor] }));
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url }, { sources: [{ ...descriptor, endpoint: descriptor.endpoint + '/other' }] }));
});

test('backend and browser exact reads use the tuple, verify lokalid and preserve every ring', async () => {
    const calls = [];
    for (const factory of [createParcelSource, browserParcelFactories['kartverket-eiendom']]) {
        const source = factory(descriptor, { fetchImpl: async (url, init) => {
            calls.push({ url: new URL(url), init });
            return response([{ ...feature, properties: { ...properties, unrelated: 'discard' } }]);
        } });
        const read = await source.queryIds([id]);
        assert.equal(read.complete, true);
        assert.equal(read.features[0].id, id);
        assert.deepEqual(read.features[0].geometry, geometry);
        assert.deepEqual(read.features[0].properties.sourceProperties, properties);
        assert.deepEqual(read.absentIds, []);
    }
    assert.equal(calls.length, 2);
    for (const { url, init } of calls) {
        assert.equal(url.pathname, '/eiendom/v1/geokoding');
        assert.equal(url.searchParams.get('kommunenummer'), '0301');
        assert.equal(url.searchParams.get('gardsnummer'), '229');
        assert.equal(url.searchParams.get('bruksnummer'), '86');
        assert.equal(url.searchParams.get('omrade'), 'true');
        assert.equal(url.searchParams.get('utkoordsys'), '4326');
        assert.deepEqual(url.searchParams.get('filtrer').split(','), ['type', 'features.type', 'features.geometry', ...descriptor.outFields.map(f => `features.properties.${f}`)]);
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
    }
});

test('exact reads distinguish another Teig in the same tuple from conflicting tuple or geometry', async () => {
    const source = features => createKartverketParcelSource(descriptor, { fetchImpl: async () => response(features) });
    const other = { ...feature, properties: { ...properties, lokalid: 291486408 } };
    assert.equal((await source([other, feature]).queryIds([id])).features.length, 1);
    assert.deepEqual((await source([]).queryIds([id])).absentIds, [id]);
    await assert.rejects(source([{ ...feature, properties: { ...properties, bruksnummer: 87 } }]).queryIds([id]), { status: 502 });
    await assert.rejects(source([feature, { ...feature, geometry: { ...geometry, coordinates: [geometry.coordinates[0]] } }]).queryIds([id]), { status: 502 });
    await assert.rejects(source(Array(500).fill(feature)).queryIds([id]), { status: 502 });
    assert.throws(() => kartverketNativeReference({ ...properties, lokalid: null }), { status: 502 });
});

test('bounds and point queries use geographic axes, exclude volume footprints and keep geometry unchanged', async () => {
    const calls = [];
    const source = createKartverketParcelSource(descriptor, { fetchImpl: async url => {
        calls.push(new URL(url));
        return response([feature, { ...feature, properties: { ...properties, objekttype: 'anleggsprojeksjonsflate' } }]);
    } });
    const read = await source.queryBounds([10.77, 59.92, 10.771, 59.921]);
    assert.equal(read.features.length, 1);
    assert.deepEqual(read.features[0].geometry, geometry);
    assert.equal(calls[0].searchParams.get('ost'), '10.7705');
    assert.ok(Math.abs(Number(calls[0].searchParams.get('nord')) - 59.9205) < 1e-10);
    assert.equal(calls[0].searchParams.get('koordsys'), '4326');
    assert.equal(calls[0].searchParams.get('maksTreff'), '500');
    assert.ok(Number(calls[0].searchParams.get('radius')) <= 3000);
    assert.equal((await source.queryPoint([10.7707, 59.9207])).features.length, 1);
    assert.equal((await source.queryPoint([10.7703, 59.9203])).features.length, 0); // Inside a hole.
});

test('full area responses subdivide, and a persistent cap never returns complete', async () => {
    let calls = 0;
    const source = createKartverketParcelSource(descriptor, { fetchImpl: async () => response(++calls === 1 ? Array(500).fill(feature) : [feature]) });
    const read = await source.queryBounds([10.77, 59.92, 10.771, 59.921]);
    assert.equal(calls, 5);
    assert.equal(read.complete, true);
    assert.equal(read.features.length, 1);
    const capped = createKartverketParcelSource(descriptor, { fetchImpl: async () => response(Array(500).fill(feature)) });
    await assert.rejects(capped.queryBounds([10.77, 59.92, 10.771, 59.921]), { status: 502 });
});

test('invalid input, unsafe descriptors, malformed replies, byte overflow and upstream errors fail', async () => {
    let requests = 0;
    const source = createKartverketParcelSource(descriptor, { fetchImpl: async () => { requests++; return response([]); } });
    await assert.rejects(source.queryIds(['NO-KARTVERKET-LOKALID:291486407']), { status: 400 });
    await assert.rejects(source.queryIds([id.replace('229', '0229')]), { status: 400 });
    await assert.rejects(source.queryBounds([10, 59, 11, 60]), { status: 400 });
    assert.equal(requests, 0);
    assert.throws(() => createKartverketParcelSource({ ...descriptor, outFields: [...descriptor.outFields, 'unrelated'] }));
    const malformed = createKartverketParcelSource(descriptor, { fetchImpl: async () => new Response('{}') });
    await assert.rejects(malformed.queryIds([id]), { status: 502 });
    const overflow = createKartverketParcelSource(descriptor, { maxResponseBytes: 1024,
        fetchImpl: async () => new Response(' '.repeat(1025)) });
    await assert.rejects(overflow.queryIds([id]), { status: 502 });
    const unavailable = createKartverketParcelSource(descriptor, { fetchImpl: async () => new Response('', { status: 503 }) });
    await assert.rejects(unavailable.queryIds([id]), { status: 502 });
});
