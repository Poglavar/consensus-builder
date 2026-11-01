// Preserve Johor's leading-zero UPI keys and full source polygons in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const { descriptor, response } = JSON.parse(readFileSync(new URL('./fixtures/my-iplan-johor.json', import.meta.url)));
const ids = response.features.map(feature => descriptor.idPrefix + feature.properties.UPI);

for (const [runtime, create] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    for (const mode of ['exact', 'bounds']) {
        test(`${runtime}: Johor ${mode} reads preserve native UPI and unaltered polygons`, async () => {
            const calls = [];
            const fetchImpl = async input => {
                const url = new URL(input), params = url.searchParams;
                assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
                calls.push(params);
                let body;
                if (params.get('returnCountOnly') === 'true') body = { count: response.features.length };
                else if (params.get('returnIdsOnly') === 'true') body = {
                    objectIdFieldName: 'OBJECTID', objectIds: response.features.map(feature => feature.properties.OBJECTID)
                };
                else {
                    assert.equal(params.get('outFields'), 'OBJECTID,UPI');
                    assert.equal(params.get('outSR'), '4326');
                    assert.equal(params.has('geometryPrecision'), false);
                    const requested = params.get('objectIds').split(',').map(Number);
                    body = { type: 'FeatureCollection', features: response.features.filter(feature => requested.includes(feature.properties.OBJECTID)) };
                }
                return { ok: true, status: 200, json: async () => structuredClone(body) };
            };
            const source = await create({ ...descriptor, pageSize: 1 }, { fetchImpl });
            const read = () => mode === 'exact' ? source.queryIds(ids) : source.queryBounds([103.7558, 1.5142, 103.7561, 1.5146]);
            const first = await read(), second = await read();
            assert.equal(first.complete, true);
            assert.deepEqual(first.features.map(feature => feature.id), ids);
            assert.deepEqual(first.features.map(feature => feature.properties.sourceParcelId), response.features.map(feature => feature.properties.UPI));
            assert.deepEqual(first.features.map(feature => feature.geometry), response.features.map(feature => feature.geometry));
            assert.deepEqual(second, first);
            assert.equal(calls.filter(params => params.has('objectIds')).length, 6);
            if (mode === 'exact') {
                assert.deepEqual(first.absentIds, []);
                assert.equal(calls[0].get('where'), "UPI IN ('0102400003793','0102400003795','0102400003796')");
            } else {
                assert.equal(calls[0].get('inSR'), '4326');
                assert.equal(calls[0].get('geometry'), '103.7558,1.5142,103.7561,1.5146');
            }
        });
    }
}
