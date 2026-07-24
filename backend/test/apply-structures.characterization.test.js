// Characterizes the model-before-view contract for applying and unapplying park/square/lake/station
// proposals: every layer refresh must observe the proposal's canonical application state.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _applyStructureProposal } = require('../../frontend/js/proposals/apply/structures.js');
const { _unapplyStructureProposalConfirmed } = require('../../frontend/js/proposals/apply/unapply.js');
const { persistAppliedProposal } = require('../../frontend/js/proposals/apply/finalize.js');
const { getLifecycleStatus, isApplied, setProposalApplied } = require('../../frontend/js/proposals/status.js');

const originals = new Map();

function installGlobal(name, value) {
    if (!originals.has(name)) {
        originals.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

afterEach(() => {
    for (const [name, original] of originals) {
        if (original.existed) globalThis[name] = original.value;
        else delete globalThis[name];
    }
    originals.clear();
    vi.restoreAllMocks();
});

function polygon() {
    return {
        type: 'Polygon',
        coordinates: [[[15.97, 45.81], [15.971, 45.81], [15.971, 45.811], [15.97, 45.811], [15.97, 45.81]]]
    };
}

function structureProposal(kind, applied) {
    const proposal = {
        proposalId: `p-${kind}`,
        lifecycleStatus: 'Active',
        applied,
        parentParcelIds: ['parcel-1'],
        structureProposal: {
            kind,
            geometry: polygon(),
            parentParcelIds: ['parcel-1'],
            demolitionScanned: true,
            demolishedBuildings: [{ id: 'building-1', geometry: polygon() }]
        }
    };
    if (kind === 'station') {
        Object.assign(proposal.structureProposal, {
            stationType: 'elevated',
            center: [15.9705, 45.8105],
            bearing: 35,
            platformHeightM: 16.5,
            attachment: { kind: 'rail', proposalId: 'track-1' },
            modelVersion: 2
        });
    }
    return proposal;
}

function installSharedGlobals(browserWindow, proposalStore) {
    installGlobal('window', browserWindow);
    installGlobal('proposalStorage', proposalStore);
    installGlobal('PersistentStorage', { setItem: vi.fn() });
    installGlobal('_normalizeProposalId', value => String(value));
    installGlobal('appliedOf', isApplied);
    installGlobal('lifecycleOf', getLifecycleStatus);
    installGlobal('setProposalApplied', setProposalApplied);
    installGlobal('persistAppliedProposal', persistAppliedProposal);
    installGlobal('refreshProposalUIAfterApply', vi.fn());
    installGlobal('updateStatus', vi.fn());
}

const kinds = [
    ['park', 'parks', 'updateParksLayer', 'ensureParkDecorations'],
    ['square', 'squares', 'updateSquaresLayer', 'ensureSquareDecorations'],
    ['lake', 'lakes', 'updateLakesLayer', 'ensureLakeGraphics'],
    ['station', 'transitStations', 'updateTransitStationsLayer', null]
];

describe.each(kinds)('%s proposal presentation ordering', (kind, collectionName, updateName, ensureName) => {
    it('refreshes the layer only after apply is canonical', async () => {
        const proposal = structureProposal(kind, false);
        const browserWindow = { parks: [], squares: [], lakes: [], transitStations: [] };
        const proposalStore = {
            proposals: new Map([[proposal.proposalId, proposal]]),
            getAllProposals: () => [proposal],
            _indexProposal: vi.fn(value => proposalStore.proposals.set(value.proposalId, value)),
            save: vi.fn()
        };
        installSharedGlobals(browserWindow, proposalStore);
        if (ensureName) installGlobal(ensureName, vi.fn());

        const stateSeenByRefresh = [];
        installGlobal(updateName, vi.fn(() => stateSeenByRefresh.push(isApplied(proposal, proposal.structureProposal))));

        const manager = {
            _getCanonicalStructureGeometry: () => proposal.structureProposal.geometry,
            _resolveParcelFeaturesByIds: vi.fn(() => []),
            _resolveParentAvailabilityOrDefer: vi.fn(async () => ({ defer: false })),
            _setDescendantProposalOnParcels: vi.fn(),
            _linkProposalToAncestors: vi.fn(),
            _unmarkParcelModified: vi.fn()
        };

        const result = await _applyStructureProposal.call(manager, proposal.proposalId, proposal);

        expect(result).toBe(true);
        expect(browserWindow[collectionName]).toHaveLength(1);
        if (kind === 'station') {
            expect(browserWindow.transitStations[0].properties).toMatchObject({
                stationType: 'elevated', bearing: 35, platformHeightM: 16.5,
                attachment: { kind: 'rail', proposalId: 'track-1' }, modelVersion: 2
            });
        }
        expect(stateSeenByRefresh).toEqual([true]);
        expect(isApplied(proposal, proposal.structureProposal)).toBe(true);
    });

    it('refreshes the layer only after unapply is canonical', async () => {
        const proposal = structureProposal(kind, true);
        const feature = {
            type: 'Feature',
            properties: { proposalId: proposal.proposalId },
            geometry: polygon()
        };
        const browserWindow = { parks: [], squares: [], lakes: [], transitStations: [], [collectionName]: [feature] };
        const proposalStore = {
            proposals: new Map([[proposal.proposalId, proposal]]),
            _indexProposal: vi.fn(value => proposalStore.proposals.set(value.proposalId, value)),
            save: vi.fn()
        };
        installSharedGlobals(browserWindow, proposalStore);
        installGlobal('_getProposalRecord', () => proposal);

        const stateSeenByRefresh = [];
        installGlobal(updateName, vi.fn(() => stateSeenByRefresh.push(isApplied(proposal, proposal.structureProposal))));

        const manager = {
            _clearDescendantProposalOnParcels: vi.fn(),
            _unmarkParcelModified: vi.fn()
        };

        const result = await _unapplyStructureProposalConfirmed.call(manager, proposal.proposalId);

        expect(result).toBe(true);
        expect(browserWindow[collectionName]).toEqual([]);
        expect(stateSeenByRefresh).toEqual([false]);
        expect(isApplied(proposal, proposal.structureProposal)).toBe(false);
    });

    it('repairs an applied structure even when an earlier empty scan was marked complete', async () => {
        const proposal = structureProposal(kind, true);
        proposal.structureProposal.demolishedBuildings = [];
        proposal.structureProposal.demolitionScanned = true;
        const feature = {
            type: 'Feature',
            properties: { proposalId: proposal.proposalId },
            geometry: polygon()
        };
        const expectedRecord = { id: 'building-1', geometry: polygon() };
        const browserWindow = {
            parks: [],
            squares: [],
            lakes: [],
            transitStations: [],
            [collectionName]: [feature],
            ensureCorridorBuildingFootprintsLoaded: vi.fn(async () => true),
            demolishBuildingsUnderFootprint: vi.fn(async () => [expectedRecord])
        };
        const proposalStore = {
            proposals: new Map([[proposal.proposalId, proposal]]),
            getAllProposals: () => [proposal],
            _indexProposal: vi.fn(),
            save: vi.fn()
        };
        installSharedGlobals(browserWindow, proposalStore);

        const stateSeenByRefresh = [];
        installGlobal(updateName, vi.fn(() => stateSeenByRefresh.push(isApplied(proposal, proposal.structureProposal))));

        const result = await _applyStructureProposal.call({}, proposal.proposalId, proposal);

        expect(result).toBe(true);
        expect(browserWindow.ensureCorridorBuildingFootprintsLoaded).toHaveBeenCalledOnce();
        expect(browserWindow.demolishBuildingsUnderFootprint).toHaveBeenCalledWith(proposal.structureProposal.geometry);
        expect(proposal.structureProposal.demolishedBuildings).toEqual([expectedRecord]);
        expect(stateSeenByRefresh).toEqual([true]);
        expect(proposalStore.save).toHaveBeenCalled();
    });

    it('repairs from canonical geometry when a legacy structure has no nested geometry', async () => {
        const proposal = structureProposal(kind, true);
        const canonicalGeometry = polygon();
        proposal.structureProposal.geometry = null;
        proposal.structureProposal.demolishedBuildings = [];
        proposal.structureProposal.demolitionScanned = true;
        const feature = {
            type: 'Feature',
            properties: { proposalId: proposal.proposalId },
            geometry: canonicalGeometry
        };
        const expectedRecord = { id: 'building-1', geometry: polygon() };
        const browserWindow = {
            parks: [],
            squares: [],
            lakes: [],
            transitStations: [],
            [collectionName]: [feature],
            ensureCorridorBuildingFootprintsLoaded: vi.fn(async () => true),
            demolishBuildingsUnderFootprint: vi.fn(async () => [expectedRecord])
        };
        const proposalStore = {
            proposals: new Map([[proposal.proposalId, proposal]]),
            getAllProposals: () => [proposal],
            _indexProposal: vi.fn(),
            save: vi.fn()
        };
        installSharedGlobals(browserWindow, proposalStore);
        installGlobal(updateName, vi.fn());

        const manager = { _getCanonicalStructureGeometry: vi.fn(() => canonicalGeometry) };
        const result = await _applyStructureProposal.call(manager, proposal.proposalId, proposal);

        expect(result).toBe(true);
        expect(browserWindow.demolishBuildingsUnderFootprint).toHaveBeenCalledWith(canonicalGeometry);
        expect(proposal.structureProposal.geometry).toEqual(canonicalGeometry);
        expect(proposal.structureProposal.demolishedBuildings).toEqual([expectedRecord]);
    });
});
