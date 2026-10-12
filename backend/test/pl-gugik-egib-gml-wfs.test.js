// GUGiK's national collective EGiB WFS profile: PUWG 1992 N,E geometry, TERYT identity, and the
// one-request completeness its pages allow when they state the whole set's match count.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createGmlWfsParcelSource } from '../parcels/gml-wfs-source.js';
import { POLAND_EGIB_GML_SCHEMA, parseGmlParcels } from '../parcels/gml-parcel-reader.js';

const ID = '280503_2.0014.63', ID2 = '280503_2.0014.64', PREFIX = 'PL-EGIB-';
const descriptor = {
    id: 'pl-gugik-egib-wfs', adapter: 'gml-wfs', version: '2.0.0',
    endpoint: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/EGIB/WFS/UslugaZbiorcza', featureType: 'ms:dzialki',
    idField: 'ID_DZIALKI', geometryField: 'geom', responseCrs: 'EPSG:2180',
    idPrefix: PREFIX, idType: 'string', parcelNumberField: 'ID_DZIALKI', outFields: ['ID_DZIALKI'],
    pageSize: 100, maxFeatures: 1500, maxBboxKm2: 1
};
// Opening vertices of a raw 2026-10-12 response (northing easting), closed for the fixture.
const ring = '672980.019 744264.056 673213.298 744202.973 673011.733 743772.879 672789.342 743841.187 672980.019 744264.056';
function member(id = ID) {
    return `<wfs:member><ms:dzialki gml:id="dzialki.${id}"><ms:geom><gml:Polygon gml:id="dzialki.${id}.1" srsName="urn:ogc:def:crs:EPSG::2180"><gml:exterior><gml:LinearRing><gml:posList srsDimension="2">${ring}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></ms:geom><ms:ID_DZIALKI>${id}</ms:ID_DZIALKI></ms:dzialki></wfs:member>`;
}
function collection(ids, matched, returned = ids.length) {
    return `<wfs:FeatureCollection xmlns:ms="${POLAND_EGIB_GML_SCHEMA.featureNamespace}" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${matched}" numberReturned="${returned}">${ids.map(id => member(id)).join('')}</wfs:FeatureCollection>`;
}
const response = xml => new Response(xml, { headers: { 'content-type': 'text/xml; subtype="gml/3.2.1"; charset=UTF-8' } });
// The collective service states numberMatched only when one page holds the whole set.
function transport(ids, { statesCount = true } = {}) {
    const requests = [];
    const fetchImpl = async url => {
        const u = new URL(url); requests.push(u);
        if (u.searchParams.get('resultType') === 'hits') return response(collection([], ids.length, 0));
        const start = Number(u.searchParams.get('startIndex')), count = Number(u.searchParams.get('count'));
        const page = ids.slice(start, start + count);
        const whole = statesCount && start === 0 && page.length === ids.length;
        return response(collection(page, whole ? ids.length : 'unknown'));
    };
    return { fetchImpl, requests };
}

test('parses the collective layer in PUWG 1992 with northing-easting axes and TERYT identity', async () => {
    const parsed = await parseGmlParcels(collection([ID], 1), { schema: POLAND_EGIB_GML_SCHEMA });
    assert.equal(parsed.features[0].id, ID);
    assert.equal(parsed.sourceCrs, 'EPSG:2180');
    const [lon, lat] = parsed.features[0].geometry.coordinates[0][0];
    const [expectedLon, expectedLat] = proj4('EPSG:2180', 'EPSG:4326', [744264.056, 672980.019]);
    assert.ok(Math.abs(lon - expectedLon) < 1e-9 && Math.abs(lat - expectedLat) < 1e-9);
    // TERYT 2805 is Ełk county: the swapped axis order would put the parcel 70 km north.
    assert.ok(Math.abs(lon - 22.716) < 0.001 && Math.abs(lat - 53.864) < 0.001);
});

test('reads a cell in one request when the page states the whole set\'s count', async () => {
    const { fetchImpl, requests } = transport([ID, ID2]);
    const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
    const result = await source.queryBounds([22.705, 53.862, 22.715, 53.866]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('resultType'), null);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(feature => feature.id).sort(), [`${PREFIX}${ID}`, `${PREFIX}${ID2}`]);
    const exact = transport([ID]);
    const ids = await createGmlWfsParcelSource(descriptor, { fetchImpl: exact.fetchImpl }).queryIds([`${PREFIX}${ID}`]);
    assert.equal(exact.requests.length, 1);
    assert.deepEqual(ids.features.map(feature => feature.id), [`${PREFIX}${ID}`]);
});

test('falls back to the counted, paged read when the page leaves the count unknown', async () => {
    const many = Array.from({ length: 3 }, (_, index) => `280503_2.0014.${70 + index}`);
    const { fetchImpl, requests } = transport(many, { statesCount: false });
    const source = createGmlWfsParcelSource({ ...descriptor, pageSize: 2, maxFeatures: 100 }, { fetchImpl });
    const result = await source.queryBounds([22.705, 53.862, 22.715, 53.866]);
    assert.equal(result.features.length, 3);
    // The unknown-count first page stays page one: hits, the remaining page, hits; no page twice.
    assert.deepEqual(requests.map(u => u.searchParams.get('resultType') || `page@${u.searchParams.get('startIndex')}`),
        ['page@0', 'hits', 'page@2', 'hits']);
});

test('an absent ID is not proven by a page that leaves the count unknown', async () => {
    const { fetchImpl, requests } = transport([], { statesCount: false });
    const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
    const result = await source.queryIds([`${PREFIX}280503_2.0014.999998`]);
    assert.deepEqual(result.absentIds, [`${PREFIX}280503_2.0014.999998`]);
    assert.ok(requests.some(u => u.searchParams.get('resultType') === 'hits'));
});

// GUGiK resets about 1% of connections before answering; the relay reports such a read as 502.
function flaky(failures, ids = [ID]) {
    const { fetchImpl: answer, requests } = transport(ids);
    const queue = [...failures];
    const fetchImpl = async (url, init) => {
        const next = queue.shift();
        if (next === 'reset') { requests.push(new URL(url)); throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }
        if (Number.isInteger(next)) { requests.push(new URL(url)); return new Response('{"error":"Parcel provider is unavailable."}', { status: next }); }
        return answer(url, init);
    };
    return { fetchImpl, requests };
}

test('a read GUGiK dropped before answering is sent once more', async () => {
    for (const failure of ['reset', 502]) {
        const { fetchImpl, requests } = flaky([failure]);
        const result = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryBounds([22.705, 53.862, 22.715, 53.866]);
        assert.equal(requests.length, 2);
        assert.deepEqual(result.features.map(feature => feature.id), [`${PREFIX}${ID}`]);
    }
    const twice = flaky(['reset', 'reset']);
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl: twice.fetchImpl }).queryBounds([22.705, 53.862, 22.715, 53.866]),
        error => error.code === 'parcel-source-unavailable' && error.upstreamStatus === undefined);
    assert.equal(twice.requests.length, 2);
    // An answer is never repeated: a refusal or an overloaded service stands.
    for (const status of [403, 503]) {
        const answered = flaky([status]);
        await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl: answered.fetchImpl }).queryBounds([22.705, 53.862, 22.715, 53.866]),
            error => error.upstreamStatus === status);
        assert.equal(answered.requests.length, 1);
    }
});

test('only this profile may read pages of up to 1000 rows', () => {
    assert.doesNotThrow(() => createGmlWfsParcelSource({ ...descriptor, pageSize: 500, maxResponseBytes: 2 * 1024 * 1024 }, { fetchImpl: async () => {} }));
    assert.throws(() => createGmlWfsParcelSource({ ...descriptor, pageSize: 1001 }, { fetchImpl: async () => {} }), /Invalid GML WFS/);
    const gdansk = { id: 'gdansk-gml-wfs', adapter: 'gml-wfs', version: '2.0.0', endpoint: 'https://ewid-wms.gdansk.gda.pl/iip/ows',
        featureType: 'ms:dzialki', idField: 'ID_DZIALKI', geometryField: 'geometry', responseCrs: 'EPSG:2177', idPrefix: 'PL-GDANSK-',
        idType: 'string', parcelNumberField: 'ID_DZIALKI', outFields: ['ID_DZIALKI'], maxFeatures: 300 };
    assert.doesNotThrow(() => createGmlWfsParcelSource({ ...gdansk, pageSize: 100 }, { fetchImpl: async () => {} }));
    assert.throws(() => createGmlWfsParcelSource({ ...gdansk, pageSize: 500 }, { fetchImpl: async () => {} }), /Invalid GML WFS/);
});
