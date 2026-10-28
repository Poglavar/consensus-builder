// Exercise safe Jijuk transport, exact identity, limits and unchanged polygon structure.
import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { GWANGJU_AREA_ENDPOINT, GWANGJU_PNU_ENDPOINT, GWANGJU_PROJECTION } from '../parcels/gwangju-jijuk-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { id:'kr-jeonnam-gwangju-jijuk-lookup', adapter:'gwangju-jijuk', endpoint:GWANGJU_AREA_ENDPOINT,
    exactEndpoint:GWANGJU_PNU_ENDPOINT, idPrefix:'KR-JG-JIJUK-PNU-', sourceCrs:'EPSG:5186', idField:'pnu', outFields:['pnu'] };
const nativeId = '1224011800100180003', id = descriptor.idPrefix + nativeId;
const ring = [[188000,285200],[188010,285200],[188010,285210],[188000,285210],[188000,285200]];
const wktRing = points => `(${points.map(point => point.join(' ')).join(',')})`;
const geometry = `MULTIPOLYGON((${wktRing(ring)},${wktRing(ring)}),(${wktRing(ring)}))`;
const row = { pnu:nativeId, geom:geometry, unsolicited:'discard' };
const response = value => new Response(JSON.stringify(value));
const make = (fetchImpl, extra = {}) => createParcelSource({ ...descriptor, ...extra }, { fetchImpl });

test('backend and browser read exact native IDs afresh, strip attributes and preserve all rings/parts', async () => {
    for (const factory of [make, fetchImpl => browserParcelFactories['gwangju-jijuk'](descriptor, {fetchImpl})]) {
        const calls = [];
        const adapter = factory(async (url, options) => {
            calls.push(url);
            assert.equal(url, GWANGJU_PNU_ENDPOINT);
            assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
            assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
            assert.equal(options.body, `code=${nativeId}`);
            return response(row);
        });
        const first = await adapter.queryIds([id]), second = await adapter.queryIds([id]);
        assert.equal(calls.length, 2);
        assert.deepEqual(first, second);
        assert.equal(first.complete, true); assert.deepEqual(first.absentIds, []);
        assert.equal(first.features[0].id, id);
        assert.deepEqual(first.features[0].properties.sourceProperties, {pnu:nativeId});
        assert.equal(JSON.stringify(first).includes('unsolicited'), false);
        const projected = ring.map(point => proj4(GWANGJU_PROJECTION, 'EPSG:4326', point));
        assert.deepEqual(first.features[0].geometry, {type:'MultiPolygon',coordinates:[[projected,projected],[projected]]});
    }
});

test('area request transforms WGS84 to native x,y and never clips extending source polygons', async () => {
    let request;
    const adapter = make(async (url, options) => { request = {url, options}; return response([row]); });
    const read = await adapter.queryBounds([126.868,35.163,126.869,35.164]);
    assert.equal(request.url, GWANGJU_AREA_ENDPOINT);
    const wkt = new URLSearchParams(request.options.body).get('wkt');
    const corner = proj4('EPSG:4326', GWANGJU_PROJECTION, [126.868,35.163]);
    assert.ok(wkt.startsWith(`POLYGON((${corner.join(' ')},`));
    assert.equal(read.areaComplete, false); assert.equal(read.authoritativeAbsence, false);
    assert.deepEqual(read.features[0].geometry.coordinates[0][0], ring.map(point => proj4(GWANGJU_PROJECTION,'EPSG:4326',point)));
});

test('different exact PNU, open rings, duplicate area IDs and transfer caps fail explicitly', async () => {
    await assert.rejects(() => make(async () => response({...row,pnu:'1224011800109220001'})).queryIds([id]), /different PNU/);
    await assert.rejects(() => make(async () => response({...row,geom:`POLYGON(${wktRing(ring.slice(0,-1))})`})).queryIds([id]), /no repair/);
    await assert.rejects(() => make(async () => response([row,row])).queryBounds([126.868,35.163,126.869,35.164]), /duplicate PNU/);
    await assert.rejects(() => make(async () => response([row]),{maxFeatures:1}).queryBounds([126.868,35.163,126.869,35.164]), /transfer cap/);
    await assert.rejects(() => make(async () => new Response(' '.repeat(1025)),{maxResponseBytes:1024}).queryIds([id]), /byte limit/);
    const missing = await make(async () => response(null)).queryIds([id]);
    assert.equal(missing.complete, false); assert.deepEqual(missing.absentIds, []); assert.deepEqual(missing.unresolvedIds,[id]);
});

test('invalid queries and unsafe descriptors fail before fetching; relay permits only catalogued endpoints', async () => {
    let calls = 0;
    const adapter = make(async () => { calls++; return response(row); });
    for (const ids of [[id,id],['foreign'],[id+'?']]) await assert.rejects(() => adapter.queryIds(ids),{status:400});
    await assert.rejects(() => adapter.queryBounds([126,35,127,36]),{status:400});
    assert.throws(() => make(async () => response(row),{outFields:['owner']}), /descriptor/);
    assert.equal(calls, 0);
    for (const url of [GWANGJU_AREA_ENDPOINT,GWANGJU_PNU_ENDPOINT]) {
        const relay = validateParcelProviderRelayRequest(descriptor.id, {url, method:'POST',
            headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`code=${nativeId}`},{sources:[descriptor]});
        assert.equal(relay.target.href,url);
    }
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id,{url:'https://map.jeonnam-gwangju.go.kr/private',method:'GET'},{sources:[descriptor]}));
});
