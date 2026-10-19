// Unit tests for frontend/js/proposals/proposal-kind.js: the publish-time kind (owner deal, owner
// vote, community vote; proposal-kinds.md), its default for older records, and its term rules.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const kinds = require('../../frontend/js/proposals/proposal-kind.js');
const codes = record => kinds.kindErrors(record).map(error => error.code);

describe('kindOf', () => {
    it('reads the chosen kind', () => {
        for (const kind of kinds.KINDS) expect(kinds.kindOf({ kind })).toBe(kind);
    });

    it('reads a record without a kind as an owner deal (published before kinds existed)', () => {
        expect(kinds.kindOf({})).toBe('owner-deal');
        expect(kinds.kindOf({ kind: null })).toBe('owner-deal');
    });

    it('gives an unknown kind no kind at all', () => {
        expect(kinds.kindOf({ kind: 'petition' })).toBe(null);
        expect(kinds.isNonBinding({ kind: 'petition' })).toBe(false);
        expect(kinds.kindOf(null)).toBe(null);
    });

    it('preselects the least-committal kind for publishing', () => {
        expect(kinds.DEFAULT_PUBLISH_KIND).toBe('community-vote');
    });
});

describe('kindErrors', () => {
    it('accepts any design under any kind', () => {
        for (const kind of kinds.KINDS) {
            expect(codes({ kind, goal: 'park', facets: { ownership: 'to-city', parcels: 'merge' } })).toEqual([]);
        }
    });

    it('refuses an unknown kind', () => {
        expect(codes({ kind: 'petition' })).toEqual(['unknown-kind']);
    });

    it('refuses money on either vote kind', () => {
        for (const kind of ['owner-vote', 'community-vote']) {
            expect(codes({ kind, offer: 1000 })).toEqual(['vote-has-offer']);
            expect(codes({ kind, budget: '5' })).toEqual(['vote-has-budget']);
            expect(codes({ kind, depositEnabled: true })).toEqual(['vote-has-deposit']);
            expect(codes({ kind, offer: null, budget: null, depositEnabled: false })).toEqual([]);
            expect(codes({ kind, offer: 0 })).toEqual([]);
        }
    });

    it('lets an owner deal carry money', () => {
        expect(codes({ kind: 'owner-deal', offer: 1000, budget: 1000, depositEnabled: true })).toEqual([]);
        expect(codes({ offer: 1000 })).toEqual([]);
    });

    it('keeps the owner\'s sale offer an owner deal', () => {
        const sale = { goal: 'ownership-transfer-from-me', ownershipTransferProposal: { direction: 'from-me' } };
        expect(kinds.isOwnerSaleOffer(sale)).toBe(true);
        expect(codes({ ...sale, kind: 'owner-deal' })).toEqual([]);
        expect(codes(sale)).toEqual([]);
        expect(codes({ ...sale, kind: 'owner-vote' })).toEqual(['sale-offer-is-owner-deal']);
        expect(codes({ proposalRole: 'owner-offer', kind: 'community-vote' })).toEqual(['sale-offer-is-owner-deal']);
    });
});
