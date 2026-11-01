// Check Bursa's native parcel identity, safe requests and unchanged geometry in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const { descriptor, response } = JSON.parse(fs.readFileSync(new URL('./fixtures/tr-bursa-safe.json', import.meta.url)));
const rows = response.features;
const ids = rows.map(row => descriptor.idPrefix + row.properties.ID);

function provider(sourceRows = rows) {
    const calls = [];
    const fetchImpl = async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init?.body || url.search);
        calls.push(params);
        assert.equal(params.get('outFields'), 'OBJECTID,ID');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('returnGeometry'), 'true');
        assert.equal(params.has('geometryPrecision'), false);
        assert.equal(params.has('maxAllowableOffset'), false);
        const predicate = params.get('where');
        const selected = predicate === '1=1' ? sourceRows : sourceRows.filter(row =>
            predicate.match(/\d+/g).map(Number).includes(row.properties.ID));
        const offset = Number(params.get('resultOffset'));
        const limit = Number(params.get('resultRecordCount'));
        return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection',
            features: structuredClone(selected.slice(offset, offset + limit)),
            exceededTransferLimit: offset + limit < selected.length }) };
    };
    return { fetchImpl, calls };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: Bursa reads native IDs repeatably with full source polygons and safe fields`, async () => {
        const fetch = provider();
        const source = factory({ ...descriptor, pageSize: 1 }, fetch);
        const first = await source.queryIds(ids);
        const second = await factory({ ...descriptor, pageSize: 1 }, provider()).queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(row => row.id), ids);
        assert.deepEqual(first.features, second.features);
        first.features.forEach((row, index) => {
            assert.equal(row.properties.sourceParcelId, String(rows[index].properties.ID));
            assert.deepEqual(row.geometry, rows[index].geometry);
        });
        assert.deepEqual(fetch.calls.map(params => Number(params.get('resultOffset'))), [0, 1, 2]);
        const absent = await source.queryIds([descriptor.idPrefix + '2147483647']);
        assert.equal(absent.complete, true);
        assert.deepEqual(absent.features, []);
        assert.deepEqual(absent.absentIds, [descriptor.idPrefix + '2147483647']);
        const bounded = await source.queryBounds([29.0469, 40.205, 29.0471, 40.2051]);
        assert.equal(bounded.complete, true);
        assert.deepEqual(bounded.features.map(row => row.geometry), rows.map(row => row.geometry));
    });

    test(`${name}: Bursa rejects conflicting outlines for one native ID`, async () => {
        const conflict = structuredClone(rows[1]);
        conflict.properties.ID = rows[0].properties.ID;
        const source = factory({ ...descriptor, pageSize: 1 }, provider([rows[0], conflict]));
        await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
    });
}
