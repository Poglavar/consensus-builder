// Exercise daily layer resolution and stable e-gazar parcel routing in both runtime factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { resolveEgazarLayers } from '../parcels/mn-egazar-source.js';

const descriptor = {
    id: 'mn-egazar-geoware-parcels', adapter: 'wfs', layerProfile: 'mn-egazar-districts-v1',
    endpoint: 'https://geoserver.egazar.gov.mn/geoserver/geoware/ows', version: '2.0.0',
    egazarDistrictCodes: ['01119','01125'], idPrefix: 'MN-EGAZAR-', idField: 'parcel_id',
    idType: 'string', idPattern: '^[0-9]{10}$', geometryField: 'geometry', outFields: ['parcel_id'],
    requestProperties: true, responseSrid: 4326, pageSize: 1, idBatchSize: 1,
    maxFeatures: 10, maxBboxKm2: 2, maxResponseBytes: 1024 * 1024
};
const geometry = { type: 'Polygon', coordinates: [[[106.888,47.933],[106.8881,47.933],
    [106.8881,47.9331],[106.888,47.9331],[106.888,47.933]]] };
const layer = (district, date) => `geoware:geo_view_parcel_soum_egazar_${district}_${date}`;
const capabilities = date => `<WFS_Capabilities><FeatureTypeList>${['01119','01125'].flatMap(district =>
    ['2026-10-01', date].map(day => `<FeatureType><Name>${layer(district, day)}</Name></FeatureType>`)).join('')}</FeatureTypeList></WFS_Capabilities>`;
function fixture(factory, { date = '2026-11-01', missing = false, fail = false } = {}) {
    const requests = [];
    const source = factory(descriptor, { fetchImpl: async url => {
        const q = new URL(url).searchParams;
        requests.push(q);
        if (q.get('request') === 'GetCapabilities') return new Response(missing ? '<WFS_Capabilities/>' : capabilities(date));
        const name = q.get('typeNames');
        assert.ok(name.endsWith(date));
        assert.equal(q.get('propertyName'), 'geometry,parcel_id');
        assert.equal(q.get('srsName'), 'EPSG:4326');
        if (fail && name.includes('_01125_')) return new Response('', { status: 503 });
        const match = /parcel_id IN \('(\d{10})'\)/.exec(q.get('cql_filter') || '');
        const ids = match ? match[1] === '0000000000' ? [] : [match[1]] : ['1000000001','1000000002'];
        const rows = ids.slice(Number(q.get('startIndex') || 0), Number(q.get('startIndex') || 0) + Number(q.get('count')));
        return new Response(JSON.stringify({ type: 'FeatureCollection', numberMatched: ids.length,
            numberReturned: rows.length, features: rows.map(id => ({ type: 'Feature',
                id: `${name}.${id}`, properties: { parcel_id: id }, geometry })) }));
    } });
    return { source, requests };
}
for (const [name, factory] of [['backend',createWfsParcelSource],['browser',browserParcelFactories.wfs]]) {
    test(`${name}: cross-district exact IDs retain native keys, geometry, absence and stable identities across dates`, async () => {
        const ids = ['MN-EGAZAR-01125-1000000001','MN-EGAZAR-01119-1000000002','MN-EGAZAR-01125-0000000000'];
        const { source, requests } = fixture(factory);
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.deepEqual(first, second);
        assert.deepEqual(first.absentIds, [ids[2]]);
        assert.deepEqual(first.features.map(f => f.id), ids.slice(0,2));
        assert.equal(first.features[0].properties.sourceParcelId, '1000000001');
        assert.deepEqual(first.features[0].geometry, geometry);
        assert.deepEqual(first.features[0].properties.sourceProperties, { parcel_id: '1000000001' });
        assert.equal(requests.filter(q => q.get('request') === 'GetCapabilities').length, 1);
        const refreshed = await fixture(factory, { date: '2026-11-02' }).source.queryIds(ids);
        assert.deepEqual(refreshed, first);
    });
}
test('bounds page each district and preserve coincident parcels in separate namespaces', async () => {
    const { source, requests } = fixture(createWfsParcelSource);
    const result = await source.queryBounds([106.8879,47.9329,106.8882,47.9332]);
    assert.equal(result.complete,true);
    assert.equal(result.features.length,4);
    assert.equal(new Set(result.features.map(f => f.id)).size,4);
    assert.ok(result.features.every(f => JSON.stringify(f.geometry) === JSON.stringify(geometry)));
    assert.equal(requests.filter(q => q.get('startIndex') === '1').length,2);
    assert.equal((await source.queryGeometry(geometry)).features.length,4);
});
test('invalid IDs fail before requests; missing or failing districts never become complete absence', async () => {
    const { source, requests } = fixture(createWfsParcelSource);
    await assert.rejects(source.queryIds(['MN-EGAZAR-01125-1000000001','MN-EGAZAR-01122-1000000001']), { status:400 });
    assert.equal(requests.length,0);
    await assert.rejects(fixture(createWfsParcelSource,{ missing:true }).source.queryIds(['MN-EGAZAR-01125-1000000001']), /publish/);
    await assert.rejects(fixture(createWfsParcelSource,{ fail:true }).source.queryBounds([106.8879,47.9329,106.8882,47.9332]), { status:502 });
});
test('layer parser ignores unrelated and invalid-date layers and requires all configured districts', () => {
    const xml = capabilities('2026-11-01').replace('</FeatureTypeList>',`<FeatureType><Name>${layer('01125','2026-99-99')}</Name></FeatureType></FeatureTypeList>`);
    assert.equal(resolveEgazarLayers(xml,['01125']).get('01125'),layer('01125','2026-11-01'));
    assert.throws(() => resolveEgazarLayers(xml,['01122']), /publish/);
    assert.throws(() => createWfsParcelSource({...descriptor,outFields:['parcel_id','address']}), /Invalid/);
});
