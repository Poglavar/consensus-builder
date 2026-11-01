import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource, parcelSourceCatalog } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = parcelSourceCatalog.sources.find(source => source.id === 'br-sfb-consulta-car-public-wfs');
// Synthetic fixtures: these are not retained source polygons or cadastral claims.
const nativeIds = [1, 2, 3].map(value => `SP-3509502-${String(value).padStart(32, '0')}`);
const externalId = native => `BR-CAR-${native}`;
const geometry = { type: 'MultiPolygon', coordinates: [
    [[[-47.13, -22.90], [-47.12, -22.90], [-47.12, -22.89], [-47.13, -22.90]],
        [[-47.125, -22.897], [-47.124, -22.897], [-47.124, -22.896], [-47.125, -22.897]]],
    [[[-47.129, -22.889], [-47.128, -22.889], [-47.128, -22.888], [-47.129, -22.889]]]
] };
const raw = (native, transport = 'iru.transport') => ({ type: 'Feature', id: transport,
    geometry, properties: { cod_imovel: native, unexpected: 'discard' } });
const page = (features, matched = features.length) => new Response(JSON.stringify({
    type: 'FeatureCollection', features, numberMatched: matched, numberReturned: features.length,
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    links: [{ rel: 'next', href: 'https://other.invalid/wfs' }]
}));
function fixture(responses, overrides = {}, factory = createParcelSource) {
    const requests = [];
    const source = factory({ ...descriptor, ...overrides }, { fetchImpl: async (url, options) => {
        requests.push({ url: new URL(url), options });
        assert.ok(responses.length, 'Unexpected provider request');
        return responses.shift();
    } });
    return { source, requests };
}

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${runtime}: SICAR exact reads use cod_imovel and preserve all parts, holes and precision`, async () => {
        const { source, requests } = fixture([
            page([raw(nativeIds[0], 'iru.first')]), page([raw(nativeIds[0], 'iru.independent')])
        ], {}, factory);
        const ids = [externalId(nativeIds[0])];
        const first = await source.queryIds(ids);
        const second = await source.queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(second, first);
        assert.equal(first.features[0].id, ids[0]);
        assert.equal(first.features[0].properties.sourceParcelId, nativeIds[0]);
        assert.deepEqual(first.features[0].properties.sourceProperties, { cod_imovel: nativeIds[0] });
        assert.deepEqual(first.features[0].geometry, geometry);
        assert.equal(requests.length, 2);
        for (const { url, options } of requests) {
            assert.equal(`${url.origin}${url.pathname}`, 'https://consulta.car.gov.br/geoserver/wfs');
            assert.equal(url.searchParams.get('typeNames'), 'consulta_publica:iru');
            assert.equal(url.searchParams.get('propertyName'), 'geom,cod_imovel');
            assert.equal(url.searchParams.get('srsName'), 'CRS:84');
            assert.equal(url.searchParams.get('cql_filter'), `cod_imovel IN ('${nativeIds[0]}')`);
            assert.equal(url.searchParams.get('sortBy'), 'cod_imovel');
            assert.equal(options.redirect, 'error');
        }
    });
}

test('SICAR paging uses native identity even when distinct records share a transport FID', async () => {
    const { source, requests } = fixture([
        page([raw(nativeIds[0])], 2), page([raw(nativeIds[1])], 2)
    ], { pageSize: 1 });
    const result = await source.queryBounds([-47.13, -22.90, -47.12, -22.89]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(feature => feature.id), nativeIds.slice(0, 2).map(externalId));
    assert.deepEqual(result.features.map(feature => feature.geometry), [geometry, geometry]);
    assert.deepEqual(requests.map(({ url }) => url.searchParams.get('startIndex')), ['0', '1']);
    for (const { url } of requests) {
        assert.equal(url.origin, 'https://consulta.car.gov.br');
        assert.equal(url.searchParams.get('bbox'), '-47.13,-22.9,-47.12,-22.89,CRS:84');
        assert.equal(url.searchParams.get('propertyName'), 'geom,cod_imovel');
    }
});

test('SICAR repeated native IDs across pages fail without publishing partial results', async () => {
    const { source } = fixture([
        page([raw(nativeIds[0], 'iru.one')], 2), page([raw(nativeIds[0], 'iru.two')], 2)
    ], { pageSize: 1 });
    await assert.rejects(source.queryBounds([-47.13, -22.90, -47.12, -22.89]), /repeated a native parcel ID/);
});

test('SICAR exact batches report absence only after all batches finish', async () => {
    const { source, requests } = fixture([page([raw(nativeIds[0])]), page([])], { idBatchSize: 1 });
    const ids = nativeIds.slice(0, 2).map(externalId);
    const result = await source.queryIds(ids);
    assert.equal(result.complete, true);
    assert.deepEqual(result.absentIds, [ids[1]]);
    assert.equal(requests.length, 2);
    const failed = fixture([page([raw(nativeIds[0])]), new Response('', { status: 503 })], { idBatchSize: 1 });
    await assert.rejects(failed.source.queryIds(ids), { status: 502 });
});

test('SICAR malformed/foreign IDs make no request; unexpected records fail exact reads', async () => {
    const { source, requests } = fixture([]);
    for (const id of ['OTHER-' + nativeIds[0], externalId("' OR 1=1"), 'BR-CAR-iru.transport']) {
        await assert.rejects(source.queryIds([id]), { status: 400 });
    }
    assert.equal(requests.length, 0);
    const unexpected = fixture([page([raw(nativeIds[1])])]);
    await assert.rejects(unexpected.source.queryIds([externalId(nativeIds[0])]), /unexpected parcels/);
});

test('SICAR enforces actual streamed byte limits without a Content-Length header', async () => {
    const response = page([raw(nativeIds[0])]);
    assert.equal(response.headers.has('content-length'), false);
    const { source } = fixture([response], { maxResponseBytes: 64 });
    await assert.rejects(source.queryIds([externalId(nativeIds[0])]), /response byte limit/);
});
