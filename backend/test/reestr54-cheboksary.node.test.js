import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const nativeId = '21:01:010609:208';
const descriptor = {
    id: 'ru-chuvashia-reestr54-cheboksary-cadastral',
    endpoint: 'https://kk.reestr54.ru/chuvashskaya-respublika/',
    adapter: 'reestr54-bounded', idPrefix: 'RU-REESTR54-CHEBOKSARY-',
    idField: 'cad_num', outFields: ['cad_num'], nativeCrs: 'EPSG:3857',
    browserTransport: 'relay', capabilities: { areaEnumeration: false },
    coverage: { scope: 'explicit-native-id-subset', citywide: false, nativeIds: [nativeId] }
};

test('Cheboksary backend/browser exact reads and relay bind to its native district and endpoint', async () => {
    const token = 'a'.repeat(32);
    for (const factory of [createParcelSource, browserParcelFactories['reestr54-bounded']]) {
        let posts = 0;
        const fetchImpl = async (url, init) => {
            assert.equal(url, descriptor.endpoint);
            const { method, headers, redirect, body } = init;
            validateParcelProviderRelayRequest(descriptor.id, { url, method, headers, redirect,
                ...(body ? { body } : {}) }, { sources: [descriptor] });
            if (init.method === 'GET') return new Response('Публичная кадастровая карта', {
                headers: { 'set-cookie': `csrftoken=${token}; Path=/` }
            });
            posts++;
            assert.equal(JSON.parse(init.body).new_kadnum, nativeId);
            return new Response(JSON.stringify({ type: 'Feature', properties: { category: 36368,
                options: { cad_num: nativeId } }, geometry: { type: 'Polygon', coordinates: [[
                [5255369, 7582794], [5255416, 7582794], [5255416, 7582844], [5255369, 7582794]
            ]] } }), { headers: { 'content-type': 'application/json' } });
        };
        const source = factory(descriptor, { fetchImpl });
        const ids = [descriptor.idPrefix + nativeId];
        const first = await source.queryIds(ids);
        assert.deepEqual(await source.queryIds(ids), first);
        assert.equal(posts, 2);
        assert.equal(first.features[0].properties.sourceParcelId, nativeId);
        assert.equal(first.areaComplete, false);
        assert.equal(first.authoritativeAbsence, false);
        await assert.rejects(source.queryIds([descriptor.idPrefix + '70:21:0100050:122']));
    }
    assert.throws(() => createParcelSource({ ...descriptor, endpoint: 'https://kk.reestr54.ru/tomsk/' }));
    assert.throws(() => createParcelSource({ ...descriptor, coverage: {
        ...descriptor.coverage, nativeIds: ['70:21:0100050:122']
    } }));
});
