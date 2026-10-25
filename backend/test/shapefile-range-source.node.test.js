import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate';
import { createShapefileRangeParcelSource, createShapefileRangeBrowserSource } from '../parcels/shapefile-range-source.js';
import { sha256Hex } from '../parcels/portable-hash.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

function fixture(changes = {}) {
    const records = Array.from({ length: 120 }, (_, i) => {
        const b = new Uint8Array(128), v = new DataView(b.buffer), x = -21000 + i * 100, y = -159000;
        v.setUint32(0, 5, true); [-0.0 + x, y, x + 10, y + 10].forEach((n, j) => v.setFloat64(4 + j * 8, n, true));
        v.setUint32(36, 1, true); v.setUint32(40, 5, true); v.setUint32(44, 0, true);
        [[x,y],[x,y+10],[x+10,y+10],[x+10,y],[x,y]].flat().forEach((n, j) => v.setFloat64(48 + j * 8, n, true));
        return b;
    });
    const bytes = new Uint8Array(100 + records.length * 136), v = new DataView(bytes.buffer);
    v.setUint32(0,9994); v.setUint32(24,bytes.length/2); v.setUint32(28,1000,true); v.setUint32(32,5,true);
    records.forEach((record, i) => { const at=100+i*136; v.setUint32(at,i+1); v.setUint32(at+4,64); bytes.set(record,at+8); });
    let crc=0xffffffff;
    for(const b of bytes) { crc^=b; for(let j=0;j<8;j++) crc=crc&1?0xedb88320^(crc>>>1):crc>>>1; }
    const compressed=deflateSync(bytes), calls=[];
    const d={id:'test-shape-range',adapter:'shapefile-range',endpoint:'https://example.org/parcels.geojson',
        geometryEndpoint:'https://example.org/parcels.shp.zip',geometryEtag:'"pinned"',geometryArchiveBytes:compressed.length+1100,
        geometryMember:{dataStart:1000,compressedBytes:compressed.length,uncompressedBytes:bytes.length,crc32:(crc^0xffffffff)>>>0,records:records.length},
        idPrefix:'test-shape-range/native-shape-sha256-v1/',outFields:[],sourceCrs:'EPSG:6673',rangeBytes:1024,maxFeatures:10000,maxBboxKm2:25,...changes};
    const fetchImpl=async(url, init)=>{
        assert.equal(String(url),d.geometryEndpoint); assert.equal(new Headers(init.headers).get('if-match'),d.geometryEtag);
        const match=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range')), [start,end]=match.slice(1).map(Number);
        calls.push([start,end]); assert.ok(start>=1000 && end<1000+compressed.length);
        return new Response(compressed.slice(start-1000,end-1000+1),{status:206,headers:{etag:d.geometryEtag,
            'content-range':`bytes ${start}-${end}/${d.geometryArchiveBytes}`,'content-length':String(end-start+1)}});
    };
    return {d,calls,fetchImpl,records,compressed,bytes,ids:records.map(r=>d.idPrefix+sha256Hex(r))};
}
test('independent exact reads preserve every ring point and stop before the whole member',async()=>{
    const f=fixture();
    for(let run=0;run<2;run++) {
        const before=f.calls.length, r=await createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryIds(f.ids.slice(0,3));
        assert.equal(r.complete,true);assert.deepEqual(r.absentIds,[]);assert.deepEqual(r.features.map(f=>f.id),f.ids.slice(0,3));
        assert.equal(r.features[0].geometry.coordinates[0].length,5);
        const first=r.features[0].geometry.coordinates[0][0];assert.ok(first[0]>134&&first[0]<134.2&&first[1]>34.5&&first[1]<34.7);
        assert.equal(r.features[0].properties.sourceParcelId,sha256Hex(f.records[0]));
        assert.deepEqual(r.features[0].properties.sourceProperties,{});
        assert.ok(f.calls.length-before<Math.ceil(f.compressed.length/f.d.rangeBytes));
    }
});
test('full area scan checks CRC/count and shares only the geometry index across queries',async()=>{
    const f=fixture(),s=createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl});
    const exact=await s.queryIds([f.ids[0]]),p=exact.features[0].geometry.coordinates[0];
    const bounds=[Math.min(...p.map(x=>x[0]))-1e-6,Math.min(...p.map(x=>x[1]))-1e-6,Math.max(...p.map(x=>x[0]))+1e-6,Math.max(...p.map(x=>x[1]))+1e-6];
    const [a,b]=await Promise.all([s.queryBounds(bounds),s.queryBounds(bounds)]);
    assert.deepEqual(a.features.map(f=>f.id),[f.ids[0]]);assert.deepEqual(a,b);assert.equal(a.statistics.recordsRead,120);
    assert.equal(a.statistics.downloadedBytes,f.compressed.length);assert.equal(a.statistics.extractedBytes,f.bytes.length);
    const before=f.calls.length;await s.queryBounds(bounds);assert.equal(f.calls.length,before);
    const absent=f.d.idPrefix+'0'.repeat(64);assert.deepEqual((await s.queryIds([absent])).absentIds,[absent]);
    for(const change of [{crc32:0},{records:121}]) {
        const broken={...f.d,geometryMember:{...f.d.geometryMember,...change}};
        await assert.rejects(createShapefileRangeParcelSource(broken,{fetchImpl:f.fetchImpl}).queryBounds(bounds));
    }
});
test('revision, body and framing failures cannot produce usable parcels',async()=>{
    for(const alter of [r=>new Response(r.body,{status:200,headers:r.headers}),
        r=>{r.headers.set('etag','"changed"');return r;},r=>{r.headers.set('content-range','bytes 0-1/2');return r;},
        async r=>new Response((await r.arrayBuffer()).slice(0,-1),{status:206,headers:r.headers})]) {
        const f=fixture(); await assert.rejects(createShapefileRangeParcelSource(f.d,{fetchImpl:async(...a)=>alter(await f.fetchImpl(...a))}).queryIds([f.ids.at(-1)]));
    }
    const f=fixture(),s=createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl});
    await assert.rejects(s.queryIds(['foreign']));assert.throws(()=>s.queryBounds([0,0,1,1]));assert.equal(f.calls.length,0);
    assert.throws(()=>createShapefileRangeParcelSource({...f.d,geometryEndpoint:'https://other.example/arbitrary.zip'}));
});
test('browser factory and fixed-source relay read the same live geometry member',async()=>{
    const f=fixture();
    const request=validateParcelProviderRelayRequest(f.d.id,{url:f.d.endpoint,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({_geojsonRangeOperation:'queryIds',input:[f.ids[0]]})},{sources:[f.d]});
    assert.equal(request.timeoutMs,60000);
    const browser=createShapefileRangeBrowserSource(f.d,{fetchImpl:async(url,init)=>fetchParcelProviderRelay(
        validateParcelProviderRelayRequest(f.d.id,{url,method:init.method,headers:init.headers,body:init.body},{sources:[f.d]}),
        {providerFetch:f.fetchImpl})});
    const data=await browser.queryIds([f.ids[0]]);assert.equal(data.features[0].id,f.ids[0]);assert.ok(f.calls.length);
    await assert.rejects(browser.queryIds(['foreign']));
});
