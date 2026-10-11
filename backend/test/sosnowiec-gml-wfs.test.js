// Sosnowiec's independently observed GML schema, axes, native IDs and bounded WFS completeness.
import { onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { createGmlWfsParcelSource as createSource } from '../parcels/gml-wfs-source.js';
import { createParcelSource as createProductionSource } from '../parcels/sources.js';
import { SOSNOWIEC_GML_SCHEMA, GDANSK_GML_SCHEMA, parseGmlParcels } from '../parcels/gml-parcel-reader.js';

const ID = '247501_1.0011.29', ID2 = '247501_1.0010.3473', MISSING = '247501_1.0010.999999999';
const PREFIX = 'PL-SOSNOWIEC-';
// Inject only the pacing wait; requests, parsing and shared budgets remain real.
const createGmlWfsParcelSource = (d, options) => createSource(d, { waitImpl: async () => {}, ...options });
const createParcelSource = (d, options) => createProductionSource(d, { waitImpl: async () => {}, ...options });
const descriptor = {
    id: 'sosnowiec-gml-wfs', adapter: 'gml-wfs', version: '2.0.0',
    endpoint: 'https://sosnowiec.webewid.pl:9443/iip/ows', featureType: 'ms:dzialki',
    idField: 'ID_DZIALKI', geometryField: 'geometry', responseCrs: 'EPSG:2177',
    idPrefix: PREFIX, idType: 'string', parcelNumberField: 'ID_DZIALKI', outFields: ['ID_DZIALKI'],
    pageSize: 1, maxFeatures: 1500, maxBboxKm2: 1
};
const sample = readFileSync(new URL('./fixtures/sosnowiec-safe-sample.gml', import.meta.url), 'utf8');
const sourceMember = /<wfs:member>[\s\S]*?<\/wfs:member>/.exec(sample)[0];
const sourceRing = /<gml:posList[^>]*>([^<]+)<\/gml:posList>/.exec(sample)[1].trim();
const member = (id = ID, extra = '') => sourceMember.replace(`<ms:ID_DZIALKI>${ID}</ms:ID_DZIALKI>`,
    `<ms:ID_DZIALKI>${id}</ms:ID_DZIALKI>${extra}`);
const collection = (xml = '', matched = 'unknown', returned = 1) =>
    `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="${SOSNOWIEC_GML_SCHEMA.featureNamespace}" xmlns:gml="http://www.opengis.net/gml/3.2" numberMatched="${matched}" numberReturned="${returned}">${xml}</wfs:FeatureCollection>`;
const response = xml => new Response(xml, { headers: { 'content-type': 'application/gml+xml; version=3.2' } });
const hits = n => response(collection('', n, 0));
const parse = xml => parseGmlParcels(xml, { schema: SOSNOWIEC_GML_SCHEMA });
function transport(ids = [ID, ID2], { before = ids.length, after = before, dataMatched = 'unknown', dataXml } = {}) {
    const requests = []; let hitCalls = 0;
    const fetchImpl = async (url, init) => {
        const u = new URL(url); requests.push({ u, init });
        if (u.searchParams.get('resultType') === 'hits') return hits(++hitCalls === 1 ? before : after);
        const page = ids.slice(Number(u.searchParams.get('startIndex')), Number(u.searchParams.get('startIndex')) + Number(u.searchParams.get('count')));
        return response(dataXml ?? collection(page.map(id => member(id)).join(''), dataMatched, page.length));
    };
    return { requests, fetchImpl };
}

test('Sosnowiec parses every observed vertex in N,E order using its own municipal identity schema', async () => {
    assert.notDeepEqual(SOSNOWIEC_GML_SCHEMA, GDANSK_GML_SCHEMA);
    const parsed = await parse(sample);
    assert.equal(parsed.features[0].id, ID);
    assert.deepEqual(parsed.features[0].properties, { ID_DZIALKI: ID });
    assert.equal(parsed.sourceCrs, 'EPSG:2177');
    const xy = sourceRing.split(/\s+/).map(Number), expected = [];
    for (let i = 0; i < xy.length; i += 2) expected.push(proj4('EPSG:2177', 'EPSG:4326', [xy[i + 1], xy[i]]));
    assert.deepEqual(parsed.features[0].geometry, { type: 'Polygon', coordinates: [expected] });
    assert.equal(expected.length, 48);
    assert.ok(Math.abs(expected[0][0] - 19.146) < .01 && Math.abs(expected[0][1] - 50.292) < .01);
    assert.doesNotMatch(JSON.stringify(parsed), /930112485/);
    const clean = await parse(collection(member(ID, '<ms:owner>DO-NOT-RETAIN</ms:owner><ms:address>DO-NOT-RETAIN</ms:address>')));
    assert.doesNotMatch(JSON.stringify(clean), /DO-NOT-RETAIN|owner|address/);
    await assert.rejects(parse(collection(member('226101_1.0055.284/13'))), /native identifier/);
    assert.equal((await parse(collection(member('247501_1.0010.3473/2')))).features[0].id, '247501_1.0010.3473/2');
});

test('all multipart components and holes survive without geometry repair', async () => {
    const polygon = /<gml:Polygon[\s\S]*?<\/gml:Polygon>/.exec(sourceMember)[0];
    const hole = '<gml:interior><gml:LinearRing><gml:posList>5573200 6581860 5573200 6581861 5573201 6581861 5573201 6581860 5573200 6581860</gml:posList></gml:LinearRing></gml:interior>';
    const multi = `<gml:MultiSurface><gml:surfaceMember>${polygon.replace('</gml:Polygon>', hole + '</gml:Polygon>')}</gml:surfaceMember><gml:surfaceMember>${polygon}</gml:surfaceMember></gml:MultiSurface>`;
    const result = await parse(collection(member().replace(polygon, multi)));
    assert.equal(result.features[0].geometry.type, 'MultiPolygon');
    assert.deepEqual(result.features[0].geometry.coordinates.map(p => p.map(r => r.length)), [[48, 5], [48]]);
});

test('direct simple identity and geometry fields reject namespace, path and duplicate confusion', async () => {
    const idXml = `<ms:ID_DZIALKI>${ID}</ms:ID_DZIALKI>`;
    for (const xml of [member().replace(idXml, ''), member().replace(idXml, idXml + idXml),
        member().replace(idXml, `<ms:other>${idXml}</ms:other>`),
        member().replace(idXml, `<ms:ID_DZIALKI><ms:other>${ID}</ms:other></ms:ID_DZIALKI>`),
        member('247501_1.0010.1&amp;unsafe'),
        member().replace(idXml, `<x:ID_DZIALKI xmlns:x="urn:other">${ID}</x:ID_DZIALKI>`),
        member().replace('<ms:geometry>', '<ms:other><ms:geometry>').replace('</ms:geometry>', '</ms:geometry></ms:other>'),
        member().replaceAll('ms:geometry', 'x:geometry').replace('<x:geometry>', '<x:geometry xmlns:x="urn:other">')])
        await assert.rejects(parse(collection(xml)));
});

test('malformed XML, DTD, CRS/dimension drift, unsupported and unclosed geometry fail closed', async () => {
    for (const xml of [sample.slice(0, -30), '<!DOCTYPE x>' + sample,
        sample.replaceAll(SOSNOWIEC_GML_SCHEMA.featureNamespace, 'urn:other'),
        sample.replaceAll('http://www.opengis.net/gml/3.2', 'http://www.opengis.net/gml'),
        sample.replaceAll('EPSG::2177', 'EPSG::2180'),
        sample.replaceAll('srsDimension="2"', 'srsDimension="3"'),
        sample.replaceAll('gml:Polygon', 'gml:Curve'),
        sample.replace(sourceRing, sourceRing.replace(/5573188\.810000 6581860\.110000$/, '5573189 6581860')),
        collection(member(), 1, 0), collection(member(), 'invalid', 1)]) await assert.rejects(parse(xml));
});

test('empty, referenced and malformed geometry components cannot be silently discarded', async () => {
    const polygon = /<gml:Polygon[\s\S]*?<\/gml:Polygon>/.exec(sourceMember)[0];
    for (const extra of ['<gml:surfaceMember/>', '<gml:surfaceMembers/>',
        '<gml:surfaceMember xmlns:x="http://www.w3.org/1999/xlink" x:href="#other"/>'])
        await assert.rejects(parse(collection(member().replace(polygon,
            `<gml:MultiSurface><gml:surfaceMember>${polygon}</gml:surfaceMember>${extra}</gml:MultiSurface>`))));
    for (const xml of [member().replace('<gml:LinearRing>', '').replace('</gml:LinearRing>', ''),
        member().replace('</gml:Polygon>', '<gml:interior><gml:LinearRing/></gml:interior></gml:Polygon>'),
        member().replace('<ms:geometry>', '<ms:geometry xmlns:x="http://www.w3.org/1999/xlink" x:href="#other">'),
        member().replace(polygon, polygon + polygon)]) await assert.rejects(parse(collection(xml)));
});

test('Sosnowiec rejects nil components and stray geometry text instead of discarding them', async () => {
    for (const tag of ['ms:geometry', 'gml:Polygon', 'gml:LinearRing', 'gml:posList']) {
        for (const nil of ['true', '1', 'invalid']) {
            const xml = member().replace(`<${tag}`, `<${tag} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="${nil}"`);
            await assert.rejects(parse(collection(xml)), /nil or invalid geometry/);
        }
        for (const nil of ['false', '0']) {
            const xml = member().replace(`<${tag}`, `<${tag} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="${nil}"`);
            assert.deepEqual((await parse(collection(xml))).features[0].geometry, (await parse(sample)).features[0].geometry);
        }
    }
    for (const tag of ['ms:geometry', 'gml:Polygon', 'gml:exterior', 'gml:LinearRing']) {
        const xml = member().replace(new RegExp(`<${tag}\\b[^>]*>`), opening => opening + 'invalid component');
        await assert.rejects(parse(collection(xml)), /unexpected geometry text/);
    }
});

test('production factory pages safe attribute exact IDs with stable pre/post counts', async () => {
    const { requests, fetchImpl } = transport();
    const result = await createParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + ID, PREFIX + ID2]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(f => f.id), [PREFIX + ID, PREFIX + ID2]);
    assert.deepEqual(result.features[0].properties.sourceProperties, { ID_DZIALKI: ID });
    assert.deepEqual(result.completenessEvidence, [{ paging: true, matchedBefore: 2, matchedAfter: 2,
        numberReturned: 2, parsedFeatureCount: 2, uniqueNativeCount: 2, verifiedEmptyDataProbes: 0 }]);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.filter(({ u }) => u.searchParams.has('count')).map(({ u }) => u.searchParams.get('startIndex')), ['0', '1']);
    const filters = new Set(requests.map(({ u }) => u.searchParams.get('filter')));
    assert.equal(filters.size, 1);
    assert.match([...filters][0], /<fes:Or>/);
    assert.match([...filters][0], /<fes:ValueReference>ms:ID_DZIALKI<\/fes:ValueReference>/);
    for (const { u, init } of requests) {
        assert.equal(u.origin + u.pathname, descriptor.endpoint);
        assert.equal(u.searchParams.get('propertyName'), 'ms:ID_DZIALKI,ms:geometry');
        assert.equal(u.searchParams.get('srsName'), 'urn:ogc:def:crs:EPSG::2177');
        assert.equal(u.searchParams.get('sortBy'), 'ms:ID_DZIALKI');
        assert.equal(u.searchParams.has('RESOURCEID'), false);
        assert.equal(init.redirect, 'error');
    }
});

test('bounded area filters project N,E coordinates and keep complete intersecting source geometry', async () => {
    const { requests, fetchImpl } = transport([ID]);
    const [x, y] = (await parse(sample)).features[0].geometry.coordinates[0][0];
    const bounds = [x - .0001, y - .0001, x + .0001, y + .0001];
    const result = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryBounds(bounds);
    assert.equal(result.features.length, 1);
    assert.deepEqual(result.features[0].geometry, (await parse(sample)).features[0].geometry);
    const filter = requests[0].u.searchParams.get('filter');
    assert.match(filter, /<fes:Intersects>/); assert.match(filter, /ms:geometry/);
    const xy = /<gml:posList[^>]*>([^<]+)/.exec(filter)[1].split(' ').map(Number);
    assert.ok(xy[0] > 5570000 && xy[0] < 5580000 && xy[1] > 6580000 && xy[1] < 6590000);
});

test('unsafe IDs and descriptor drift are rejected before network access', async () => {
    let calls = 0; const fetchImpl = async () => { calls++; return hits(0); };
    for (const change of [{ endpoint: 'https://ewid-wms.gdansk.gda.pl/iip/ows' }, { outFields: ['ID_DZIALKI', 'owner'] },
        { responseCrs: 'EPSG:4326' }, { geometryField: 'msGeometry' }, { idPrefix: 'PL-GDANSK-' },
        { version: '1.1.0' }, { pageSize: 0 }, { maxFeatures: 5001 }, { maxResponseBytes: 3000000 }])
        assert.throws(() => createGmlWfsParcelSource({ ...descriptor, ...change }, { fetchImpl }), /descriptor/);
    const s = createGmlWfsParcelSource(descriptor, { fetchImpl });
    for (const ids of [[PREFIX + '<xml>'], ['PL-GDANSK-' + ID], [PREFIX + '226101_1.0055.1'],
        [PREFIX + '247501_1.0010.1\' OR 1=1'], [], Array(81).fill(PREFIX + ID)]) await assert.rejects(s.queryIds(ids), { status: 400 });
    await assert.rejects(s.queryBounds([19, 50, 20, 51]), { status: 400 });
    assert.equal(calls, 0);
});

for (const [name, options] of [
    ['short page', { dataXml: collection('', 'unknown', 0) }], ['changed count', { after: 3 }],
    ['lying page count', { dataMatched: 3 }], ['duplicate across pages', { dataXml: collection(member()) }],
    ['unrequested native identity', { dataXml: collection(member('247501_1.0010.2')) }],
    ['unknown nonempty hit set', { before: 'unknown' }], ['over feature budget', { before: 1501 }],
    ['missing returned count', { dataXml: collection(member()).replace(' numberReturned="1"', '') }]
]) test('Sosnowiec cannot establish completeness for ' + name, async () => {
    const { fetchImpl } = transport([ID, ID2], options);
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + ID, PREFIX + ID2]));
});

test('observed unknown empty hits require two independent empty data probes for absence', async () => {
    const { requests, fetchImpl } = transport([], { before: 'unknown', after: 'unknown' });
    const result = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + MISSING]);
    assert.deepEqual(result.absentIds, [PREFIX + MISSING]);
    assert.equal(result.complete, true); assert.equal(requests.length, 4);
    assert.equal(result.completenessEvidence[0].verifiedEmptyDataProbes, 2);
    assert.ok(requests.filter(({ u }) => u.searchParams.has('count')).every(({ u }) => u.searchParams.get('count') === '1'));
    const changed = transport([], { before: 'unknown', after: 1 });
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl: changed.fetchImpl }).queryIds([PREFIX + MISSING]), /changed/);
    for (const dataXml of [collection(member()), collection('', 'unknown', 0).replace(' numberReturned="0"', ''),
        collection('', 'unknown', 0).replace(' numberMatched="unknown"', '')]) {
        const t = transport([], { before: 'unknown', dataXml });
        await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl: t.fetchImpl }).queryIds([PREFIX + MISSING]));
    }
});

test('HTTP denial, exception XML, redirects, timeouts, bad content and truncation never imply absence', async () => {
    for (const fetchImpl of [async () => new Response('denied', { status: 403 }), async () => new Response('', { status: 429 }),
        async () => new Response('', { status: 302 }), async () => response('<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>'),
        async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
        async () => { throw new DOMException('timeout', 'TimeoutError'); },
        async () => new Response(collection('', 0, 0), { headers: { 'content-type': 'application/xml', 'content-length': '9000' } })])
        await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + MISSING]));
});

test('normal requests are paced and a publisher throttle fails without any automatic retry', async () => {
    const waits = [], t = transport([ID]);
    await createSource(descriptor, { fetchImpl: t.fetchImpl, waitImpl: async ms => { waits.push(ms); } }).queryIds([PREFIX + ID]);
    assert.deepEqual(waits, [1000, 1000, 1000]);
    let calls = 0;
    const s = createSource(descriptor, { waitImpl: async () => {}, fetchImpl: async () => {
        calls++; return new Response('', { status: 429 });
    } });
    await assert.rejects(s.queryIds([PREFIX + ID]), { code: 'parcel-source-rate-limited', upstreamStatus: 429 });
    assert.equal(calls, 1);
});

test('byte, feature and request limits bound pages before claiming completeness', async () => {
    const n = Buffer.byteLength(collection('', 1, 0)), d = Buffer.byteLength(collection(member()));
    for (const change of [{ maxResponseBytes: 10 }, { maxResponseBytes: d, maxTotalResponseBytes: 2 * n + d - 1 }]) {
        const { fetchImpl } = transport([ID]);
        await assert.rejects(createGmlWfsParcelSource({ ...descriptor, ...change }, { fetchImpl }).queryIds([PREFIX + ID]), /byte limit/);
    }
    await assert.rejects(parseGmlParcels(sample, { schema: SOSNOWIEC_GML_SCHEMA, maxBytes: 10 }), /byte limit/);
    await assert.rejects(parseGmlParcels(collection(member() + member(ID2), 'unknown', 2), { schema: SOSNOWIEC_GML_SCHEMA, maxFeatures: 1 }), /feature limit/);
    const t = transport([ID], { before: 127 });
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl: t.fetchImpl }).queryBounds([19.1459, 50.2921, 19.1461, 50.2924]), /request limit/);
    assert.equal(t.requests.length, 1);
});

test('exact predicates batch at eight, share byte budgets and retain per-batch completeness', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `247501_1.0010.${i + 1}`), requests = [];
    const fetchImpl = async url => {
        const u = new URL(url); requests.push(u);
        const found = [...u.searchParams.get('filter').matchAll(/<fes:Literal>([^<]+)<\/fes:Literal>/g)].map(m => m[1]);
        return u.searchParams.get('resultType') === 'hits' ? hits(found.length)
            : response(collection(found.map(id => member(id)).join(''), 'unknown', found.length));
    };
    const s = createGmlWfsParcelSource({ ...descriptor, pageSize: 50 }, { fetchImpl });
    const result = await s.queryIds(ids.map(id => PREFIX + id));
    assert.equal(result.features.length, 9); assert.equal(result.completenessEvidence.length, 2);
    assert.deepEqual([...new Set(requests.map(u => u.searchParams.get('filter')))].map(f => [...f.matchAll(/<fes:Literal>/g)].length), [8, 1]);
    const budget = 2 * Buffer.byteLength(collection('', 8, 0)) + Buffer.byteLength(collection(ids.slice(0, 8).map(id => member(id)).join(''), 'unknown', 8));
    await assert.rejects(createGmlWfsParcelSource({ ...descriptor, pageSize: 50, maxTotalResponseBytes: budget }, { fetchImpl }).queryIds(ids.map(id => PREFIX + id)), /byte limit/);
});

test('the operation deadline is shared across pages', async () => {
    const base = Date.now(); let elapsed = 0, calls = 0;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => base + elapsed);
    onTestFinished(() => dateNowSpy.mockRestore());
    const fetchImpl = async url => {
        calls++; elapsed += 20000;
        return new URL(url).searchParams.get('resultType') === 'hits' ? hits(2) : response(collection(member()));
    };
    await assert.rejects(createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([PREFIX + ID, PREFIX + ID2]), /timed out/);
    assert.equal(calls, 3);
});
