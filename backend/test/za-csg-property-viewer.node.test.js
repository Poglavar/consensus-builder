// Verifies full-geometry references and complete exact reads for repeated CSG native keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource, nativeGeometryHash, NATIVE_GEOMETRY_IDENTITY_KIND } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-property-viewer.json', import.meta.url)));
const descriptor = {
    adapter: 'arcgis', id: 'za-csg-property-viewer-erven',
    endpoint: 'https://csggis.dlrrd.gov.za/server/rest/services/Property_Viewer/MapServer/2',
    idPrefix: 'ZA-CSG-PV-ERVEN-', idField: 'PRCL_KEY', objectIdField: 'OBJECTID',
    idType: 'string', idPattern: '^[A-Z0-9]{26}$', identityKind: NATIVE_GEOMETRY_IDENTITY_KIND,
    outFields: ['OBJECTID', 'PRCL_KEY'], queryFormat: 'geojson', boundsQueryMode: 'object-ids',
    idsQueryMode: 'object-ids', pageSize: 1, maxFeatures: 2000, maxBboxKm2: 2
};

function provider({ incomplete = false, ignoreWhere = false } = {}) {
    const rows = structuredClone(fixture.response.features), calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        const keys = [...(params.get('where') || '').matchAll(/'([A-Z0-9]+)'/g)].map(match => match[1]);
        const selectedRows = keys.length && !ignoreWhere ? rows.filter(row => keys.includes(row.properties.PRCL_KEY)) : rows;
        let data;
        if (params.get('returnCountOnly') === 'true') data = { count: selectedRows.length + (incomplete ? 1 : 0) };
        else if (params.get('returnIdsOnly') === 'true') data = {
            objectIdFieldName: 'OBJECTID', objectIds: selectedRows.map(row => row.properties.OBJECTID)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            assert.equal(params.has('geometryPrecision'), false);
            assert.equal(params.has('resultOffset'), false);
            const objects = params.get('objectIds').split(',').map(Number);
            data = { ...fixture.response, features: rows.filter(row => objects.includes(row.properties.OBJECTID)) };
        }
        return { ok: true, status: 200, json: async () => structuredClone(data) };
    };
    return { rows, calls, source: createArcgisParcelSource(descriptor, { fetchImpl }) };
}

test('repeated PRCL_KEY polygons retain distinct full-geometry hashes matching discovery', async () => {
    const { source, calls, rows } = provider();
    const result = await source.queryBounds([25.565, -33.854, 25.569, -33.85]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(f => f.id), fixture.expectedIds);
    assert.equal(new Set(rows.map(f => f.properties.PRCL_KEY)).size, 2);
    assert.equal(new Set(result.features.map(f => f.id)).size, 3);
    assert.equal(calls.length, 5);
    for (let i = 0; i < rows.length; i++) {
        assert.deepEqual(result.features[i].geometry, rows[i].geometry);
        assert.equal(result.features[i].properties.sourceNativeParcelId, rows[i].properties.PRCL_KEY);
        assert.equal(result.features[i].properties.sourceParcelId, fixture.expectedIds[i].slice(descriptor.idPrefix.length));
        assert.equal(result.features[i].properties.parcelIdentityKind, NATIVE_GEOMETRY_IDENTITY_KIND);
    }
});

test('independent exact reads survive transport OID reassignment and select one sibling precisely', async () => {
    const { source, rows, calls } = provider();
    const requested = [fixture.expectedIds[1]];
    const first = await source.queryIds(requested);
    assert.deepEqual(first.features.map(f => f.id), requested);
    assert.deepEqual(first.absentIds, []);
    for (const row of rows) row.properties.OBJECTID += 200;
    const second = await source.queryIds(requested);
    assert.deepEqual(second.features, first.features.map(f => ({ ...f, properties: {
        ...f.properties, sourceProperties: { ...f.properties.sourceProperties, OBJECTID: f.properties.sourceProperties.OBJECTID + 200 }
    } })));
    assert.equal(calls[0].get('where'), `PRCL_KEY IN ('${rows[1].properties.PRCL_KEY}')`);
    assert.equal(second.complete, true);
});

test('a changed vertex becomes explicit absence for the old full-geometry reference', async () => {
    const { source, rows } = provider();
    rows[1].geometry.coordinates[0][1][0] += 1e-12;
    const result = await source.queryIds([fixture.expectedIds[1]]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [fixture.expectedIds[1]]);
});

test('full geometry hashing preserves precision, ring order and polygon type', () => {
    const geometry = fixture.response.features[1].geometry;
    assert.equal(nativeGeometryHash(geometry), nativeGeometryHash({ coordinates: geometry.coordinates, type: geometry.type }));
    const reversed = structuredClone(geometry);
    reversed.coordinates[0].reverse();
    assert.notEqual(nativeGeometryHash(reversed), nativeGeometryHash(geometry));
    assert.notEqual(nativeGeometryHash({ type: 'MultiPolygon', coordinates: [geometry.coordinates] }), nativeGeometryHash(geometry));
});

test('incomplete manifests and foreign native keys fail instead of producing false absence', async () => {
    const incomplete = provider({ incomplete: true });
    await assert.rejects(incomplete.source.queryIds([fixture.expectedIds[0]]), /object-ID list/);
    const foreign = provider({ ignoreWhere: true });
    foreign.rows[0].properties.PRCL_KEY = 'XXXXXXXXXXXXXXXXXXXXXXXXXX';
    await assert.rejects(foreign.source.queryIds(fixture.expectedIds), /unexpected native parcels/);
});

test('malformed references fail before network I/O and unsafe identity modes are rejected', async () => {
    const { source, calls } = provider();
    for (const bad of ['OTHER-1', descriptor.idPrefix + 'bad', descriptor.idPrefix + "x' OR 1=1-" + 'a'.repeat(64)]) {
        await assert.rejects(source.queryIds([bad]), /Invalid|different source/);
    }
    assert.equal(calls.length, 0);
    // Esri JSON became a supported native-key geometry format in 90dc8d45a (South Australia uses it).
    for (const extra of [{ queryFormat: 'pbf' }, { nativeGeometryMode: 'parts' }, { boundsQueryMode: 'offset' }, { overlapResolution: 'derived-ground-v1' }]) {
        assert.throws(() => createArcgisParcelSource({ ...descriptor, ...extra }), /Invalid ArcGIS/);
    }
});
