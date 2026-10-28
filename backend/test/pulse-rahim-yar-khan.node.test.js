// Verify Rahim Yar Khan layer 27 through both production factories without network or saved parcel data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createPulsePublicFetch } from '../parcels/pulse-public-source.js';

const endpoint = 'https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer/27';
const bootstrap = 'https://lis.pulse.gop.pk/api/gis/token';
const descriptor = {
    id: 'pk-pulse-rahim-yar-khan-cadastral', adapter: 'pulse-public', endpoint,
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'pk-pulse-rahim-yar-khan-objectid:', outFields: ['OBJECTID'], queryFormat: 'geojson',
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    boundsSrid: 3857, boundsProjection: 'EPSG:3857', pageSize: 100, idBatchSize: 80,
    maxFeatures: 3000, maxBboxKm2: 1, maxResponseBytes: 16777216,
    maxConcurrentQueries: 2, browserTransport: 'relay'
};
const ids = [5291819, 5771235];
const canonicalIds = ids.map(id => descriptor.idPrefix + id);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
});
const access = () => json({ success: true, token: 'synthetic-reader',
    expiresAt: new Date(Date.now() + 60000).toISOString() });
// Synthetic multipart geometry includes a hole and extends beyond the requested viewport.
const geometry = { type: 'MultiPolygon', coordinates: [
    [
        [[70.306, 28.420], [70.307, 28.420], [70.307, 28.421], [70.306, 28.421], [70.306, 28.420]],
        [[70.3062, 28.4202], [70.3062, 28.4203], [70.3063, 28.4203], [70.3063, 28.4202], [70.3062, 28.4202]]
    ],
    [[[70.308, 28.422], [70.309, 28.422], [70.309, 28.423], [70.308, 28.423], [70.308, 28.422]]]
] };

for (const [name, factory] of [['backend', createParcelSource],
    ['browser', browserParcelFactories['pulse-public']]]) {
    test(`${name} Rahim Yar Khan reads complete native-ID manifests and unchanged full geometry`, async () => {
        let bootstraps = 0;
        const queries = [];
        // Smaller pages exercise batching while retaining the city's production query modes.
        const source = factory({ ...descriptor, pageSize: 1 }, { fetchImpl: async (input, init) => {
            if (input === bootstrap) { bootstraps++; return access(); }
            const url = new URL(input), p = url.searchParams;
            queries.push(p);
            assert.equal(url.origin + url.pathname, endpoint + '/query');
            assert.equal(p.get('token'), 'synthetic-reader');
            assert.equal(p.get('outFields'), 'OBJECTID');
            assert.equal(init.redirect, 'error');
            assert.equal(init.headers.get('Referer'), 'https://lis.pulse.gop.pk/');
            if (p.has('returnCountOnly')) return json({ count: ids.length });
            if (p.has('returnIdsOnly')) return json({ objectIdFieldName: 'OBJECTID', objectIds: [...ids].reverse() });
            assert.equal(p.get('outSR'), '4326');
            for (const key of ['geometry', 'geometryPrecision', 'maxAllowableOffset']) assert.equal(p.has(key), false);
            const oid = Number(p.get('objectIds'));
            assert.ok(ids.includes(oid));
            return json({ type: 'FeatureCollection', exceededTransferLimit: false,
                features: [{ type: 'Feature', properties: { OBJECTID: oid }, geometry }] });
        } });
        const first = await source.queryIds(canonicalIds);
        const repeated = await source.queryIds(canonicalIds);
        const bounded = await source.queryBounds([70.3064, 28.4203, 70.3065, 28.4204]);
        for (const result of [first, repeated, bounded]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(f => f.id).sort(), canonicalIds);
            for (const feature of result.features) assert.deepEqual(feature.geometry, geometry);
            assert.equal(JSON.stringify(result).includes('synthetic-reader'), false);
        }
        assert.deepEqual(first.features, repeated.features);
        assert.deepEqual(first.absentIds, []);
        assert.equal(bootstraps, 1);
        assert.equal(queries[0].get('where'), 'OBJECTID IN (5291819,5771235)');
        const envelope = queries.find(p => p.has('geometry'));
        assert.equal(envelope.get('inSR'), '3857');
        assert.equal(envelope.get('geometryType'), 'esriGeometryEnvelope');
        const projected = envelope.get('geometry').split(',').map(Number);
        assert.ok(projected[0] > 7820000 && projected[2] < 7830000);
        assert.ok(projected[1] > 3300000 && projected[3] < 3310000);
    });

    test(`${name} Rahim Yar Khan rejects a truncated manifest before accepting polygons`, async () => {
        let polygons = 0;
        const source = factory(descriptor, { fetchImpl: async input => {
            if (input === bootstrap) return access();
            const p = new URL(input).searchParams;
            if (p.has('returnCountOnly')) return json({ count: 2 });
            if (p.has('returnIdsOnly')) return json({ objectIdFieldName: 'OBJECTID', objectIds: [ids[0]] });
            polygons++;
            return json({ type: 'FeatureCollection', features: [] });
        } });
        await assert.rejects(source.queryIds(canonicalIds), /incomplete or invalid object-ID list/);
        assert.equal(polygons, 0);
    });
}

test('Rahim Yar Khan reader shares concurrent bootstrap and renews timezone-free expiry after thirty seconds', async () => {
    let time = Date.parse('2026-10-26T00:00:00Z'), bootstraps = 0;
    const tokens = [];
    const fetch = createPulsePublicFetch(endpoint, { now: () => time, fetchImpl: async input => {
        if (input === bootstrap) return json({ success: true, token: `synthetic-reader-${++bootstraps}`,
            expiresAt: '2026-10-26T01:00:00' });
        tokens.push(new URL(input).searchParams.get('token'));
        return json({});
    } });
    const query = endpoint + '/query?f=json';
    await Promise.all([fetch(query), fetch(query)]);
    time += 29000;
    await fetch(query);
    assert.equal(bootstraps, 1);
    time += 1001;
    await fetch(query);
    assert.equal(bootstraps, 2);
    assert.deepEqual(tokens, ['synthetic-reader-1', 'synthetic-reader-1', 'synthetic-reader-1', 'synthetic-reader-2']);
});

test('Rahim Yar Khan reader rejects other layers and caller tokens before any access bootstrap', async () => {
    let calls = 0;
    const fetch = createPulsePublicFetch(endpoint, { fetchImpl: async () => { calls++; return access(); } });
    for (const target of [endpoint.replace('/27', '/12') + '/query?f=json',
        'https://example.test/query', endpoint + '/query?token=caller-value', endpoint + '/query#fragment']) {
        await assert.rejects(fetch(target), /configured layer/);
    }
    assert.equal(calls, 0);
});

test('Rahim Yar Khan preserves a blocked response without retrying or exposing the reader', async () => {
    let queries = 0;
    const source = createParcelSource(descriptor, { fetchImpl: async input => {
        if (input === bootstrap) return access();
        queries++;
        return json({}, 403);
    } });
    await assert.rejects(source.queryIds([canonicalIds[0]]), error => {
        assert.equal(error.code, 'parcel-source-blocked');
        assert.equal(error.upstreamStatus, 403);
        assert.equal(JSON.stringify(error).includes('synthetic-reader'), false);
        return true;
    });
    assert.equal(queries, 1);
});
