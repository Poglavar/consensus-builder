// Protect GEOSA native string identity, complete reads and pinned public-viewer transport in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { GEOSA_SOURCE_ID, GEOSA_ENDPOINT, GEOSA_REFERER } from '../parcels/geosa-transport.js';

const descriptor = {
    id: GEOSA_SOURCE_ID, endpoint: GEOSA_ENDPOINT, adapter: 'arcgis',
    idPrefix: 'SAU-GEOSA-NDM-LANDPARCEL-', idField: 'SUBDIVPARCEL_UNIFIED_ID',
    idType: 'string', idPattern: '^[0-9]{17}$', objectIdField: 'OBJECTID',
    outFields: ['OBJECTID', 'SUBDIVPARCEL_UNIFIED_ID'],
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', pageSize: 100,
    maxResponseBytes: 16777216
};
const nativeId = '00600200001000003', parcelId = descriptor.idPrefix + nativeId;
// Synthetic geometry is solely a transport/identity fixture, never source evidence.
const geometry = { type: 'Polygon', coordinates: [[[42.77, 18.33], [42.7701, 18.33],
    [42.7701, 18.3301], [42.77, 18.33]]] };

function provider({ truncated = false, incomplete = false } = {}) {
    const calls = [];
    return { calls, fetchImpl: async (input, init) => {
        assert.equal(new Headers(init.headers).get('referer'), GEOSA_REFERER);
        const url = new URL(input), params = url.searchParams;
        assert.equal(url.origin + url.pathname, GEOSA_ENDPOINT + '/query');
        assert.ok(['OBJECTID', descriptor.outFields.join(',')].includes(params.get('outFields')));
        calls.push(params);
        const data = params.get('returnCountOnly') === 'true' ? { count: incomplete ? 2 : 1 }
            : params.get('returnIdsOnly') === 'true' ? { objectIdFieldName: 'OBJECTID', objectIds: [7] }
            : { type: 'FeatureCollection', exceededTransferLimit: truncated, features: [{
                type: 'Feature', properties: { OBJECTID: 7, SUBDIVPARCEL_UNIFIED_ID: nativeId }, geometry }] };
        return new Response(JSON.stringify(data));
    } };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: GEOSA supports complete offset reads without redundant manifest requests`, async () => {
        const mock = provider();
        const source = factory({ ...descriptor, boundsQueryMode: 'offset', idsQueryMode: 'offset' }, mock);
        const result = await source.queryIds([parcelId]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(f => f.id), [parcelId]);
        assert.deepEqual(result.features[0].geometry, geometry);
        assert.equal(mock.calls.length, 1);
        assert.equal(mock.calls[0].get('resultOffset'), '0');
        assert.equal(mock.calls[0].get('orderByFields'), 'OBJECTID');
        assert.equal(mock.calls[0].get('where'), `SUBDIVPARCEL_UNIFIED_ID IN ('${nativeId}')`);
    });

    test(`${name}: GEOSA preserves unified-ID leading zeros and unchanged polygons on independent reads`, async () => {
        const mock = provider(), source = factory(descriptor, mock);
        const one = await source.queryIds([parcelId]), two = await source.queryIds([parcelId]);
        const bounds = await source.queryBounds([42.7699, 18.3299, 42.7702, 18.3302]);
        for (const result of [one, two, bounds]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(f => f.id), [parcelId]);
            assert.deepEqual(result.features[0].geometry, geometry);
            assert.equal(result.features[0].properties.sourceParcelId, nativeId);
        }
        assert.deepEqual(one.absentIds, []);
        assert.deepEqual(one, two);
        assert.ok(mock.calls.some(p => p.get('where') === `SUBDIVPARCEL_UNIFIED_ID IN ('${nativeId}')`));
        await assert.rejects(source.queryIds(['SAU-GEOSA-NDM-LANDPARCEL-600200001000003']), /Invalid parcel ID/);
    });

    test(`${name}: GEOSA rejects incomplete manifests and transfer-limited geometry`, async () => {
        for (const options of [{ truncated: true }, { incomplete: true }]) {
            await assert.rejects(factory(descriptor, provider(options)).queryIds([parcelId]), /incomplete/);
        }
    });
}

test('GEOSA relay grants its fixed viewer referrer only to the exact registered source', () => {
    const url = GEOSA_ENDPOINT + '/query?f=json&returnCountOnly=true&where=1%3D1';
    const request = { url, headers: { Referer: GEOSA_REFERER } };
    const catalog = { sources: [descriptor] };
    assert.equal(validateParcelProviderRelayRequest(descriptor.id, request, catalog).headers.get('referer'), GEOSA_REFERER);
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id,
        { ...request, headers: { Referer: 'https://example.com/' } }, catalog));
    for (const changed of [{ ...descriptor, id: 'other-source' },
        { ...descriptor, endpoint: GEOSA_ENDPOINT.replace('/0', '/1') }]) {
        assert.throws(() => validateParcelProviderRelayRequest(changed.id,
            { ...request, url: changed.endpoint + '/query?f=json' }, { sources: [changed] }));
    }
});
