// Verify safe Mbeya UUID reads, sorted WFS paging and unchanged polygons through both runtime factories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/tz-eardhi-survey/geometry-only.json', import.meta.url)));
const { descriptor, features, crs } = fixture;
const ids = features.map(feature => descriptor.idPrefix + feature.properties.uid);

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`e-Ardhi ${runtime} uses native UUIDs and safe fields across exact reads and pages`, async () => {
        const requests = [];
        const source = factory({ ...descriptor, pageSize: 2, minRequestIntervalMs: undefined }, { fetchImpl: async input => {
            const url = new URL(input);
            requests.push(url);
            const filter = url.searchParams.get('cql_filter');
            const selected = filter ? features.filter(feature => filter.includes(`'${feature.properties.uid}'`)) : features;
            const offset = Number(url.searchParams.get('startIndex'));
            const page = selected.slice(offset, offset + Number(url.searchParams.get('maxFeatures')));
            return new Response(JSON.stringify({ type: 'FeatureCollection', crs, totalFeatures: selected.length,
                numberMatched: selected.length, numberReturned: page.length,
                // GeoServer transport IDs can change each request; they must never become parcel identity.
                features: page.map((feature, index) => ({ ...feature, id: `transport-${requests.length}-${index}` })) }));
        } });
        const first = await source.queryIds(ids);
        const second = await source.queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features.map(feature => feature.id), ids);
        assert.deepEqual(first.features.map(feature => feature.geometry), features.map(feature => feature.geometry));
        const bounds = await source.queryBounds([33.477, -8.9134, 33.482, -8.909]);
        assert.deepEqual(bounds.features, first.features);
        assert.equal(bounds.complete, true);
        assert.deepEqual(requests.map(url => Number(url.searchParams.get('startIndex'))), [0, 2, 0, 2, 0, 2]);
        for (const url of requests) {
            assert.equal(url.origin + url.pathname, descriptor.endpoint);
            assert.equal(url.searchParams.get('typeName'), 'taspro:survey_spatial_units');
            assert.equal(url.searchParams.get('propertyName'), 'geom,uid');
            assert.equal(url.searchParams.get('sortBy'), 'uid');
            assert.equal(url.searchParams.get('srsName'), 'EPSG:4326');
        }
        assert.deepEqual(Object.keys(first.features[0].properties.sourceProperties), ['uid']);
        const count = requests.length;
        await assert.rejects(source.queryIds([`${descriptor.idPrefix}' OR 1=1`]));
        await assert.rejects(source.queryIds(['foreign/uuid']));
        assert.equal(requests.length, count, 'invalid/foreign IDs fail before a provider request');
    });

    test(`e-Ardhi ${runtime} refuses conflicting UUID geometry instead of discarding overlaps`, async () => {
        const changed = structuredClone(features[0]);
        changed.geometry.coordinates[0][1][0] += 0.00001;
        const source = factory({ ...descriptor, minRequestIntervalMs: undefined }, { fetchImpl: async () => new Response(JSON.stringify({
            type: 'FeatureCollection', crs, totalFeatures: 2, numberMatched: 2, numberReturned: 2,
            features: [{ ...features[0], id: 'transport-a' }, { ...changed, id: 'transport-b' }]
        })) });
        await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
    });
}
