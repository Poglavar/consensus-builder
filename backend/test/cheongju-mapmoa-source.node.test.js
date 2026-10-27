// Verify MapMoa transport encoding, safe identity, bounded reads and faithful GML rings/parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { CHEONGJU_ENDPOINT, mapmoaQueryUrl } from '../parcels/cheongju-mapmoa-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { id: 'kr-cheongju-mapmoa-cadastral-wfs', adapter: 'cheongju-mapmoa', endpoint: CHEONGJU_ENDPOINT,
    featureType: 'LSMD_CONT_LDREG', version: '1.1.0', idField: 'PNU', idType: 'string', geometryField: 'G2_SPATIAL',
    parcelNumberField: 'PNU', outFields: ['PNU'], idPrefix: 'KR-CHEONGJU-PNU-', sourceCrs: 'EPSG:5186' };
const nativeId = '4311210200103160032', id = descriptor.idPrefix + nativeId;
const ring = [[241942,448486],[241969,448486],[241969,448498],[241942,448498],[241942,448486]];
const hole = [[241945,448488],[241946,448488],[241946,448489],[241945,448488]];
const linear = points => `<gml:LinearRing><gml:posList srsDimension="2">${points.flat().join(' ')}</gml:posList></gml:LinearRing>`;
const polygon = (points = ring, inner = []) => `<gml:Polygon><gml:exterior>${linear(points)}</gml:exterior>${inner.map(points => `<gml:interior>${linear(points)}</gml:interior>`).join('')}</gml:Polygon>`;
const member = (key = nativeId, geometry = polygon()) => `<gml:featureMember><c:LSMD_CONT_LDREG fid="unrelated"><c:PNU>${key}</c:PNU><c:G2_SPATIAL>${geometry}</c:G2_SPATIAL></c:LSMD_CONT_LDREG></gml:featureMember>`;
const xml = (members = [member()], count = members.length) => `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:c="http://geogate.g-inno.com/dataserver/dh_cjcivil" xmlns:gml="http://www.opengis.net/gml" numberOfFeatures="${count}">${members.join('')}</wfs:FeatureCollection>`;
const response = body => new Response(body, { headers: { 'Content-Type': 'text/xml' } });
const make = (fetchImpl, extra = {}) => createParcelSource({ ...descriptor, ...extra }, { fetchImpl });
const bounds = [127.4689,36.6338,127.4694,36.6341];

test('backend and browser perform independent exact reads with viewer encoding and discard unsolicited fields', async () => {
    for (const factory of [make, fetchImpl => browserParcelFactories['cheongju-mapmoa'](descriptor, { fetchImpl })]) {
        let calls = 0;
        const adapter = factory(async (url, options) => {
            calls++;
            const expected = `<ogc:PropertyIsEqualTo><ogc:PropertyName>PNU</ogc:PropertyName><ogc:Literal>${nativeId}</ogc:Literal></ogc:PropertyIsEqualTo>`;
            assert.equal(url, mapmoaQueryUrl(expected, 2));
            const inner = unescape(unescape(new URL(url).search.slice(1)));
            assert.ok(inner.includes('&PROPERTYNAME=PNU,G2_SPATIAL&MAXFEATURES=2&FILTER='));
            assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
            return response(xml().replace('</c:PNU>', '</c:PNU><c:unsolicited>discard</c:unsolicited>'));
        });
        const first = await adapter.queryIds([id]), second = await adapter.queryIds([id]);
        assert.equal(calls, 2); assert.deepEqual(first, second); assert.equal(first.complete, true);
        assert.equal(first.features[0].id, id); assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features[0].properties.sourceProperties, { PNU: nativeId });
        assert.equal(JSON.stringify(first).includes('discard'), false);
        assert.deepEqual(first.features[0].geometry.coordinates, [ring.map(p => proj4('EPSG:5186', 'EPSG:4326', p))]);
    }
});

test('area lookup uses XML Intersects, keeps holes and all polygon components, never clips source geometry', async () => {
    const geometry = `<gml:MultiPolygon><gml:polygonMember>${polygon(ring, [hole])}</gml:polygonMember><gml:polygonMember>${polygon()}</gml:polygonMember></gml:MultiPolygon>`;
    const adapter = make(async url => {
        const inner = unescape(unescape(new URL(url).search.slice(1)));
        assert.ok(inner.includes('<ogc:Intersects><ogc:PropertyName>G2_SPATIAL</ogc:PropertyName><gml:Polygon srsName="EPSG:5186">'));
        assert.ok(inner.includes('MAXFEATURES=1000')); assert.equal(inner.includes('&BBOX='), false);
        return response(xml([member(nativeId, geometry)]));
    });
    const read = await adapter.queryBounds(bounds);
    assert.equal(read.complete, true); assert.equal(read.areaComplete, false);
    assert.deepEqual(read.features[0].geometry, { type: 'MultiPolygon', coordinates: [[ring, hole], [ring]].map(poly => poly.map(r => r.map(p => proj4('EPSG:5186','EPSG:4326',p)))) });
    assert.equal((await adapter.queryGeometry(read.features[0].geometry)).features.length, 1);
});

test('ignored filters, capped sets, duplicate IDs, wrong counts, open rings and bad CRS fail explicitly', async () => {
    await assert.rejects(() => make(async () => response(xml([member('4311210200103160059')]))).queryIds([id]), /exact PNU filter/);
    await assert.rejects(() => make(async () => response(xml([member(), member('4311210200103160059')]))).queryIds([id]), /transfer cap/);
    await assert.rejects(() => make(async () => response(xml([member(), member()]))).queryBounds(bounds), /duplicate/);
    await assert.rejects(() => make(async () => response(xml([member()],2))).queryIds([id]), /counts/);
    await assert.rejects(() => make(async () => response(xml([member(nativeId,polygon(ring.slice(0,-1)))]))).queryIds([id]), /not closed/);
    await assert.rejects(() => make(async () => response(xml().replace('<gml:Polygon>','<gml:Polygon srsName="EPSG:4326">'))).queryIds([id]), /coordinate system/);
    await assert.rejects(() => make(async () => response(xml([member()],1).replaceAll('2419','2410'))).queryBounds(bounds), /spatial filter/);
    const unresolved = await make(async () => response(xml([]))).queryIds([id]);
    assert.equal(unresolved.complete, false); assert.deepEqual(unresolved.absentIds, []); assert.deepEqual(unresolved.unresolvedIds, [id]);
});

test('stream byte limits, invalid queries and unsafe descriptors fail; relay stays on registered resource', async () => {
    await assert.rejects(() => make(async () => response(' '.repeat(1025)), {maxResponseBytes:1024}).queryIds([id]), /byte limit/);
    let calls = 0; const adapter = make(async () => { calls++; return response(xml()); });
    for (const ids of [[id,id], ['foreign'], [id+'?']]) await assert.rejects(() => adapter.queryIds(ids), {status:400});
    await assert.rejects(() => adapter.queryBounds([127,36,128,37]), {status:400});
    assert.equal(calls, 0); assert.throws(() => make(async () => response(xml()), {outFields:['owner']}), /descriptor/);
    assert.equal(mapmoaQueryUrl('a = /\"',2).split('?')[1], escape(escape('SERVICE=WFS&VERSION=1.1.0&SRSNAME=EPSG:5186&REQUEST=GetFeature&TYPENAME=LSMD_CONT_LDREG&PROPERTYNAME=PNU,G2_SPATIAL&MAXFEATURES=2&FILTER=<ogc:Filter>a = /\"</ogc:Filter>')));
    const relay = validateParcelProviderRelayRequest(descriptor.id, {url:mapmoaQueryUrl('a',2),method:'GET'}, {sources:[descriptor]});
    assert.equal(relay.target.origin + relay.target.pathname, CHEONGJU_ENDPOINT);
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, {url:'https://map.cheongju.go.kr/private',method:'GET'}, {sources:[descriptor]}));
});

test('source relay pins public DNS, uses verified fetch transport, normalizes only the invalid XML MIME and closes dispatchers', async () => {
    const { fetchCheongjuMapmoa } = await import('../parcels/cheongju-mapmoa-fetch.js');
    let destroyed = 0, fetched = 0;
    const dispatcher = { destroy: async () => { destroyed++; } };
    const url = mapmoaQueryUrl('a',2);
    const injections = {
        lookupImpl: async host => { assert.equal(host,'map.cheongju.go.kr'); return [{address:'8.8.8.8',family:4}]; },
        dispatcherFactory: address => { assert.deepEqual(address,{address:'8.8.8.8',family:4}); return dispatcher; },
        fetchImpl: async (target, options) => {
            fetched++; assert.equal(target,url); assert.equal(options.dispatcher,dispatcher);
            assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
            return new Response('unchanged', {headers:{'content-type':'text/xml; subtype=gml/3.1.1; charset=UTF-8','set-cookie':'incidental=value'}});
        }
    };
    const read = await fetchCheongjuMapmoa(url,{},injections);
    assert.equal(await read.text(),'unchanged'); assert.equal(read.headers.get('content-type'),'text/xml; charset=UTF-8');
    assert.equal(read.headers.has('set-cookie'),false);
    // ReadableStream's terminal pull schedules dispatcher cleanup after the consumer resumes.
    assert.equal(destroyed,1);
    await assert.rejects(() => fetchCheongjuMapmoa(url,{}, {...injections,lookupImpl:async()=>[{address:'127.0.0.1',family:4}]}),{status:403});
    await assert.rejects(() => fetchCheongjuMapmoa('https://map.cheongju.go.kr/private',{},injections),{status:400});
    assert.equal(fetched,1);
    const oversized = await fetchCheongjuMapmoa(url,{}, {...injections,fetchImpl:async()=>new Response(new Uint8Array(2*1024*1024+1))});
    await assert.rejects(() => oversized.arrayBuffer(),/byte limit/); assert.equal(destroyed,2);
    await assert.rejects(() => fetchCheongjuMapmoa(url,{}, {...injections,fetchImpl:async()=>{throw Error('failed transport');}}),/failed transport/);
    assert.equal(destroyed,3);
});
