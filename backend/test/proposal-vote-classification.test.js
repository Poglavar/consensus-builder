// Unit tests for isVoteProposal() in frontend/js/proposals/lifecycle.js — the single predicate
// that decides whether a proposal is a non-binding VOTE (owners cast yes-votes, nothing transfers)
// versus a binding ACCEPT proposal. Getting this wrong would turn a binding parcel change into a
// mere vote (or vice versa), so the tricky cases are pinned down here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isVoteProposal } = require('../../frontend/js/proposals/lifecycle.js');

describe('isVoteProposal', () => {
    it('is a vote when it changes neither ownership nor parcels (e.g. an urban rule / public-realm change)', () => {
        expect(isVoteProposal({ facets: { ownership: 'no-change', parcels: 'as-is' } })).toBe(true);
    });

    it('is NOT a vote when ownership transfers to the proposer', () => {
        expect(isVoteProposal({ facets: { ownership: 'to-me', parcels: 'as-is' } })).toBe(false);
    });

    it('is NOT a vote when ownership transfers to the city', () => {
        expect(isVoteProposal({ facets: { ownership: 'to-city', parcels: 'merge' } })).toBe(false);
    });

    it('is NOT a vote when ownership transfers to a third party', () => {
        expect(isVoteProposal({ facets: { ownership: 'third-party', parcels: 'as-is' } })).toBe(false);
    });

    // The critical case: a reparcellization keeps ownership 'no-change' but reshapes parcels.
    // That is a binding change requiring owner acceptance — it must NOT be classified as a vote.
    it('is NOT a vote when parcels are reshaped even if ownership is no-change (reparcellization)', () => {
        expect(isVoteProposal({ facets: { ownership: 'no-change', parcels: 'readjust' } })).toBe(false);
        expect(isVoteProposal({ facets: { ownership: 'no-change', parcels: 'merge' } })).toBe(false);
    });

    it('honors an explicit boolean isVote flag (chain-loaded proposals) over facet derivation', () => {
        expect(isVoteProposal({ isVote: true, facets: { ownership: 'to-me', parcels: 'merge' } })).toBe(true);
        expect(isVoteProposal({ isVote: false, facets: { ownership: 'no-change', parcels: 'as-is' } })).toBe(false);
    });

    it('defaults to NOT a vote when facets are missing (legacy/binding proposals stay binding)', () => {
        expect(isVoteProposal({})).toBe(false);
        expect(isVoteProposal(null)).toBe(false);
        expect(isVoteProposal(undefined)).toBe(false);
    });
});
