// Every polygon clip in the proposal modules either refuses with a typed ClipFailure (anything
// applied, stored or validated) or, where only a display degrades, reports it into clipHealth().
//
// Each test stubs turf so that one clip throws — "Maximum call stack size exceeded", what turf 6.5's
// polygon-clipping does on long chains — and asserts what happens to the failure. Before this, each
// of these sites caught it and substituted a plausible wrong answer: zero overlap, the operand
// unchanged, null, "keep what we have".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const A = require('../../frontend/js/proposals/parcel-arrangement.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const gain = require('../../frontend/js/proposals/gain.js');
const subdivision = require('../../frontend/js/proposals/subdivision.js');
const contributions = require('../../frontend/js/proposals/readjustment-contributions.js');
const siteBinding = require('../../frontend/js/proposals/site-binding.js');
const siteClip = require('../../frontend/js/proposals/site-clip.js');
const siteDraft = require('../../frontend/js/proposals/site-draft.js');
const sitePlots = require('../../frontend/js/proposals/site-plots.js');
const plotCrossings = require('../../frontend/js/proposals/plot-crossings.js');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const openGround = require('../../frontend/js/proposals/open-ground.js');
const roadApply = require('../../frontend/js/proposals/apply/road.js');
const structuresApply = require('../../frontend/js/proposals/apply/structures.js');
const buildingsApply = require('../../frontend/js/proposals/apply/buildings.js');
const parcelsApply = require('../../frontend/js/proposals/apply/parcels.js');
const { prepareParcelSelection } = require('../../frontend/js/proposal-editor-adapters.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
require('../../frontend/js/proposal-parcel-identity.js'); // installs _getParcelIdFromFeature etc.

const STACK = 'Maximum call stack size exceeded';

// turf with the named operations replaced; `fails(operation, callNumber, args)` picks the throw.
function failingTurf(operations, fails = () => true) {
    const calls = {};
    return new Proxy(turf, {
        get(target, prop) {
            if (!operations.includes(prop)) return target[prop];
            return (...args) => {
                calls[prop] = (calls[prop] || 0) + 1;
                if (fails(prop, calls[prop], args)) throw new RangeError(STACK);
                return target[prop](...args);
            };
        }
    });
}

const GLOBALS = ['window', 'turf', '_normalizeProposalId', 'updateStatus', 'showEphemeralMessage',
    '_resolveRootParcelIdFromProperties', '_resolveRootParcelNumberFromProperties', '_calculateGeoJsonArea',
    'persistAppliedProposal', 'refreshProposalUIAfterApply', 'proposalStorage', 'isProposalCurrentlyApplied',
    '__planOrder', '__parcelArrangement', 'LiveParcelFabric', 'CadastralParcelRepository', 'ParcelPresenter'];
const saved = {};
beforeEach(() => {
    GLOBALS.forEach(name => {
        saved[name] = { has: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] };
    });
    globalThis.turf = turf;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    GLOBALS.forEach(name => {
        if (saved[name].has) globalThis[name] = saved[name].value;
        else delete globalThis[name];
    });
    vi.restoreAllMocks();
});

const siteCount = site => A.clipHealth().bySite[site] || 0;

// True when the clip was called directly from `file` (the readjustment validator runs its own
// clips first, and those must work for the apply to reach the sites under test).
const calledFrom = file => () => {
    const frames = String(new Error().stack).split('\n').slice(1);
    const caller = frames.find(line => !/clip-failure-proposals\.test\.js/.test(line));
    return !!caller && caller.includes(file);
};

// Fails the call with a ClipFailure from `site`, and counts it there once.
function expectClipFailure(run, site) {
    const before = siteCount(site);
    let thrown = null;
    try { run(); } catch (error) { thrown = error; }
    expect(thrown, `${site} did not throw`).toBeInstanceOf(A.ClipFailure);
    expect(thrown.site).toBe(site);
    expect(thrown.originalMessage).toBe(STACK);
    expect(siteCount(site)).toBe(before + 1);
    return thrown;
}

async function expectClipRejection(promise, site) {
    let thrown = null;
    try { await promise; } catch (error) { thrown = error; }
    expect(thrown, `${site} did not reject`).toBeInstanceOf(A.ClipFailure);
    expect(thrown.site).toBe(site);
    expect(thrown.originalMessage).toBe(STACK);
    return thrown;
}

// Reported for a display: counted at the site, marked degraded, and the caller carries on.
function expectReported(run, site) {
    const before = siteCount(site);
    const degradedBefore = A.clipHealth().degraded;
    const result = run();
    expect(siteCount(site), `${site} was not reported`).toBe(before + 1);
    expect(A.clipHealth().degraded).toBe(degradedBefore + 1);
    return result;
}

// ~8 m × 11 m units near Zagreb.
const LON = 15.96, LAT = 45.80, U = 1e-4;
const rect = (x0, y0, x1, y1) => ({
    type: 'Polygon',
    coordinates: [[[LON + x0 * U, LAT + y0 * U], [LON + x1 * U, LAT + y0 * U], [LON + x1 * U, LAT + y1 * U],
        [LON + x0 * U, LAT + y1 * U], [LON + x0 * U, LAT + y0 * U]]]
});
const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });

describe('plan-order.intersectionArea', () => {
    it('keeps its measured buffer repair for a single throw', () => {
        globalThis.turf = failingTurf(['intersect'], (_op, n) => n === 1);
        const area = planOrder.intersectionArea(feature(rect(0, 0, 10, 10)), feature(rect(5, 0, 15, 10)));
        expect(area).toBeGreaterThan(0);
    });

    it('throws a ClipFailure when the exact clip and every repair throw, instead of answering zero', () => {
        globalThis.turf = failingTurf(['intersect']);
        expectClipFailure(() => planOrder.intersectionArea(feature(rect(0, 0, 10, 10)), feature(rect(5, 0, 15, 10))),
            'plan-order.intersectionArea');
    });
});

describe('gain.computeParcelMetrics (panel figures)', () => {
    const parcel = feature(rect(0, 0, 10, 10));
    const opts = t => ({ floorHeightM: 3, turf: t, footprintOf: b => b.footprint, heightOf: () => 9 });

    it('reports a built-volume clip that fails', () => {
        const t = failingTurf(['intersect']);
        expectReported(() => gain.computeParcelMetrics(parcel,
            [{ z_min: 0, z_max: 9, footprint: feature(rect(1, 1, 3, 3)) }], [], opts(t)), 'gain.builtVolume');
    });

    it('reports a proposed-volume clip that fails', () => {
        const t = failingTurf(['intersect']);
        expectReported(() => gain.computeParcelMetrics(parcel, [], [feature(rect(1, 1, 3, 3))], opts(t)), 'gain.proposedVolume');
    });
});

describe('subdivision', () => {
    const site = rect(0, 0, 10, 10);
    const parcels = [{ id: 'HR-1', geometry: rect(0, 0, 5, 10) }, { id: 'HR-2', geometry: rect(5, 0, 10, 10) }];

    it('sitePool refuses instead of dropping a parcel whose overlap cannot be computed', () => {
        const failure = expectClipFailure(() => subdivision.sitePool(site, parcels, { turf: failingTurf(['intersect']) }),
            'subdivision.sitePool');
        expect(failure.parcelId).toBe('HR-1');
    });

    it('ownerKeyByGround refuses instead of handing the plot to whichever overlap computed', () => {
        const pool = subdivision.sitePool(site, parcels, { turf });
        const shares = [{ ownerKey: 'a', parcelIds: ['HR-1'] }, { ownerKey: 'b', parcelIds: ['HR-2'] }];
        expectClipFailure(() => subdivision.ownerKeyByGround(rect(0, 0, 4, 10), pool, shares, { turf: failingTurf(['intersect']) }),
            'subdivision.ownerKeyByGround');
    });
});

describe('readjustment-contributions', () => {
    it('contributionsByOwner refuses instead of leaving a parcel\'s owners out of the pool', () => {
        globalThis.turf = failingTurf(['intersect']);
        const parent = feature(rect(0, 0, 10, 10), { parcelId: 'HR-1', ownershipDetails: { owners: [{ ownerId: 'o1', percentageShare: 100 }] } });
        const failure = expectClipFailure(() => contributions.contributionsByOwner([parent], rect(0, 0, 5, 10)),
            'readjustment-contributions.contributionsByOwner');
        expect(failure.parcelId).toBe('HR-1');
    });

    it('overlappingPlots refuses instead of passing an unmeasurable pair', () => {
        globalThis.turf = failingTurf(['intersect']);
        expectClipFailure(() => contributions.overlappingPlots([rect(0, 0, 5, 10), rect(4, 0, 10, 10)]),
            'readjustment-contributions.overlappingPlots');
    });
});

describe('site-binding', () => {
    const parcels = [{ id: 'HR-1', geometry: rect(0, 0, 5, 10) }, { id: 'HR-2', geometry: rect(5, 0, 10, 10) }];

    it('siteOf refuses instead of leaving a declared parcel out of the site', () => {
        const record = { goal: 'parcel', cadastreParcelIds: ['HR-1', 'HR-2'] };
        expectClipFailure(() => siteBinding.siteOf(record, { parcels, turf: failingTurf(['union']) }), 'site-binding.unionAll');
    });

    it('bindingFromParcels refuses instead of leaving a parcel the site reaches into unbound', () => {
        const failure = expectClipFailure(() => siteBinding.bindingFromParcels(rect(1, 1, 9, 9), parcels,
            { turf: failingTurf(['intersect']) }), 'site-binding.bindingFromParcels');
        expect(failure.parcelId).toBe('HR-1');
    });

    it('bindingFromParcels refuses instead of overstating the unsurveyed ground', () => {
        expectClipFailure(() => siteBinding.bindingFromParcels(rect(1, 1, 9, 9), parcels,
            { turf: failingTurf(['difference']) }), 'site-binding.unsurveyed');
    });
});

describe('site-clip.exactUnion', () => {
    it('throws the clipper\'s error instead of a bare null', () => {
        expectClipFailure(() => siteClip.exactUnion([rect(0, 0, 5, 10), rect(5, 0, 10, 10)], { turf: failingTurf(['union']) }),
            'site-clip.exactUnion');
    });
});

describe('site-draft', () => {
    it('siteFromFeatures refuses instead of saving a site that lacks a feature', () => {
        expectClipFailure(() => siteDraft.siteFromFeatures([feature(rect(0, 0, 5, 10)), feature(rect(5, 0, 10, 10))],
            { turf: failingTurf(['union']) }), 'site-draft.siteFromFeatures');
    });

    it('openGroundOf (the preview hatch) reports a failed difference and keeps the larger estimate', () => {
        const open = expectReported(() => siteDraft.openGroundOf(rect(0, 0, 10, 10), [{ id: 'HR-1', geometry: rect(0, 0, 5, 10) }],
            { turf: failingTurf(['difference']) }), 'site-draft.openGroundOf');
        expect(open).toBeTruthy();
    });
});

describe('site-plots.cutPlots', () => {
    const MY = 180 / (Math.PI * 6378137), MX = MY / Math.cos(LAT * Math.PI / 180);
    const site = ring => turf.polygon([[...ring, ring[0]].map(([x, y]) => [LON + x * MX, LAT + y * MY])]).geometry;

    it('refuses instead of dropping a strip whose clip throws', () => {
        expectClipFailure(() => sitePlots.cutPlots(site([[0, 0], [100, 0], [100, 40], [0, 40]]),
            { plotWidthM: 20, turf: failingTurf(['intersect']) }), 'site-plots.strip');
    });

    it('refuses instead of making a sliver its own plot when the merge throws', () => {
        // The peninsula hook of site-plots.test.js: one 2 m sliver that must join its neighbour.
        const hooked = site([[0, 0], [60, 0], [60, 30], [58, 30], [58, 50], [38, 50], [38, 45], [42, 45], [42, 30], [0, 30]]);
        expectClipFailure(() => sitePlots.cutPlots(hooked, { frontageEdgeIndex: 0, plotWidthM: 20, turf: failingTurf(['union']) }),
            'site-plots.mergeIntoNeighbour');
    });
});

describe('plot-crossings.detectPlotCrossings', () => {
    it('refuses instead of leaving a crossed plot out of "Build through?"', () => {
        const record = { proposalId: 'sub', reparcellization: { polygons: [] } };
        expectClipFailure(() => plotCrossings.detectPlotCrossings(rect(0, 4, 20, 6), {
            turf: failingTurf(['intersect']),
            pieces: [feature(rect(0, 0, 10, 10), { parcelId: 'sub-1', producedByProposalId: 'sub' })],
            lookupProposal: () => record
        }), 'plot-crossings.overlapM2');
    });
});

describe('formation-edit', () => {
    const ctx = t => ({
        area: f => t.area(f),
        intersectionArea: (a, b) => { const hit = t.intersect(a, b); return hit ? t.area(hit) : 0; },
        difference: (a, b) => t.difference(a, b)
    });

    it('an overlap that cannot be computed refuses instead of reading as zero', () => {
        expectClipFailure(() => formationEdit.clipPiecesByTaking([{ geometry: rect(0, 0, 10, 10) }], rect(5, 0, 15, 10),
            ctx(failingTurf(['intersect']))), 'formation-edit.intersectionArea');
    });

    it('clipPiecesByTaking refuses instead of treating a failed difference as "fully taken"', () => {
        expectClipFailure(() => formationEdit.clipPiecesByTaking([{ geometry: rect(0, 0, 10, 10) }], rect(5, 0, 15, 10),
            ctx(failingTurf(['difference']))), 'formation-edit.clipPiecesByTaking');
    });

    it('severanceVerdict refuses instead of inventing a verdict', () => {
        expectClipFailure(() => formationEdit.severanceVerdict({ polygons: [] }, rect(0, 0, 10, 10), rect(4, -5, 6, 15),
            ctx(failingTurf(['difference']))), 'formation-edit.severanceVerdict');
    });
});

describe('open-ground.openGroundGeometry', () => {
    it('keeps its typed refusal, now carrying and counting the ClipFailure', () => {
        const before = siteCount('open-ground.openGroundGeometry');
        let thrown = null;
        try {
            openGround.openGroundGeometry(rect(0, 0, 10, 10), [{ id: 'HR-1', geometry: rect(0, 0, 5, 10) }],
                { turf: failingTurf(['difference']) });
        } catch (error) { thrown = error; }
        expect(thrown.code).toBe('open-ground-derivation-failed');
        expect(thrown.message).toContain(STACK);
        expect(thrown.cause).toBeInstanceOf(A.ClipFailure);
        expect(thrown.cause.parcelId).toBe('HR-1');
        expect(siteCount('open-ground.openGroundGeometry')).toBe(before + 1);
    });
});

describe('apply/road.js', () => {
    const roadRecord = { proposalId: 'road-1', applied: true, roadProposal: { definition: {} } };
    const self = claimGeometry => ({ ...roadApply, _takingFootprintOf: () => claimGeometry });

    it('_groundAfterLaterCorridors refuses instead of leaving a later corridor inside the formation', () => {
        globalThis.window = globalThis;
        globalThis.__planOrder = { compareFormationOrder: () => 1, footprintOf: () => null };
        globalThis.isProposalCurrentlyApplied = record => !!record.applied;
        globalThis.turf = failingTurf(['intersect']);
        const store = { getAllProposals: () => [roadRecord] };
        const failure = expectClipFailure(() => self(rect(0, 4, 20, 6))._groundAfterLaterCorridors(
            { proposalId: 'park-1' }, [rect(0, 0, 10, 10)], { _parcelMutation: { proposals: store } }),
        'apply-road.groundAfterLaterCorridors');
        expect(failure).toMatchObject({ proposalId: 'park-1', takeId: 'road-1' });
    });

    it('_appliedRoadOverlappedByTaking refuses instead of letting a take stand on a road unchecked', () => {
        globalThis.isProposalCurrentlyApplied = record => !!record.applied;
        globalThis.turf = failingTurf(['intersect']);
        const store = { getAllProposals: () => [roadRecord] };
        const failure = expectClipFailure(() => self(rect(0, 4, 20, 6))._appliedRoadOverlappedByTaking(
            rect(0, 0, 10, 10), 'park-1', { _parcelMutation: { proposals: store } }), 'apply-road.appliedRoadOverlappedByTaking');
        expect(failure).toMatchObject({ proposalId: 'park-1', takeId: 'road-1' });
    });
});

// The ProposalManager mixins, called with a stand-in `this` (as form-building-parcel.test.js does).
function installApplyGlobals() {
    globalThis.window = { __formationEdit: formationEdit };
    globalThis._normalizeProposalId = value => (value == null ? '' : String(value));
    globalThis.updateStatus = vi.fn();
    globalThis.showEphemeralMessage = vi.fn();
    globalThis._resolveRootParcelIdFromProperties = props => (props && props.rootParcelId) || null;
    globalThis._resolveRootParcelNumberFromProperties = props => (props && props.rootParcelNumber) || null;
    globalThis._calculateGeoJsonArea = geometry => turf.area(feature(geometry));
    globalThis.persistAppliedProposal = vi.fn();
    globalThis.refreshProposalUIAfterApply = vi.fn();
}
const parcelFeature = (id, geometry, extra = {}) => feature(geometry, {
    parcelId: id, cadastreParcelIds: [id], rootParcelId: id, BROJ_CESTICE: id,
    ownershipDetails: { owners: [{ name: `Owner ${id}`, percentageShare: 100 }] }, ...extra
});
function mixinThis(methods, parcels) {
    return {
        hidden: [],
        added: [],
        _resolveParcelFeaturesByIds: vi.fn(() => parcels),
        _assignSyntheticChildIdentities(...args) { return ProposalManager._assignSyntheticChildIdentities(...args); },
        _addFeaturesToMap(features) { this.added.push(...features); },
        _consumeFeaturesFromLiveFabric(features) { this.hidden.push(...(features || [])); },
        _markParcelProducedByProposal: vi.fn(),
        _setDescendantProposalOnParcels: vi.fn(),
        _linkProposalToAncestors: vi.fn(),
        _markParcelsModifiedBatch: vi.fn(),
        _addChildParcels: vi.fn(),
        _adoptForeignPlotPieces: vi.fn(),
        _setLastApplyFailure: vi.fn(),
        _appliedRoadOverlappedByTaking: vi.fn(() => null),
        ...methods
    };
}

describe('apply/structures.js', () => {
    it('structureTakeContext refuses instead of reading an overlap as zero', () => {
        const ctx = structuresApply.structureTakeContext(failingTurf(['intersect']), null);
        expectClipFailure(() => ctx.intersectionArea(feature(rect(0, 0, 10, 10)), feature(rect(5, 0, 15, 10))),
            'apply-structures.intersectionArea');
    });

    it('_formStructureParcel refuses a partial cut naming the parcel, not as a footprint problem', async () => {
        installApplyGlobals();
        const hr1 = parcelFeature('HR-1', rect(0, 0, 20, 10));
        const self = mixinThis({ _formStructureParcel: structuresApply._formStructureParcel }, [hr1]);
        globalThis.turf = failingTurf(['difference']);
        const failure = await expectClipRejection(self._formStructureParcel('sq-1', {}, { kind: 'square' }, rect(5, 0, 15, 10),
            ['HR-1'], 'sq-1', [hr1], {}), 'apply-structures.partialCut');
        expect(failure).toMatchObject({ proposalId: 'sq-1', parcelId: 'HR-1' });
        expect(self.hidden).toHaveLength(0);
    });
});

describe('apply/buildings.js _formBuildingParcel', () => {
    const run = (self, bp, footprint) => self._formBuildingParcel('p-bld', { author: 'Ana' }, bp, footprint, [], 'p-bld');

    it('an overlap that cannot be computed refuses instead of reading as zero', async () => {
        installApplyGlobals();
        const self = mixinThis({ _formBuildingParcel: buildingsApply._formBuildingParcel }, [parcelFeature('HR-A', rect(0, 0, 20, 20))]);
        globalThis.turf = failingTurf(['intersect']);
        await expectClipRejection(run(self, {}, rect(5, 5, 10, 10)), 'apply-buildings.intersectionArea');
        expect(self.hidden).toHaveLength(0);
    });

    it('the footprint\'s open ground refuses instead of being left out of its parcel', async () => {
        installApplyGlobals();
        globalThis.window.__openGround = openGround;
        const host = feature(rect(0, 0, 20, 20), { parcelId: 'ground:abc', openGroundHost: true, groundIds: ['ground:abc'] });
        const self = mixinThis({ _formBuildingParcel: buildingsApply._formBuildingParcel }, [host]);
        // Intersect #1 measures the host overlap (it works); #2 is the open-ground take.
        globalThis.turf = failingTurf(['intersect'], (_op, n) => n === 2);
        const failure = await expectClipRejection(run(self, {}, rect(5, 5, 10, 10)), 'apply-buildings.groundTake');
        expect(failure.parcelId).toBe('ground:abc');
    });

    it('a whole-parcel merge refusal carries the clipper\'s error', async () => {
        installApplyGlobals();
        globalThis.window.__cadastreAncestry = { resolveParentsByGeometry: () => ({ ids: ['HR-A', 'HR-B'], coverage: 1 }) };
        const parcels = [parcelFeature('HR-A', rect(0, 0, 10, 10)), parcelFeature('HR-B', rect(10, 0, 20, 10))];
        const self = mixinThis({ _formBuildingParcel: buildingsApply._formBuildingParcel }, parcels);
        globalThis.turf = failingTurf(['union']);
        const before = siteCount('apply-buildings.hostUnion');
        const result = await run(self, { takeWholeParcels: true }, rect(0, 0, 20, 10));
        expect(result.ok).toBe(false);
        const refusal = self._setLastApplyFailure.mock.calls[0][1];
        expect(refusal.code).toBe('building-merge-failed');
        expect(refusal.message).toContain(STACK);
        expect(siteCount('apply-buildings.hostUnion')).toBe(before + 1);
    });

    it('a host remainder that cannot be computed refuses with the clipper\'s error and counts it', async () => {
        installApplyGlobals();
        const parcels = [parcelFeature('HR-A', rect(0, 0, 10, 10)), parcelFeature('HR-B', rect(10, 0, 20, 10))];
        const self = mixinThis({ _formBuildingParcel: buildingsApply._formBuildingParcel }, parcels);
        globalThis.turf = failingTurf(['difference']);
        const before = siteCount('apply-buildings.hostRemainder');
        const result = await run(self, {}, rect(5, 2, 15, 8));
        expect(result.ok).toBe(false);
        const refusal = self._setLastApplyFailure.mock.calls[0][1];
        expect(refusal.code).toBe('building-cut-failed');
        expect(refusal.message).toContain(STACK);
        expect(siteCount('apply-buildings.hostRemainder')).toBe(before + 1);
    });
});

describe('apply/parcels.js _applyReparcellizationProposal', () => {
    // Two pooled parcels (x 0..20 and 20..40); the plots leave HR-B's east end (30..40) to its owner.
    const parents = () => [parcelFeature('HR-A', rect(0, 0, 20, 20)), parcelFeature('HR-B', rect(20, 0, 40, 20))];
    const self = () => {
        const features = parents();
        return mixinThis({
            _applyReparcellizationProposal: parcelsApply._applyReparcellizationProposal,
            _resolveLiveFormationParents: () => ({ ok: true, ids: ['HR-A', 'HR-B'], cadastreIds: ['HR-A', 'HR-B'], features })
        }, features);
    };
    const data = () => ({
        cadastreParcelIds: ['HR-A', 'HR-B'],
        reparcellization: {
            polygons: [
                { geometry: rect(0, 0, 10, 20), ownerKey: 'owner-a', displayName: 'One' },
                { geometry: rect(10, 0, 30, 20), ownerKey: 'owner-a', displayName: 'Two' }
            ]
        }
    });

    it('applies with the remainder minted when the clipper works (control)', async () => {
        installApplyGlobals();
        const manager = self();
        await expect(manager._applyReparcellizationProposal('p-rep', data(), {})).resolves.toBe(true);
        expect(manager.added.length).toBe(3);
    });

    it('plot provenance refuses instead of dropping a parcel whose overlap cannot be computed', async () => {
        installApplyGlobals();
        globalThis.turf = failingTurf(['intersect'], calledFrom('apply/parcels.js'));
        await expectClipRejection(self()._applyReparcellizationProposal('p-rep', data(), {}), 'apply-parcels.intersectionArea');
    });

    it('the plots\' union refuses instead of minting a plot back as a remainder', async () => {
        installApplyGlobals();
        globalThis.turf = failingTurf(['union'], calledFrom('apply/parcels.js'));
        await expectClipRejection(self()._applyReparcellizationProposal('p-rep', data(), {}), 'apply-parcels.plotsUnion');
    });

    it('a remainder that cannot be computed refuses instead of orphaning the owner\'s leftover', async () => {
        installApplyGlobals();
        globalThis.turf = failingTurf(['difference'], calledFrom('apply/parcels.js'));
        const failure = await expectClipRejection(self()._applyReparcellizationProposal('p-rep', data(), {}), 'apply-parcels.remainder');
        expect(failure.parcelId).toBe('HR-A');
    });
});

describe('proposal-editor-adapters prepareParcelSelection', () => {
    it('refuses instead of dropping a parcel whose overlap with the footprint cannot be computed', async () => {
        const hr1 = feature(rect(0, 0, 10, 10), { parcelId: 'HR-1', cadastreParcelIds: ['HR-1'] });
        globalThis.window = globalThis;
        // The overlap is measured by plan-order; here it throws the clipper's raw error.
        globalThis.__planOrder = { intersectionArea: () => { throw new RangeError(STACK); } };
        globalThis.CadastralParcelRepository = { ensureIds: async () => {} };
        globalThis.LiveParcelFabric = {
            get: id => (String(id) === 'HR-1' ? hr1 : null),
            featureId: f => String(f?.properties?.parcelId || ''),
            explicitCadastreIds: f => f.properties.cadastreParcelIds,
            cadastreIdsForParcelIds: ids => ids,
            entriesForCadastre: () => [hr1]
        };
        globalThis.ParcelPresenter = { getLayer: () => ({ feature: hr1 }) };
        const failure = await expectClipRejection(prepareParcelSelection(['HR-1'], rect(2, 2, 8, 8)),
            'proposal-editor-adapters.featureOverlapsFootprint');
        expect(failure.parcelId).toBe('HR-1');
    });
});

// Classic scripts (top-level functions): loaded into a vm context as the page loads them.
function classicContext(file, extra = {}) {
    const context = { console, window: { __parcelArrangement: A }, turf, LAKE_SHORE_TARGET_RATIO: 0.2, LAKE_GRAPHICS_VERSION: 1, ...extra };
    vm.createContext(context);
    vm.runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), context);
    return context;
}

describe('proposals/geometry.js', () => {
    const parcels = [feature(rect(0, 0, 5, 10)), feature(rect(5, 0, 10, 10))];

    it('buildGeometryFromParcels refuses instead of saving undissolved raw rings', () => {
        const ctx = classicContext('../../frontend/js/proposals/geometry.js');
        ctx.turf = failingTurf(['union']);
        expectClipFailure(() => ctx.buildGeometryFromParcels(parcels), 'proposals-geometry.buildGeometryFromParcels');
    });

    it('buildGeometryFromParcels refuses instead of carving a parcel\'s ground out as a hole', () => {
        const ctx = classicContext('../../frontend/js/proposals/geometry.js');
        ctx.turf = failingTurf(['difference']);
        expectClipFailure(() => ctx.buildGeometryFromParcels(parcels), 'proposals-geometry.internalGaps');
    });

    it('lake graphics report a failed shore and transition and carry on', () => {
        const ctx = classicContext('../../frontend/js/proposals/geometry.js');
        ctx.turf = failingTurf(['difference']);
        const before = siteCount('proposals-geometry.lakeShore');
        const transitionBefore = siteCount('proposals-geometry.lakeTransition');
        const zones = ctx.computeLakeZonesForGeometry(feature(rect(0, 0, 100, 100)), {});
        expect(zones).toBeTruthy();
        expect(siteCount('proposals-geometry.lakeShore')).toBeGreaterThan(before);
        expect(siteCount('proposals-geometry.lakeTransition')).toBe(transitionBefore + 1);
    });

    it('lake graphics report a failed union of the lake\'s parts and carry on', () => {
        const ctx = classicContext('../../frontend/js/proposals/geometry.js');
        ctx.turf = failingTurf(['union']);
        const lake = { type: 'MultiPolygon', coordinates: [rect(0, 0, 50, 50).coordinates, rect(50, 0, 100, 50).coordinates] };
        expectReported(() => ctx.buildLakeGraphicsFromGeometry(lake, {}), 'proposals-geometry.lakeUnion');
    });
});

describe('proposal-road-geometry.js _mergeParcelGeometries', () => {
    it('throws the clipper\'s error instead of a null the caller can only call "failed to merge"', () => {
        const ctx = classicContext('../../frontend/js/proposal-road-geometry.js');
        ctx.turf = failingTurf(['union']);
        expectClipFailure(() => ctx._mergeParcelGeometries([feature(rect(0, 0, 5, 10)), feature(rect(5, 0, 10, 10))]),
            'proposal-road-geometry.mergeParcelGeometries');
    });
});
