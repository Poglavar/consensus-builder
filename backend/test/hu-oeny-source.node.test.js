// Exercise OÉNY identity joins, EOV transforms, bounded enumeration and relay wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createOenyParcelSource, eovToWgs84, wgs84ToEov } from '../parcels/hu-oeny-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { id: 'hu-lechner-oeny-cadastral-parcels', adapter: 'hu-oeny',
    endpoint: 'https://www.oeny.hu/hk-api/parcels/at', idPrefix: 'HU-OENY-HRSZ-',
    idField: 'id', outFields: ['id'], capabilities: { areaEnumeration: true }, maxFeatures: 80 };
const native = { type: 'MultiPolygon', coordinates: [[[
    [652700, 239300], [652800, 239300], [652800, 239400], [652700, 239400], [652700, 239300]
]]] };
const payload = () => ({ outline: structuredClone(native), settlement: { kshCode: '25405', name: 'Budapest' },
    lotNumber: '34589', boundingBox: { min: { x: 1, y: 2 }, max: { x: 3, y: 4 } },
    addresses: ['unselected incidental field'] });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function transport(overrides = {}) {
    const calls = [];
    const fetchImpl = async (input, init) => {
        const url = new URL(input); calls.push(url);
        assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
        if (url.pathname.endsWith('/hrsz')) return json(overrides.enumeration || { success: true,
            data: [{ ksh_telepules: 'BUDAPEST VIII.KERÜLET', fekves: 1, hrsz: '34589' }] });
        if (url.pathname.endsWith('/search')) return json([{ id: overrides.id || 278781, lotNumber: '34589' },
            { id: 42, lotNumber: '34589/1' }]);
        return json(overrides.parcel || payload());
    };
    return { calls, fetchImpl, queueRequestImpl: (_key, interval, run) => {
        assert.equal(interval, 1100);
        return run();
    } };
}

test('native EOV axis handling agrees with independently evaluated EPSG transform', () => {
    const p = eovToWgs84([652716.718, 239387.041]);
    assert.ok(Math.abs(p[0] - 19.0835031026958) < 0.000005);
    assert.ok(Math.abs(p[1] - 47.498413385628) < 0.000005);
    const back = wgs84ToEov(p);
    assert.ok(Math.hypot(back[0] - 652716.718, back[1] - 239387.041) < 0.01);
});

test('backend and browser factories perform fresh exact reads and retain only safe native identity', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['hu-oeny']]) {
        const t = transport(), adapter = factory(descriptor, t);
        const before = structuredClone(native);
        const a = await adapter.queryIds(['HU-OENY-HRSZ-278781']);
        const b = await adapter.queryIds(['HU-OENY-HRSZ-278781']);
        assert.deepEqual(a, b); assert.equal(t.calls.length, 4);
        assert.equal(a.features[0].id, 'HU-OENY-HRSZ-278781');
        assert.deepEqual(a.features[0].properties.sourceProperties, { id: '278781' });
        assert.equal(JSON.stringify(a).includes('addresses'), false);
        assert.deepEqual(native, before);
        assert.equal(a.features[0].geometry.coordinates[0][0].length, 5);
    }
});

test('exact reads fail when reverse mapping disagrees or an ID is outside Budapest', async () => {
    await assert.rejects(createOenyParcelSource(descriptor, transport({ id: 77 })).queryIds(['HU-OENY-HRSZ-278781']), /inconsistent/);
    const foreign = payload(); foreign.settlement.name = 'Mór';
    await assert.rejects(createOenyParcelSource(descriptor, transport({ parcel: foreign })).queryIds(['HU-OENY-HRSZ-278781']), /inconsistent/);
});

test('bounds uses documented intersection list and full outlines, not provider boundingBox', async () => {
    const t = transport(), adapter = createOenyParcelSource(descriptor, t);
    const p = eovToWgs84([652750, 239350]);
    const r = await adapter.queryBounds([p[0] - 0.00001, p[1] - 0.00001, p[0] + 0.00001, p[1] + 0.00001]);
    assert.equal(r.complete, true); assert.equal(r.features.length, 1);
    assert.equal(t.calls.length, 3);
    const request = JSON.parse(t.calls[0].searchParams.get('geojson'));
    assert.equal(request.type, 'Polygon'); assert.equal(request.coordinates[0].length, 33);
    assert.equal(t.calls[1].searchParams.get('kshCode'), 'budap');
    assert.deepEqual(r.features[0].geometry.coordinates[0][0][0], eovToWgs84(native.coordinates[0][0][0]));
    assert.equal(r.completeness.citywide, false);
});

test('capped enumeration, malformed rings and byte overflow never become complete or absent', async () => {
    const rows = Array.from({ length: 500 }, () => ({ ksh_telepules: 'BUDAPEST VIII.KERÜLET', hrsz: '34589' }));
    await assert.rejects(createOenyParcelSource(descriptor, transport({ enumeration: { success: true, data: rows } }))
        .queryBounds([19.08, 47.498, 19.081, 47.499]), /limit/);
    const broken = payload(); broken.outline.coordinates[0][0].pop();
    await assert.rejects(createOenyParcelSource(descriptor, transport({ parcel: broken })).queryIds(['HU-OENY-HRSZ-278781']), /inconsistent/);
    const adapter = createOenyParcelSource(descriptor, { maxResponseBytes: 1024,
        queueRequestImpl: (_key, _interval, run) => run(),
        fetchImpl: async () => new Response(new Uint8Array(1025)) });
    await assert.rejects(adapter.queryIds(['HU-OENY-HRSZ-278781']), /byte budget/);
    await assert.rejects(createOenyParcelSource(descriptor, transport()).queryIds(['HU-OENY-HRSZ-0']), /canonical/);
});

test('relay permits only the source-specific companion resource paths', () => {
    for (const url of ['https://www.oeny.hu/hk-api/parcels/search?kshCode=budap&lotNumber=34589',
        'https://www.oeny.hu/hk-api/parcels/bounding-box?id=278781',
        'https://api.lechnerkozpont.hu/hrsz-terminator/api/hrsz?geojson=x']) {
        assert.doesNotThrow(() => validateParcelProviderRelayRequest(descriptor.id, { url, method: 'GET' }, { sources: [descriptor] }));
    }
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id,
        { url: 'https://www.oeny.hu/hk-api/addresses/search?searchString=x', method: 'GET' }, { sources: [descriptor] }));
});

test('bounds rejects ambiguous duplicate lot numbers across districts', async () => {
    const t = transport({ enumeration: { success: true, data: [
        { ksh_telepules: 'BUDAPEST VIII.KERÜLET', fekves: 1, hrsz: '34589' },
        { ksh_telepules: 'BUDAPEST IX.KERÜLET', fekves: 1, hrsz: '34589' }
    ] } });
    await assert.rejects(createOenyParcelSource(descriptor, t).queryBounds([19.08, 47.498, 19.081, 47.499]), /inconsistent/);
});

test('adjacent cells reuse their lot join but explicit exact reads stay fresh', async () => {
    const t = transport(), adapter = createOenyParcelSource(descriptor, t);
    const bounds = [19.08, 47.498, 19.081, 47.499];
    await adapter.queryBounds(bounds); await adapter.queryBounds(bounds);
    assert.equal(t.calls.length, 4);
    await adapter.queryIds(['HU-OENY-HRSZ-278781']);
    assert.equal(t.calls.length, 6);
});
