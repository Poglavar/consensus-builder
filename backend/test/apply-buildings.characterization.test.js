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
    it('uses the same strict parent resolution for rule buildings and a Freeform building', async () => {
        const seen = [];
        const mgr = makeManager({
            _resolveLiveFormationParents: (_data, _label, formationLabel, options) => {
                seen.push({ formationLabel, contentOnly: options && options.contentOnly });
                return { ok: true, ids: ['HR-1', 'HR-2'], cadastreIds: ['HR-1', 'HR-2'], features: [] };
            }
        });
        // A rule can supply several building volumes on existing parcels.
        const plan = buildingProposalData();
        plan.geometry.buildings.push(JSON.parse(JSON.stringify(plan.geometry.buildings[0])));
        expect(await _applyBuildingProposal.call(mgr, 'p-b1', plan, mutationOptions())).toBe(true);
        // A Freeform building forms its own parcel, with the same source-overlap proof.
        const single = { ...buildingProposalData(), proposalId: 'p-s1', goal: 'single' };
        await _applyBuildingProposal.call(mgr, 'p-s1', single, mutationOptions()).catch(() => null);
        expect(seen[0]).toEqual({ formationLabel: 'building', contentOnly: undefined });
        expect(seen[1]).toEqual({ formationLabel: 'building', contentOnly: undefined });
    });

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

// The demolition scan must land on the record the carve reads from storage. A shallow copy of
// buildingProposal once swallowed it, so no building proposal ever demolished anything (2026-10-22).
describe('_applyBuildingProposal demolition records', () => {
    const { demolishedBuildingRecordsFrom } = require('../../frontend/js/corridor-carve.js');
    const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.0001, y], [x + 0.0001, y + 0.0001], [x, y + 0.0001], [x, y]]] });
    const records = () => [
        { id: '62761', geometry: square(15.971, 45.811), demolishedPart: square(15.971, 45.811), remainder: square(15.9712, 45.811) },
        { id: '62722', geometry: square(15.972, 45.812) }
    ];

    it('stores the scan on the persisted record, scoped to the authored footprints', async () => {
        const scans = [];
        const mgr = makeManager({ _deriveDemolishedBuildings: async (geometry, options) => { scans.push({ type: geometry.type, proposalId: options.proposalId }); return records(); } });
        const data = buildingProposalData();
        data.buildingProposal = { typologyType: 'block', demolishedBuildings: [{ id: 'stale', geometry: square(0, 0) }], demolitionScanned: true };
        expect(await _applyBuildingProposal.call(mgr, 'p-b1', data, mutationOptions())).toBe(true);
        expect(scans).toEqual([{ type: 'Polygon', proposalId: 'p-b1' }]);
        expect(data.buildingProposal.demolishedBuildings).toEqual(records());
        expect(data.buildingProposal).not.toHaveProperty('demolitionScanned');
        expect(data.buildingProposal.typologyType).toBe('block');
        // The object handed to storage IS the record, and the carve collects from it.
        expect(store.indexed[0]).toBe(data);
        expect(demolishedBuildingRecordsFrom([data]).map(record => record.id)).toEqual(['62761', '62722']);
    });

    it('gives a proposal without a sub-record one, so a Freeform demolition has a home', async () => {
        const mgr = makeManager({ _deriveDemolishedBuildings: async () => records().slice(1) });
        const data = buildingProposalData();
        delete data.buildingProposal;
        expect(await _applyBuildingProposal.call(mgr, 'p-b1', data, mutationOptions())).toBe(true);
        expect(data.buildingProposal.demolishedBuildings.map(record => record.id)).toEqual(['62722']);
    });

    it('records an empty scan as empty and a failed scan as failed, on the record', async () => {
        const empty = buildingProposalData();
        empty.buildingProposal = { demolishedBuildings: records() };
        expect(await _applyBuildingProposal.call(makeManager(), 'p-b1', empty, mutationOptions())).toBe(true);
        expect(empty.buildingProposal.demolishedBuildings).toEqual([]);
        expect(demolishedBuildingRecordsFrom([empty])).toEqual([]);

        const failing = buildingProposalData();
        const mgr = makeManager({ _deriveDemolishedBuildings: async () => { throw new Error('backend down'); } });
        const errors = [];
        const originalError = console.error;
        console.error = (...args) => errors.push(args[0]);
        try { expect(await _applyBuildingProposal.call(mgr, 'p-b1', failing, mutationOptions())).toBe(true); } finally { console.error = originalError; }
        expect(failing.buildingProposal.demolitionScanFailed).toBe(true);
        expect(failing.buildingProposal.demolishedBuildings).toEqual([]);
        expect(errors.some(message => String(message).includes('demolition scan failed'))).toBe(true);
    });
});
