// Exercise nested S-MAP WFS transport, paging and native PNU identity without changing geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'kr-seoul-smap-cadastral-lp-pa-cbnd', adapter: 'wfs',
    endpoint: 'https://smap.seoul.go.kr/imageProxy.do?svc=GEOSERVER&param=%2Fgeoserver%2Fseoul%2Fwfs',
    wfsProxyParameter: 'param', version: '1.0.0', featureType: 'seoul:lp_pa_cbnd',
    idField: 'pnu', idType: 'string', idPattern: '^[0-9]{19}$', idPrefix: 'KR-SEOUL-SMAP-PNU-',
    outFields: ['pnu'], geometryField: 'geom', requestProperties: true, pageSize: 1
};
const ids = ['1162010100117180000', '1162010100106350111'];
const geometry = { type: 'MultiPolygon', coordinates: [[[[126.945, 37.488], [126.946, 37.488],
    [126.946, 37.489], [126.945, 37.488]]]] };
const row = (pnu, index) => ({ type: 'Feature', id: `lp_pa_cbnd.${index}`, properties: { pnu }, geometry });
const response = (features, total) => ({ ok: true, status: 200, json: async () => ({
    type: 'FeatureCollection', totalFeatures: total, numberReturned: features.length, numberMatched: total,
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } }, features
}) });

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${name} nests a paged WFS query inside the fixed viewer proxy`, async () => {
        const calls = [];
        const adapter = factory(descriptor, { fetchImpl: async url => {
            calls.push(new URL(url));
            return response([row(ids[calls.length - 1], calls.length)], 2);
        } });
        const result = await adapter.queryBounds([126.944, 37.487, 126.947, 37.490]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(f => f.id), ids.map(id => descriptor.idPrefix + id));
        assert.deepEqual(result.features[0].geometry, geometry);
        assert.equal(calls.length, 2);
        for (const [index, url] of calls.entries()) {
            assert.equal(url.origin + url.pathname, 'https://smap.seoul.go.kr/imageProxy.do');
            assert.equal(url.searchParams.get('svc'), 'GEOSERVER');
            assert.deepEqual([...url.searchParams.keys()], ['svc', 'param']);
            const inner = new URL(url.searchParams.get('param'), url.origin);
            assert.equal(inner.pathname, '/geoserver/seoul/wfs');
            assert.equal(inner.searchParams.get('typeName'), 'seoul:lp_pa_cbnd');
            assert.equal(inner.searchParams.get('propertyName'), 'geom,pnu');
            assert.equal(inner.searchParams.get('startIndex'), String(index));
            assert.equal(inner.searchParams.get('maxFeatures'), '1');
            assert.equal(inner.searchParams.get('bbox'), '126.944,37.487,126.947,37.49,EPSG:4326');
        }
    });
}

test('exact reads filter the native string PNU and preserve full geometry', async () => {
    const calls = [];
    const adapter = createWfsParcelSource(descriptor, { fetchImpl: async url => {
        calls.push(new URL(new URL(url).searchParams.get('param'), 'https://smap.seoul.go.kr'));
        return response([row(ids[0], 1)], 1);
    } });
    const id = descriptor.idPrefix + ids[0];
    const result = await adapter.queryIds([id]);
    assert.equal(calls[0].searchParams.get('cql_filter'), `pnu IN ('${ids[0]}')`);
    assert.deepEqual(result.absentIds, []);
    assert.equal(result.features[0].properties.sourceParcelId, ids[0]);
    assert.deepEqual(result.features[0].geometry, geometry);
    await assert.rejects(adapter.queryIds(['KR-SEOUL-SMAP-PNU-1']), /Invalid parcel ID/);
    assert.equal(calls.length, 1);
});

test('rejects malformed proxy paths before fetching and detects repeated pages', async () => {
    for (const param of ['https://other.test/wfs', '//other.test/wfs', '/wfs?unsafe=1', '/a/../wfs']) {
        const url = new URL(descriptor.endpoint); url.searchParams.set('param', param);
        assert.throws(() => createWfsParcelSource({ ...descriptor, endpoint: url.href }), /Invalid WFS proxy/);
    }
    const adapter = createWfsParcelSource(descriptor, { fetchImpl: async () => response([row(ids[0], 1)], 2) });
    await assert.rejects(adapter.queryBounds([126.944, 37.487, 126.947, 37.490]), /repeated or omitted a feature ID/);
});
