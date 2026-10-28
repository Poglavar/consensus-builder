// Exercise INTERPI paging, exact identity, privacy and unchanged geometry without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterpiSigefParcelSource, INTERPI_ENDPOINT } from '../parcels/interpi-sigef-source.js';

const d = { id: 'test-interpi', endpoint: INTERPI_ENDPOINT, idPrefix: 'INTERPI:', table: 'SIGEF Privado',
    sourceTable: 'outros_sigef_privado', municipality: 'Teresina', sourceCrs: 'EPSG:4674',
    idField: 'id', outFields: ['id'], pageSize: 1, maxFeatures: 10, maxMunicipalityFeatures: 10 };
function parcel(id, x = -42.77) {
    return { type: 'Feature', properties: { id, tabela: d.sourceTable, nome: 'unsolicited display field' },
        geometry: { type: 'MultiPolygon', crs: { type: 'name', properties: { name: 'EPSG:4674' } },
            coordinates: [[[[x,-5.1,3],[x+0.001,-5.1,4],[x+0.001,-5.099,5],[x,-5.099,6],[x,-5.1,3]]]] } };
}
const response = (features, more_data = false) => Response.json({ type: 'FeatureCollection', features, more_data });

test('search results are exhausted and equality checked; every exact read is fresh and unchanged', async () => {
    const original = parcel(12), calls = [];
    const source = createInterpiSigefParcelSource(d, { fetchImpl: async url => {
        const p = new URL(url).searchParams; calls.push(Object.fromEntries(p));
        return p.get('offset') === '0' ? response([parcel(123)], true) : response([original]);
    } });
    for (let i = 0; i < 2; i++) {
        const result = await source.queryIds(['INTERPI:12']);
        assert.deepEqual(result.features.map(f => f.id), ['INTERPI:12']);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features[0].geometry, original.geometry);
        assert.deepEqual(result.features[0].properties.sourceProperties, { id: 12 });
        assert.equal(JSON.stringify(result).includes('unsolicited'), false);
    }
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map(p => p.offset), ['0','1','0','1']);
    assert.ok(calls.every(p => p.term === '12' && p.municipio === 'Teresina' && p.tables === 'SIGEF Privado' && p.limit === '1'));
});

test('complete absence uses exact equality, never the first substring hit', async () => {
    const source = createInterpiSigefParcelSource(d, { fetchImpl: async () => response([parcel(123)]) });
    assert.deepEqual((await source.queryIds(['INTERPI:12'])).absentIds, ['INTERPI:12']);
    await assert.rejects(source.queryIds(['FOREIGN:12']), /Invalid INTERPI/);
});

test('bounds exhaust pages, share the ephemeral cache, and preserve intersecting full polygons', async () => {
    let calls = 0;
    const original = parcel(12);
    const source = createInterpiSigefParcelSource(d, { fetchImpl: async url => {
        calls++;
        return new URL(url).searchParams.get('offset') === '0' ? response([original], true) : response([parcel(13, -42.8)]);
    } });
    const bounds = [-42.7698,-5.0998,-42.7694,-5.0994];
    const [a,b] = await Promise.all([source.queryBounds(bounds), source.queryBounds(bounds)]);
    assert.equal(calls, 2);
    assert.equal(a.complete, true);
    assert.deepEqual(a.features.map(f => f.id), ['INTERPI:12']);
    assert.deepEqual(a.features[0].geometry, original.geometry);
    assert.deepEqual(a,b);
});

test('duplicate pages, truncated pagination and wrong CRS/layer fail closed', async () => {
    const repeated = createInterpiSigefParcelSource(d, { fetchImpl: async () => response([parcel(12)], true) });
    await assert.rejects(repeated.queryIds(['INTERPI:12']), /repeated a native ID/);
    const emptyMore = createInterpiSigefParcelSource(d, { fetchImpl: async () => response([], true) });
    await assert.rejects(emptyMore.queryIds(['INTERPI:12']), /paging envelope/);
    for (const field of ['crs','layer']) {
        const f = parcel(12);
        if (field === 'crs') f.geometry.crs.properties.name = 'EPSG:3857'; else f.properties.tabela = 'other';
        const source = createInterpiSigefParcelSource(d, { fetchImpl: async () => response([f]) });
        await assert.rejects(source.queryIds(['INTERPI:12']), /identity, layer or geometry/);
    }
});

test('a failed page does not become cached completeness and can be retried', async () => {
    let calls = 0;
    const source = createInterpiSigefParcelSource(d, { fetchImpl: async () => {
        calls++; return calls === 1 ? response([], true) : response([parcel(12)]);
    } });
    const bounds = [-42.77,-5.1,-42.769,-5.099];
    await assert.rejects(source.queryBounds(bounds), /paging envelope/);
    assert.equal((await source.queryBounds(bounds)).features.length, 1);
    assert.equal(calls, 2);
});
