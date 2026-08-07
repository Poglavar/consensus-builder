// Unit tests for generic immutable-replacement source supersession.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    proposalIsAppliedForReplacement,
    proposalReplacementSourceId,
    commitReplacementSupersession
} = require('../../frontend/js/proposal-supersession.js');

describe('proposal replacement supersession', () => {
    it('recognizes only the canonical root application flag', () => {
        expect(proposalIsAppliedForReplacement({ applied: true, buildingProposal: {} })).toBe(true);
        expect(proposalIsAppliedForReplacement({ applied: false, reparcellization: {} })).toBe(false);
        expect(proposalIsAppliedForReplacement({ buildingProposal: { status: 'applied' } })).toBe(false);
    });

    it('accepts new provenance fields before the legacy copied-from field', () => {
        expect(proposalReplacementSourceId({ sourceProposalId: 'new', copiedFromProposalId: 'old' })).toBe('new');
        expect(proposalReplacementSourceId({ replacementOfProposalId: 'replacement-source' })).toBe('replacement-source');
    });

    it('parks an applied source after its replacement succeeds', () => {
        const source = { proposalId: 'source', applied: true, appliedAt: 'before', buildingProposal: {} };
        const replacement = { proposalId: 'replacement', sourceProposalId: 'source', applied: true, buildingProposal: {} };
        const records = new Map([['source', source], ['replacement', replacement]]);

        const committed = commitReplacementSupersession(replacement, 'replacement', id => records.get(id));

        expect(committed).toMatchObject({ source, sourceId: 'source', replacementId: 'replacement' });
        expect(source.applied).toBe(false);
        expect(source.appliedAt).toBeUndefined();
        expect(replacement.replacementLifecycle).toBeUndefined();
        expect(replacement.supersedesProposalIds).toBeUndefined();
    });

    it('leaves an already-unapplied source alone', () => {
        const source = { proposalId: 'source', applied: false };
        const replacement = { proposalId: 'replacement', sourceProposalId: 'source' };
        const records = new Map([['source', source], ['replacement', replacement]]);
        expect(commitReplacementSupersession(replacement, 'replacement', id => records.get(id))).toBeNull();
        expect(source.applied).toBe(false);
    });
});
