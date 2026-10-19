// Headless proof for complete large snapshots, privacy, release identity and fail-closed budgets.
import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGeojsonSnapshotParcelSource, encodeSnapshotNativeId, decodeSnapshotNativeId } from '../parcels/geojson-snapshot-source.js';
import { exactPolygonFingerprint, inspectGeojsonSnapshot } from '../parcels/disk-geojson-snapshot-source.js';
import { readGeojsonFeatureStream } from '../parcels/geojson-stream-reader.js';

const polygon = (x = 132.76) => ({ type: 'Polygon', coordinates: [[[x,33.82],[x+.001,33.82],[x+.001,33.821],[x,33.821],[x,33.82]]] });
const feature = (native = 'H1', geometry = polygon()) => ({ type: 'Feature', geometry,
    properties: { '市区町村C': '38201', '地図名': '図~松山', ID: native, owner: 'PRIVATE-MUST-NOT-PERSIST', address: 'PRIVATE-ADDRESS' } });
const collection = features => ({ type: 'FeatureCollection', name: '公開筆R_2025', features });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const native = value => encodeSnapshotNativeId(['38201','図~松山',value]);
const id = value => 'JP-' + native(value);
const bounds = [132.7599,33.8199,132.7612,33.8212];
const descriptor = data => ({ id: 'moj-test', endpoint: 'https://example.org/public.geojson', idPrefix: 'JP-',
    idFields: ['市区町村C','地図名','ID'], outFields: ['市区町村C','地図名','ID'], idNamespace: {field:'市区町村C',value:'38201'},
    snapshotStorage: 'disk', duplicateNativeIdentity: 'equivalent', expectedEtag: '"immutable"', expectedCollectionName: data.name,
    expectedSnapshotSha256: sha(JSON.stringify(data)), expectedSnapshotFeatures: data.features.length,
    maxSnapshotBytes: 1000000, maxSnapshotFeatures: 100, maxFeatures: 100, maxBboxKm2: 25,
    maxRecordBytes: 4096, maxMemoryBytes: 4194304, maxIndexBytes: 65536, maxDiskBytes: 1000000, snapshotTimeoutMs: 10000 });
function source(data, changes = {}, transport) {
    const fetchImpl = transport ?? (async () => new Response(JSON.stringify(data), { headers: {etag:'"immutable"'} }));
    const s = createGeojsonSnapshotParcelSource({...descriptor(data), ...changes}, { fetchImpl }); onTestFinished(() => s.close()); return s;
}
async function parse(text, split = 1) {
    const rows = [], bytes = Buffer.from(text);
    async function* chunks() { for (let i=0; i<bytes.length; i+=split) yield bytes.subarray(i,i+split); }
    const result = await readGeojsonFeatureStream(chunks(), {maxRecordBytes:4096,onFeature:f=>rows.push(f)}); return {...result,rows};
}

test('stream parser handles UTF8, escaped braces and every byte boundary, with metadata after features', async () => {
    const data = collection([feature('H"}\\1')]);
    const text = JSON.stringify({features:data.features, crs:{type:'name',properties:{name:'EPSG:4326'}}, type:data.type, name:data.name});
    for (const split of [1,2,7,65536]) {
        const result = await parse(text,split); assert.deepEqual(result.rows,data.features); assert.equal(result.count,1); assert.equal(result.metadata.name,data.name);
    }
});
for (const text of ['null','{}','{"type":"FeatureCollection"}', '{"type":"FeatureCollection","features":[',
    '{"type":"FeatureCollection","features":[],}', '{"type":"FeatureCollection","features":[{},]}',
    '{"type":"FeatureCollection","features":[],"features":[]}', JSON.stringify(collection([]))+'false',
    JSON.stringify({...collection([]),complete:false}), JSON.stringify({...collection([]),exceededTransferLimit:true}),
    JSON.stringify({...collection([]),crs:{type:'name',properties:{name:'EPSG:6672'}}})]) {
    test('parser rejects malformed/incomplete collection: '+text.slice(0,70), async()=>assert.rejects(parse(text)));
}
test('parser rejects invalid UTF8, oversized records and excessive envelope members', async()=>{
    await assert.rejects(readGeojsonFeatureStream([Buffer.from([255])],{maxRecordBytes:10,onFeature:()=>{}}));
    await assert.rejects(parse(JSON.stringify(collection([{...feature(),padding:'x'.repeat(5000)}]))),/memory limit/);
    await assert.rejects(parse(JSON.stringify({...collection([]),...Object.fromEntries(Array.from({length:33},(_,i)=>['extra'+i,i]))})));
});
test('safe IDs are reversible, canonical and delimiter safe',()=>{
    assert.deepEqual(decodeSnapshotNativeId(native('H1'),3),['38201','図~松山','H1']);
    for (const bad of ['38201~%ZZ~x',native('H1').replace('%7E','~'),native('H1').replace('%E5','%e5')]) assert.throws(()=>decodeSnapshotNativeId(bad,3));
    for (const value of [null,{},'',-1,1.1,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>encodeSnapshotNativeId(['38201','map',value]));
});
test('exact fingerprint tolerates ring rotation/direction/component order without rounding',()=>{
    const a=polygon(), ring=a.coordinates[0], reversed={type:'Polygon',coordinates:[[...ring].reverse()]};
    const rotated={type:'Polygon',coordinates:[[ring[2],ring[3],ring[0],ring[1],ring[2]]]};
    assert.equal(exactPolygonFingerprint(a),exactPolygonFingerprint(reversed)); assert.equal(exactPolygonFingerprint(a),exactPolygonFingerprint(rotated));
    assert.equal(exactPolygonFingerprint(a),exactPolygonFingerprint({type:'MultiPolygon',coordinates:[a.coordinates]}));
    assert.notEqual(exactPolygonFingerprint(a),exactPolygonFingerprint(polygon(132.76000000001)));
});
test('complete disk snapshot serves safe exact, absence, bbox and geometry reads with isolated objects',async ()=>{
    const data=collection([feature(),feature('H2',polygon(132.77))]); let calls=0;
    const s=source(data,{},async()=>{calls++; return new Response(JSON.stringify(data),{headers:{etag:'"immutable"','content-length':String(Buffer.byteLength(JSON.stringify(data)))}});});
    const result=await s.queryIds([id('H1'),id('missing'),id('H1')]);
    assert.equal(result.complete,true); assert.equal(result.snapshotSha256,descriptor(data).expectedSnapshotSha256);
    assert.deepEqual(result.absentIds,[id('missing')]); assert.equal(result.features.length,1);
    assert.deepEqual(Object.keys(result.features[0].properties.sourceProperties),descriptor(data).idFields);
    result.features[0].geometry.coordinates[0][0][0]=0;
    assert.deepEqual((await s.queryBounds(bounds)).features[0].geometry,polygon());
    assert.equal((await s.queryGeometry(polygon())).features.length,1); assert.equal(calls,1);
    for (const dir of await readdir(tmpdir())) if(dir.startsWith('parcel-geojson-')) {
        const text=await readFile(path.join(tmpdir(),dir,'safe-records.jsonl'),'utf8'); assert.doesNotMatch(text,/PRIVATE|owner|address/);
    }
});
test('equivalent repeated native IDs are verified, counted, and returned once without changing geometry',async ()=>{
    const reversed={type:'Polygon',coordinates:[[...polygon().coordinates[0]].reverse()]};
    const data=collection([feature(),feature('H1',reversed)]), s=source(data);
    assert.deepEqual((await s.queryIds([id('H1')])).features[0].geometry,polygon());
    const evidence=await inspectGeojsonSnapshot(descriptor(data), {fetchImpl:async()=>new Response(JSON.stringify(data),{headers:{etag:'"immutable"'}})});
    assert.equal(evidence.featureCount,2); assert.equal(evidence.duplicateNativeIds,1); assert.equal(evidence.conflictingNativeIds,0);
});
test('genuinely conflicting same-ID polygons fail every query after a complete pinned read',async ()=>{
    const data=collection([feature(),feature('H1',polygon(132.77))]),s=source(data);
    for(const query of [()=>s.queryIds([id('H1')]),()=>s.queryBounds(bounds),()=>s.queryIds([id('missing')])]) {
        await assert.rejects(query(),error=>{
            assert.equal(error.code,'parcel-snapshot-conflicting-identity'); assert.equal(error.snapshotEvidence.completeBody,true);
            assert.equal(error.snapshotEvidence.snapshotSha256,descriptor(data).expectedSnapshotSha256);
            assert.equal(error.snapshotEvidence.conflictingNativeIds,1); assert.notDeepEqual(error.snapshotEvidence.conflictExamples[0].firstBbox,error.snapshotEvidence.conflictExamples[0].conflictingBbox); return true;
        });
    }
});
test('default explicit reject policy rejects even equivalent native repeats',async ()=>{
    await assert.rejects(source(collection([feature(),feature()]),{duplicateNativeIdentity:'reject'}).queryBounds(bounds),/conflicting/);
});
for(const [changes,pattern] of [
    [{maxSnapshotBytes:10},/byte limit/], [{maxDiskBytes:10},/disk limit/], [{maxIndexBytes:10},/memory limit/],
    [{maxSnapshotFeatures:1,expectedSnapshotFeatures:1},/feature limit/], [{maxFeatures:1},/feature limit/],
    [{expectedSnapshotSha256:'0'.repeat(64)},/hash/], [{expectedSnapshotFeatures:3},/count/], [{expectedCollectionName:'2026'},/vintage/]
]) test('enforces configured budget/revision '+JSON.stringify(changes),async ()=>{
    const s=source(collection([feature(),feature('H2')]),changes); await assert.rejects(s.queryBounds(bounds),pattern);
});
for(const status of [206,403,429,500]) test('HTTP '+status+' fails closed',async ()=>{
    await assert.rejects(source(collection([]),{},async()=>new Response('{}',{status})).queryBounds(bounds),error=>{assert.equal(error.upstreamStatus,status); return true;});
});
for(const headers of [{'content-range':'bytes 0-100/99999'},{'content-length':'1'},{etag:'"changed"'},{'content-encoding':'gzip'},{'content-length':'garbage'}]) {
    test('rejects inconsistent transport '+JSON.stringify(headers),async ()=>{
        await assert.rejects(source(collection([]),{},async()=>new Response(JSON.stringify(collection([])),{headers:{etag:'"immutable"',...headers}})).queryBounds(bounds));
    });
}
test('rejects unsafe fields, missing release pins and unbounded budgets before transport',()=>{
    const d=descriptor(collection([]));
    for(const changes of [{expectedSnapshotSha256:undefined},{expectedEtag:undefined},{expectedSnapshotFeatures:undefined},
        {expectedCollectionName:undefined},{maxMemoryBytes:100},{maxDiskBytes:1e12},{snapshotTimeoutMs:0},
        {outFields:[...d.outFields,'owner']},{idFields:['owner'],outFields:['owner'],idNamespace:undefined}]) {
        assert.throws(()=>createGeojsonSnapshotParcelSource({...d,...changes}),/descriptor/);
    }
});
test('invalid clients, query size and geometry fail before fetching',async ()=>{
    let calls=0; const s=source(collection([]),{},async()=>{calls++;throw Error('should not fetch');});
    for(const ids of [[],['other-source'],['JP-38201~%ZZ~x'],Array(81).fill(id('H1'))]) await assert.rejects(s.queryIds(ids),{status:400});
    assert.throws(()=>s.queryBounds([0,0,10,10]),{status:400}); assert.throws(()=>s.queryGeometry({type:'Point',coordinates:[0,0]})); assert.equal(calls,0);
});
test('foreign namespace, bad native ID and malformed source geometry fail',async ()=>{
    for(const bad of [{...feature(),properties:{...feature().properties,'市区町村C':'other'}},
        {...feature(),properties:{...feature().properties,ID:null}}, {...feature(),geometry:null}]) await assert.rejects(source(collection([bad])).queryBounds(bounds));
});
test('failed reads clean temporary files, retry, serialize concurrent queries and expire without stale fallback',async ()=>{
    const existingDirs = new Set((await readdir(tmpdir())).filter(dir=>dir.startsWith('parcel-geojson-')));
    const data=collection([feature()]); let calls=0, clock=0;
    const fetchImpl=async()=>{calls++;return calls===2?new Response('',{status:503}):new Response(JSON.stringify(data),{headers:{etag:'"immutable"'}});};
    const s=createGeojsonSnapshotParcelSource(descriptor(data),{fetchImpl,now:()=>clock});onTestFinished(()=>s.close());
    await Promise.all([s.queryIds([id('H1')]),s.queryBounds(bounds)]);assert.equal(calls,1);
    clock=300000;await assert.rejects(s.queryIds([id('H1')]),/503/);
    assert.equal((await s.queryIds([id('H1')])).features.length,1);assert.equal(calls,3);
    await s.close();assert.equal((await readdir(tmpdir())).filter(dir=>dir.startsWith('parcel-geojson-') && !existingDirs.has(dir)).length,0);
});

test('query geometry bytes are bounded separately from the complete on-disk snapshot', async () => {
    const s=source(collection([feature()]),{maxIndexBytes:2048,maxMemoryBytes:2164736});
    await assert.rejects(s.queryIds([id('H1')]),/query exceeds memory limit/);
    await assert.rejects(s.queryBounds(bounds),/query exceeds memory limit/);
});
test('empty immutable disk snapshot explicitly proves absence',async ()=>{
    const s=source(collection([]));assert.deepEqual((await s.queryIds([id('missing')])).absentIds,[id('missing')]);
    assert.deepEqual((await s.queryBounds(bounds)).features,[]);
});

test('overlarge single transport chunks fail within the memory budget and cancel the stream', async () => {
    let cancelled=false;
    const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(1048577));},cancel(){cancelled=true;}});
    const s=source(collection([]),{maxSnapshotBytes:2000000},async()=>new Response(body,{headers:{etag:'"immutable"'}}));
    await assert.rejects(s.queryBounds(bounds),/transport chunk exceeds memory limit/);assert.equal(cancelled,true);
});
test('declared byte overflow cancels before consuming provider data',async ()=>{
    let reads=0,cancelled=false;
    const body=new ReadableStream({pull(){reads++;},cancel(){cancelled=true;}},{highWaterMark:0});
    const s=source(collection([]),{},async()=>new Response(body,{headers:{etag:'"immutable"','content-length':'1000001'}}));
    await assert.rejects(s.queryBounds(bounds),/byte limit/);assert.equal(reads,0);assert.equal(cancelled,true);
});

test('stream parser enforces JSON whitespace and bounded typed envelope metadata', async () => {
    for (const text of [
        '\u00a0' + JSON.stringify(collection([])),
        JSON.stringify(collection([])).replace(':[]', ':\u00a0[]'),
        JSON.stringify({...collection([]), name:{owner:'PRIVATE'}}),
        JSON.stringify({...collection([]), name:'x'.repeat(1025)}),
        JSON.stringify({...collection([]), ['x'.repeat(257)]:null}),
        JSON.stringify({...collection([]), crs:{type:'name',properties:{name:'EPSG:4326',owner:'PRIVATE'}}}),
        JSON.stringify({...collection([]), complete:'true'}),
        JSON.stringify({...collection([]), exceededTransferLimit:0})
    ]) await assert.rejects(parse(text));
    assert.equal((await parse(' \t\r\n' + JSON.stringify(collection([])) + '\n')).count, 0);
    for (const maxRecordBytes of [undefined, 0, -1, Infinity, 1.5]) {
        await assert.rejects(readGeojsonFeatureStream([], {maxRecordBytes, onFeature:()=>{}}), /limits/);
    }
});
test('rejects unsafe geometry foreign members and malformed extra ordinates without storing them', async () => {
    for (const geometry of [
        {...polygon(), owner:'PRIVATE'},
        {...polygon(), bbox:[0,0,'PRIVATE',1]},
        {...polygon(), coordinates:polygon().coordinates.map(ring=>ring.map(point=>[...point,{owner:'PRIVATE'}]))},
        {...polygon(), coordinates:polygon().coordinates.map(ring=>ring.map(point=>[...point,Infinity]))},
        {...polygon(), coordinates:polygon().coordinates.map(ring=>ring.map((point,i)=>[...point,i]))}
    ]) await assert.rejects(source(collection([feature('H1',geometry)])).queryIds([id('H1')]),
        {code:'parcel-snapshot-invalid-geometry'});
    const geometry = {...polygon(), coordinates:polygon().coordinates.map(ring=>ring.map(point=>[...point,5]))};
    assert.deepEqual((await source(collection([feature('H1',geometry)])).queryIds([id('H1')])).features[0].geometry, geometry);
});
test('verified snapshot profile remains fixed if the caller edits identity arrays or namespace', async () => {
    const data=collection([feature()]), d=descriptor(data);
    const s=createGeojsonSnapshotParcelSource(d, {fetchImpl:async()=>new Response(JSON.stringify(data), {headers:{etag:'"immutable"'}})});
    onTestFinished(()=>s.close());
    d.idFields[2]='owner'; d.outFields.push('owner'); d.idNamespace.value='changed';
    const result=await s.queryIds([id('H1')]);
    assert.equal(result.features.length,1);
    assert.deepEqual(Object.keys(result.features[0].properties.sourceProperties), descriptor(data).outFields);
});
test('no early exact result is published before the full body, final syntax and hash are verified', async () => {
    const data=collection([feature()]);
    for (const text of [JSON.stringify(data).slice(0,-1), JSON.stringify(data)+'false']) {
        const s=source(data,{},async()=>new Response(text,{headers:{etag:'"immutable"'}}));
        await assert.rejects(s.queryIds([id('H1')]),{code:'parcel-snapshot-malformed'});
    }
});
test('multipart and hole order fingerprints preserve every distinct component', () => {
    const outer=polygon().coordinates, second=polygon(132.77).coordinates;
    const hole=polygon(132.7602).coordinates[0];
    const a={type:'MultiPolygon',coordinates:[[outer[0],hole],second]};
    const b={type:'MultiPolygon',coordinates:[second,[outer[0],[...hole].reverse()]]};
    assert.equal(exactPolygonFingerprint(a),exactPolygonFingerprint(b));
    assert.notEqual(exactPolygonFingerprint(a),exactPolygonFingerprint({type:'MultiPolygon',coordinates:[outer,second]}));
});
test('complete streaming load exceeds the former 3 MiB / 3000 feature ceiling without retaining a full response', async () => {
    const count=6000;
    function* chunks() {
        yield Buffer.from('{"type":"FeatureCollection","name":"公開筆R_2025","features":[');
        for(let i=0;i<count;i++) {
            const row=feature('H'+i); row.properties.address='PRIVATE-'+ 'x'.repeat(1024);
            yield Buffer.from((i?',':'')+JSON.stringify(row));
        }
        yield Buffer.from(']}');
    }
    const hash=createHash('sha256'); let bytes=0;
    for(const chunk of chunks()) {hash.update(chunk);bytes+=chunk.length;}
    assert.ok(bytes>3*1024**2);
    const d={...descriptor(collection([])),expectedSnapshotSha256:hash.digest('hex'),expectedSnapshotFeatures:count,
        maxSnapshotBytes:16*1024**2,maxSnapshotFeatures:count,maxDiskBytes:8*1024**2,
        maxIndexBytes:16*1024**2,maxMemoryBytes:64*1024**2};
    let pulls=0;
    const s=createGeojsonSnapshotParcelSource(d,{fetchImpl:async()=>{
        const generator=chunks();
        return new Response(new ReadableStream({pull(controller){pulls++; const row=generator.next();
            if(row.done)controller.close();else controller.enqueue(row.value);}}, {highWaterMark:0}),
            {headers:{etag:'"immutable"','content-length':String(bytes)}});
    }});
    onTestFinished(()=>s.close());
    const result=await s.queryIds([id('H5999'),id('missing')]);
    assert.equal(result.complete,true);assert.equal(pulls,count+3);
    assert.deepEqual(result.absentIds,[id('missing')]);assert.equal(result.features[0].id,id('H5999'));
    assert.equal(result.snapshotSha256,d.expectedSnapshotSha256);
});
