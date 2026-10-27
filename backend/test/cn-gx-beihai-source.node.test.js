import test from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisParcelSource, encodeArcgisCompositeId } from '../parcels/arcgis-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const nativeKey = '{8ADFFE3E-71F0-4728-A73A-9FEE9F9';
const descriptor = {
    id: 'cn-gx-tianditu-zongdi-natural-building', adapter: 'arcgis',
    endpoint: 'https://guangxi.tianditu.gov.cn/mapgxservice/rest/services/TMP/oldTM260414new/MapServer/8',
    idPrefix: 'cn-gx-tianditu-zongdi-natural-building:ZDID:',
    idFields: ['ZDID', 'OBJECTID'], idFieldTypes: { ZDID: 'string', OBJECTID: 'integer' },
    objectIdField: 'OBJECTID', outFields: ['ZDID', 'OBJECTID'], queryFormat: 'esri-json',
    boundsQueryMode: 'object-ids', idsQueryMode: 'composite-object-ids', pageSize: 1
};
const canonicalId = oid => descriptor.idPrefix + encodeArcgisCompositeId([nativeKey, oid]);
const rings = [
    [[109, 21], [109, 21.001], [109.001, 21.001], [109.001, 21], [109, 21]],
    [[109.0001, 21.0001], [109.0002, 21.0001], [109.0002, 21.0002], [109.0001, 21.0002], [109.0001, 21.0001]]
];
function provider({ key = nativeKey, ids = [1, 2], incomplete = false } = {}) {
    const calls = [];
    const fetchImpl = async url => {
        const p = new URL(url).searchParams;
        calls.push(p);
        assert.equal(p.get('where'), '1=1'); // No unindexed region-wide native-key SQL scan.
        assert.equal(p.get('f'), 'json');
        const objects = (p.get('objectIds') || '').split(',').map(Number).filter(id => ids.includes(id));
        const body = p.has('returnCountOnly') ? { count: objects.length }
            : p.has('returnIdsOnly') ? { objectIdFieldName: 'OBJECTID', objectIds: objects }
            : { geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
                features: (incomplete ? [] : objects).map(OBJECTID => ({ attributes: { ZDID: key, OBJECTID }, geometry: { rings } })) };
        assert.equal(p.get('outFields'), p.get('returnGeometry') === 'true' ? 'ZDID,OBJECTID' : 'OBJECTID');
        return new Response(JSON.stringify(body));
    };
    return { calls, fetchImpl };
}
for (const [name, factory] of [['backend', createArcgisParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: truncated ZDID collisions retain distinct record IDs and unchanged rings on cold exact reads`, async () => {
        const mock = provider();
        const source = factory(descriptor, { fetchImpl: mock.fetchImpl });
        const ids = [canonicalId(1), canonicalId(2)];
        const first = await source.queryIds(ids);
        const second = await factory(descriptor, { fetchImpl: mock.fetchImpl }).queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(f => f.id), ids);
        assert.deepEqual(second, first);
        for (const f of first.features) {
            assert.equal(f.properties.sourceProperties.ZDID, nativeKey);
            assert.deepEqual(f.geometry, { type: 'Polygon', coordinates: rings });
        }
        assert.equal(mock.calls.length, 8); // Count + manifest + two singleton geometry reads, twice.
    });
}
test('recycled OID with a changed native key, and deleted OIDs, explicitly mark the old composite ID absent', async () => {
    for (const settings of [{ key: '{DIFFERENT-NATIVE-KEY' }, { ids: [] }]) {
        const source = createArcgisParcelSource(descriptor, { fetchImpl: provider(settings).fetchImpl });
        const result = await source.queryIds([canonicalId(1)]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features, []);
        assert.deepEqual(result.absentIds, [canonicalId(1)]);
    }
});
test('incomplete OID geometry and invalid composite descriptors fail closed', async () => {
    const source = createArcgisParcelSource(descriptor, { fetchImpl: provider({ incomplete: true }).fetchImpl });
    await assert.rejects(source.queryIds([canonicalId(1)]), /incomplete object-ID/);
    assert.throws(() => createArcgisParcelSource({ ...descriptor, idFieldTypes: { ZDID: 'string', OBJECTID: 'string' } }), /Invalid ArcGIS/);
    assert.throws(() => createArcgisParcelSource({ ...descriptor, idFields: ['ZDID', 'OTHER'], idFieldTypes: { ZDID: 'string', OTHER: 'integer' } }), /Invalid ArcGIS/);
});
