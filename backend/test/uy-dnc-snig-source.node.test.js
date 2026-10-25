import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { DNC_URBAN_ARCHIVE, SNIG_CADASTRAL_LAYER } from '../parcels/uy-dnc-snig-source.js';
import { nativeGeometryHash } from '../parcels/arcgis-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { id: 'uy-dnc-pais-urbano-shp-2026', adapter: 'uy-dnc-snig', endpoint: DNC_URBAN_ARCHIVE,
    liveEndpoint: SNIG_CADASTRAL_LAYER, idPrefix: 'UY-DNC-SNIG:', idField: 'Codigo', objectIdField: 'OBJECTID',
    idType: 'string', identityKind: 'native-key-geometry-sha256-v1', outFields: ['OBJECTID', 'Codigo', 'codDepto', 'codLocCat', 'tipo'],
    attributeFilters: { codDepto: 'V', codLocCat: 'AA', tipo: 'U' }, queryFormat: 'geojson',
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', maxResponseBytes: 2097152, pageSize: 1 };
const geometry = { type: 'Polygon', coordinates: [
    [[-56.171,-34.867],[-56.170,-34.867],[-56.170,-34.866],[-56.171,-34.866],[-56.171,-34.867]],
    [[-56.1708,-34.8668],[-56.1708,-34.8666],[-56.1706,-34.8666],[-56.1706,-34.8668],[-56.1708,-34.8668]]
] };
const row = { type: 'Feature', geometry, properties: { OBJECTID: 1, Codigo: 'VAA0105193', codDepto: 'V', codLocCat: 'AA', tipo: 'U' } };
const id = descriptor.idPrefix + row.properties.Codigo + '-' + nativeGeometryHash(geometry);
function provider(factory = createParcelSource, options = {}) {
    const requests = [], rows = [structuredClone(row), ...(options.duplicate ? [{ ...structuredClone(row), properties: { ...row.properties, OBJECTID: 2 } }] : [])];
    if (options.changed) rows[0].geometry.coordinates[0][1][0] += 0.00001;
    if (options.variant) { const other = structuredClone(row); other.properties.OBJECTID = 3; other.geometry.coordinates[0][1][0] += 0.00001; rows.push(other); }
    const source = factory(descriptor, { fetchImpl: async (input, init = {}) => {
        const url = new URL(input), p = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, SNIG_CADASTRAL_LAYER + '/query'); requests.push(p);
        for (const field of ['codDepto', 'codLocCat', 'tipo']) assert.ok(p.get('where').includes(field));
        assert.equal(p.has('geometryPrecision'), false);
        if (p.get('returnCountOnly') === 'true') return Response.json({ count: options.empty ? 0 : rows.length + Number(!!options.badCount) });
        if (p.get('returnIdsOnly') === 'true') return Response.json({ objectIdFieldName: 'OBJECTID', objectIds: options.empty ? null : rows.map(r => r.properties.OBJECTID) });
        assert.equal(p.get('outFields'), descriptor.outFields.join(','));
        assert.equal(p.get('outSR'), '4326');
        return Response.json({ type: 'FeatureCollection', exceededTransferLimit: !!options.truncated,
            features: rows.filter(r => p.get('objectIds').split(',').includes(String(r.properties.OBJECTID))) });
    } });
    return { source, requests };
}
test('backend and browser preserve full polygons/holes on independently repeated exact reads', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['uy-dnc-snig']]) {
        const { source, requests } = provider(factory);
        for (let i=0;i<2;i++) {
            const result = await source.queryIds([id]);
            assert.equal(result.complete, true); assert.deepEqual(result.absentIds, []);
            assert.equal(result.features[0].id, id); assert.deepEqual(result.features[0].geometry, geometry);
            assert.deepEqual(Object.keys(result.features[0].properties.sourceProperties), descriptor.outFields);
        }
        assert.equal(requests.length, 6);
        const bounds = await source.queryBounds([-56.172,-34.868,-56.169,-34.865]);
        assert.equal(bounds.features[0].id, id);
        const byGeometry = await source.queryGeometry(geometry);
        assert.equal(byGeometry.features[0].id, id);
    }
});
test('distinct full outlines sharing a native cadastral key remain separate references', async () => {
    const result = await provider(createParcelSource, { variant: true }).source.queryBounds([-56.172,-34.868,-56.169,-34.865]);
    assert.equal(result.complete, true); assert.equal(result.features.length, 2);
    assert.notEqual(result.features[0].id, result.features[1].id);
    assert.ok(result.features.every(f => f.properties.sourceNativeParcelId === row.properties.Codigo));
});
test('identical native-key geometry rows collide even across separate OID pages', async () => {
    await assert.rejects(provider(createParcelSource, { duplicate: true }).source.queryIds([id]), /collision/);
});
test('changed geometry becomes explicit absence; empty manifests remain complete', async () => {
    for (const options of [{ changed: true }, { empty: true }]) {
        const result = await provider(createParcelSource, options).source.queryIds([id]);
        assert.equal(result.complete, true); assert.deepEqual(result.features, []); assert.deepEqual(result.absentIds, [id]);
    }
});
test('count mismatches and truncated polygons fail closed', async () => {
    await assert.rejects(provider(createParcelSource, { badCount: true }).source.queryIds([id]), /object-ID list/);
    await assert.rejects(provider(createParcelSource, { truncated: true }).source.queryIds([id]), /incomplete/);
});
test('counts actual streamed bytes and cancels over-limit responses', async () => {
    let cancelled = false;
    const source = createParcelSource(descriptor, { fetchImpl: async () => new Response(new ReadableStream({
        pull(c) { c.enqueue(new Uint8Array(1024*1024)); }, cancel() { cancelled = true; }
    })) });
    await assert.rejects(source.queryIds([id]), /byte limit/); assert.equal(cancelled, true);
});
test('fixed source identity, safe fields and companion relay path cannot be widened', () => {
    for (const patch of [{ endpoint: DNC_URBAN_ARCHIVE + '?other' }, { liveEndpoint: SNIG_CADASTRAL_LAYER + '/other' },
        { outFields: [...descriptor.outFields, 'owner'] }, { attributeFilters: {} }, { geometryPrecision: 6 }]) {
        assert.throws(() => createParcelSource({ ...descriptor, ...patch }), /Invalid/);
    }
    const validate = (url, d = descriptor) => validateParcelProviderRelayRequest(d.id, { url }, { sources: [d] });
    assert.equal(validate(SNIG_CADASTRAL_LAYER + '/query?f=geojson').target.pathname, new URL(SNIG_CADASTRAL_LAYER + '/query').pathname);
    assert.throws(() => validate(SNIG_CADASTRAL_LAYER.replace('/1', '/0') + '/query'));
    assert.throws(() => validate(SNIG_CADASTRAL_LAYER + '/query', { ...descriptor, endpoint: DNC_URBAN_ARCHIVE + '?other' }));
});
