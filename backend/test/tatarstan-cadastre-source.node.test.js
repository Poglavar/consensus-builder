// Exercise live-contract identity binding, geometry preservation, scope and relay restrictions.
import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createTatarstanCadastreSource, tatarstanPointUrl, TATARSTAN_ENDPOINT, TATARSTAN_GEOMETRY } from '../parcels/tatarstan-cadastre-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const row = { id: '16:27:070701:242', externalId: '205164', point: [52.38, 55.78] };
const descriptor = { id: 'ru-tatarstan-karta-cadastre', adapter: 'tatarstan-cadastre-bounded',
    endpoint: TATARSTAN_ENDPOINT, geometryEndpoint: TATARSTAN_GEOMETRY, idPrefix: 'RU-TATARSTAN-',
    idField: 'cad_num', outFields: ['cad_num'], nativeCrs: 'EPSG:3857',
    capabilities: { areaEnumeration: false }, coverage: { scope: 'explicit-native-id-subset', citywide: false, parcels: [row] } };
const id = descriptor.idPrefix + row.id;
const [x, y] = proj4('EPSG:4326', 'EPSG:3857', row.point);
const ring = [[x - 100, y - 100], [x + 100, y - 100], [x + 100, y + 100], [x - 100, y + 100], [x - 100, y - 100]];
const native = { type: 'MultiPolygon', coordinates: [[ring]], crs: { type: 'name', properties: { name: 'spatialreferencing.org:900913' } } };
function mock({ changedId = false, crs = native.crs, status = 200 } = {}) {
    const calls = [];
    const fetchImpl = async url => {
        calls.push(url);
        return new Response(JSON.stringify(url.startsWith(TATARSTAN_ENDPOINT)
            ? { 4: { cadastre: [{ cad_num: changedId ? '16:27:000000:999' : row.id, externalId: row.externalId, address: 'discard me' }] } }
            : { ...native, crs }), { status });
    };
    return { calls, fetchImpl };
}

test('both factories preserve native ID, reread upstream and transform every unchanged vertex', async () => {
    for (const factory of [createParcelSource, browserParcelFactories[descriptor.adapter]]) {
        const upstream = mock();
        const adapter = factory(descriptor, upstream);
        const first = await adapter.queryIds([id]), second = await adapter.queryIds([id]);
        assert.equal(upstream.calls.length, 4);
        assert.equal(upstream.calls[0], tatarstanPointUrl(row.point));
        assert.deepEqual(second, first);
        assert.deepEqual(first.absentIds, []);
        assert.equal(first.features[0].id, id);
        assert.deepEqual(first.features[0].properties.sourceProperties, { cad_num: row.id });
        assert.equal(JSON.stringify(first).includes('discard me'), false);
        assert.deepEqual(first.features[0].geometry.coordinates, [[ring.map(pair => proj4('EPSG:3857', 'EPSG:4326', pair))]]);
        assert.equal(first.areaComplete, false);
    }
});

test('identity changes, unknown CRS and provider denials fail rather than reporting absence', async () => {
    const identity = mock({ changedId: true });
    await assert.rejects(createTatarstanCadastreSource(descriptor, identity).queryIds([id]), /identity changed/);
    assert.equal(identity.calls.length, 1);
    await assert.rejects(createTatarstanCadastreSource(descriptor, mock({ crs: { type: 'name', properties: { name: 'EPSG:4326' } } })).queryIds([id]), /unusable/);
    await assert.rejects(createTatarstanCadastreSource(descriptor, mock({ status: 403 })).queryIds([id]), error => error.code === 'parcel-source-blocked');
    await assert.rejects(createTatarstanCadastreSource(descriptor, mock()).queryIds(['RU-TATARSTAN-16:52:000000:1']), error => error.code === 'parcel-source-out-of-scope');
});

test('viewport and point reads filter only the explicitly declared live subset', async () => {
    const upstream = mock(), adapter = createTatarstanCadastreSource(descriptor, upstream);
    const inside = await adapter.queryBounds([52.379, 55.779, 52.381, 55.781]);
    assert.equal(inside.features.length, 1);
    assert.equal(inside.coverageScope, 'explicit-native-id-subset');
    assert.equal((await adapter.queryPoint(row.point)).features.length, 1);
    assert.equal((await adapter.queryPoint([52, 55])).features.length, 0);
    assert.equal(upstream.calls.length, 2);
    await adapter.queryIds([id]);
    assert.equal(upstream.calls.length, 4);
});

test('streamed byte cap is enforced without Content-Length and cancels an oversized response', async () => {
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(1025)); },
        cancel() { cancelled = true; }
    }));
    const adapter = createTatarstanCadastreSource(descriptor, { fetchImpl, maxResponseBytes: 1024 });
    await assert.rejects(adapter.queryIds([id]), /unusable/);
    assert.equal(cancelled, true);
});

test('relay accepts only configured public identity/geometry reads', () => {
    const validate = input => validateParcelProviderRelayRequest(descriptor.id, input, { sources: [descriptor] });
    assert.equal(validate({ url: tatarstanPointUrl(row.point) }).method, 'GET');
    assert.equal(validate({ url: `${TATARSTAN_GEOMETRY}?id=205164` }).method, 'GET');
    for (const input of [
        { url: `${TATARSTAN_GEOMETRY}?id=999` },
        { url: `${TATARSTAN_GEOMETRY}?id=205164&extra=true` },
        { url: tatarstanPointUrl(row.point), method: 'POST', body: '{}' },
        { url: tatarstanPointUrl(row.point), headers: { Cookie: 'GISSESSID=private' } },
        { url: 'https://karta.tatar.ru/gis/ajax/profile' }
    ]) assert.throws(() => validate(input));
});
