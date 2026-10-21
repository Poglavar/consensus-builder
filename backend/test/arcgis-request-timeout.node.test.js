import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csggis-diepsloot.json', import.meta.url)));
const descriptor = fixture.descriptor;
const ids = fixture.response.features.map(row => descriptor.idPrefix + row.attributes.PRCL_KEY);

test('ArcGIS exact reads use the configured bounded timeout for every manifest and geometry request', async t => {
    const deadlines = [];
    const signal = new AbortController().signal;
    t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return signal; });
    for (const timeoutMs of [undefined, 45000]) {
        deadlines.length = 0;
        const source = createArcgisParcelSource({ ...descriptor, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, {
            fetchImpl: async (input, init) => {
                assert.equal(init.signal, signal);
                const params = new URL(input).searchParams;
                let data;
                if (params.get('returnCountOnly') === 'true') data = { count: ids.length };
                else if (params.get('returnIdsOnly') === 'true') data = {
                    objectIdFieldName: 'OBJECTID', objectIds: fixture.response.features.map(row => row.attributes.OBJECTID)
                };
                else {
                    assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
                    assert.equal(params.get('outSR'), '4326');
                    data = fixture.response;
                }
                return { ok: true, json: async () => structuredClone(data) };
            }
        });
        const result = await source.queryIds(ids);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(row => row.id), ids);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(deadlines, Array(3).fill(timeoutMs ?? 15000));
    }
});

test('ArcGIS rejects invalid or unbounded timeout settings before requesting parcels', () => {
    for (const timeoutMs of [null, 0, -1, 999, 45001, Infinity, NaN, '45000', 15000.5]) {
        assert.throws(() => createArcgisParcelSource({ ...descriptor, timeoutMs }), /Invalid ArcGIS/);
    }
});

test('ArcGIS reports timed-out configured requests as unavailable rather than absent', async () => {
    const source = createArcgisParcelSource({ ...descriptor, timeoutMs: 45000 }, {
        fetchImpl: async () => { throw Object.assign(new Error('Timed out'), { name: 'TimeoutError' }); }
    });
    await assert.rejects(source.queryIds(ids), error => error.status === 504 && error.code === 'parcel-source-unavailable');
});
