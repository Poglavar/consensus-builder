// Exercise Skopje's safe native-ID manifest contract through both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'mk-skopje-old-bazaar-parcels', adapter: 'arcgis',
    endpoint: 'https://gisportal.skopje.gov.mk/arcgis/rest/services/OUT/StaraCarsijaWGS/FeatureServer/3',
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'MK-SK-OUT-StaraCarsijaWGS-OBJECTID-', outFields: ['OBJECTID'],
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', queryFormat: 'geojson',
    pageSize: 2, idBatchSize: 80, maxFeatures: 1000, maxBboxKm2: 25,
    timeoutMs: 30000, maxResponseBytes: 16777216
};
const parcelId = id => `${descriptor.idPrefix}${id}`;
const bounds = [21.4354, 41.9994, 21.4359, 41.9997];
// Synthetic rings are test inputs, not retained provider samples or alignment evidence.
const rows = [18, 19, 20].map((id, i) => {
    const x = 21.43545 + i * 0.0001;
    return { type: 'Feature', properties: { OBJECTID: id }, geometry: {
        type: 'Polygon', coordinates: [[[x, 41.99945], [x + 0.00005, 41.99945],
            [x + 0.00005, 41.99955], [x, 41.99955], [x, 41.99945]]]
    } };
});

function provider({ fault, coincident = false } = {}) {
    const calls = [];
    const sourceRows = structuredClone(rows);
    if (coincident) sourceRows[1].geometry = structuredClone(sourceRows[0].geometry);
    return { calls, sourceRows, fetchImpl: async input => {
        const url = new URL(input), params = url.searchParams;
        calls.push(params);
        assert.equal(url.origin + url.pathname, `${descriptor.endpoint}/query`);
        assert.equal(params.get('outFields'), 'OBJECTID');
        for (const key of ['resultOffset', 'resultRecordCount', 'orderByFields',
            'geometryPrecision', 'maxAllowableOffset']) assert.equal(params.has(key), false);
        let selected = sourceRows;
        const ids = params.get('objectIds')?.split(',').map(Number)
            ?? params.get('where')?.match(/OBJECTID IN \(([\d,]+)\)/)?.[1].split(',').map(Number);
        if (ids) selected = selected.filter(row => ids.includes(row.properties.OBJECTID));
        if (params.has('geometry')) {
            assert.equal(params.get('geometryType'), 'esriGeometryEnvelope');
            assert.equal(params.get('inSR'), '4326');
            assert.equal(params.get('spatialRel'), 'esriSpatialRelIntersects');
            const [west, south, east, north] = params.get('geometry').split(',').map(Number);
            selected = selected.filter(row => row.geometry.coordinates[0].some(([x, y]) =>
                x >= west && x <= east && y >= south && y <= north));
        }
        let payload;
        if (params.get('returnCountOnly') === 'true') {
            assert.equal(params.get('returnGeometry'), 'false');
            payload = { count: selected.length + (fault === 'count' ? 1 : 0) };
        } else if (params.get('returnIdsOnly') === 'true') {
            assert.equal(params.get('returnGeometry'), 'false');
            const objectIds = selected.map(row => row.properties.OBJECTID);
            if (fault === 'duplicate-manifest' && objectIds.length > 1) objectIds[1] = objectIds[0];
            payload = { objectIdFieldName: 'OBJECTID', objectIds: objectIds.length ? objectIds : null };
        } else {
            assert.equal(params.get('returnGeometry'), 'true');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            assert.ok(params.has('objectIds'), 'geometry must be read by manifest OBJECTIDs');
            let features = structuredClone(selected).reverse();
            if (fault === 'omitted-geometry') features.pop();
            if (fault === 'unexpected-id' && features.length) features[0].properties.OBJECTID = 999;
            payload = { type: 'FeatureCollection', features,
                properties: { exceededTransferLimit: fault === 'transfer-limit' } };
        }
        return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    } };
}

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${runtime}: Skopje bounds enumerate every OID and preserve complete geometry`, async () => {
        const transport = provider();
        const result = await factory(descriptor, transport).queryBounds(bounds);
        assert.equal(result.complete, true);
        assert.equal(result.sourceId, descriptor.id);
        assert.deepEqual(result.features.map(f => f.id).sort(), rows.map(row => parcelId(row.properties.OBJECTID)).sort());
        for (const feature of result.features) {
            const original = rows.find(row => parcelId(row.properties.OBJECTID) === feature.id);
            assert.deepEqual(feature.geometry, original.geometry);
            assert.deepEqual(feature.properties.sourceProperties, original.properties);
        }
        assert.equal(transport.calls.length, 4); // count, manifest, and two complete OID batches
        assert.equal(transport.calls[0].get('geometry'), bounds.join(','));
        assert.equal(transport.calls[1].get('geometry'), bounds.join(','));
        assert.deepEqual(transport.calls.slice(2).map(p => p.get('objectIds')), ['18,19', '20']);
    });

    test(`${runtime}: Skopje exact reads work in fresh instances and distinguish explicit absence`, async () => {
        const requested = [parcelId(20), parcelId(18), parcelId(2147483647)];
        const results = [];
        for (let i = 0; i < 2; i++) {
            const transport = provider();
            const result = await factory(descriptor, transport).queryIds(requested);
            assert.equal(result.complete, true);
            assert.deepEqual(result.absentIds, [parcelId(2147483647)]);
            assert.deepEqual(result.features.map(f => f.id).sort(), [parcelId(18), parcelId(20)]);
            assert.equal(transport.calls[0].get('where'), 'OBJECTID IN (20,18,2147483647)');
            assert.equal(transport.calls[1].get('where'), transport.calls[0].get('where'));
            for (const feature of result.features) assert.deepEqual(feature.geometry,
                rows.find(row => parcelId(row.properties.OBJECTID) === feature.id).geometry);
            results.push(result);
        }
        assert.deepEqual(results[0], results[1]);
    });

    test(`${runtime}: Skopje preserves distinct native IDs with coincident outlines`, async () => {
        const result = await factory(descriptor, provider({ coincident: true })).queryIds([parcelId(18), parcelId(19)]);
        assert.equal(result.features.length, 2);
        assert.notEqual(result.features[0].id, result.features[1].id);
        assert.deepEqual(result.features[0].geometry, result.features[1].geometry);
    });

    test(`${runtime}: an empty Skopje window is complete without downloading geometry`, async () => {
        const transport = provider();
        const result = await factory(descriptor, transport).queryBounds([21.4315, 41.9985, 21.4317, 41.9987]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features, []);
        assert.equal(transport.calls.length, 2);
    });

    for (const fault of ['count', 'duplicate-manifest', 'omitted-geometry', 'unexpected-id', 'transfer-limit']) {
        test(`${runtime}: Skopje rejects ${fault} instead of claiming completeness`, async () => {
            await assert.rejects(factory(descriptor, provider({ fault })).queryIds([parcelId(18), parcelId(19)]),
                /incomplete|invalid object-ID|repeated or omitted an object ID/);
        });
    }

    test(`${runtime}: Skopje rejects foreign or unsafe IDs before fetching`, async () => {
        const transport = provider();
        const source = factory(descriptor, transport);
        for (const id of ['foreign-18', parcelId('18 OR 1=1'), parcelId('-1')]) {
            await assert.rejects(source.queryIds([id]), /different source|Invalid parcel ID/);
        }
        assert.equal(transport.calls.length, 0);
    });
}
