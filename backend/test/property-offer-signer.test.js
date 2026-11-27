// The node signer adapter for property offers v2 builds the browser codec's exact instructions, refuses
// wrong signers and steps the program would refuse before anything is signed, replays without signing,
// and indexes every confirmed step. The chain is an in-memory set of accounts Anchor's coder encodes.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { canonicalBytes } from '../cid.js';
import { client } from '../property-offers/onchain.js';
import { cancelOffer, commitOffer, confirmOffer, createOfferOnChain, createOnchainRecorder, executeOffer, expireOffer, stateHolding } from '../agents/property-offer-signer.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const Statements = require('../../frontend/js/solana/property-statements.js').configure({ web3 });
const anchor = createRequire(new URL('../../blockchain/solana/package.json', import.meta.url))('@coral-xyz/anchor');
const coder = new anchor.BorshCoder(JSON.parse(readFileSync(new URL('../../blockchain/solana/idl/property_offer.json', import.meta.url), 'utf8')));

const kp = n => Keypair.fromSeed(new Uint8Array(32).fill(n));
const [sellerKp, buyerKp, memberKp, strangerKp] = [41, 42, 43, 44].map(kp);
const [seller, buyer, member] = [sellerKp, buyerKp, memberKp].map(k => k.publicKey.toBase58());
const { PROPERTY_OFFER_PROGRAM_ID: PROGRAM, SAS_PROGRAM_ID: SAS } = client.constants;
const NOW = 1800000000;
const FLAT = { kind: 'flat', xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::4', at: '45.7665,15.9722,19' };
const HOLDING = kp(45).publicKey.toBase58();
const disc = name => Buffer.from(client.IX_DISCRIMINATORS[name]);
const lensOf = (members, threshold, confirmed = 0) => ({ members: [...members.map(m => new PublicKey(m)), ...Array(8 - members.length).fill(PublicKey.default)], count: members.length, threshold, confirmed });

function offerRow({ direction = 'sell', currency = 'SOL' } = {}) {
    const content = Offer.published({ schema: 'property-offer/v2', title: 'Flat 6/4', city: 'zagreb', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
        direction, proposer: direction === 'sell' ? seller : buyer, currency, price: '900', lens: direction === 'buy' ? { members: [member], threshold: 1 } : { members: [], threshold: 0 },
        asset: FLAT, ...(direction === 'sell' ? { payouts: [{ recipient: seller, amount: '900' }] } : {}) });
    return { cid: Offer.cid(content), content, onchain: null };
}

function fakeChain(row) {
    const accounts = new Map(), c = row.content;
    const put = (address, owner, data, executable = false) => accounts.set(new PublicKey(address).toBase58(), { owner: new PublicKey(owner), data, executable, lamports: 1 });
    const [address, bump] = client.getOfferPda(row.cid, c.proposer);
    put(PROGRAM, 'BPFLoaderUpgradeab1e11111111111111111111111', Buffer.alloc(0), true);
    const chain = {
        address: address.toBase58(), state: null,
        open: () => ({ maker: new PublicKey(c.proposer), buyer: c.direction === 'buy' ? new PublicKey(buyer) : PublicKey.default, seller: c.direction === 'sell' ? new PublicKey(seller) : PublicKey.default,
            mint: c.currency === 'USDC' ? new PublicKey(client.constants.USDC_MINT) : PublicKey.default, side: c.direction === 'buy' ? { Buy: {} } : { Sell: {} }, status: { Open: {} },
            price: new anchor.BN(900), escrow: new anchor.BN(c.direction === 'buy' ? 900 : 0), deadline: new anchor.BN(Math.floor(Date.parse(c.expiresAt) / 1000)),
            created_at: new anchor.BN(NOW), committed_at: new anchor.BN(0), settled_at: new anchor.BN(0),
            terms_hash: [...createHash('sha256').update(canonicalBytes(c)).digest()], payouts_hash: Array(32).fill(c.direction === 'sell' ? 7 : 0),
            buyer_lens: c.direction === 'buy' ? lensOf(c.lens.members, c.lens.threshold) : lensOf([], 0), seller_lens: c.direction === 'sell' ? lensOf(c.lens.members, c.lens.threshold) : lensOf([], 0),
            payouts: (c.payouts || []).map(p => ({ recipient: new PublicKey(p.recipient), amount: new anchor.BN(p.amount) })), bump, cid: row.cid }),
        async set(patch) { chain.state = { ...(chain.state || chain.open()), ...patch }; put(chain.address, PROGRAM, await coder.accounts.encode('PropertyOffer', chain.state)); },
        put,
        connection: { getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', getSlot: async () => 1, getBlockTime: async () => NOW,
            getAccountInfo: vi.fn(async key => accounts.get(new PublicKey(key).toBase58()) ?? null) }
    };
    return chain;
}
// A committed sell offer: the buyer's lens is `member`.
async function committedSell(row, chain, patch = {}) {
    await chain.set({ buyer: new PublicKey(buyer), status: { Committed: {} }, escrow: new anchor.BN(900), buyer_lens: lensOf([member], 1), ...patch });
}
const sender = effect => vi.fn(async (connection, transaction) => { await effect?.(transaction); return `sig${transaction.instructions.length}`; });
const recorder = () => vi.fn(async (ref, cid) => ({ cid, onchain: { account: ref.account } }));
const base = (chain, row, keypair) => ({ connection: chain.connection, keypair, row, recordOnchain: recorder() });

describe('create', () => {
    it('the maker creates a sell offer with the codec’s exact instruction and indexes it; an existing account is a replay', async () => {
        const row = offerRow(), chain = fakeChain(row), options = base(chain, row, sellerKp);
        const sendAndConfirm = sender(() => chain.set({}));
        const result = await createOfferOnChain({ ...options, nowSeconds: NOW, sendAndConfirm });
        expect(result).toMatchObject({ signature: 'sig1', replayed: false, account: chain.address, status: 'open' });
        const [ix] = sendAndConfirm.mock.calls[0][1].instructions;
        expect(Buffer.from(ix.data)).toEqual(Buffer.from(client.encodeCreateData({ cid: row.cid, side: 'sell', termsHash: createHash('sha256').update(canonicalBytes(row.content)).digest('hex'),
            price: '900', deadline: Math.floor(Date.parse(row.content.expiresAt) / 1000), payouts: row.content.payouts, lens: [], lensThreshold: 0 })));
        expect(options.recordOnchain).toHaveBeenCalledExactlyOnceWith({ chain: 'solana', cluster: 'devnet', account: chain.address, signature: 'sig1' }, row.cid);
        const again = sender();
        expect((await createOfferOnChain({ ...options, nowSeconds: NOW, sendAndConfirm: again })).replayed).toBe(true);
        expect(again).not.toHaveBeenCalled();
    });
    it('refuses another signer and an account carrying other terms', async () => {
        const row = offerRow(), chain = fakeChain(row);
        await expect(createOfferOnChain({ ...base(chain, row, buyerKp), nowSeconds: NOW, sendAndConfirm: sender() })).rejects.toThrow(/Only the proposer/);
        await chain.set({ price: new anchor.BN(901) });
        await expect(createOfferOnChain({ ...base(chain, row, sellerKp), nowSeconds: NOW, sendAndConfirm: sender() })).rejects.toThrow(/does not match/);
    });
});

describe('commit', () => {
    it('a buyer takes a USDC sale naming its lens, paying into the vault; the maker and a lensless buyer are refused', async () => {
        const row = offerRow({ currency: 'USDC' }), chain = fakeChain(row);
        await chain.set({});
        const sendAndConfirm = sender(() => committedSell(row, chain));
        const result = await commitOffer({ ...base(chain, row, buyerKp), lens: { members: [member], threshold: 1 }, nowSeconds: NOW, sendAndConfirm });
        expect(result.status).toBe('committed');
        const instructions = sendAndConfirm.mock.calls[0][1].instructions;
        expect(instructions.map(ix => Buffer.from(ix.data))).toEqual(client.buildCommitIxs({ offer: chain.address, counterparty: buyer, currency: 'USDC', side: 'sell', lens: [member], lensThreshold: 1 }).map(ix => Buffer.from(ix.data)));
        expect(Buffer.from(instructions.at(-1).data).subarray(0, 8)).toEqual(disc('commit'));
        expect((await commitOffer({ ...base(chain, row, buyerKp), lens: { members: [member], threshold: 1 }, nowSeconds: NOW, sendAndConfirm: sender() })).replayed).toBe(true);
        const fresh = fakeChain(row); await fresh.set({});
        await expect(commitOffer({ ...base(fresh, row, sellerKp), lens: { members: [member], threshold: 1 }, nowSeconds: NOW, sendAndConfirm: sender() })).rejects.toThrow(/own offer/);
        await expect(commitOffer({ ...base(fresh, row, buyerKp), nowSeconds: NOW, sendAndConfirm: sender() })).rejects.toThrow(/names its lens/);
    });
    it('a seller takes a buy offer with the default payout schedule to itself', async () => {
        const row = offerRow({ direction: 'buy' }), chain = fakeChain(row);
        await chain.set({});
        const sendAndConfirm = sender(() => chain.set({ seller: new PublicKey(seller), status: { Committed: {} } }));
        await commitOffer({ ...base(chain, row, sellerKp), nowSeconds: NOW, sendAndConfirm });
        expect(Buffer.from(sendAndConfirm.mock.calls[0][1].instructions[0].data)).toEqual(Buffer.from(client.encodeCommitData({ side: 'buy', payouts: [{ recipient: seller, amount: '900' }], lens: [], lensThreshold: 0 })));
    });
});

describe('confirm', () => {
    it('a buyer-lens member confirms the seller holds the asset: setup, attestation at the holding’s fixed address, confirm and execute in one transaction', async () => {
        const row = offerRow(), chain = fakeChain(row);
        await committedSell(row, chain);
        const sendAndConfirm = sender(() => chain.set({ status: { Settled: {} } }));
        await confirmOffer({ ...base(chain, row, memberKp), holding: HOLDING, nowSeconds: NOW, sendAndConfirm });
        const instructions = sendAndConfirm.mock.calls[0][1].instructions;
        const nonce = client.decisionNonce({ role: 0, assetHash: Offer.assetHash(FLAT), holding: HOLDING, offer: chain.address });
        const attestation = Statements.confirmationAddress(member, nonce).toBase58();
        // credential + schema setup (none exist yet), the attestation, confirm, execute
        expect(instructions.map(ix => ix.programId.toBase58())).toEqual([SAS, SAS, SAS, PROGRAM, PROGRAM]);
        expect(instructions[2].keys[4].pubkey.toBase58()).toBe(attestation);
        expect(Buffer.from(instructions[3].data)).toEqual(disc('confirm'));
        expect(instructions[3].keys[1].pubkey.toBase58()).toBe(attestation);
        expect(Buffer.from(instructions[4].data)).toEqual(disc('execute'));
        const payload = Buffer.from(instructions[2].data).subarray(1 + 32 + 4);
        expect(payload.includes(Buffer.from(HOLDING))).toBe(true);
    });
    it('refuses a stranger, a role-0 confirmation without holding, and a holding already confirmed for another offer', async () => {
        const row = offerRow(), chain = fakeChain(row);
        await committedSell(row, chain);
        await expect(confirmOffer({ ...base(chain, row, strangerKp), holding: HOLDING, nowSeconds: NOW, sendAndConfirm: sender() })).rejects.toThrow(/not a lens member/);
        await expect(confirmOffer({ ...base(chain, row, memberKp), nowSeconds: NOW, sendAndConfirm: sender() })).rejects.toThrow(/needs holding/);
        const nonce = client.decisionNonce({ role: 0, assetHash: Offer.assetHash(FLAT), holding: HOLDING, offer: chain.address });
        const other = kp(46).publicKey.toBase58();
        const payload = client.encodeDecisionPayload({ cid: row.cid, offer: other, termsHash: 'ab'.repeat(32), payoutsHash: 'cd'.repeat(32), buyer, seller, role: 0, assetHash: Offer.assetHash(FLAT), holding: HOLDING, observedAt: 1 });
        const len = Buffer.alloc(4); len.writeUInt32LE(payload.length);
        chain.put(Statements.confirmationAddress(member, nonce), SAS, Buffer.concat([Buffer.from([2]), Buffer.alloc(96), len, Buffer.from(payload), Buffer.alloc(32), Buffer.alloc(8)]));
        const sendAndConfirm = sender();
        await expect(confirmOffer({ ...base(chain, row, memberKp), holding: HOLDING, nowSeconds: NOW, sendAndConfirm })).rejects.toThrow(/another sale of this holding/);
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });
    it('a member that has confirmed already replays', async () => {
        const row = offerRow(), chain = fakeChain(row);
        await committedSell(row, chain, { buyer_lens: lensOf([member, seller], 2, 0b01) });
        const sendAndConfirm = sender();
        expect((await confirmOffer({ ...base(chain, row, memberKp), holding: HOLDING, nowSeconds: NOW, sendAndConfirm })).replayed).toBe(true);
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });
});

describe('execute, cancel, expire', () => {
    it('execute waits for both lenses; cancel is the maker’s while open; expire only after the deadline', async () => {
        const row = offerRow(), chain = fakeChain(row);
        await committedSell(row, chain);
        await expect(executeOffer({ ...base(chain, row, strangerKp), nowSeconds: NOW, sendAndConfirm: sender() })).rejects.toThrow(/waits for its lens members/);
        await chain.set({ buyer_lens: lensOf([member], 1, 0b1) });
        const sendAndConfirm = sender(() => chain.set({ status: { Settled: {} } }));
        expect((await executeOffer({ ...base(chain, row, strangerKp), nowSeconds: NOW, sendAndConfirm })).status).toBe('settled');
        expect(sendAndConfirm.mock.calls[0][1].instructions[0].keys.at(-1).pubkey.toBase58()).toBe(seller);
        const open = fakeChain(row); await open.set({});
        await expect(cancelOffer({ ...base(open, row, buyerKp), sendAndConfirm: sender() })).rejects.toThrow(/Only the maker/);
        await expect(expireOffer({ ...base(open, row, strangerKp), nowSeconds: NOW, sendAndConfirm: sender() })).rejects.toThrow(/has not passed/);
        const cancel = sender(() => open.set({ status: { Cancelled: {} } }));
        expect((await cancelOffer({ ...base(open, row, sellerKp), nowSeconds: NOW, sendAndConfirm: cancel })).status).toBe('cancelled');
        expect(Buffer.from(cancel.mock.calls[0][1].instructions[0].data)).toEqual(disc('cancel'));
    });
});

describe('state holding', () => {
    it('states a first holder once at its fixed address; the same holder replays, another is refused', async () => {
        const row = offerRow(), chain = fakeChain(row);
        const sendAndConfirm = sender();
        const result = await stateHolding({ connection: chain.connection, keypair: memberKp, asset: FLAT, holder: seller, basis: 'declared', nowSeconds: NOW, sendAndConfirm });
        const address = Statements.holdingAddress(member, Offer.assetHash(FLAT)).toBase58();
        expect(result).toMatchObject({ replayed: false, attestation: address, assetHash: Offer.assetHash(FLAT) });
        // The statement now exists: a SAS attestation account carrying its payload.
        const payload = Buffer.from(Statements.encodeHoldingPayload({ assetHash: Offer.assetHash(FLAT), asset: Offer.assetKey(FLAT), holder: seller, basis: 'declared', observedAt: NOW }));
        const length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
        chain.put(address, SAS, Buffer.concat([Buffer.from([2]), Buffer.alloc(96), length, payload, Buffer.alloc(40)]));
        expect((await stateHolding({ connection: chain.connection, keypair: memberKp, asset: FLAT, holder: seller, basis: 'declared', nowSeconds: NOW, sendAndConfirm })).replayed).toBe(true);
        await expect(stateHolding({ connection: chain.connection, keypair: memberKp, asset: FLAT, holder: buyer, basis: 'declared', nowSeconds: NOW, sendAndConfirm })).rejects.toThrow(/already stated/);
        expect(sendAndConfirm).toHaveBeenCalledOnce();
    });
});

describe('createOnchainRecorder', () => {
    it('posts the reference with the app origin and checks the answer names the offer', async () => {
        const row = offerRow();
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ cid: row.cid, onchain: {} }) }));
        const record = createOnchainRecorder({ apiBase: 'http://localhost:4201/', appOrigin: 'http://localhost:5201/property-offers', fetchImpl });
        await record({ chain: 'solana', cluster: 'devnet', account: 'A' }, row.cid);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(`http://localhost:4201/property-offers/${row.cid}/onchain`);
        expect(init.headers.Origin).toBe('http://localhost:5201');
    });
});
