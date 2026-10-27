// Exercise public viewer decoding, early cancellation, safe projection, and bounded failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ECB, pkcs7Pad } from 'aes-js';
import { createHuaibeiParcelSource, HUAIBEI_ENDPOINT, HUAIBEI_SOURCE_ID } from '../parcels/huaibei-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
const d = { id: HUAIBEI_SOURCE_ID, endpoint: HUAIBEI_ENDPOINT, adapter: 'huaibei-cadastre',
    idPrefix: 'CN-HUAIBEI-', browserTransport: 'relay', outFields: ['ID'], maxFeatures: 1000 };
const geometry = {type:'Polygon',coordinates:[[[116.78,33.97],[116.79,33.97],[116.79,33.98],[116.78,33.97]]]};
function wire(features) {
    const input = new TextEncoder().encode(JSON.stringify({ type:'FeatureCollection',features }));
    const encrypted = new ECB(new TextEncoder().encode('14SB,DHB,2B,94SB')).encrypt(pkcs7Pad(input));
    return new TextEncoder().encode(JSON.stringify({success:true,code:10000,resultData:Buffer.from(encrypted).toString('base64')}));
}
const row = (ID, shape=geometry) => ({type:'Feature',properties:{ID, ZL:'private fixture omitted'},geometry:shape});
function fetcher(bytes, chunk=13) {
    let cancelled = false;
    return { get cancelled() { return cancelled; }, fetch: async () => {
        let offset = 0;
        return new Response(new ReadableStream({pull(controller) {
            if (offset >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(offset, offset += chunk));
        }, cancel() { cancelled=true; }}));
    }};
}
test('exact native IDs stop the stream, preserve geometry, and drop unrelated fields', async () => {
    const transport=fetcher(wire([row(38901),row(38902)]));
    const a=createHuaibeiParcelSource(d,{fetchImpl:transport.fetch});
    const result=await a.queryIds(['CN-HUAIBEI-38901']);
    assert.equal(result.complete,true); assert.equal(result.evidence.streamingStop,true);
    assert.equal(transport.cancelled,true); assert.deepEqual(result.features[0].geometry,geometry);
    assert.equal(result.features[0].properties.sourceParcelId,'38901');
    assert.equal(JSON.stringify(result).includes('private fixture'),false);
});
test('bounds require a complete envelope and unchanged polygons',async()=>{
    const transport=fetcher(wire([row(38901)]));
    let calls=0;
    const a=createHuaibeiParcelSource(d,{fetchImpl:async (...args)=>{calls++;return transport.fetch(...args);}});
    const r=await a.queryBounds([116.781,33.971,116.782,33.972]);
    assert.equal(r.complete,true); assert.equal(r.evidence.fullEnvelopeRead,true);
    assert.equal(r.features.length,1);
    r.features[0].geometry.coordinates[0][0][0]=0;
    const again=await a.queryBounds([116.781,33.971,116.782,33.972]);
    assert.equal(calls,1); assert.deepEqual(again.features[0].geometry,geometry);
    await a.queryIds(['CN-HUAIBEI-38901']); assert.equal(calls,2); // Exact reads stay fresh.
    const truncated=fetcher(wire([row(38901)]).slice(0,-10));
    await assert.rejects(createHuaibeiParcelSource(d,{fetchImpl:truncated.fetch}).queryBounds([116.781,33.971,116.782,33.972]));
});
test('invalid IDs fail before any request and private/detail relay routes are rejected',async()=>{
    let calls=0; const a=createHuaibeiParcelSource(d,{fetchImpl:async()=>{calls++;}});
    await assert.rejects(a.queryIds(['CN-HUAIBEI-038901'])); assert.equal(calls,0);
    const request={url:HUAIBEI_ENDPOINT+'?token=wwg',method:'POST',
        headers:{token:'wwg','content-type':'application/json;charset=UTF-8'},body:'{"type":0,"fields":["ID","geometry"]}'};
    const validated=validateParcelProviderRelayRequest(d.id,request,{sources:[d]});
    assert.equal(validated.target.href,request.url); assert.equal(validated.timeoutMs,45000);
    for (const change of [{url:request.url.replace('/list','/getData')},{body:'{"type":0}'},{headers:{...request.headers,token:'other'}}]) {
        assert.throws(()=>validateParcelProviderRelayRequest(d.id,{...request,...change},{sources:[d]}));
    }
});

test('the actual streamed byte budget is enforced before parsing and cancels the body',async()=>{
    let cancelled=false;
    const a=createHuaibeiParcelSource(d,{fetchImpl:async()=>new Response(new ReadableStream({
        start(controller){controller.enqueue(new Uint8Array(16*1024**2+1));},
        cancel(){cancelled=true;}
    }))});
    await assert.rejects(a.queryIds(['CN-HUAIBEI-38901']), /16 MiB streaming budget/);
    assert.equal(cancelled,true);
});
