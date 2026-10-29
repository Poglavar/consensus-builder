// Bremen WFS2 identity, unchanged coordinates and independently counted unpaged reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BREMEN_GML_SCHEMA, parseGmlParcels } from '../parcels/gml-parcel-reader.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const prefix = 'DE-HB-ALKIS-';
const ids = ['043088088002710001__', '043088088002710003__'];
const descriptor = {
    id: 'de-hb-alkis-flurstuecke-wfs', adapter: 'gml-wfs', version: '2.0.0',
    endpoint: 'https://geodienste.bremen.de/wfs_hduk2958loah3976niun',
    featureType: 'app:flurstuecke', idField: 'flstkennz', geometryField: 'geom',
    responseCrs: 'EPSG:4326', idPrefix: prefix, idType: 'string',
    parcelNumberField: 'flstkennz', outFields: ['flstkennz'], pageSize: 1,
    maxFeatures: 30, maxBboxKm2: 1
};
const ring = [[8.8321, 53.0805], [8.8322, 53.0805], [8.8322, 53.0806], [8.8321, 53.0805]];
const hole = [[8.83215, 53.08051], [8.83218, 53.08051], [8.83218, 53.08052], [8.83215, 53.08051]];
const linear = points => `<g:LinearRing><g:posList>${points.flat().join(' ')}</g:posList></g:LinearRing>`;
const surface = () => `<g:surfaceMember><g:Polygon><g:exterior>${linear(ring)}</g:exterior><g:interior>${linear(hole)}</g:interior></g:Polygon></g:surfaceMember>`;
function member(id, extra = '') {
    return `<wfs:member><app:flurstuecke g:id="APP_FLURSTUECKE_1"><app:flstkennz>${id}</app:flstkennz>${extra}<app:geom><g:MultiSurface srsName="EPSG:4326">${surface()}${surface()}</g:MultiSurface></app:geom></app:flurstuecke></wfs:member>`;
}
function collection(members = '', matched = 'unknown', returned = 0) {
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:app="${BREMEN_GML_SCHEMA.featureNamespace}" xmlns:g="${BREMEN_GML_SCHEMA.gmlNamespace}" numberMatched="${matched}" numberReturned="${returned}">${members}</wfs:FeatureCollection>`;
}
const parse = xml => parseGmlParcels(xml, { schema: BREMEN_GML_SCHEMA });
const response = xml => new Response(xml, { headers: { 'content-type': 'application/gml+xml; version=3.2' } });
function transport({ dataIds = ids, hitCount, after, returned = 0 } = {}) {
    let hits = 0;
    const requests = [];
    return { requests, fetchImpl: async url => {
        const u = new URL(url); requests.push(u);
        const literals = [...(u.searchParams.get('filter') || '').matchAll(/<fes:Literal>([^<]+)<\/fes:Literal>/g)].map(m => m[1]);
        const found = literals.length ? dataIds.filter(id => literals.includes(id)) : dataIds;
        const matched = hitCount ?? found.length;
        return response(u.searchParams.get('resultType') === 'hits'
            ? collection('', ++hits === 1 ? matched : (after ?? matched), 0)
            : collection(found.map(id => member(id)).join(''), 'unknown', returned));
    } };
}

test('Bremen parser retains literal WGS84 coordinates, all parts and holes, and only native identity', async () => {
    const result = await parse(collection(member(ids[0], '<app:unused>discard-me</app:unused>')));
    assert.deepEqual(result.features[0].properties, { flstkennz: ids[0] });
    assert.deepEqual(result.features[0].geometry, { type: 'MultiPolygon', coordinates: [[ring, hole], [ring, hole]] });
    assert.ok(!JSON.stringify(result).includes('discard-me'));
    assert.equal(result.declaredNumberReturned, 0);
    assert.equal(result.numberReturned, 1);
    assert.equal(result.numberReturnedProtocolException, 'bremen-deegree-unknown-zero-numberReturned-on-data-response');
    for (const xml of [collection(member(ids[0]), 1, 0), collection(member(ids[0]), 'unknown', 2),
        collection(member(ids[0])).replace('EPSG:4326', 'EPSG:25832'),
        collection(member(ids[0])).replace('<app:flstkennz>', '<app:other><app:flstkennz>').replace('</app:flstkennz>', '</app:flstkennz></app:other>'),
        collection(member(ids[0])).replace('</g:MultiSurface>', '<g:surfaceMember/></g:MultiSurface>'),
        collection(member(ids[0])).replace('<app:geom>', '<app:geom xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#other">')]) {
        await assert.rejects(parse(xml));
    }
});

test('backend and browser factories read exact IDs using safe FES predicates and pre/post counts', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['gml-wfs']]) {
        const io = transport();
        const result = await factory(descriptor, io).queryIds([prefix + ids[0], prefix + ids[1]]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(f => f.id), ids.map(id => prefix + id));
        assert.deepEqual(result.features[0].properties.sourceProperties, { flstkennz: ids[0] });
        assert.equal(io.requests.length, 6); // pageSize=1 means singleton exact predicates.
        for (const u of io.requests) {
            assert.equal(u.searchParams.get('propertyName'), 'app:flstkennz,app:geom');
            assert.equal(u.searchParams.get('srsName'), 'EPSG:4326');
            assert.ok(u.searchParams.get('filter').includes('<fes:ValueReference>app:flstkennz</fes:ValueReference>'));
            assert.equal(u.searchParams.has('startIndex'), false);
        }
    }
});

test('bounded area reads return the whole match set without paging and fail on truncation or mutation', async () => {
    const io = transport();
    const result = await createParcelSource(descriptor, io).queryBounds([8.832, 53.0804, 8.8323, 53.0807]);
    assert.equal(result.features.length, 2);
    for (const [key, value] of Object.entries({ paging: false, matchedBefore: 2, matchedAfter: 2, parsedFeatureCount: 2 })) {
        assert.equal(result.completenessEvidence[key], value);
    }
    assert.equal(io.requests[1].searchParams.get('count'), '2');
    assert.equal(io.requests[1].searchParams.get('bbox'), '8.832,53.0804,8.8323,53.0807,EPSG:4326');
    for (const options of [{ hitCount: 3 }, { after: 3 }, { returned: 1 }]) {
        await assert.rejects(createParcelSource(descriptor, transport(options)).queryBounds([8.832, 53.0804, 8.8323, 53.0807]));
    }
    const oversized = transport({ hitCount: 31 });
    await assert.rejects(createParcelSource(descriptor, oversized).queryBounds([8.832, 53.0804, 8.8323, 53.0807]), /parcel limit/);
    assert.equal(oversized.requests.length, 1);
});

test('wrong native IDs and descriptor drift fail closed, while repeated zero hits prove absence', async () => {
    const validIo = { fetchImpl: async url => response(new URL(url).searchParams.get('resultType') === 'hits'
        ? collection('', 1, 0) : collection(member(ids[0]))) };
    await assert.rejects(createParcelSource(descriptor, validIo).queryIds([prefix + ids[1]]), /unexpected native/);
    const emptyIo = transport({ dataIds: [] });
    const absent = await createParcelSource(descriptor, emptyIo).queryIds([prefix + ids[0]]);
    assert.deepEqual(absent.absentIds, [prefix + ids[0]]);
    assert.equal(emptyIo.requests.length, 2);
    assert.throws(() => createParcelSource({ ...descriptor, outFields: ['flstkennz', 'aktualit'] }));
    assert.throws(() => createParcelSource({ ...descriptor, endpoint: descriptor.endpoint + '/other' }));
    const invalid = transport();
    await assert.rejects(createParcelSource(descriptor, invalid).queryIds([prefix + 'unsafe']), /Invalid parcel ID/);
    assert.equal(invalid.requests.length, 0);
});
