// Pure logic of frontend/js/proposals/bids-card.js: the "Offer my land" mode gate (an ownership
// attestation for the connected wallet from a lens member) and the ranking of pledges and donations
// shown as bids in Details.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const offer = require('../../frontend/js/proposals/bids-card.js');

const MEMBER = 'Memb3r1111111111111111111111111111111111111';
const OTHER_MEMBER = 'Other111111111111111111111111111111111111111';
const OWNER = 'Owner11111111111111111111111111111111111111';
const STRANGER = 'Strange1111111111111111111111111111111111111';
const NOW = 1_800_000_000;

const att = (parcelUid, overrides = {}) => ({ address: `att-${parcelUid}`, kind: 'ownership', authority: MEMBER, parcelUid, owner: OWNER, expiry: NOW + 3600, ...overrides });

describe('ownerOfferEligibility', () => {
    const base = { parcelIds: ['P1', 'P2'], owner: OWNER, lensKeys: [MEMBER], nowSeconds: NOW };

    it('is eligible when a lens member attested the wallet for one selected parcel, submittable only when all are', () => {
        const partial = offer.ownerOfferEligibility({ ...base, results: [
            { memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P1')] },
            { memberKey: MEMBER, parcelUid: 'P2', attestations: [] }
        ] });
        expect(partial).toMatchObject({ eligible: true, submittable: false, attestedParcelIds: ['P1'], unattestedParcelIds: ['P2'] });
        expect(partial.attestedBy).toEqual({ P1: [MEMBER] });

        const full = offer.ownerOfferEligibility({ ...base, results: [
            { memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P1')] },
            { memberKey: MEMBER, parcelUid: 'P2', attestations: [att('P2')] }
        ] });
        expect(full).toMatchObject({ eligible: true, submittable: true, unattestedParcelIds: [] });
    });

    it('is not eligible without a matching attestation', () => {
        const cases = [
            [], // nothing asked
            [{ memberKey: MEMBER, parcelUid: 'P1', attestations: null }], // service unreachable proves nothing
            [{ memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P1', { owner: STRANGER })] }], // someone else's
            [{ memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P2')] }], // other parcel in payload
            [{ memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P1', { expiry: NOW - 1 })] }], // expired
            [{ memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P1', { authority: OTHER_MEMBER })] }], // not signed by the asked member
            [{ memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P1', { kind: 'verdict' })] }], // not an ownership fact
            [{ memberKey: OTHER_MEMBER, parcelUid: 'P1', attestations: [att('P1', { authority: OTHER_MEMBER })] }], // member not in the lens
            [{ memberKey: MEMBER, parcelUid: 'P9', attestations: [att('P9')] }] // parcel not selected
        ];
        for (const results of cases) {
            const result = offer.ownerOfferEligibility({ ...base, results });
            expect(result.eligible).toBe(false);
            expect(result.submittable).toBe(false);
        }
        expect(offer.ownerOfferEligibility({ ...base, owner: null, results: [
            { memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P1')] }] }).eligible).toBe(false);
        expect(offer.ownerOfferEligibility({ ...base, parcelIds: [], results: [] }).submittable).toBe(false);
    });

    it('treats an attestation without a stated expiry as unexpired', () => {
        const result = offer.ownerOfferEligibility({ ...base, parcelIds: ['P1'], results: [
            { memberKey: MEMBER, parcelUid: 'P1', attestations: [att('P1', { expiry: null })] }] });
        expect(result.submittable).toBe(true);
    });
});

describe('rankBids', () => {
    it('ranks active/fulfilled pledges and unrefunded donations by amount, earlier bid first on ties', () => {
        const ranked = offer.rankBids({
            pledges: [
                { address: 'pA', owner: 'W1', amount: 5_000_000n, status: 0, time: 200, signature: 'sA' },
                { address: 'pB', owner: 'W2', amount: 9_000_000n, status: 1, time: 300 },
                { address: 'pC', owner: 'W3', amount: 50_000_000n, status: 2, time: 100 }, // revoked
                { address: 'pD', owner: 'W4', amount: 50_000_000n, status: 3, time: 100 }, // voided
                { address: 'pE', owner: 'W5', amount: 0n, status: 0, time: 100 }
            ],
            donations: [
                { address: 'dA', owner: 'W1', amount: 5_000_000n, refunded: false, time: 100 },
                { address: 'dB', owner: 'W6', amount: '7000000', refunded: false, time: null },
                { address: 'dC', owner: 'W7', amount: 80_000_000n, refunded: true, time: 50 }
            ]
        });
        expect(ranked.bids.map(bid => [bid.rank, bid.kind, bid.address, bid.amount])).toEqual([
            [1, 'pledge', 'pB', 9_000_000n],
            [2, 'donation', 'dB', 7_000_000n],
            [3, 'donation', 'dA', 5_000_000n],
            [4, 'pledge', 'pA', 5_000_000n]
        ]);
        expect(ranked.bids[0].fulfilled).toBe(true);
        expect(ranked.bids[3].signature).toBe('sA');
        expect(ranked.total).toBe(26_000_000n);
        expect(ranked.bidderCount).toBe(3);
    });

    it('sorts an unknown time after a known one at the same amount', () => {
        const ranked = offer.rankBids({ donations: [
            { address: 'd1', owner: 'W1', amount: 1n, refunded: false, time: null },
            { address: 'd2', owner: 'W2', amount: 1n, refunded: false, time: 10 }
        ] });
        expect(ranked.bids.map(bid => bid.address)).toEqual(['d2', 'd1']);
    });

    it('returns an empty ranking for no support', () => {
        expect(offer.rankBids({})).toEqual({ bids: [], total: 0n, bidderCount: 0 });
    });
});

describe('isOwnerOffer and explorerLink', () => {
    it('recognises only the owner-offer role', () => {
        expect(offer.isOwnerOffer({ proposalRole: 'owner-offer' })).toBe(true);
        expect(offer.isOwnerOffer({ proposalRole: 'other' })).toBe(false);
        expect(offer.isOwnerOffer({})).toBe(false);
        expect(offer.isOwnerOffer(null)).toBe(false);
    });

    it('links the transaction when known, else the account', () => {
        expect(offer.explorerLink({ signature: 'Sig', address: 'Acc', cluster: 'devnet' })).toBe('https://explorer.solana.com/tx/Sig?cluster=devnet');
        expect(offer.explorerLink({ address: 'Acc' })).toBe('https://explorer.solana.com/address/Acc?cluster=devnet');
        expect(offer.explorerLink({})).toBeNull();
    });
});
