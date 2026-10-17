// Unit tests for isVoteProposal() / isNonBindingProposal() in frontend/js/proposals/lifecycle.js.
// Whether a proposal is a vote is the kind chosen at publish (proposal-kinds.md), never inferred
// from its design: getting this wrong would turn a binding parcel change into a mere vote (or vice
// versa), so the cases the old design-based inference got wrong are pinned down here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isVoteProposal, isNonBindingProposal } = require('../../frontend/js/proposals/lifecycle.js');

describe('isVoteProposal (owners cast votes)', () => {
    it('is the owner-vote kind, whatever the design changes', () => {
        expect(isVoteProposal({ kind: 'owner-vote', facets: { ownership: 'no-change', parcels: 'as-is' } })).toBe(true);
        // A park that takes a car park's parcel can be put to the owners as a vote.
        expect(isVoteProposal({ kind: 'owner-vote', goal: 'park', facets: { ownership: 'to-city', parcels: 'merge' } })).toBe(true);
    });

    it('is never inferred from the design', () => {
        expect(isVoteProposal({ facets: { ownership: 'no-change', parcels: 'as-is' } })).toBe(false);
        expect(isVoteProposal({ kind: 'owner-deal', facets: { ownership: 'no-change', parcels: 'as-is' } })).toBe(false);
    });

    it('is not a community vote: residents vote there, not owners', () => {
        expect(isVoteProposal({ kind: 'community-vote' })).toBe(false);
    });

    it('ignores the retired isVote flag', () => {
        expect(isVoteProposal({ isVote: true })).toBe(false);
    });

    it('a record without a kind, or no record, is not a vote', () => {
        expect(isVoteProposal({})).toBe(false);
        expect(isVoteProposal(null)).toBe(false);
        expect(isVoteProposal(undefined)).toBe(false);
    });
});

describe('isNonBindingProposal (never executes, holds no money)', () => {
    it('covers both vote kinds and nothing else', () => {
        expect(isNonBindingProposal({ kind: 'owner-vote' })).toBe(true);
        expect(isNonBindingProposal({ kind: 'community-vote' })).toBe(true);
        expect(isNonBindingProposal({ kind: 'owner-deal' })).toBe(false);
        expect(isNonBindingProposal({})).toBe(false);
        expect(isNonBindingProposal({ kind: 'petition' })).toBe(false);
    });
});
