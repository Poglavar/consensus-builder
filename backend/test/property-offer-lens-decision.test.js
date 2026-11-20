import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { canonicalBytes, cidOf } from '../cid.js';
import { planPropertyOfferDecision } from '../lens/property-offer-decision.js';
import { createHash } from 'node:crypto';

const wallet = () => Keypair.generate().publicKey.toBase58();
describe('property-offer lens decision', () => {
    it('refuses a schedule that omits a co-owner before trusting any caller consent', async () => {
        const maker = wallet(), ownerA = wallet(), ownerB = wallet();
        const content = { schema: 'property-offer/v1', city: 'zagreb', createdAt: '2026-11-17T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
            direction: 'sell', proposer: maker, buyer: null, seller: maker, lens: wallet(), parcels: [{ sourceId: 'cadastre', id: '1' }], priceLamports: '10', payouts: [{ recipient: ownerA, lamports: '10' }] };
        const cid = cidOf(canonicalBytes(content));
        const termsHash = createHash('sha256').update(canonicalBytes(content)).digest('hex');
        const ownershipHash = 'a'.repeat(64);
        await expect(planPropertyOfferDecision({ ownershipHash, offer: { cid, content }, account: { cid, address: wallet(), maker, lens: content.lens, side: 'Sell', priceLamports: '10', status: 'Open', termsHash, payoutsHash: 'x', deadline: Math.floor(Date.parse(content.expiresAt) / 1000) },
            candidate: { buyer: wallet(), seller: maker, ownershipHash, consents: [{ owner: ownerA, signature: 'not-used' }] }, nowSeconds: 1_000,
            ownerSets: async () => new Map([['["cadastre","1",null]', [{ owner: ownerA, ownerCount: 2, establishedAt: 900 }, { owner: ownerB, ownerCount: 2, establishedAt: 900 }]]])
        })).rejects.toMatchObject({ code: 'payout_ownership_mismatch' });
    });
});
