// Unit tests for generic immutable-replacement source supersession and restoration.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    proposalIsAppliedForReplacement,
    proposalReplacementSourceId,
    beginReplacementSupersession,
    commitReplacementSupersession,
    activeReplacementSuperseder,
    releaseReplacementSource
} = require('../../frontend/js/proposal-supersession.js');

describe('proposal replacement supersession', () => {
    it('recognizes applied state across every proposal payload family', () => {
        expect(proposalIsAppliedForReplacement({ buildingProposal: { status: 'applied' } })).toBe(true);
        expect(proposalIsAppliedForReplacement({ reparcellization: { status: 'executed' } })).toBe(true);
        expect(proposalIsAppliedForReplacement({ structureProposal: { status: 'unapplied' }, status: 'Active' })).toBe(false);
    });

    it('accepts new provenance fields before the legacy copied-from field', () => {
        expect(proposalReplacementSourceId({ sourceProposalId: 'new', copiedFromProposalId: 'old' })).toBe('new');
        expect(proposalReplacementSourceId({ replacementOfProposalId: 'replacement-source' })).toBe('replacement-source');
    });

    it('records whether the immutable source was applied, then parks it after replacement apply', () => {
        const source = { proposalId: 'source', status: 'Applied', buildingProposal: { status: 'applied' } };
        const replacement = { proposalId: 'replacement', sourceProposalId: 'source', status: 'Active', buildingProposal: { status: 'unapplied' } };
        const records = new Map([['source', source], ['replacement', replacement]]);

        const prepared = beginReplacementSupersession(replacement, 'replacement', id => records.get(id));
        const committed = commitReplacementSupersession(replacement, 'replacement', id => records.get(id));

        expect(prepared.wasApplied).toBe(true);
        expect(committed.lifecycle.state).toBe('active');
        expect(source.supersededByProposalId).toBe('replacement');
        expect(replacement.supersedesProposalIds).toEqual(['source']);
        expect(activeReplacementSuperseder(source, id => records.get(id))).toBeNull();

        replacement.status = 'Applied';
        replacement.buildingProposal.status = 'applied';
        expect(activeReplacementSuperseder(source, id => records.get(id))).toBe(replacement);
    });

    it('releases the marker and requests source reapplication only when it was previously applied', () => {
        const source = { proposalId: 'source', status: 'Active', structureProposal: { status: 'unapplied' } };
        const replacement = {
            proposalId: 'replacement',
            sourceProposalId: 'source',
            supersedesProposalIds: ['source'],
            replacementLifecycle: {
                sourceProposalId: 'source',
                replacementProposalId: 'replacement',
                sourceWasApplied: true,
                sourceStatusSnapshot: { status: 'Applied', 'structureProposal.status': 'applied' },
                state: 'active'
            }
        };
        source.supersededByProposalId = 'replacement';
        const records = new Map([['source', source], ['replacement', replacement]]);

        const released = releaseReplacementSource(replacement, 'replacement', id => records.get(id));

        expect(released).toMatchObject({ sourceId: 'source', shouldReapply: true });
        expect(source.supersededByProposalId).toBeUndefined();
        expect(replacement.replacementLifecycle).toBeUndefined();
        expect(replacement.supersedesProposalIds).toBeUndefined();
    });

    it('does not reapply the source when the supersession was prepared but never committed', () => {
        // An apply attempt that fails leaves a 'pending' lifecycle on the replacement; removing
        // the still-unapplied replacement must not double-apply the untouched source.
        const source = { proposalId: 'source', status: 'Applied', buildingProposal: { status: 'applied' } };
        const replacement = { proposalId: 'replacement', sourceProposalId: 'source', status: 'Active' };
        const records = new Map([['source', source], ['replacement', replacement]]);
        beginReplacementSupersession(replacement, 'replacement', id => records.get(id));

        const released = releaseReplacementSource(replacement, 'replacement', id => records.get(id));
        expect(released.shouldReapply).toBe(false);
        expect(source.supersededByProposalId).toBeUndefined();
    });

    it('does not request reapplication for a source that was already unapplied', () => {
        const source = { proposalId: 'source', status: 'Active' };
        const replacement = { proposalId: 'replacement', replacementOfProposalId: 'source' };
        const records = new Map([['source', source], ['replacement', replacement]]);
        beginReplacementSupersession(replacement, 'replacement', id => records.get(id));
        commitReplacementSupersession(replacement, 'replacement', id => records.get(id));

        expect(releaseReplacementSource(replacement, 'replacement', id => records.get(id)).shouldReapply).toBe(false);
    });
});
