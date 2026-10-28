import * as turf from '@turf/turf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { demolishBuildingsUnderFootprint, collectLoadedCorridorBuildings } = require('../../frontend/js/corridor-tunnel.js');
const { demolishedBuildingRecordsFrom } = require('../../frontend/js/corridor-carve.js');

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
    'ensureBuildingFootprintsForBounds',
    'demolishedBuildingRecordsFrom'
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
        globalThis.demolishedBuildingRecordsFrom = demolishedBuildingRecordsFrom;
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

        await demolishBuildingsUnderFootprint(REGION, {
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

    it('re-derives removals from the transaction state rather than the still-visible source it replaces', async () => {
        const stock = { ...structuredClone(BUILDING), properties: { id: 'observed-1' } };
        globalThis.proposedBuildings = [];
        globalThis.proposalStorage = { getAllProposals: () => [{ proposalId: 'source', applied: true,
            buildingProposal: { demolishedBuildings: [{ id: 'observed-1', geometry: stock.geometry }] } }] };
        expect(collectLoadedCorridorBuildings({ extraPool: [stock], includeLoadedSurveyPool: false })).toEqual([]);
        const transaction = { proposals: { getAllProposals: () => [] }, collections: { proposedBuildings: [] } };
        const records = await demolishBuildingsUnderFootprint(REGION, {
            proposalId: 'edited', _parcelMutation: transaction, preloadedBuildings: [stock]
        });
        expect(records).toMatchObject([{ id: 'observed-1', geometry: stock.geometry }]);
        // The editor uses the same stock view when reviewing a replacement, before commit.
        expect(collectLoadedCorridorBuildings({ extraPool: [stock], includeLoadedSurveyPool: false, excludeProposalId: 'source' }))
            .toMatchObject([{ properties: { id: 'observed-1' } }]);
        expect(globalThis.proposalStorage.getAllProposals()[0].applied).toBe(true);
    });

    it('keeps removals made by other applied designs while reviewing or replacing a source', async () => {
        const stock = ['source-stock', 'other-stock'].map(id => ({
            ...structuredClone(BUILDING), properties: { id }
        }));
        const source = { proposalId: 'source', applied: true,
            buildingProposal: { demolishedBuildings: [{ id: 'source-stock', geometry: stock[0].geometry }] } };
        const other = { proposalId: 'other', applied: true,
            buildingProposal: { demolishedBuildings: [{ id: 'other-stock', geometry: stock[1].geometry }] } };
        globalThis.proposedBuildings = [];
        globalThis.proposalStorage = { getAllProposals: () => [source, other] };
        const pool = collectLoadedCorridorBuildings({ extraPool: stock, includeLoadedSurveyPool: false,
            excludeProposalId: 'source' });
        expect(pool.map(feature => feature.properties.id)).toEqual(['source-stock']);
        const records = await demolishBuildingsUnderFootprint(REGION, {
            proposalId: 'edited', preloadedBuildings: stock,
            _parcelMutation: { proposals: { getAllProposals: () => [other] }, collections: { proposedBuildings: [] } }
        });
        expect(records.map(record => record.id)).toEqual(['source-stock']);
    });

    it('does not treat a stale copy of the taker as its own obstacle', async () => {
        await demolishBuildingsUnderFootprint(REGION, {
            proposalId: 'earlier-building',
            _parcelMutation: { id: 18 }
        });

        expect(globalThis.ProposalManager.unapplyProposal).not.toHaveBeenCalled();
    });

    it('does not change another proposal record while boot is materializing its applied-set snapshot', async () => {
        await demolishBuildingsUnderFootprint(REGION, {
            proposalId: 'later-square',
            preserveAppliedSet: true
        });

        expect(globalThis.ProposalManager.unapplyProposal).not.toHaveBeenCalled();
    });
});
