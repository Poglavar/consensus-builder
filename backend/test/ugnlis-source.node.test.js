// Exercise UgNLIS's live selector semantics, privacy boundary and fresh exact reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUgnlisParcelSource, UGN_SOURCE_ENDPOINT, UGN_FILTER_ENDPOINT, UGN_NATIVE_PROJECTION } from '../parcels/ugnlis-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const nativeGeometry = { type: 'MultiPolygon', coordinates: [[[
    [267524.43762702, 333101.22954789], [267579.92266592, 333101.22954789],
    [267579.92266592, 333153.49482563], [267524.43762702, 333153.49482563],
    [267524.43762702, 333101.22954789]
]]] };
const descriptor = {
    id: 'ug-mlhud-ugnlis-nalisep-arua-parcel-search', adapter: 'ugnlis-parcel-search',
    endpoint: UGN_SOURCE_ENDPOINT, filterEndpoint: UGN_FILTER_ENDPOINT,
    idPrefix: 'UG-UGNLIS-ARUA-', idField: 'id', outFields: ['id'],
    selector: { caddistrict: 'cadreg1', county: 'cad_co_ayivu', city: 'cad_mcp_arua' },
    municipalityLabel: 'Arua Municipality', sourceCrs: 'EPSG:21096', projection: UGN_NATIVE_PROJECTION,
    maxBboxKm2: 25, maxFeatures: 100, cityIds: ['arua'], browserTransport: 'relay'
};
const parcelId = `${descriptor.idPrefix}10000000021850`;
const bounds = [30.908, 3.008, 30.911, 3.011];
function record(id = '10000000021850', geometry = nativeGeometry) {
    return { id, cad_muni_tc_city: 'Arua Municipality', owner_name: 'discard this field',
        geometry: JSON.stringify({ type: 'Feature', id, geometry, properties: { owner_name: 'also discard' } }) };
}
function mockProvider({ records = [record(), record('10000000104862', null)], replace } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        let payload;
        if (url === UGN_FILTER_ENDPOINT) payload = body.isFilterPlot
            ? records.map((_, index) => ({ lot_number: index + 1 })) : [{ block_number: 1 }];
        else payload = replace?.(calls.filter(call => call.url === UGN_SOURCE_ENDPOINT).length, body)
            ?? records[Number(body.plot) - 1];
        return new Response(JSON.stringify(payload), { status: 201, headers: { 'content-type': 'application/json' } });
    };
    return { fetchImpl, calls };
}

test('backend and browser factories read native polygons and discard provider attributes', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['ugnlis-parcel-search']]) {
        const provider = mockProvider();
        const source = factory(descriptor, factory === createParcelSource ? provider : {
            fetchImpl: (url, init) => fetchParcelProviderRelay(validateParcelProviderRelayRequest(descriptor.id,
                { url, method: init.method, headers: init.headers, body: init.body }, { sources: [descriptor] }),
            { providerFetch: (target, options) => provider.fetchImpl(target.href, options) })
        });
        const result = await source.queryBounds(bounds);
        assert.equal(result.complete, true);
        assert.equal(result.coverage.citywideCompleteness, false);
        assert.equal(result.coverage.nullGeometryCount, 1);
        assert.equal(result.features.length, 1);
        assert.equal(result.features[0].id, parcelId);
        assert.deepEqual(result.features[0].properties.sourceProperties, { id: '10000000021850' });
        assert.ok(!JSON.stringify(result).includes('owner_name'));
        // Independent pyproj reference for EPSG:21096 and Arc 1960 to WGS 84 (1).
        const [longitude, latitude] = result.features[0].geometry.coordinates[0][0][0];
        assert.ok(Math.abs(longitude - 30.909125612615846) < 1e-9);
        assert.ok(Math.abs(latitude - 3.0089118318098014) < 1e-9);
        for (const { body } of provider.calls) {
            assert.equal(body.city, 'cad_mcp_arua');
            assert.equal(body.county, 'cad_co_ayivu');
            assert.equal(body.caddistrict, 'cadreg1');
            assert.equal(body.road, '');
            assert.deepEqual(Object.keys(body).sort(), ['block', 'caddistrict', 'city', 'county', 'isFilterPlot', 'plot', 'radioBlockRoad', 'road']);
        }
    }
});

test('repeated exact reads use fresh provider requests and enforce native ID equality', async () => {
    const provider = mockProvider({ records: [record()] });
    const source = createUgnlisParcelSource(descriptor, provider);
    const first = await source.queryIds([parcelId]);
    const second = await source.queryIds([parcelId]);
    assert.deepEqual(first.features, second.features);
    assert.equal(provider.calls.filter(call => call.url === UGN_SOURCE_ENDPOINT).length, 3);
    const changed = mockProvider({ records: [record()], replace: count => count > 1 ? record('999999') : undefined });
    await assert.rejects(createUgnlisParcelSource(descriptor, changed).queryIds([parcelId]), /no longer resolves/);
});

test('null-boundary records cannot be mistaken for absent registry records', async () => {
    const source = createUgnlisParcelSource(descriptor, mockProvider());
    await assert.rejects(source.queryIds([`${descriptor.idPrefix}10000000104862`]), error => error.code === 'parcel-source-geometry-unavailable');
    const absent = await source.queryIds([`${descriptor.idPrefix}999999`]);
    assert.deepEqual(absent.absentIds, [`${descriptor.idPrefix}999999`]);
});

test('bounds filter whole polygons and geometry queries preserve their complete rings', async () => {
    const source = createUgnlisParcelSource(descriptor, mockProvider());
    assert.equal((await source.queryBounds([30.92, 3.02, 30.921, 3.021])).features.length, 0);
    const read = await source.queryBounds(bounds);
    const exact = await source.queryGeometry(read.features[0].geometry);
    assert.deepEqual(exact.features, read.features);
    assert.equal(exact.features[0].geometry.coordinates[0][0].length, 5);
});

test('foreign municipality, invalid JSON, unsafe IDs and incomplete enumeration fail closed', async () => {
    const wrong = record(); wrong.cad_muni_tc_city = 'Another municipality';
    await assert.rejects(createUgnlisParcelSource(descriptor, mockProvider({ records: [wrong] })).queryBounds(bounds), /municipality binding/);
    await assert.rejects(createUgnlisParcelSource(descriptor, { fetchImpl: async () => new Response('') }).queryBounds(bounds), /empty or invalid JSON/);
    await assert.rejects(createUgnlisParcelSource(descriptor, { fetchImpl: async () => new Response('[]') }).queryBounds(bounds), /no municipality selectors/);
    const provider = mockProvider();
    await assert.rejects(createUgnlisParcelSource(descriptor, provider).queryIds(['another-source']), /native UgNLIS parcel IDs/);
    assert.equal(provider.calls.length, 0);
    assert.throws(() => createUgnlisParcelSource({ ...descriptor, outFields: ['owner_name'] }), /Invalid UgNLIS/);
});

test('relay permits the fixed official filter route, and rejects unrelated subroutes', () => {
    const input = { url: UGN_FILTER_ENDPOINT, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    const result = validateParcelProviderRelayRequest(descriptor.id, input, { sources: [descriptor] });
    assert.equal(result.target.href, UGN_FILTER_ENDPOINT);
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id,
        { ...input, url: UGN_SOURCE_ENDPOINT.replace('parcel-search', 'unrelated') }, { sources: [descriptor] }));
});

test('one browser directory query uses one relay envelope and retains fresh exact reads', async () => {
    const provider = mockProvider({ records: [record()] });
    const relayCalls = [];
    const source = browserParcelFactories[descriptor.adapter](descriptor, { fetchImpl: async (url, init) => {
        relayCalls.push(JSON.parse(init.body));
        const request = validateParcelProviderRelayRequest(descriptor.id,
            { url, method: init.method, headers: init.headers, body: init.body }, { sources: [descriptor] });
        return fetchParcelProviderRelay(request, { providerFetch: (target, options) => provider.fetchImpl(target.href, options) });
    } });
    const boundsRead = await source.queryBounds(bounds);
    const first = await source.queryIds([parcelId]), second = await source.queryIds([parcelId]);
    assert.equal(boundsRead.features.length, 1);
    assert.deepEqual(first.features, second.features);
    assert.deepEqual(relayCalls.map(call => call._ugnlisOperation), ['bounds', 'ids', 'ids']);
    assert.ok(provider.calls.filter(call => call.url === UGN_SOURCE_ENDPOINT).length >= 3);
    assert.ok(provider.calls.every(call => !Object.hasOwn(call.body, '_ugnlisOperation')));
});

test('cancelled viewport releases its relay operation while the bounded directory loads', async () => {
    let releaseProvider, providerStarted;
    const started = new Promise(resolve => { providerStarted = resolve; });
    const gate = new Promise(resolve => { releaseProvider = resolve; });
    const provider = mockProvider({ records: [record()] });
    const controller = new AbortController();
    const request = validateParcelProviderRelayRequest(descriptor.id, { url: descriptor.endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _ugnlisOperation: 'bounds', input: bounds }) }, { sources: [descriptor] });
    const result = fetchParcelProviderRelay(request, { signal: controller.signal, providerFetch: async (target, options) => {
        providerStarted();
        await gate;
        return provider.fetchImpl(target.href, options);
    } });
    await started;
    controller.abort();
    // This assertion completes before the provider gate is released. A cancelled
    // HTTP request cannot retain a global relay slot behind the shared download.
    try { await assert.rejects(result, error => error.status === 499); }
    finally { releaseProvider(); }
});
