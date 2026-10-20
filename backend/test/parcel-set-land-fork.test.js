// Land-fork decisions: when a counterproposal's parcel set differs from its origin's, how it relates,
// and the lineage record it stores (null for an identical set = plain counterproposal).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    describeLandFork,
    buildLandForkLineage,
    landForkSummaryMessage
} = require('../../frontend/js/proposals/parcel-set-relations.js');

const origin = (parcelIds, setHash = 'sha256:origin') => ({
    proposalId: 'origin-1',
    cadastreParcelIds: parcelIds,
    parcelSet: { parcelIds: [...parcelIds].sort(), setHash, parcelSource: { sourceId: 'register-a', snapshotId: null } }
});
const source = { sourceId: 'register-a', snapshotId: null };

describe('land fork of a proposal', () => {
    it('treats an identical set (any order, duplicates) as a plain counterproposal', () => {
        const proposal = origin(['HR-1', 'HR-2']);
        expect(describeLandFork(proposal, ['HR-2', 'HR-1', 'HR-2'], source)).toMatchObject({
            relation: 'same', sameSet: true, addedCount: 0, removedCount: 0
        });
        expect(buildLandForkLineage(proposal, ['HR-2', 'HR-1'], source)).toBeNull();
    });

    it('records origin set hash and counts when the fork adds parcels', () => {
        expect(buildLandForkLineage(origin(['HR-1', 'HR-2']), ['HR-1', 'HR-2', 'HR-3'], source)).toEqual({
            originSetHash: 'sha256:origin',
            relation: 'contains-origin',
            originParcelCount: 2,
            sharedParcelCount: 2,
            addedParcelCount: 1,
            removedParcelCount: 0
        });
    });

    it('classifies subset, partial overlap and disjoint forks from the origin side', () => {
        const proposal = origin(['HR-1', 'HR-2', 'HR-3']);
        expect(describeLandFork(proposal, ['HR-1'], source)).toMatchObject({ relation: 'inside-origin', sharedCount: 1, removedCount: 2, addedCount: 0 });
        expect(describeLandFork(proposal, ['HR-3', 'HR-4'], source)).toMatchObject({ relation: 'overlap', sharedCount: 1, addedCount: 1, removedCount: 2 });
        expect(buildLandForkLineage(proposal, ['HR-8', 'HR-9'], source)).toMatchObject({ relation: 'disjoint', sharedParcelCount: 0, addedParcelCount: 2, removedParcelCount: 3 });
    });

    it('does not claim a land fork when either source is unknown', () => {
        const local = { proposalId: 'local-7', cadastreParcelIds: ['HR-1'] };
        expect(buildLandForkLineage(local, ['HR-1', 'HR-2'], source)).toBeNull();
        expect(buildLandForkLineage(origin(['HR-1']), ['HR-1', 'HR-2'])).toBeNull();
    });

    it('keeps the origin proposal reference in proposalOrigin rather than duplicating it', () => {
        const lineage = buildLandForkLineage(origin(['HR-1']), ['HR-1', 'HR-2'], source);
        expect(lineage).toMatchObject({ originSetHash: 'sha256:origin', relation: 'contains-origin' });
        expect(lineage).not.toHaveProperty('originProposalId');
    });

    it('uses the current declaration and a null publication hash for a sourced local origin', () => {
        const local = { proposalId: 'local-7', cadastreParcelIds: ['HR-1'], parcelSet: { parcelSource: source } };
        expect(buildLandForkLineage(local, ['HR-1', 'HR-2'], source)).toMatchObject({
            originSetHash: null, relation: 'contains-origin'
        });
    });

    it('records nothing without an origin id or without parcels on either side', () => {
        expect(buildLandForkLineage({ cadastreParcelIds: ['HR-1'] }, ['HR-2'], source)).toBeNull();
        expect(buildLandForkLineage(origin([]), ['HR-2'], source)).toBeNull();
        expect(buildLandForkLineage(origin(['HR-1']), [], source)).toBeNull();
        expect(describeLandFork(null, ['HR-1'], source)).toBeNull();
    });

    it('phrases each relation with its own i18n key and the stored counts', () => {
        const lineage = buildLandForkLineage(origin(['HR-1', 'HR-2', 'HR-3']), ['HR-3', 'HR-4'], source);
        expect(landForkSummaryMessage(lineage)).toEqual({
            key: 'panel.proposal.landFork.relationOverlap',
            fallback: '{{shared}} parcels shared with the original, {{added}} added, {{removed}} removed',
            params: { origin: 3, shared: 1, added: 1, removed: 2 }
        });
        const live = describeLandFork(origin(['HR-1']), ['HR-1'], source);
        expect(landForkSummaryMessage(live).key).toBe('panel.proposal.landFork.relationSame');
        expect(landForkSummaryMessage({ relation: 'bogus' })).toBeNull();
        expect(landForkSummaryMessage(null)).toBeNull();
    });
});
