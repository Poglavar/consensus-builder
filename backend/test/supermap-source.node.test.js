// Exercise SuperMap safe query payloads, paging, identity and complete REGION topology.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupermapParcelSource, supermapRegionGeometry } from '../parcels/supermap-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = { id: 'cn-jinan-nrp-zd0824-dj', adapter: 'supermap-map', idPrefix: 'CN-JINAN-ZD-',
    endpoint: 'https://nrp.jinan.gov.cn/queryResults.json?returnContent=true', layer: 'ZD0824_Project@地籍数据',
    idField: 'BDCDYH', outFields: ['BDCDYH'], pageSize: 1 };
const ring = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
function region(rings, partTopo) { return { type: 'REGION', parts: rings.map(r => r.length), partTopo,
    points: rings.flat().map(([x, y]) => ({ x, y })) }; }
const row = (id, geometry = region([ring(117, 36, 0.001)], [1])) => ({ ID: id.charCodeAt(0), fieldNames: ['BDCDYH'], fieldValues: [id], geometry });
const reply = (features, totalCount = features.length) => new Response(JSON.stringify({ totalCount,
    currentCount: features.length, recordsets: [{ features }] }));

test('REGION keeps disconnected shells, holes and nested islands without changing point sequences', () => {
    const rings = [ring(117, 36, 0.01), ring(117.002, 36.002, 0.006), ring(117.003, 36.003, 0.001), ring(117.02, 36, 0.002)];
    assert.deepEqual(supermapRegionGeometry(region(rings, [1, -1, 1, 1])), {
        type: 'MultiPolygon', coordinates: [[rings[0], rings[1]], [rings[2]], [rings[3]]] });
    assert.throws(() => supermapRegionGeometry(region(rings, [1, 0, 1, 1])), /topology/);
    assert.throws(() => supermapRegionGeometry(region([rings[0], rings[3]], [1, -1])), /containing island/);
    const invalid = region([rings[0]], [1]); invalid.parts = [4];
    assert.throws(() => supermapRegionGeometry(invalid), /topology/);
});

test('backend and browser factories page exact IDs with only BDCDYH', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['supermap-map']]) {
        const bodies = [];
        const adapter = factory(descriptor, { fetchImpl: async (_url, init) => {
            const body = JSON.parse(init.body); bodies.push(body);
            assert.equal(init.method, 'POST'); assert.equal(body.queryMode, 'SqlQuery');
            const next = bodies.length === 2;
            assert.deepEqual(body.queryParameters.queryParams, [{ name: descriptor.layer, fields: ['BDCDYH'], orderBy: 'SMID ASC',
                attributeFilter: "BDCDYH IN ('A','B')" + (next ? ' AND SMID > 65' : '') }]);
            return reply([row(next ? 'B' : 'A')], next ? 1 : 2);
        } });
        const response = await adapter.queryIds(['CN-JINAN-ZD-A', 'CN-JINAN-ZD-B']);
        assert.equal(response.complete, true); assert.deepEqual(response.absentIds, []);
        assert.deepEqual(bodies.map(b => b.queryParameters.startRecord), [0, 0]);
        assert.deepEqual(response.features.map(f => f.id), ['CN-JINAN-ZD-A', 'CN-JINAN-ZD-B']);
        await assert.rejects(adapter.queryIds(["CN-JINAN-ZD-A' OR 1=1"]), /Invalid/);
    }
});

test('bounds uses REGION and keeps whole polygons; exact absence is explicit', async () => {
    const adapter = createSupermapParcelSource(descriptor, { fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.queryMode === 'SqlQuery') return reply([]);
        assert.equal(body.spatialQueryMode, 'INTERSECT');
        assert.deepEqual(body.geometry.parts, [5]);
        assert.deepEqual(body.queryParameters.queryParams[0].fields, ['BDCDYH']);
        return reply([row('A')]);
    } });
    const response = await adapter.queryBounds([117, 36, 117.0005, 36.0005]);
    assert.deepEqual(response.features[0].geometry.coordinates[0], ring(117, 36, 0.001));
    assert.deepEqual((await adapter.queryIds(['CN-JINAN-ZD-MISSING'])).absentIds, ['CN-JINAN-ZD-MISSING']);
});

test('rejects ignored projection, conflicting IDs, repeated pages and missing topology', async () => {
    for (const features of [
        [{ ...row('A'), fieldNames: ['BDCDYH', 'OTHER'], fieldValues: ['A', 'x'] }],
        [row('A'), { ...row('A', region([ring(117.01, 36, 0.001)], [1])), ID: 66 }],
        [row('B')],
        [row('A', { ...region([ring(117, 36, 0.001)], [1]), partTopo: null })]
    ]) {
        const adapter = createSupermapParcelSource({ ...descriptor, pageSize: 10 }, { fetchImpl: async () => reply(features) });
        await assert.rejects(adapter.queryIds(['CN-JINAN-ZD-A']));
    }
    const adapter = createSupermapParcelSource(descriptor, { fetchImpl: async () => reply([row('A')], 2) });
    await assert.rejects(adapter.queryIds(['CN-JINAN-ZD-A']), /paging/);
});
