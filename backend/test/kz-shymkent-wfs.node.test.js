// Shymkent's explicit CRS:84 route avoids guessing the advertised native CRS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'kz-shymkent-rgis-aisgzk-merge1', adapter: 'wfs',
    endpoint: 'https://geo-shym.kz/geoserver/gis_shymkent/ows',
    version: '1.1.0', featureType: 'gis_shymkent:aisgzk_shymkent_merge1',
    geometryField: 'geom', idField: 'cad_number', idType: 'string',
    idPrefix: 'KZ-SHYMKENT-AISGZK:', idPattern: '^[0-9]+$',
    outFields: ['cad_number'], requestProperties: true, pageSize: 1,
    maxFeatures: 3000, maxBboxKm2: 2, maxResponseBytes: 1048576
};
// Synthetic coordinates and keys; no downloaded parcel fixture.
const geometry = { type: 'MultiPolygon', coordinates: [[[
    [69.599, 42.337], [69.5991, 42.337], [69.5991, 42.3371], [69.599, 42.337]
]]] };
const keys = ['0000123', '0000124'];
const ids = keys.map(key => descriptor.idPrefix + key);

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`Shymkent ${runtime}: safe fields, explicit axes, complete paging and unchanged exact reads`, async () => {
        const requests = [];
        let serial = 0;
        const source = factory(descriptor, { fetchImpl: async input => {
            const url = new URL(input), p = url.searchParams;
            requests.push(p);
            assert.equal(url.origin + url.pathname, descriptor.endpoint);
            assert.equal(p.get('version'), '1.1.0');
            assert.equal(p.get('typeName'), descriptor.featureType);
            assert.equal(p.get('propertyName'), 'geom,cad_number');
            assert.equal(p.get('srsName'), 'CRS:84');
            assert.equal(p.get('sortBy'), 'cad_number');
            assert.equal(p.get('maxFeatures'), '1');
            const filter = p.get('cql_filter');
            const selected = filter ? keys.filter(key => filter.includes(`'${key}'`)) : keys;
            if (filter) assert.match(filter, /^cad_number IN \('[0-9]+'(?:,'[0-9]+')*\)$/);
            else assert.equal(p.get('bbox'), '69.5989,42.3369,69.5992,42.3372,CRS:84');
            const offset = Number(p.get('startIndex'));
            return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: selected.length,
                crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:CRS::84' } },
                features: selected.slice(offset, offset + 1).map(key => ({ type: 'Feature',
                    id: `aisgzk_shymkent_merge1.${++serial}`, properties: { cad_number: key }, geometry })) }));
        } });
        const bounds = await source.queryBounds([69.5989, 42.3369, 69.5992, 42.3372]);
        assert.deepEqual(bounds.features.map(f => f.id), ids);
        assert.deepEqual(requests.map(p => p.get('startIndex')), ['0', '1']);
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.deepEqual(first, second);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(f => f.geometry), [geometry, geometry]);
        assert.deepEqual(first.features[0].properties.sourceProperties, { cad_number: '0000123' });
        assert.equal(first.features[0].properties.sourceParcelId, '0000123');
        const count = requests.length;
        await assert.rejects(source.queryIds([descriptor.idPrefix + "123' OR 1=1"]), /Invalid parcel ID/);
        await assert.rejects(source.queryIds(['OTHER:0000123']), /different source/);
        assert.equal(requests.length, count);
    });

    test(`Shymkent ${runtime}: conflicting cadastral identities fail without changing geometry`, async () => {
        const changed = structuredClone(geometry);
        changed.coordinates[0][0][1][0] += 0.00001;
        const source = factory({ ...descriptor, pageSize: 2 }, { fetchImpl: async () =>
            new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 2,
                features: [geometry, changed].map((g, index) => ({ type: 'Feature',
                    id: `aisgzk_shymkent_merge1.${index}`, properties: { cad_number: keys[0] }, geometry: g })) })) });
        await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
    });
}
