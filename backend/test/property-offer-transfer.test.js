import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { canonicalBytes } from '../cid.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { devnetOwnerRegistry } from '../lens/approval.js';
import { client } from '../property-offers/onchain.js';
import { createOwnershipTransfers, ownershipTransferBasis, resolveOwnershipTransfers } from '../property-offers/ownership-transfers.js';
import { readOwnership, registryParcelKey } from '../property-offers/ownership.js';

const Offer = createRequire(import.meta.url)('../../frontend/js/property-offer-record.js');
const [first, other, second, third, lens, decision] = [1, 2, 3, 4, 5, 6].map(n => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58());
const network = 'test-genesis';
const parcels = [{ sourceId: 'oss-wfs', id: 'HR-1-1/2' }, { sourceId: 'local', id: '2' }];
const keys = parcels.map(registryParcelKey);
const rootRows = keys.flatMap((parcelUid, i) => (i === 0 ? [first, other] : [first]).map(owner => ({
    parcelUid, owner, ownerCount: i === 0 ? 2 : 1, establishedAt: 100
})));

function fixture() {
    const records = new Map(), confirmed = new Map(), offers = new Map();
    const store = {
        async list(_lens, _network, ids) { return [...records.values()].filter(record => record.keys.some(key => ids.includes(key))); },
        async get(_lens, _network, cid) { return records.get(cid); },
        async reserve(record, verify) { await verify(); records.set(record.cid, { ...record, terminal: null }); },
        async observe(_lens, _network, cid, state) { const record = { ...records.get(cid), ...state }; records.set(cid, record); return record; }
    };
    const readFinalized = vi.fn(async offer => confirmed.get(offer.cid));
    const transfers = createOwnershipTransfers({ store, authority: lens, network, loadOffer: async cid => offers.get(cid), readFinalized });
    const identity = createDevnetRegistryIdentity({ rows: rootRows, authority: lens, clock: { nowSeconds: () => 1000 },
        resolveOwnerSets: roots => transfers.resolve(roots) });
    async function prepare(buyer, seller, sellers, observedAt) {
        const content = Offer.published({ schema: 'property-offer/v1', city: 'test', direction: 'sell', proposer: seller, buyer: null, seller,
            lens, parcels, priceLamports: String(sellers.length), payouts: sellers.map(recipient => ({ recipient, lamports: '1' })),
            createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' });
        const cid = Offer.cid(content);
        const offer = { cid, content };
        offers.set(cid, offer);
        const address = client.getOfferPda(cid, seller)[0].toBase58();
        const fields = { cid, offer: address, buyer, seller, termsHash: createHash('sha256').update(canonicalBytes(content)).digest('hex'),
            payoutsHash: Buffer.from(client.payoutScheduleHash(content.payouts)).toString('hex') };
        const basis = ownershipTransferBasis(content.parcels, await readOwnership(content.parcels, identity), network);
        await transfers.reserve({ offer, fields, basis, decision, identity, consents: sellers.map(owner => ({ owner, signature: Buffer.alloc(64).toString('base64') })) });
        const account = { ...fields, address, lens, maker: seller, side: 'Sell', status: 'Settled', decisionAttestation: decision,
            priceLamports: BigInt(content.priceLamports), escrowLamports: 0n, deadline: BigInt(Math.floor(Date.parse(content.expiresAt) / 1000)),
            payouts: content.payouts, payoutsReleased: sellers.length, paidBitmap: (1 << sellers.length) - 1 };
        return { cid, settle: (state = {}) => confirmed.set(cid, { observedAt, account: { ...account, ...state } }) };
    }
    return { identity, transfers, prepare, records, readFinalized };
}

const walletsOf = rows => rows.map(row => row.owner).sort();

describe('lens ownership transfer evidence', () => {
    it('recognizes the same buyer for offers and agreements only after finality, then follows a resale', async () => {
        const f = fixture();
        const initial = await f.prepare(second, first, [first, other], 200);
        expect(await f.transfers.evidence(initial.cid)).toBeNull();
        expect(walletsOf(await f.identity.ownerSet(keys[0]))).toEqual([first, other].sort());
        initial.settle();
        const agreement = await devnetOwnerRegistry(f.identity).load(keys);
        expect([...agreement.parcels.values()].map(parcel => parcel.owners[0].ownerId)).toEqual([second, second]);
        const evidence = await f.transfers.evidence(initial.cid);
        expect(evidence).toMatchObject({ proof: { buyer: second, seller: first, lens, network }, observedAt: 200, decision });
        for (const ref of parcels) expect((await f.identity.ownerSet(registryParcelKey(ref)))[0]).toMatchObject({ owner: second, ownerCount: 1, evidenceRef: evidence.id });
        const resale = await f.prepare(third, second, [second], 300);
        resale.settle();
        const resaleEvidence = await f.transfers.evidence(resale.cid);
        expect(resaleEvidence.proof.parcels.map(parcel => parcel.owners[0])).toEqual(parcels.map(() => expect.objectContaining({
            evidenceRef: evidence.id, evidenceOfferCid: initial.cid, evidenceLens: lens
        })));
        expect(walletsOf(await f.identity.ownerSet(keys[0]))).toEqual([third]);
        expect(walletsOf(await f.identity.ownerSet(keys[1]))).toEqual([third]);
    });

    it('rejects a different finalized decision and keeps void offers out of the proof chain', async () => {
        const f = fixture();
        const entry = await f.prepare(second, first, [first, other], 200);
        entry.settle({ decisionAttestation: third });
        await expect(f.transfers.evidence(entry.cid)).rejects.toMatchObject({ code: 'transfer_settlement_mismatch' });
        entry.settle({ status: 'Expired' });
        expect(await f.transfers.evidence(entry.cid)).toBeNull();
        expect(walletsOf(await f.identity.ownerSet(keys[0]))).toEqual([first, other].sort());
    });

    it('leaves competing finalized successor records unresolved', async () => {
        const f = fixture();
        const entry = await f.prepare(second, first, [first, other], 200);
        const original = { ...f.records.get(entry.cid), terminal: 'settled', observedAt: 200 };
        const conflict = { ...original, proof: { ...original.proof, buyer: third } };
        expect(() => resolveOwnershipTransfers(new Map([[keys[0], rootRows.filter(row => row.parcelUid === keys[0])]]), [original, conflict]))
            .toThrow(/conflicting ownership transfers/);
    });
});
