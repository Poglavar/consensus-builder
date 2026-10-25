// Exercise Kigoma's WFS 2 transport paging and native UUID identity through both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/tz-kigoma-qualified-safe.json', import.meta.url)));
const { descriptor, features, crs } = fixture;
const ids = features.map(feature => descriptor.idPrefix + feature.properties.uid);

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`Kigoma ${runtime} pages by numeric id and rereads native UUID polygons unchanged`, async () => {
        const requests = [];
        const source = factory({ ...descriptor, pageSize: 2, minRequestIntervalMs: undefined }, {
            fetchImpl: async input => {
                const url = new URL(input), params = url.searchParams;
                requests.push(url);
                const filter = params.get('cql_filter');
                const selected = filter ? features.filter(feature => filter.includes(`'${feature.properties.uid}'`)) : features;
                const offset = Number(params.get('startIndex'));
                const page = selected.slice(offset, offset + Number(params.get('count')));
                return new Response(JSON.stringify({ type: 'FeatureCollection', crs,
                    numberMatched: selected.length, numberReturned: page.length,
                    features: page.map((feature, index) => ({ ...feature,
                        id: `qualified_spatial_units.fid-${requests.length}-${index}` })) }));
            }
        });
        const bounds = await source.queryBounds([29.642, -4.891, 29.643, -4.890]);
        const first = await source.queryIds(ids);
        const second = await source.queryIds(ids);
        assert.equal(bounds.complete, true);
        assert.deepEqual(bounds.features, first.features);
        assert.deepEqual(first, second);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(feature => feature.id), ids);
        assert.deepEqual(first.features.map(feature => feature.geometry), features.map(feature => feature.geometry));
        assert.deepEqual(first.features.map(feature => feature.properties.sourceProperties),
            features.map(feature => ({ uid: feature.properties.uid })));
        assert.deepEqual(requests.map(url => url.searchParams.get('startIndex')), ['0', '2', '0', '2', '0', '2']);
        for (const url of requests) {
            assert.equal(url.origin + url.pathname, descriptor.endpoint);
            assert.equal(url.searchParams.get('version'), '2.0.0');
            assert.equal(url.searchParams.get('typeNames'), 'taspro:qualified_spatial_units');
            assert.equal(url.searchParams.get('sortBy'), 'id');
            assert.equal(url.searchParams.get('propertyName'), 'geom,uid');
            assert.equal(url.searchParams.get('srsName'), 'CRS:84');
        }
        const count = requests.length;
        await assert.rejects(source.queryIds([descriptor.idPrefix + "' OR 1=1"]));
        await assert.rejects(source.queryIds(['another-source/uuid']));
        assert.equal(requests.length, count);
    });

    test(`Kigoma ${runtime} rejects conflicting UUID geometry without altering either polygon`, async () => {
        const changed = structuredClone(features[0]);
        changed.geometry.coordinates[0][0][1][0] += 0.00001;
        const before = structuredClone([features[0], changed]);
        const source = factory({ ...descriptor, minRequestIntervalMs: undefined }, {
            fetchImpl: async () => new Response(JSON.stringify({ type: 'FeatureCollection', crs,
                numberMatched: 2, numberReturned: 2,
                features: [{ ...features[0], id: 'transport-a' }, { ...changed, id: 'transport-b' }] }))
        });
        await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
        assert.deepEqual([features[0], changed], before);
    });
}
