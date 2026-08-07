import * as turf from '@turf/turf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { demolishBuildingsUnderFootprint } = require('../../frontend/js/corridor-tunnel.js');

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
    'ensureBuildingFootprintsForBounds'
];

describe('demolition during canonical replay', () => {
    const previous = new Map();

    beforeEach(() => {
        GLOBAL_KEYS.forEach(key => previous.set(key, globalThis[key]));
        globalThis.turf = turf;
        globalThis.buildingFeaturePool = [];
        globalThis.proposedBuildings = [structuredClone(BUILDING)];
        globalThis.proposalStorage = { getAllProposals: () => [] };
        globalThis.ensureBuildingFootprintsForBounds = vi.fn(async () => true);
        globalThis.ProposalManager = { unapplyProposal: vi.fn(async () => true) };
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
        const transaction = { id: 17 };

        await demolishBuildingsUnderFootprint(REGION, {
            proposalId: 'later-square',
            _mutationTransaction: transaction
        });

        expect(globalThis.ProposalManager.unapplyProposal).toHaveBeenCalledWith(
            'earlier-building',
            expect.objectContaining({
                skipConfirm: true,
                skipRebuild: true,
                _mutationTransaction: transaction
            })
        );
    });

    it('does not treat a stale copy of the taker as its own obstacle', async () => {
        await demolishBuildingsUnderFootprint(REGION, {
            proposalId: 'earlier-building',
            _mutationTransaction: { id: 18 }
        });

        expect(globalThis.ProposalManager.unapplyProposal).not.toHaveBeenCalled();
    });
});
