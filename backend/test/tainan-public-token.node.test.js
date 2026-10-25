import test from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { createTainanPublicFetch, TAINAN_PUBLIC_TOKEN_URL, TAINAN_PARCEL_LAYER } from '../parcels/tainan-public-fetch.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { id: 'tw-tainan-ldmap-tn-measure-parcels', adapter: 'arcgis', endpoint: TAINAN_PARCEL_LAYER,
    publicTokenUrl: TAINAN_PUBLIC_TOKEN_URL, idPrefix: 'TW-TNLD-MEASURE-17:',
    idFields: ['LANDCODE', 'SECT', 'LANDNO8'], idFieldTypes: { LANDCODE: 'string', SECT: 'string', LANDNO8: 'string' },
    compositeIdSeparator: ':', objectIdField: 'OBJECTID', outFields: ['OBJECTID', 'LANDCODE', 'SECT', 'LANDNO8'], pageSize: 10 };
const json = value => new Response(JSON.stringify(value));
const token = () => json({ token: 'anonymous-test-token', expires: Date.now() + 120_000, ssl: true });
const geometry = { type: 'Polygon', coordinates: [[[120.2254,23.0028],[120.2255,23.0028],[120.2255,23.003],[120.2254,23.0028]]] };

test('Tainan exact reads preserve native zeroes and full geometry with one cached public token', async () => {
    let tokens = 0;
    const source = createArcgisParcelSource(descriptor, { fetchImpl: async (input, init) => {
        if (input === TAINAN_PUBLIC_TOKEN_URL) { tokens++; return token(); }
        const p = new URL(input).searchParams;
        assert.equal(p.get('token'), 'anonymous-test-token');
        assert.equal(p.get('where'), "(LANDCODE = 'DA' AND SECT = '0067' AND LANDNO8 = '00420090')");
        assert.equal(p.get('outFields'), 'OBJECTID,LANDCODE,SECT,LANDNO8');
        assert.equal(init.credentials, 'omit');
        return json({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry,
            properties: { OBJECTID: 123, LANDCODE: 'DA', SECT: '0067', LANDNO8: '00420090' } }] });
    } });
    const id = 'TW-TNLD-MEASURE-17:DA:0067:00420090';
    const first = await source.queryIds([id]), second = await source.queryIds([id]);
    assert.equal(tokens, 1);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.equal(first.features[0].id, id);
    assert.deepEqual(first.features[0].geometry, geometry);
    assert.deepEqual(first, second);
    await assert.rejects(source.queryIds(['TW-TNLD-MEASURE-17:DA:0067:00420090:extra']));
});

test('Tainan renews once on expiry and pins token destinations', async () => {
    let tokens = 0, queries = 0;
    const fetch = createTainanPublicFetch(async input => {
        if (input === TAINAN_PUBLIC_TOKEN_URL) { tokens++; return token(); }
        queries++;
        return json({ error: { code: 498 } });
    }, descriptor);
    await assert.rejects(fetch('https://example.test/query'));
    assert.equal(tokens, 0);
    assert.equal((await (await fetch(`${TAINAN_PARCEL_LAYER}/query`)).json()).error.code, 498);
    assert.equal(tokens, 2);
    assert.equal(queries, 2);
    assert.throws(() => createTainanPublicFetch(() => {}, { ...descriptor, endpoint: 'https://example.test' }));
});

test('relay permits only the pinned anonymous handler for the Tainan source', () => {
    const input = { url: TAINAN_PUBLIC_TOKEN_URL, method: 'GET', headers: { Accept: 'application/json' } };
    assert.doesNotThrow(() => validateParcelProviderRelayRequest(descriptor.id, input, { sources: [descriptor] }));
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id,
        { ...input, url: 'https://landmap.tainan.gov.tw/gis/assist/other.ashx' }, { sources: [descriptor] }));
});
