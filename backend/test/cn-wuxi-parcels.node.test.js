// Exercise Wuxi's safe live-response fixture through the production backend and browser factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const { descriptor, response, sampleIds } = JSON.parse(fs.readFileSync(new URL('./fixtures/cn-wuxi-safe.json', import.meta.url)));

function provider({ missingManifest = false, truncated = false } = {}) {
    const calls = [];
    const fetchImpl = async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init?.body || url.search);
        calls.push(params);
        // Wuxi explicitly does not support offsets, order-by or resultRecordCount.
        for (const key of ['resultOffset', 'resultRecordCount', 'orderByFields', 'geometryPrecision', 'maxAllowableOffset']) {
            assert.equal(params.has(key), false, key);
        }
        let rows = response.features;
        if (params.has('where') && params.get('where') !== '1=1') {
            const nativeIds = [...params.get('where').matchAll(/'([0-9A-Z]+)'/g)].map(match => match[1]);
            rows = rows.filter(row => nativeIds.includes(row.properties.ZDDM));
        }
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: rows.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'FID', objectIds: rows.slice(missingManifest ? 1 : 0).map(row => row.properties.FID)
        };
        else {
            assert.equal(params.get('outFields'), 'ZDDM,FID');
            assert.equal(params.get('outSR'), '4326');
            const objects = params.get('objectIds').split(',').map(Number);
            payload = { ...response, features: response.features.filter(row => objects.includes(row.properties.FID)),
                exceededTransferLimit: truncated };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    };
    return { fetchImpl, calls };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: Wuxi reads full unchanged polygons through OID manifests without pagination`, async () => {
        const fetch = provider();
        const source = factory({ ...descriptor, pageSize: 1 }, fetch);
        const first = await source.queryIds(sampleIds);
        const second = await factory(descriptor, provider()).queryIds(sampleIds);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features, second.features);
        assert.deepEqual(new Set(first.features.map(row => row.id)), new Set(sampleIds));
        for (const feature of first.features) {
            const native = feature.properties.sourceNativeParcelId;
            assert.deepEqual(feature.geometry, response.features.find(row => row.properties.ZDDM === native).geometry);
            assert.match(feature.id, new RegExp('^' + descriptor.idPrefix + native + '-[a-f0-9]{64}$'));
            assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['FID', 'ZDDM']);
        }
        const bounds = await source.queryBounds([120.28927, 31.58164, 120.2893, 31.58167]);
        assert.equal(bounds.complete, true);
        assert.deepEqual(new Set(bounds.features.map(row => row.id)), new Set(sampleIds));
        assert.equal(fetch.calls.some(params => params.get('objectIds')?.includes(',')), false);
    });

    test(`${name}: Wuxi rejects incomplete manifests and truncated geometry responses`, async () => {
        for (const options of [{ missingManifest: true }, { truncated: true }]) {
            await assert.rejects(factory(descriptor, provider(options)).queryIds(sampleIds));
        }
    });

    test(`${name}: Wuxi never substitutes another outline for an exact geometry reference`, async () => {
        const changed = sampleIds[0].slice(0, -64) + '0'.repeat(64);
        const result = await factory(descriptor, provider()).queryIds([changed]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features, []);
        assert.deepEqual(result.absentIds, [changed]);
    });
}
