import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { CHANGHUA_ENDPOINT, CHANGHUA_SOURCE, CHANGHUA_PREFIX, CHANGHUA_PROJECTION } from '../parcels/changhua-source.js';
import { validateParcelProviderRelayRequest, fetchParcelProviderRelay } from '../parcels/provider-relay.js';

const d = {id:CHANGHUA_SOURCE,adapter:'changhua-urbangis',endpoint:CHANGHUA_ENDPOINT,idPrefix:CHANGHUA_PREFIX,
    sourceCrs:'EPSG:3826',townName:'彰化市',outFields:['SECT','LANDNO8'],parcelNumberField:'LANDNO8'};
const id = CHANGHUA_PREFIX + '0119-LANDNO8-09350000';
const row = {TNAME:'彰化市',SECT:'0119',LANDNO8:'09350000',
    WKT:'MULTIPOLYGON (((200680 2663470,200690 2663470,200690 2663480,200680 2663480,200680 2663470),(200682 2663472,200684 2663472,200684 2663474,200682 2663474,200682 2663472)),((200700 2663470,200710 2663470,200710 2663480,200700 2663480,200700 2663470)))'};
const response = rows => new Response(JSON.stringify({MSGCODE:200,DATA:rows}));
const make = fetchImpl => createParcelSource(d,{fetchImpl});

test('both registered factories preserve key padding, holes and components on fresh exact reads', async () => {
    for (const factory of [make, fetchImpl => browserParcelFactories[d.adapter](d,{fetchImpl:async (url,init) => fetchParcelProviderRelay(
        validateParcelProviderRelayRequest(d.id,{url,method:init.method,body:init.body,headers:init.headers,redirect:init.redirect},{sources:[d]}),
        {providerFetch:(target,options) => fetchImpl(target.href,options)})})]) {
        let reads = 0;
        const adapter = factory(async (url, init) => {
            reads++;
            assert.equal(url,CHANGHUA_ENDPOINT);
            const form = new URLSearchParams(init.body);
            assert.equal(form.get('Sect'),'0119'); assert.equal(form.get('LandNo'),'935');
            return response([{...row,unsolicited:'discard'}]);
        });
        const a = await adapter.queryIds([id]), b = await adapter.queryIds([id]);
        assert.equal(reads,2); assert.equal(a.complete,true); assert.deepEqual(a,b);
        assert.equal(a.features[0].id,id); assert.equal(a.features[0].geometry.coordinates.length,2);
        assert.equal(a.features[0].geometry.coordinates[0].length,2);
        assert.deepEqual(a.features[0].geometry.coordinates[0][0][0],proj4(CHANGHUA_PROJECTION,'EPSG:4326',[200680,2663470]));
        assert.deepEqual(a.features[0].properties.sourceProperties,{SECT:'0119',LANDNO8:'09350000'});
        assert.ok(!JSON.stringify(a).includes('unsolicited'));
    }
});

test('empty exact results stay unresolved; foreign identity, conflicting geometry and open rings fail',async () => {
    const empty = await make(async () => response([])).queryIds([id]);
    assert.equal(empty.complete,false); assert.deepEqual(empty.absentIds,[]); assert.deepEqual(empty.unresolvedIds,[id]);
    await assert.rejects(() => make(async () => response([{...row,SECT:'0120'}])).queryIds([id]));
    await assert.rejects(() => make(async () => response([row,{...row,WKT:row.WKT.replaceAll('200710','200711')}])).queryIds([id]));
    await assert.rejects(() => make(async () => response([{...row,WKT:'POLYGON ((200680 2663470,200690 2663470,200690 2663480,200680 2663471))'}])).queryIds([id]));
});

test('bounded lookup resolves distinct overlapping keys and never invents citywide completeness',async () => {
    const second = CHANGHUA_PREFIX + '0119-LANDNO8-09360000';
    const adapter = make(async (_url,init) => {
        const form = new URLSearchParams(init.body);
        if (form.get('key') === 'getpolygon') return response([row,{...row,LANDNO8:'09360000'}]);
        return response([{...row,LANDNO8:form.get('LandNo') === '935' ? '09350000' : '09360000'}]);
    });
    const p = proj4(CHANGHUA_PROJECTION,'EPSG:4326',[200680,2663470]);
    const read = await adapter.queryBounds([p[0]-.00001,p[1]-.00001,p[0]+.0004,p[1]+.0004]);
    assert.equal(read.complete,true); assert.equal(read.areaComplete,false);
    assert.deepEqual(read.features.map(f=>f.id),[id,second]);
    assert.deepEqual(read.features[0].geometry,read.features[1].geometry);
});

test('relay permits fixed cadastral reads and rejects handler mutation operations before provider access', async () => {
    const input = {url:CHANGHUA_ENDPOINT,method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({key:'getsectdata',timeStamp:'--',timeName:'--',TownName:'彰化市',Sect:'0119',LandNo:'935'}).toString()};
    const request = validateParcelProviderRelayRequest(d.id,input,{sources:[d]});
    let calls = 0;
    await fetchParcelProviderRelay(request,{providerFetch:async () => {calls++; return response([row]);}});
    assert.equal(calls,1);
    for (const body of ['key=LayRec&laydata=x','key=getsectdata&timeStamp=--&timeName=--&TownName=x&Sect=0119&LandNo=935',input.body+'&key=LayRec']) {
        assert.throws(()=>validateParcelProviderRelayRequest(d.id,{...input,body},{sources:[d]}));
    }
});


test('browser batches native exact reads in one relay request and preserves fresh provider reads', async () => {
    let browserCalls=0,providerCalls=0;
    const ids=[id,CHANGHUA_PREFIX+'0119-LANDNO8-09360000'];
    const adapter=browserParcelFactories[d.adapter](d,{fetchImpl:async (url,init) => {
        browserCalls++;
        return fetchParcelProviderRelay(validateParcelProviderRelayRequest(d.id,{url,method:init.method,body:init.body,headers:init.headers,redirect:init.redirect},{sources:[d]}),
            {providerFetch:async (_url,options) => {
                providerCalls++;
                assert.ok(options.headers instanceof Headers);
                const land=new URLSearchParams(options.body).get('LandNo');
                return response([{...row,LANDNO8:land==='935'?'09350000':'09360000',unsolicited:'discard'}]);
            }});
    }});
    const a=await adapter.queryIds(ids),b=await adapter.queryIds(ids);
    assert.equal(browserCalls,2); assert.equal(providerCalls,4);
    assert.deepEqual(a,b); assert.deepEqual(a.features.map(f=>f.id),ids);
    assert.ok(!JSON.stringify(a).includes('unsolicited'));
    const input={url:CHANGHUA_ENDPOINT,method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'}};
    for(const body of ['_parcelIds=[]','_parcelIds=%5B%22foreign%22%5D','_parcelIds=%5B%22foreign%22%5D&key=LayRec']) {
        assert.throws(()=>validateParcelProviderRelayRequest(d.id,{...input,body},{sources:[d]}));
    }
});
