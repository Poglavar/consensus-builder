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
    parcelSet: { parcelIds: [...parcelIds].sort(), setHash }
});

describe('land fork of a proposal', () => {
    it('treats an identical set (any order, duplicates) as a plain counterproposal', () => {
        const source = origin(['HR-1', 'HR-2']);
        expect(describeLandFork(source, ['HR-2', 'HR-1', 'HR-2'])).toMatchObject({
            relation: 'same', sameSet: true, addedCount: 0, removedCount: 0
        });
        expect(buildLandForkLineage(source, ['HR-2', 'HR-1'])).toBeNull();
    });

    it('records origin id, origin set hash and counts when the fork adds parcels', () => {
        expect(buildLandForkLineage(origin(['HR-1', 'HR-2']), ['HR-1', 'HR-2', 'HR-3'])).toEqual({
            originProposalId: 'origin-1',
            originSetHash: 'sha256:origin',
            relation: 'contains-origin',
            originParcelCount: 2,
            sharedParcelCount: 2,
            addedParcelCount: 1,
            removedParcelCount: 0
        });
    });

    it('classifies subset, partial overlap and disjoint forks from the origin side', () => {
        const source = origin(['HR-1', 'HR-2', 'HR-3']);
        expect(describeLandFork(source, ['HR-1'])).toMatchObject({ relation: 'inside-origin', sharedCount: 1, removedCount: 2, addedCount: 0 });
        expect(describeLandFork(source, ['HR-3', 'HR-4'])).toMatchObject({ relation: 'overlap', sharedCount: 1, addedCount: 1, removedCount: 2 });
        expect(buildLandForkLineage(source, ['HR-8', 'HR-9'])).toMatchObject({ relation: 'disjoint', sharedParcelCount: 0, addedParcelCount: 2, removedParcelCount: 3 });
    });

    it('falls back to legacy cadastreParcelIds and a null hash for a local origin', () => {
        const local = { proposalId: 'local-7', cadastreParcelIds: ['HR-1'] };
        expect(buildLandForkLineage(local, ['HR-1', 'HR-2'])).toMatchObject({
            originProposalId: 'local-7', originSetHash: null, relation: 'contains-origin'
        });
    });

    it('records nothing without an origin id or without parcels on either side', () => {
        expect(buildLandForkLineage({ cadastreParcelIds: ['HR-1'] }, ['HR-2'])).toBeNull();
        expect(buildLandForkLineage(origin([]), ['HR-2'])).toBeNull();
        expect(buildLandForkLineage(origin(['HR-1']), [])).toBeNull();
        expect(describeLandFork(null, ['HR-1'])).toBeNull();
    });

    it('phrases each relation with its own i18n key and the stored counts', () => {
        const lineage = buildLandForkLineage(origin(['HR-1', 'HR-2', 'HR-3']), ['HR-3', 'HR-4']);
        expect(landForkSummaryMessage(lineage)).toEqual({
            key: 'panel.proposal.landFork.relationOverlap',
            fallback: '{{shared}} parcels shared with the original, {{added}} added, {{removed}} removed',
            params: { origin: 3, shared: 1, added: 1, removed: 2 }
        });
        const live = describeLandFork(origin(['HR-1']), ['HR-1']);
        expect(landForkSummaryMessage(live).key).toBe('panel.proposal.landFork.relationSame');
        expect(landForkSummaryMessage({ relation: 'bogus' })).toBeNull();
        expect(landForkSummaryMessage(null)).toBeNull();
    });
});
