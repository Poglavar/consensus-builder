// Exercises anonymous token renewal, safe request scope and unchanged exact ArcGIS reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { createAkwaGisPublicFetch, AKWAGIS_PUBLIC_TOKEN_URL } from '../parcels/akwagis-public-fetch.js';

const endpoint = 'https://akwagis.xyz/server/rest/services/SurveyMap/mainDrafter/FeatureServer/3';
const descriptor = {
    id: 'ng-akwaibom-akwagis-surveymap-parcel-drafter', adapter: 'arcgis', endpoint,
    publicTokenUrl: AKWAGIS_PUBLIC_TOKEN_URL, idPrefix: 'NG-AKWAGIS-',
    idField: 'globalid', objectIdField: 'objectid', idType: 'string',
    idPattern: '^\\{[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\\}$',
    outFields: ['objectid', 'globalid'], pageSize: 1, maxFeatures: 10
};
const ids = ['{6F1BDD22-8AB2-412C-AE5E-05BE26146156}', '{751B4105-19FC-4711-BB5D-8B36F77AA96F}'];
const geometry = { type: 'Polygon', coordinates: [[[7.78,5.01],[7.781,5.01],[7.781,5.011],[7.78,5.01]]] };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const publicToken = (token = 'anonymous-test-token', expires = Date.now() + 120_000) =>
    json({ success: true, data: { token, expires, server: 'https://akwagis.xyz/server' } });

test('exact IDs and paged bounds use safe fields, one cached token and unchanged geometry', async () => {
    let tokens = 0;
    const queries = [];
    const fetchImpl = async (input, init) => {
        if (input === AKWAGIS_PUBLIC_TOKEN_URL) { tokens++; return publicToken(); }
        const url = new URL(input), p = url.searchParams;
        assert.equal(p.get('token'), 'anonymous-test-token');
        assert.equal(p.get('outFields'), 'objectid,globalid');
        assert.equal(p.get('outSR'), '4326');
        assert.equal(p.has('geometryPrecision'), false);
        assert.equal(init.credentials, 'omit');
        queries.push(p);
        const offset = Number(p.get('resultOffset'));
        const selected = offset < ids.length ? [{ type: 'Feature', properties: { objectid: offset + 1, globalid: ids[offset] }, geometry }] : [];
        return json({ type: 'FeatureCollection', features: selected, exceededTransferLimit: offset === 0 });
    };
    const source = createArcgisParcelSource(descriptor, { fetchImpl });
    const exact = await source.queryIds(ids.map(id => descriptor.idPrefix + id));
    const bounds = await source.queryBounds([7.779,5.009,7.782,5.012]);
    assert.equal(tokens, 1);
    assert.equal(exact.complete, true);
    assert.deepEqual(exact.absentIds, []);
    assert.deepEqual(bounds.features, exact.features);
    assert.equal(exact.features.length, 2);
    assert.deepEqual(exact.features[0].geometry, geometry);
    assert.equal(queries[0].get('where'), `globalid IN ('${ids[0]}','${ids[1]}')`);
    assert.deepEqual(queries.map(p => p.get('resultOffset')), ['0','1','0','1']);
});

for (const status of [200, 498, 499]) test(`renews exactly once for ArcGIS token error (${status})`, async () => {
    let tokens = 0, queries = 0;
    const source = createArcgisParcelSource(descriptor, { fetchImpl: async input => {
        if (input === AKWAGIS_PUBLIC_TOKEN_URL) return publicToken(`public-${++tokens}`);
        const url = new URL(input);
        assert.equal(url.searchParams.get('token'), `public-${queries ? 2 : 1}`);
        if (!queries++) return json({ error: { code: 498 } }, status);
        return json({ type: 'FeatureCollection', exceededTransferLimit: false, features: [{ type: 'Feature', properties: { objectid: 1, globalid: ids[0] }, geometry }] });
    } });
    assert.equal((await source.queryIds([descriptor.idPrefix + ids[0]])).features.length, 1);
    assert.equal(tokens, 2);
    assert.equal(queries, 2);
});

test('persistent token rejection stops after one renewal; 403 is never renewed', async () => {
    for (const code of [498, 403]) {
        let tokens = 0, queries = 0;
        const source = createArcgisParcelSource(descriptor, { fetchImpl: async input => {
            if (input === AKWAGIS_PUBLIC_TOKEN_URL) { tokens++; return publicToken(); }
            queries++;
            return json({ error: { code } }, code);
        } });
        await assert.rejects(source.queryIds([descriptor.idPrefix + ids[0]]), error =>
            error.code === 'parcel-source-blocked' && !error.message.includes('anonymous-test-token'));
        assert.equal(tokens, code === 498 ? 2 : 1);
        assert.equal(queries, tokens);
    }
});

test('expiry refresh, concurrent token acquisition and form POST retain their request contracts', async () => {
    let now = 1_000_000, tokens = 0;
    const fetch = createAkwaGisPublicFetch(async (input, init) => {
        if (input === AKWAGIS_PUBLIC_TOKEN_URL) return publicToken(`public-${++tokens}`, now + 120_000);
        const url = new URL(input), body = new URLSearchParams(init.body);
        assert.equal(url.searchParams.has('token'), false);
        assert.equal(body.get('token'), `public-${tokens}`);
        assert.equal(body.get('where'), '1=1');
        return json({ count: 0 });
    }, descriptor, { now: () => now });
    const post = () => fetch(`${endpoint}/query`, { method: 'POST', body: 'where=1%3D1&f=json' });
    await Promise.all([post(), post()]);
    assert.equal(tokens, 1);
    now += 100_000;
    await post();
    assert.equal(tokens, 2);
});

test('rejects foreign token routes, foreign service targets and malformed token contracts', async () => {
    let calls = 0;
    const fetch = createAkwaGisPublicFetch(async () => { calls++; return publicToken(); }, descriptor);
    await assert.rejects(fetch('https://example.test/query'), /cannot be sent/);
    assert.equal(calls, 0);
    assert.throws(() => createAkwaGisPublicFetch(() => {}, { ...descriptor, publicTokenUrl: 'https://example.test/token' }));
    for (const data of [ { token: 'x', expires: Date.now() + 120_000, server: 'https://example.test' },
        { token: 'x', expires: 0, server: 'https://akwagis.xyz/server' } ]) {
        const bad = createAkwaGisPublicFetch(async () => json({ success: true, data }), descriptor);
        await assert.rejects(bad(`${endpoint}/query`), /invalid public-token contract/);
    }
});
