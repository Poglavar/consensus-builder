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
        _parkProposedBuildingsUnder: async () => {},
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

// The scan region is the ground the proposal takes (demolition-prefetch.js buildingDemolitionGeometry).
describe('_applyBuildingProposal demolition ground', () => {
    const square = (x, y, side = 0.0001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + side, y], [x + side, y + side], [x, y + side], [x, y]]] });
    const parcels = [
        { type: 'Feature', properties: { parcelId: 'HR-1' }, geometry: square(15.96, 45.80, 0.02) },
        { type: 'Feature', properties: { parcelId: 'HR-2' }, geometry: square(15.98, 45.80, 0.02) }
    ];
    // The land is what the apply path registers with the demolition index (demolition-index.js).
    const capture = () => {
        const regions = [];
        (typeof window !== 'undefined' ? window : globalThis).DemolitionIndex = { registerRegion: (_id, geometry) => regions.push(geometry) };
        const mgr = makeManager({
            _resolveLiveFormationParents: () => ({ ok: true, ids: ['HR-1', 'HR-2'], cadastreIds: ['HR-1', 'HR-2'], features: parcels })
        });
        return { mgr, regions };
    };

    it('a block scans the parcels it stands on plus its footprints, so courtyard buildings go too', async () => {
        const { mgr, regions } = capture();
        const data = buildingProposalData();
        data.buildingProposal = { typologyType: 'block' };
        data.geometry.buildings.push(JSON.parse(JSON.stringify(data.geometry.buildings[0])));
        expect(await _applyBuildingProposal.call(mgr, 'p-b1', data, mutationOptions())).toBe(true);
        expect(regions).toHaveLength(1);
        expect(regions[0].type).toBe('MultiPolygon');
        expect(regions[0].coordinates).toHaveLength(4);
        expect(regions[0].coordinates[0]).toEqual(parcels[0].geometry.coordinates);
        expect(regions[0].coordinates[1]).toEqual(parcels[1].geometry.coordinates);
        expect(regions[0].coordinates[2]).toEqual(data.geometry.buildings[0].geometry.coordinates);
    });

    it('a rule that raises the existing buildings scans only its footprints', async () => {
        const { mgr, regions } = capture();
        const data = buildingProposalData();
        data.buildingProposal = { typologyType: 'block', parameters: { mode: 'existing', rule: 'additional' } };
        data.geometry.buildings.push(JSON.parse(JSON.stringify(data.geometry.buildings[0])));
        expect(await _applyBuildingProposal.call(mgr, 'p-b1', data, mutationOptions())).toBe(true);
        expect(regions[0].coordinates).toHaveLength(2);
    });

    it('a Freeform building that forms its own parcel scans its footprint alone', async () => {
        const { mgr, regions } = capture();
        const data = { ...buildingProposalData(), goal: 'single' };
        // Formation itself is not under test here (no _formBuildingParcel stub); the scan precedes it.
        await _applyBuildingProposal.call(mgr, 'p-s1', data, mutationOptions()).catch(() => null);
        expect(regions).toHaveLength(1);
        expect(regions[0]).toEqual(data.geometry.buildings[0].geometry);
    });
});

// Existing buildings are derived from the registered land, never stored on the design; applied
// proposed buildings under it are parked inside the apply (docs/source-loading-plan.md F4).
describe('_applyBuildingProposal demolitions', () => {
    it('registers its land with the index, parks proposed buildings under it and stores no records', async () => {
        const registered = [];
        const root = typeof window !== 'undefined' ? window : globalThis;
        root.DemolitionIndex = { registerRegion: (id, geometry) => registered.push([id, geometry.type]) };
        const parked = [];
        const mgr = makeManager({ _parkProposedBuildingsUnder: async (geometry, options) => { parked.push([geometry.type, options.proposalId]); } });
        const data = buildingProposalData();
        data.buildingProposal = { typologyType: 'block' };
        expect(await _applyBuildingProposal.call(mgr, 'p-b1', data, mutationOptions())).toBe(true);
        expect(registered).toEqual([['p-b1', 'Polygon']]);
        expect(parked).toEqual([['Polygon', 'p-b1']]);
        expect(data.buildingProposal).not.toHaveProperty('demolishedBuildings');
        expect(store.indexed[0]).toBe(data);
        delete root.DemolitionIndex;
    });
});
