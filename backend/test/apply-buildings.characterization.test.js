// Characterization test for _applyBuildingProposal — the FIRST node-runnable coverage of a
// ProposalManager apply path. The method is pure I/O orchestration (no return value worth much on its
// own), so we assert its OBSERVABLE EFFECTS on its collaborators: it renders the building feature,
// flips the applied flags, persists, and links ancestors. Collaborators are stubbed as spies; deleting
// the method's save/link/render tail (or its applied=true writes) makes these assertions fail — i.e.
// this is a test that can actually go red. It is the safety net for extracting the shared apply tail.
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

// A ProposalManager-shaped `this` whose collaborators are spies. The building path overlays parents,
// so parent availability resolves (no defer) and no other building conflicts.
function makeManager(overrides = {}) {
    return {
        _resolveParcelFeaturesByIds: () => [],
        _resolveParentAvailabilityOrDefer: async () => ({ defer: false }),
        _isBuildingProposal: () => false,
        _getBuildingAncestorKey: () => null,
        _setDescendantProposalOnParcels: spy(),
        _linkProposalToAncestors: spy(),
        ...overrides
    };
}

function buildingProposalData() {
    return {
        proposalId: 'p-b1',
        goal: 'buildings',
        title: 'Test building',
        parentParcelIds: ['HR-1', 'HR-2'],
        buildingProposal: { parentParcelIds: ['HR-1', 'HR-2'] },
        geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[15.97, 45.81], [15.98, 45.81], [15.98, 45.82], [15.97, 45.81]]] } }] }
    };
}

describe('_applyBuildingProposal (characterization)', () => {
    it('applies: renders the building, flips applied flags, persists, links ancestors', async () => {
        const mgr = makeManager();
        const data = buildingProposalData();

        const result = await _applyBuildingProposal.call(mgr, 'p-b1', data, {});

        expect(result).toBe(true);
        // Applied flags on both axes-carriers.
        expect(data.applied).toBe(true);
        expect(data.buildingProposal.applied).toBe(true);
        expect(data.buildingProposal.appliedAt).toBeTruthy();
        // Rendered the feature with the applied state + proposal id stamped on.
        expect(globalThis.upsertProposedBuildingFeature.calls.length).toBe(1);
        const rendered = globalThis.upsertProposedBuildingFeature.calls[0][0];
        expect(rendered.properties.proposalId).toBe('p-b1');
        expect(rendered.properties.proposalState).toBe('applied');
        // Persisted and linked to the (deduped) ancestors.
        expect(store.saved).toBeGreaterThan(0);
        expect(mgr._linkProposalToAncestors.calls[0]).toEqual(['p-b1', ['HR-1', 'HR-2']]);
        expect(mgr._setDescendantProposalOnParcels.calls[0]).toEqual([['HR-1', 'HR-2'], 'p-b1']);
    });

    it('marks proposalState "executed" when the lifecycle is Executed', async () => {
        const data = buildingProposalData();
        data.lifecycleStatus = 'Executed';
        await _applyBuildingProposal.call(makeManager(), 'p-b1', data, {});
        expect(globalThis.upsertProposedBuildingFeature.calls[0][0].properties.proposalState).toBe('executed');
    });

    it('refuses (no persist) when there are no ancestor parcels', async () => {
        const data = buildingProposalData();
        data.parentParcelIds = [];
        data.buildingProposal.parentParcelIds = [];
        const result = await _applyBuildingProposal.call(makeManager(), 'p-b1', data, {});
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

    it('defers (returns false) when parent availability says defer', async () => {
        const mgr = makeManager({ _resolveParentAvailabilityOrDefer: async () => ({ defer: true }) });
        const result = await _applyBuildingProposal.call(mgr, 'p-b1', buildingProposalData(), {});
        expect(result).toBe(false);
        expect(store.saved).toBe(0);
    });

    it('waits for a conflicting building to be fully unapplied before rendering', async () => {
        let finishUnapply;
        const conflict = {
            proposalId: 'p-old',
            applied: true,
            buildingProposal: { parentParcelIds: ['HR-1', 'HR-2'] }
        };
        globalThis.proposalStorage.getAllProposals = () => [conflict];
        const unapplyWholeFamily = spy(() => new Promise(resolve => { finishUnapply = resolve; }));
        const mgr = makeManager({
            _isBuildingProposal: () => true,
            _getBuildingAncestorKey: () => 'HR-1|HR-2',
            unapplyWholeFamily
        });

        const applying = _applyBuildingProposal.call(mgr, 'p-b1', buildingProposalData(), {});
        await Promise.resolve();
        await Promise.resolve();

        expect(unapplyWholeFamily.calls.length).toBe(1);
        expect(globalThis.upsertProposedBuildingFeature.calls.length).toBe(0);

        finishUnapply(true);
        expect(await applying).toBe(true);
        expect(globalThis.upsertProposedBuildingFeature.calls.length).toBe(1);
    });

    it('returns false on null proposalData without throwing', async () => {
        expect(await _applyBuildingProposal.call(makeManager(), 'p-b1', null, {})).toBe(false);
    });
});
