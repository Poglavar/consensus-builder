// Characterizes the model-before-view contract for applying and unapplying park/square/lake/station
// proposals: every layer refresh must observe the proposal's canonical application state.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _applyStructureProposal, _formStructureParcel } = require('../../frontend/js/proposals/apply/structures.js');
const { _unapplyStructureProposalConfirmed, _reverseFormationRecord } = require('../../frontend/js/proposals/apply/unapply.js');
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
    // The §15a structure formation runs inside apply for park/square/lake: give the fake window
    // the real formation-edit module and real turf, so the ADOPT path (footprint matches the one
    // candidate parcel exactly) exercises end to end instead of refusing.
    browserWindow.__formationEdit = require('../../frontend/js/proposals/formation-edit.js');
    browserWindow.__cadastreAncestry = {
        resolveParentsByGeometry: () => ({ ids: ['parcel-1'], coverage: 1 })
    };
    installGlobal('window', browserWindow);
    installGlobal('turf', require('@turf/turf'));
    installGlobal('_getParcelIdFromFeature', feature => feature?.properties?.parcelId ?? null);
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

// The one live parcel under every test footprint: same polygon, so the take plan ADOPTS it.
function candidateParcelFeature() {
    return {
        type: 'Feature',
        properties: {
            parcelId: 'parcel-1',
            ownershipDetails: { owners: [{ name: 'Original Owner', percentageShare: 100 }] },
            ownershipType: 'private'
        },
        geometry: polygon()
    };
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

        const adoptedParcel = candidateParcelFeature();
        const manager = {
            _getCanonicalStructureGeometry: () => proposal.structureProposal.geometry,
            _resolveParcelFeaturesByIds: vi.fn(() => [adoptedParcel]),
            _resolveParentAvailabilityOrDefer: vi.fn(async () => ({ defer: false })),
            _setDescendantProposalOnParcels: vi.fn(),
            _linkProposalToAncestors: vi.fn(),
            _unmarkParcelModified: vi.fn(),
            _setLastApplyFailure: vi.fn(),
            _persistParcelFeature: vi.fn(),
            _formStructureParcel
        };

        const result = await _applyStructureProposal.call(manager, proposal.proposalId, proposal);

        expect(result).toBe(true);
        if (kind !== 'station') {
            // §15a: the structure ADOPTED the matching parcel — ownership → City, snapshot kept.
            expect(adoptedParcel.properties.ownershipType).toBe('city');
            expect(proposal.structureProposal.formation).toMatchObject({ mode: 'adopt', parcelIds: ['parcel-1'] });
            expect(proposal.structureProposal.formation.prior[0].ownershipDetails.owners[0].name).toBe('Original Owner');
            expect(proposal.parentParcelIds).toEqual(['parcel-1']);
        } else {
            // A station forms nothing — it stays content on its corridor.
            expect(proposal.structureProposal.formation).toBeUndefined();
        }
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
            _unmarkParcelModified: vi.fn(),
            _persistParcelFeature: vi.fn(),
            _reverseFormationRecord
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

describe('_formStructureParcel — merge-take and refusal (§15a)', () => {
    const LON = 15.96, LAT = 45.80;
    const rect = (dx0, dy0, dx1, dy1) => ({
        type: 'Polygon',
        coordinates: [[
            [LON + dx0 * 1e-3, LAT + dy0 * 1e-3], [LON + dx1 * 1e-3, LAT + dy0 * 1e-3],
            [LON + dx1 * 1e-3, LAT + dy1 * 1e-3], [LON + dx0 * 1e-3, LAT + dy1 * 1e-3],
            [LON + dx0 * 1e-3, LAT + dy0 * 1e-3]
        ]]
    });
    const parcelOf = (id, dx0, dx1) => ({
        type: 'Feature',
        properties: { parcelId: id, rootParcelId: id, ownershipDetails: { owners: [{ name: 'Owner ' + id, percentageShare: 100 }] } },
        geometry: rect(dx0, 0, dx1, 2)
    });

    function makeFormationManager(parcels) {
        return {
            hidden: [],
            added: [],
            _resolveParcelFeaturesByIds: vi.fn(() => parcels),
            _assignSyntheticChildIdentities: vi.fn((pid, features) => {
                features.forEach((f, i) => { f.properties.parcelId = `HR-A#${pid}-${i + 1}`; });
            }),
            _addFeaturesToMap(features) { this.added.push(...features); },
            _hideFeaturesFromMap(features) { this.hidden.push(...features); },
            _persistParcelFeature: vi.fn(),
            _addProposalAsAncestor: vi.fn(),
            _addChildParcels: vi.fn(),
            _setLastApplyFailure: vi.fn(),
            _formStructureParcel
        };
    }

    function installFormationGlobals(parcelIds) {
        installSharedGlobals({
            __formationEdit: require('../../frontend/js/proposals/formation-edit.js'),
            __cadastreAncestry: { resolveParentsByGeometry: () => ({ ids: parcelIds, coverage: 1 }) }
        }, { proposals: new Map(), _indexProposal: vi.fn(), save: vi.fn() });
        installGlobal('_resolveRootParcelIdFromProperties', props => props?.rootParcelId || null);
        installGlobal('_resolveRootParcelNumberFromProperties', () => null);
        installGlobal('_calculateGeoJsonArea', geometry => {
            try { return require('@turf/turf').area({ type: 'Feature', properties: {}, geometry }); } catch (_) { return 0; }
        });
    }

    it('merge-takes a union of whole parcels into ONE minted city parcel with flat anchors', async () => {
        const parcels = [parcelOf('HR-A', 0, 2), parcelOf('HR-B', 2, 4)];
        installFormationGlobals(['HR-A', 'HR-B']);
        const manager = makeFormationManager(parcels);
        const proposalData = { parentParcelIds: [] };
        const sp = { kind: 'park' };

        const result = await manager._formStructureParcel('p-park', proposalData, sp, rect(0, 0, 4, 2), [], 'p-park');

        expect(result.ok).toBe(true);
        expect(result.parentIds).toEqual(['HR-A', 'HR-B']);
        expect(sp.formation.mode).toBe('merge');
        expect(manager.added).toHaveLength(1);
        const minted = manager.added[0];
        expect(minted.properties.parcelId).toBe('HR-A#p-park-1');
        expect(minted.properties.baseParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(minted.properties.ownershipType).toBe('city');
        expect(manager.hidden.map(f => f.properties.parcelId)).toEqual(['HR-A', 'HR-B']);
        expect(sp.childParcelIds).toEqual(['HR-A#p-park-1']);
    });

    it('refuses a footprint that covers only part of a parcel, naming the offender', async () => {
        const parcels = [parcelOf('HR-A', 0, 2), parcelOf('HR-B', 2, 4)];
        installFormationGlobals(['HR-A', 'HR-B']);
        const manager = makeFormationManager(parcels);
        const sp = { kind: 'square' };

        const result = await manager._formStructureParcel('p-square', { parentParcelIds: [] }, sp, rect(0, 0, 3, 2), [], 'p-square');

        expect(result.ok).toBe(false);
        expect(sp.formation).toBeUndefined();
        expect(manager.added).toHaveLength(0);
        const failure = manager._setLastApplyFailure.mock.calls[0][1];
        expect(failure.code).toBe('structure-partial-parcels');
        expect(failure.message).toContain('HR-B');
        expect(failure.message).toContain('road or a land readjustment');
    });
});
