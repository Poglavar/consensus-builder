// Danané uses layer-qualified GUIDs and a different UTM zone from the other municipalities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { parseDivoPolygon } from '../parcels/divo-ecommunes-source.js';

const guid = '976797F01D4B45D5A4471A3A36834498';
const layers = ['PARCELLAIRE_BLESSALEU', 'PARCELLAIRE_PETIT_DANANE'];
const prefix = 'ci-danane-ecommunes/feature-id/';
const keys = layers.map(layer => `${layer}:${guid}`);
const descriptor = {
    id: 'ci-danane-ecommunes-parcellaire', adapter: 'ecommunes-xml',
    endpoint: 'https://danane.ecommunes.ci/MapServer/AgentLot.aspx/Query',
    layers, idPrefix: prefix, sourceCrs: 'EPSG:32629', outFields: [],
    nativeExtent: [586603.591,793912.6709,602825.5484,809532.0852],
    idLookupBoundsNative: Object.fromEntries(keys.map(key => [key, [593672,802406,593772,802506]]))
};
const wkt = 'POLYGONZM ((593722 802456 394.633 -1.79769313486232E+308,593742 802456 394.633 -1.79769313486232E+308,593722 802476 394.633 -1.79769313486232E+308,593722 802456 394.633 -1.79769313486232E+308))';
const xml = geometry => `<result><Feature ID="${guid}"><Geometry>${geometry}</Geometry><Values><Ignored>discarded</Ignored></Values></Feature></result>`;

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories['ecommunes-xml']]]) {
    test(`${name}: layer namespaces avoid collisions; exact rereads hit each native layer and retain Z`, async () => {
        const requests = [];
        const source = factory(descriptor, { fetchImpl: async url => {
            requests.push(new URL(url));
            return new Response(xml(wkt));
        } });
        const ids = keys.map(key => prefix + key);
        const a = await source.queryIds(ids), b = await source.queryIds(ids);
        assert.equal(requests.length, 4);
        assert.equal(a.complete, true);
        assert.deepEqual(a.features, b.features);
        assert.deepEqual(a.features.map(f => f.id), ids);
        assert.deepEqual(a.features.map(f => f.properties.sourceParcelId), keys);
        assert.deepEqual(requests.map(u => u.searchParams.get('layer')), [...layers, ...layers]);
        const point = a.features[0].geometry.coordinates[0][0];
        assert.ok(Math.abs(point[0] + 8.1510145) < 0.00001);
        assert.ok(Math.abs(point[1] - 7.2588914) < 0.00001);
        assert.equal(point[2], 394.633);
        assert.equal(point.length, 3);
        assert.deepEqual(a.features[0].properties.sourceProperties, {});
        assert.ok(!JSON.stringify(a).includes('discarded'));
        const bounds = await source.queryBounds([-8.1511,7.2588,-8.1508,7.2592]);
        assert.equal(bounds.features.length, 2);
        assert.equal(bounds.nativeQueries, 6);
        assert.equal(bounds.complete, true);
        assert.equal(bounds.areaComplete, false);
        const beforeCachedRead = requests.length;
        const repeated = await source.queryBounds([-8.1511,7.2588,-8.1508,7.2592]);
        assert.equal(requests.length, beforeCachedRead);
        assert.deepEqual(repeated.features, bounds.features);
        assert.equal(repeated.nativeQueries, 0);
        const fresh = await source.queryIds(ids);
        assert.equal(requests.length, beforeCachedRead + 2);
        assert.equal(fresh.complete, true);
    });
}

test('Danané descriptor rejects foreign host, CRS, non-parcel layer, duplicate layers and unqualified locator IDs', () => {
    for (const change of [{ endpoint: 'https://divo.ecommunes.ci/MapServer/AgentLot.aspx/Query' },
        { sourceCrs: 'EPSG:32630' }, { layers: ['Quartiers'] }, { layers: [layers[0], layers[0]] },
        { idLookupBoundsNative: { [guid]: [593672,802406,593772,802506] } }]) {
        assert.throws(() => createParcelSource({ ...descriptor, ...change }), /descriptor/);
    }
});

test('Z preservation retains every ring and multipart order; M never becomes an elevation', () => {
    const g = parseDivoPolygon('MULTIPOLYGONZM (((1 2 7 -1.79769313486232E+308,3 2 8 0,1 4 9 0,1 2 7 0)),((5 6 10 0,7 6 11 0,5 8 12 0,5 6 10 0)))', { preserveZ: true });
    assert.deepEqual(g.coordinates[0][0], [[1,2,7],[3,2,8],[1,4,9],[1,2,7]]);
    assert.equal(g.coordinates[1][0][0][2], 10);
    assert.deepEqual(parseDivoPolygon('POLYGONM ((1 2 0,3 2 0,1 4 0,1 2 0))', { preserveZ: true }).coordinates[0][0], [1,2]);
    assert.throws(() => parseDivoPolygon(wkt.replace('394.633', '1e309'), { preserveZ: true }), /malformed/);
});
