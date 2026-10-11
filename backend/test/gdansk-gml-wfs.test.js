// Gdańsk's verified municipal GML profile: native identity, full geometry and bounded completeness.
import { onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createGmlWfsParcelSource as createSource } from '../parcels/gml-wfs-source.js';
import { createParcelSource as createProductionSource } from '../parcels/sources.js';
import { GDANSK_GML_SCHEMA, parseGmlParcels } from '../parcels/gml-parcel-reader.js';

const ID = '226101_1.0055.284/13', ID2 = '226101_1.0055.284/15', ID3 = '226101_1.0055.279/9';
const MISSING = '226101_1.0055.999999/9999', PREFIX = 'PL-GDANSK-';
// Inject only the clock wait; requests, parsing and budgets remain production code.
const createGmlWfsParcelSource = (d, options) => createSource(d, { ...options, waitImpl: async () => {} });
const createParcelSource = (d, options) => createProductionSource(d, { ...options, waitImpl: async () => {} });
const descriptor = {
    id: 'gdansk-gml-wfs', adapter: 'gml-wfs', version: '2.0.0',
    endpoint: 'https://ewid-wms.gdansk.gda.pl/iip/ows', featureType: 'ms:dzialki',
    idField: 'ID_DZIALKI', geometryField: 'geometry', responseCrs: 'EPSG:2177',
    idPrefix: PREFIX, idType: 'string', parcelNumberField: 'ID_DZIALKI', outFields: ['ID_DZIALKI'],
    pageSize: 1, maxFeatures: 300, maxBboxKm2: 1
};
// Complete posList from a bounded, safe-property publisher response; N,E order.
const ring = '6027150.05 6539660.16 6027144.01 6539659.99 6027142.24 6539660.46 6027141.31 6539661.17 6027139.76 6539662.35 6027140.68 6539663.25 6027128.61 6539683.16 6027132.79 6539686.48 6027156.88 6539698.76 6027162.62 6539683.67 6027166.83 6539672.74 6027167.44 6539671.10 6027157.65 6539665.27 6027156.22 6539666.38 6027153.06 6539661.77 6027150.05 6539660.16';
function member(id = ID, extra = '') {
    return `<wfs:member><m:dzialki g:id="dzialki.589118"><g:boundedBy><g:Envelope srsName="urn:ogc:def:crs:EPSG::2177"><g:lowerCorner>6027128.61 6539659.99</g:lowerCorner><g:upperCorner>6027167.44 6539698.76</g:upperCorner></g:Envelope></g:boundedBy><m:geometry><g:Polygon srsName="urn:ogc:def:crs:EPSG::2177"><g:exterior><g:LinearRing><g:posList srsDimension="2">${ring}</g:posList></g:LinearRing></g:exterior></g:Polygon></m:geometry><m:ID_DZIALKI>${id}</m:ID_DZIALKI>${extra}</m:dzialki></wfs:member>`;
}
function collection(content = '', matched = 'unknown', returned = 1) {
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:m="${GDANSK_GML_SCHEMA.featureNamespace}" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="${matched}" numberReturned="${returned}">${content}</wfs:FeatureCollection>`;
}
const response = xml => new Response(xml, { headers: { 'content-type': 'application/gml+xml; version=3.2' } });
const hits = n => response(collection('', n, 0));
const parse = xml => parseGmlParcels(xml, { schema: GDANSK_GML_SCHEMA });
function transport(ids = [ID, ID2], { before = ids.length, after = before, dataMatched = 'unknown', dataXml } = {}) {
    const requests = []; let hitCalls = 0;
    const fetchImpl = async (url, init) => {
        const u = new URL(url); requests.push({ u, init });
        if (u.searchParams.get('resultType') === 'hits') return hits(++hitCalls === 1 ? before : after);
        const start = Number(u.searchParams.get('startIndex')), count = Number(u.searchParams.get('count'));
        const page = ids.slice(start, start + count);
        return response(dataXml ?? collection(page.map(id => member(id)).join(''), dataMatched, page.length));
    };
    return { fetchImpl, requests };
}

test('Gdańsk parses observed namespace, all vertices and N,E axes, ignoring row gml:id and extra properties', async () => {
    const r = await parse(collection(member(ID, '<m:owner>DO-NOT-RETAIN</m:owner><m:address>DO-NOT-RETAIN</m:address>')));
    assert.equal(r.features[0].id, ID);
    assert.deepEqual(r.features[0].properties, { ID_DZIALKI: ID });
    assert.equal(r.sourceCrs, 'EPSG:2177'); assert.equal(r.numberMatchedUnknown, true);
    const xy = ring.split(' ').map(Number), expected = [];
    for (let i = 0; i < xy.length; i += 2) expected.push(proj4('EPSG:2177', 'EPSG:4326', [xy[i + 1], xy[i]]));
    assert.deepEqual(r.features[0].geometry, { type: 'Polygon', coordinates: [expected] });
    assert.ok(Math.abs(expected[0][0] - 18.610319318) < 1e-8);
    assert.ok(Math.abs(expected[0][1] - 54.373075254) < 1e-8);
    assert.doesNotMatch(JSON.stringify(r), /DO-NOT-RETAIN|owner|address|589118/);
});

test('Gdańsk preserves multipart polygons and interior rings without clipping or simplification', async () => {
    let xml = member();
    const polygon = /<g:Polygon[\s\S]*?<\/g:Polygon>/.exec(xml)[0];
    const hole = '<g:interior><g:LinearRing><g:posList>6027144 6539670 6027144 6539671 6027145 6539671 6027145 6539670 6027144 6539670</g:posList></g:LinearRing></g:interior>';
    const multi = `<g:MultiSurface><g:surfaceMember>${polygon.replace('</g:Polygon>', hole + '</g:Polygon>')}</g:surfaceMember><g:surfaceMember>${polygon}</g:surfaceMember></g:MultiSurface>`;
    xml = xml.replace(polygon, multi);
    const geometry = (await parse(collection(xml))).features[0].geometry;
    assert.equal(geometry.type, 'MultiPolygon'); assert.equal(geometry.coordinates.length, 2);
    assert.deepEqual(geometry.coordinates.map(p => p.length), [2, 1]);
    assert.equal(geometry.coordinates[0][0].length, 16);
});

test('Gdańsk requires simple, unique, direct native ID and geometry fields with exact namespaces', async () => {
    const idXml = `<m:ID_DZIALKI>${ID}</m:ID_DZIALKI>`;
    for (const xml of [member().replace(idXml, ''), member().replace(idXml, idXml + idXml),
        member().replace(idXml, `<m:other>${idXml}</m:other>`),
        member().replace(idXml, `<m:ID_DZIALKI><m:other>${ID}</m:other></m:ID_DZIALKI>`),
        member('bad&amp;id'), member('../unsafe id'),
        member().replace(idXml, `<x:ID_DZIALKI xmlns:x="urn:other">${ID}</x:ID_DZIALKI>`),
        member().replace('<m:geometry>', '<m:other><m:geometry>').replace('</m:geometry>', '</m:geometry></m:other>')]) {
        await assert.rejects(parse(collection(xml)));
    }
});

test('Gdańsk rejects malformed XML, DTD, namespace/CRS drift, dimensions and unsupported or unclosed geometry', async () => {
    for (const xml of [collection(member()).slice(0, -10), '<!DOCTYPE x>' + collection(member()),
        collection(member()).replaceAll(GDANSK_GML_SCHEMA.featureNamespace, 'urn:other'),
        collection(member()).replaceAll('http://www.opengis.net/gml/3.2', 'http://www.opengis.net/gml'),
        collection(member()).replaceAll('EPSG::2177', 'EPSG::2180'),
        collection(member()).replaceAll('srsDimension="2"', 'srsDimension="3"'),
        collection(member()).replaceAll('g:Polygon', 'g:Curve'),
        collection(member()).replace(ring, ring.replace(/6027150.05 6539660.16$/, '6027151 6539660')),
        collection(member(), 1, 0), collection(member(), 'invalid', 1)]) await assert.rejects(parse(xml));
});

test('Gdańsk cannot silently omit referenced, empty or path-confused geometry components', async () => {
    const polygon = /<g:Polygon[\s\S]*?<\/g:Polygon>/.exec(member())[0];
    for (const extra of ['<g:surfaceMember/>', '<g:surfaceMembers/>',
        '<g:surfaceMember xmlns:x="http://www.w3.org/1999/xlink" x:href="#other"/>']) {
        const xml = member().replace(polygon, `<g:MultiSurface><g:surfaceMember>${polygon}</g:surfaceMember>${extra}</g:MultiSurface>`);
        await assert.rejects(parse(collection(xml)));
    }
    for (const xml of [member().replace('<g:LinearRing>', '').replace('</g:LinearRing>', ''),
        member().replace('</g:Polygon>', '<g:interior><g:LinearRing/></g:interior></g:Polygon>'),
        member().replace('<m:geometry>', '<m:geometry xmlns:x="http://www.w3.org/1999/xlink" x:href="#other">'),
        member().replace(polygon, polygon + polygon)]) await assert.rejects(parse(collection(xml)));
});

test('production factory paginates exact IDs, scopes properties, sorts consistently and checks pre/post counts', async () => {
    const { requests, fetchImpl } = transport();
    const r = await createParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + ID, PREFIX + ID2]);
    assert.equal(r.complete, true); assert.equal(r.numberMatched, 2);
    assert.deepEqual(r.features.map(f => f.id), [PREFIX + ID, PREFIX + ID2]);
    assert.deepEqual(r.features[0].properties.sourceProperties, { ID_DZIALKI: ID });
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.filter(({u}) => u.searchParams.has('count')).map(({u}) => u.searchParams.get('startIndex')), ['0', '1']);
    const filter = requests[0].u.searchParams.get('filter');
    assert.match(filter, /<fes:Or>/); assert.match(filter, /<fes:ValueReference>ms:ID_DZIALKI<\/fes:ValueReference>/);
    assert.match(filter, /<fes:Literal>226101_1.0055.284\/13<\/fes:Literal>/);
    for (const { u, init } of requests) {
        assert.equal(u.searchParams.get('filter'), filter);
        assert.equal(u.searchParams.get('propertyName'), 'ms:ID_DZIALKI,ms:geometry');
        assert.equal(u.searchParams.get('sortBy'), 'ms:ID_DZIALKI');
        assert.equal(u.searchParams.get('srsName'), 'urn:ogc:def:crs:EPSG::2177');
        assert.equal(init.redirect, 'error'); assert.equal(u.searchParams.has('RESOURCEID'), false);
    }
});

test('area and geometry filters project to EPSG:2177 N,E and return full source geometry', async () => {
    const { requests, fetchImpl } = transport([ID]);
    const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
    const bounds = [18.61, 54.3728, 18.6108, 54.3734];
    const r = await source.queryBounds(bounds);
    assert.equal(r.features.length, 1); assert.equal(r.features[0].geometry.coordinates[0].length, 16);
    const filter = requests[0].u.searchParams.get('filter');
    assert.match(filter, /<fes:Intersects>/); assert.match(filter, /ms:geometry/);
    const xy = /<gml:posList srsDimension="2">([^<]+)/.exec(filter)[1].split(' ').map(Number);
    assert.ok(xy[0] > 6000000 && xy[0] < 6100000 && xy[1] > 6500000);
    assert.deepEqual(xy.slice(0, 2), xy.slice(-2));
    assert.equal((await source.queryGeometry(r.features[0].geometry)).features.length, 1);
});

test('absence requires two stable known zero hit counts and no data request', async () => {
    const { requests, fetchImpl } = transport([]);
    const r = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + MISSING]);
    assert.equal(r.complete, true); assert.deepEqual(r.absentIds, [PREFIX + MISSING]);
    assert.equal(requests.length, 2);
    const broken = transport([], { after: 1 });
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl: broken.fetchImpl }).queryIds([PREFIX + MISSING]), /changed/);
});

test('observed unknown empty hit counts require independent zero-member data probes before and after', async () => {
    const { requests, fetchImpl } = transport([], { before: 'unknown' });
    const r = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + MISSING]);
    assert.equal(r.complete, true); assert.deepEqual(r.absentIds, [PREFIX + MISSING]);
    assert.equal(r.completenessEvidence[0].verifiedEmptyDataProbes, 2);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(({u}) => u.searchParams.get('resultType')), ['hits', null, 'hits', null]);
    assert.ok(requests.filter(({u}) => !u.searchParams.has('resultType')).every(({u}) => u.searchParams.get('count') === '1'));
    for (const xml of [collection('', 'unknown', 0).replace(' numberReturned="0"', ''), collection('', 1, 0), collection(member())]) {
        const broken = transport([], { before: 'unknown', dataXml: xml });
        await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl: broken.fetchImpl }).queryIds([PREFIX + MISSING]));
    }
    let calls = 0;
    const changing = async () => { calls++; return calls % 2 ? hits('unknown') : response(calls === 2 ? collection('', 'unknown', 0) : collection(member())); };
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl: changing }).queryIds([PREFIX + MISSING]));
});

test('Gdańsk paces every request and propagates 429 without retrying', async () => {
    const waits = []; let calls = 0;
    const s = createSource(descriptor, { waitImpl: async ms => waits.push(ms), fetchImpl: async () => { calls++; return new Response('throttled', { status: 429 }); } });
    await assert.rejects(s.queryIds([PREFIX + ID]), { upstreamStatus: 429 });
    assert.equal(calls, 1); assert.deepEqual(waits, [1000]);
    const empty = createSource(descriptor, { waitImpl: async ms => waits.push(ms), fetchImpl: async () => hits(0) });
    assert.equal((await empty.queryIds([PREFIX + MISSING])).complete, true);
    assert.deepEqual(waits, [1000, 1000, 1000]);
});

test('unsafe XML IDs, foreign IDs, descriptor drift and overlarge bounds fail before fetching', async () => {
    let calls = 0; const fetchImpl = async () => { calls++; return hits(0); };
    for (const change of [{ endpoint: 'https://example.org/wfs' }, { geometryField: 'msGeometry' },
        { outFields: ['ID_DZIALKI', 'owner'] }, { responseCrs: 'EPSG:4326' }, { version: '1.1.0' },
        { pageSize: 0 }, { maxFeatures: 5001 }, { maxResponseBytes: 3000000 }])
        assert.throws(() => createGmlWfsParcelSource({ ...descriptor, ...change }, { fetchImpl }), /descriptor/);
    const s = createGmlWfsParcelSource(descriptor, { fetchImpl });
    for (const ids of [[PREFIX + '<xml>'], [PREFIX + 'id&x'], [PREFIX + "id'x"], [PREFIX + 'id\"x'],
        [PREFIX + 'id x'], ['PL-POZNAN-' + ID], [], Array(81).fill(PREFIX + ID)])
        await assert.rejects(s.queryIds(ids), { status: 400 });
    await assert.rejects(s.queryBounds([18, 54, 19, 55]), { status: 400 });
    assert.equal(calls, 0);
});

for (const [name, options] of [
    ['unknown hits', { before: 'unknown' }], ['over feature limit', { before: 301 }],
    ['changed count', { after: 3 }], ['incorrect page match count', { dataMatched: 3 }],
    ['omitted returned count', { dataXml: collection(member()).replace(' numberReturned="1"', '') }],
    ['truncated page', { dataXml: collection('', 'unknown', 0) }],
    ['unexpected native ID', { dataXml: collection(member(ID3)) }],
    ['repeated cross-page identity', { dataXml: collection(member()) }]
]) test('Gdańsk never labels ' + name + ' complete', async () => {
    const { fetchImpl } = transport([ID, ID2], options);
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + ID, PREFIX + ID2]));
});

test('Gdańsk rejects duplicate identities in a page and conflicting geometry across pages', async () => {
    const duplicate = transport([ID, ID2], { dataXml: collection(member() + member(), 'unknown', 2) });
    await assert.rejects(createGmlWfsParcelSource({ ...descriptor, pageSize: 2 }, { fetchImpl: duplicate.fetchImpl }).queryIds([PREFIX + ID, PREFIX + ID2]), /repeated/);
    let pages = 0;
    const fetchImpl = async url => new URL(url).searchParams.get('resultType') === 'hits' ? hits(2)
        : response(collection(++pages === 1 ? member() : member().replaceAll('6539660.16', '6539660.17')));
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + ID, PREFIX + ID2]), /conflicting/);
});

test('HTTP denials, OWS exceptions, non-XML, redirect, timeout and incomplete bytes cannot establish absence', async () => {
    for (const fetchImpl of [async () => new Response('denied', { status: 403 }),
        async () => new Response('', { status: 302 }),
        async () => response('<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>'),
        async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
        async () => { throw new DOMException('timeout', 'TimeoutError'); },
        async () => new Response(collection('', 0, 0), { headers: { 'content-type': 'application/xml', 'content-length': '9000' } })])
        await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + MISSING]));
});

test('response, aggregate and parser byte/feature limits are enforced', async () => {
    const hitBytes = Buffer.byteLength(collection('', 1, 0)), dataBytes = Buffer.byteLength(collection(member()));
    for (const change of [{ maxResponseBytes: 10 },
        { maxResponseBytes: dataBytes, maxTotalResponseBytes: 2 * hitBytes + dataBytes - 1 }]) {
        const { fetchImpl } = transport([ID]);
        await assert.rejects(createGmlWfsParcelSource({ ...descriptor, ...change }, { fetchImpl }).queryIds([PREFIX + ID]), /byte limit/);
    }
    await assert.rejects(parseGmlParcels(collection(member()), { schema: GDANSK_GML_SCHEMA, maxBytes: 10 }), /byte limit/);
    await assert.rejects(parseGmlParcels(collection(member() + member(ID2), 'unknown', 2), { schema: GDANSK_GML_SCHEMA, maxFeatures: 1 }), /feature limit/);
});

test('exact-ID batches are bounded at eight and share the total byte budget', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `226101_1.0055.${i + 1}/1`), requests = [];
    const fetchImpl = async url => {
        const u = new URL(url); requests.push(u);
        const found = [...u.searchParams.get('filter').matchAll(/<fes:Literal>([^<]+)<\/fes:Literal>/g)].map(m => m[1]);
        return u.searchParams.get('resultType') === 'hits' ? hits(found.length)
            : response(collection(found.map(id => member(id)).join(''), 'unknown', found.length));
    };
    const s = createGmlWfsParcelSource({ ...descriptor, pageSize: 50 }, { fetchImpl });
    assert.equal((await s.queryIds(ids.map(id => PREFIX + id))).features.length, 9);
    const filters = [...new Set(requests.map(u => u.searchParams.get('filter')))];
    assert.deepEqual(filters.map(f => [...f.matchAll(/<fes:Literal>/g)].length), [8, 1]);
    const budget = 2 * Buffer.byteLength(collection('', 8, 0)) + Buffer.byteLength(collection(ids.slice(0, 8).map(id => member(id)).join(''), 'unknown', 8));
    await assert.rejects(createGmlWfsParcelSource({ ...descriptor, pageSize: 50, maxTotalResponseBytes: budget }, { fetchImpl }).queryIds(ids.map(id => PREFIX + id)), /byte limit/);
});

test('Gdańsk rejects known paging sets beyond the request budget before downloading data', async () => {
    let calls = 0;
    const fetchImpl = async url => {
        calls++;
        const u = new URL(url);
        if (u.searchParams.get('resultType') === 'hits') return hits(128);
        return response(collection(member(`226101_1.0055.${Number(u.searchParams.get('startIndex')) + 1}/1`)));
    };
    const s = createGmlWfsParcelSource(descriptor, { fetchImpl });
    await assert.rejects(s.queryBounds([18.61, 54.3728, 18.6108, 54.3734]), /request limit/);
    assert.equal(calls, 1);
});

test('Gdańsk permits paging exactly up to the request budget, including the final hit check', async () => {
    const ids = Array.from({ length: 126 }, (_, i) => `226101_1.0055.${i + 1}/1`);
    const { requests, fetchImpl } = transport(ids);
    const result = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryBounds([18.61, 54.3728, 18.6108, 54.3734]);
    assert.equal(result.complete, true);
    assert.equal(result.numberMatched, 126);
    assert.equal(result.features.length, 126);
    assert.equal(requests.length, 128);
    assert.equal(requests.at(-1).u.searchParams.get('resultType'), 'hits');
});

test('the operation deadline remains shared across all Gdańsk pages', async () => {
    const baseTime = Date.now(); let elapsed = 0, calls = 0;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => baseTime + elapsed);
    onTestFinished(() => dateNowSpy.mockRestore());
    const fetchImpl = async url => {
        calls++; elapsed += 20000;
        return new URL(url).searchParams.get('resultType') === 'hits' ? hits(2) : response(collection(member()));
    };
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + ID, PREFIX + ID2]), /timed out/);
    assert.equal(calls, 3);
});
