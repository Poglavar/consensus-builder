// Synthetic publisher responses test immutable KML geometry, non-unique native keys and both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createTijuanaImplanSource } from '../parcels/tijuana-implan-source.js';
import { validateParcelProviderRelayRequest, fetchParcelProviderRelay } from '../parcels/provider-relay.js';

const descriptor = { id: 'mx-tijuana-implan-catastro-wms', adapter: 'tijuana-implan-wms',
    endpoint: 'https://gemelodigital.implantijuana.gob.mx/geoserver-local-proxy/wms',
    layer: 'catastro_pub:predios-211126_Predios', idField: 'cve_cat', idFields: ['cve_cat'],
    idPrefix: 'MX-TIJUANA-CVE-', outFields: ['cve_cat'], parcelNumberField: 'cve_cat', identityKind: 'attribute-geometry-sha256-v1' };
const shell = [[-116.956,32.494,0],[-116.955,32.494,0],[-116.955,32.495,0],[-116.956,32.495,0],[-116.956,32.494,0]];
const hole = [[-116.9558,32.4942,0],[-116.9558,32.4944,0],[-116.9556,32.4944,0],[-116.9558,32.4942,0]];
const geometry = { type: 'Polygon', coordinates: [shell, hole] };
const other = { type: 'Polygon', coordinates: [shell.map(([x,y,z]) => [x + 0.0001,y,z])] };
const idFor = (g, code = 'CF127016') => descriptor.idPrefix + code + ':' + createHash('sha256').update(JSON.stringify(g)).digest('hex');
const id = idFor(geometry);
const ring = (side, coordinates) => `<${side}BoundaryIs><LinearRing><coordinates>${coordinates.map(p => p.join(',')).join(' ')}</coordinates></LinearRing></${side}BoundaryIs>`;
const mark = (g = geometry, fid = 'unstable') => `<Placemark id="${fid}"><Polygon>${ring('outer',g.coordinates[0])}${g.coordinates.slice(1).map(r => ring('inner',r)).join('')}</Polygon></Placemark>`;
const kml = (marks = mark()) => `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${marks}</Document></kml>`;
const collection = (codes = ['CF127016']) => ({ type: 'FeatureCollection', numberReturned: codes.length,
    features: codes.map(cve_cat => ({ properties: { cve_cat }, geometry: null })) });
const mock = (calls, marks = mark(), payload = collection()) => async (url, init) => {
    const p = new URL(url).searchParams; calls.push({ p, init });
    return new Response(p.get('REQUEST') === 'GetMap' ? kml(marks) : JSON.stringify(payload));
};

test('backend and browser read unchanged rings and holes with independently verified geometry references', async () => {
    const calls = [], browserCalls = [];
    const a = await createParcelSource(descriptor, { fetchImpl: mock(calls) }).queryIds([id]);
    const browser = browserParcelFactories['tijuana-implan-wms'](descriptor, { fetchImpl: async (url, init) => {
        browserCalls.push({ url, init });
        const validated = validateParcelProviderRelayRequest(descriptor.id, { url, method: init.method,
            headers: init.headers, body: init.body }, { sources: [descriptor] });
        assert.equal(validated.timeoutMs, 60000);
        return fetchParcelProviderRelay(validated, { providerFetch: (url, init) => mock(calls)(url.href, init) });
    } });
    const b = await browser.queryIds([id]);
    assert.deepEqual(a, b); assert.equal(calls.length, 2); assert.equal(browserCalls.length, 1);
    assert.deepEqual(a.features[0].geometry, geometry);
    assert.equal(a.features[0].id, id);
    assert.equal(a.features[0].properties.sourceParcelId, 'CF127016');
    assert.equal(a.features[0].properties.parcelNumber, 'CF127016');
    assert.deepEqual(a.features[0].properties.sourceProperties, { cve_cat: 'CF127016' });
    for (const { p, init } of calls) {
        assert.equal(p.get('CQL_FILTER'), "cve_cat = 'CF127016'");
        assert.equal(p.get('PROPERTYNAME'), 'cve_cat,geom');
        assert.equal(p.get('maxFeatures'), '65');
        assert.match(p.get('format_options'), /KMATTR:false/);
        assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    }
    assert.deepEqual((await browser.queryBounds([-116.956,32.494,-116.9555,32.4945])).features[0].geometry, geometry);
    assert.equal(browserCalls.length, 2); assert.equal(calls.length, 4);
    for (const body of [{ _tijuanaOperation: 'queryIds', input: [id + "' OR 1=1"] },
        { _tijuanaOperation: 'unknown', input: [] }, { _tijuanaOperation: 'queryIds', input: [], extra: true }]) {
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url: descriptor.endpoint,
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { sources: [descriptor] }));
    }
    const tampered = structuredClone(a); tampered.features[0].geometry = other;
    await assert.rejects(browserParcelFactories['tijuana-implan-wms'](descriptor, {
        fetchImpl: async () => new Response(JSON.stringify(tampered))
    }).queryIds([id]), { status: 502 });
});

test('two different source polygons sharing a native key remain separate and exactly readable', async () => {
    const calls = [], source = createTijuanaImplanSource(descriptor, { fetchImpl: mock(calls,
        mark(geometry, 'fid-1') + mark(other, 'fid-2'), collection(['CF127016','CF127016'])) });
    const read = await source.queryBounds([-116.9561,32.4939,-116.9548,32.4951]);
    assert.equal(read.features.length, 2);
    assert.deepEqual(read.features.map(f => f.id).sort(), [id, idFor(other)].sort());
    assert.deepEqual(read.features.map(f => f.geometry), [geometry, other]);
    assert.equal(calls.length, 2); // One native-key group, despite repeated manifest rows.
    const exact = await source.queryIds([id]);
    assert.deepEqual(exact.features.map(f => f.id), [id]);
    assert.deepEqual((await source.queryIds([idFor(other)])).features[0].geometry, other);
    assert.deepEqual((await source.queryIds([descriptor.idPrefix + 'CF127016:' + '0'.repeat(64)])).absentIds,
        [descriptor.idPrefix + 'CF127016:' + '0'.repeat(64)]);
    const repeated = createTijuanaImplanSource(descriptor, { fetchImpl: mock([], mark() + mark()) });
    assert.equal((await repeated.queryIds([id])).features.length, 1); // Identical representations, not distinct geometry.
});

test('every exact read is fresh; empty key reads and changed geometry explicitly lack the requested reference', async () => {
    const calls = [], source = createTijuanaImplanSource(descriptor, { fetchImpl: mock(calls) });
    await source.queryIds([id]); await source.queryIds([id]); assert.equal(calls.length, 2);
    const empty = createTijuanaImplanSource(descriptor, { fetchImpl: mock([], '') });
    assert.deepEqual((await empty.queryIds([id])).absentIds, [id]);
    await assert.rejects(empty.queryBounds([-116.956,32.494,-116.955,32.495]), { status: 502 });
    const changed = createTijuanaImplanSource(descriptor, { fetchImpl: mock([], mark(other)) });
    assert.deepEqual((await changed.queryIds([id])).absentIds, [id]);
});

test('bounded manifests use the verified small frame and geometry predicates preserve source polygons', async () => {
    const calls = [], source = createTijuanaImplanSource(descriptor, { fetchImpl: mock(calls) });
    assert.deepEqual((await source.queryBounds([-116.956,32.494,-116.9555,32.4945])).features[0].geometry, geometry);
    assert.equal(calls[0].p.get('WIDTH'), '8'); assert.equal(calls[0].p.get('X'), '4');
    assert.equal(calls[0].p.get('PROPERTYNAME'), 'cve_cat');
    assert.equal(calls[0].p.get('CQL_FILTER'), "BBOX(geom,-116.956,32.494,-116.9555,32.4945,'EPSG:4326')");
    assert.equal((await source.queryPoint([-116.9551,32.4941])).features.length, 1);
    assert.equal((await source.queryPoint([-116.95575,32.4943])).features.length, 0);
    assert.equal((await source.queryGeometry(geometry)).features.length, 1);
    assert.equal((await source.queryBounds([-116.95,32.49,-116.949,32.491])).features.length, 0);
});

test('rejects unsafe fields, indirect/malformed KML, saturation, excess bytes and malformed queries', async () => {
    const extra = collection(); extra.features[0].properties.owner = 'synthetic';
    for (const payload of [extra, collection(Array(501).fill('CF127016')), { error: 'failure' },
        { ...collection(), crs: { type: 'name', properties: { name: 'EPSG:32611' } } }]) {
        await assert.rejects(createTijuanaImplanSource(descriptor, { fetchImpl: mock([], mark(), payload) })
            .queryBounds([-116.956,32.494,-116.955,32.495]), { status: 502 });
    }
    for (const marks of [mark() + '<description>synthetic</description>', '<NetworkLink/>', Array(65).fill(mark()).join('')]) {
        await assert.rejects(createTijuanaImplanSource(descriptor, { fetchImpl: mock([], marks) }).queryIds([id]), { status: 502 });
    }
    const source = createTijuanaImplanSource(descriptor, { fetchImpl: mock([]) });
    await assert.rejects(source.queryIds([descriptor.idPrefix + 'CF127016']), { status: 400 });
    await assert.rejects(source.queryIds([id + "' OR 1=1"]), { status: 400 });
    await assert.rejects(source.queryBounds([-117,32,-116,33]), { status: 400 });
    await assert.rejects(createTijuanaImplanSource(descriptor, { maxResponseBytes: 1024,
        fetchImpl: async () => new Response(' '.repeat(1025)) }).queryIds([id]), { status: 502 });
    await assert.rejects(createTijuanaImplanSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) })
        .queryIds([id]), { upstreamStatus: 403 });
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(createTijuanaImplanSource(descriptor, { fetchImpl: async (_url,{signal}) => signal.throwIfAborted() })
        .queryIds([id], { signal: controller.signal }), /cancelled/);
});
