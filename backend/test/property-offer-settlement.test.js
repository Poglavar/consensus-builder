import { describe, it, expect, vi } from 'vitest';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import request from 'supertest';
import express from 'express';
import { ownershipTransferBasis } from '../property-offers/ownership-transfers.js';
import { createLensMemberApp } from '../lens/server.js';
import { setupPropertyOffersRoute } from '../routes/property-offers.js';
import { client, validateOfferAccount } from '../property-offers/onchain.js';
import { createPropertyOfferTools } from '../agents/mcp-property-offers.js';
const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js'), Cid = require('../../frontend/js/cid.js'), Consent = require('../../frontend/js/property-offer-consent.js');
const keys = [31, 32, 33, 34].map(n => Keypair.fromSeed(new Uint8Array(32).fill(n)));
const [buyer, seller, coowner, lens] = keys.map(k => k.publicKey.toBase58());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = (key, text) => sign(null, Buffer.from(text), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), key.secretKey.subarray(0,32)]), format:'der', type:'pkcs8' })).toString('base64');
function fixture(direction='sell') {
    const content = Offer.published({ schema:'property-offer/v1',title:'Test offer',city:'zg',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2030-01-01T00:00:00.000Z',
        direction,proposer:direction==='sell'?seller:buyer,buyer:direction==='buy'?buyer:null,seller:direction==='sell'?seller:null,lens,
        parcels:[{sourceId:'test-source',id:'parcel-1'},{sourceId:'test-source',id:'parcel-2'}],priceLamports:'100',
        ...(direction==='sell'?{payouts:[{recipient:seller,lamports:'40'},{recipient:coowner,lamports:'60'}]}:{}) });
    const cid=Offer.cid(content), address=client.getOfferPda(cid,content.proposer)[0].toBase58();
    const payouts=content.payouts || [{recipient:seller,lamports:'40'},{recipient:coowner,lamports:'60'}].sort((a,b)=>a.recipient.localeCompare(b.recipient));
    const account={address,cid,maker:content.proposer,lens,side:direction==='sell'?'Sell':'Buy',status:'Open',priceLamports:100n,escrowLamports:0n,deadline:1893456000n,
        termsHash:hash(Cid.canonicalBytes(content)),payoutsHash:direction==='sell'?Buffer.from(client.payoutScheduleHash(payouts)).toString('hex'):'0'.repeat(64),payouts:direction==='sell'?payouts:[],acceptedAt:0n};
    const sets = new Map(content.parcels.map((ref, index) => [Offer.parcelUid(ref), [{ owner: [seller, coowner][index], ownerCount: 1, establishedAt: 100 }]]));
    const { ownershipHash } = ownershipTransferBasis(content.parcels, sets);
    const candidate={cid,offer:address,ownershipHash,termsHash:account.termsHash,payoutsHash:Buffer.from(client.payoutScheduleHash(payouts)).toString('hex'),buyer,seller,payouts,consents:[]};
    candidate.consents=[keys[1],keys[2]].map(key=>({owner:key.publicKey.toBase58(),signature:signature(key,Consent.sellerConsentMessage({...candidate,seller:key.publicKey.toBase58()}))}));
    const requester=direction==='sell'?buyer:seller, signer=direction==='sell'?keys[0]:keys[1];
    const body={...candidate,requester,signature:signature(signer,Consent.requestMessage(candidate))};
    return {row:{cid,content},account,candidate,body,sets};
}
function lensApp(f, transfers = null) {
    const issue = vi.fn(async (fields, { beforeIssue } = {}) => {
        await beforeIssue?.('issued');
        return { address: 'issued', credential: 'credential', payload: fields };
    });
    const member={authority:lens,identity:{ownerSets:async()=>f.sets},attestPropertyOfferDecision:issue};
    return {app:createLensMemberApp({member,pricing:{},propertyOffers:{load:async()=>f.row,account:async()=>f.account,transfers},clock:{nowSeconds:()=>1800000000}}),issue};
}
describe('property offer settlement trust boundaries',()=>{
    for(const direction of ['buy','sell']) it(`issues ${direction} approval only for every owner and signed accepting counterparty`,async()=>{
        const f=fixture(direction),{app,issue}=lensApp(f);
        const result=await request(app).post(`/lens/property-offers/${f.row.cid}/decision`).send(f.body);
        expect(result.status).toBe(201);expect(issue).toHaveBeenCalledOnce();
        expect(issue.mock.calls[0][0]).toMatchObject({buyer,seller,ownershipVerified:1,termsHash:f.account.termsHash});
    });
    it('rejects a tampered request, an omitted co-owner and an unrelated lens without issuing',async()=>{
        for(const change of [b=>({...b,buyer:coowner}),b=>({...b,consents:b.consents.slice(0,1)}),b=>({...b,signature:'bad'}),b=>({...b,ownershipHash:'0'.repeat(64)})]){
            const f=fixture(),{app,issue}=lensApp(f);
            expect((await request(app).post(`/lens/property-offers/${f.row.cid}/decision`).send(change(f.body))).status).toBeGreaterThanOrEqual(400);
            expect(issue).not.toHaveBeenCalled();
        }
    });
    it('reserves the verified ownership proof before issuing and serves only finalized evidence', async () => {
        const f = fixture();
        const reserve = vi.fn(async () => {});
        const evidence = vi.fn(async () => null);
        const { app } = lensApp(f, { reserve, evidence });
        const path = `/lens/property-offers/${f.row.cid}`;
        expect((await request(app).post(`${path}/decision`).send({ ...f.body, ownershipHash: '0'.repeat(64) })).status).toBe(422);
        expect(reserve).not.toHaveBeenCalled();
        expect((await request(app).post(`${path}/decision`).send(f.body)).status).toBe(201);
        expect(reserve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            offer: f.row, decision: 'issued', consents: f.candidate.consents, basis: expect.objectContaining({ ownershipHash: f.candidate.ownershipHash })
        }));
        expect((await request(app).get(`${path}/transfer`)).status).toBe(404);
        evidence.mockResolvedValueOnce({ id: 'evidence', observedAt: 200 });
        expect((await request(app).get(`${path}/transfer`)).body).toEqual({ id: 'evidence', observedAt: 200 });
    });
    it('refuses account identity, amount and schedule mismatches at the index boundary',()=>{
        const f=fixture();expect(validateOfferAccount(f.row,f.account)).toBe(f.account);
        for(const patch of [{address:buyer},{maker:buyer},{priceLamports:1n},{termsHash:'0'.repeat(64)},{payoutsHash:'0'.repeat(64)}]) expect(()=>validateOfferAccount(f.row,{...f.account,...patch})).toThrow();
    });
    it('publishes canonical content without NUL database text and rejects hidden fields',async()=>{
        const f=fixture(), stored=new Map();
        const pool={query:vi.fn(async(sql,args)=>{
            if(sql.startsWith('SELECT')) return {rows:stored.has(args[0])?[stored.get(args[0])]:[]};
            if(sql.startsWith('INSERT')) {expect(args[9].every(key=>!key.includes('\0'))).toBe(true);stored.set(args[0],{cid:args[0],content:JSON.parse(args[12]),created_at:new Date()});return {rows:[]};}
            throw new Error('Unexpected SQL');
        })};
        const app=express();app.use(express.json());setupPropertyOffersRoute(app,{pool,now:()=>1800000000000});
        expect((await request(app).post('/property-offers').send(f.row)).status).toBe(201);
        const bad={...f.row.content,hidden:true};
        expect((await request(app).post('/property-offers').send({cid:Cid.cidOfObject(bad),content:bad})).status).toBe(400);
    });
    it('MCP relays only confirmed shared consent and supplies the configured app origin', async () => {
        const f = fixture(), shared = { id: 'a'.repeat(64), candidate: f.candidate };
        const fetchImpl = vi.fn(async url => ({ ok: true, json: async () => url.endsWith('/acceptances') ? shared : f.row }));
        const tools = createPropertyOfferTools({ apiBase: 'http://localhost:4201', appOrigin: 'http://localhost:5201', fetchImpl });
        const args = { operation: 'share', cid: f.row.cid, candidate: f.candidate, requester: buyer, signature: 'signed-message' };
        await expect(tools.consent(args)).rejects.toThrow('confirm');
        expect(fetchImpl).not.toHaveBeenCalled();
        const result = await tools.consent({ ...args, confirm: true });
        expect(new URL(result.url).searchParams.get('acceptance')).toBe(shared.id);
        expect(fetchImpl.mock.calls[0][1].headers.Origin).toBe('http://localhost:5201');
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ candidate: f.candidate, signature: 'signed-message' });
    });
    it('MCP drafts and edits the same immutable offer and requires reviewed publication',async()=>{
        const f=fixture(), fetchImpl=vi.fn();const tools=createPropertyOfferTools({apiBase:'http://localhost:4201',appOrigin:'http://localhost:5201',fetchImpl});
        expect(tools.draft({offer:f.row.content}).cid).toBe(f.row.cid);
        expect(tools.edit({offer:f.row.content,expectedCid:f.row.cid,changes:{title:'Another offer'}}).cid).not.toBe(f.row.cid);
        await expect(tools.publish({offer:f.row.content,expectedCid:f.row.cid,confirm:false})).rejects.toThrow('confirm');
        for (const direction of ['buy', 'sell']) {
            const sample = fixture(direction);
            const prepared = tools.prepare({ offer: sample.row.content, expectedCid: sample.row.cid,
                buyer, seller, ownershipHash: sample.candidate.ownershipHash, payouts: sample.candidate.payouts, consents: sample.candidate.consents });
            expect(prepared.candidate).toEqual(sample.candidate);
            expect(prepared.requestMessage).toBe(Consent.requestMessage(sample.candidate));
            expect(prepared.sellerMessages).toEqual(sample.candidate.payouts.map(row => ({ owner: row.recipient,
                message: Consent.sellerConsentMessage({ ...sample.candidate, seller: row.recipient }) })));
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
