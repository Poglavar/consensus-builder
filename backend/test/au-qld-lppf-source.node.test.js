// Protect Queensland lot identity and city/type scope in both registered runtime factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { nativeGeometryHash } from '../parcels/arcgis-source.js';

const descriptor = {
    id: 'au-qld-lppf-base-parcels', adapter: 'arcgis',
    endpoint: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/8',
    idPrefix: 'au-qld-lppf-base-parcels:lotplan:', idField: 'lotplan', idType: 'string',
    objectIdField: 'objectid', parcelNumberField: 'lotplan',
    outFields: ['objectid', 'lotplan', 'cover_typ', 'parcel_typ', 'shire_name'],
    attributeFilters: { cover_typ: 'Base', parcel_typ: 'Lot Type Parcel', shire_name: 'Brisbane City' },
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', queryFormat: 'geojson',
    objectIdManifestCheck: 'id-rows',
    identityKind: 'native-key-geometry-sha256-v1',
    pageSize: 500, idBatchSize: 40, maxFeatures: 4000, maxBboxKm2: 4, maxResponseBytes: 16777216
};
const native = 'ASP12345'; // Letter-valued lots must remain valid native keys.
const geometry = {
    type: 'Polygon',
    coordinates: [[[153.039123456789, -27.4891], [153.0393, -27.4891],
        [153.0393, -27.4893], [153.039123456789, -27.4891]]]
};
const otherGeometry = { type: 'Polygon', coordinates: geometry.coordinates.map(ring =>
    ring.map(([longitude, latitude]) => [longitude + 0.001, latitude])) };
const id = `${descriptor.idPrefix}${native}-${nativeGeometryHash(geometry)}`;

function provider({ properties = {}, incomplete = false } = {}) {
    const calls = [];
    let objectId = 100;
    return { calls, fetchImpl: async input => {
        const params = new URL(input).searchParams;
        calls.push(params);
        const where = params.get('where');
        for (const clause of ["cover_typ = 'Base'", "parcel_typ = 'Lot Type Parcel'", "shire_name = 'Brisbane City'"]) {
            assert.ok(where.includes(clause), `missing fixed scope: ${clause}`);
        }
        let payload;
        assert.notEqual(params.get('returnCountOnly'), 'true', 'Queensland count-only undercounts the live window');
        if (params.get('returnGeometry') === 'false' && params.get('returnIdsOnly') !== 'true') {
            objectId += 2; // Simulate nightly transport-ID reassignment between independent reads.
            assert.equal(params.get('outFields'), 'objectid');
            payload = { features: [objectId, objectId + 1].map(value => ({ attributes: { objectid: value } })),
                exceededTransferLimit: false };
        } else if (params.get('returnIdsOnly') === 'true') {
            payload = { objectIdFieldName: 'objectid', objectIds: incomplete ? [] : [objectId, objectId + 1] };
        } else {
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('outFields'), descriptor.outFields.join(','));
            assert.equal(params.get('objectIds'), `${objectId},${objectId + 1}`);
            payload = { type: 'FeatureCollection', features: [geometry, otherGeometry].map((shape, index) =>
                ({ type: 'Feature', geometry: shape,
                    properties: { objectid: objectId + index, lotplan: native, cover_typ: 'Base',
                        parcel_typ: 'Lot Type Parcel', shire_name: 'Brisbane City', ...properties } })) };
        }
        return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    } };
}

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${runtime}: duplicate lot keys retain distinct full polygons across transport-ID changes`, async () => {
        const mock = provider(), source = factory(descriptor, mock);
        const bounds = await source.queryBounds([153.039, -27.4894, 153.0394, -27.489]);
        const first = await source.queryIds([id]);
        const second = await source.queryIds([id]);
        assert.equal(bounds.features.length, 2);
        assert.notEqual(bounds.features[0].id, bounds.features[1].id);
        assert.deepEqual(bounds.features[1].geometry, otherGeometry);
        for (const result of [first, second]) {
            assert.equal(result.complete, true);
            assert.equal(result.features.length, 1);
            assert.equal(result.features[0].id, id);
            assert.deepEqual(result.features[0].geometry, geometry);
        }
        assert.notEqual(first.features[0].properties.sourceProperties.objectid,
            second.features[0].properties.sourceProperties.objectid);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(second.absentIds, []);
        assert.ok(mock.calls.some(params => params.get('where').includes("lotplan IN ('ASP12345')")));
    });

    test(`${runtime}: rejects ignored type/city predicates and missing native keys`, async () => {
        for (const properties of [{ parcel_typ: 'Road Type Parcel', lotplan: null },
            { shire_name: 'Ipswich City' }, { lotplan: null }]) {
            const source = factory(descriptor, provider({ properties }));
            await assert.rejects(source.queryIds([id]), /outside the configured ground status|missing or invalid native parcel ID/);
        }
    });

    test(`${runtime}: an incomplete OID manifest cannot become a complete parcel result`, async () => {
        const source = factory(descriptor, provider({ incomplete: true }));
        await assert.rejects(source.queryIds([id]), /incomplete or invalid object-ID list/);
    });
}
