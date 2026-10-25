// Exercises KZN COGTA full-geometry identity, OID paging, and both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { nativeGeometryHash } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-kzn-bombay-heights-safe.json', import.meta.url)));
const reference = row => fixture.descriptor.idPrefix + row.properties.SGKEY + '-' + nativeGeometryHash(row.geometry);

function provider(factory, { duplicates = false, wrongCount = false } = {}) {
    const rows = structuredClone(duplicates ? fixture.duplicateRows : fixture.response.features);
    const calls = [];
    const descriptor = { ...fixture.descriptor, pageSize: 1 };
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        const keys = [...params.get('where').matchAll(/'([A-Z0-9]+)'/g)].map(match => match[1]);
        const selected = keys.length ? rows.filter(row => keys.includes(row.properties.SGKEY)) : rows;
        let data;
        if (params.get('returnCountOnly') === 'true') data = { count: selected.length + Number(wrongCount) };
        else if (params.get('returnIdsOnly') === 'true') data = {
            objectIdFieldName: 'OBJECTID_1', objectIds: selected.map(row => row.properties.OBJECTID_1)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID_1,SGKEY');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            for (const key of ['geometryPrecision', 'maxAllowableOffset', 'resultOffset']) assert.equal(params.has(key), false);
            const objects = params.get('objectIds').split(',').map(Number);
            assert.equal(objects.length, 1);
            data = { type: 'FeatureCollection', features: selected.filter(row => objects.includes(row.properties.OBJECTID_1)) };
        }
        return { ok: true, status: 200, json: async () => structuredClone(data) };
    };
    return { rows, calls, source: factory(descriptor, { fetchImpl }) };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`KZN ${name} factory preserves exact full polygons across independent reads and transport renumbering`, async () => {
        const first = provider(factory), second = provider(factory);
        for (const row of second.rows) row.properties.OBJECTID_1 += 100000;
        for (const result of [await first.source.queryIds(fixture.expectedIds), await second.source.queryIds(fixture.expectedIds)]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.absentIds, []);
            assert.deepEqual(result.features.map(f => f.id).sort(), [...fixture.expectedIds].sort());
            for (const feature of result.features) {
                const raw = fixture.response.features.find(row => reference(row) === feature.id);
                assert.deepEqual(feature.geometry, raw.geometry);
                assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID_1', 'SGKEY']);
                assert.equal(feature.properties.sourceNativeParcelId, raw.properties.SGKEY);
            }
        }
        assert.equal(first.calls.length, 5);
        assert.equal(second.calls.length, 5);
    });

    test(`KZN ${name} factory keeps the three real different outlines under one SGKEY and selects a sibling exactly`, async () => {
        const { source, rows } = provider(factory, { duplicates: true });
        assert.equal(rows.length, 3);
        assert.equal(new Set(rows.map(row => row.properties.SGKEY)).size, 1);
        const ids = rows.map(reference);
        assert.equal(new Set(ids).size, 3);
        const all = await source.queryBounds([30.389953219533, -29.549660491012, 30.391953219533, -29.547660491012]);
        assert.equal(all.complete, true);
        assert.deepEqual(all.features.map(f => f.id).sort(), [...ids].sort());
        const exact = await source.queryIds([ids[1]]);
        assert.deepEqual(exact.features.map(f => f.id), [ids[1]]);
        assert.deepEqual(exact.features[0].geometry, rows[1].geometry);
        assert.deepEqual(exact.absentIds, []);
    });

    test(`KZN ${name} factory rejects incomplete manifests and reports changed full geometry as old-reference absence`, async () => {
        const bad = provider(factory, { wrongCount: true });
        await assert.rejects(bad.source.queryIds(fixture.expectedIds), /object-ID list/);
        const changed = provider(factory);
        changed.rows[0].geometry.coordinates[0][1][0] += 1e-12;
        const read = await changed.source.queryIds([fixture.expectedIds[0]]);
        assert.equal(read.complete, true);
        assert.deepEqual(read.features, []);
        assert.deepEqual(read.absentIds, [fixture.expectedIds[0]]);
    });
}
