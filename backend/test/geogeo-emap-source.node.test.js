// Exercise fresh viewer exact reads, safe field filtering, geometry preservation and relay bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeogeoEmapSource, EMAP_ENDPOINT, isEmapParcelUrl } from '../parcels/geogeo-emap-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = { id: 'jp-niigata-emap-fixed-tax-parcels-2025', adapter: 'geogeo-emap', endpoint: EMAP_ENDPOINT,
    idPrefix: 'JP-NIIGATA-EMAP-9000000010-', idField: 'itemid', outFields: ['itemid'], layerId: '9000000010', themeId: '20' };
const geometry = { type: 'MultiPolygon', coordinates: [[[[139,37],[139.0001,37],[139.0001,37.0001],[139,37.0001],[139,37]], [[139.00002,37.00002],[139.00002,37.00003],[139.00003,37.00003],[139.00003,37.00002],[139.00002,37.00002]]], [[[139.00005,37.00012],[139.00007,37.00012],[139.00007,37.00014],[139.00005,37.00012]]]] };
const row = { itemid: 123, layerid: '9000000010', geojson: JSON.stringify(geometry), title: 'discard', fields: [{ private: 'discard' }] };
const id = descriptor.idPrefix + '123';
const html = rows => `<!doctype html><script>var initData = ${JSON.stringify({ init_mode: 'attribute', init_mid: '20', init_attr: rows })};</script>`;

test('backend and browser factories reread exact IDs through the live search URL', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['geogeo-emap']]) {
        const calls = [];
        const adapter = factory(descriptor, { fetchImpl: async url => {
            calls.push(new URL(url)); return new Response(html([row]));
        } });
        const a = await adapter.queryIds([id]), b = await adapter.queryIds([id]);
        assert.equal(calls.length, 2);
        assert.ok(calls.every(u => u.pathname === '/maps' && u.searchParams.get('mode') === 'search' && u.searchParams.get('linkkey') === '123'));
        assert.deepEqual(a, b); assert.deepEqual(a.features[0].geometry, geometry);
        assert.equal(a.features[0].properties.sourceParcelId, '123');
        assert.equal(JSON.stringify(a).includes('discard'), false);
    }
});

test('exact lookup rejects foreign IDs, malformed pages and mismatched keys; explicit empty results stay distinct', async () => {
    for (const body of [html([{ ...row, itemid: 124 }]), '<html>unavailable</html>', html([row, row])]) {
        const source = createGeogeoEmapSource(descriptor, { fetchImpl: async () => new Response(body) });
        await assert.rejects(source.queryIds([id]));
    }
    const source = createGeogeoEmapSource(descriptor, { fetchImpl: async () => new Response(html([])) });
    assert.deepEqual((await source.queryIds([id])).absentIds, [id]);
    await assert.rejects(source.queryIds(['foreign-123']));
});

test('rectangle reads tile bounded cells, remove display properties and preserve holes and parts', async () => {
    let calls = 0;
    const source = createGeogeoEmapSource(descriptor, { fetchImpl: async url => {
        calls++; const target = new URL(url);
        assert.equal(target.pathname, '/locsearch/attsbybox.json');
        assert.equal(target.searchParams.get('layerids'), '9000000010');
        return new Response(JSON.stringify([row]));
    } });
    const result = await source.queryBounds([138.9999,36.9999,139.0015,37.0002]);
    assert.equal(calls, 2); assert.equal(result.features.length, 1);
    assert.deepEqual(result.features[0].geometry, geometry);
    assert.equal(result.complete, true);
    const conflicting = createGeogeoEmapSource(descriptor, { fetchImpl: async () => new Response(JSON.stringify([row, { ...row, geojson: JSON.stringify({ ...geometry, coordinates: [[[[139,37],[139.0002,37],[139.0002,37.0001],[139,37]]]] }) }])) });
    await assert.rejects(conflicting.queryBounds([138.9999,36.9999,139.0003,37.0002]));
});

test('the relay contract pins host, layer, route, operation and safe decimal IDs', () => {
    const good = new URL('https://niigata.e-map.geogeo.jp/maps?mode=search&lid=0&mid=20&layerid=9000000010&linkkey=123');
    assert.equal(isEmapParcelUrl(descriptor, good), true);
    for (const [key, value] of [['layerid','1'],['mode','attribute'],['linkkey','123 OR 1=1'],['fields','owner']]) {
        const bad = new URL(good); bad.searchParams.set(key,value);
        assert.equal(isEmapParcelUrl(descriptor,bad),false);
    }
    const bad = new URL(good); bad.hostname = 'example.com';
    assert.equal(isEmapParcelUrl(descriptor,bad),false);
});
