// Regress Mahikeng's required minimal OID field and unchanged multipart cadastral reads in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-mahikeng-cadastre.json', import.meta.url)));

function provider(factory) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, fixture.descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        // This layer errors on key-only reads: the real OID must be explicitly included.
        assert.equal(params.get('outFields'), 'parcel_key,ESRI_OID');
        assert.equal(params.get('f'), 'json');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.has('geometryPrecision'), false);
        assert.equal(params.has('maxAllowableOffset'), false);
        const data = structuredClone(fixture.response);
        if (params.get('where').includes('ABSENT')) data.features = [];
        return { ok: true, status: 200, json: async () => data };
    };
    return { calls, source: factory(fixture.descriptor, { fetchImpl }) };
}

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${runtime}: native exact reads retain both complete farm shells and minimal fields`, async () => {
        const { source, calls } = provider(factory);
        for (let pass = 0; pass < 2; pass++) {
            const result = await source.queryIds([fixture.id]);
            assert.equal(result.complete, true);
            assert.deepEqual(result.absentIds, []);
            assert.equal(result.features.length, 1);
            const feature = result.features[0];
            assert.equal(feature.id, fixture.id);
            assert.equal(feature.properties.sourceParcelId, fixture.response.features[0].attributes.parcel_key);
            assert.deepEqual(feature.properties.sourceProperties, fixture.response.features[0].attributes);
            assert.equal(feature.geometry.type, 'MultiPolygon');
            assert.deepEqual(feature.geometry.coordinates, fixture.response.features[0].geometry.rings.map(ring => [ring]));
        }
        assert.equal(calls.length, 2);
        assert.equal(calls[0].get('where'), "parcel_key IN ('N383T0JO000000000302000001')");
    });

    test(`${runtime}: complete absence and foreign identity remain distinct from unavailable reads`, async () => {
        const { source, calls } = provider(factory);
        const absentId = fixture.descriptor.idPrefix + 'ABSENT00000000000000000000';
        const result = await source.queryIds([absentId]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features, []);
        assert.deepEqual(result.absentIds, [absentId]);
        await assert.rejects(source.queryIds(['FOREIGN-PARCEL']), /different source/);
        assert.equal(calls.length, 1);
    });
}
