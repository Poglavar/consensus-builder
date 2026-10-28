// Verifies the reviewed Abengourou binding and real multipart envelope false positive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/abengourou-ecommunes-safe.json' with { type: 'json' };
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: fixture.sourceId, endpoint: fixture.endpoint, layer: fixture.layer, idPrefix: fixture.prefix,
    adapter: 'ecommunes-xml', sourceCrs: 'EPSG:32630', outFields: [],
    nativeExtent: [440669.874427734,739159.9712,450929.709603648,752104.975200001],
    idLookupBoundsNative: Object.fromEntries(fixture.features.map(row => [row.id, fixture.nativeBbox]))
};
const xml = '<result>' + fixture.features.map(row => `<Feature ID="${row.id}"><Geometry><![CDATA[${row.wkt}]]></Geometry><Values><Ignored>discard-me</Ignored></Values></Feature>`).join('') + '</result>';

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories['ecommunes-xml']]]) {
    test(`${name}: precise bounds exclude the envelope-only multipart while exact reads retain all parts`, async () => {
        const requests = [];
        const source = factory(descriptor, { fetchImpl: async url => {
            requests.push(new URL(url));
            return new Response(xml);
        } });
        const bounds = await source.queryBounds(fixture.wgs84Bbox);
        assert.equal(bounds.features.length, 2);
        assert.equal(bounds.complete, true);
        assert.equal(bounds.areaComplete, false);
        const multipartId = fixture.prefix + '252B25CF2F6443238C16B74B8E4EBC40';
        assert.ok(bounds.features.every(row => row.id !== multipartId));
        const a = await source.queryIds([multipartId]);
        const b = await source.queryIds([multipartId]);
        assert.equal(a.complete, true);
        assert.deepEqual(a.features, b.features);
        assert.equal(a.features[0].geometry.type, 'MultiPolygon');
        assert.deepEqual(a.features[0].geometry.coordinates.map(p => p[0].length), [11, 7]);
        assert.equal(requests.length, 5);
        assert.ok(requests.every(url => url.origin === 'https://abengourou.ecommunes.ci'
            && url.searchParams.get('layer') === fixture.layer
            && [...url.searchParams.keys()].join(',') === 'layer,geom'));
        assert.equal(JSON.stringify(a).includes('discard-me'), false);
        assert.deepEqual(a.features[0].properties.sourceProperties, {});
    });
}

test('Abengourou binding rejects another host, layer, prefix and CRS', () => {
    for (const change of [{ endpoint: 'https://divo.ecommunes.ci/MapServer/AgentLot.aspx/Query' },
        { layer: 'Parcellaire' }, { idPrefix: 'foreign/' }, { sourceCrs: 'EPSG:32730' }]) {
        assert.throws(() => createParcelSource({ ...descriptor, ...change }), /descriptor/);
    }
});
