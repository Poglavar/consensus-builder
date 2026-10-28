import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-middelburg-requalification.json', import.meta.url)));

function provider(factory, { pageSize = 1, wrongCount = false, reassign = false } = {}) {
    const response = structuredClone(fixture.response);
    if (reassign) for (const row of response.features) row.attributes.OBJECTID += 100000;
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, fixture.descriptor.endpoint + '/query');
        calls.push(params);
        const keys = [...params.get('where').matchAll(/'([^']+)'/g)].map(match => match[1]);
        const rows = response.features.filter(row => !keys.length || keys.includes(row.attributes.PRCL_KEY));
        let value;
        if (params.get('returnCountOnly') === 'true') value = { count: rows.length + Number(wrongCount) };
        else if (params.get('returnIdsOnly') === 'true') value = {
            objectIdFieldName: 'OBJECTID', objectIds: rows.map(row => row.attributes.OBJECTID)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('f'), 'json');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('returnTrueCurves'), 'true');
            for (const name of ['geometryPrecision', 'maxAllowableOffset', 'resultOffset']) assert.equal(params.has(name), false);
            const objects = params.get('objectIds').split(',').map(Number);
            assert.ok(objects.length <= pageSize);
            value = { ...response, features: rows.filter(row => objects.includes(row.attributes.OBJECTID)), exceededTransferLimit: false };
        }
        return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return { source: factory({ ...fixture.descriptor, pageSize }, { fetchImpl }), calls };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`Middelburg ${name} factory preserves native IDs and complete Esri rings across exact rereads and OID reassignment`, async () => {
        const first = provider(factory), second = provider(factory, { reassign: true });
        for (const adapter of [first, second]) {
            const result = await adapter.source.queryIds(fixture.expectedIds);
            assert.equal(result.complete, true);
            assert.deepEqual(result.absentIds, []);
            assert.deepEqual(result.features.map(row => row.id).sort(), [...fixture.expectedIds].sort());
            for (const feature of result.features) {
                const raw = fixture.response.features.find(row => row.attributes.PRCL_KEY === feature.properties.sourceParcelId);
                assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: raw.geometry.rings });
                assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID', 'PRCL_KEY']);
            }
            assert.equal(adapter.calls.filter(params => params.has('objectIds')).length, 3);
        }
    });
}

test('Middelburg rejects count/manifest disagreement rather than claiming absence', async () => {
    const { source } = provider(createParcelSource, { wrongCount: true });
    await assert.rejects(source.queryIds(fixture.expectedIds), /object-ID list/);
});

test('Middelburg reports complete absence only after an empty native-key manifest', async () => {
    const { source, calls } = provider(createParcelSource);
    const id = fixture.descriptor.idPrefix + 'M000T0JS000000000000000000';
    const result = await source.queryIds([id]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [id]);
    assert.equal(calls.some(params => params.has('objectIds')), false);
});
