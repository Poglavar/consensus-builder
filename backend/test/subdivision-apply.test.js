// Phase 4 of PARCEL-OPTIONAL.md, end to end through the real ProposalManager, live fabric and
// parcel-mutation transaction: a parcel layout on a site with open ground (a subdivision) forms its
// plots on the open-ground host — rootless plots with ground ids on bare ground, cadastral + ground
// provenance on a mixed site, no remainder for the host — unapply and replay restore the fabric
// exactly, and ground another proposal formed there is refused. The layout is geometry only:
// whoever owned the ground still holds it (carry-over), and open ground stays unowned.
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
const sitePlots = require('../../frontend/js/proposals/site-plots.js');
const layoutRecord = require('../../frontend/js/parcel-layout-record.js');

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

// The browser-local owner records (parcel_<id>_owner → agent id) a parcel mutation reads and
// writes through its storage draft; atomicWrite commits the draft's puts and deletes.
function ownerStorage(rows = {}) {
    const map = new Map(Object.entries(rows));
    return {
        rows: map,
        getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
        forEach(iterator) { map.forEach((value, key) => iterator(value, key)); },
        async atomicWrite({ puts, deletes }) {
            puts.forEach((value, key) => map.set(key, value));
            deletes.forEach(key => map.delete(key));
        }
    };
}

function agentStore(agents = []) {
    return {
        agents: new Map(agents.map(agent => [agent.id, { ...agent }])),
        getAgent(id) { return this.agents.get(id) || null; },
        getAllAgents() { return [...this.agents.values()]; },
        addAgent(agent) { this.agents.set(agent.id, agent); return agent.id; },
        updateAgent(id, updates) { const agent = this.agents.get(id); if (agent) Object.assign(agent, updates); }
    };
}

async function harness({ facts = [], records = [], ownerRows = {}, agents = [] } = {}) {
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
    const storage = ownerStorage(ownerRows);
    install('PersistentStorage', storage);
    install('agentStorage', agentStore(agents));
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
    return { manager, fabric, store, repository, storage };
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
const area = value => turf.area(value.type === 'Feature' ? value : turf.feature(value));
const multi = polygon => ({ type: 'MultiPolygon', coordinates: [polygon.coordinates] });

// The layout a subdivision saves: plots cut across the site, geometry only.
function subdivisionLayout(site) {
    const plots = sitePlots.cutPlots(site, { frontageEdgeIndex: 0, plotWidthM: 20, turf })
        .map(feature => ({ geometry: feature.geometry, area: area(feature.geometry), source: 'equal' }));
    return { algorithm: 'equal', pool: site, poolSource: 'site', totalArea: area(site), plotCount: plots.length, plots };
}

function subdivisionRecord(id, site, { declared = [], binding, applied = false } = {}) {
    return {
        proposalId: id,
        title: id,
        goal: 'parcel-layout',
        applied,
        createdAt: '2026-10-01T00:00:05.000Z',
        cadastreParcelIds: declared,
        site: multi(site),
        binding,
        parcelLayout: subdivisionLayout(site)
    };
}

// Owner records are written per piece (agents.js transferParcelOwnership); no other ownership
// helper may be reached by a layout.
function installOwnershipRecords() {
    const spies = {
        transferParcelOwnership: vi.fn((parcelId, fromAgentId, toAgentId, options) => {
            options.storage.setItem(`parcel_${parcelId}_owner`, toAgentId);
        }),
        getOrCreateJointPoolAgent: vi.fn(() => { throw new Error('No plot here straddles two owners.'); }),
        getOrCreateCityAgent: vi.fn(() => 'city'),
        getOrCreateAgentForRecipient: vi.fn(name => `agent:${name}`)
    };
    Object.entries(spies).forEach(([name, fn]) => install(name, fn));
    return spies;
}

const BARE_SITE = rect(0, 0, 12, 6); // ≈ 108 m × 67 m: five plots
const HR1 = parcel('HR-330264-1', rect(0, 0, 6, 6));
const MIXED_SITE = rect(3, 0, 15, 6); // half over HR-1, half over the hole beside it

describe('subdivision on bare ground (empty binding)', () => {
    it('forms rootless, unowned plots on the open-ground host, and unapply/replay restore exactly', async () => {
        const record = subdivisionRecord('sub-bare', BARE_SITE, { binding: { parcels: [], coverage: 'none', source: 'server' } });
        const { manager, fabric } = await harness({ records: [record] });
        const spies = installOwnershipRecords();
        await expect(manager.applyProposal('sub-bare')).resolves.toBe(true);
        expect(manager.getLastApplyFailure('sub-bare')).toBeNull();

        const hash = await siteHash.siteHashHex(record.site);
        const pieces = fabric.list();
        expect(pieces).toHaveLength(record.parcelLayout.plots.length);
        const plotReferences = record.parcelLayout.plots.map(layoutRecord.plotFingerprint).sort();
        expect(pieces.map(piece => piece.properties.readjustmentPiece.plotFingerprint).sort()).toEqual(plotReferences);
        pieces.forEach(piece => {
            expect(piece.properties.cadastreParcelIds).toEqual([]);
            expect(piece.properties.groundIds).toEqual([`ground:${hash}`]);
            expect(piece.properties.rootParcelId).toBeNull();
            expect(piece.properties.parcelId).toMatch(/^sub-bare-\d+$/);
            expect(openGround.isGroundPiece(piece)).toBe(true);
            // Open ground has no owner to carry over.
            expect(piece.properties.ownershipDetails).toBeUndefined();
        });
        // The plots are the whole site; nothing was minted for the host's rest.
        expect(pieces.reduce((sum, piece) => sum + area(piece), 0)).toBeCloseTo(area(BARE_SITE), 0);
        Object.values(spies).forEach(spy => expect(spy).not.toHaveBeenCalled());
        // Never offered as cadastral parcels.
        expect(fabric.claimedCadastreIds().size).toBe(0);

        const applied = fabric.list().map(piece => [piece.properties.parcelId, JSON.stringify(piece.geometry)]).sort();
        await expect(manager.unapplyProposal('sub-bare')).resolves.toBe(true);
        expect(fabric.list()).toEqual([]);

        // Reload: the boot replay re-derives the same plots under the same ids.
        globalThis.proposalStorage.getProposal('sub-bare').applied = true;
        await expect(manager.rebuildAppliedFabric({ silent: true })).resolves.toMatchObject({ ok: true, applied: 1, failed: [] });
        expect(fabric.list().map(piece => [piece.properties.parcelId, JSON.stringify(piece.geometry)]).sort()).toEqual(applied);
        expect(fabric.list().map(piece => piece.properties.readjustmentPiece.plotFingerprint).sort()).toEqual(plotReferences);
    });

    it('refuses a subdivision whose plots leave its declared site uncovered, before changing the fabric', async () => {
        const record = subdivisionRecord('sub-part', BARE_SITE, { binding: { parcels: [], coverage: 'none' } });
        // A subdivision partitions its declared site, including open ground; a missing plot is a gap.
        record.parcelLayout.plots = record.parcelLayout.plots.slice(0, 3);
        const { manager, fabric } = await harness({ records: [record] });
        const spies = installOwnershipRecords();

        await expect(manager.applyProposal('sub-part')).resolves.toBe(false);

        expect(manager.getLastApplyFailureInfo('sub-part')).toMatchObject({ code: 'invalid-parcel-layout' });
        expect(fabric.list()).toEqual([]);
        Object.values(spies).forEach(spy => expect(spy).not.toHaveBeenCalled());
        expect(globalThis.proposalStorage.getProposal('sub-part').applied).toBe(false);
    });

    it('refuses to re-divide ground another proposal formed on the same open ground', async () => {
        const park = {
            proposalId: 'park-first', title: 'Corner park', goal: 'park', applied: false,
            createdAt: '2026-10-01T00:00:01.000Z', cadastreParcelIds: [],
            site: multi(rect(0, 0, 3, 3)), binding: { parcels: [], coverage: 'none' },
            structureProposal: { kind: 'park', geometry: rect(0, 0, 3, 3) }
        };
        const record = subdivisionRecord('sub-over-park', BARE_SITE, { binding: { parcels: [], coverage: 'none' } });
        const { manager, fabric } = await harness({ records: [park, record] });
        await expect(manager.applyProposal('park-first')).resolves.toBe(true);
        const before = fabric.list().map(piece => piece.properties.parcelId);

        await expect(manager.applyProposal('sub-over-park')).resolves.toBe(false);
        const failure = manager.getLastApplyFailureInfo('sub-over-park');
        expect(failure.code).toBe('readjustment-taken-ground');
        expect(failure.message).toContain('"Corner park"');
        expect(fabric.list().map(piece => piece.properties.parcelId)).toEqual(before);
    });
});

describe('subdivision of a site partly over parcels (mixed pool)', () => {
    it('gives plots cadastral and/or ground provenance, carries the parcel owner over, and unapply restores both', async () => {
        const record = subdivisionRecord('sub-mixed', MIXED_SITE, {
            declared: ['HR-330264-1'],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial', unsurveyedM2: 3600, source: 'server' }
        });
        const ownerRows = { 'parcel_HR-330264-1_owner': 'agent-hr1' };
        const { manager, fabric, storage } = await harness({
            facts: [HR1], records: [record], ownerRows, agents: [{ id: 'agent-hr1', name: 'Hana' }]
        });
        const spies = installOwnershipRecords();
        const before = fabric.list().map(piece => JSON.stringify(piece));

        await expect(manager.applyProposal('sub-mixed')).resolves.toBe(true);
        const hash = await siteHash.siteHashHex(record.site);
        const pieces = fabric.list();
        const plots = pieces.filter(piece => piece.properties.producedByProposalId === 'sub-mixed' && turf.booleanWithin(turf.centroid(piece), turf.feature(MIXED_SITE)));
        expect(plots).toHaveLength(record.parcelLayout.plots.length);
        expect(plots.map(piece => piece.properties.readjustmentPiece.plotFingerprint).sort())
            .toEqual(record.parcelLayout.plots.map(layoutRecord.plotFingerprint).sort());
        const onParcel = plots.filter(piece => piece.properties.cadastreParcelIds.length);
        const onGround = plots.filter(piece => piece.properties.groundIds && piece.properties.groundIds.length);
        expect(onParcel.length).toBeGreaterThan(0);
        expect(onGround.length).toBeGreaterThan(0);
        onParcel.forEach(piece => expect(piece.properties.cadastreParcelIds).toEqual(['HR-330264-1']));
        onGround.forEach(piece => expect(piece.properties.groundIds).toEqual([`ground:${hash}`]));
        plots.filter(piece => !piece.properties.cadastreParcelIds.length)
            .forEach(piece => expect(piece.properties.parcelId).toMatch(/^sub-mixed-\d+$/));
        // Spanning plots (one crosses the parcel edge) carry both.
        expect(plots.some(piece => piece.properties.cadastreParcelIds.length && piece.properties.groundIds)).toBe(true);
        // HR-1's part outside the site is its remainder, with its owner; the open ground has none.
        const rest = pieces.filter(piece => !plots.includes(piece));
        expect(rest).toHaveLength(1);
        expect(rest[0].properties.readjustmentPiece).toEqual({ role: 'remainder' });
        expect(rest[0].properties.cadastreParcelIds).toEqual(['HR-330264-1']);
        expect(rest[0].properties.groundIds).toBeUndefined();
        expect(rest[0].properties.ownershipDetails.owners[0].name).toBe('Owner HR-330264-1');
        expect(area(rest[0])).toBeCloseTo(area(rect(0, 0, 3, 6)), 0);
        expect(pieces.reduce((sum, piece) => sum + area(piece), 0)).toBeCloseTo(area(rect(0, 0, 15, 6)), 0);

        // Carry-over: every piece standing on HR-1 is held by HR-1's owner, the rest by nobody.
        plots.forEach(piece => {
            const onHr1 = piece.properties.cadastreParcelIds.includes('HR-330264-1');
            expect(storage.getItem(`parcel_${piece.properties.parcelId}_owner`)).toBe(onHr1 ? 'agent-hr1' : null);
            if (onHr1) {
                expect(piece.properties.ownershipDetails).toEqual({
                    owners: [{ name: 'Hana', ownerLabel: 'Hana', ownerKey: 'agent-hr1', percentageShare: 100, actualShareText: '100%' }],
                    jointPool: false
                });
            } else {
                expect(piece.properties.ownershipDetails).toBeUndefined();
            }
        });
        expect(storage.getItem(`parcel_${rest[0].properties.parcelId}_owner`)).toBe('agent-hr1');
        expect(new Set(spies.transferParcelOwnership.mock.calls.map(call => call[2]))).toEqual(new Set(['agent-hr1']));
        expect(spies.getOrCreateCityAgent).not.toHaveBeenCalled();
        expect(spies.getOrCreateAgentForRecipient).not.toHaveBeenCalled();

        await expect(manager.unapplyProposal('sub-mixed')).resolves.toBe(true);
        expect(fabric.list().map(piece => JSON.stringify(piece))).toEqual(before);
        expect(liveIds(fabric)).toEqual(['HR-330264-1']);
        // The pieces' owner records went with the pieces; the parcel's own record never moved.
        expect(Object.fromEntries(storage.rows)).toEqual(ownerRows);
    });

    it('keeps an ordinary layout on parcels exactly as before (no open ground, no ground ids)', async () => {
        const HR2 = parcel('HR-330264-2', rect(6, 0, 12, 6));
        const site = rect(0, 0, 12, 6);
        const record = subdivisionRecord('readjust', site, {
            declared: ['HR-330264-1', 'HR-330264-2'],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }, { parcelId: 'HR-330264-2' }], coverage: 'complete', source: 'server' }
        });
        expect(openGround.hasOpenGround(record)).toBe(false);
        const { manager, fabric } = await harness({ facts: [HR1, HR2], records: [record] });
        installOwnershipRecords();
        await expect(manager.applyProposal('readjust')).resolves.toBe(true);
        const pieces = fabric.list();
        expect(pieces).toHaveLength(record.parcelLayout.plots.length);
        pieces.forEach(piece => {
            expect(piece.properties.groundIds).toBeUndefined();
            expect(piece.properties.cadastreParcelIds.length).toBeGreaterThan(0);
            expect(piece.properties.parcelId.startsWith('HR-330264-')).toBe(true);
        });
        await expect(manager.unapplyProposal('readjust')).resolves.toBe(true);
        expect(liveIds(fabric)).toEqual(['HR-330264-1', 'HR-330264-2']);
    });
});
