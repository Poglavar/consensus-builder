// Prague's municipal PARCKEY contract uses the shared backend and browser ArcGIS adapter.
// Synthetic polygons test identity, complete paging and unchanged rings without duplicating live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'cz-praha-gspub-zakladni-mapa-parcely', adapter: 'arcgis',
    endpoint: 'https://gs-pub.praha.eu/arcgis/rest/services/map/zakladni_mapa/MapServer/14',
    idField: 'PARCKEY', objectIdField: 'OBJECTID', idType: 'string',
    idPattern: '^[0-9]{16}$', idPrefix: 'CZ-PRAHA-', outFields: ['PARCKEY', 'OBJECTID'],
    pageSize: 1, queryFormat: 'geojson'
};
const geometry = {
    type: 'Polygon', coordinates: [
        [[14.44, 50.07], [14.441, 50.07], [14.441, 50.071], [14.44, 50.07]],
        [[14.4406, 50.0702], [14.4406, 50.0703], [14.4407, 50.0702], [14.4406, 50.0702]]
    ]
};
const nativeIds = ['7271642017120040', '7271642018330000'];
const ids = nativeIds.map(value => descriptor.idPrefix + value);

function provider({ conflict = false } = {}) {
    const calls = [];
    return { calls, fetchImpl: async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init?.body || url.search);
        calls.push(params);
        assert.equal(params.get('outFields'), 'PARCKEY,OBJECTID');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('returnGeometry'), 'true');
        assert.equal(params.has('geometryPrecision'), false);
        const offset = Number(params.get('resultOffset'));
        const key = nativeIds[conflict ? 0 : offset];
        return { ok: true, status: 200, json: async () => ({
            type: 'FeatureCollection', exceededTransferLimit: offset === 0,
            features: [{ type: 'Feature', properties: { PARCKEY: key, OBJECTID: 63562 + offset },
                geometry: conflict && offset ? { ...geometry, coordinates: [geometry.coordinates[0]] } : structuredClone(geometry) }]
        }) };
    } };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: Prague retains quoted native keys and full polygons across complete pages`, async () => {
        const transport = provider();
        const source = factory(descriptor, transport);
        const result = await source.queryIds(ids);
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(feature => feature.id), ids);
        for (const feature of result.features) assert.deepEqual(feature.geometry, geometry);
        assert.deepEqual(transport.calls.map(params => params.get('resultOffset')), ['0', '1']);
        for (const params of transport.calls) {
            assert.equal(params.get('where'), "PARCKEY IN ('7271642017120040','7271642018330000')");
        }
        const bounds = await source.queryBounds([14.44, 50.07, 14.441, 50.071]);
        assert.equal(bounds.complete, true);
        assert.deepEqual(bounds.features.map(feature => feature.id), ids);
        assert.equal(transport.calls.at(-1).get('inSR'), '4326');
    });

    test(`${name}: Prague fails conflicting rows instead of silently choosing a parcel version`, async () => {
        await assert.rejects(factory(descriptor, provider({ conflict: true })).queryIds(ids));
    });
}
