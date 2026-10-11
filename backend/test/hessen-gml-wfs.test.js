// Hessen WFS protocol, safe native identity and unpaged completeness regression tests.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createGmlWfsParcelSource } from '../parcels/gml-wfs-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { HESSEN_GML_SCHEMA, SAXONY_GML_SCHEMA, parseGmlParcels } from '../parcels/gml-parcel-reader.js';

const ID = 'DEHE062000013CfcFL', ID2 = 'DEHE062000013CfdFL', MISSING = 'DEHE000000000000FL';
const prefix = 'DE-HE-';
const descriptor = {
    id: 'hessen-alkis-vereinfacht-wfs', adapter: 'gml-wfs', version: '2.0.0',
    endpoint: 'https://www.gds.hessen.de/wfs2/aaa-suite/cgi-bin/alkis/vereinf/wfs',
    featureType: 'ave:Flurstueck', idField: 'oid', geometryField: 'geometrie',
    responseCrs: 'EPSG:25832', idPrefix: prefix, idType: 'string',
    parcelNumberField: 'oid', outFields: ['oid'], pageSize: 1, maxFeatures: 300, maxBboxKm2: 1
};
const ring = '445834 5542639 445844 5542639 445844 5542649 445834 5542649 445834 5542639';
function member(id = ID, { gmlId = id, extra = '', coordinates = ring } = {}) {
    return `<wfs:member><a:Flurstueck g:id="${gmlId}"><a:oid>${id}</a:oid>${extra}<a:geometrie><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::25832" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>${coordinates}</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></a:geometrie></a:Flurstueck></wfs:member>`;
}
function collection(features = '', matched = 'unknown', returned = 1) {
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:a="${HESSEN_GML_SCHEMA.featureNamespace}" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="${matched}" numberReturned="${returned}">${features}</wfs:FeatureCollection>`;
}
const response = xml => new Response(xml, { headers: { 'content-type': 'application/gml+xml; version=3.2' } });
const hits = n => response(collection('', n, 0));
const parse = xml => parseGmlParcels(xml, { schema: HESSEN_GML_SCHEMA });
function transport(ids = [ID], { matched = ids.length, dataMatched = 'unknown', returned = ids.length, after = matched, xml } = {}) {
    const requests = []; let hitCalls = 0;
    const fetchImpl = async (url, init) => {
        const u = new URL(url); requests.push({ u, init });
        return u.searchParams.get('resultType') === 'hits' ? hits(++hitCalls === 1 ? matched : after)
            : response(xml ?? collection(ids.map(id => member(id)).join(''), dataMatched, returned));
    };
    return { requests, fetchImpl };
}

test('Hessen parser preserves case, easting/northing, MultiSurface components and holes; discards all other properties', async () => {
    const hole = '<g:interior><g:LinearRing><g:posList>445836 5542641 445838 5542641 445838 5542643 445836 5542643 445836 5542641</g:posList></g:LinearRing></g:interior>';
    let xml = member(ID, { extra: '<a:owner>DO-NOT-RETAIN</a:owner><a:lagebeztxt>DO-NOT-RETAIN</a:lagebeztxt>' });
    xml = xml.replace('</g:Polygon>', hole + '</g:Polygon>');
    const surface = /<g:surfaceMember>[\s\S]*?<\/g:surfaceMember>/.exec(xml)[0];
    xml = xml.replace('</g:MultiSurface>', surface + '</g:MultiSurface>');
    const result = await parse(collection(xml));
    assert.equal(result.features[0].id, ID);
    assert.deepEqual(result.features[0].properties, { oid: ID });
    assert.equal(result.features[0].geometry.type, 'MultiPolygon');
    assert.equal(result.features[0].geometry.coordinates.length, 2);
    assert.equal(result.features[0].geometry.coordinates[0].length, 2);
    const expected = proj4('EPSG:25832', 'EPSG:4326').forward([445834,5542639]);
    assert.deepEqual(result.features[0].geometry.coordinates[0][0][0], expected);
    assert.ok(Math.abs(expected[0] - 8.244) < .01 && Math.abs(expected[1] - 50.033) < .01);
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-RETAIN|owner|lagebeztxt/);
});

test('strict Hessen identity is direct, unique, shaped and bound to gml:id', async () => {
    const variants = [member(ID, {gmlId:ID2}), member().replace(' g:id="'+ID+'"',''),
        member('DEHEunsafeFL'), member().replace('<a:oid>'+ID+'</a:oid>', '<a:other><a:oid>'+ID+'</a:oid></a:other>'),
        member().replace('<a:oid>'+ID+'</a:oid>', '<a:oid>'+ID+'</a:oid><a:oid>'+ID+'</a:oid>'),
        member().replace('<a:oid>'+ID+'</a:oid>', '<a:oid><a:other>'+ID+'</a:other></a:oid>'),
        member().replace('<a:geometrie>', '<a:other><a:geometrie>').replace('</a:geometrie>', '</a:geometrie></a:other>')];
    for (const xml of variants) await assert.rejects(parse(collection(xml)));
});

test('Hessen parsing fails closed on malformed XML, namespace/CRS drift and unsupported or unclosed geometry', async () => {
    for (const xml of [collection(member()).slice(0,-10), '<!DOCTYPE x>'+collection(member()),
        collection(member()).replaceAll('http://www.opengis.net/gml/3.2', 'http://www.opengis.net/gml'),
        collection(member()).replaceAll('EPSG::25832','EPSG::25833'),
        collection(member()).replaceAll('g:Polygon','g:Curve'),
        collection(member(ID, {coordinates: ring.replace(/445834 5542639$/, '445835 5542639')})),
        collection(member()).replaceAll('srsDimension="2"','srsDimension="3"'),
        collection(member(),1,0)]) await assert.rejects(parse(xml));
});

test('Hessen never omits referenced, empty or path-confused geometry components', async () => {
    const extraComponents = [
        '<g:surfaceMember xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#other"/>',
        '<g:surfaceMember/>', '<g:surfaceMembers/>',
        '<g:surfaceMember><g:Surface><g:patches/></g:Surface></g:surfaceMember>'
    ];
    for (const extra of extraComponents) {
        await assert.rejects(parse(collection(member().replace('</g:MultiSurface>', extra + '</g:MultiSurface>'))));
    }
    for (const xml of [
        member().replace('</g:Polygon>', '<g:interior><g:LinearRing/></g:interior></g:Polygon>'),
        member().replace('<g:surfaceMember>', '').replace('</g:surfaceMember>', ''),
        member().replace('<g:LinearRing>', '').replace('</g:LinearRing>', ''),
        member().replace('<a:geometrie>', '<a:geometrie xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#other">')
    ]) await assert.rejects(parse(collection(xml)));
});

test('Hessen preserves inline Surface patches as separate polygon components', async () => {
    const patch = /<g:Polygon>[\s\S]*?<\/g:Polygon>/.exec(member())[0]
        .replaceAll('g:Polygon', 'g:PolygonPatch');
    const xml = member().replace(/<g:Polygon>[\s\S]*?<\/g:Polygon>/,
        '<g:Surface><g:patches>' + patch + patch + '</g:patches></g:Surface>');
    const result = await parse(collection(xml));
    assert.equal(result.features[0].geometry.type, 'MultiPolygon');
    assert.equal(result.features[0].geometry.coordinates.length, 2);
});

test('area enumeration is a single unpaged response with actual counts, unchanged pre/post predicate and safe properties', async () => {
    const {fetchImpl,requests} = transport([ID,ID2]);
    const s = createParcelSource(descriptor, {fetchImpl});
    const center = proj4('EPSG:25832','EPSG:4326').forward([445839,5542644]);
    const bounds = [center[0]-.0002,center[1]-.0002,center[0]+.0002,center[1]+.0002];
    const result = await s.queryBounds(bounds);
    assert.equal(result.complete,true); assert.equal(result.features.length,2);
    assert.deepEqual(result.completenessEvidence,{paging:false,matchedBefore:2,matchedAfter:2,numberReturned:2,parsedFeatureCount:2,uniqueNativeCount:2});
    assert.equal(requests.length,3);
    assert.equal(requests[1].u.searchParams.get('count'),'2');
    const filter = requests[0].u.searchParams.get('filter');
    assert.match(filter, /<fes:Intersects>/); assert.match(filter, /ave:geometrie/);
    const xy = /<gml:posList srsDimension="2">([^<]+)/.exec(filter)[1].split(' ').map(Number);
    assert.ok(xy[0] > 400000 && xy[0] < 500000 && xy[1] > 5500000);
    for (const {u,init} of requests) {
        assert.equal(u.searchParams.get('propertyName'),'ave:oid,ave:geometrie');
        assert.equal(u.searchParams.get('srsName'),'urn:ogc:def:crs:EPSG::25832');
        assert.equal(u.searchParams.get('filter'),filter);
        assert.equal(u.searchParams.has('startIndex'),false); assert.equal(u.searchParams.has('sortBy'),false);
        assert.equal(init.redirect,'error');
    }
    assert.deepEqual(result.features[0].properties.sourceProperties,{oid:ID});
});

test('page size one executes distinct unpaged exact predicates and does not truncate area-style ID batches', async () => {
    const requests=[];
    const fetchImpl=async url=>{
        const u=new URL(url);requests.push(u);
        const ids=[...u.searchParams.get('filter').matchAll(/<fes:Literal>([^<]+)<\/fes:Literal>/g)].map(m=>m[1]);
        const found=ids.filter(id=>id!==MISSING);
        return u.searchParams.get('resultType')==='hits' ? hits(found.length) : response(collection(found.map(id=>member(id)).join(''),'unknown',found.length));
    };
    const result=await createGmlWfsParcelSource(descriptor,{fetchImpl}).queryIds([prefix+ID,prefix+ID2,prefix+MISSING,prefix+ID]);
    assert.deepEqual(result.features.map(f=>f.id),[prefix+ID,prefix+ID2]);
    assert.deepEqual(result.absentIds,[prefix+MISSING]);
    assert.equal(result.completenessEvidence.length,3); assert.equal(requests.length,8);
    const data=requests.filter(u=>!u.searchParams.has('resultType'));
    assert.equal(new Set(data.map(u=>u.searchParams.get('filter'))).size,2);
    assert.ok(data.every(u=>u.searchParams.get('count')==='1' && !u.searchParams.has('startIndex')));
    assert.ok(requests.every(u=>!u.searchParams.has('RESOURCEID') && u.searchParams.get('filter').includes('<fes:ValueReference>ave:oid</fes:ValueReference>')));
    const batch=await createGmlWfsParcelSource({...descriptor,pageSize:50},{fetchImpl}).queryIds([prefix+ID,prefix+ID2]);
    assert.equal(batch.features.length,2); assert.equal(batch.completenessEvidence.length,1);
    assert.match(requests.at(-1).searchParams.get('filter'), /<fes:Or>/);
});

test('rejects unsafe IDs and descriptor drift before fetching', async () => {
    let calls=0;const fetchImpl=async()=>{calls++;return hits(0);};
    for(const change of [{endpoint:'https://example.org/wfs'},{outFields:['oid','owner']},{responseCrs:'EPSG:4326'},
        {idField:'flstkennz'},{version:'1.1.0'},{pageSize:0},{maxFeatures:5001},{maxResponseBytes:3000000}])
        assert.throws(()=>createGmlWfsParcelSource({...descriptor,...change},{fetchImpl}),/descriptor/);
    const s=createGmlWfsParcelSource(descriptor,{fetchImpl});
    for(const ids of [[prefix+'<xml>'],['DE-SN-'+ID],[prefix+'DEHEbadFL'],[],Array(81).fill(prefix+ID)]) await assert.rejects(s.queryIds(ids),{status:400});
    await assert.rejects(s.queryBounds([8,49,9,50]),{status:400});
    assert.equal(calls,0);
});

for (const [name,options] of [
    ['truncated result',{matched:2,returned:1}], ['lying data match count',{dataMatched:2}],
    ['lying returned count',{returned:2}], ['changed post-count',{after:0}],
    ['missing data count',{xml:collection(member()).replace(' numberReturned="1"','')}],
    ['unknown hit count',{matched:'unknown'}], ['over feature budget',{matched:301}],
    ['duplicate native rows',{matched:2,returned:2,xml:collection(member()+member(),'unknown',2)}],
    ['unrequested identity',{xml:collection(member(ID2))}]
]) test('never marks '+name+' complete',async()=>{
    const {fetchImpl}=transport([ID],options);
    await assert.rejects(createGmlWfsParcelSource(descriptor,{fetchImpl}).queryIds([prefix+ID]));
});

test('empty matches require two known stable hit counts and no data request',async()=>{
    const {requests,fetchImpl}=transport([]);
    const result=await createGmlWfsParcelSource(descriptor,{fetchImpl}).queryIds([prefix+MISSING]);
    assert.equal(result.complete,true);assert.deepEqual(result.absentIds,[prefix+MISSING]);assert.equal(requests.length,2);
    const broken=transport([],{after:1});
    await assert.rejects(createGmlWfsParcelSource(descriptor,{fetchImpl:broken.fetchImpl}).queryIds([prefix+MISSING]),/changed/);
});

test('HTTP, OWS exceptions, malformed content, redirect and timeout errors cannot establish absence',async()=>{
    for(const fetchImpl of [async()=>new Response('denied',{status:403}),async()=>new Response('',{status:302}),
        async()=>response('<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>'),
        async()=>new Response('<html/>',{headers:{'content-type':'text/html'}}),
        async()=>{throw new DOMException('timeout','TimeoutError');}]) {
        await assert.rejects(createGmlWfsParcelSource(descriptor,{fetchImpl}).queryIds([prefix+MISSING]));
    }
});

test('response and aggregate byte budgets, declared truncation, and parser feature limits are enforced',async()=>{
    const hitText=collection('',1,0), data=collection(member());
    const n=Buffer.byteLength(hitText), d=Buffer.byteLength(data);
    for(const changes of [{maxResponseBytes:10},{maxResponseBytes:Math.max(n,d),maxTotalResponseBytes:2*n+d-1}]) {
        const {fetchImpl}=transport();
        await assert.rejects(createGmlWfsParcelSource({...descriptor,...changes},{fetchImpl}).queryIds([prefix+ID]),/byte limit/);
    }
    const fetchImpl=async()=>new Response(hitText,{headers:{'content-type':'application/xml','content-length':String(n+1)}});
    await assert.rejects(createGmlWfsParcelSource(descriptor,{fetchImpl}).queryIds([prefix+ID]),/incomplete/);
    await assert.rejects(parseGmlParcels(collection(member()+member(ID2),'unknown',2),{schema:HESSEN_GML_SCHEMA,maxFeatures:1}),/feature limit/);
});

test('existing Saxony profile still paginates and requires its own identity/CRS',async()=>{
    const existing={...descriptor,id:'dresden-saxony-gml-wfs',endpoint:'https://geodienste.sachsen.de/aaa/public_alkis/vereinf/wfs',
        responseCrs:'EPSG:25833',idField:'flstkennz',parcelNumberField:'flstkennz',outFields:['flstkennz'],idPrefix:'DE-SN-',maxFeatures:20};
    const requests=[];
    const fetchImpl=async url=>{
        const u=new URL(url);requests.push(u);
        if(u.searchParams.get('resultType')==='hits')return hits(2);
        const id=u.searchParams.get('startIndex')==='0'?'140209___00622001002':'140209___00622001003';
        return response(collection(member(id).replaceAll('a:oid','a:flstkennz').replaceAll('EPSG::25832','EPSG::25833'),2,1));
    };
    const result=await createGmlWfsParcelSource(existing,{fetchImpl}).queryIds(['DE-SN-140209___00622001002','DE-SN-140209___00622001003']);
    assert.equal(result.features.length,2);assert.equal(requests.length,4);
    assert.deepEqual(requests.filter(u=>u.searchParams.has('count')).map(u=>u.searchParams.get('startIndex')),['0','1']);
    assert.equal(result.completenessEvidence,undefined);
    assert.notDeepEqual(SAXONY_GML_SCHEMA,HESSEN_GML_SCHEMA);
});
