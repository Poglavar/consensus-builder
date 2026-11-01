// Check Almaty's old ArcGIS wire protocol and unchanged native polygons in both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const { descriptor, sampleIds, response } = JSON.parse(fs.readFileSync(new URL('./fixtures/kz-almaty-mapalmaty-safe.json', import.meta.url)));
function provider({ truncated = false, missingManifest = false } = {}) {
    const calls = [];
    return { calls, fetchImpl: async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init?.body || url.search);
        calls.push(params);
        for (const key of ['resultOffset', 'orderByFields', 'geometryPrecision', 'maxAllowableOffset']) assert.equal(params.has(key), false);
        let rows = response.features;
        const where = params.get('where');
        if (where !== '1=1') {
            const ids = [...where.matchAll(/'([0-9]+)'/g)].map(match => match[1]);
            rows = rows.filter(row => ids.includes(row.attributes.kad_nomer));
        }
        if (params.has('geometry')) {
            assert.equal(params.get('inSR'), '32643');
            const [x, y, right, top] = params.get('geometry').split(',').map(Number);
            assert.ok(x > 650000 && right < 660000 && y > 4790000 && top < 4800000);
        }
        let result;
        if (params.get('returnCountOnly') === 'true') result = { count: rows.length };
        else if (params.get('returnIdsOnly') === 'true') result = { objectIdFieldName: 'objectid',
            objectIds: rows.slice(missingManifest ? 1 : 0).map(row => row.attributes.objectid) };
        else {
            assert.equal(params.get('outFields'), 'objectid,kad_nomer');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'json');
            const ids = params.get('objectIds').split(',').map(Number);
            result = { ...response, features: response.features.filter(row => ids.includes(row.attributes.objectid)), exceededTransferLimit: truncated };
        }
        return { ok: true, status: 200, json: async () => structuredClone(result) };
    } };
}
for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: Almaty exact reads preserve IDs and every original ring`, async () => {
        const fetch = provider();
        const source = factory({ ...descriptor, pageSize: 1 }, fetch);
        const first = await source.queryIds(sampleIds);
        const second = await factory(descriptor, provider()).queryIds(sampleIds);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features, second.features);
        assert.deepEqual(new Set(first.features.map(row => row.id)), new Set(sampleIds));
        for (const row of first.features) {
            const native = response.features.find(feature => descriptor.idPrefix + feature.attributes.kad_nomer === row.id);
            assert.deepEqual(row.geometry, { type: 'Polygon', coordinates: native.geometry.rings });
            assert.deepEqual(Object.keys(row.properties.sourceProperties).sort(), ['kad_nomer', 'objectid']);
        }
        const bounded = await source.queryBounds([76.90847572589956, 43.260372723197136, 76.90973526301181, 43.26129324869728]);
        assert.equal(bounded.complete, true);
        assert.deepEqual(bounded.features, first.features);
        const absentId = descriptor.idPrefix + '00000000000';
        const absent = await source.queryIds([absentId]);
        assert.deepEqual(absent.features, []);
        assert.deepEqual(absent.absentIds, [absentId]);
    });
    test(`${name}: Almaty refuses incomplete manifests and truncated polygons`, async () => {
        for (const options of [{ truncated: true }, { missingManifest: true }]) {
            await assert.rejects(factory(descriptor, provider(options)).queryIds(sampleIds));
        }
    });
}
