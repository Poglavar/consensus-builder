// Exercise bounded range transport, geometry identity, complete scans and the browser relay path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeojsonRangeParcelSource, createGeojsonRangeBrowserSource, geometryHashReference } from '../parcels/geojson-range-source.js';
import { sha256Hex } from '../parcels/portable-hash.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const polygon = x => ({ type: 'Polygon', coordinates: [[[x,34.45],[x+.001,34.45],[x+.001,34.451],[x,34.451],[x,34.45]]] });
const collection = { type:'FeatureCollection', name:'公開2025', crs:{type:'name',properties:{name:'urn:ogc:def:crs:OGC::CRS84'}},
    features: [132.32,132.34].map(x => ({ type:'Feature', geometry:polygon(x), properties:{ID:1,owner:'DO-NOT-RETAIN',padding:'x'.repeat(2000)} })) };
function fixture(data = collection, changes = {}) {
    const bytes = new TextEncoder().encode(JSON.stringify(data)), calls = [];
    const d = { id:'test-range', adapter:'geojson-range', endpoint:'https://example.org/parcel.geojson',
        idPrefix:'test-range/geometry-sha256-v1/', outFields:[], expectedEtag:'"pinned"',
        expectedSnapshotSha256:sha256Hex(bytes), expectedSnapshotBytes:bytes.length,
        expectedSnapshotFeatures:data.features.length, expectedCollectionName:data.name,
        rangeBytes:1024, maxFeatures:100, maxBboxKm2:25, ...changes };
    const fetchImpl = async (_url, init) => {
        const h = new Headers(init.headers), match = /^bytes=(\d+)-(\d+)$/.exec(h.get('range'));
        assert.equal(h.get('if-match'),d.expectedEtag); const [start,end] = match.slice(1).map(Number);
        calls.push([start,end]);
        return new Response(bytes.slice(start,end+1), {status:206,headers:{etag:d.expectedEtag,
            'content-range':`bytes ${start}-${end}/${bytes.length}`, 'content-length':String(end-start+1)}});
    };
    return {d, bytes, calls, fetchImpl, ids:data.features.map(f=>d.idPrefix+geometryHashReference(f.geometry))};
}
test('exact reads stop when all hashes are found and independently preserve unchanged geometry', async()=>{
    const f=fixture();
    for(let run=0;run<2;run++) {
        const before=f.calls.length, source=createGeojsonRangeParcelSource(f.d,{fetchImpl:f.fetchImpl});
        const read=await source.queryIds([f.ids[0]]);
        assert.equal(read.complete,true);assert.deepEqual(read.absentIds,[]);
        assert.deepEqual(read.features[0].geometry,collection.features[0].geometry);
        assert.deepEqual(read.features[0].properties.sourceProperties,{});
        assert.doesNotMatch(JSON.stringify(read),/DO-NOT-RETAIN|"padding"|"owner"/);
        assert.ok(f.calls.length-before<Math.ceil(f.bytes.length/f.d.rangeBytes));
    }
});
test('complete bounds and absence scans verify every range and release hash, cache only safe geometry',async()=>{
    const f=fixture(),s=createGeojsonRangeParcelSource(f.d,{fetchImpl:f.fetchImpl});
    const reads=await Promise.all([s.queryBounds([132.319,34.449,132.322,34.452]),s.queryBounds([132.339,34.449,132.342,34.452])]);
    assert.deepEqual(reads.map(r=>r.features[0].id),f.ids);
    assert.equal(f.calls.length,Math.ceil(f.bytes.length/f.d.rangeBytes));
    reads[0].features[0].geometry.coordinates[0][0][0]=0;
    assert.deepEqual((await s.queryIds([f.ids[0]])).features[0].geometry,collection.features[0].geometry);
    const absent=f.d.idPrefix+'0'.repeat(64);
    assert.deepEqual((await s.queryIds([absent])).absentIds,[absent]);
    assert.deepEqual((await createGeojsonRangeParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryIds([absent])).absentIds,[absent]);
});
test('full scans fail closed on revision, byte range, body, syntax, count and checksum mismatch',async()=>{
    for (const alter of [r=>new Response(r.body,{status:200,headers:r.headers}),
        r=>{r.headers.set('etag','"changed"');return r;},
        r=>{r.headers.set('content-range','bytes 1-1024/9999');return r;},
        async r=>new Response((await r.text()).slice(0,-1),{status:206,headers:r.headers}),
        r=>{r.headers.set('content-encoding','gzip');return r;}]) {
        const f=fixture(),s=createGeojsonRangeParcelSource(f.d,{fetchImpl:async(...args)=>alter(await f.fetchImpl(...args))});
        await assert.rejects(s.queryIds([f.ids[0]]));
    }
    for (const changes of [{expectedSnapshotSha256:'0'.repeat(64)},{expectedSnapshotFeatures:3},{expectedCollectionName:'wrong'}]) {
        const f=fixture(collection,changes);
        await assert.rejects(createGeojsonRangeParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryBounds([132.319,34.449,132.322,34.452]));
    }
});
test('invalid IDs and oversize bounds fail before transport; identical geometries alone deduplicate',async()=>{
    const f=fixture({...collection,features:[collection.features[0],collection.features[0]]}),s=createGeojsonRangeParcelSource(f.d,{fetchImpl:f.fetchImpl});
    await assert.rejects(s.queryIds(['foreign']));
    assert.throws(()=>s.queryBounds([0,0,1,1]));assert.equal(f.calls.length,0);
    assert.equal((await s.queryBounds([132.319,34.449,132.322,34.452])).features.length,1);
});
test('rejects unsafe geometry members and non-numeric extra ordinates without persisting them',async()=>{
    for (const geometry of [{...polygon(132.32),owner:'DO-NOT-RETAIN'},
        {...polygon(132.32),coordinates:polygon(132.32).coordinates.map(r=>r.map(p=>[...p,'DO-NOT-RETAIN']))}]) {
        const f=fixture({...collection,features:[{type:'Feature',properties:{},geometry}]});
        await assert.rejects(createGeojsonRangeParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryIds([f.ids[0]]));
    }
});
test('browser semantic relay performs live range reads with the same adapter and rejects arbitrary operations',async()=>{
    const f=fixture();
    const fetchImpl=async(url,init)=>fetchParcelProviderRelay(validateParcelProviderRelayRequest(f.d.id,
        {url,method:init.method,headers:init.headers,body:init.body},{sources:[f.d]}),{providerFetch:f.fetchImpl});
    const browser=createGeojsonRangeBrowserSource(f.d,{fetchImpl});
    assert.deepEqual((await browser.queryIds([f.ids[0]])).features[0].geometry,collection.features[0].geometry);
    assert.ok(f.calls.length>0);
    await assert.rejects(fetchImpl(f.d.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({_geojsonRangeOperation:'fetch',input:'https://other.example/'})}));
});
