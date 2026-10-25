// Slow cadastral WFS responses need the same bounded deadline in direct and relayed reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = {
    id: 'tz-survey-timeout-test', adapter: 'wfs',
    endpoint: 'https://eardhi.lands.go.tz/map/geoserver/taspro/ows',
    version: '1.0.0', featureType: 'taspro:qualified_spatial_units',
    geometryField: 'geom', requestProperties: true, outFields: ['uid'],
    idField: 'uid', idType: 'string', idPrefix: 'TZ-SURVEY-', pageSize: 100
};

test('default and configured WFS deadlines reach the actual provider request and relay', async t => {
    const durations = [];
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', ms => {
        durations.push(ms);
        return controller.signal;
    });
    for (const timeoutMs of [undefined, 1000, 45000]) {
        const source = { ...descriptor, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
        const adapter = createWfsParcelSource(source, { fetchImpl: async (url, options) => {
            assert.equal(options.signal, controller.signal);
            assert.equal(new URL(url).searchParams.get('propertyName'), 'geom,uid');
            return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 0, features: [] }));
        } });
        const result = await adapter.queryIds(['TZ-SURVEY-not-present']);
        assert.deepEqual(result.absentIds, ['TZ-SURVEY-not-present']);
        const relay = validateParcelProviderRelayRequest(source.id,
            { url: source.endpoint + '?service=WFS' }, { sources: [source] });
        assert.equal(relay.timeoutMs, timeoutMs ?? 15000);
    }
    assert.deepEqual(durations, [15000, 1000, 45000]);
});

test('malformed or unbounded WFS timeouts fail before requesting provider data', () => {
    for (const timeoutMs of [null, 0, 999, 45001, Infinity, 1.5, '45000']) {
        assert.throws(() => createWfsParcelSource({ ...descriptor, timeoutMs }), /Invalid WFS/);
        // The relay never lets malformed catalog configuration enlarge its transport budget.
        const source = { ...descriptor, timeoutMs };
        const relay = validateParcelProviderRelayRequest(source.id,
            { url: source.endpoint + '?service=WFS' }, { sources: [source] });
        assert.equal(relay.timeoutMs, 15000);
    }
});

test('an elapsed configured WFS deadline still fails with a timeout and no absence claim', async t => {
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', ms => {
        assert.equal(ms, 45000);
        return controller.signal;
    });
    const adapter = createWfsParcelSource({ ...descriptor, timeoutMs: 45000 }, {
        fetchImpl: async () => { controller.abort(); throw controller.signal.reason; }
    });
    await assert.rejects(adapter.queryIds(['TZ-SURVEY-not-present']),
        { status: 504, code: 'parcel-source-unavailable', message: 'Parcel provider timed out.' });
});
