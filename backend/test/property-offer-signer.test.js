// The node signer adapter for standalone property offers builds the browser bridge's exact instructions,
// refuses wrong signers and unbacked acceptances before anything is signed or sent, replays without
// signing, and indexes every confirmed step. The chain is an in-memory set of real encoded accounts.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Keypair, PublicKey } from '@solana/web3.js';
import { canonicalBytes } from '../cid.js';
import { client } from '../property-offers/onchain.js';
import { verifyWalletSignature } from '../lens/identity/devnet-registry.js';
import { signMessageBytes } from '../agents/lens-ownership-client.js';
import { createPropertyOfferTools } from '../agents/mcp-property-offers.js';
import { acceptOffer, cancelOffer, createOfferOnChain, createOnchainRecorder, expireOffer, fundOffer, releaseOffer } from '../agents/property-offer-signer.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const Consent = require('../../frontend/js/property-offer-consent.js');
const LensCore = require('../../frontend/js/lens-core.js');
const anchors = require('../../frontend/js/solana/parcel-client.js').configure({ web3 });

const kp = n => Keypair.fromSeed(new Uint8Array(32).fill(n));
const [sellerKp, buyerKp, coownerKp, lensKp, strangerKp] = [41, 42, 43, 44, 45].map(kp);
const [seller, buyer, coowner, lens] = [sellerKp, buyerKp, coownerKp, lensKp].map(k => k.publicKey.toBase58());
const credential = kp(46).publicKey.toBase58(), attestationAddress = kp(47).publicKey.toBase58();
const schemaAddress = client.getDecisionSchemaPda(credential)[0].toBase58();
const { PROPERTY_OFFER_PROGRAM_ID: PROGRAM, SAS_PROGRAM_ID: SAS, SYSTEM_PROGRAM_ID: SYSTEM, DEFAULT_PUBKEY: NONE } = client.constants;
const PARCEL_PROGRAM = anchors.constants.PARCEL_NFT_PROGRAM_ID;
const NOW = 1800000000, DEADLINE = 1893456000, LENS_URL = 'https://lens.example', OWNERSHIP = 'ab'.repeat(32);
const APARTMENT = { xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::A4-C-23', at: '45.7665,15.9722,19' };
const tools = createPropertyOfferTools({ apiBase: 'http://localhost:4201', appOrigin: 'http://localhost:5201', fetchImpl: async () => { throw new Error('no index'); } });

const u8 = n => Buffer.from([n]);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const pk = key => new PublicKey(key).toBuffer();
const str = text => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text)]);
const hex = bytes => Buffer.from(bytes).toString('hex');
const sign = (keypair, message) => LensCore.base58Encode(new Uint8Array(signMessageBytes({ secretKey: keypair.secretKey, message })));
const keysOf = ix => ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
const disc = name => Buffer.from(client.IX_DISCRIMINATORS[name]);

function offerRow({ direction = 'sell', apartment = false } = {}) {
    const proposer = direction === 'sell' ? seller : buyer;
    const payouts = apartment ? [{ recipient: seller, lamports: '100' }] : [{ recipient: seller, lamports: '40' }, { recipient: coowner, lamports: '60' }];
    const content = Offer.published({ schema: 'property-offer/v1', title: 'Test offer', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
        direction, proposer, buyer: direction === 'buy' ? proposer : null, seller: direction === 'sell' ? proposer : null, lens, priceLamports: '100',
        ...(apartment ? { city: 'zagreb', apartment: APARTMENT } : { city: 'zg', parcels: [{ sourceId: 'test-source', id: 'parcel-1' }, { sourceId: 'test-source', id: 'parcel-2' }] }),
        ...(direction === 'sell' ? { payouts } : {}) });
    return { row: { cid: Offer.cid(content), content, onchain: null }, sellerPayouts: Offer.published({ ...content, direction: 'sell', buyer: null, seller: content.proposer, payouts }).payouts };
}

// PropertyOffer account bytes in the program's Borsh layout (property-offer-client.js readPropertyOffer).
function offerData(s) {
    return Buffer.concat([Buffer.from(client.ACCOUNT_DISCRIMINATORS.PropertyOffer), pk(s.maker), pk(s.lens), pk(s.buyer), pk(s.seller), u8(s.side), u8(s.status),
        u64(s.price), u64(s.escrow), i64(s.deadline), i64(s.created), i64(s.accepted), i64(s.attested), Buffer.from(s.termsHash, 'hex'), Buffer.from(s.payoutsHash, 'hex'),
        u32(s.payouts.length), ...s.payouts.flatMap(p => [pk(p.recipient), u64(p.lamports)]), u8(0), u16(0), pk(s.attestation), Buffer.alloc(32), u8(s.bump), str(s.cid)]);
}

function fakeChain(row) {
    const accounts = new Map(), c = row.content;
    const put = (address, owner, data, executable = false) => accounts.set(address, { owner: new PublicKey(owner), data, executable, lamports: 1 });
    const [address, bump] = client.getOfferPda(row.cid, c.proposer);
    const identityHash = c.apartment ? Offer.apartmentHash(c.apartment) : null;
    put(PROGRAM, 'BPFLoaderUpgradeab1e11111111111111111111111', Buffer.alloc(0), true);
    put(credential, SAS, Buffer.concat([u8(0), pk(lens)]));
    put(schemaAddress, SAS, Buffer.concat([u8(1), pk(credential), str('PropertyOfferDecision'), str(''), str('fields'), Buffer.concat([u32(3), Buffer.from([1, 2, 3])]), Buffer.from([0, 1])]));
    const chain = {
        address: address.toBase58(), state: null,
        open: () => ({ maker: c.proposer, lens, buyer: c.direction === 'buy' ? c.proposer : NONE, seller: c.direction === 'sell' ? c.proposer : NONE, side: c.direction === 'buy' ? 0 : 1,
            status: 0, price: 100n, escrow: 0n, deadline: BigInt(DEADLINE), created: BigInt(NOW), accepted: 0n, attested: 0n,
            termsHash: createHash('sha256').update(canonicalBytes(c)).digest('hex'), payoutsHash: c.direction === 'sell' ? hex(client.payoutScheduleHash(c.payouts)) : '00'.repeat(32),
            payouts: c.payouts || [], attestation: NONE, bump, cid: row.cid }),
        set(patch) { chain.state = { ...(chain.state || chain.open()), ...patch }; put(chain.address, PROGRAM, offerData(chain.state)); },
        anchorAddress: identityHash ? anchors.getApartmentPda(identityHash)[0].toBase58() : null,
        putAnchor() { put(chain.anchorAddress, PARCEL_PROGRAM, Buffer.concat([Buffer.from([228, 251, 95, 117, 86, 31, 42, 43]), Buffer.from(identityHash, 'hex'), u8(anchors.getApartmentPda(identityHash)[1])])); },
        attest(fields, { qualified = 1, signer = lens } = {}) {
            const payload = Buffer.concat([str(fields.cid), str(fields.offer), str(fields.termsHash), str(fields.payoutsHash), str(fields.buyer), str(fields.seller), u8(qualified), i64(NOW - 10)]);
            put(attestationAddress, SAS, Buffer.concat([u8(2), Buffer.alloc(32, 9), pk(credential), pk(schemaAddress), u32(payload.length), payload, pk(signer), i64(1900000000)]));
        },
        connection: { getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', getAccountInfo: vi.fn(async key => accounts.get(new PublicKey(key).toBase58()) ?? null) }
    };
    return chain;
}

// sendAndConfirm stub: records each transaction and applies its effect to the fake chain.
const sender = effect => vi.fn(async (connection, transaction) => { effect?.(transaction); return `sig${transaction.instructions.length}`; });
const recorder = () => vi.fn(async (ref, cid) => ({ cid, onchain: { status: ref.status, account: ref.account } }));
function lensFetch(chain, row, { tamper = fields => fields } = {}) {
    return vi.fn(async (url, init) => {
        if (url === `${LENS_URL}/lens/property-offers/check`) return { ok: true, status: 200, json: async () => ({ key: lens, credential, schema: schemaAddress }) };
        if (url === `${LENS_URL}/lens/property-offers/${row.cid}/decision`) {
            chain.attest(tamper(JSON.parse(init.body)));
            return { ok: true, status: 201, json: async () => ({ address: attestationAddress, credential }) };
        }
        throw new Error(`unexpected ${url}`);
    });
}
function sellCandidate(row, consentKeys = [sellerKp, coownerKp]) {
    const prepared = tools.prepare({ offer: row.content, expectedCid: row.cid, ownershipHash: OWNERSHIP, buyer, seller });
    const consents = consentKeys.map(key => ({ owner: key.publicKey.toBase58(), signature: sign(key, prepared.sellerMessages.find(m => m.owner === key.publicKey.toBase58()).message) }));
    return { ...prepared.candidate, consents };
}

describe('property offer signer: create', () => {
    it('the proposer creates a sell offer after the lens preflight, with the exact create instruction, and indexes it', async () => {
        const { row } = offerRow(), chain = fakeChain(row), fetchImpl = lensFetch(chain, row), recordOnchain = recorder();
        const sendAndConfirm = sender(() => chain.set({}));
        const result = await createOfferOnChain({ connection: chain.connection, keypair: sellerKp, row, recordOnchain, lensServiceUrl: LENS_URL, fetchImpl, nowSeconds: NOW, sendAndConfirm });
        expect(result).toEqual({ signature: 'sig1', replayed: false, account: chain.address, status: 'open', onchain: { status: 'open', account: chain.address } });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ content: row.content });
        expect(fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(sendAndConfirm.mock.invocationCallOrder[0]);
        const [, transaction, signers] = sendAndConfirm.mock.calls[0];
        expect(transaction.feePayer.toBase58()).toBe(seller);
        expect(signers).toEqual([sellerKp]);
        const [ix] = transaction.instructions;
        expect(transaction.instructions).toHaveLength(1);
        expect(ix.programId.toBase58()).toBe(PROGRAM);
        expect(ix.data.subarray(0, 8)).toEqual(disc('create'));
        expect(Buffer.from(ix.data)).toEqual(Buffer.from(client.encodeCreateData({ cid: row.cid, lens, side: 'sell', termsHash: chain.open().termsHash,
            priceLamports: '100', deadline: DEADLINE, payouts: row.content.payouts })));
        expect(keysOf(ix)).toEqual([[chain.address, false, true], [seller, true, true], [SYSTEM, false, false]]);
        expect(recordOnchain).toHaveBeenCalledExactlyOnceWith({ chain: 'solana', cluster: 'devnet', account: chain.address, signature: 'sig1', status: 'open' }, row.cid);
    });

    it('refuses another signer before the lens or any send; an existing account is a replay; foreign terms are refused', async () => {
        const { row } = offerRow(), chain = fakeChain(row), fetchImpl = lensFetch(chain, row), recordOnchain = recorder(), sendAndConfirm = sender();
        const args = { connection: chain.connection, row, recordOnchain, lensServiceUrl: LENS_URL, fetchImpl, nowSeconds: NOW, sendAndConfirm };
        await expect(createOfferOnChain({ ...args, keypair: strangerKp })).rejects.toThrow('Only the proposer');
        chain.set({});
        const replay = await createOfferOnChain({ ...args, keypair: sellerKp });
        expect(replay).toMatchObject({ signature: null, replayed: true, status: 'open' });
        expect(recordOnchain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ signature: null, status: 'open' }), row.cid);
        chain.set({ price: 99n });
        await expect(createOfferOnChain({ ...args, keypair: sellerKp })).rejects.toThrow('does not match the published offer');
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('an apartment offer mints its anchor with the offer, and only the anchor when the offer exists without it', async () => {
        const { row } = offerRow({ apartment: true }), chain = fakeChain(row), recordOnchain = recorder();
        const sendAndConfirm = sender(() => { chain.set({}); chain.putAnchor(); });
        const args = { connection: chain.connection, keypair: sellerKp, row, recordOnchain, lensServiceUrl: LENS_URL, fetchImpl: lensFetch(chain, row), nowSeconds: NOW, sendAndConfirm };
        const result = await createOfferOnChain(args);
        const [mintAnchor, create] = sendAndConfirm.mock.calls[0][1].instructions;
        expect(mintAnchor.programId.toBase58()).toBe(PARCEL_PROGRAM);
        expect(Buffer.from(mintAnchor.data)).toEqual(Buffer.concat([Buffer.from(anchors.IX_DISCRIMINATORS.mint_apartment), Buffer.from(Offer.apartmentHash(APARTMENT), 'hex')]));
        expect(keysOf(mintAnchor)).toEqual([[chain.anchorAddress, false, true], [seller, true, true], [SYSTEM, false, false]]);
        expect(create.data.subarray(0, 8)).toEqual(disc('create'));
        expect(result.status).toBe('open');
        expect(recordOnchain.mock.calls[0][0].apartmentAnchor).toBe(chain.anchorAddress);

        const other = offerRow({ apartment: true }), half = fakeChain(other.row), onlyAnchor = sender(() => half.putAnchor());
        half.set({});
        await createOfferOnChain({ ...args, connection: half.connection, row: other.row, sendAndConfirm: onlyAnchor });
        expect(onlyAnchor.mock.calls[0][1].instructions.map(ix => ix.programId.toBase58())).toEqual([PARCEL_PROGRAM]);
    });
});

describe('property offer signer: accept', () => {
    it('the buyer accepts a parcel sell offer with every seller consent: exact signed lens request, checked decision, accept instruction', async () => {
        const { row } = offerRow(), chain = fakeChain(row), fetchImpl = lensFetch(chain, row), recordOnchain = recorder();
        chain.set({});
        const candidate = sellCandidate(row);
        const sendAndConfirm = sender(() => chain.set({ status: 1, buyer, accepted: BigInt(NOW), attestation: attestationAddress }));
        const result = await acceptOffer({ connection: chain.connection, keypair: buyerKp, row, candidate, lensServiceUrl: LENS_URL, fetchImpl, recordOnchain, nowSeconds: NOW, sendAndConfirm });
        expect(result).toMatchObject({ signature: 'sig1', replayed: false, status: 'accepted' });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(`${LENS_URL}/lens/property-offers/${row.cid}/decision`);
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        const { signature, requester, ...request } = body;
        expect(request).toEqual(candidate);
        expect(requester).toBe(buyer);
        expect(verifyWalletSignature({ owner: buyer, message: Consent.requestMessage(request), signature })).toBe(true);
        expect(verifyWalletSignature({ owner: seller, message: Consent.requestMessage(request), signature })).toBe(false);
        const [ix] = sendAndConfirm.mock.calls[0][1].instructions;
        expect(ix.programId.toBase58()).toBe(PROGRAM);
        expect(Buffer.from(ix.data)).toEqual(Buffer.concat([disc('accept'), u32(0)]));
        expect(keysOf(ix)).toEqual([[chain.address, false, true], [buyer, true, false], [attestationAddress, false, false], [credential, false, false]]);
        expect(recordOnchain).toHaveBeenCalledExactlyOnceWith({ chain: 'solana', cluster: 'devnet', account: chain.address, signature: 'sig1', status: 'accepted' }, row.cid);
    });

    it('refuses before signing: a wrong signer, a missing or forged seller consent, a decision attesting other terms', async () => {
        const { row } = offerRow(), chain = fakeChain(row), recordOnchain = recorder(), sendAndConfirm = sender();
        chain.set({});
        const base = { connection: chain.connection, row, lensServiceUrl: LENS_URL, recordOnchain, nowSeconds: NOW, sendAndConfirm };
        const fetchImpl = lensFetch(chain, row);
        for (const keypair of [sellerKp, strangerKp]) await expect(acceptOffer({ ...base, keypair, candidate: sellCandidate(row), fetchImpl })).rejects.toThrow('accepting counterparty');
        await expect(acceptOffer({ ...base, keypair: buyerKp, candidate: sellCandidate(row, [sellerKp]), fetchImpl })).rejects.toThrow('Every seller must sign');
        const forged = sellCandidate(row);
        forged.consents[1] = { ...forged.consents[1], signature: forged.consents[0].signature };
        await expect(acceptOffer({ ...base, keypair: buyerKp, candidate: forged, fetchImpl })).rejects.toThrow('Invalid seller consent');
        expect(fetchImpl).not.toHaveBeenCalled();
        const otherTerms = lensFetch(chain, row, { tamper: fields => ({ ...fields, buyer: coowner }) });
        await expect(acceptOffer({ ...base, keypair: buyerKp, candidate: sellCandidate(row), fetchImpl: otherTerms })).rejects.toThrow('attests other terms (buyer)');
        expect(otherTerms).toHaveBeenCalledOnce();
        expect(sendAndConfirm).not.toHaveBeenCalled();
        expect(recordOnchain).not.toHaveBeenCalled();
    });

    it('the seller accepts an apartment buy offer on the lens qualification with its payout schedule; an accepted offer is a replay', async () => {
        const { row, sellerPayouts } = offerRow({ direction: 'buy', apartment: true }), chain = fakeChain(row), fetchImpl = lensFetch(chain, row), recordOnchain = recorder();
        chain.set({}); chain.putAnchor();
        const { candidate } = tools.prepare({ offer: row.content, expectedCid: row.cid, buyer, seller, payouts: sellerPayouts });
        const sendAndConfirm = sender(() => chain.set({ status: 1, seller, payouts: sellerPayouts, payoutsHash: hex(client.payoutScheduleHash(sellerPayouts)), attestation: attestationAddress }));
        const args = { connection: chain.connection, keypair: sellerKp, row, candidate, lensServiceUrl: LENS_URL, fetchImpl, recordOnchain, nowSeconds: NOW, sendAndConfirm };
        await expect(acceptOffer({ ...args, keypair: buyerKp })).rejects.toThrow('accepting counterparty');
        await acceptOffer(args);
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body).toMatchObject({ requester: seller, consents: [], payouts: sellerPayouts });
        expect(body).not.toHaveProperty('ownershipHash');
        expect(verifyWalletSignature({ owner: seller, message: Consent.requestMessage(body), signature: body.signature })).toBe(true);
        const [ix] = sendAndConfirm.mock.calls[0][1].instructions;
        expect(Buffer.from(ix.data)).toEqual(Buffer.from(client.encodeAcceptData({ payouts: sellerPayouts })));
        expect(keysOf(ix)[1]).toEqual([seller, true, false]);
        expect(recordOnchain.mock.calls[0][0]).toMatchObject({ status: 'accepted', apartmentAnchor: chain.anchorAddress });
        const replay = await acceptOffer(args);
        expect(replay).toMatchObject({ signature: null, replayed: true, status: 'accepted' });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });
});

describe('property offer signer: fund, release, cancel, expire', () => {
    const accepted = { status: 1, buyer, accepted: BigInt(NOW), attestation: attestationAddress };
    function setup(state) {
        const { row } = offerRow(), chain = fakeChain(row), recordOnchain = recorder();
        if (state) chain.set(state);
        return { row, chain, recordOnchain, args: { connection: chain.connection, row, recordOnchain, nowSeconds: NOW } };
    }

    it('fund: only the bound buyer deposits, once', async () => {
        const { chain, recordOnchain, args } = setup(accepted), sendAndConfirm = sender(() => chain.set({ escrow: 100n }));
        await expect(fundOffer({ ...args, keypair: strangerKp, sendAndConfirm })).rejects.toThrow('Only the buyer');
        const result = await fundOffer({ ...args, keypair: buyerKp, sendAndConfirm });
        const [ix] = sendAndConfirm.mock.calls[0][1].instructions;
        expect(Buffer.from(ix.data)).toEqual(disc('fund'));
        expect(keysOf(ix)).toEqual([[chain.address, false, true], [buyer, true, true], [SYSTEM, false, false]]);
        expect(result).toMatchObject({ signature: 'sig1', status: 'accepted' });
        expect(await fundOffer({ ...args, keypair: buyerKp, sendAndConfirm })).toMatchObject({ signature: null, replayed: true });
        expect(sendAndConfirm).toHaveBeenCalledOnce();
        expect(recordOnchain).toHaveBeenCalledTimes(2);
    });

    it('release: anyone pays the funded schedule in schedule order; unfunded is refused; settled is a replay', async () => {
        const { row, chain, args } = setup(accepted), sendAndConfirm = sender(() => chain.set({ status: 2, escrow: 0n }));
        await expect(releaseOffer({ ...args, keypair: strangerKp, sendAndConfirm })).rejects.toThrow('must fund it first');
        chain.set({ escrow: 100n });
        await releaseOffer({ ...args, keypair: strangerKp, sendAndConfirm });
        const [ix] = sendAndConfirm.mock.calls[0][1].instructions;
        expect(Buffer.from(ix.data)).toEqual(disc('execute'));
        expect(keysOf(ix)).toEqual([[chain.address, false, true], ...row.content.payouts.map(p => [p.recipient, false, true])]);
        expect(await releaseOffer({ ...args, keypair: strangerKp, sendAndConfirm })).toMatchObject({ signature: null, replayed: true, status: 'settled' });
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });

    it('cancel: only the proposer withdraws an open offer; a cancelled one is a replay', async () => {
        const { chain, args } = setup({}), sendAndConfirm = sender(() => chain.set({ status: 3 }));
        await expect(cancelOffer({ ...args, keypair: buyerKp, sendAndConfirm })).rejects.toThrow('Only the proposer');
        await cancelOffer({ ...args, keypair: sellerKp, sendAndConfirm });
        const [ix] = sendAndConfirm.mock.calls[0][1].instructions;
        expect(Buffer.from(ix.data)).toEqual(disc('cancel'));
        expect(keysOf(ix)).toEqual([[chain.address, false, true], [seller, true, true]]);
        expect(await cancelOffer({ ...args, keypair: sellerKp, sendAndConfirm })).toMatchObject({ signature: null, status: 'cancelled' });
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });

    it('expire: refused before the deadline; after it refunds to the maker of an open sell; expired is a replay', async () => {
        const { chain, args } = setup({}), sendAndConfirm = sender(() => chain.set({ status: 4 }));
        await expect(expireOffer({ ...args, keypair: strangerKp, sendAndConfirm })).rejects.toThrow('has not passed');
        await expireOffer({ ...args, keypair: strangerKp, nowSeconds: DEADLINE + 1, sendAndConfirm });
        const [ix] = sendAndConfirm.mock.calls[0][1].instructions;
        expect(Buffer.from(ix.data)).toEqual(disc('expire'));
        expect(keysOf(ix)).toEqual([[chain.address, false, true], [seller, false, true]]);
        expect(await expireOffer({ ...args, keypair: strangerKp, nowSeconds: DEADLINE + 1, sendAndConfirm })).toMatchObject({ signature: null, status: 'expired' });
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });

    it('a step the index cannot record keeps its signature; a missing chain account is refused', async () => {
        const { chain, args } = setup(accepted), sendAndConfirm = sender(() => chain.set({ escrow: 100n }));
        const recordOnchain = vi.fn(async () => { throw new Error('index down'); });
        const error = await fundOffer({ ...args, recordOnchain, keypair: buyerKp, sendAndConfirm }).catch(e => e);
        expect(error).toMatchObject({ signature: 'sig1', message: expect.stringContaining('Repeat the same step') });
        const empty = setup(null);
        await expect(fundOffer({ ...empty.args, keypair: buyerKp, sendAndConfirm })).rejects.toThrow('Create this offer on Solana first');
    });
});

describe('property offer signer: index recorder', () => {
    it('posts the reference to the offer’s onchain path with the app origin', async () => {
        const fetchImpl = vi.fn(async url => ({ ok: true, status: 200, json: async () => ({ cid: url.split('/')[4], onchain: { status: 'open' } }) }));
        const record = createOnchainRecorder({ apiBase: 'http://localhost:4201/', appOrigin: 'http://localhost:5201/property-offers', fetchImpl });
        const { row } = offerRow(), ref = { chain: 'solana', cluster: 'devnet', account: 'x', signature: 'sig', status: 'open' };
        expect(await record(ref, row.cid)).toEqual({ cid: row.cid, onchain: { status: 'open' } });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(`http://localhost:4201/property-offers/${row.cid}/onchain`);
        expect(init).toMatchObject({ method: 'POST', headers: { Origin: 'http://localhost:5201', 'Content-Type': 'application/json' } });
        expect(JSON.parse(init.body)).toEqual(ref);
    });
});
