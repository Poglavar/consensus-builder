// Exercises the national BoFiNet LAPCAS descriptor through the production ArcGIS adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bw-bofinet-botswana-lapcas-plots.json', import.meta.url)));
const descriptor = fixture.descriptor;
const ids = fixture.response.features.map(row => descriptor.idPrefix + row.attributes.FID);

function provider({ incompleteManifest = false, transferLimit = false, omittedGeometry = false,
    wrongCrs = false, foreignObject = false, httpStatus = 200 } = {}) {
    const rows = structuredClone(fixture.response.features), calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        // No pagination, ordering, simplification, rounding or extra attributes are supported.
        for (const key of ['resultOffset', 'resultRecordCount', 'orderByFields', 'geometryPrecision',
            'maxAllowableOffset', 'quantizationParameters']) assert.equal(params.has(key), false);
        assert.equal(params.get('f'), 'json');
        if (httpStatus !== 200) return { ok: false, status: httpStatus };
        const where = params.get('where');
        const requested = /^FID IN \(([\d,]+)\)$/.exec(where)?.[1].split(',').map(Number);
        const selected = requested ? rows.filter(row => requested.includes(row.attributes.FID)) : rows;
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: selected.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'FID', objectIds: selected.slice(incompleteManifest ? 1 : 0).map(row => row.attributes.FID)
        };
        else {
            assert.equal(params.get('outFields'), 'FID');
            assert.equal(params.get('returnGeometry'), 'true');
            assert.equal(params.get('outSR'), '4326');
            const objects = params.get('objectIds').split(',').map(Number);
            const features = structuredClone(rows.filter(row => objects.includes(row.attributes.FID)));
            if (foreignObject && features.length) features[0].attributes.FID = 999999999;
            payload = { ...fixture.response, features: omittedGeometry ? features.slice(1) : features,
                exceededTransferLimit: transferLimit,
                spatialReference: { wkid: wrongCrs ? 3857 : 4326 } };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    };
    return { rows, calls, source: createParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl }) };
}

test('national-layer identity stays distinct from the enabled city-specific service', () => {
    assert.equal(descriptor.id, 'bw-bofinet-botswana-lapcas-plots');
    assert.equal(descriptor.endpoint, 'https://bofinetarcgisportal.bofinet.co.bw/server/rest/services/PUBLIC/BOTSWANA_PLOTS/MapServer/0');
    assert.equal(descriptor.idPrefix, 'bofinet:Botswana_PLOTS:FID:');
    assert.equal(descriptor.defaultForCity, false);
    assert.deepEqual(descriptor.outFields, ['FID']);
});

test('fresh exact-ID reads return the same full rings with canonical native FIDs', async () => {
    const { source, rows, calls } = provider();
    const first = await source.queryIds(ids);
    const second = await source.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features, second.features);
    assert.deepEqual(first.features.map(row => row.id), ids);
    for (let i = 0; i < rows.length; i++) {
        const feature = first.features[i];
        assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: rows[i].geometry.rings });
        assert.equal(feature.properties.sourceParcelId, String(rows[i].attributes.FID));
        assert.equal(feature.properties.sourceId, descriptor.id);
        assert.deepEqual(feature.properties.sourceProperties, { FID: rows[i].attributes.FID });
    }
    assert.equal(calls.length, 10);
    assert.equal(calls[0].get('where'), `FID IN (${rows.map(row => row.attributes.FID).join(',')})`);
    assert.equal(calls.filter(call => call.has('objectIds')).length, 6);
});

test('bounded enumeration validates the count and manifest then retains uncut polygons', async () => {
    const { source, rows, calls } = provider();
    const bbox = [25.857, -24.636, 25.861, -24.632];
    const result = await source.queryBounds(bbox);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(row => row.geometry.coordinates), rows.map(row => row.geometry.rings));
    assert.equal(calls[0].get('geometry'), bbox.join(','));
    assert.equal(calls[0].get('inSR'), '4326');
    assert.equal(calls[0].get('spatialRel'), 'esriSpatialRelIntersects');
    assert.equal(calls.length, 5);
});

test('incomplete manifests, missing polygons, transfer limits and foreign OIDs fail closed', async () => {
    await assert.rejects(provider({ incompleteManifest: true }).source.queryIds(ids), /object-ID list/);
    await assert.rejects(provider({ omittedGeometry: true }).source.queryIds(ids), /incomplete object-ID/);
    await assert.rejects(provider({ transferLimit: true }).source.queryIds(ids), /incomplete object-ID/);
    await assert.rejects(provider({ foreignObject: true }).source.queryIds(ids), /object ID/);
    await assert.rejects(provider({ wrongCrs: true }).source.queryIds(ids), /Esri parcel polygon collection/);
});

test('explicit complete absence is distinct from provider access failure', async () => {
    const { source } = provider();
    const absent = descriptor.idPrefix + '2147483647';
    const result = await source.queryIds([absent]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [absent]);
    await assert.rejects(provider({ httpStatus: 403 }).source.queryIds([absent]), error =>
        error.code === 'parcel-source-blocked' && error.upstreamStatus === 403);
});

test('foreign namespaces and malformed FIDs fail before requesting the provider', async () => {
    const { source, calls } = provider();
    for (const id of ['gaborone:bofinet:11324', descriptor.idPrefix + '01', descriptor.idPrefix + '-1',
        descriptor.idPrefix + "11324 OR 1=1", descriptor.idPrefix + '9007199254740992']) {
        await assert.rejects(source.queryIds([id]), /different source|Invalid parcel ID/);
    }
    assert.equal(calls.length, 0);
});
