// OPAMSS uses native string parcel codes and a discovery-bound /query endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'SV-OPAMSS-SAN-SALVADOR-PLANIMETRIA-31', adapter: 'arcgis',
    endpoint: 'https://geovisor.opamss.org.sv/server/rest/services/Geo_OPAMSS_Planimetria/MapServer/31/query',
    idField: 'cod_parcel', idType: 'string', idPattern: '^[0-9]{12,16}$',
    objectIdField: 'objectid', idPrefix: 'SV-OPAMSS-SAN-SALVADOR-cod_parcel:',
    outFields: ['objectid', 'cod_parcel'], queryFormat: 'geojson',
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    pageSize: 1, maxFeatures: 100, maxResponseBytes: 16777216
};
// Synthetic geometry: no additional provider parcel samples retained by this test.
const geometry = { type: 'Polygon', coordinates: [[[-89.17, 13.707], [-89.1699, 13.707],
    [-89.1699, 13.7071], [-89.17, 13.7071], [-89.17, 13.707]]] };
function provider(factory, { incomplete = false } = {}) {
    const rows = [{ type: 'Feature', properties: { objectid: 17, cod_parcel: '061403940028' }, geometry }];
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint);
        assert.ok(['objectid', 'objectid,cod_parcel'].includes(params.get('outFields')));
        assert.equal(params.has('geometryPrecision'), false);
        assert.equal(params.has('maxAllowableOffset'), false);
        calls.push(params);
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: rows.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'objectid', objectIds: incomplete ? [] : rows.map(row => row.properties.objectid)
        };
        else {
            assert.equal(params.get('outFields'), 'objectid,cod_parcel');
            assert.equal(params.get('f'), 'geojson');
            assert.equal(params.get('outSR'), '4326');
            const ids = params.get('objectIds').split(',').map(Number);
            payload = { type: 'FeatureCollection', features: rows.filter(row => ids.includes(row.properties.objectid)) };
        }
        return new Response(JSON.stringify(payload), { status: 200 });
    };
    return { source: factory(descriptor, { fetchImpl }), rows, calls };
}

for (const [label, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${label} OPAMSS exact reads preserve leading zeros and geometry after object ID reassignment`, async () => {
        const { source, rows, calls } = provider(factory);
        const id = descriptor.idPrefix + rows[0].properties.cod_parcel;
        const first = await source.queryIds([id]);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(row => [row.id, row.geometry]), [[id, geometry]]);
        assert.equal(first.features[0].properties.sourceParcelId, '061403940028');
        assert.deepEqual(Object.keys(first.features[0].properties.sourceProperties).sort(), ['cod_parcel', 'objectid']);
        assert.equal(calls[0].get('where'), "cod_parcel IN ('061403940028')");
        rows[0].properties.objectid = 901;
        const second = await source.queryIds([id]);
        assert.deepEqual(second.features.map(row => [row.id, row.geometry]), [[id, geometry]]);
    });

    test(`${label} OPAMSS bounds require a count-matched object manifest`, async () => {
        const { source, calls } = provider(factory);
        const bounds = [-89.1701, 13.7069, -89.1698, 13.7072];
        const read = await source.queryBounds(bounds);
        assert.equal(read.complete, true);
        assert.deepEqual(read.features.map(row => row.geometry), [geometry]);
        assert.equal(calls[0].get('geometry'), bounds.join(','));
        assert.equal(calls[0].get('inSR'), '4326');
        await assert.rejects(provider(factory, { incomplete: true }).source.queryBounds(bounds), /object-ID list/);
    });
}
