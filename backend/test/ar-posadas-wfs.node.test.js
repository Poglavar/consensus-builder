// Verify the Posadas WFS contract in backend and browser factories without retaining provider polygons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../parcels/portable-hash.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = JSON.parse(readFileSync(new URL('./fixtures/ar-posadas-wfs-descriptor.json', import.meta.url)));
const nativeIds = ['0459009022700080003', '0459009022700080007'];
// Synthetic multipart geometry includes a hole to detect any ring or component loss.
const geometry = { type: 'MultiPolygon', coordinates: [
    [[[-55.911, -27.402], [-55.910, -27.402], [-55.910, -27.401], [-55.911, -27.401], [-55.911, -27.402]],
        [[-55.9108, -27.4018], [-55.9108, -27.4016], [-55.9106, -27.4016], [-55.9106, -27.4018], [-55.9108, -27.4018]]],
    [[[-55.910, -27.401], [-55.9098, -27.401], [-55.9098, -27.4008], [-55.910, -27.4008], [-55.910, -27.401]]]
] };
const rows = nativeIds.map((IDGIS, index) => ({ type: 'Feature', id: `mae_29_publico.${index + 1}`, properties: { IDGIS }, geometry }));
const ids = nativeIds.map(id => `${descriptor.idPrefix}${id}|geom-sha256=${sha256Hex(JSON.stringify(geometry))}`);

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`Posadas ${runtime} preserves leading zeroes and full geometry through exact and paged bounds reads`, async () => {
        const requests = [];
        const source = factory({ ...descriptor, pageSize: 1 }, { fetchImpl: async input => {
            const url = new URL(input);
            requests.push(url);
            assert.equal(url.origin + url.pathname, descriptor.endpoint);
            assert.equal(url.searchParams.get('version'), '1.0.0');
            assert.equal(url.searchParams.get('typeName'), 'geonode:mae_29_publico');
            assert.equal(url.searchParams.get('propertyName'), 'geometry,IDGIS');
            assert.equal(url.searchParams.get('srsName'), 'EPSG:4326');
            assert.equal(url.searchParams.get('sortBy'), 'fid');
            assert.equal(url.searchParams.get('maxFeatures'), '1');
            assert.equal(url.searchParams.get('count'), '1');
            const filter = url.searchParams.get('cql_filter');
            if (filter) assert.equal(filter, "IDGIS IN ('0459009022700080003','0459009022700080007')");
            else assert.equal(url.searchParams.get('bbox'), '-55.912,-27.403,-55.909,-27.4,EPSG:4326');
            const offset = Number(url.searchParams.get('startIndex'));
            return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 2, numberReturned: 1,
                features: rows.slice(offset, offset + 1), crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } } }));
        } });
        const first = await source.queryIds(ids);
        const second = await source.queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features.map(feature => feature.id), ids);
        assert.deepEqual(first.features.map(feature => feature.properties.sourceParcelId), nativeIds);
        assert.deepEqual(first.features.map(feature => feature.geometry), [geometry, geometry]);
        assert.deepEqual(first.features[0].properties.sourceProperties, { IDGIS: nativeIds[0] });
        assert.deepEqual(requests.slice(0, 2).map(url => url.searchParams.get('startIndex')), ['0', '1']);
        const bounded = await source.queryBounds([-55.912, -27.403, -55.909, -27.4]);
        assert.deepEqual(bounded.features, first.features);
        const count = requests.length;
        await assert.rejects(source.queryIds([descriptor.idPrefix + "0459009' OR 1=1"]));
        await assert.rejects(source.queryIds(['FOREIGN-0459009022700080003']));
        assert.equal(requests.length, count);
    });
    test(`Posadas ${runtime} keeps distinct outlines sharing IDGIS and resolves the exact requested outline`, async () => {
        const siblingGeometry = structuredClone(geometry);
        siblingGeometry.coordinates[0][0][1][0] += 0.00001;
        const siblingId = `${descriptor.idPrefix}${nativeIds[0]}|geom-sha256=${sha256Hex(JSON.stringify(siblingGeometry))}`;
        const source = factory(descriptor, { fetchImpl: async () => new Response(JSON.stringify({
            type: 'FeatureCollection', totalFeatures: 2, numberReturned: 2,
            features: [rows[0], { ...rows[0], id: 'mae_29_publico.999', geometry: siblingGeometry }]
        })) });
        const bounds = await source.queryBounds([-55.912, -27.403, -55.909, -27.4]);
        assert.deepEqual(bounds.features.map(feature => feature.id), [ids[0], siblingId]);
        assert.deepEqual(bounds.features.map(feature => feature.geometry), [geometry, siblingGeometry]);
        assert.deepEqual(bounds.features.map(feature => feature.properties.sourceParcelId), [nativeIds[0], nativeIds[0]]);
        const exact = await source.queryIds([siblingId]);
        assert.equal(exact.complete, true);
        assert.deepEqual(exact.features.map(feature => feature.id), [siblingId]);
        assert.deepEqual(exact.features[0].geometry, siblingGeometry);
        assert.deepEqual(exact.absentIds, []);
        assert.deepEqual((await source.queryIds([siblingId])).features, exact.features);
        await assert.rejects(source.queryIds([descriptor.idPrefix + nativeIds[0]]), /Invalid composite/);
    });
    test(`Posadas ${runtime} rejects a repeated composite page`, async () => {
        const source = factory({ ...descriptor, pageSize: 1 }, { fetchImpl: async () => new Response(JSON.stringify({
            type: 'FeatureCollection', totalFeatures: 2, numberReturned: 1, features: [rows[0]]
        })) });
        await assert.rejects(source.queryIds([ids[0]]), /repeated a composite identity page/);
    });
}
