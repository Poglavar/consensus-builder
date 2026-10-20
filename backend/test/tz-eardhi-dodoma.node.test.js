// Verifies the production WFS reader against Dodoma's safe UUID/geometry response contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/tz-eardhi-dodoma.json', import.meta.url)));
const descriptor = fixture.descriptor;
const ids = fixture.features.map(feature => descriptor.idPrefix + feature.properties.uid);
const absentId = descriptor.idPrefix + '00000000-0000-0000-0000-000000000000';

function provider({ mutate = payload => payload } = {}) {
    const requests = [];
    const fetchImpl = async input => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint);
        const p = url.searchParams;
        requests.push(p);
        assert.equal(p.get('version'), '1.0.0');
        assert.equal(p.get('typeName'), 'taspro:spatial_units36');
        assert.equal(p.get('propertyName'), 'geom,uid');
        assert.equal(p.get('srsName'), 'EPSG:4326');
        assert.equal(p.get('sortBy'), 'uid');
        assert.equal(p.get('count'), p.get('maxFeatures'));
        const selected = fixture.features.filter(feature => !p.has('cql_filter')
            || p.get('cql_filter').includes(`'${feature.properties.uid}'`));
        const offset = Number(p.get('startIndex'));
        const features = structuredClone(selected.slice(offset, offset + Number(p.get('maxFeatures'))));
        for (const [index, feature] of features.entries()) {
            // GeoTools' changing transport IDs must never replace the stable native UUID.
            feature.id = `spatial_units36.fid-6adb7e67_1a151022162_-${requests.length * 10 + index}`;
        }
        return new Response(JSON.stringify(mutate({ type: 'FeatureCollection', features,
            totalFeatures: selected.length, numberMatched: selected.length, numberReturned: features.length,
            crs: fixture.crs }, requests.length)), { headers: { 'Content-Type': 'application/json' } });
    };
    return { requests, fetchImpl };
}

test('Dodoma production factory repeats exact UUID reads and preserves every source coordinate', async () => {
    const mock = provider();
    for (let read = 0; read < 2; read++) {
        const result = await createParcelSource(descriptor, mock).queryIds(ids);
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(feature => feature.id), ids);
        for (const [index, feature] of result.features.entries()) {
            assert.deepEqual(feature.geometry, fixture.features[index].geometry);
            assert.deepEqual(feature.properties.sourceProperties, { uid: fixture.features[index].properties.uid });
            assert.equal(feature.properties.sourceParcelId, fixture.features[index].properties.uid);
        }
    }
    assert.equal(mock.requests.length, 2);
});

test('Dodoma bounds use explicit geographic axes and complete sorted page-size-one reads', async () => {
    const mock = provider();
    const result = await createParcelSource({ ...descriptor, pageSize: 1 }, mock)
        .queryBounds([35.733, -6.173, 35.753, -6.153]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(feature => feature.id), ids);
    assert.deepEqual(mock.requests.map(p => p.get('startIndex')), ['0', '1', '2']);
    assert.ok(mock.requests.every(p => p.get('bbox') === '35.733,-6.173,35.753,-6.153,EPSG:4326'));
    assert.deepEqual(result.features.map(feature => feature.geometry), fixture.features.map(feature => feature.geometry));
});

test('Dodoma geometry queries filter returned parcels without clipping the source polygon', async () => {
    const mock = provider();
    const result = await createParcelSource(descriptor, mock).queryGeometry(fixture.features[0].geometry);
    assert.deepEqual(result.features.map(feature => feature.id), [ids[0]]);
    assert.deepEqual(result.features[0].geometry, fixture.features[0].geometry);
});

test('Dodoma reports complete absence through the UUID attribute route', async () => {
    const mock = provider();
    const result = await createParcelSource(descriptor, mock).queryIds([absentId]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [absentId]);
    assert.equal(mock.requests[0].get('cql_filter'), "uid IN ('00000000-0000-0000-0000-000000000000')");
});

test('Dodoma rejects foreign IDs and CQL syntax before making a source request', async () => {
    const mock = provider();
    const source = createParcelSource(descriptor, mock);
    await assert.rejects(source.queryIds(['foreign/' + fixture.features[0].properties.uid]), /different source/);
    await assert.rejects(source.queryIds([descriptor.idPrefix + "' OR 1=1"]), /Invalid parcel ID/);
    assert.equal(mock.requests.length, 0);
});

test('Dodoma rejects a missing UUID or an unusable source polygon', async t => {
    for (const [name, alter, error] of [
        ['UUID', feature => { delete feature.properties.uid; }, /missing or invalid native parcel ID/],
        ['geometry', feature => { feature.geometry = { type: 'MultiPolygon', coordinates: [] }; }, /invalid polygon geometry/]
    ]) await t.test(name, async () => {
        const mock = provider({ mutate: payload => { alter(payload.features[0]); return payload; } });
        await assert.rejects(createParcelSource(descriptor, mock).queryIds(ids), error);
    });
});

test('Dodoma refuses incomplete pagination instead of publishing a partial collection', async () => {
    const mock = provider({ mutate: (payload, read) => read === 2
        ? { ...payload, features: [], numberReturned: 0 } : payload });
    await assert.rejects(createParcelSource({ ...descriptor, pageSize: 1 }, mock).queryIds(ids), /incomplete pagination/);
    assert.equal(mock.requests.length, 2);
});

test('Dodoma refuses different geometry under one UUID across pages', async () => {
    const mock = provider({ mutate: (payload, read) => {
        if (read === 2) payload.features[0].properties.uid = fixture.features[0].properties.uid;
        return payload;
    } });
    await assert.rejects(createParcelSource({ ...descriptor, pageSize: 1 }, mock).queryIds(ids), /conflicting geometry/);
});
