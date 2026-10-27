// Exercise bounded selected-sheet transport, projection, identity and browser relay behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseMojMapXml, MOJ_ZONE_6 } from '../parcels/moj-mapxml-reader.js';
import { createMojMapXmlParcelSource } from '../parcels/moj-mapxml-source.js';
import { sha256Hex } from '../parcels/portable-hash.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest, fetchParcelProviderRelay } from '../parcels/provider-relay.js';
import proj4 from 'proj4';

const xmlName = '25201-1600-401.xml', zipName = '25201-1600-401.zip';
const coordinates = [[-12000,-110000],[-11900,-110000],[-11900,-109900],[-12000,-109900],[-12000,-110000]];
const xml = strToU8(`<地図 xmlns="http://www.moj.go.jp/MINJI/tizuxml" xmlns:g="http://www.moj.go.jp/MINJI/tizuzumen">
<座標系>公共座標6系</座標系><測地系判別>測量</測地系判別><市区町村コード>25201</市区町村コード>
<g:GM_Curve id="C1"><g:GM_OrientablePrimitive.orientation>+</g:GM_OrientablePrimitive.orientation><g:GM_Curve.segment><g:GM_LineString><g:GM_LineString.controlPoint>
${coordinates.map(([e,n])=>`<g:GM_PointArray.column><g:GM_Position.direct><g:X>${n}</g:X><g:Y>${e}</g:Y></g:GM_Position.direct></g:GM_PointArray.column>`).join('')}
</g:GM_LineString.controlPoint></g:GM_LineString></g:GM_Curve.segment></g:GM_Curve>
<g:GM_Surface id="F1"><g:GM_Surface.patch><g:GM_Polygon><g:GM_Polygon.boundary><g:GM_SurfaceBoundary><g:GM_SurfaceBoundary.exterior><g:GM_Ring><g:GM_CompositeCurve.generator idref="C1"/></g:GM_Ring></g:GM_SurfaceBoundary.exterior></g:GM_SurfaceBoundary></g:GM_Polygon.boundary></g:GM_Polygon></g:GM_Surface.patch></g:GM_Surface>
<筆 id="H000000001"><形状 idref="F1"/><測地系判別>変換</測地系判別><unselected>discarded</unselected></筆></地図>`);
const bytes = zipSync({ [xmlName]: xml });
const endpoint = 'https://www.geospatial.jp/ckan/dataset/be71f8da-3320-4deb-95f8-1d0bdb3e73c3/resource/17960975-58e8-4031-a3f8-8327fe74365f/download/25201-1600-2026.zip';
const descriptor = () => ({ id:'jp-moj-test', adapter:'moj-mapxml', endpoint, idPrefix:'JP-MOJ-2026-OTSUSI-',
    outFields:['id'], maxFeatures:1000, archiveAccess:'selected-range-v1', archiveSha256:'a'.repeat(64),
    archiveBytes:100000, archiveEtag:'"pinned"', municipalityCode:'25201', coordinateSystem:'公共座標6系',
    sheetIndex:[{ zip:zipName, xml:xmlName, rangeStart:100, rangeBytes:bytes.length, xmlBytes:xml.length,
        sha256:sha256Hex(bytes), bbox:[135,34,137,36] }], browserTransport:'relay', dataVersion:'2026' });
const canonicalId = 'JP-MOJ-2026-OTSUSI-25201-1600-401-H000000001';
const response = (d, body=bytes) => new Response(body,{status:206,headers:{etag:d.archiveEtag,
    'content-range':`bytes 100-${99+bytes.length}/${d.archiveBytes}`,'content-length':String(body.length)}});

test('zone 6 uses native X=northing and Y=easting; root survey marker is not overwritten', () => {
    const parsed = parseMojMapXml(xml,xmlName,{expectedCoordinateSystem:'公共座標6系',municipalityCode:'25201'});
    assert.equal(parsed.metadata.datumClassification,'測量');
    assert.equal(parsed.metadata.municipalityCode,'25201');
    assert.deepEqual(parsed.features[0].geometry.coordinates[0],coordinates.map(p=>proj4(MOJ_ZONE_6,'EPSG:4326').forward(p)));
    assert.deepEqual(Object.keys(parsed.features[0].properties),['id']);
    assert.throws(()=>parseMojMapXml(xml,xmlName,{municipalityCode:'04102'}));
    assert.throws(()=>parseMojMapXml(xml,xmlName,{expectedCoordinateSystem:'公共座標10系'}));
});

test('zone VII selected-sheet reads preserve native vertices and agree with independent EPSG:6675 coordinates', async () => {
    // Independent pyproj EPSG:6675 -> EPSG:4326 result for E=-47776.680, N=63044.958.
    const expected = [136.63288039023533, 36.567017302688086];
    const name = '17201-2200-436.xml';
    const zone7Xml = strToU8(new TextDecoder().decode(xml)
        .replace('公共座標6系', '公共座標7系').replace('25201', '17201')
        .replaceAll('<g:X>-110000</g:X>', '<g:X>63044.958</g:X>')
        .replaceAll('<g:X>-109900</g:X>', '<g:X>63144.958</g:X>')
        .replaceAll('<g:Y>-12000</g:Y>', '<g:Y>-47776.680</g:Y>')
        .replaceAll('<g:Y>-11900</g:Y>', '<g:Y>-47676.680</g:Y>'));
    const payload = zipSync({ [name]: zone7Xml });
    const d = { ...descriptor(), municipalityCode: '17201', coordinateSystem: '公共座標7系',
        idPrefix: 'JP-MOJ-2026-KANAZAWA-',
        endpoint: endpoint.replace('25201-1600-2026.zip', '17201-2200-2026.zip'),
        sheetIndex: [{ zip: name.replace('.xml', '.zip'), xml: name, rangeStart: 100,
            rangeBytes: payload.length, xmlBytes: zone7Xml.length, sha256: sha256Hex(payload),
            bbox: [136.63, 36.56, 136.65, 36.58] }] };
    const id = d.idPrefix + '17201-2200-436-H000000001';
    const source = createMojMapXmlParcelSource(d, { fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Range, `bytes=100-${99 + payload.length}`);
        return new Response(payload, { status: 206, headers: { etag: d.archiveEtag,
            'content-range': `bytes 100-${99 + payload.length}/${d.archiveBytes}` } });
    } });
    const result = await source.queryIds([id]);
    assert.deepEqual(result.absentIds, []);
    assert.equal(result.features[0].id, id);
    const ring = result.features[0].geometry.coordinates[0];
    assert.equal(ring.length, coordinates.length);
    assert.deepEqual(ring[0], ring.at(-1));
    for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(ring[0][axis] - expected[axis]) < 1e-10);
    assert.equal((await source.queryBounds(d.sheetIndex[0].bbox)).features[0].id, id);
    assert.throws(() => createMojMapXmlParcelSource({ ...d, coordinateSystem: '任意座標系' }));
});

test('selected sheet reads exact composite IDs, immutable geometry and scoped bounds with one range',async()=>{
    const d=descriptor();let requests=0;
    const source=createMojMapXmlParcelSource(d,{fetchImpl:async(url,init)=>{
        requests++;assert.equal(url,endpoint);assert.equal(init.redirect,'manual');
        assert.equal(init.headers.Range,`bytes=100-${99+bytes.length}`);assert.equal(init.headers['If-Match'],d.archiveEtag);
        return response(d);
    }});
    const first=await source.queryIds([canonicalId]);
    assert.equal(first.complete,true);assert.equal(first.features[0].id,canonicalId);
    assert.equal(first.features[0].properties.sourceParcelId,'25201-1600-401-H000000001');
    const geometry=structuredClone(first.features[0].geometry);first.features[0].geometry.coordinates[0][0][0]=0;
    assert.deepEqual((await source.queryIds([canonicalId])).features[0].geometry,geometry);
    const absent=canonicalId.replace('H000000001','H999999999');
    assert.deepEqual((await source.queryIds([absent])).absentIds,[absent]);
    const p=geometry.coordinates[0][0];
    assert.equal((await source.queryBounds([p[0]-.0001,p[1]-.0001,p[0]+.0001,p[1]+.0001])).features.length,1);
    assert.equal(requests,1);
    assert.deepEqual(first.statistics,{downloadedBytes:bytes.length,extractedBytes:xml.length});
    await assert.rejects(source.queryIds(['JP-MOJ-2026-OTSUSI-foreign']));
    const cold=createMojMapXmlParcelSource(d,{fetchImpl:async()=>response(d)});
    assert.deepEqual((await cold.queryIds([canonicalId])).features[0].geometry,geometry);
});

test('rejects ignored ranges, changed bytes/revision, truncation, excess bodies and foreign redirects',async()=>{
    const d=descriptor();
    for(const fetchImpl of [async()=>new Response(bytes),async()=>response({...d,archiveEtag:'"changed"'}),
        async()=>response(d,bytes.slice(1)),async()=>response(d,new Uint8Array(bytes.length+1)),
        async()=>new Response(null,{status:302,headers:{location:'https://example.org/elsewhere'}}),
        async()=>response(d,bytes.map((v,i)=>i===0?v^1:v))]) {
        await assert.rejects(createMojMapXmlParcelSource(d,{fetchImpl}).queryIds([canonicalId]));
    }
    assert.throws(()=>createMojMapXmlParcelSource({...d,sheetIndex:[{...d.sheetIndex[0],rangeBytes:17*1024**2}]}));
});

test('cache expiry independently refetches the pinned sheet and renews the active byte budget',async()=>{
    const d=descriptor();let time=1000,requests=0;
    const source=createMojMapXmlParcelSource(d,{now:()=>time,fetchImpl:async()=>{requests++;return response(d);}});
    const a=await source.queryIds([canonicalId]);
    time+=300001;
    const b=await source.queryIds([canonicalId]);
    assert.equal(requests,2);
    assert.deepEqual(b.features,a.features);
    assert.deepEqual(b.statistics,{downloadedBytes:bytes.length,extractedBytes:xml.length});
});

test('follows only pinned anonymous S3 resource; browser factory and fixed-source relay execute bounded reader',async()=>{
    const d=descriptor();let calls=0;
    const providerFetch=async(url,init)=>{
        calls++;
        assert.equal(new Headers(init.headers).get('range'),`bytes=100-${99+bytes.length}`);
        if(String(url)===endpoint)return new Response(null,{status:302,headers:{location:'https://ckan-storage.s3.amazonaws.com/ckan/resources/17960975-58e8-4031-a3f8-8327fe74365f/25201-1600-2026.zip?public-signature=ephemeral'}});
        assert.equal(new URL(url).hostname,'ckan-storage.s3.amazonaws.com');return response(d);
    };
    const browser=browserParcelFactories['moj-mapxml'](d,{fetchImpl:async(url,init)=>{
        assert.equal(init.method,'POST');assert.equal(url,endpoint);
        const request=validateParcelProviderRelayRequest(d.id,{url,method:init.method,headers:init.headers,body:init.body},{sources:[d]});
        return fetchParcelProviderRelay(request,{providerFetch});
    }});
    const read=await browser.queryIds([canonicalId]);
    assert.equal(read.features[0].id,canonicalId);assert.equal(calls,2);
});
