// Exercise Asunción's real safe-field Esri responses through both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/py-asuncion-safe.json', import.meta.url)));
const { descriptor, response } = fixture;
const field = descriptor.objectIdField;
const ids = response.features.map(row => descriptor.idPrefix + row.attributes[field]);
const bounds = [-57.636, -25.2871, -57.6357, -25.2867];

function provider(mutate = () => {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint);
        assert.equal(params.get('outFields'), field);
        assert.equal(params.get('f'), 'json');
        for (const key of ['geometryPrecision', 'maxAllowableOffset', 'resultOffset', 'resultRecordCount']) {
            assert.equal(params.has(key), false);
        }
        calls.push(params);
        const predicate = params.get('where').match(/ IN \(([^)]+)\)/);
        const wanted = (params.get('objectIds') || predicate?.[1] || '').split(',').map(Number);
        const rows = structuredClone(response.features.filter(row =>
            (!params.has('objectIds') && !predicate) || wanted.includes(row.attributes[field])));
        let payload;
        if (params.get('returnIdsOnly') === 'true') {
            payload = { objectIdFieldName: field, objectIds: rows.length ? rows.map(row => row.attributes[field]) : null };
        } else if (params.get('returnGeometry') === 'false') {
            // This server ignores count requests and returns safe attribute rows instead.
            payload = { ...fixture.idRows, features: rows.map(row => ({ attributes: row.attributes })) };
        } else {
            assert.equal(params.get('returnTrueCurves'), 'true');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.has('objectIds'), true);
            payload = { ...response, features: rows };
        }
        mutate(payload, params);
        return { ok: true, status: 200, json: async () => payload };
    };
    return { fetchImpl, calls };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: Asunción reads native OIDs and full rings independently with singleton manifest batches`, async () => {
        const mock = provider(), source = factory({ ...descriptor, pageSize: 1 }, mock);
        const first = await source.queryIds(ids);
        const second = await factory(descriptor, provider()).queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features, second.features);
        assert.deepEqual(first.features.map(row => row.id), ids);
        first.features.forEach((row, index) => {
            assert.deepEqual(row.geometry, { type: 'Polygon', coordinates: response.features[index].geometry.rings });
            assert.deepEqual(Object.keys(row.properties.sourceProperties), [field]);
        });
        assert.deepEqual(mock.calls.filter(p => p.has('objectIds')).map(p => p.get('objectIds')),
            response.features.map(row => String(row.attributes[field])));
        const viewport = await source.queryBounds(bounds);
        assert.deepEqual(viewport.features, first.features);
        const absentId = descriptor.idPrefix + '2147483647';
        assert.deepEqual((await source.queryIds([absentId])).absentIds, [absentId]);
        const callCount = mock.calls.length;
        for (const id of ['FOREIGN-23914', descriptor.idPrefix + '023914', descriptor.idPrefix + "1 OR 1=1"]) {
            await assert.rejects(source.queryIds([id]));
        }
        assert.equal(mock.calls.length, callCount);
    });

    test(`${name}: Asunción rejects incomplete or disagreeing ID representations and geometry`, async () => {
        const mutations = [
            (data, p) => { if (p.get('returnIdsOnly') === 'true') data.objectIds.pop(); },
            (data, p) => { if (p.get('returnIdsOnly') === 'true') data.objectIds[0] = 999999; },
            (data, p) => { if (p.get('returnIdsOnly') === 'true') data.objectIds[0] = data.objectIds[1]; },
            (data, p) => { if (p.get('returnGeometry') === 'false' && !p.has('returnIdsOnly')) data.features[0].attributes[field] = -1; },
            (data, p) => { if (p.get('returnGeometry') === 'false' && !p.has('returnIdsOnly')) data.features.push(data.features[0]); },
            (data, p) => { if (p.get('returnGeometry') === 'false') data.exceededTransferLimit = true; },
            (data, p) => { if (p.has('objectIds')) data.features.pop(); },
            (data, p) => { if (p.has('objectIds')) data.exceededTransferLimit = true; },
            (data, p) => { if (p.has('objectIds')) data.features[0].geometry.curveRings = data.features[0].geometry.rings; }
        ];
        for (const mutate of mutations) await assert.rejects(factory(descriptor, provider(mutate)).queryIds(ids));
        await assert.rejects(factory({ ...descriptor, maxFeatures: 2 }, provider()).queryBounds(bounds), /parcel limit/);
    });
}

test('ID-row cross-check is explicit and cannot silently replace a broken count on other sources', async () => {
    const { objectIdManifestCheck: _ignored, ...normal } = descriptor;
    await assert.rejects(createParcelSource(normal, provider()).queryBounds(bounds), /invalid count/);
    for (const setting of ['auto', true, null]) {
        assert.throws(() => createParcelSource({ ...descriptor, objectIdManifestCheck: setting }), /Invalid ArcGIS/);
    }
    assert.throws(() => createParcelSource({ ...descriptor, idsQueryMode: 'offset' }), /Invalid ArcGIS/);
});
