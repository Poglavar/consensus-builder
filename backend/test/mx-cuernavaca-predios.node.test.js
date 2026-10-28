// Exercise the Cuernavaca ArcGIS profile, preserving source rings and complete OID manifests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { withSourceControls } from '../parcels/source-controls.js';

const descriptor = {
    id: 'mx-morelos-isryc-cuernavaca-predios-arcgis-28', adapter: 'arcgis',
    endpoint: 'https://geoportal.morelos.gob.mx/server/rest/services/rpp/7/MapServer/28',
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'MX-MORELOS-CUERNAVACA-PREDIOS-OBJECTID-', outFields: ['OBJECTID'],
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', queryFormat: 'esri-json',
    boundsSrid: 32614, boundsProjection: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs',
    pageSize: 200, idBatchSize: 80, maxFeatures: 10000, maxResponseBytes: 16777216
};
const ring = oid => {
    const west = -99.21 + oid * 0.000001, south = 18.90;
    return [[west, south], [west, south + 0.000001],
        [west + 0.000001, south + 0.000001], [west + 0.000001, south], [west, south]];
};
function provider(ids, { omitLast = false, curve = false, geojson = false } = {}) {
    const calls = [];
    return { calls, fetchImpl: async input => {
        const url = new URL(input), q = url.searchParams;
        calls.push(q);
        assert.equal(url.pathname, '/server/rest/services/rpp/7/MapServer/28/query');
        assert.equal(q.get('outFields'), 'OBJECTID');
        const selected = q.has('where') && q.get('where') !== '1=1'
            ? ids.filter(id => q.get('where').match(/\d+/g).map(Number).includes(id)) : ids;
        let data;
        if (q.get('returnCountOnly') === 'true') data = { count: selected.length };
        else if (q.get('returnIdsOnly') === 'true') data = { objectIdFieldName: 'OBJECTID', objectIds: selected };
        else {
            assert.equal(q.get('outSR'), '4326');
            const batch = q.get('objectIds').split(',').map(Number);
            if (omitLast) batch.pop();
            data = geojson ? { type: 'FeatureCollection', features: batch.map(id => ({
                type: 'Feature', properties: { OBJECTID: id },
                geometry: { type: 'Polygon', coordinates: [ring(id).map(p => [...p, 0, null])] }
            })) } : { geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
                features: batch.map(id => ({ attributes: { OBJECTID: id },
                    geometry: curve === true || curve === id ? { curveRings: [ring(id)] } : { rings: [ring(id)] } })) };
        }
        return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } };
}

test('backend and browser share the production factory; 1001 OIDs are all read in bounded batches', async () => {
    assert.equal(browserParcelFactories.arcgis, createArcgisParcelSource);
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    const mock = provider(ids);
    const source = createParcelSource(descriptor, { fetchImpl: mock.fetchImpl });
    const result = await source.queryBounds([-99.211, 18.899, -99.208, 18.902]);
    assert.equal(result.complete, true);
    assert.equal(result.features.length, ids.length);
    assert.equal(new Set(result.features.map(f => f.id)).size, ids.length);
    for (let i = 0; i < ids.length; i++) {
        assert.equal(result.features[i].id, descriptor.idPrefix + ids[i]);
        assert.deepEqual(result.features[i].geometry.coordinates, [ring(ids[i])]);
        assert.deepEqual(result.features[i].properties.sourceProperties, { OBJECTID: ids[i] });
    }
    assert.equal(mock.calls[0].get('inSR'), '32614');
    const pages = mock.calls.filter(q => q.has('objectIds'));
    assert.equal(pages.length, 6);
    assert.ok(pages.every(q => q.get('objectIds').split(',').length <= 200));
    assert.ok(pages.every(q => q.get('returnTrueCurves') === 'true'));
    const repeated = await source.queryIds([descriptor.idPrefix + 1, descriptor.idPrefix + 1001]);
    assert.deepEqual(repeated.features.map(f => f.geometry), [result.features[0].geometry, result.features.at(-1).geometry]);
    assert.deepEqual(repeated.absentIds, []);
});

test('incomplete OID geometry and true curves fail explicitly instead of dropping IDs or approximating curves', async () => {
    for (const options of [{ omitLast: true }, { curve: true }]) {
        const mock = provider([38210], options);
        await assert.rejects(createParcelSource(descriptor, { fetchImpl: mock.fetchImpl })
            .queryIds([descriptor.idPrefix + 38210]), /incomplete object-ID paging|Unsupported Esri parcel polygon/);
    }
});

test('the GeoJSON path preserves every returned Z/M position without local ordinate removal', async () => {
    const mock = provider([104723], { geojson: true });
    const source = createParcelSource({ ...descriptor, queryFormat: 'geojson' }, { fetchImpl: mock.fetchImpl });
    const result = await source.queryIds([descriptor.idPrefix + 104723]);
    assert.deepEqual(result.features[0].geometry.coordinates, [ring(104723).map(p => [...p, 0, null])]);
    assert.deepEqual((await source.queryIds([descriptor.idPrefix + 104723])).features, result.features);
});

test('a curved viewport fails without putting independent usable exact reads into provider cooldown', async () => {
    const mock = provider([38210, 104723], { curve: 38210 });
    const source = withSourceControls(createParcelSource(descriptor, { fetchImpl: mock.fetchImpl }));
    await assert.rejects(source.queryBounds([-99.211, 18.899, -99.208, 18.902]),
        { code: 'parcel-source-geometry-unsupported' });
    const result = await source.queryIds([descriptor.idPrefix + 104723]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features[0].geometry.coordinates, [ring(104723)]);
});
