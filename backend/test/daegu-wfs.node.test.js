// Verify native PNU identity, projected geometry and envelope filtering in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const native = JSON.parse(readFileSync(new URL('./fixtures/daegu/central-native.geojson', import.meta.url)));
const descriptor = {
    id: 'kr-daegu-gis-go-kr-dg-lsmd-cont-ldreg', adapter: 'wfs',
    endpoint: 'https://gis.go.kr/geoserver/dg/ows', featureType: 'dg:LSMD_CONT_LDREG', version: '1.1.0',
    idField: 'pnu', idType: 'string', idPattern: '^[0-9]{19}$', idPrefix: 'KR-DAEGU-PNU-',
    outFields: ['pnu'], geometryField: 'geom', requestProperties: true,
    responseSrid: 5187,
    projection: '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
    filterBoundsGeometry: true, pageSize: 1, maxBboxKm2: 2
};
const bounds = [128.59346454724744, 35.85892854088338, 128.59347566423938, 35.858937590665];
const nativeId = '2711015600107140002';
const id = descriptor.idPrefix + nativeId;

function provider(calls) {
    return async url => {
        const params = new URL(url).searchParams;
        calls.push(params);
        assert.equal(params.get('typeName'), descriptor.featureType);
        assert.equal(params.get('version'), '1.1.0');
        assert.equal(params.get('propertyName'), 'geom,pnu');
        assert.equal(params.get('srsName'), 'EPSG:5187');
        assert.equal(params.get('sortBy'), 'pnu');
        const selected = params.has('bbox') ? native.features
            : native.features.filter(f => params.get('cql_filter').includes(f.properties.pnu));
        const offset = Number(params.get('startIndex'));
        const features = selected.slice(offset, offset + Number(params.get('maxFeatures')));
        return new Response(JSON.stringify({ ...native, features,
            totalFeatures: selected.length, numberMatched: selected.length, numberReturned: features.length }));
    };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${name} pages all envelope hits then keeps only actual intersections without clipping`, async () => {
        const calls = [];
        const adapter = factory(descriptor, { fetchImpl: provider(calls) });
        const result = await adapter.queryBounds(bounds);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(f => f.id), [id]);
        assert.equal(calls.length, 3);
        assert.deepEqual(calls.map(p => p.get('startIndex')), ['0', '1', '2']);
        assert.equal(calls[0].get('bbox'), `${bounds.join(',')},CRS:84`);
        const raw = native.features.find(f => f.properties.pnu === nativeId).geometry;
        const expected = { type: raw.type, coordinates: raw.coordinates.map(polygon => polygon.map(ring =>
            ring.map(point => proj4(descriptor.projection, 'EPSG:4326', point)))) };
        assert.deepEqual(result.features[0].geometry, expected);
        assert.deepEqual(result.features[0].properties.sourceProperties, { pnu: nativeId });
    });
    test(`${name} independently repeats exact native PNU reads and explicitly reports absence`, async () => {
        const calls = [];
        const adapter = factory(descriptor, { fetchImpl: provider(calls) });
        const first = await adapter.queryIds([id]);
        const second = await factory(descriptor, { fetchImpl: provider(calls) }).queryIds([id]);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features.map(f => f.id), [id]);
        assert.deepEqual(first.absentIds, []);
        assert.equal(calls[0].get('cql_filter'), `pnu IN ('${nativeId}')`);
        const missing = descriptor.idPrefix + '2711015600199999999';
        const absent = await adapter.queryIds([missing]);
        assert.equal(absent.complete, true);
        assert.deepEqual(absent.features, []);
        assert.deepEqual(absent.absentIds, [missing]);
        await assert.rejects(adapter.queryIds([descriptor.idPrefix + '1']), /Invalid parcel ID/);
        await assert.rejects(adapter.queryIds(['FOREIGN-' + nativeId]), /different source/);
        assert.equal(calls.length, 3);
    });
    test(`${name} preserves PNU identity when provider row identifiers are reassigned`, async () => {
        const calls = [];
        const read = provider(calls);
        let generation = 0;
        const fetchImpl = async url => {
            const payload = await (await read(url)).json();
            for (const feature of payload.features) {
                feature.id = `LSMD_CONT_LDREG.${++generation}`;
            }
            return new Response(JSON.stringify(payload));
        };
        const first = await factory(descriptor, { fetchImpl }).queryIds([id]);
        const second = await factory(descriptor, { fetchImpl }).queryIds([id]);
        assert.equal(generation, 2);
        assert.deepEqual(first.features, second.features);
        assert.equal(first.features[0].id, id);
        assert.equal(first.features[0].properties.sourceParcelId, nativeId);
        assert.deepEqual(first.features[0].properties.sourceProperties, { pnu: nativeId });
        assert.ok(calls.every(params => params.get('propertyName') === 'geom,pnu'));
    });
}

test('bounds intersection setting fails closed on invalid configuration', () => {
    assert.throws(() => createParcelSource({ ...descriptor, filterBoundsGeometry: 'true' }), /Invalid WFS/);
});

test('conflicting duplicate native PNU geometries fail closed', async () => {
    const features = structuredClone(native.features.slice(0, 2));
    features[1].properties.pnu = features[0].properties.pnu;
    const adapter = createParcelSource({ ...descriptor, pageSize: 100 }, { fetchImpl: async () =>
        new Response(JSON.stringify({ ...native, features, totalFeatures: 2, numberMatched: 2, numberReturned: 2 })) });
    await assert.rejects(adapter.queryBounds(bounds), /conflicting geometry/);
});
