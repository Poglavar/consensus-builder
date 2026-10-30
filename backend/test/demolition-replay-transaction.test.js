import * as turf from '@turf/turf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// A design applied during a replay parks the proposed buildings under it inside the replay's own
// transaction; existing buildings are derived (demolition-index.js), read here as its records.
const { parkProposedBuildingsUnder, collectLoadedCorridorBuildings } = require('../../frontend/js/corridor-tunnel.js');

const REGION = {
    type: 'Polygon',
    coordinates: [[
        [15.96, 45.80],
        [15.97, 45.80],
        [15.97, 45.81],
        [15.96, 45.81],
        [15.96, 45.80]
    ]]
};

const BUILDING = {
    type: 'Feature',
    properties: { proposalId: 'earlier-building', buildingIndex: 0 },
    geometry: {
        type: 'Polygon',
        coordinates: [[
            [15.962, 45.802],
            [15.964, 45.802],
            [15.964, 45.804],
            [15.962, 45.804],
            [15.962, 45.802]
        ]]
    }
};

const GLOBAL_KEYS = [
    'turf',
    'buildingFeaturePool',
    'proposedBuildings',
    'proposalStorage',
    'ProposalManager',
    'DemolitionIndex'
];

describe('demolition during canonical replay', () => {
    const previous = new Map();

    beforeEach(() => {
        GLOBAL_KEYS.forEach(key => previous.set(key, globalThis[key]));
        globalThis.turf = turf;
        globalThis.buildingFeaturePool = [];
        globalThis.proposedBuildings = [structuredClone(BUILDING)];
        globalThis.proposalStorage = { getAllProposals: () => [] };
        globalThis.ProposalManager = { unapplyProposal: vi.fn(async () => true) };
        globalThis.DemolitionIndex = { records: vi.fn(() => []) };
    });

    afterEach(() => {
        GLOBAL_KEYS.forEach(key => {
            const value = previous.get(key);
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        });
        previous.clear();
    });

    it('parks an earlier building inside the active root transaction', async () => {
        const mutation = { id: 17 };

        await parkProposedBuildingsUnder(REGION, {
            proposalId: 'later-square',
            _parcelMutation: mutation
        });

        expect(globalThis.ProposalManager.unapplyProposal).toHaveBeenCalledWith(
            'earlier-building',
            expect.objectContaining({
                skipConfirm: true,
                skipRebuild: true,
                _parcelMutation: mutation
            })
        );
    });

    it('scans the buildings as they stand without the design being edited', () => {
        const stock = ['source-stock', 'other-stock'].map(id => ({ ...structuredClone(BUILDING), properties: { id, source: 'osm' } }));
        globalThis.proposedBuildings = [];
        // The other design's removal stays; the edited one's is read as if it were not applied.
        globalThis.DemolitionIndex.records.mockImplementation(({ excludeProposalId }) =>
            (excludeProposalId === 'source' ? [{ id: 'osm:other-stock', geometry: stock[1].geometry }]
                : [{ id: 'osm:source-stock', geometry: stock[0].geometry }, { id: 'osm:other-stock', geometry: stock[1].geometry }]));
        expect(collectLoadedCorridorBuildings({ extraPool: stock, includeLoadedSurveyPool: false })).toEqual([]);
        expect(collectLoadedCorridorBuildings({ extraPool: stock, includeLoadedSurveyPool: false, excludeProposalId: 'source' })
            .map(feature => feature.properties.id)).toEqual(['source-stock']);
    });

    it('does not treat a stale copy of the taker as its own obstacle', async () => {
        await parkProposedBuildingsUnder(REGION, {
            proposalId: 'earlier-building',
            _parcelMutation: { id: 18 }
        });

        expect(globalThis.ProposalManager.unapplyProposal).not.toHaveBeenCalled();
    });

    it('does not change another proposal record while boot is materializing its applied-set snapshot', async () => {
        await parkProposedBuildingsUnder(REGION, {
            proposalId: 'later-square',
            preserveAppliedSet: true
        });

        expect(globalThis.ProposalManager.unapplyProposal).not.toHaveBeenCalled();
    });
});
