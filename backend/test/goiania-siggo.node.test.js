// Exercise the municipal SIGGO contract through both production ArcGIS factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/br-goiania-siggo-safe.json', import.meta.url)));
const descriptor = fixture.descriptor;
const nativeIds = fixture.response.features.map(row => row.properties.OBJECTID);
const ids = nativeIds.map(id => descriptor.idPrefix + id);

function provider({ incomplete = false } = {}) {
    const calls = [];
    return { calls, fetchImpl: async input => {
        const url = new URL(input), params = url.searchParams;
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: nativeIds.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'OBJECTID', objectIds: incomplete ? nativeIds.slice(1) : nativeIds
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.has('resultOffset'), false);
            const requested = params.get('objectIds').split(',').map(Number);
            payload = { ...fixture.response, features: fixture.response.features.filter(row => requested.includes(row.properties.OBJECTID)) };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    } };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: SIGGO exact reads preserve native OIDs and every polygon coordinate`, async () => {
        const mock = provider();
        const adapter = factory(descriptor, { fetchImpl: mock.fetchImpl });
        const first = await adapter.queryIds(ids), second = await adapter.queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(row => row.id), ids);
        assert.deepEqual(first.features.map(row => row.geometry), fixture.response.features.map(row => row.geometry));
        assert.deepEqual(second, first);
        assert.equal(mock.calls.length, 6);
    });

    test(`${name}: SIGGO bounds use native UTM envelopes and retain full source polygons`, async () => {
        const mock = provider();
        const adapter = factory(descriptor, { fetchImpl: mock.fetchImpl });
        const result = await adapter.queryBounds([-49.2912, -16.709, -49.2818, -16.6999]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(row => row.geometry), fixture.response.features.map(row => row.geometry));
        for (const params of mock.calls.slice(0, 2)) {
            assert.equal(params.get('inSR'), '31982');
            const bbox = params.get('geometry').split(',').map(Number);
            assert.ok(bbox[0] > 681000 && bbox[2] < 684000);
            assert.ok(bbox[1] > 8150000 && bbox[3] < 8154000);
        }
    });

    test(`${name}: SIGGO incomplete OID manifests fail instead of implying absence`, async () => {
        const mock = provider({ incomplete: true });
        const adapter = factory(descriptor, { fetchImpl: mock.fetchImpl });
        await assert.rejects(adapter.queryIds(ids), /incomplete or invalid object-ID list/);
        assert.equal(mock.calls.length, 2);
    });
}
