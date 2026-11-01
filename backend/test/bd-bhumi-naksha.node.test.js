// Exercise public-session transport, unchanged geometry, native IDs and fail-closed mouza reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { createBrowserProviderFetch, browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { parseKeralaWktPolygon } from '../parcels/kerala-wkt.js';

const rows = JSON.parse(readFileSync(new URL('./fixtures/bd-bhumi-naksha-safe-plots.json', import.meta.url)));
const descriptor = {
    id: 'bd-minland-smart-bhumi-naksha-brahmanbaria-plot-geometry', adapter: 'bd-bhumi-naksha',
    endpoint: 'https://map.land.gov.bd/getGeomByCode', catalogueUrl: 'https://map.land.gov.bd/',
    idPrefix: 'bd-map-land:', outFields: ['m_code', 'plot_no_en'], parcelNumberField: 'plot_no_en',
    mouzaForm: { level: 'forMauza', tableName: 'cha_bra', mauzaVal: '201213091071', plotOrLanduse: 'plot' },
    sheetNamespaces: rows.map(row => row.m_code.toLowerCase()),
    expectedSnapshotFeatures: rows.length, maxSnapshotFeatures: 5000, maxSnapshotBytes: 8388608,
    maxFeatures: 10000, maxBboxKm2: 25, snapshotTimeoutMs: 45000
};
const ids = rows.map(row => `bd-map-land:${row.m_code.toLowerCase()}:plot-${row.plot_no_en}`);
const html = '<meta name="csrf-token" content="abcdefghijklmnopqrstuv1234567890">';
function fixture({ payload = () => ({ plots: rows }), expiredOnce = false, factory = createParcelSource } = {}) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (url === descriptor.catalogueUrl) return new Response(html, { headers: { 'Set-Cookie': 'laravel_session=public-fixture; Path=/; HttpOnly' } });
        assert.equal(url, descriptor.endpoint);
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Cookie, 'laravel_session=public-fixture');
        const form = new URLSearchParams(options.body);
        assert.deepEqual(Object.fromEntries(form), { ...descriptor.mouzaForm, _token: 'abcdefghijklmnopqrstuv1234567890' });
        if (expiredOnce) { expiredOnce = false; return new Response('expired', { status: 419 }); }
        return new Response(JSON.stringify(payload()));
    };
    return { adapter: factory(descriptor, { fetchImpl }), calls };
}

test('backend and browser factories preserve complete exact plot IDs and WKT geometry', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['bd-bhumi-naksha']]) {
        const { adapter, calls } = fixture({ factory });
        const result = await adapter.queryIds(ids);
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(feature => feature.id), ids);
        assert.deepEqual(result.features.map(feature => feature.geometry), rows.map(row => parseKeralaWktPolygon(row.geom)));
        assert.deepEqual(result.features.map(feature => Object.keys(feature.properties.sourceProperties)), rows.map(() => ['m_code', 'plot_no_en']));
        result.features[0].geometry.coordinates[0][0][0][0] = 0;
        assert.deepEqual((await adapter.queryIds(ids)).features[0].geometry, parseKeralaWktPolygon(rows[0].geom));
        assert.equal(calls.length, 2, 'one public session and whole-mouza request per cached instance');
        const absent = `${descriptor.idPrefix}${descriptor.sheetNamespaces[0]}:plot-999999999999`;
        assert.deepEqual((await adapter.queryIds([absent])).absentIds, [absent]);
        const found = await adapter.queryBounds([91.097, 23.979, 91.098, 23.980]);
        assert.ok(found.features.some(feature => feature.id === ids[0]));
        assert.deepEqual(found.features.find(feature => feature.id === ids[0]).geometry, parseKeralaWktPolygon(rows[0].geom));
    }
});

test('fresh sessions repeat native geometry and a stale public CSRF session is renewed once', async () => {
    const a = fixture({ expiredOnce: true }), b = fixture();
    assert.deepEqual((await a.adapter.queryIds(ids)).features, (await b.adapter.queryIds(ids)).features);
    assert.equal(a.calls.length, 4);
    assert.equal(b.calls.length, 2);
});

test('partial responses, duplicate keys, foreign sheets and unexpected dimensionality fail closed', async () => {
    for (const bad of [
        { plots: rows.slice(0, 1) },
        { plots: [rows[0], rows[0]] },
        { plots: [{ ...rows[0], m_code: 'CHA_BRA_BRA_072_001_BS' }, rows[1]] },
        { plots: [{ ...rows[0], geom: 'POLYGON((91 24 2,92 24 2,92 25 2,91 24 2))' }, rows[1]] },
        { plots: rows, complete: false }
    ]) await assert.rejects(fixture({ payload: () => bad }).adapter.queryIds(ids));
    const { adapter, calls } = fixture();
    await assert.rejects(adapter.queryIds(['bd-map-land:foreign:plot-1']), { status: 400 });
    assert.equal(calls.length, 0, 'invalid identity fails before transport');
    assert.throws(() => createParcelSource({ ...descriptor, mouzaForm: { ...descriptor.mouzaForm, plotOrLanduse: 'landzone' } }));
    for (const snapshotTimeoutMs of [0, 45001, '45000']) {
        assert.throws(() => createParcelSource({ ...descriptor, snapshotTimeoutMs }));
    }
});

test('multipart polygons and holes retain all original rings and vertices', async () => {
    const geom = 'MULTIPOLYGON(((91 24,91.1 24,91.1 24.1,91 24)),((91.2 24,91.3 24,91.3 24.1,91.2 24),(91.25 24.01,91.26 24.01,91.26 24.02,91.25 24.01)))';
    const result = await fixture({ payload: () => ({ plots: [{ ...rows[0], geom }, rows[1]] }) }).adapter.queryIds([ids[0]]);
    assert.deepEqual(result.features[0].geometry, parseKeralaWktPolygon(geom));
    assert.equal(result.features[0].geometry.coordinates.length, 2);
    assert.equal(result.features[0].geometry.coordinates[1].length, 2);
});

test('browser relay carries only the fixed provider session and rejects unrelated resources', async () => {
    const requests = [];
    const fetchImpl = createBrowserProviderFetch(descriptor, { relayBase: '/api', fetchImpl: async (url, options) => {
        requests.push(url);
        const input = JSON.parse(options.body);
        const checked = validateParcelProviderRelayRequest(descriptor.id, input, { sources: [descriptor] });
        assert.equal(checked.target.origin, 'https://map.land.gov.bd');
        if (input.method === 'GET') return new Response(html, { headers: {
            'x-parcel-upstream-cookies': JSON.stringify(['laravel_session=public-fixture; Path=/; HttpOnly'])
        } });
        assert.equal(checked.headers.get('cookie'), 'laravel_session=public-fixture');
        return new Response(JSON.stringify({ plots: rows }));
    } });
    const adapter = browserParcelFactories['bd-bhumi-naksha'](descriptor, { fetchImpl });
    assert.deepEqual((await adapter.queryIds(ids)).features.map(feature => feature.id), ids);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(url => url === `/api/parcel-provider-relay/${descriptor.id}`));
    for (const url of ['https://map.land.gov.bd/admin', 'https://example.com/getGeomByCode']) {
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url }, { sources: [descriptor] }));
    }
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url: descriptor.endpoint,
        headers: { Authorization: 'private-token' } }, { sources: [descriptor] }));
});
