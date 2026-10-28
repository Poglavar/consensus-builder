import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate';
import proj4 from 'proj4';
import { createHash } from 'node:crypto';
import { createSantosLotesSource, santosLotReferences, SANTOS_ENDPOINT, SANTOS_CRS } from '../parcels/santos-lotes-source.js';
import { readShapefilePolygon, nativePolygonWkb } from '../parcels/shapefile-zip-reader.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const ring = [[364353.1587023408,7349496.175607921,0],[364383.05186203565,7349493.003162581,0],
    [364382.30857880414,7349486.4268339025,0],[364352.5276689971,7349489.733781454,0],[364353.1587023408,7349496.175607921,0]];
const expectedHash = '72d171c56d2ea53fcc342569d1e2b1588dce70d138bff2a1316ec8d9d441792c';
const prefix = 'BR-SANTOS-MAPA-LOTES-2026:LOTE:';
const id = `${prefix}55044022:GEOMSHA256:${expectedHash}`;
const hash = b => createHash('sha256').update(b).digest('hex');
const v = b => new DataView(b.buffer,b.byteOffset,b.byteLength);
function crc(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i=0;i<8;i++) c = c&1 ? 0xedb88320^(c>>>1) : c>>>1; } return (c^0xffffffff)>>>0; }
function polygonRecord() {
    const b = new Uint8Array(44+4+5*16+16+5*8), d = v(b);
    d.setUint32(0,15,true); [364352.5276689971,7349486.4268339025,364383.05186203565,7349496.175607921].forEach((n,i)=>d.setFloat64(4+i*8,n,true));
    d.setUint32(36,1,true);d.setUint32(40,5,true);
    ring.forEach((p,i)=>{d.setFloat64(48+i*16,p[0],true);d.setFloat64(56+i*16,p[1],true);d.setFloat64(144+i*8,p[2],true);});
    return b;
}
function fixture() {
    const count=44278, record=polygonRecord(), shp=new Uint8Array(100+count*(record.length+8)), s=v(shp);
    s.setUint32(0,9994);s.setUint32(24,shp.length/2);s.setUint32(28,1000,true);s.setUint32(32,15,true);
    for(let i=0;i<count;i++){const offset=100+i*(record.length+8);s.setUint32(offset,i+1);s.setUint32(offset+4,record.length/2);shp.set(record,offset+8);}
    // Include a private-looking unselected column to verify that only LOTE is returned.
    const width=17,header=97,dbf=new Uint8Array(header+count*width+1);dbf.fill(32);const b=v(dbf);
    dbf[0]=3;b.setUint32(4,count,true);b.setUint16(8,header,true);b.setUint16(10,width,true);
    dbf.fill(0,32,96);dbf.set(new TextEncoder().encode('LOTE'),32);dbf[43]=78;dbf[48]=8;
    dbf.set(new TextEncoder().encode('PRIVATE'),64);dbf[75]=67;dbf[80]=8;dbf[96]=13;dbf[dbf.length-1]=26;
    for(let i=0;i<count;i++){dbf.set(new TextEncoder().encode(i===0?'55044022':i===2?'********':'       2'),header+i*width+1);dbf.set(new TextEncoder().encode('ignored!'),header+i*width+9);}
    const d={id:'br-santos-prefeitura-mapa-lotes-2026',adapter:'santos-lotes',endpoint:SANTOS_ENDPOINT,sourceCrs:'EPSG:31983',idPrefix:prefix,
        expectedArchiveBytes:4046406,expectedSnapshotFeatures:count,expectedEtag:'"3dbe46-64caca3bb0900"',outFields:['LOTE'],parcelNumberField:'LOTE',
        maxFeatures:10000,maxRecordPoints:1000,zipMembers:{},browserTransport:'relay'};
    const prj=new TextEncoder().encode('verified projection fixture');d.prjSha256=hash(prj);
    const bodies=new Map();let localOffset=0;
    for(const [kind,bytes] of Object.entries({prj,dbf,shp})) {
        const name=`LOTES_2026-SIR.${kind}`,nameBytes=new TextEncoder().encode(name),compressed=deflateSync(bytes),headerBytes=30+nameBytes.length;
        const body=new Uint8Array(headerBytes+compressed.length),h=v(body);h.setUint32(0,0x04034b50,true);h.setUint16(8,8,true);h.setUint16(26,nameBytes.length,true);
        body.set(nameBytes,30);body.set(compressed,headerBytes);
        d.zipMembers[kind]={name,localOffset,dataOffset:localOffset+headerBytes,compressedBytes:compressed.length,bytes:bytes.length,crc:crc(bytes)};
        bodies.set(`bytes=${localOffset}-${localOffset+body.length-1}`,body);localOffset+=body.length;
    }
    const calls=[];let cancelled=0;
    const fetchImpl=async (url,init)=>{
        assert.equal(url,SANTOS_ENDPOINT);assert.equal(init.headers['If-Match'],d.expectedEtag);
        const range=init.headers.Range,bytes=bodies.get(range);assert.ok(bytes);calls.push(range);let offset=0;
        return new Response(new ReadableStream({pull(controller){if(offset===bytes.length){controller.close();return;}
            controller.enqueue(bytes.slice(offset,offset+256));offset=Math.min(bytes.length,offset+256);},cancel(){cancelled++;}}),
            {status:206,headers:{etag:d.expectedEtag,'content-range':`${range.replace('=',' ')}/${d.expectedArchiveBytes}`}});
    };
    return {d,fetchImpl,calls,dbf,cancelled:()=>cancelled};
}

test('Santos native PolygonZ serializes byte-for-byte like the independent OGR control',()=>{
    const record=polygonRecord(),result=readShapefilePolygon(v(record),0,record.length,proj4(SANTOS_CRS,'EPSG:4326'),{maxRecordPoints:1000});
    assert.deepEqual(result.nativeGeometry,{type:'Polygon',coordinates:[ring]});
    assert.equal(hash(nativePolygonWkb(result.nativeGeometry)),expectedHash);
    assert.equal(result.geometry.coordinates[0].every(p=>p.length===3&&p[2]===0),true);
});
test('DBF decoder keeps only numeric LOTE and recognizes DBF numeric NULLs',()=>{
    const f=fixture(),lots=santosLotReferences(f.dbf,44278);assert.equal(lots[0],'55044022');assert.equal(lots[2],'NULL');assert.equal(lots[4],'2');
});
test('production exact reads stop early, repeat independently and reject a changed release',async()=>{
    const f=fixture();
    for(let i=0;i<2;i++){
        const result=await createParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryIds([id]);
        assert.equal(result.features[0].id,id);assert.equal(result.features[0].geometry.coordinates[0][0].length,3);
        assert.deepEqual(Object.keys(result.features[0].properties.sourceProperties),['LOTE']);
        assert.equal(result.readStatistics.cancelledAfterExactMatch,1);
    }
    assert.equal(f.calls.length,6);assert.ok(f.cancelled()>=2);
    const source=createSantosLotesSource(f.d,{fetchImpl:async()=>new Response('changed',{status:206,headers:{etag:'"changed"'}})});
    await assert.rejects(source.queryIds([id]),/revision changed/);
});
test('release row hints bound DBF decoding while the LOTE and exact WKB remain the identity',async()=>{
    const f=fixture();f.d.exactReadHints={[id]:0};
    const result=await createSantosLotesSource(f.d,{fetchImpl:f.fetchImpl}).queryIds([id]);
    assert.equal(result.features[0].id,id);
    assert.equal(result.readStatistics.cancelledAfterExactMatch,2);
    assert.ok(result.readStatistics.actualInflatedBytes < f.d.zipMembers.dbf.bytes);
    const wrong=fixture();wrong.d.exactReadHints={[`${prefix}2:GEOMSHA256:${expectedHash}`]:0};
    await assert.rejects(createSantosLotesSource(wrong.d,{fetchImpl:wrong.fetchImpl})
        .queryIds([`${prefix}2:GEOMSHA256:${expectedHash}`]),/row hint no longer matches/);
});
test('bounds preserve overlapping distinct references and reuse only the in-memory SHP member',async()=>{
    const f=fixture(),source=createSantosLotesSource(f.d,{fetchImpl:f.fetchImpl});
    const bounds=[-46.3332,-23.9607,-46.3328,-23.9605];
    const first=await source.queryBounds(bounds);assert.equal(first.complete,true);assert.equal(first.features.length,3);
    assert.ok(first.features.some(feature=>feature.id===id));
    assert.equal(new Set(first.features.map(feature=>feature.id)).size,3);
    const calls=f.calls.length;assert.equal((await source.queryIds([id])).features.length,1);
    assert.equal((await source.queryBounds(bounds)).features.length,3);assert.equal(f.calls.length,calls);
    assert.equal((await source.queryIds([`${prefix}55044022:GEOMSHA256:${'0'.repeat(64)}`])).absentIds.length,1);
});
test('browser factory and fixed-source relay execute the real source reader',async()=>{
    const f=fixture();
    const fetchImpl=async(url,init)=>{
        const request=validateParcelProviderRelayRequest(f.d.id,{url,method:init.method,headers:init.headers,body:init.body},{sources:[f.d]});
        return fetchParcelProviderRelay(request,{providerFetch:f.fetchImpl});
    };
    // The relay normalizes request headers to Headers, as its real HTTPS transport expects.
    const original=f.fetchImpl;
    // Fixture expects the same header names used by the production reader.
    f.fetchImpl=async(url,init)=>{const h=new Headers(init.headers);return original(String(url),{...init,headers:{Range:h.get('range'),'If-Match':h.get('if-match')}});};
    const result=await browserParcelFactories['santos-lotes'](f.d,{fetchImpl}).queryIds([id]);
    assert.equal(result.complete,true);assert.equal(result.features[0].id,id);
    await assert.rejects(fetchImpl(SANTOS_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({_santosOperation:'constructor',input:[]})}),e=>e.status===400);
});
