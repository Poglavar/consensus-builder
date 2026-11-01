// Check Galle's safe query fields and collision-preserving identity in both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import descriptor from './fixtures/lk-galle-candidate-descriptor.json' with { type: 'json' };
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { nativeGeometryHash } from '../parcels/arcgis-source.js';

// Synthetic provider polygons exercise duplicate native keys without retaining further research samples.
const shapes = [
    { type: 'Polygon', coordinates: [[[80.212, 6.061], [80.213, 6.061], [80.213, 6.062], [80.212, 6.061]]] },
    { type: 'Polygon', coordinates: [[[80.214, 6.061], [80.215, 6.061], [80.215, 6.062], [80.214, 6.061]]] }
];
const nativeId = '810023010000100138';
const references = shapes.map(shape => descriptor.idPrefix + nativeId + '-' + nativeGeometryHash(shape));
function provider({ incomplete = false, native = nativeId } = {}) {
    let oid = 10;
    return { fetchImpl: async input => {
        const url = new URL(input), params = url.searchParams;
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        assert.ok(['OBJECTID', 'OBJECTID,pcl_pg_id2'].includes(params.get('outFields')));
        if (!params.has('geometry') && !params.has('objectIds')) {
            assert.equal(params.get('where'), `pcl_pg_id2 IN ('${native}')`);
        }
        let body;
        if (params.get('returnCountOnly') === 'true') {
            oid += 2;
            body = { count: 2 };
        } else if (params.get('returnIdsOnly') === 'true') {
            body = { objectIdFieldName: 'OBJECTID', objectIds: incomplete ? [oid] : [oid, oid + 1] };
        } else {
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('objectIds'), `${oid},${oid + 1}`);
            body = { type: 'FeatureCollection', features: shapes.map((geometry, index) => ({
                type: 'Feature', geometry, properties: { OBJECTID: oid + index, pcl_pg_id2: native }
            })) };
        }
        return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    } };
}
for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${runtime}: Galle keeps distinct outlines for a repeated parcel number and survives OID reassignment`, async () => {
        const source = factory(descriptor, provider());
        const bounds = await source.queryBounds([80.211, 6.060, 80.216, 6.063]);
        assert.deepEqual(bounds.features.map(row => row.id), references);
        assert.deepEqual(bounds.features.map(row => row.geometry), shapes);
        const first = await source.queryIds([references[0]]);
        const second = await source.queryIds([references[0]]);
        for (const result of [first, second]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.absentIds, []);
            assert.deepEqual(result.features.map(row => row.id), [references[0]]);
            assert.deepEqual(result.features[0].geometry, shapes[0]);
            assert.equal(result.features[0].properties.sourceNativeParcelId, nativeId);
            assert.deepEqual(Object.keys(result.features[0].properties.sourceProperties).sort(), ['OBJECTID', 'pcl_pg_id2']);
        }
        assert.notEqual(first.features[0].properties.sourceProperties.OBJECTID, second.features[0].properties.sourceProperties.OBJECTID);
    });
    test(`${runtime}: Galle preserves variable text keys without numeric rewriting`, async () => {
        const native = '81/0023/01/0138';
        const source = factory(descriptor, provider({ native }));
        const id = descriptor.idPrefix + native + '-' + nativeGeometryHash(shapes[0]);
        const read = await source.queryIds([id]);
        assert.deepEqual(read.features.map(row => row.id), [id]);
        assert.equal(read.features[0].properties.sourceNativeParcelId, native);
        assert.deepEqual(read.features[0].geometry, shapes[0]);
    });
    test(`${runtime}: Galle rejects a partial manifest`, async () => {
        await assert.rejects(factory(descriptor, provider({ incomplete: true })).queryIds([references[0]]), /incomplete or invalid object-ID list/);
    });
}
