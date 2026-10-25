// Exercises Divo's streaming XML privacy boundary and fresh spatial exact reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDivoEcommunesSource, parseDivoPolygon } from '../parcels/divo-ecommunes-source.js';
import { createParcelSource } from '../parcels/sources.js';

const nativeId = 'E18CBD07CCEB4212A0DA05942DADD590';
const prefix = 'ci-divo-ecommunes/Parcellaire/feature-id/';
const id = prefix + nativeId;
const nativeWkt = 'POLYGONZM ((237000 646900 0 -1.79769313486232E+308,237020 646900 0 -1.79769313486232E+308,237020 646920 0 -1.79769313486232E+308,237000 646900 0 -1.79769313486232E+308))';
const descriptor = {
    id: 'ci-divo-ecommunes-parcellaire', adapter: 'divo-ecommunes-xml', idPrefix: prefix,
    endpoint: 'https://divo.ecommunes.ci/MapServer/AgentLot.aspx/Query', layer: 'Parcellaire',
    sourceCrs: 'EPSG:32630', outFields: [], nativeExtent: [235273,641461,241423,648095],
    idLookupBoundsNative: { [nativeId]: [236400,646400,237400,647400] }
};
const xml = (wkt = nativeWkt, featureId = nativeId) => `<?xml version="1.0"?><result><Feature ID="${featureId}"><Geometry><![CDATA[${wkt}]]></Geometry><Values><Ignored>discarded</Ignored></Values></Feature></result>`;

test('factory reads native GUID and every XY vertex, discards Values, and fetches again for exact reads', async () => {
    const requests = [];
    const source = createParcelSource(descriptor, { fetchImpl: async (url, options) => {
        requests.push({ url: new URL(url), options });
        return new Response(xml(), { headers: { 'content-type': 'text/xml' } });
    } });
    const one = await source.queryIds([id]);
    const two = await source.queryIds([id]);
    assert.equal(requests.length, 2);
    assert.equal(one.complete, true);
    assert.deepEqual(one.absentIds, []);
    assert.deepEqual(one.features, two.features);
    assert.equal(one.features[0].id, id);
    assert.equal(one.features[0].properties.sourceParcelId, nativeId);
    assert.deepEqual(one.features[0].properties.sourceProperties, {});
    assert.equal(JSON.stringify(one).includes('discarded'), false);
    assert.equal(one.features[0].geometry.coordinates[0].length, 4);
    assert.equal(one.features[0].geometry.coordinates[0][0].length, 2);
    assert.ok(Math.abs(one.features[0].geometry.coordinates[0][0][0] + 5.375) < 0.01);
    assert.deepEqual([...requests[0].url.searchParams.keys()], ['layer', 'geom']);
    assert.equal(requests[0].url.searchParams.get('layer'), 'Parcellaire');
    assert.equal(requests[0].options.cache, 'no-store');
});

test('reread returns changed source coordinates rather than cached geometry', async () => {
    let reads = 0;
    const source = createDivoEcommunesSource(descriptor, { fetchImpl: async () => new Response(xml(++reads === 1
        ? nativeWkt : nativeWkt.replaceAll('237000', '237001'))) });
    const one = await source.queryIds([id]), two = await source.queryIds([id]);
    assert.notDeepEqual(one.features[0].geometry, two.features[0].geometry);
});

test('unknown or locally missing GUIDs remain unresolved; empty XML never proves source-wide absence', async () => {
    let reads = 0;
    const source = createDivoEcommunesSource(descriptor, { fetchImpl: async () => { reads++; return new Response('<result/>'); } });
    const missing = await source.queryIds([id]);
    assert.equal(missing.complete, false);
    assert.deepEqual(missing.absentIds, []);
    assert.deepEqual(missing.unresolvedIds, [id]);
    const unknown = prefix + '00000000000000000000000000000000';
    assert.equal((await source.queryIds([unknown])).complete, false);
    assert.equal(reads, 1);
    await assert.rejects(source.queryIds([id + "' OR 1=1"]), /unique Divo/);
    assert.equal(reads, 1);
});

test('partition-checked bounded transfers do not claim complete area coverage, and supply locators for fresh ID reads', async () => {
    const source = createDivoEcommunesSource({ ...descriptor, idLookupBoundsNative: {} }, { fetchImpl: async () => new Response(xml()) });
    const result = await source.queryBounds([-5.376,5.847,-5.375,5.848]);
    assert.equal(result.complete, true);
    assert.equal(result.areaComplete, false);
    assert.equal(result.authoritativeAbsence, false);
    assert.equal(result.nativeQueries, 3);
    assert.ok(result.features.length);
    assert.equal((await source.queryIds([id])).complete, true);
});

test('partition disagreement retains every observed polygon but leaves the transfer incomplete', async () => {
    let reads = 0;
    const source = createDivoEcommunesSource(descriptor, { fetchImpl: async () => new Response(++reads === 1 ? '<result/>' : xml()) });
    const result = await source.queryBounds([-5.376,5.847,-5.375,5.848]);
    assert.equal(result.complete, false);
    assert.equal(result.features.length, 1);
});

test('retries a transient server failure once and never retries an access denial', async () => {
    let reads = 0;
    const source = createDivoEcommunesSource(descriptor, { fetchImpl: async () => ++reads === 1
        ? new Response('', { status: 500 }) : new Response(xml()) });
    assert.equal((await source.queryIds([id])).complete, true);
    assert.equal(reads, 2);
    reads = 0;
    const denied = createDivoEcommunesSource(descriptor, { fetchImpl: async () => { reads++; return new Response('', { status: 403 }); } });
    await assert.rejects(denied.queryIds([id]));
    assert.equal(reads, 1);
});

test('parser retains holes and ring order without closing, simplifying or repairing polygons', () => {
    const polygon = parseDivoPolygon('POLYGONZM ((1 2 0 0,4 2 0 0,4 5 0 0,1 2 0 0),(2 3 0 0,3 3 0 0,2 4 0 0,2 3 0 0))');
    assert.deepEqual(polygon.coordinates, [[[1,2],[4,2],[4,5],[1,2]],[[2,3],[3,3],[2,4],[2,3]]]);
    assert.throws(() => parseDivoPolygon('POINT(1 2)'), /unsupported/);
});

test('rejects XML service errors, malformed/duplicate IDs, unclosed rings, entities and byte overruns', async () => {
    for (const body of ['<html/>', '<result><Error/></result>', xml(nativeWkt, 'unsafe'),
        '<result>' + xml().split('<result>')[1].replace('</result>', '') .repeat(2) + '</result>',
        xml(nativeWkt.replace(/,237000 646900 0 -1.79769313486232E\+308\)\)/, '))')),
        '<!DOCTYPE result [<!ENTITY x "bad">]><result/>', '<result><Feature', '<result/>trailing']) {
        const source = createDivoEcommunesSource(descriptor, { fetchImpl: async () => new Response(body) });
        await assert.rejects(source.queryIds([id]));
    }
    const source = createDivoEcommunesSource({ ...descriptor, maxResponseBytes: 1024 }, { fetchImpl: async () => new Response(' '.repeat(1025)) });
    await assert.rejects(source.queryIds([id]), /byte limit/);
});

test('rejects foreign endpoints and upstream HTTP errors', async () => {
    assert.throws(() => createDivoEcommunesSource({ ...descriptor, endpoint: 'https://example.org' }), /descriptor/);
    const source = createDivoEcommunesSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) });
    await assert.rejects(source.queryIds([id]), error => error.upstreamStatus === 403);
});
