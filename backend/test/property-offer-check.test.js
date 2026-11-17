// Preflight rejects unusable ownership evidence before offer publication.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createLensMemberApp } from '../lens/server.js';
const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');

const [lens, ownerA, ownerB, maker] = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
const schema = Keypair.generate().publicKey.toBase58();
const refs = [{ sourceId: 'oss-wfs', id: 'HR-1-1/1' }, { sourceId: 'oss-wfs', id: 'HR-1-1/2' }];
const uid = ref => Offer.parcelUid(ref);
const ownerRows = new Map([[refs[0].id, [{ owner: ownerA, ownerCount: 2, establishedAt: 100 }, { owner: ownerB, ownerCount: 2, establishedAt: 100 }]],
    [refs[1].id, [{ owner: ownerB, ownerCount: 1, establishedAt: 200 }]]]);

function content(patch = {}) {
    return Offer.published({ schema: 'property-offer/v1', city: 'zagreb', createdAt: '2026-11-17T00:00:00.000Z', expiresAt: '2026-12-17T00:00:00.000Z',
        direction: 'sell', proposer: ownerA, buyer: null, seller: ownerA, lens, parcels: refs, priceLamports: '20',
        payouts: [{ recipient: ownerA, lamports: '10' }, { recipient: ownerB, lamports: '10' }], ...patch });
}

function appFor({ sets = ownerRows, dryRun = false } = {}) {
    const ownerSets = vi.fn(async keys => new Map(keys.map(key => [key, sets.get(key) || []])));
    const load = vi.fn(), account = vi.fn(), attest = vi.fn();
    const member = { authority: lens, credential: Keypair.generate().publicKey.toBase58(), schemas: { propertyOffer: schema }, identity: { ownerSets },
        status: async () => ({ dryRun }), attestPropertyOfferDecision: attest };
    const app = createLensMemberApp({ member, pricing: {}, propertyOffers: { load, account }, clock: { nowSeconds: () => Math.floor(Date.parse('2026-11-20T00:00:00.000Z') / 1000) } });
    return { app, member, ownerSets, load, account, attest };
}

describe('property offer preflight', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns current complete ownership sets without reading chain accounts or issuing attestations', async () => {
        const f = appFor(), offer = content();
        const response = await request(f.app).post('/lens/property-offers/check').send({ content: offer });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ key: lens, credential: f.member.credential, schema, parcels: [
            { ref: refs[0], owners: ownerRows.get(refs[0].id) }, { ref: refs[1], owners: ownerRows.get(refs[1].id) }
        ] });
        expect(f.ownerSets).toHaveBeenCalledWith(refs.map(ref => ref.id));
        expect(f.load).not.toHaveBeenCalled();
        expect(f.account).not.toHaveBeenCalled();
        expect(f.attest).not.toHaveBeenCalled();
    });

    it('rejects missing and incomplete ownership with parcel details', async () => {
        const missing = appFor({ sets: new Map([[refs[0].id, ownerRows.get(refs[0].id)]]) });
        const absent = await request(missing.app).post('/lens/property-offers/check').send({ content: content() });
        expect(absent.status).toBe(422);
        expect(absent.body).toMatchObject({ error: 'ownership_missing', parcels: [refs[1]] });

        const incomplete = appFor({ sets: new Map([[refs[0].id, [{ owner: ownerA, ownerCount: 1, establishedAt: 100 }, { owner: ownerA, ownerCount: 1, establishedAt: 100 }]], [refs[1].id, ownerRows.get(refs[1].id)]]) });
        const duplicate = await request(incomplete.app).post('/lens/property-offers/check').send({ content: content() });
        expect(duplicate.status).toBe(422);
        expect(duplicate.body).toMatchObject({ error: 'ownership_incomplete', parcels: [{ ref: refs[0] }] });
    });

    it('requires sale payouts to exactly match owners and enforces lens and live member', async () => {
        const f = appFor();
        const mismatch = await request(f.app).post('/lens/property-offers/check').send({ content: content({ payouts: [{ recipient: ownerA, lamports: '20' }] }) });
        expect(mismatch.status).toBe(422);
        expect(mismatch.body.error).toBe('payout_ownership_mismatch');
        const wrongLens = await request(f.app).post('/lens/property-offers/check').send({ content: content({ lens: maker }) });
        expect(wrongLens.status).toBe(422);
        expect(wrongLens.body.error).toBe('wrong_lens');
        const dry = appFor({ dryRun: true });
        const refused = await request(dry.app).post('/lens/property-offers/check').send({ content: content() });
        expect(refused.status).toBe(503);
        expect(refused.body.error).toBe('dry_run_member');
    });

    it('rejects noncanonical or invalid content before querying ownership', async () => {
        const f = appFor();
        const extra = { ...content(), unexpected: true };
        const response = await request(f.app).post('/lens/property-offers/check').send({ content: extra });
        expect(response.status).toBe(422);
        expect(response.body.error).toBe('noncanonical_offer');
        expect(f.ownerSets).not.toHaveBeenCalled();
    });

    it('accepts reordered JSONB object keys while refusing expired offers and a nonowner proposer', async () => {
        const f = appFor();
        const canonical = content();
        const reordered = Object.fromEntries(Object.entries(canonical).reverse());
        const accepted = await request(f.app).post('/lens/property-offers/check').send({ content: reordered });
        expect(accepted.status).toBe(200);

        const expired = await request(f.app).post('/lens/property-offers/check').send({ content: content({ expiresAt: '2026-11-19T00:00:00.000Z' }) });
        expect(expired.status).toBe(422);
        expect(expired.body.error).toBe('expired_offer');

        const nonowner = await request(f.app).post('/lens/property-offers/check').send({ content: content({ proposer: maker, seller: maker }) });
        expect(nonowner.status).toBe(422);
        expect(nonowner.body.error).toBe('seller_not_owner');
    });
});
