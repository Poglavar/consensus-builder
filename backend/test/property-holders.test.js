// Holder according to a lens (frontend/js/property-holders.js): a lens member's first-holder statement
// followed through the sales it confirmed whose offers settled; pending and expired sales stop the walk;
// members who name different holders are a conflict. Accounts are built with the real codecs.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const offers = require('../../frontend/js/solana/property-offer-client.js');
const statements = require('../../frontend/js/solana/property-statements.js');
const Holders = require('../../frontend/js/property-holders.js');
const anchor = createRequire(new URL('../../blockchain/solana/package.json', import.meta.url))('@coral-xyz/anchor');
const coder = new anchor.BorshCoder(JSON.parse(readFileSync(new URL('../../blockchain/solana/idl/property_offer.json', import.meta.url), 'utf8')));
offers.configure({ web3 }); statements.configure({ web3 });

const key = n => web3.Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const [M, N, A, B, C, D] = [1, 2, 3, 4, 5, 6].map(key);
const asset = 'ab'.repeat(32);
const vec = bytes => { const l = Buffer.alloc(4); l.writeUInt32LE(bytes.length); return Buffer.concat([l, Buffer.from(bytes)]); };
const attestation = (member, kind, nonce, payload) => Buffer.concat([Buffer.from([2]), new web3.PublicKey(nonce).toBuffer(), statements.credentialPda(member).toBuffer(),
    statements.schemaPda(statements.credentialPda(member), kind).toBuffer(), vec(payload), member.toBuffer(), Buffer.alloc(8, 0x7f), Buffer.alloc(32)]);

function world() {
    const accounts = new Map();
    const put = (address, bytes) => accounts.set(address.toString(), new Uint8Array(bytes));
    const first = (member, holder) => put(statements.holdingAddress(member, asset), attestation(member, 'holding', Buffer.from(asset, 'hex'),
        statements.encodeHoldingPayload({ assetHash: asset, asset: 'k', holder: holder.toBase58(), basis: 'developer', observedAt: 1 })));
    let n = 10;
    async function sale(member, holding, seller, buyer, status) {
        const cid = 'bafkrei' + String(n).padStart(52, 'a'); const offer = key(n++);
        put(offer, await coder.accounts.encode('PropertyOffer', { maker: seller, buyer, seller, mint: web3.PublicKey.default, side: { Sell: {} }, status: { [status]: {} },
            price: new anchor.BN(5), escrow: new anchor.BN(0), deadline: new anchor.BN(9), created_at: new anchor.BN(1), committed_at: new anchor.BN(2), settled_at: new anchor.BN(3),
            terms_hash: Array(32).fill(1), payouts_hash: Array(32).fill(2), buyer_lens: { members: Array(8).fill(web3.PublicKey.default), count: 0, threshold: 0, confirmed: 0 },
            seller_lens: { members: Array(8).fill(web3.PublicKey.default), count: 0, threshold: 0, confirmed: 0 }, payouts: [{ recipient: seller, amount: new anchor.BN(5) }], bump: 1, cid }));
        const nonce = offers.decisionNonce({ role: 0, assetHash: asset, holding });
        put(statements.confirmationAddress(member, nonce), attestation(member, 'confirmation', new web3.PublicKey(nonce).toBuffer(), offers.encodeDecisionPayload({ cid, offer: offer.toBase58(),
            termsHash: '01'.repeat(32), payoutsHash: '02'.repeat(32), buyer: buyer.toBase58(), seller: seller.toBase58(), role: 0, assetHash: asset, holding, observedAt: 1 })));
        return offer.toBase58();
    }
    return { first, sale, deps: { assetHash: asset, getAccount: async address => accounts.get(address) || null, statements, offers } };
}

describe('holder according to a lens', () => {
    it('follows a lens member’s first holder through settled sales and stops at a pending one', async () => {
        const w = world();
        w.first(M, A);
        const firstAddress = statements.holdingAddress(M, asset).toBase58();
        const sold = await w.sale(M, firstAddress, A, B, 'Settled');
        const pending = await w.sale(M, sold, B, C, 'Committed');
        const view = await Holders.viewOf({ member: M.toBase58(), ...w.deps });
        expect(view.holder).toBe(B.toBase58());
        expect(view.holding).toBe(sold);
        expect(view.sales.map(s => s.buyer)).toEqual([B.toBase58()]);
        expect(view.pending).toMatchObject({ offer: pending, buyer: C.toBase58() });
    });
    it('leaves the holder unchanged after an expired sale and marks it stale', async () => {
        const w = world();
        w.first(M, A);
        await w.sale(M, statements.holdingAddress(M, asset).toBase58(), A, B, 'Expired');
        const view = await Holders.viewOf({ member: M.toBase58(), ...w.deps });
        expect(view.holder).toBe(A.toBase58());
        expect(view.stale).toMatchObject({ status: 'Expired', buyer: B.toBase58() });
    });
    it('reports agreement, silence and conflict across a lens', async () => {
        const w = world();
        w.first(M, A);
        let lens = await Holders.lensView({ members: [M.toBase58(), N.toBase58()], ...w.deps });
        expect(lens).toMatchObject({ holder: A.toBase58(), conflict: null, silent: [N.toBase58()], stating: 1 });
        w.first(N, D);
        lens = await Holders.lensView({ members: [M.toBase58(), N.toBase58()], ...w.deps });
        expect(lens.holder).toBeNull();
        expect(lens.conflict.sort()).toEqual([A.toBase58(), D.toBase58()].sort());
    });
    it('ignores a statement signed by someone else at the member’s address', async () => {
        const w = world();
        const forged = attestation(N, 'holding', Buffer.from(asset, 'hex'), statements.encodeHoldingPayload({ assetHash: asset, asset: 'k', holder: D.toBase58(), basis: 'declared', observedAt: 1 }));
        const view = await Holders.viewOf({ member: M.toBase58(), ...w.deps, getAccount: async address => address === statements.holdingAddress(M, asset).toBase58() ? new Uint8Array(forged) : null });
        expect(view.holder).toBeNull();
        expect(view.invalid).toBe(statements.holdingAddress(M, asset).toBase58());
    });

    it('batches first holdings and hop-0 confirmations across many assets in a single viewsOf read, then walks sales breadth-first', async () => {
        const asset1 = '11'.repeat(32);
        const asset2 = '22'.repeat(32);
        const asset3 = '33'.repeat(32);
        const accounts = new Map();
        const put = (address, bytes) => accounts.set(address.toString(), new Uint8Array(bytes));
        const firstFor = (member, assetHash, holder) => put(
            statements.holdingAddress(member, assetHash),
            attestation(member, 'holding', Buffer.from(assetHash, 'hex'),
                statements.encodeHoldingPayload({ assetHash, asset: 'k', holder: holder.toBase58(), basis: 'developer', observedAt: 1 }))
        );
        let n = 30;
        async function saleFor(member, assetHash, holding, seller, buyer, status) {
            const cid = 'bafkrei' + String(n).padStart(52, 'b'); const offer = key(n++);
            put(offer, await coder.accounts.encode('PropertyOffer', { maker: seller, buyer, seller, mint: web3.PublicKey.default, side: { Sell: {} }, status: { [status]: {} },
                price: new anchor.BN(5), escrow: new anchor.BN(0), deadline: new anchor.BN(9), created_at: new anchor.BN(1), committed_at: new anchor.BN(2), settled_at: new anchor.BN(3),
                terms_hash: Array(32).fill(1), payouts_hash: Array(32).fill(2), buyer_lens: { members: Array(8).fill(web3.PublicKey.default), count: 0, threshold: 0, confirmed: 0 },
                seller_lens: { members: Array(8).fill(web3.PublicKey.default), count: 0, threshold: 0, confirmed: 0 }, payouts: [{ recipient: seller, amount: new anchor.BN(5) }], bump: 1, cid }));
            const nonce = offers.decisionNonce({ role: 0, assetHash, holding });
            put(statements.confirmationAddress(member, nonce), attestation(member, 'confirmation', new web3.PublicKey(nonce).toBuffer(), offers.encodeDecisionPayload({ cid, offer: offer.toBase58(),
                termsHash: '01'.repeat(32), payoutsHash: '02'.repeat(32), buyer: buyer.toBase58(), seller: seller.toBase58(), role: 0, assetHash, holding, observedAt: 1 })));
            return offer.toBase58();
        }
        // Three assets with no sales yet: viewsOf finishes in 1 batched getAccounts call.
        firstFor(M, asset1, A);
        firstFor(M, asset2, B);
        let batchCalls = 0;
        const getAccounts = async addresses => {
            batchCalls += 1;
            return new Map(addresses.map(address => [address, accounts.get(address) || null]));
        };
        const items = [{ member: M.toBase58(), assetHash: asset1 }, { member: M.toBase58(), assetHash: asset2 }, { member: M.toBase58(), assetHash: asset3 }];
        const noSales = await Holders.viewsOf({ items, getAccounts, statements, offers });
        expect(batchCalls).toBe(1);
        expect(noSales.map(v => v.holder)).toEqual([A.toBase58(), B.toBase58(), null]);

        // Add a settled sale + pending sale on asset1 and an expired sale on asset2; viewsOf must match viewOf.
        const sold = await saleFor(M, asset1, statements.holdingAddress(M, asset1).toBase58(), A, C, 'Settled');
        const pending = await saleFor(M, asset1, sold, C, D, 'Committed');
        await saleFor(M, asset2, statements.holdingAddress(M, asset2).toBase58(), B, D, 'Expired');
        batchCalls = 0;
        const batched = await Holders.viewsOf({ items, getAccounts, statements, offers });
        const single = await Promise.all(items.map(item => Holders.viewOf({
            ...item, getAccount: async address => accounts.get(address) || null, statements, offers
        })));
        expect(batched).toEqual(single);
        expect(batched[0]).toMatchObject({ holder: C.toBase58(), holding: sold, pending: { offer: pending, buyer: D.toBase58() } });
        expect(batched[1]).toMatchObject({ holder: B.toBase58(), stale: { status: 'Expired', buyer: D.toBase58() } });
        // 1 initial batch (holdings + hop-0 confirmations) + 1 offer batch + 1 hop-1 confirmation + 1 hop-1 offer = 4 batches total for all 3 assets.
        expect(batchCalls).toBe(4);
    });
});
