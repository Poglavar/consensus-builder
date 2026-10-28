import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-diepsloot.json', import.meta.url)));
const ids = fixture.response.features.map(row => fixture.descriptor.idPrefix + row.attributes.PRCL_KEY);

function provider(factory, { pageSize = 100, wrongCount = false, reassignedOids = false } = {}) {
    const rows = structuredClone(fixture.response.features);
    if (reassignedOids) for (const row of rows) row.attributes.OBJECTID += 10000000;
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, fixture.descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        const nativeKeys = [...params.get('where').matchAll(/'([A-Z0-9]+)'/g)].map(match => match[1]);
        const selected = nativeKeys.length ? rows.filter(row => nativeKeys.includes(row.attributes.PRCL_KEY)) : rows;
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: selected.length + Number(wrongCount) };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'OBJECTID', objectIds: selected.map(row => row.attributes.OBJECTID)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'json');
            for (const field of ['geometryPrecision', 'maxAllowableOffset', 'resultOffset']) assert.equal(params.has(field), false);
            const objectIds = params.get('objectIds').split(',').map(Number);
            assert.ok(objectIds.length <= pageSize);
            payload = { ...fixture.response, features: selected.filter(row => objectIds.includes(row.attributes.OBJECTID)),
                exceededTransferLimit: false };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    };
    return { rows, calls, source: factory({ ...fixture.descriptor, pageSize }, { fetchImpl }) };
}

test('Diepsloot backend and browser factories preserve native keys and every Esri ring coordinate across OID reassignment and one-row pages', async () => {
    const backend = provider(createParcelSource);
    const browser = provider(browserParcelFactories.arcgis, { pageSize: 1, reassignedOids: true });
    for (const source of [backend.source, browser.source]) {
        const result = await source.queryIds(ids);
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(feature => feature.id).sort(), [...ids].sort());
        for (const feature of result.features) {
            const row = fixture.response.features.find(value => fixture.descriptor.idPrefix + value.attributes.PRCL_KEY === feature.id);
            assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: row.geometry.rings });
            assert.equal(feature.properties.sourceId, fixture.descriptor.id);
            assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID', 'PRCL_KEY']);
        }
    }
    assert.equal(backend.calls.length, 3);
    assert.equal(browser.calls.length, 5);
});

test('Diepsloot count/manifest disagreement is unavailable rather than a partial success', async () => {
    const { source } = provider(createParcelSource, { wrongCount: true });
    await assert.rejects(source.queryIds(ids), /object-ID list/);
});

test('Diepsloot conflicting polygons for one native key fail without changing identity or geometry', async () => {
    const { source, rows } = provider(createParcelSource, { pageSize: 1 });
    rows[1].attributes.PRCL_KEY = rows[0].attributes.PRCL_KEY;
    await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
});
