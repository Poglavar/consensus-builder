// Exercises Niš public parcel identity, safe requests and paging through both runtime factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'rs-nis-gis-smartportal-public-parcels', adapter: 'arcgis',
    endpoint: 'https://gis.ni.rs/server/rest/services/Nis_SmartPortal/MapServer/2',
    idField: 'gis_id', idType: 'string', idPattern: '^[0-9]{6}-[0-9]+(?:/[0-9]+)?$',
    objectIdField: 'objectid', idPrefix: 'RS-NIS-', parcelNumberField: 'broj_parcele',
    outFields: ['objectid', 'gis_id', 'broj_parcele'],
    pageSize: 2, maxFeatures: 10000, maxBboxKm2: 25, timeoutMs: 30000
};
// Synthetic polygons keep this regression independent of saved research data or a live server.
const rows = ['729787-5237/17', '729787-5376/2', '729787-04800'].map((id, index) => ({
    type: 'Feature', id: index + 100,
    properties: { objectid: index + 100, gis_id: id, broj_parcele: id.split('-')[1] },
    geometry: { type: 'Polygon', coordinates: [[[21.91 + index / 1000, 43.32],
        [21.9101 + index / 1000, 43.32], [21.9101 + index / 1000, 43.3201],
        [21.91 + index / 1000, 43.3201], [21.91 + index / 1000, 43.32]]] }
}));
const ids = rows.map(row => descriptor.idPrefix + row.properties.gis_id);
const absentId = 'RS-NIS-729787-999999999';
const bounds = [21.909, 43.319, 21.914, 43.322];
const response = (features, exceededTransferLimit = false) => ({
    ok: true, status: 200,
    json: async () => ({ type: 'FeatureCollection', features: structuredClone(features), exceededTransferLimit })
});

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${runtime}: Niš pages safe native IDs and repeats exact reads without a viewport cache`, async () => {
        const calls = [];
        const fetchImpl = async input => {
            const url = new URL(input);
            assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
            const params = url.searchParams;
            calls.push(params);
            assert.equal(params.get('outFields'), 'objectid,gis_id,broj_parcele');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('returnGeometry'), 'true');
            assert.equal(params.get('orderByFields'), 'objectid');
            assert.equal(params.get('f'), 'geojson');
            assert.equal(params.get('resultRecordCount'), '2');
            const spatial = params.has('geometry');
            if (spatial) {
                assert.equal(params.get('geometry'), bounds.join(','));
                assert.equal(params.get('inSR'), '4326');
                assert.equal(params.get('where'), '1=1');
            } else {
                assert.equal(params.get('where'), "gis_id IN ('729787-5237/17','729787-5376/2','729787-04800','729787-999999999')");
                assert.equal(params.has('geometryType'), false);
            }
            const offset = Number(params.get('resultOffset'));
            return response(rows.slice(offset, offset + 2), offset === 0);
        };
        const viewport = await factory(descriptor, { fetchImpl }).queryBounds(bounds);
        assert.equal(viewport.complete, true);
        assert.deepEqual(viewport.features.map(row => row.id), ids);
        assert.deepEqual(viewport.features.map(row => row.geometry), rows.map(row => row.geometry));
        assert.deepEqual(viewport.features.map(row => row.properties.parcelNumber), rows.map(row => row.properties.broj_parcele));
        for (let repeat = 0; repeat < 2; repeat++) {
            // A fresh factory cannot resolve these IDs from the earlier viewport result.
            const exact = await factory(descriptor, { fetchImpl }).queryIds([...ids, absentId]);
            assert.equal(exact.complete, true);
            assert.deepEqual(exact.features, viewport.features);
            assert.deepEqual(exact.absentIds, [absentId]);
        }
        assert.deepEqual(calls.map(params => params.get('resultOffset')), ['0', '2', '0', '2', '0', '2']);
    });

    test(`${runtime}: Niš rejects malformed or foreign IDs before any provider call`, async () => {
        let calls = 0;
        const source = factory(descriptor, { fetchImpl: async () => { calls++; throw new Error('Unexpected fetch'); } });
        for (const id of ['RS-OTHER-729787-4800', "RS-NIS-729787-4800' OR 1=1", 'RS-NIS-4800']) {
            await assert.rejects(source.queryIds([ids[0], id]), /ID/i);
        }
        assert.equal(calls, 0);
    });

    test(`${runtime}: Niš fails on repeated paging and conflicting native geometry`, async () => {
        const repeated = factory(descriptor, { fetchImpl: async () => response(rows.slice(0, 2), true) });
        await assert.rejects(repeated.queryBounds(bounds), /repeated or omitted an object ID/);
        const conflict = structuredClone(rows[1]);
        conflict.properties.gis_id = rows[0].properties.gis_id;
        const conflicting = factory(descriptor, { fetchImpl: async () => response([rows[0], conflict]) });
        await assert.rejects(conflicting.queryIds([ids[0]]), /conflicting geometry/);
        const unexpected = factory(descriptor, { fetchImpl: async () => response([rows[1]]) });
        await assert.rejects(unexpected.queryIds([ids[0]]), /unexpected parcels/);
    });
}
