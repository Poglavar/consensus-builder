// Verify Podolsk live-reader wiring, projection and city-isolated anonymous relay requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { isReestr54Source } from '../parcels/reestr54-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const nativeId = '50:55:0030204:4';
const descriptor = { id: 'ru-mosobl-reestr54-cadastral', endpoint: 'https://kk.reestr54.ru/moskovskaya-oblast/',
    adapter: 'reestr54-bounded', idPrefix: 'RU-REESTR54-PODOLSK-', idField: 'cad_num', outFields: ['cad_num'],
    nativeCrs: 'EPSG:3857', browserTransport: 'relay', capabilities: { areaEnumeration: false },
    coverage: { scope: 'explicit-native-id-subset', citywide: false, nativeIds: [nativeId] } };
const token = 'a'.repeat(32);
const ring = [[4180000, 7446800], [4180100, 7446800], [4180100, 7446900], [4180000, 7446900], [4180000, 7446800]];

test('Podolsk backend and browser read exact native IDs repeatedly with vertexwise conversion', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['reestr54-bounded']]) {
        let reads = 0;
        const fetchImpl = async (url, options) => {
            assert.equal(url, descriptor.endpoint);
            if (options.method === 'GET') return new Response('Публичная кадастровая карта', {
                headers: { 'Set-Cookie': `csrftoken=${token}; Path=/` } });
            reads++;
            assert.equal(options.headers.Referer, descriptor.endpoint);
            assert.deepEqual(JSON.parse(options.body), { new_kadnum: nativeId, zoom: 19 });
            return new Response(JSON.stringify({ type: 'Feature', properties: { category: 36368,
                options: { cad_num: nativeId, discarded: 'synthetic unselected field' } },
                geometry: { type: 'Polygon', coordinates: [ring] } }), { headers: { 'Content-Type': 'application/json' } });
        };
        const source = factory(descriptor, { fetchImpl });
        const ids = [descriptor.idPrefix + nativeId];
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.deepEqual(first, second);
        assert.equal(reads, 2);
        assert.equal(first.features[0].id, ids[0]);
        assert.deepEqual(first.features[0].geometry.coordinates, [ring.map(p => proj4('EPSG:3857', 'EPSG:4326', p))]);
        assert.deepEqual(first.features[0].properties.sourceProperties, { cad_num: nativeId });
        assert.equal(first.areaComplete, false);
        assert.equal(first.authoritativeAbsence, false);
        await assert.rejects(source.queryIds(['RU-REESTR54-BARNAUL-22:63:050814:79']));
        assert.equal(reads, 2);
    }
});

test('Podolsk relay pins source, route, same-page referer and native ID scope', () => {
    const request = { url: descriptor.endpoint, method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Referer: descriptor.endpoint,
            Cookie: `csrftoken=${token}`, 'X-CSRFToken': token },
        body: JSON.stringify({ new_kadnum: nativeId, zoom: 19 }) };
    const validate = value => validateParcelProviderRelayRequest(descriptor.id, value, { sources: [descriptor] });
    assert.equal(validate(request).target.href, descriptor.endpoint);
    assert.equal(validate({ url: descriptor.endpoint }).method, 'GET');
    for (const endpoint of ['https://kk.reestr54.ru/barnaul/', 'https://example.org/podolsk/']) {
        assert.equal(isReestr54Source({ ...descriptor, endpoint }), false);
        assert.throws(() => validate({ ...request, url: endpoint }));
        assert.throws(() => validate({ ...request, headers: { ...request.headers, Referer: endpoint } }));
    }
    assert.throws(() => validate({ ...request, body: JSON.stringify({ new_kadnum: '50:55:0000000:999', zoom: 19 }) }));
    assert.throws(() => createParcelSource({ ...descriptor, coverage: { ...descriptor.coverage, nativeIds: ['22:63:050814:79'] } }));
});
