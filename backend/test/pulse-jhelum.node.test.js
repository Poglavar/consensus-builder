// Regress Jhelum's production factories, bounded manifests and token-safe full parcel reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createPulsePublicFetch } from '../parcels/pulse-public-source.js';

const endpoint = 'https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer/12';
const bootstrap = 'https://lis.pulse.gop.pk/api/gis/token';
const descriptor = {
    id: 'pk-pulse-jhelum-cadastral', adapter: 'pulse-public', endpoint,
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'pk-pulse-jhelum-objectid:', outFields: ['OBJECTID'], queryFormat: 'geojson',
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    boundsSrid: 3857, boundsProjection: 'EPSG:3857', pageSize: 1, maxFeatures: 3000,
    maxBboxKm2: 25, maxResponseBytes: 16777216
};
// Synthetic geometry extends outside the viewport and includes a hole to catch clipping or ring loss.
const geometry = { type: 'Polygon', coordinates: [
    [[73.71, 32.94], [73.72, 32.94], [73.72, 32.95], [73.71, 32.95], [73.71, 32.94]],
    [[73.713, 32.943], [73.713, 32.944], [73.714, 32.944], [73.714, 32.943], [73.713, 32.943]]
] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json' } });
const access = () => json({ success: true, token: 'synthetic-public-reader',
    expiresAt: new Date(Date.now() + 60000).toISOString() });
const ids = [1747833, 1747853];

for (const [name, factory] of [['backend', createParcelSource],
    ['browser', browserParcelFactories['pulse-public']]]) {
    test(`${name} Jhelum factory preserves native IDs and full rings across manifest pages`, async () => {
        let bootstraps = 0;
        const queries = [];
        const source = factory(descriptor, { fetchImpl: async (input, init) => {
            if (input === bootstrap) { bootstraps++; return access(); }
            const url = new URL(input), p = url.searchParams;
            queries.push(p);
            assert.equal(url.origin + url.pathname, endpoint + '/query');
            assert.equal(p.get('token'), 'synthetic-public-reader');
            assert.equal(p.get('outFields'), 'OBJECTID');
            assert.equal(init.headers.get('Referer'), 'https://lis.pulse.gop.pk/');
            assert.equal(init.redirect, 'error');
            if (p.has('returnCountOnly')) return json({ count: 2 });
            if (p.has('returnIdsOnly')) return json({ objectIdFieldName: 'OBJECTID', objectIds: [...ids].reverse() });
            assert.equal(p.get('outSR'), '4326');
            assert.equal(p.has('geometryPrecision'), false);
            assert.equal(p.has('maxAllowableOffset'), false);
            assert.equal(p.has('geometry'), false);
            const oid = Number(p.get('objectIds'));
            assert.ok(ids.includes(oid));
            return json({ type: 'FeatureCollection', exceededTransferLimit: false,
                features: [{ type: 'Feature', properties: { OBJECTID: oid }, geometry }] });
        } });
        const requested = ids.map(id => descriptor.idPrefix + id);
        const first = await source.queryIds(requested);
        const second = await source.queryIds(requested);
        const bounds = await source.queryBounds([73.714, 32.944, 73.715, 32.945]);
        for (const result of [first, second, bounds]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(f => f.id).sort(), [...requested].sort());
            for (const feature of result.features) assert.deepEqual(feature.geometry, geometry);
            assert.equal(JSON.stringify(result).includes('synthetic-public-reader'), false);
        }
        assert.deepEqual(first.features, second.features);
        assert.deepEqual(first.absentIds, []);
        assert.equal(bootstraps, 1);
        assert.equal(queries.length, 12);
        assert.equal(queries[0].get('where'), 'OBJECTID IN (1747833,1747853)');
        const envelope = queries.find(p => p.has('geometry'));
        assert.equal(envelope.get('inSR'), '3857');
        assert.equal(envelope.get('geometryType'), 'esriGeometryEnvelope');
        const projected = envelope.get('geometry').split(',').map(Number);
        assert.ok(projected[0] > 8200000 && projected[2] < 8210000);
        assert.ok(projected[1] > 3880000 && projected[3] < 3890000);
    });
}

test('Jhelum rejects an incomplete manifest before reading any polygon', async () => {
    let polygons = 0;
    const source = createParcelSource(descriptor, { fetchImpl: async input => {
        if (input === bootstrap) return access();
        const p = new URL(input).searchParams;
        if (p.has('returnCountOnly')) return json({ count: 2 });
        if (p.has('returnIdsOnly')) return json({ objectIdFieldName: 'OBJECTID', objectIds: [ids[0]] });
        polygons++;
        return json({ type: 'FeatureCollection', features: [] });
    } });
    await assert.rejects(source.queryIds(ids.map(id => descriptor.idPrefix + id)), /incomplete or invalid object-ID list/);
    assert.equal(polygons, 0);
});

test('Jhelum confines anonymous readers to its configured layer before bootstrap', async () => {
    let calls = 0;
    const fetch = createPulsePublicFetch(endpoint, { fetchImpl: async () => { calls++; return access(); } });
    for (const target of [endpoint.replace('/12', '/25') + '/query?f=json',
        'https://example.test/query', endpoint + '/query?token=caller-value']) {
        await assert.rejects(fetch(target), /configured layer/);
    }
    assert.equal(calls, 0);
});

test('Jhelum preserves blocked-source errors without retrying or exposing reader values', async () => {
    let queries = 0;
    const source = createParcelSource(descriptor, { fetchImpl: async input => {
        if (input === bootstrap) return access();
        queries++;
        return json({}, 403);
    } });
    await assert.rejects(source.queryIds([descriptor.idPrefix + ids[0]]), error => {
        assert.equal(error.code, 'parcel-source-blocked');
        assert.equal(error.upstreamStatus, 403);
        assert.equal(JSON.stringify(error).includes('synthetic-public-reader'), false);
        return true;
    });
    assert.equal(queries, 1);
});
