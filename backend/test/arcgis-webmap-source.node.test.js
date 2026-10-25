import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { createArcgisWebmapParcelSource, webmapParcelCollection } from '../parcels/arcgis-webmap-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/thika-webmap-native-safe.json', import.meta.url)));
const prefix = 'arcgis-webmap:ea580568a6d84bc7b7e33e03efd1305c/plots:fid=';
const descriptor = { id: 'ke-arcgis-thika-rim-webmap-plots', adapter: 'arcgis-webmap',
    endpoint: 'https://www.arcgis.com/sharing/rest/content/items/ea580568a6d84bc7b7e33e03efd1305c/data?f=json',
    idPrefix: prefix, idFields: ['FID'], objectIdField: 'FID', outFields: ['FID'],
    webmapLayerName: 'plots', expectedSnapshotFeatures: 6 };
const layer = payload => payload.operationalLayers[0].featureCollection.layers[0];

test('retains every native vertex and degenerate component, projecting only declared Mercator', () => {
    const collection = webmapParcelCollection(fixture, descriptor);
    assert.equal(collection.features.length, 6);
    for (const feature of collection.features) {
        const original = layer(fixture).featureSet.features.find(f => f.attributes.FID === feature.properties.FID);
        const rings = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
        assert.deepEqual(rings, original.geometry.rings.map(ring => ring.map(p => proj4('EPSG:3857', 'EPSG:4326', p))));
        assert.deepEqual(Object.keys(feature.properties), ['FID']);
    }
    assert.equal(collection.features[0].geometry.type, 'MultiPolygon');
    const ring = collection.features[0].geometry.coordinates[0][0];
    assert.equal(new Set(ring.map(p => p.join(','))).size, 2);
});

test('backend and browser factories perform bounds and stable native exact reads with explicit absence', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['arcgis-webmap']]) {
        let requests = 0;
        const adapter = factory(descriptor, { fetchImpl: async url => {
            assert.equal(url, descriptor.endpoint); requests++;
            const payload = structuredClone(fixture);
            layer(payload).featureSet.features[0].attributes.PIN = 123;
            return new Response(JSON.stringify(payload));
        } });
        const ids = [prefix + '1', prefix + '0'];
        const first = await adapter.queryIds(ids), second = await adapter.queryIds(ids);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features.map(f => f.id), ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.features[1].properties.sourceProperties, { FID: 0 });
        first.features[0].geometry.coordinates[0][0][0] = 0;
        assert.deepEqual(await adapter.queryIds(ids), second);
        const missing = await adapter.queryIds([prefix + '999999']);
        assert.deepEqual(missing.absentIds, [prefix + '999999']);
        assert.deepEqual(missing.features, []);
        const inside = await adapter.queryBounds([37.0435, -1.0497, 37.0496, -1.0404]);
        assert.equal(inside.features.length, 6);
        const centre = await adapter.queryBounds([37.09, -1.056, 37.091, -1.055]);
        assert.equal(centre.features.length, 0);
        assert.equal(requests, 1);
        await assert.rejects(adapter.queryIds(['foreign:1']), /different source/);
    }
});

test('groups Esri counterclockwise holes under their clockwise shell without reversing vertices', () => {
    const payload = structuredClone(fixture);
    const shell = [[0,0],[0,4],[4,4],[4,0],[0,0]];
    const hole = [[1,1],[2,1],[2,2],[1,2],[1,1]];
    layer(payload).featureSet.features = [{ attributes: { FID: 7 }, geometry: {
        spatialReference: { wkid: 4326 }, rings: [shell, hole] } }];
    const result = webmapParcelCollection(payload, descriptor);
    assert.deepEqual(result.features[0].geometry, { type: 'Polygon', coordinates: [shell, hole] });
    layer(payload).featureSet.features[0].geometry.rings = [hole];
    assert.throws(() => webmapParcelCollection(payload, descriptor), /no exterior/);
});

test('rejects duplicate FIDs, ambiguous layer selection, truncated collections and unknown CRS', () => {
    const duplicate = structuredClone(fixture);
    layer(duplicate).featureSet.features.push(layer(duplicate).featureSet.features[0]);
    assert.throws(() => webmapParcelCollection(duplicate, descriptor), /identity/);
    const ambiguous = structuredClone(fixture);
    ambiguous.operationalLayers[0].featureCollection.layers.push(layer(ambiguous));
    assert.throws(() => webmapParcelCollection(ambiguous, descriptor), /ambiguous/);
    const truncated = structuredClone(fixture);
    layer(truncated).featureSet.exceededTransferLimit = true;
    assert.throws(() => webmapParcelCollection(truncated, descriptor), /collection/);
    const unknown = structuredClone(fixture);
    layer(unknown).featureSet.features[0].geometry.spatialReference = { wkid: 999999 };
    assert.throws(() => webmapParcelCollection(unknown, descriptor), /spatial reference/);
});

test('enforces source byte budget before converting or retaining a partial download', async () => {
    const adapter = createArcgisWebmapParcelSource({ ...descriptor, maxSnapshotBytes: 50 }, {
        fetchImpl: async () => new Response(JSON.stringify(fixture)) });
    await assert.rejects(adapter.queryIds([prefix + '1']), /byte limit/);
});
