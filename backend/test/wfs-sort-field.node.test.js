// Verify independent WFS transport ordering without changing durable parcel identity or geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const uid = 'fda75b3a-2cdc-4403-9228-27442a532ea7';
const descriptor = {
    id: 'tz-arusha-sort-test', adapter: 'wfs', endpoint: 'https://example.test/wfs',
    version: '1.0.0', featureType: 'taspro:spatial_units37', geometryField: 'geom',
    requestProperties: true, outFields: ['uid'], idField: 'uid', idType: 'string',
    idPrefix: 'TZ-TEST-', sortField: 'id', pageSize: 1
};
const geometry = { type: 'MultiPolygon', coordinates: [[[
    [36.718, -3.419], [36.7181, -3.419], [36.7181, -3.4189], [36.718, -3.419]
]]] };

for (const [runtime, factory] of [['backend', createWfsParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${runtime} pages by transport sort field and repeats exact native UUID reads unchanged`, async () => {
        const requests = [];
        let serial = 0;
        const adapter = factory(descriptor, { fetchImpl: async url => {
            const params = new URL(url).searchParams;
            requests.push(params);
            assert.equal(params.get('sortBy'), 'id');
            assert.equal(params.get('propertyName'), 'geom,uid');
            const offset = Number(params.get('startIndex'));
            const exact = params.has('cql_filter');
            if (exact) assert.equal(params.get('cql_filter'), `uid IN ('${uid}')`);
            return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: exact ? 1 : 2,
                features: [{ type: 'Feature', id: `spatial_units37.fid-${++serial}`,
                    properties: { uid: exact || offset === 0 ? uid : 'second-native-uuid' }, geometry }] }));
        } });
        const bounds = await adapter.queryBounds([36.717, -3.42, 36.719, -3.418]);
        assert.deepEqual(bounds.features.map(f => f.id), ['TZ-TEST-' + uid, 'TZ-TEST-second-native-uuid']);
        assert.deepEqual(requests.slice(0, 2).map(p => p.get('startIndex')), ['0', '1']);
        const first = await adapter.queryIds(['TZ-TEST-' + uid]);
        const second = await adapter.queryIds(['TZ-TEST-' + uid]);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features[0].geometry, geometry);
        assert.deepEqual(first.features[0].properties.sourceProperties, { uid });
    });
}

test('invalid explicit sort identifiers fail before transport', () => {
    for (const sortField of [null, '', 7, 'id DESC', 'id;DROP', 'id,uid']) {
        assert.throws(() => createWfsParcelSource({ ...descriptor, sortField }), /Invalid WFS/);
    }
    assert.throws(() => createWfsParcelSource({ ...descriptor, nativeIdMode: 'feature-id',
        idField: null, outFields: [] }), /Invalid WFS/);
});

test('omitting a transport override preserves the existing identity-field sort', async () => {
    const { sortField, ...existing } = descriptor;
    const adapter = createWfsParcelSource(existing, { fetchImpl: async url => {
        assert.equal(new URL(url).searchParams.get('sortBy'), 'uid');
        return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 0, features: [] }));
    } });
    assert.deepEqual((await adapter.queryIds(['TZ-TEST-absent'])).absentIds, ['TZ-TEST-absent']);
});
