// Unit tests for copied-road replacement state, independent of Leaflet and proposal storage.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    roadProposalIsApplied,
    supersedeCopiedRoadSource,
    restoreSupersededRoadSources,
    activeRoadSuperseder,
    appliedRoadProposalForFeature
} = require('../../frontend/js/road-supersession.js');

// Post status-split: proposals carry the boolean `applied` axis and a `lifecycleStatus` axis.
function proposal(id, applied = false, lifecycleStatus = 'Active') {
    return { proposalId: id, applied, lifecycleStatus, roadProposal: {} };
}

describe('copied road supersession', () => {
    it('parks an applied source after its combined replacement applies', () => {
        const source = proposal('road-a', true, 'Active');
        const replacement = { ...proposal('road-b', true, 'Active'), copiedFromProposalId: 'road-a' };
        const records = new Map([[source.proposalId, source], [replacement.proposalId, replacement]]);

        expect(supersedeCopiedRoadSource(replacement, replacement.proposalId, id => records.get(id))).toBe(source);
        expect(source.roadProposal.applied).toBeUndefined();
        expect(source.applied).toBe(false);
        expect(source.lifecycleStatus).toBe('Active');
        expect(source.supersededByProposalId).toBe('road-b');
        expect(replacement.supersedesProposalIds).toEqual(['road-a']);
        expect(roadProposalIsApplied(source)).toBe(false);
        expect(activeRoadSuperseder(source, id => records.get(id))).toBe(replacement);
    });

    it('restores the source when the combined road is removed', () => {
        const source = proposal('road-a', true, 'Executed');
        const replacement = { ...proposal('road-b', true, 'Active'), copiedFromProposalId: 'road-a' };
        const records = new Map([[source.proposalId, source], [replacement.proposalId, replacement]]);
        supersedeCopiedRoadSource(replacement, replacement.proposalId, id => records.get(id));

        expect(restoreSupersededRoadSources(replacement, replacement.proposalId, id => records.get(id))).toEqual([source]);
        expect(source.roadProposal.applied).toBeUndefined();
        // An executed road comes back executed — supersession only parked its geometry.
        expect(source.lifecycleStatus).toBe('Executed');
        expect(source.supersededByProposalId).toBeUndefined();
        expect(replacement.supersedesProposalIds).toBeUndefined();
        expect(activeRoadSuperseder(source, id => records.get(id))).toBeNull();
    });

    it('does not park an unapplied source or an unrelated overlapping road', () => {
        const source = proposal('road-a');
        const replacement = proposal('road-b', true, 'Active');
        const records = new Map([[source.proposalId, source], [replacement.proposalId, replacement]]);
        expect(supersedeCopiedRoadSource(replacement, replacement.proposalId, id => records.get(id))).toBeNull();
        replacement.copiedFromProposalId = 'road-a';
        expect(supersedeCopiedRoadSource(replacement, replacement.proposalId, id => records.get(id))).toBeNull();
    });

    it('resolves an applied proposal when its corridor parcel is clicked', () => {
        const road = proposal('road-a', true, 'Active');
        const records = new Map([[road.proposalId, road]]);
        const feature = { properties: { isRoad: true, isCorridor: true, ancestorProposal: 'road-a' } };
        expect(appliedRoadProposalForFeature(feature, id => records.get(id))).toBe(road);
        expect(appliedRoadProposalForFeature({ properties: { isRoad: true } }, id => records.get(id))).toBeNull();
        road.applied = false;
        expect(appliedRoadProposalForFeature(feature, id => records.get(id))).toBeNull();
    });
});
