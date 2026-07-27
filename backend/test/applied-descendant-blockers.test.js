// Which applied proposals may BLOCK a parent road/reparcellization from re-creating one of its child
// slices. Only typologies that actually consume their parents (road, reparcellization, decide-later)
// may block; structures and buildings merely overlay theirs. Getting this wrong punches a hole in the
// parcel fabric: the parent is hidden, the slice under the overlay is never re-created, and nothing
// under the building is clickable any more. Pure — no map, no DOM, no turf.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    _buildAppliedDescendantIndex,
    _filterChildFeaturesBlockedByDescendants
} = require('../../frontend/js/proposal-manager.js');

const SLICE_ID = 'HR-339270-6804/1#p-road-1';

const sliceFeature = (parcelId = SLICE_ID) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
    properties: { parcelId }
});

const stubStorage = (proposals) => {
    globalThis.proposalStorage = { getAllProposals: () => proposals };
};

describe('applied descendant blockers', () => {
    afterEach(() => {
        delete globalThis.proposalStorage;
    });

    it('an applied building does NOT block its parent slice from being re-created', () => {
        // Regression: a freeform building applied on road slice #-1 made the road's re-apply skip
        // that slice entirely. The road hid the 13350 m2 parent and re-created only 2644 m2 of
        // children, leaving ~9900 m2 with no clickable parcel underneath the building.
        stubStorage([{
            proposalId: 'p-building',
            applied: true,
            parentParcelIds: [SLICE_ID],
            buildingProposal: { applied: true, parentParcelIds: [SLICE_ID] }
        }]);

        expect(_buildAppliedDescendantIndex('p-road').has(SLICE_ID)).toBe(false);
        expect(_filterChildFeaturesBlockedByDescendants([sliceFeature()], 'p-road')).toHaveLength(1);
    });

    it('an applied structure does NOT block its parent slice either', () => {
        stubStorage([{
            proposalId: 'p-park',
            applied: true,
            parentParcelIds: [SLICE_ID],
            structureProposal: { applied: true, parentParcelIds: [SLICE_ID] }
        }]);

        expect(_filterChildFeaturesBlockedByDescendants([sliceFeature()], 'p-road')).toHaveLength(1);
    });

    it('an applied road DOES block the slice it consumed', () => {
        stubStorage([{
            proposalId: 'p-other-road',
            applied: true,
            parentParcelIds: [SLICE_ID],
            roadProposal: { applied: true, parentParcelIds: [SLICE_ID] }
        }]);

        expect(_buildAppliedDescendantIndex('p-road').has(SLICE_ID)).toBe(true);
        expect(_filterChildFeaturesBlockedByDescendants([sliceFeature()], 'p-road')).toHaveLength(0);
    });

    it('a building that also reparcels still blocks — it consumes its parents', () => {
        stubStorage([{
            proposalId: 'p-mixed',
            applied: true,
            parentParcelIds: [SLICE_ID],
            buildingProposal: { applied: true, parentParcelIds: [SLICE_ID] },
            reparcellization: { applied: true, parentParcelIds: [SLICE_ID] }
        }]);

        expect(_filterChildFeaturesBlockedByDescendants([sliceFeature()], 'p-road')).toHaveLength(0);
    });

    it('an UNapplied building never blocks', () => {
        stubStorage([{
            proposalId: 'p-building',
            applied: false,
            parentParcelIds: [SLICE_ID],
            buildingProposal: { applied: false, parentParcelIds: [SLICE_ID] }
        }]);

        expect(_filterChildFeaturesBlockedByDescendants([sliceFeature()], 'p-road')).toHaveLength(1);
    });

    it('the proposal being applied never blocks itself', () => {
        stubStorage([{
            proposalId: 'p-road',
            applied: true,
            parentParcelIds: [SLICE_ID],
            roadProposal: { applied: true, parentParcelIds: [SLICE_ID] }
        }]);

        expect(_filterChildFeaturesBlockedByDescendants([sliceFeature()], 'p-road')).toHaveLength(1);
    });

    it('slices unrelated to any applied proposal pass through', () => {
        stubStorage([{
            proposalId: 'p-other-road',
            applied: true,
            parentParcelIds: ['HR-339270-9999#p-x-1'],
            roadProposal: { applied: true, parentParcelIds: ['HR-339270-9999#p-x-1'] }
        }]);

        expect(_filterChildFeaturesBlockedByDescendants([sliceFeature()], 'p-road')).toHaveLength(1);
    });
});
