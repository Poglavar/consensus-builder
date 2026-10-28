// Regress Kamoke's production factories, full geometry, safe fields and layer-confined reader access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createPulsePublicFetch } from '../parcels/pulse-public-source.js';

const endpoint = 'https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer/8';
const bootstrap = 'https://lis.pulse.gop.pk/api/gis/token';
const descriptor = {
    id: 'pk-pulse-gujranwala-kamoke-cadastral', adapter: 'pulse-public', endpoint,
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'pk-pulse-gujranwala-kamoke-objectid:', outFields: ['OBJECTID'],
    queryFormat: 'geojson', boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    boundsSrid: 3857, boundsProjection: 'EPSG:3857', pageSize: 100, idBatchSize: 80,
    maxFeatures: 3000, maxBboxKm2: 25, maxResponseBytes: 16777216,
    maxConcurrentQueries: 2, browserTransport: 'relay'
};
const ids = [5253636, 5254688];
const canonicalIds = ids.map(id => descriptor.idPrefix + id);
// Synthetic full geometry extends outside the viewport; the inner ring must survive unchanged.
const geometry = { type: 'Polygon', coordinates: [
    [[74.221, 31.980], [74.227, 31.980], [74.227, 31.999], [74.221, 31.999], [74.221, 31.980]],
    [[74.223, 31.983], [74.223, 31.984], [74.224, 31.984], [74.224, 31.983], [74.223, 31.983]]
] };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
});
const access = () => json({ success: true, token: 'synthetic-kamoke-reader',
    expiresAt: new Date(Date.now() + 60000).toISOString() });

for (const [name, factory] of [['backend', createParcelSource],
    ['browser', browserParcelFactories['pulse-public']]]) {
    test(`${name} Kamoke enumerates bounded IDs and repeats full exact parcel reads`, async () => {
        let bootstraps = 0;
        const queries = [];
        // Force multiple geometry pages while using the production city's query modes.
        const source = factory({ ...descriptor, pageSize: 1 }, { fetchImpl: async (input, init) => {
            if (input === bootstrap) { bootstraps++; return access(); }
            const url = new URL(input), p = url.searchParams;
            queries.push(p);
            assert.equal(url.origin + url.pathname, endpoint + '/query');
            assert.equal(p.get('token'), 'synthetic-kamoke-reader');
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
        const bounds = [74.2245, 31.985, 74.2246, 31.9851];
        const bounded = await source.queryBounds(bounds);
        const exact = await source.queryIds(canonicalIds);
        const repeated = await source.queryIds(canonicalIds);
        for (const result of [bounded, exact, repeated]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(f => f.id).sort(), canonicalIds);
            for (const feature of result.features) assert.deepEqual(feature.geometry, geometry);
            assert.equal(JSON.stringify(result).includes('synthetic-kamoke-reader'), false);
        }
        assert.deepEqual(exact.features, repeated.features);
        assert.deepEqual(exact.absentIds, []);
        assert.equal(bootstraps, 1);
        assert.equal(queries.length, 12);
        const envelope = queries.find(p => p.has('geometry'));
        assert.equal(envelope.get('inSR'), '3857');
        assert.equal(envelope.get('geometryType'), 'esriGeometryEnvelope');
        const projected = envelope.get('geometry').split(',').map(Number);
        const mercator = ([lon, lat]) => [6378137 * lon * Math.PI / 180,
            6378137 * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
        const expected = [...mercator(bounds.slice(0, 2)), ...mercator(bounds.slice(2))];
        projected.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 0.001));
        assert.equal(queries.find(p => p.get('where')?.startsWith('OBJECTID IN')).get('where'),
            'OBJECTID IN (5253636,5254688)');
    });

    test(`${name} Kamoke refuses truncated ID manifests before reading geometry`, async () => {
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

test('Kamoke reader rejects another layer and caller tokens before bootstrapping', async () => {
    let calls = 0;
    const fetch = createPulsePublicFetch(endpoint, { fetchImpl: async () => { calls++; return access(); } });
    for (const target of [endpoint.replace('/8', '/12') + '/query?f=json',
        endpoint + '/query?token=caller-value', endpoint + '/query#fragment', 'https://example.test/query']) {
        await assert.rejects(fetch(target), /configured layer/);
    }
    assert.equal(calls, 0);
});

test('Kamoke preserves provider access failures without leaking anonymous reader values', async () => {
    let queries = 0;
    const source = createParcelSource(descriptor, { fetchImpl: async input => {
        if (input === bootstrap) return access();
        queries++;
        return json({}, 403);
    } });
    await assert.rejects(source.queryIds([canonicalIds[0]]), error => {
        assert.equal(error.code, 'parcel-source-blocked');
        assert.equal(error.upstreamStatus, 403);
        assert.equal(JSON.stringify(error).includes('synthetic-kamoke-reader'), false);
        return true;
    });
    assert.equal(queries, 1);
});
