// Characterization test for _applyBuildingProposal — the FIRST node-runnable coverage of a
// ProposalManager apply path. It resolves parents from current geometry, derives demolition data,
// renders authored building content and persists one flat applied record.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _applyBuildingProposal } = require('../../frontend/js/proposals/apply/buildings.js');
const { isApplied, getLifecycleStatus } = require('../../frontend/js/proposals/status.js');
const { persistAppliedProposal, refreshProposalUIAfterApply } = require('../../frontend/js/proposals/apply/finalize.js');

// Globals the method reaches for (browser globals in prod; installed here for the duration of a test).
const GLOBAL_KEYS = [
    '_normalizeProposalId', 'appliedOf', 'lifecycleOf', 'proposalStorage', 'updateStatus',
    'upsertProposedBuildingFeature', 'updateProposedBuildingsLayer', 'saveExecutedBuildingsToStorage',
    'updateShowProposalsButton', 'updateProposalList', 'refreshParcelStylesForAppliedProposals', 'document',
    'persistAppliedProposal', 'refreshProposalUIAfterApply'
];
const saved = {};

function spy(retval) {
    const fn = (...args) => { fn.calls.push(args); return typeof retval === 'function' ? retval(...args) : retval; };
    fn.calls = [];
    return fn;
}

let store;

beforeEach(() => {
    GLOBAL_KEYS.forEach(k => { saved[k] = globalThis[k]; });
    store = { saved: 0, indexed: [] };
    globalThis._normalizeProposalId = (v) => (v == null ? '' : String(v));
    globalThis.appliedOf = isApplied;
    globalThis.lifecycleOf = getLifecycleStatus;
    globalThis.proposalStorage = {
        getAllProposals: () => [],
        _indexProposal: (p) => { store.indexed.push(p); },
        save: () => { store.saved++; },
        proposals: new Map()
    };
    globalThis.updateStatus = spy();
    globalThis.upsertProposedBuildingFeature = spy();
    globalThis.updateProposedBuildingsLayer = spy();
    globalThis.saveExecutedBuildingsToStorage = spy();
    globalThis.updateShowProposalsButton = spy();
    globalThis.updateProposalList = spy();
    globalThis.refreshParcelStylesForAppliedProposals = spy();
    globalThis.document = { getElementById: () => null };
    globalThis.persistAppliedProposal = persistAppliedProposal;
    globalThis.refreshProposalUIAfterApply = refreshProposalUIAfterApply;
});

afterEach(() => {
    GLOBAL_KEYS.forEach(k => {
        if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
    });
});

// A ProposalManager-shaped `this` whose collaborators are spies.
function makeManager(overrides = {}) {
    return {
        _resolveLiveFormationParents: () => ({
            ok: true,
            ids: ['HR-1', 'HR-2'],
            cadastreIds: ['HR-1', 'HR-2'],
            features: []
        }),
        _deriveDemolishedBuildings: async () => [],
        ...overrides
    };
}

function buildingProposalData() {
    return {
        proposalId: 'p-b1',
        goal: 'buildings',
        title: 'Test building',
        cadastreParcelIds: ['HR-1', 'HR-2'],
        buildingProposal: {},
        geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[15.97, 45.81], [15.98, 45.81], [15.98, 45.82], [15.97, 45.81]]] } }] }
    };
}

function mutationOptions(extra = {}) {
    return {
        ...extra,
        _parcelMutation: {
            proposals: globalThis.proposalStorage,
            collections: { proposedBuildings: [] },
            afterCommit: callback => callback()
        }
    };
}

describe('_applyBuildingProposal (characterization)', () => {
    it('applies: renders the building, flips applied flags and persists one flat record', async () => {
        const mgr = makeManager();
        const data = buildingProposalData();

        const options = mutationOptions();
        const result = await _applyBuildingProposal.call(mgr, 'p-b1', data, options);

        expect(result).toBe(true);
        // Map visibility has one authoritative root carrier.
        expect(data.applied).toBe(true);
        expect(data.appliedAt).toBeTruthy();
        expect(data.buildingProposal.applied).toBeUndefined();
        expect(data.buildingProposal.appliedAt).toBeUndefined();
        // Rendered the feature with the applied state + proposal id stamped on.
        expect(globalThis.upsertProposedBuildingFeature.calls.length).toBe(0);
        const rendered = options._parcelMutation.collections.proposedBuildings[0];
        expect(rendered.properties.proposalId).toBe('p-b1');
        expect(rendered.properties.proposalState).toBe('applied');
        // Persisted with flat cadastral anchors; no ancestry graph is written.
        expect(store.saved).toBeGreaterThan(0);
        expect(data.cadastreParcelIds).toEqual(['HR-1', 'HR-2']);
        expect(data).not.toHaveProperty('parentParcelIds');
        expect(data.buildingProposal).not.toHaveProperty('parentParcelIds');
    });

    it('marks proposalState "executed" when the lifecycle is Executed', async () => {
        const data = buildingProposalData();
        data.lifecycleStatus = 'Executed';
        const options = mutationOptions();
        await _applyBuildingProposal.call(makeManager(), 'p-b1', data, options);
        expect(options._parcelMutation.collections.proposedBuildings[0].properties.proposalState).toBe('executed');
    });

    it('keeps authored block membership when its massing touches fewer parcels', async () => {
        const data = buildingProposalData();
        data.typologyType = 'block';
        data.cadastreParcelIds = ['HR-1', 'HR-2', 'HR-EDGE'];
        data.buildingProposal = {
            typologyType: 'block',
            ineligibleParcels: [{ status: 'below-min-plot' }]
        };

        const result = await _applyBuildingProposal.call(makeManager(), 'p-b1', data, mutationOptions());

        expect(result).toBe(true);
        // Applying may resolve fewer current live pieces than the authored block contains. It may
        // not rewrite the durable cadastral declaration to match today's materialization.
        expect(data.cadastreParcelIds).toEqual(['HR-1', 'HR-2', 'HR-EDGE']);
        expect(data).not.toHaveProperty('parentParcelIds');
        expect(data.buildingProposal).not.toHaveProperty('parentParcelIds');
        expect(data.buildingProposal).not.toHaveProperty('blockParcelIds');
    });

    it('updates canonical state but performs no presentation work when a plan defers it', async () => {
        const data = buildingProposalData();

        const options = mutationOptions({
            deferPresentation: true,
            preloadedBuildings: []
        });
        const result = await _applyBuildingProposal.call(makeManager(), 'p-b1', data, options);

        expect(result).toBe(true);
        expect(options._parcelMutation.collections.proposedBuildings).toHaveLength(1);
        expect(store.saved).toBeGreaterThan(0);
        expect(globalThis.updateProposedBuildingsLayer.calls).toHaveLength(0);
        expect(globalThis.updateShowProposalsButton.calls).toHaveLength(0);
        expect(globalThis.updateProposalList.calls).toHaveLength(0);
        expect(globalThis.refreshParcelStylesForAppliedProposals.calls).toHaveLength(0);
    });

    it('refuses (no persist) when there are no ancestor parcels', async () => {
        const data = buildingProposalData();
        const result = await _applyBuildingProposal.call(makeManager({
            _resolveLiveFormationParents: () => ({ ok: false, ids: [], features: [] })
        }), 'p-b1', data, {});
        expect(result).toBe(false);
        expect(store.saved).toBe(0);
        expect(globalThis.upsertProposedBuildingFeature.calls.length).toBe(0);
    });

    it('refuses (no persist) when the building geometry is missing', async () => {
        const data = buildingProposalData();
        data.geometry.buildings = [];
        const result = await _applyBuildingProposal.call(makeManager(), 'p-b1', data, {});
        expect(result).toBe(false);
        expect(store.saved).toBe(0);
    });

    it('returns false on null proposalData without throwing', async () => {
        expect(await _applyBuildingProposal.call(makeManager(), 'p-b1', null, {})).toBe(false);
    });
});
