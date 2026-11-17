// Shared acceptance signatures stay bound to their terms and merge independently.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import express from 'express';
import request from 'supertest';
import { prepareAcceptance } from '../property-offers/acceptance.js';
import { setupPropertyOfferAcceptances } from '../routes/property-offer-acceptances.js';
const require=createRequire(import.meta.url), Offer=require('../../frontend/js/property-offer-record.js'), Consent=require('../../frontend/js/property-offer-consent.js');
const keys=[61,62,63,64,65].map(n=>Keypair.fromSeed(new Uint8Array(32).fill(n)));
const [buyer,seller,coowner,lens,stranger]=keys.map(k=>k.publicKey.toBase58());
const signature=(key,message)=>sign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),key.secretKey.subarray(0,32)]),format:'der',type:'pkcs8'})).toString('base64');
function setup(direction='sell') {
 const payouts=[{recipient:seller,lamports:'40'},{recipient:coowner,lamports:'60'}].sort((a,b)=>a.recipient.localeCompare(b.recipient));
 const content=Offer.published({schema:'property-offer/v1',city:'test',direction,proposer:direction==='sell'?seller:buyer,buyer:direction==='buy'?buyer:null,seller:direction==='sell'?seller:null,lens,parcels:[{sourceId:'test',id:'one'},{sourceId:'test',id:'two'}],priceLamports:'100',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2030-01-01T00:00:00.000Z',...(direction==='sell'?{payouts}:{})});
 const offer={cid:Offer.cid(content),content}, prepared=prepareAcceptance(offer,{buyer,seller,payouts});
 const rows=new Map(); let time=1800000000000;
 const store={get:async(cid,id)=>rows.get(id),create:async(cid,id,candidate)=>{if(!rows.has(id))rows.set(id,{id,candidate,consents:{}});return rows.get(id);},addConsent:async(cid,id,{owner,signature})=>{const r=rows.get(id);r.consents[owner]=signature;return r;}};
 const app=express();app.use(express.json());setupPropertyOfferAcceptances(app,{load:async cid=>cid===offer.cid?offer:null,store,now:()=>time});
 const base=`/property-offers/${offer.cid}/acceptances`;
 const shareBody={candidate:prepared.candidate,requester:buyer,signature:signature(keys[0],Consent.sessionMessage({cid:offer.cid,id:prepared.id}))};
 const consent=i=>({owner:keys[i].publicKey.toBase58(),signature:signature(keys[i],Consent.sellerConsentMessage({...prepared.candidate,seller:keys[i].publicKey.toBase58()}))});
 return {app,base,shareBody,prepared,consent,rows,expire:()=>time=2000000000000};
}
describe('shared property-offer acceptances',()=>{
 for(const direction of ['buy','sell'])it(`merges independent ${direction} seller signatures and preserves them when sharing again`,async()=>{
  const f=setup(direction);
  expect((await request(f.app).post(f.base).send(f.shareBody)).status).toBe(201);
  const path=`${f.base}/${f.prepared.id}`;
  const results=await Promise.all([1,2].map(i=>request(f.app).post(`${path}/consents`).send(f.consent(i))));
  expect(results.map(r=>r.status)).toEqual([200,200]);
  const read=await request(f.app).get(path);
  expect(read.body.candidate.consents).toHaveLength(2);expect(read.body.waitingFor).toEqual([]);
  expect((await request(f.app).post(f.base).send(f.shareBody)).body.candidate.consents).toHaveLength(2);
 });
 it('rejects unsigned or unrelated sharing and signatures for altered terms',async()=>{
  const f=setup();
  expect((await request(f.app).post(f.base).send({...f.shareBody,signature:''})).status).toBe(422);
  expect((await request(f.app).post(f.base).send({...f.shareBody,requester:stranger})).status).toBe(422);
  await request(f.app).post(f.base).send(f.shareBody);
  const bad={owner:seller,signature:signature(keys[1],Consent.sellerConsentMessage({...f.prepared.candidate,buyer:stranger,seller}))};
  expect((await request(f.app).post(`${f.base}/${f.prepared.id}/consents`).send(bad)).status).toBe(422);
  expect((await request(f.app).get(`${f.base}/${f.prepared.id}`)).body.waitingFor).toHaveLength(2);
 });
 it('does not accept new signatures after expiry and still allows review',async()=>{
  const f=setup();await request(f.app).post(f.base).send(f.shareBody);f.expire();
  expect((await request(f.app).post(`${f.base}/${f.prepared.id}/consents`).send(f.consent(1))).status).toBe(422);
  expect((await request(f.app).get(`${f.base}/${f.prepared.id}`)).status).toBe(200);
 });
});
