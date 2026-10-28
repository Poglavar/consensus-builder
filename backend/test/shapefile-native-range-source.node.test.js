// Native composite IDs, revision pins and bounded member reads work through backend and browser relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { createShapefileRangeParcelSource, createShapefileRangeBrowserSource } from '../parcels/shapefile-range-source.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { verifiedProjection, SHAPEFILE_CRS } from '../parcels/shapefile-zip-reader.js';
import proj4 from 'proj4';

const prj = 'PROJCS["MAGNA-SIRGAS_2018_Origen-Nacional",GEOGCS["MAGNA-SIRGAS_2018",DATUM["Marco_Geocentrico_Nacional_de_Referencia_2018",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",5000000],PARAMETER["False_Northing",2000000],PARAMETER["Central_Meridian",-73],PARAMETER["Scale_Factor",0.9992],PARAMETER["Latitude_Of_Origin",4],UNIT["Meter",1]]';
const square = (x, y, s) => [[x,y],[x,y+s],[x+s,y+s],[x+s,y],[x,y]];
function fixture({ wrongCrc = false, wrongProjection = false, recordCount = 3, emptyCode = false } = {}) {
    const rings = [square(4971580,2714440,20), square(4971585,2714445,5).reverse(), square(4971620,2714440,10)];
    const points = rings.flat(), polygon = Buffer.alloc(44 + rings.length * 4 + points.length * 16);
    polygon.writeUInt32LE(5); [4971580,2714440,4971630,2714460].forEach((n,i)=>polygon.writeDoubleLE(n,4+i*8));
    polygon.writeUInt32LE(rings.length,36); polygon.writeUInt32LE(points.length,40); let offset=0;
    rings.forEach((r,i)=>{polygon.writeUInt32LE(offset,44+i*4);offset+=r.length;});
    points.flat().forEach((n,i)=>polygon.writeDoubleLE(n,44+rings.length*4+i*8));
    // Two identical full polygons with distinct native composites, followed by a null geometry.
    const records=Array.from({length:recordCount},(_,i)=>i===recordCount-1?Buffer.alloc(4):polygon), shp=Buffer.alloc(100+records.reduce((n,r)=>n+8+r.length,0));
    shp.writeUInt32BE(9994);shp.writeUInt32BE(shp.length/2,24);shp.writeUInt32LE(1000,28);shp.writeUInt32LE(5,32);offset=100;
    records.forEach((r,i)=>{shp.writeUInt32BE(i+1,offset);shp.writeUInt32BE(r.length/2,offset+4);r.copy(shp,offset+8);offset+=8+r.length;});
    const head=129,width=45,dbf=Buffer.alloc(head+records.length*width+1,32);dbf.fill(0,0,head);dbf[0]=3;
    dbf.writeUInt32LE(records.length,4);dbf.writeUInt16LE(head,8);dbf.writeUInt16LE(width,10);
    [['codigo','C',30],['Shape_Id','N',10],['OWNER','C',4]].forEach(([name,type,len],i)=>{const at=32+i*32;dbf.write(name,at);dbf[at+11]=type.charCodeAt(0);dbf[at+16]=len;});dbf[head-1]=13;
    for(let i=0;i<records.length;i++){const at=head+i*width;if(!emptyCode||i!==0)dbf.write('200010100000000000000000001',at+1);dbf.write(String(i+1).padStart(10),at+31);dbf.fill(255,at+41,at+45);}dbf[dbf.length-1]=26;
    const files={'U_TERRENO.dbf':dbf,'U_TERRENO.shp':shp,'U_TERRENO.prj':new TextEncoder().encode(wrongProjection?prj.replace('5000000','5000001'):prj),'U_TERRENO.cpg':new TextEncoder().encode('UTF-8')};
    const bytes=zipSync(files), zipMembers={};
    let pos=0;
    while(new DataView(bytes.buffer).getUint32(pos,true)===0x04034b50){
        const v=new DataView(bytes.buffer),nl=v.getUint16(pos+26,true),el=v.getUint16(pos+28,true),name=new TextDecoder().decode(bytes.subarray(pos+30,pos+30+nl));
        const m={name,localOffset:pos,dataStart:pos+30+nl+el,method:v.getUint16(pos+8,true),crc32:v.getUint32(pos+14,true),compressedBytes:v.getUint32(pos+18,true),uncompressedBytes:v.getUint32(pos+22,true)};
        zipMembers[name.split('.').at(-1)]=m;pos=m.dataStart+m.compressedBytes;
    }
    const d={id:'co-test-native',adapter:'shapefile-range',archiveAccess:'native-dbf-range-v1',endpoint:'https://publisher.example/U_TERRENO.zip',sourceLayer:'U_TERRENO',sourceCrs:'EPSG:9377',
        expectedEtag:'"pin"',expectedSnapshotBytes:bytes.length,expectedSnapshotFeatures:recordCount,idPrefix:'TEST-',idField:'codigo',idFields:['codigo','Shape_Id'],outFields:['codigo','Shape_Id'],zipMembers,
        rangeBytes:1024,maxFeatures:100,maxRecordPoints:1000,maxBboxKm2:25,dbfEncoding:'utf-8',browserTransport:'relay'};
    if(wrongCrc){d.zipMembers.shp.crc32=0;new DataView(bytes.buffer).setUint32(d.zipMembers.shp.localOffset+14,0,true);}
    const calls=[];
    const fetchImpl=async(url,init)=>{
        assert.equal(String(url),d.endpoint);const h=new Headers(init.headers);assert.equal(h.get('if-match'),d.expectedEtag);
        assert.ok(h.get('accept').includes('application/x-zip-compressed'));
        const [start,end]=h.get('range').match(/^bytes=(\d+)-(\d+)$/).slice(1).map(Number);calls.push([start,end]);
        return new Response(bytes.slice(start,end+1),{status:206,headers:{etag:d.expectedEtag,'content-range':`bytes ${start}-${end}/${bytes.length}`}});
    };
    return {d,fetchImpl,calls,rings,ids:Array.from({length:recordCount},(_,i)=>'TEST-'+(emptyCode&&i===0?'':'200010100000000000000000001')+'~'+(i+1))};
}
const bounds=[-73.25982,10.46514,-73.2592,10.4654];
test('EPSG:9377 agrees with independent PROJ control and rejects changed publisher parameters',()=>{
    const p=verifiedProjection(new TextEncoder().encode(prj),'EPSG:9377');
    const control=p.forward([4971580.528734986,2714440.2136168233]);
    assert.ok(Math.abs(control[0]+73.2597933292061)<1e-10);assert.ok(Math.abs(control[1]-10.4651505401655)<1e-10);
    assert.throws(()=>verifiedProjection(new TextEncoder().encode(prj.replace('5000000','5000010')),'EPSG:9377'));
});
test('repeatable cold exact IDs preserve all rings, holes and parts and decode only safe fields',async()=>{
    const f=fixture();let previous;
    for(let i=0;i<2;i++){
        const r=await createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryIds([f.ids[0]]),g=r.features[0].geometry;
        assert.equal(g.type,'MultiPolygon');assert.deepEqual(g.coordinates.map(p=>p.length),[2,1]);
        assert.deepEqual(g.coordinates[0],f.rings.slice(0,2).map(r=>r.map(p=>proj4(SHAPEFILE_CRS['EPSG:9377'],'EPSG:4326',p))));
        assert.deepEqual(r.features[0].properties.sourceProperties,{codigo:'200010100000000000000000001',Shape_Id:1});
        assert.deepEqual(r.absentIds,[]);assert.ok(r.statistics.extractedBytes<10000);
        if(previous)assert.deepEqual(g,previous);previous=g;
    }
});
test('area scans preserve duplicate geometry with distinct IDs and handle null rows explicitly',async()=>{
    const f=fixture(),s=createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl});
    const r=await s.queryBounds(bounds);assert.deepEqual(r.features.map(f=>f.id),f.ids.slice(0,2));assert.equal(r.nullGeometryRows,1);
    const before=f.calls.length,exact=await s.queryIds(f.ids.slice(0,2));assert.equal(f.calls.length,before);assert.deepEqual(exact.features,r.features);
    await assert.rejects(s.queryIds([f.ids[2]]),/no published polygon/);
    assert.deepEqual((await s.queryIds(['TEST-missing~0'])).absentIds,['TEST-missing~0']);
    assert.deepEqual((await s.queryBounds([0,0,0.001,0.001])).features,[]);
});
test('full member CRC, changed projection, revision and truncated ranges fail closed',async()=>{
    for(const opts of [{wrongCrc:true},{wrongProjection:true}]){
        const f=fixture(opts);await assert.rejects(createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryBounds(bounds));
    }
    for(const change of [r=>{r.headers.set('etag','"new"');return r;},async r=>new Response((await r.arrayBuffer()).slice(0,-1),{status:206,headers:r.headers})]){
        const f=fixture();await assert.rejects(createShapefileRangeParcelSource(f.d,{fetchImpl:async(...args)=>change(await f.fetchImpl(...args))}).queryIds([f.ids[0]]));
    }
    const f=fixture(),s=createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl});await assert.rejects(s.queryIds(['foreign']));assert.equal(f.calls.length,0);
});
test('existing browser registration and fixed-source relay dispatch native member profile',async()=>{
    const f=fixture(),browser=createShapefileRangeBrowserSource(f.d,{fetchImpl:async(url,init)=>fetchParcelProviderRelay(
        validateParcelProviderRelayRequest(f.d.id,{url,method:init.method,headers:init.headers,body:init.body},{sources:[f.d]}),{providerFetch:f.fetchImpl})});
    const r=await browser.queryIds([f.ids[0]]);assert.equal(r.features[0].id,f.ids[0]);assert.equal(r.features[0].geometry.type,'MultiPolygon');
});
test('empty native components require explicit opt-in and retain the other native component',async()=>{
    const f=fixture({emptyCode:true});
    await assert.rejects(createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryBounds(bounds),/native DBF identity/);
    const s=createShapefileRangeParcelSource({...f.d,emptyIdFields:['codigo']},{fetchImpl:f.fetchImpl});
    const r=await s.queryBounds(bounds);assert.deepEqual(r.features.map(f=>f.id),['TEST-~1',f.ids[1]]);assert.equal(r.emptyIdentityRows,1);
    assert.equal((await s.queryIds(['TEST-~1'])).features[0].properties.sourceProperties.codigo,'');
    await assert.rejects(s.queryIds(['TEST-~']));
});
test('cold native exact reads stop before fully downloading or inflating large members',async()=>{
    const f=fixture({recordCount:2000}),r=await createShapefileRangeParcelSource(f.d,{fetchImpl:f.fetchImpl}).queryIds([f.ids[0]]);
    assert.equal(r.features.length,1);
    assert.ok(r.statistics.downloadedBytes<f.d.zipMembers.shp.compressedBytes);
    assert.ok(r.statistics.extractedBytes<f.d.zipMembers.shp.uncompressedBytes/10);
});
