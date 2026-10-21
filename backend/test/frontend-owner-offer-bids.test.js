// Pure logic of frontend/js/proposals/bids-card.js: the ranking of pledges and donations shown as
// bids in Details, the owner-offer role and explorer links. (The "Offer my land" mode gate went with
// owner offers in M2, plan-design-agreement.md.)
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const offer = require('../../frontend/js/proposals/bids-card.js');

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
