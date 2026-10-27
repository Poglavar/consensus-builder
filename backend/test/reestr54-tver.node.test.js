import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const nativeId = '69:40:0000000:7394';
const descriptor = { id: 'ru-tver-reestr54-tver-cadastral', endpoint: 'https://kk.reestr54.ru/tver/',
    adapter: 'reestr54-bounded', idPrefix: 'RU-REESTR54-TVER-', idField: 'cad_num', outFields: ['cad_num'],
    nativeCrs: 'EPSG:3857', browserTransport: 'relay', capabilities: { areaEnumeration: false },
    coverage: { scope: 'explicit-native-id-subset', citywide: false, nativeIds: [nativeId] } };
const token = 'a'.repeat(32);
const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
const polygons = [[square(3995650, 7730050, 100), square(3995670, 7730070, 10)], [square(3995900, 7730300, 40)]];

test('Tver backend/browser repeat live native-ID reads and preserve multipart rings and holes', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['reestr54-bounded']]) {
        let posts = 0, bootstraps = 0;
        const fetchImpl = async (url, options) => {
            assert.equal(url, descriptor.endpoint);
            if (options.method === 'GET') {
                bootstraps++;
                return new Response('Публичная кадастровая карта', { headers: { 'Set-Cookie': `csrftoken=${token}; Path=/` } });
            }
            posts++;
            assert.deepEqual(JSON.parse(options.body), { new_kadnum: nativeId, zoom: 19 });
            assert.equal(options.headers.Referer, descriptor.endpoint);
            assert.equal(options.headers.Cookie, `csrftoken=${token}`);
            return new Response(JSON.stringify({ type: 'Feature', realty_type: 'Земельный участок',
                properties: { category: 36368, options: { cad_num: nativeId, discarded: 'synthetic field' } },
                geometry: { type: 'MultiPolygon', coordinates: polygons } }), { headers: { 'Content-Type': 'application/json' } });
        };
        const source = factory(descriptor, { fetchImpl });
        const ids = [descriptor.idPrefix + nativeId];
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.deepEqual(first, second);
        assert.equal(posts, 2);
        assert.equal(bootstraps, 1);
        assert.equal(first.features[0].id, ids[0]);
        assert.deepEqual(first.features[0].properties.sourceProperties, { cad_num: nativeId });
        assert.deepEqual(first.features[0].geometry.coordinates,
            polygons.map(polygon => polygon.map(ring => ring.map(p => proj4('EPSG:3857', 'EPSG:4326', p)))));
        const bounds = await source.queryBounds([35.893, 56.852, 35.901, 56.856]);
        assert.equal(bounds.features.length, 1);
        assert.equal(bounds.areaComplete, false);
        assert.equal(bounds.authoritativeAbsence, false);
        await assert.rejects(source.queryIds([descriptor.idPrefix + '69:40:0000000:999']), { code: 'parcel-source-out-of-scope' });
    }
});

test('Tver relay binds the receipt endpoint, native cadastral district and explicit ID subset', () => {
    const validate = input => validateParcelProviderRelayRequest(descriptor.id, input, { sources: [descriptor] });
    const request = { url: descriptor.endpoint, method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Referer: descriptor.endpoint,
            Cookie: `csrftoken=${token}`, 'X-CSRFToken': token },
        body: JSON.stringify({ new_kadnum: nativeId, zoom: 19 }) };
    assert.equal(validate(request).target.href, descriptor.endpoint);
    assert.equal(validate({ url: descriptor.endpoint }).method, 'GET');
    assert.throws(() => validate({ ...request, url: 'https://kk.reestr54.ru/tomsk/' }));
    assert.throws(() => validate({ ...request, body: JSON.stringify({ new_kadnum: '69:40:0000000:999', zoom: 19 }) }));
    assert.throws(() => createParcelSource({ ...descriptor, endpoint: 'https://kk.reestr54.ru/tomsk/' }));
    assert.throws(() => createParcelSource({ ...descriptor, coverage: { ...descriptor.coverage, nativeIds: ['70:21:0000000:110'] } }));
});
