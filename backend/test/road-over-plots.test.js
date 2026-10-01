// Phase 6b of PARCEL-OPTIONAL.md, end to end through the real ProposalManager, live fabric and
// parcel-mutation transaction: a road applied after a subdivision (or land readjustment) takes its
// ribbon out of the plots it crosses — on open ground, on a mixed site and on cadastral parcels — so
// no ground is covered twice; unapplying the road gives the plots back exactly, the boot replay is
// stable, an EARLIER road still refuses a newer subdivision over it, and a building standing in the
// road's way still refuses the road.
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
const subdivision = require('../../frontend/js/proposals/subdivision.js');
const sitePlots = require('../../frontend/js/proposals/site-plots.js');

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
const area = value => turf.area(value.type === 'Feature' ? value : turf.feature(value));
const multi = polygon => ({ type: 'MultiPolygon', coordinates: [polygon.coordinates] });

// The plan the editor saves for a subdivision: plots cut across the site, each given to the
// contributor whose ground it stands on, and the last one assigned to public land by hand (the
// way a public strip is made: a plot whose owner is set to the City).
function subdivisionPlan(site, { pool, shares }) {
    const cut = sitePlots.cutPlots(site, { frontageEdgeIndex: 0, plotWidthM: 20, turf }).map(feature => feature.geometry);
    const plot = (geometry, ownerKey, displayName) => ({
        ownerKey, displayName, percent: null, color: '#cccccc', source: 'sweep-line', area: area(geometry), geometry,
        owners: [{ ownerKey, displayName, color: '#cccccc', share: 1 }]
    });
    const polygons = cut.slice(0, -1).map(geometry => {
        const key = subdivision.ownerKeyByGround(geometry, pool, shares, { turf }) || subdivision.OPEN_GROUND_OWNER_KEY;
        const share = shares.find(entry => entry.ownerKey === key);
        return plot(geometry, key, share ? share.displayName : 'Open ground');
    });
    polygons.push(plot(cut[cut.length - 1], 'public-land', 'Public land'));
    return { algorithm: 'sweep-line', poolSource: 'site', poolGeometry: site, openGroundM2: pool.openGroundM2, polygons };
}

function subdivisionRecord(id, site, { declared = [], binding, parcels = [], applied = false } = {}) {
    const pool = subdivision.sitePool(site, parcels, { turf });
    const contributions = pool.parts.map(part => ({
        ownerKey: `owner:${part.parcelId}`, displayName: `Owner ${part.parcelId}`, area: part.areaM2, value: null, parcelIds: [part.parcelId]
    }));
    const { shares } = subdivision.poolShares(contributions, { openGroundM2: pool.openGroundM2 });
    return {
        proposalId: id,
        title: id,
        goal: 'reparcellization',
        applied,
        createdAt: '2026-10-01T00:00:05.000Z',
        cadastreParcelIds: declared,
        site: multi(site),
        binding,
        reparcellization: subdivisionPlan(site, { pool, shares })
    };
}

function installOwnershipSpies() {
    const spies = {
        transferParcelOwnership: vi.fn(),
        getOrCreateCityAgent: vi.fn(() => 'city'),
        getOrCreateAgentForRecipient: vi.fn(name => `agent:${name}`)
    };
    Object.entries(spies).forEach(([name, fn]) => install(name, fn));
    return spies;
}

const BARE_SITE = rect(0, 0, 12, 6); // ≈ 97 m × 67 m: five plots, the last one public
const HR1 = parcel('HR-330264-1', rect(0, 0, 6, 6));
const MIXED_SITE = rect(3, 0, 15, 6); // half over HR-1, half over the hole beside it
// A road across the site, north–south through a plot (≈ 8 m wide).
const CROSS_ROAD = rect(7.5, -3, 8.5, 9);
const overlap = (a, b) => {
    const hit = turf.intersect(turf.feature(a.geometry || a), turf.feature(b.geometry || b));
    return hit ? turf.area(hit) : 0;
};
const total = pieces => pieces.reduce((sum, piece) => sum + area(piece), 0);
const unionOf = pieces => pieces.reduce((acc, piece) => (acc ? turf.union(acc, piece) : piece), null);
const snapshot = fabric => fabric.list().map(piece => [piece.properties.parcelId, JSON.stringify(piece.geometry)]).sort();

function roadRecord(id, polygon, extra = {}) {
    return {
        proposalId: id,
        title: id,
        goal: 'road-track',
        applied: false,
        createdAt: '2026-10-02T00:00:00.000Z',
        cadastreParcelIds: [],
        roadProposal: { id, definition: { polygon, points: [[LAT - 3 * U, LON + 8 * U], [LAT + 9 * U, LON + 8 * U]], width: 8 } },
        ...extra
    };
}

// No two pieces share ground, nothing stands on the road, and the pieces plus the road's ground in
// `within` are exactly `within`.
function expectPartition(pieces, road, within) {
    pieces.forEach(piece => expect(overlap(piece, road)).toBeLessThan(0.25));
    expect(total(pieces)).toBeCloseTo(area(unionOf(pieces)), 0);
    expect(total(pieces) + overlap(within, road)).toBeCloseTo(area(within), 0);
}

describe('a road built through subdivision plots on open ground', () => {
    it('cuts the plots it crosses, unapply gives them back exactly, and the boot replay is stable', async () => {
        const record = subdivisionRecord('sub', BARE_SITE, { binding: { parcels: [], coverage: 'none', source: 'server' } });
        const road = roadRecord('road', CROSS_ROAD);
        const { manager, fabric } = await harness({ records: [record, road] });
        installOwnershipSpies();
        await expect(manager.applyProposal('sub')).resolves.toBe(true);
        const before = snapshot(fabric);
        const plotCount = fabric.list().length;

        // The road tool's create path (what follows the "Build through" prompt).
        await expect(manager.deriveForNewProposal(globalThis.proposalStorage.getProposal('road'))).resolves.toMatchObject({ ok: true });
        expect(manager.getLastApplyFailure('road')).toBeNull();
        expect(manager.getLastApplyFailure('sub')).toBeNull();
        const cut = fabric.list();
        // The plot the road runs through was split where it crosses.
        expect(cut.length).toBeGreaterThan(plotCount);
        expectPartition(cut, CROSS_ROAD, BARE_SITE);
        const hash = await siteHash.siteHashHex(record.site);
        cut.forEach(piece => {
            expect(piece.properties.producedByProposalId).toBe('sub');
            expect(piece.properties.cadastreParcelIds).toEqual([]);
            expect(piece.properties.groundIds).toEqual([`ground:${hash}`]);
        });
        // The authored plan is untouched.
        expect(globalThis.proposalStorage.getProposal('sub').reparcellization.polygons).toHaveLength(plotCount);
        const withRoad = snapshot(fabric);

        // Reload: the boot replay derives the same carved plots under the same ids.
        await expect(manager.rebuildAppliedFabric({ silent: true })).resolves.toMatchObject({ ok: true, failed: [] });
        expect(snapshot(fabric)).toEqual(withRoad);

        await expect(manager.unapplyProposal('road')).resolves.toBe(true);
        expect(snapshot(fabric)).toEqual(before);
        expect(total(fabric.list())).toBeCloseTo(area(BARE_SITE), 0);
    });

    it('keeps refusing a newer subdivision laid over an earlier road', async () => {
        const road = roadRecord('road-first', CROSS_ROAD, { createdAt: '2026-09-30T00:00:00.000Z' });
        const record = subdivisionRecord('sub-later', BARE_SITE, { binding: { parcels: [], coverage: 'none', source: 'server' } });
        const { manager, fabric } = await harness({ records: [road, record] });
        installOwnershipSpies();
        await expect(manager.applyProposal('road-first')).resolves.toBe(true);
        await expect(manager.applyProposal('sub-later')).resolves.toBe(false);
        const failure = manager.getLastApplyFailureInfo('sub-later');
        expect(failure.code).toBe('readjustment-over-road');
        expect(failure.message).toMatch(/stand on \d+ m² of the applied road "road-first"/);
        expect(fabric.list()).toEqual([]);
    });

    it('refuses a road through a building standing on a plot, and cuts the plot beside it', async () => {
        const record = subdivisionRecord('sub-b', BARE_SITE, { binding: { parcels: [], coverage: 'none', source: 'server' } });
        const { manager, fabric } = await harness({ records: [record] });
        installOwnershipSpies();
        await expect(manager.applyProposal('sub-b')).resolves.toBe(true);
        // A house in the west part of the corner plot.
        const plot = fabric.list().find(piece => turf.booleanPointInPolygon(turf.point([LON + 0.5 * U, LAT + 0.5 * U]), piece));
        const [minX, minY, maxX, maxY] = turf.bbox(plot);
        const x = value => (value - LON) / U;
        const y = value => (value - LAT) / U;
        const houseBox = [x(minX) + 0.2, y(minY) + 0.2, x(minX) + 0.2 + (x(maxX) - x(minX)) * 0.3, y(maxY) - 0.2];
        const house = {
            proposalId: 'house', title: 'House', goal: 'single', applied: false,
            createdAt: '2026-10-01T12:00:00.000Z', cadastreParcelIds: [],
            site: multi(rect(...houseBox)), binding: { parcels: [], coverage: 'none', source: 'server' },
            buildingProposal: {}, geometry: { buildings: [turf.feature(rect(...houseBox))] }
        };
        globalThis.proposalStorage.proposals.set('house', house);
        await expect(manager.applyProposal('house')).resolves.toBe(true);
        const before = snapshot(fabric);

        // Through the house: refused, nothing changes (a road is never built over a standing building).
        const through = roadRecord('road-through', rect(houseBox[0] + 0.1, -3, houseBox[2] - 0.1, 9));
        globalThis.proposalStorage.proposals.set('road-through', through);
        const refused = await manager.deriveForNewProposal(globalThis.proposalStorage.getProposal('road-through'));
        expect(refused && refused.ok).not.toBe(true);
        expect(snapshot(fabric)).toEqual(before);

        // Beside the house, across the same plot: the plot is cut, the house keeps its parcel.
        const beside = roadRecord('road-beside', rect(houseBox[2] + 0.3, -3, x(maxX) - 0.3, 9));
        globalThis.proposalStorage.proposals.set('road-beside', beside);
        await expect(manager.deriveForNewProposal(globalThis.proposalStorage.getProposal('road-beside'))).resolves.toMatchObject({ ok: true });
        const pieces = fabric.list();
        expectPartition(pieces, beside.roadProposal.definition.polygon, BARE_SITE);
        expect(pieces.some(piece => piece.properties.producedByProposalId === 'house')).toBe(true);
        expect(globalThis.proposedBuildings.some(feature => String(feature.properties.proposalId) === 'house')).toBe(true);
    });
});

describe('a road built through a subdivision of a site partly over parcels', () => {
    it('cuts the plots on the parcel and on open ground alike, and unapply restores them', async () => {
        const binding = { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial', unsurveyedM2: 3600, source: 'server' };
        const record = subdivisionRecord('sub-mixed', MIXED_SITE, {
            declared: ['HR-330264-1'], binding, parcels: [{ id: 'HR-330264-1', geometry: HR1.geometry }]
        });
        // Across the parcel edge (x = 6): half the ribbon over HR-1, half over the hole.
        const ROAD = rect(5.5, -3, 6.5, 9);
        const road = roadRecord('road-mixed', ROAD, { cadastreParcelIds: ['HR-330264-1'], binding });
        const { manager, fabric } = await harness({ facts: [HR1], records: [record, road] });
        installOwnershipSpies();
        await expect(manager.applyProposal('sub-mixed')).resolves.toBe(true);
        const before = snapshot(fabric);

        await expect(manager.deriveForNewProposal(globalThis.proposalStorage.getProposal('road-mixed'))).resolves.toMatchObject({ ok: true });
        expect(manager.getLastApplyFailure('sub-mixed')).toBeNull();
        const pieces = fabric.list();
        const roadPieces = pieces.filter(piece => piece.properties.producedByProposalId === 'road-mixed');
        const rest = pieces.filter(piece => !roadPieces.includes(piece));
        // On the parcel the arrangement gives the road its piece; on open ground the ribbon has none.
        expect(roadPieces.length).toBeGreaterThan(0);
        roadPieces.forEach(piece => expect(piece.properties.cadastreParcelIds).toEqual(['HR-330264-1']));
        const ground = rect(0, 0, 15, 6);
        expectPartition(rest, ROAD, ground);
        expect(total(roadPieces)).toBeCloseTo(overlap(HR1, ROAD), 0);

        await expect(manager.unapplyProposal('road-mixed')).resolves.toBe(true);
        expect(snapshot(fabric)).toEqual(before);
    });
});

describe('a road built through a land readjustment on parcels', () => {
    it('cuts the readjusted plots instead of refusing the road', async () => {
        const HR2 = parcel('HR-330264-2', rect(6, 0, 12, 6));
        const binding = { parcels: [{ parcelId: 'HR-330264-1' }, { parcelId: 'HR-330264-2' }], coverage: 'complete', source: 'server' };
        const record = subdivisionRecord('readjust', BARE_SITE, {
            declared: ['HR-330264-1', 'HR-330264-2'], binding,
            parcels: [{ id: 'HR-330264-1', geometry: HR1.geometry }, { id: 'HR-330264-2', geometry: HR2.geometry }]
        });
        const road = roadRecord('road-cad', CROSS_ROAD, { cadastreParcelIds: ['HR-330264-2'], binding: { parcels: [{ parcelId: 'HR-330264-2' }], coverage: 'complete', source: 'server' } });
        const { manager, fabric } = await harness({ facts: [HR1, HR2], records: [record, road] });
        installOwnershipSpies();
        await expect(manager.applyProposal('readjust')).resolves.toBe(true);
        const before = snapshot(fabric);

        await expect(manager.deriveForNewProposal(globalThis.proposalStorage.getProposal('road-cad'))).resolves.toMatchObject({ ok: true });
        expect(manager.getLastApplyFailure('readjust')).toBeNull();
        const pieces = fabric.list();
        const plots = pieces.filter(piece => piece.properties.producedByProposalId === 'readjust');
        expectPartition(plots, CROSS_ROAD, BARE_SITE);
        expect(total(pieces)).toBeCloseTo(area(BARE_SITE), 0);

        await expect(manager.unapplyProposal('road-cad')).resolves.toBe(true);
        expect(snapshot(fabric)).toEqual(before);
    });
});

// Observed in the road tool on HR-339318-5848/3 (fixture): a Block proposed on the parcel, then a
// road drawn along the parcel through the block's building. The corridor replay re-derives the block,
// whose footprint the road has taken, so the block refuses and the whole road rolls back — by the
// rule above. The refusal used to reach the user as "proposal could not be materialized locally": the
// block's own reason was read as `.message` off the string getLastApplyFailure returns.
describe('a road through a block standing on a cadastral parcel (HR-339318-5848/3)', () => {
    const fixture = require('./fixtures/road-through-block-5848-3.json');

    it('is refused with the block\'s own reason', async () => {
        const facts = [parcel(fixture.parcelId, fixture.parcel)];
        const block = {
            proposalId: 'block', title: 'Block 0110-2207', goal: 'buildings', applied: false,
            createdAt: '2026-10-01T12:00:00.000Z', cadastreParcelIds: [fixture.parcelId],
            buildingProposal: {}, geometry: { buildings: [turf.feature(fixture.blockBuilding)] }
        };
        const road = {
            ...roadRecord('road-block', fixture.roadPolygon, { cadastreParcelIds: [fixture.parcelId] }),
            title: 'Road 0110-2210'
        };
        road.roadProposal.definition.points = fixture.roadPoints;
        road.roadProposal.definition.width = 7.5;
        const { manager, store } = await harness({ facts, records: [block, road] });
        installOwnershipSpies();
        await expect(manager.applyProposal('block')).resolves.toBe(true);
        // The road really does run through the building, not just across the parcel.
        expect(overlap(turf.feature(fixture.blockBuilding), fixture.roadPolygon)).toBeGreaterThan(10);

        store.getProposal('road-block').applied = true;
        const derived = await manager.rematerializeCorridorScope([store.getProposal('road-block')]);
        expect(derived && derived.ok).not.toBe(true);
        expect(derived.failed[0]).toMatchObject({ proposalId: 'block', title: 'Block 0110-2207' });
        expect(derived.failed[0].reason).toMatch(/covers only \d+% of this building's footprint/);
        expect(derived.failed[0].reason).not.toMatch(/could not be materialized locally/);
    });
});
