// SIGEF native parcel UUIDs identify full rural polygons; OIDs are transport tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/br-infrasa-sigef.json', import.meta.url)));
const descriptor = fixture.descriptor;
const row = fixture.response.features[0];
const id = descriptor.idPrefix + row.properties.parcela_co;
function provider({ incomplete = false } = {}) {
    const rows = structuredClone(fixture.response.features), calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        const keys = [...params.get('where').matchAll(/'([^']+)'/g)].map(match => match[1]);
        const selected = keys.length ? rows.filter(row => keys.includes(row.properties.parcela_co)) : rows;
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: selected.length };
        else if (params.get('returnIdsOnly') === 'true') payload = { objectIdFieldName: 'objectid', objectIds: incomplete ? [] : selected.map(row => row.properties.objectid) };
        else {
            assert.equal(params.get('outFields'), 'objectid,parcela_co');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            for (const key of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters']) assert.equal(params.has(key), false);
            const objects = params.get('objectIds').split(',').map(Number);
            payload = { ...fixture.response, features: rows.filter(row => objects.includes(row.properties.objectid)) };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    };
    return { rows, calls, fetchImpl };
}
for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: SIGEF UUID exact reads preserve source geometry across OID changes`, async () => {
        const mock = provider(), source = factory(descriptor, { fetchImpl: mock.fetchImpl });
        const first = await source.queryIds([id]);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.equal(first.features[0].id, id);
        assert.deepEqual(first.features[0].geometry, row.geometry);
        assert.deepEqual(Object.keys(first.features[0].properties.sourceProperties).sort(), ['objectid', 'parcela_co']);
        mock.rows[0].properties.objectid += 100000;
        const second = await source.queryIds([id]);
        assert.deepEqual(second.features.map(row => [row.id, row.geometry]), first.features.map(row => [row.id, row.geometry]));
        assert.equal(mock.calls[0].get('where'), `parcela_co IN ('${row.properties.parcela_co}')`);
        const absentId = descriptor.idPrefix + '00000000-0000-0000-0000-000000000000';
        const absent = await source.queryIds([absentId]);
        assert.equal(absent.complete, true);
        assert.deepEqual(absent.absentIds, [absentId]);
        assert.deepEqual(absent.features, []);
        await assert.rejects(source.queryIds([descriptor.idPrefix + "x' OR 1=1"]), /Invalid parcel ID/);
    });
    test(`${name}: intersecting bounds retain full rural parcel and reject incomplete manifests`, async () => {
        const mock = provider(), source = factory(descriptor, { fetchImpl: mock.fetchImpl });
        const bounds = [-34.8905, -7.1555, -34.8705, -7.1355];
        const result = await source.queryBounds(bounds);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(row => row.geometry), [row.geometry]);
        const broken = provider({ incomplete: true });
        await assert.rejects(factory(descriptor, { fetchImpl: broken.fetchImpl }).queryBounds(bounds), /incomplete or invalid object-ID/);
    });
}
