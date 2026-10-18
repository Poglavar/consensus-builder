// A polygon clip that throws while a corridor's fabric is derived refuses the apply, naming what
// failed, and leaves nothing partial behind. turf 6.5's clipper (polygon-clipping 0.15) throws
// "Maximum call stack size exceeded" on long corridor chains; the arrangement used to drop that
// take, so the road "applied" while the parcel under it stayed whole. End to end through the real
// ProposalManager, live fabric and parcel-mutation transaction (harness as in open-ground-apply).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
// Browser modules first, while `window` is still undefined, so each picks its node path; they
// publish their namespaced APIs on globalThis, which becomes `window` below.
const status = require('../../frontend/js/proposals/status.js');
const footprintParts = require('../../frontend/js/proposals/footprint-parts.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const siteBinding = require('../../frontend/js/proposals/site-binding.js');
const siteHash = require('../../frontend/js/proposals/site-hash.js');
const openGround = require('../../frontend/js/proposals/open-ground.js');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const parcelArrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const parcelContiguity = require('../../frontend/js/proposals/parcel-contiguity.js');
const applyRoute = require('../../frontend/js/proposals/apply/route.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const finalize = require('../../frontend/js/proposals/apply/finalize.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

// A small grid near Šibenik, in units of 1e-4 degree (≈ 8 m east, 11 m north).
const LON = 15.876;
const LAT = 43.7537;
const U = 1e-4;
const rect = (x0, y0, x1, y1) => ({
    type: 'Polygon',
    coordinates: [[
        [LON + x0 * U, LAT + y0 * U], [LON + x1 * U, LAT + y0 * U],
        [LON + x1 * U, LAT + y1 * U], [LON + x0 * U, LAT + y1 * U],
        [LON + x0 * U, LAT + y0 * U]
    ]]
});
const parcel = (id, geometry) => ({
    type: 'Feature',
    properties: {
        parcelId: id,
        cadastreParcelIds: [id],
        BROJ_CESTICE: id.split('-').pop(),
        ownershipDetails: { owners: [{ name: `Owner ${id}`, percentageShare: 100 }] }
    },
    geometry
});

const installed = new Map();
function install(name, value) {
    if (!installed.has(name)) {
        installed.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

function mutationStore(records) {
    const proposals = new Map(records.map(record => [String(record.proposalId), record]));
    return {
        proposals,
        nextProposalId: 1,
        save: vi.fn(),
        getProposal(id) { return this.proposals.get(String(id)) || null; },
        getAllProposals() { return [...this.proposals.values()]; },
        _indexProposal(record) { this.proposals.set(String(record.proposalId), record); },
        snapshotForMutation() {
            return { records: new Map([...this.proposals].map(([id, record]) => [id, structuredClone(record)])), nextProposalId: this.nextProposalId };
        },
        createMutationDraft(snapshot) {
            const draft = Object.create(this);
            draft.proposals = new Map([...snapshot.records].map(([id, record]) => [id, structuredClone(record)]));
            draft.save = () => {};
            return draft;
        },
        serializeMutationDraft: () => null,
        publishMutationDraft(draft) {
            draft.proposals.forEach((record, id) => {
                const current = this.proposals.get(id);
                if (current) {
                    Object.keys(current).forEach(key => delete current[key]);
                    Object.assign(current, structuredClone(record));
                } else this.proposals.set(id, structuredClone(record));
            });
        }
    };
}

// The cadastral repository holds the cadastre the server would bind against. `ensureProposalGround`
// answers from it; every fact is already seeded into the fabric.
function repositoryOf(facts) {
    const byId = new Map(facts.map(feature => [feature.properties.parcelId, feature]));
    return {
        calls: [],
        getMany(ids) { return Array.from(ids || []).map(id => byId.get(String(id))).filter(Boolean).map(f => structuredClone(f)); },
        peekMany(ids) { return this.getMany(ids); },
        list() { return [...byId.values()].map(f => structuredClone(f)); },
        listIds() { return [...byId.keys()]; },
        async ensureProposalGround(records) {
            this.calls.push(records.map(record => String(record.proposalId)));
            const missingIds = records.flatMap(record => record.cadastreParcelIds || []).filter(id => !byId.has(String(id)));
            return { members: records.length, missingIds, elapsed: 0 };
        },
        coverageOf(geometry, { ids } = {}) {
            const candidates = (ids || []).map(id => byId.get(String(id))).filter(Boolean)
                .map(feature => ({ id: feature.properties.parcelId, feature }));
            const hits = planOrder.computeBaseAncestry(geometry, candidates);
            const covered = hits.reduce((sum, hit) => sum + hit.area, 0);
            return { ids: hits.map(hit => hit.id), coverage: covered / turf.area(geometry) };
        }
    };
}

async function harness({ facts = [], records = [] } = {}) {
    install('window', globalThis);
    install('turf', turf);
    install('__formationEdit', formationEdit);
    install('__parcelArrangement', parcelArrangement);
    install('__applyRoute', applyRoute);
    install('__planOrder', planOrder);
    install('__footprintParts', footprintParts);
    install('__siteBinding', siteBinding);
    install('__siteHash', siteHash);
    install('__openGround', openGround);
    install('__parcelContiguity', parcelContiguity);
    const fabric = createLiveParcelFabric({ geometry: turf });
    install('LiveParcelFabric', fabric);
    const repository = repositoryOf(facts);
    install('CadastralParcelRepository', repository);
    const store = mutationStore(records);
    install('proposalStorage', store);
    install('PersistentStorage', { getItem: () => null, forEach() {}, atomicWrite: async () => {} });
    ['parks', 'squares', 'lakes', 'transitStations', 'proposedBuildings'].forEach(name => install(name, []));
    install('setProposalApplied', status.setProposalApplied);
    install('isApplied', status.isApplied);
    install('appliedOf', status.isApplied);
    install('lifecycleOf', status.getLifecycleStatus);
    install('isProposalCurrentlyApplied', record => status.isApplied(record));
    install('persistAppliedProposal', finalize.persistAppliedProposal);
    install('refreshProposalUIAfterApply', finalize.refreshProposalUIAfterApply);
    install('_normalizeProposalId', value => (value === undefined || value === null ? null : String(value)));
    install('_resolveRootParcelNumberFromProperties', props => (props && (props.rootParcelNumber || props.BROJ_CESTICE)) || '');
    install('_calculateGeoJsonArea', geometry => turf.area(turf.feature(geometry)));
    install('getProposalKey', record => record.proposalId);
    if (facts.length) {
        const mutation = fabric.beginMutation({ kind: 'test-seed' });
        mutation.seedCadastre(facts);
        await mutation.prepare();
        mutation.publish();
    }
    const manager = Object.create(ProposalManager);
    manager._lastApplyFailureByProposalId = new Map();
    manager._rebuildInProgress = false;
    return { manager, fabric, store, repository };
}

afterEach(() => {
    for (const [name, previous] of installed) {
        if (previous.existed) globalThis[name] = previous.value;
        else delete globalThis[name];
    }
    installed.clear();
    vi.restoreAllMocks();
});

beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

const liveIds = fabric => fabric.list().map(feature => feature.properties.parcelId).sort();
const HR1 = parcel('HR-330264-1', rect(0, 0, 20, 10));
// A second parcel under the same road, which the clipper handles.
const HR3 = parcel('HR-330264-3', rect(20, 0, 35, 10));
const ROAD_POLYGON = rect(-5, 4, 40, 6);
const road = () => ({
    proposalId: 'road-1',
    title: 'Road over HR-330264-1',
    goal: 'road-track',
    applied: false,
    createdAt: '2026-10-02T00:00:00.000Z',
    cadastreParcelIds: ['HR-330264-1', 'HR-330264-3'],
    binding: { parcels: [{ parcelId: 'HR-330264-1' }, { parcelId: 'HR-330264-3' }], coverage: 'partial', source: 'server' },
    roadProposal: { definition: { polygon: ROAD_POLYGON, points: [[LAT + 5 * U, LON - 5 * U], [LAT + 5 * U, LON + 40 * U]], width: 6 } }
});

// The clipper overflows its stack exactly where the arrangement asks which corridors reach
// HR-330264-1; every other clip in the apply, HR-330264-3's included, runs normally.
function overflowInTakeHits() {
    let inTakeHits = false;
    let thrown = 0;
    install('__parcelArrangement', {
        ...parcelArrangement,
        takeHitsOn(parcelFeature, takes) {
            inTakeHits = parcelFeature.properties.parcelId === 'HR-330264-1';
            try { return parcelArrangement.takeHitsOn(parcelFeature, takes); } finally { inTakeHits = false; }
        }
    });
    install('turf', new Proxy(turf, {
        get(target, prop) {
            if (prop !== 'intersect') return target[prop];
            return (a, b) => {
                if (inTakeHits) { thrown += 1; throw new RangeError('Maximum call stack size exceeded'); }
                return target.intersect(a, b);
            };
        }
    }));
    return () => thrown;
}

describe('a clip failure while a corridor is applied', () => {
    it('cuts the parcel when the clipper works (control)', async () => {
        const { manager, fabric } = await harness({ facts: [HR1, HR3], records: [road()] });
        await expect(manager.applyProposal('road-1')).resolves.toBe(true);
        expect(liveIds(fabric).length).toBeGreaterThan(1);
    });

    it('refuses the apply and leaves the record and the fabric as they were', async () => {
        const { manager, fabric, store } = await harness({ facts: [HR1, HR3], records: [road()] });
        const thrown = overflowInTakeHits();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const before = JSON.stringify(fabric.list());

        let result;
        try { result = await manager.applyProposal('road-1'); } catch (error) { result = error; }

        expect(thrown()).toBeGreaterThan(0);
        expect(result === true).toBe(false);
        // Nothing partial: the record is not applied and the parcel is exactly the cadastre.
        expect(store.getProposal('road-1').applied).not.toBe(true);
        expect(JSON.stringify(fabric.list())).toBe(before);
        expect(liveIds(fabric)).toEqual(['HR-330264-1', 'HR-330264-3']);
        expect(manager.getLastApplyFailureInfo('road-1')).toMatchObject({
            message: expect.stringMatching(/intersect failed at parcel-arrangement\.takeHitsOn \(parcel HR-330264-1, take road-1\): Maximum call stack/)
        });
        // The structured log names the parcel, the take and the clipper's own error.
        const logged = errors.mock.calls.find(call => /could not arrange/.test(String(call[0])));
        expect(logged).toBeTruthy();
        expect(logged[2]).toEqual([expect.objectContaining({
            parcelId: 'HR-330264-1',
            code: 'clip-failed',
            site: 'parcel-arrangement.takeHitsOn',
            takeId: 'road-1',
            error: expect.stringMatching(/Maximum call stack size exceeded/)
        })]);
    });

    it('a boot replay sets the parcel aside and says which clip failed, instead of leaving it silently whole', async () => {
        const applied = { ...road(), applied: true };
        const { manager } = await harness({ facts: [HR1, HR3], records: [applied] });
        overflowInTakeHits();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const shown = vi.fn();
        install('showEphemeralMessage', shown);

        const summary = await manager.rebuildAppliedFabric({});

        // Not a success: the parcel the clipper could not do is named in the warning, with the clip.
        expect(summary === false || (summary && summary.ok === false)).toBe(true);
        expect(shown).toHaveBeenCalledWith(
            expect.stringMatching(/HR-330264-1 — Polygon intersect failed at parcel-arrangement\.takeHitsOn \(parcel HR-330264-1, take road-1\): Maximum call stack/),
            expect.anything(), 'warning');
    });
});
