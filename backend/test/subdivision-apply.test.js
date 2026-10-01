// Phase 4 of PARCEL-OPTIONAL.md, end to end through the real ProposalManager, live fabric and
// parcel-mutation transaction: a land readjustment on a site with open ground (a subdivision) forms
// its plots on the open-ground host — rootless plots with ground ids on bare ground, cadastral +
// ground provenance on a mixed site, no remainder for the host — unapply and replay restore the
// fabric exactly, and ground another proposal formed there is refused.
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

// The plan the editor saves for a subdivision: the street layout over the site, plots by ground.
function subdivisionPlan(site, { pool, shares }) {
    const layout = subdivision.streetPlotsLayout(site, { turf });
    const plot = (geometry, ownerKey, displayName) => ({
        ownerKey, displayName, percent: null, color: '#cccccc', source: 'street-plots', area: area(geometry), geometry,
        owners: [{ ownerKey, displayName, color: '#cccccc', share: 1 }]
    });
    const polygons = layout.plots.map(geometry => {
        const key = subdivision.ownerKeyByGround(geometry, pool, shares, { turf }) || subdivision.OPEN_GROUND_OWNER_KEY;
        const share = shares.find(entry => entry.ownerKey === key);
        return plot(geometry, key, share ? share.displayName : 'Open ground');
    });
    if (layout.street) polygons.push({ ...plot(layout.street, 'public-land', 'Public land'), use: 'street' });
    return { algorithm: 'street-plots', poolSource: 'site', poolGeometry: site, openGroundM2: pool.openGroundM2, polygons };
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

const BARE_SITE = rect(0, 0, 12, 6); // ≈ 108 m × 67 m: a street through the middle
const HR1 = parcel('HR-330264-1', rect(0, 0, 6, 6));
const MIXED_SITE = rect(3, 0, 15, 6); // half over HR-1, half over the hole beside it

describe('subdivision on bare ground (empty binding)', () => {
    it('forms rootless plots and a street on the open-ground host, and unapply/replay restore exactly', async () => {
        const record = subdivisionRecord('sub-bare', BARE_SITE, { binding: { parcels: [], coverage: 'none', source: 'server' } });
        const { manager, fabric } = await harness({ records: [record] });
        const spies = installOwnershipSpies();
        await expect(manager.applyProposal('sub-bare')).resolves.toBe(true);
        expect(manager.getLastApplyFailure('sub-bare')).toBeNull();

        const hash = await siteHash.siteHashHex(record.site);
        const pieces = fabric.list();
        expect(pieces).toHaveLength(record.reparcellization.polygons.length);
        pieces.forEach(piece => {
            expect(piece.properties.cadastreParcelIds).toEqual([]);
            expect(piece.properties.groundIds).toEqual([`ground:${hash}`]);
            expect(piece.properties.rootParcelId).toBeNull();
            expect(piece.properties.parcelId).toMatch(/^sub-bare-\d+$/);
            expect(openGround.isGroundPiece(piece)).toBe(true);
        });
        // The plots and the street are the whole site; nothing was minted for the host's rest.
        expect(pieces.reduce((sum, piece) => sum + area(piece), 0)).toBeCloseTo(area(BARE_SITE), 0);
        // Open ground stays ownerless; the street goes to the City.
        expect(spies.getOrCreateAgentForRecipient).not.toHaveBeenCalled();
        expect(spies.transferParcelOwnership.mock.calls.map(call => call[2])).toEqual(['city']);
        pieces.filter(piece => piece.properties.ownerKey === subdivision.OPEN_GROUND_OWNER_KEY)
            .forEach(piece => expect(piece.properties.ownershipDetails).toBeUndefined());
        // Never offered as cadastral parcels.
        expect(fabric.claimedCadastreIds().size).toBe(0);

        const applied = fabric.list().map(piece => [piece.properties.parcelId, JSON.stringify(piece.geometry)]).sort();
        await expect(manager.unapplyProposal('sub-bare')).resolves.toBe(true);
        expect(fabric.list()).toEqual([]);

        // Reload: the boot replay re-derives the same plots under the same ids.
        globalThis.proposalStorage.getProposal('sub-bare').applied = true;
        await expect(manager.rebuildAppliedFabric({ silent: true })).resolves.toMatchObject({ ok: true, applied: 1, failed: [] });
        expect(fabric.list().map(piece => [piece.properties.parcelId, JSON.stringify(piece.geometry)]).sort()).toEqual(applied);
    });

    it('mints nothing for open ground its plots leave uncovered (open ground has no remainder)', async () => {
        const record = subdivisionRecord('sub-part', BARE_SITE, { binding: { parcels: [], coverage: 'none' } });
        // Keep only the plots on one side of the street: half the site stays open ground.
        record.reparcellization.polygons = record.reparcellization.polygons.slice(0, 3);
        const planned = record.reparcellization.polygons.reduce((sum, polygon) => sum + area(polygon.geometry), 0);
        const { manager, fabric } = await harness({ records: [record] });
        installOwnershipSpies();
        await expect(manager.applyProposal('sub-part')).resolves.toBe(true);
        expect(fabric.list()).toHaveLength(3);
        expect(fabric.list().reduce((sum, piece) => sum + area(piece), 0)).toBeCloseTo(planned, 0);
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
    it('gives plots cadastral and/or ground provenance, a remainder only for the parcel, and unapply restores it', async () => {
        const record = subdivisionRecord('sub-mixed', MIXED_SITE, {
            declared: ['HR-330264-1'],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial', unsurveyedM2: 3600, source: 'server' },
            parcels: [{ id: 'HR-330264-1', geometry: HR1.geometry }]
        });
        // The pool: an owner's part over HR-1 and an ownerless open part, both plotted.
        const owners = new Set(record.reparcellization.polygons.map(polygon => polygon.ownerKey));
        expect(owners).toEqual(new Set(['owner:HR-330264-1', subdivision.OPEN_GROUND_OWNER_KEY, 'public-land']));
        const { manager, fabric } = await harness({ facts: [HR1], records: [record] });
        installOwnershipSpies();
        const before = fabric.list().map(piece => JSON.stringify(piece));

        await expect(manager.applyProposal('sub-mixed')).resolves.toBe(true);
        const hash = await siteHash.siteHashHex(record.site);
        const pieces = fabric.list();
        const plots = pieces.filter(piece => piece.properties.producedByProposalId === 'sub-mixed' && turf.booleanWithin(turf.centroid(piece), turf.feature(MIXED_SITE)));
        expect(plots).toHaveLength(record.reparcellization.polygons.length);
        const onParcel = plots.filter(piece => piece.properties.cadastreParcelIds.length);
        const onGround = plots.filter(piece => piece.properties.groundIds && piece.properties.groundIds.length);
        expect(onParcel.length).toBeGreaterThan(0);
        expect(onGround.length).toBeGreaterThan(0);
        onParcel.forEach(piece => expect(piece.properties.cadastreParcelIds).toEqual(['HR-330264-1']));
        onGround.forEach(piece => expect(piece.properties.groundIds).toEqual([`ground:${hash}`]));
        plots.filter(piece => !piece.properties.cadastreParcelIds.length)
            .forEach(piece => expect(piece.properties.parcelId).toMatch(/^sub-mixed-\d+$/));
        // Spanning plots (the street at least crosses the parcel edge) carry both.
        expect(plots.some(piece => piece.properties.cadastreParcelIds.length && piece.properties.groundIds)).toBe(true);
        // HR-1's part outside the site is its remainder, with its owner; the open ground has none.
        const rest = pieces.filter(piece => !plots.includes(piece));
        expect(rest).toHaveLength(1);
        expect(rest[0].properties.cadastreParcelIds).toEqual(['HR-330264-1']);
        expect(rest[0].properties.groundIds).toBeUndefined();
        expect(area(rest[0])).toBeCloseTo(area(rect(0, 0, 3, 6)), 0);
        expect(pieces.reduce((sum, piece) => sum + area(piece), 0)).toBeCloseTo(area(rect(0, 0, 15, 6)), 0);

        await expect(manager.unapplyProposal('sub-mixed')).resolves.toBe(true);
        expect(fabric.list().map(piece => JSON.stringify(piece))).toEqual(before);
        expect(liveIds(fabric)).toEqual(['HR-330264-1']);
    });

    it('keeps an ordinary readjustment on parcels exactly as before (no open ground, no ground ids)', async () => {
        const HR2 = parcel('HR-330264-2', rect(6, 0, 12, 6));
        const site = rect(0, 0, 12, 6);
        const record = subdivisionRecord('readjust', site, {
            declared: ['HR-330264-1', 'HR-330264-2'],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }, { parcelId: 'HR-330264-2' }], coverage: 'complete', source: 'server' },
            parcels: [{ id: 'HR-330264-1', geometry: HR1.geometry }, { id: 'HR-330264-2', geometry: HR2.geometry }]
        });
        expect(openGround.hasOpenGround(record)).toBe(false);
        const { manager, fabric } = await harness({ facts: [HR1, HR2], records: [record] });
        installOwnershipSpies();
        await expect(manager.applyProposal('readjust')).resolves.toBe(true);
        const pieces = fabric.list();
        expect(pieces).toHaveLength(record.reparcellization.polygons.length);
        pieces.forEach(piece => {
            expect(piece.properties.groundIds).toBeUndefined();
            expect(piece.properties.cadastreParcelIds.length).toBeGreaterThan(0);
            expect(piece.properties.parcelId.startsWith('HR-330264-')).toBe(true);
        });
        await expect(manager.unapplyProposal('readjust')).resolves.toBe(true);
        expect(liveIds(fabric)).toEqual(['HR-330264-1', 'HR-330264-2']);
    });
});
