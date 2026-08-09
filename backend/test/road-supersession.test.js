// Unit tests for copied-road replacement state, independent of Leaflet and proposal storage.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    roadProposalIsApplied,
    appliedRoadProposalForFeature
} = require('../../frontend/js/road-supersession.js');

// Post status-split: proposals carry the boolean `applied` axis and a `lifecycleStatus` axis.
function proposal(id, applied = false, lifecycleStatus = 'Active') {
    return { proposalId: id, applied, lifecycleStatus, roadProposal: {} };
}

describe('road parcel selection', () => {
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
