import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const nativeId = '73:24:041902:363';
const descriptor = {
    id: 'ru-ulyanovsk-reestr54-cadastral', endpoint: 'https://kk.reestr54.ru/ulyanovskaya-oblast/',
    adapter: 'reestr54-bounded', idPrefix: 'RU-REESTR54-ULYANOVSK-', idField: 'cad_num',
    outFields: ['cad_num'], nativeCrs: 'EPSG:3857', browserTransport: 'relay',
    capabilities: { areaEnumeration: false },
    coverage: { scope: 'explicit-native-id-subset', citywide: false, nativeIds: [nativeId] }
};
const token = 'a'.repeat(32);
const ring = [[5388114, 7229813], [5388235, 7229813], [5388235, 7230044], [5388114, 7229813]];

test('Ulyanovsk backend/browser factories read exact native identity live and preserve every vertex', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['reestr54-bounded']]) {
        let posts = 0;
        const fetchImpl = async (url, options) => {
            assert.equal(url, descriptor.endpoint);
            if (options.method === 'GET') return new Response('Публичная кадастровая карта', {
                headers: { 'Set-Cookie': `csrftoken=${token}; Path=/` }
            });
            posts++;
            assert.deepEqual(JSON.parse(options.body), { new_kadnum: nativeId, zoom: 19 });
            assert.equal(options.headers.Referer, descriptor.endpoint);
            assert.equal(options.headers.Cookie, `csrftoken=${token}`);
            return new Response(JSON.stringify({ type: 'Feature', properties: {
                category: 36368, options: { cad_num: nativeId, discarded: 'synthetic unselected attribute' }
            }, geometry: { type: 'Polygon', coordinates: [ring] } }), {
                headers: { 'Content-Type': 'application/json' }
            });
        };
        const source = factory(descriptor, { fetchImpl });
        const ids = [descriptor.idPrefix + nativeId];
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.deepEqual(second, first);
        assert.equal(posts, 2);
        assert.equal(first.features[0].id, ids[0]);
        assert.deepEqual(first.features[0].properties.sourceProperties, { cad_num: nativeId });
        assert.deepEqual(first.features[0].geometry.coordinates, [ring.map(p => proj4('EPSG:3857', 'EPSG:4326', p))]);
        const bounds = await source.queryBounds([48.402, 54.313, 48.405, 54.316]);
        assert.equal(bounds.features.length, 1);
        assert.equal(bounds.areaCompleteness, false);
        assert.equal(bounds.authoritativeAbsence, false);
        await assert.rejects(source.queryIds([descriptor.idPrefix + '73:19:070901:367']), { code: 'parcel-source-out-of-scope' });
    }
});

test('Ulyanovsk relay pins receipt endpoint and restricts exact IDs to the declared subset', () => {
    const validate = input => validateParcelProviderRelayRequest(descriptor.id, input, { sources: [descriptor] });
    const request = { url: descriptor.endpoint, method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Referer: descriptor.endpoint,
            Cookie: `csrftoken=${token}`, 'X-CSRFToken': token },
        body: JSON.stringify({ new_kadnum: nativeId, zoom: 19 }) };
    assert.equal(validate(request).target.href, descriptor.endpoint);
    assert.throws(() => validate({ ...request, url: 'https://kk.reestr54.ru/barnaul/' }));
    assert.throws(() => validate({ ...request, body: JSON.stringify({ new_kadnum: '73:19:070901:367', zoom: 19 }) }));
    assert.throws(() => createParcelSource({ ...descriptor, endpoint: 'https://kk.reestr54.ru/barnaul/' }));
    assert.throws(() => createParcelSource({ ...descriptor, coverage: { ...descriptor.coverage, nativeIds: ['73:19:070901:367'] } }));
});
