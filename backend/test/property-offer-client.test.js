// Reject unusable or foreign SAS accounts before an offer can be published or minted.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const client = require('../../frontend/js/solana/property-offer-client.js');
// Anchor's own coder, from the program workspace, checks every byte this codec writes and reads.
const anchor = createRequire(new URL('../../blockchain/solana/package.json', import.meta.url))('@coral-xyz/anchor');
const idl = JSON.parse(readFileSync(new URL('../../blockchain/solana/idl/property_offer.json', import.meta.url), 'utf8'));
const coder = new anchor.BorshCoder(idl);
client.configure({ web3: require('@solana/web3.js') });
const authority = Keypair.fromSeed(new Uint8Array(32).fill(81)).publicKey;
const credential = Keypair.fromSeed(new Uint8Array(32).fill(82)).publicKey;
const owner = new PublicKey(client.constants.SAS_PROGRAM_ID);
const vec = value => { const bytes = Buffer.from(value), length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([length, bytes]); };
function fixture() {
    return { authority, credential,
        credentialInfo: { owner, data: Buffer.concat([Buffer.from([0]), authority.toBuffer()]) },
        schemaInfo: { owner, data: Buffer.concat([Buffer.from([1]), credential.toBuffer(), vec('PropertyOfferDecision'), vec(''), vec('fields'), vec([1,2,3]), Buffer.from([0,1])]) } };
}
describe('property offer SAS preflight accounts', () => {
    it('accepts the active schema under the selected lens credential', () => {
        expect(client.validateDecisionSchema(fixture())).toBe(true);
    });
    it('rejects missing, foreign, truncated or paused schema accounts', () => {
        const cases = [
            f => { f.schemaInfo = null; },
            f => { f.schemaInfo.owner = authority; },
            f => { f.credentialInfo.data[1] ^= 1; },
            f => { f.schemaInfo.data[1] ^= 1; },
            f => { f.schemaInfo.data = f.schemaInfo.data.subarray(0,40); },
            f => { f.schemaInfo.data[f.schemaInfo.data.length - 2] = 1; }
        ];
        for (const change of cases) { const f = fixture(); change(f); expect(() => client.validateDecisionSchema(f)).toThrow(); }
    });
});

describe('property offer v2 codec against the program IDL', () => {
    const keys = Array.from({ length: 6 }, (_, i) => Keypair.fromSeed(new Uint8Array(32).fill(90 + i)).publicKey);
    const cid = 'bafkrei' + 'a'.repeat(52), terms = 'ab'.repeat(32);
    it('encodes create and commit exactly as Anchor does', () => {
        const create = coder.instruction.decode(Buffer.from(client.encodeCreateData({ cid, side: 'sell', termsHash: terms, price: '900', deadline: 1_900_000_000,
            payouts: [{ recipient: keys[0].toBase58(), amount: '600' }, { recipient: keys[1].toBase58(), amount: '300' }], lens: [], lensThreshold: 0 })));
        expect(create.name).toBe('create');
        expect(create.data.cid).toBe(cid);
        expect(Object.keys(create.data.side).map(k => k.toLowerCase())).toEqual(['sell']);
        expect(create.data.price.toString()).toBe('900');
        expect(create.data.payouts.map(p => [p.recipient.toBase58(), p.amount.toString()])).toEqual([[keys[0].toBase58(), '600'], [keys[1].toBase58(), '300']]);
        expect(create.data.lens).toEqual([]);
        const commit = coder.instruction.decode(Buffer.from(client.encodeCommitData({ side: 'sell', lens: [keys[2].toBase58(), keys[3].toBase58()], lensThreshold: 2 })));
        expect(commit.name).toBe('commit');
        expect(commit.data.lens.map(k => k.toBase58())).toEqual([keys[2].toBase58(), keys[3].toBase58()]);
        expect(commit.data.lens_threshold ?? commit.data.lensThreshold).toBe(2);
        expect(() => client.encodeCommitData({ side: 'sell', lens: [], lensThreshold: 0 })).toThrow();
        expect(() => client.encodeCreateData({ cid, side: 'buy', termsHash: terms, price: '1', deadline: 1, lens: [], lensThreshold: 0 })).toThrow();
    });
    it('reads an offer account Anchor encodes, lenses and confirmations included', async () => {
        const lens = (members, threshold, confirmed) => ({ members: [...members, ...Array(8 - members.length).fill(PublicKey.default)], count: members.length, threshold, confirmed });
        const bytes = await coder.accounts.encode('PropertyOffer', {
            maker: keys[0], buyer: keys[1], seller: keys[0], mint: new PublicKey(client.constants.USDC_MINT), side: { Sell: {} }, status: { Committed: {} },
            price: new anchor.BN(900), escrow: new anchor.BN(900), deadline: new anchor.BN(1_900_000_000), created_at: new anchor.BN(1), committed_at: new anchor.BN(2), settled_at: new anchor.BN(0),
            terms_hash: Array(32).fill(0xab), payouts_hash: Array(32).fill(0xcd), buyer_lens: lens([keys[2], keys[3]], 2, 0b10), seller_lens: lens([], 0, 0),
            payouts: [{ recipient: keys[0], amount: new anchor.BN(900) }], bump: 254, cid });
        const offer = client.readPropertyOffer(new Uint8Array(bytes), 'x');
        expect(offer).toMatchObject({ maker: keys[0].toBase58(), buyer: keys[1].toBase58(), currency: 'USDC', side: 'Sell', status: 'Committed', price: 900n, escrow: 900n, cid,
            buyerLens: { members: [keys[2].toBase58(), keys[3].toBase58()], threshold: 2, confirmed: [keys[3].toBase58()], met: false }, sellerLens: { members: [], threshold: 0, met: true } });
        expect(offer.payouts).toEqual([{ recipient: keys[0].toBase58(), amount: 900n }]);
        expect([offer.createdAt, offer.committedAt, offer.termsHash, offer.payoutsHash]).toEqual([1n, 2n, 'ab'.repeat(32), 'cd'.repeat(32)]);
    });
    it('puts a holding’s sale confirmations at one address per lens member, whatever the offer', () => {
        const asset = 'ef'.repeat(32);
        const sale = offer => client.decisionNonce({ role: 0, assetHash: asset, holding: 'first-holding-statement', offer });
        expect(sale(keys[4].toBase58())).toBe(sale(keys[5].toBase58()));
        expect(client.decisionNonce({ role: 0, assetHash: asset, holding: 'bought-through-offer' })).not.toBe(sale(keys[4].toBase58()));
        expect(client.decisionNonce({ role: 1, offer: keys[4].toBase58() })).not.toBe(client.decisionNonce({ role: 1, offer: keys[5].toBase58() }));
        const payload = client.encodeDecisionPayload({ cid, offer: keys[4].toBase58(), termsHash: terms, payoutsHash: 'cd'.repeat(32), buyer: keys[1].toBase58(), seller: keys[0].toBase58(), role: 0, assetHash: asset, holding: 'h', observedAt: 5 });
        const attestation = Buffer.concat([Buffer.from([2]), keys[5].toBuffer(), keys[2].toBuffer(), keys[3].toBuffer(), vec(payload), keys[2].toBuffer(), Buffer.alloc(8), Buffer.alloc(32)]);
        expect(client.readDecisionAttestation(attestation).fields).toMatchObject({ cid, role: 0, assetHash: asset, holding: 'h', observedAt: 5n, seller: keys[0].toBase58() });
    });
});
