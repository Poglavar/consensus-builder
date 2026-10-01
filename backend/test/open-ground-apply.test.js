// Phase 3 of PARCEL-OPTIONAL.md, end to end through the real ProposalManager, live fabric and
// parcel-mutation transaction: a proposal's open ground is hosted as `ground:<siteHash>` derived from
// its site and its binding, formations stand on it beside cadastral parcels, unapply restores the
// fabric exactly, proposals on the same bare ground interact geometrically, and corridors cross open
// ground without a cadastral arrangement.
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

const SITE_HALF = rect(10, 0, 30, 10);
const HR1 = parcel('HR-330264-1', rect(0, 0, 20, 10));

function structureRecord(id, kind, geometry, { declared = [], binding = null, site = geometry, applied = false } = {}) {
    const record = {
        proposalId: id,
        title: id,
        goal: kind,
        applied,
        createdAt: `2026-10-01T00:00:0${id.length % 10}.000Z`,
        cadastreParcelIds: declared,
        site: { type: 'MultiPolygon', coordinates: [site.coordinates] },
        structureProposal: { kind, geometry }
    };
    if (binding) record.binding = binding;
    return record;
}

const liveIds = fabric => fabric.list().map(feature => feature.properties.parcelId).sort();

describe('open-ground host on a partially surveyed site', () => {
    it('applies a square half over a parcel and half over open ground, then unapply restores exactly', async () => {
        const square = structureRecord('sq-hole', 'square', SITE_HALF, {
            declared: ['HR-330264-1'],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial', unsurveyedM2: 1000, source: 'server' }
        });
        const { manager, fabric } = await harness({ facts: [HR1], records: [square] });
        const before = fabric.list().map(feature => JSON.stringify(feature.geometry));

        await expect(manager.applyProposal('sq-hole')).resolves.toBe(true);
        expect(manager.getLastApplyFailure('sq-hole')).toBeNull();
        const hash = await siteHash.siteHashHex(square.site);
        const pieces = fabric.list();
        const body = pieces.find(feature => feature.properties.structureType === 'square');
        expect(body).toBeTruthy();
        // The body is exactly the site: on the parcel AND on the open ground beside it.
        expect(turf.area(body)).toBeCloseTo(turf.area(turf.feature(SITE_HALF)), 0);
        expect(body.properties.cadastreParcelIds).toEqual(['HR-330264-1']);
        expect(body.properties.groundIds).toEqual([`ground:${hash}`]);
        // The parcel's outside part stays a piece of that parcel, with its owner.
        const remainder = pieces.find(feature => feature !== body);
        expect(remainder.properties.cadastreParcelIds).toEqual(['HR-330264-1']);
        expect(remainder.properties.ownershipDetails.owners[0].name).toBe('Owner HR-330264-1');
        expect(turf.area(remainder)).toBeCloseTo(turf.area(turf.feature(rect(0, 0, 10, 10))), 0);
        expect(pieces).toHaveLength(2);
        expect(globalThis.squares).toHaveLength(1);

        await expect(manager.unapplyProposal('sq-hole')).resolves.toBe(true);
        expect(fabric.list().map(feature => JSON.stringify(feature.geometry))).toEqual(before);
        expect(liveIds(fabric)).toEqual(['HR-330264-1']);
        expect(globalThis.squares).toHaveLength(0);
    });

    it('derives the host from the binding, never from a gap in loaded parcels', async () => {
        // The binding says HR-1 covers the whole site (coverage complete), but locally HR-1 covers
        // only half of it. That gap is a disagreement with the cadastre, not open ground: refused.
        const record = structureRecord('park-complete', 'park', SITE_HALF, {
            declared: ['HR-330264-1'],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'complete', source: 'server' }
        });
        expect(openGround.hasOpenGround(record)).toBe(false);
        const { manager, fabric } = await harness({ facts: [HR1], records: [record] });
        await expect(manager.applyProposal('park-complete')).resolves.toBe(false);
        expect(liveIds(fabric)).toEqual(['HR-330264-1']);
        expect(fabric.list().some(feature => openGround.groundIdsOf(feature).length)).toBe(false);

        // And a bound parcel the repository does not have is absent ground, never open ground.
        const absent = structureRecord('park-absent', 'park', SITE_HALF, {
            declared: ['HR-330264-1', 'HR-330264-2'],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }, { parcelId: 'HR-330264-2' }], coverage: 'partial', source: 'server' }
        });
        globalThis.proposalStorage.proposals.set('park-absent', absent);
        await expect(manager.applyProposal('park-absent')).rejects.toMatchObject({ code: 'cadastral-ground-absent' });
        expect(liveIds(fabric)).toEqual(['HR-330264-1']);
    });

    it('refuses rather than hosting when a bound parcel is missing from the repository', async () => {
        const record = structureRecord('park-missing', 'park', SITE_HALF, {
            declared: ['HR-330264-9'],
            binding: { parcels: [{ parcelId: 'HR-330264-9' }], coverage: 'partial', source: 'server' }
        });
        await expect(Promise.resolve().then(() => openGround.openGroundHost(record, {
            parcels: [], siteHashHex: 'a'.repeat(64)
        }))).rejects.toMatchObject({ code: 'open-ground-parcels-missing' });
    });
});

describe('formations on bare ground (empty binding)', () => {
    it('mints a park with no cadastral ids, rootless and never declarable', async () => {
        const park = structureRecord('park-bare', 'park', rect(0, 0, 10, 10), {
            binding: { parcels: [], coverage: 'none', source: 'client-preview' }
        });
        const { manager, fabric, repository } = await harness({ records: [park] });
        await expect(manager.applyProposal('park-bare')).resolves.toBe(true);
        const [body] = fabric.list();
        expect(body.properties.cadastreParcelIds).toEqual([]);
        expect(openGround.isGroundPiece(body)).toBe(true);
        expect(body.properties.parcelId).toBe('park-bare-1');
        // A ground piece is never offered as a cadastral parcel.
        expect(fabric.cadastreIdsForParcelIds([body.properties.parcelId])).toEqual([]);
        expect(fabric.claimedCadastreIds().size).toBe(0);
        // No client-side "parcels under the footprint" lookup for open ground.
        expect(repository.calls).toEqual([]);

        await expect(manager.unapplyProposal('park-bare')).resolves.toBe(true);
        expect(fabric.list()).toEqual([]);
        expect(globalThis.parks).toEqual([]);
    });

    it('applies a block of buildings on a drawn site with no parcels', async () => {
        const block = {
            proposalId: 'block-bare',
            title: 'Block',
            goal: 'buildings',
            applied: false,
            createdAt: '2026-10-01T00:00:00.000Z',
            cadastreParcelIds: [],
            site: { type: 'MultiPolygon', coordinates: [rect(0, 0, 20, 20).coordinates] },
            binding: { parcels: [], coverage: 'none', source: 'client-preview' },
            buildingProposal: { type: 'block' },
            geometry: { buildings: [turf.feature(rect(2, 2, 8, 8)), turf.feature(rect(12, 12, 18, 18))] }
        };
        const { manager, fabric } = await harness({ records: [block] });
        await expect(manager.applyProposal('block-bare')).resolves.toBe(true);
        expect(globalThis.proposedBuildings).toHaveLength(2);
        expect(fabric.list()).toEqual([]);
        await expect(manager.unapplyProposal('block-bare')).resolves.toBe(true);
        expect(globalThis.proposedBuildings).toHaveLength(0);
    });

    it('forms a freeform building parcel over a parcel and open ground, remainder only for the parcel', async () => {
        const single = {
            proposalId: 'house',
            title: 'House',
            goal: 'single',
            author: 'Ana',
            applied: false,
            createdAt: '2026-10-01T00:00:00.000Z',
            cadastreParcelIds: ['HR-330264-1'],
            site: { type: 'MultiPolygon', coordinates: [SITE_HALF.coordinates] },
            binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial', source: 'server' },
            buildingProposal: {},
            geometry: { buildings: [turf.feature(rect(15, 2, 25, 8))] }
        };
        const { manager, fabric } = await harness({ facts: [HR1], records: [single] });
        await expect(manager.applyProposal('house')).resolves.toBe(true);
        const pieces = fabric.list();
        const building = pieces.find(feature => feature.properties.buildingParcel === true);
        expect(building.properties.cadastreParcelIds).toEqual(['HR-330264-1']);
        expect(building.properties.groundIds).toHaveLength(1);
        const others = pieces.filter(feature => feature !== building);
        // Every other piece is HR-1's remainder; nothing was minted on the rest of the open ground.
        others.forEach(feature => expect(feature.properties.cadastreParcelIds).toEqual(['HR-330264-1']));
        const remainderArea = others.reduce((sum, feature) => sum + turf.area(feature), 0);
        expect(remainderArea).toBeCloseTo(turf.area(HR1) - turf.area(turf.feature(rect(15, 2, 20, 8))), -1);
        await expect(manager.unapplyProposal('house')).resolves.toBe(true);
        expect(liveIds(fabric)).toEqual(['HR-330264-1']);
    });

    it('applies a station stored with a partial preview binding', async () => {
        const station = {
            proposalId: 'station-edge',
            title: 'Station',
            goal: 'station',
            applied: false,
            createdAt: '2026-10-01T00:00:00.000Z',
            cadastreParcelIds: ['HR-330264-1'],
            binding: { parcels: [{ parcelId: 'HR-330264-1', overlapM2: null, intrusionM: null }], touched: [], coverage: 'partial', source: 'client-preview' },
            structureProposal: { kind: 'station', stationType: 'tram', geometry: rect(15, 2, 25, 4) }
        };
        const { manager } = await harness({ facts: [HR1], records: [station] });
        await expect(manager.applyProposal('station-edge')).resolves.toBe(true);
        expect(globalThis.transitStations).toHaveLength(1);
    });
});

describe('geometric interaction on open ground', () => {
    function bareRoad(id, polygon, extra = {}) {
        return {
            proposalId: id,
            title: id,
            goal: 'road-track',
            applied: false,
            createdAt: '2026-10-02T00:00:00.000Z',
            cadastreParcelIds: [],
            roadProposal: {
                id,
                definition: {
                    polygon,
                    points: [[LAT + 5 * U, LON - 5 * U], [LAT + 5 * U, LON + 40 * U]],
                    width: 6
                }
            },
            ...extra
        };
    }

    it('closes over standing proposals whose sites intersect on open ground, through an index', async () => {
        const seed = structureRecord('seed', 'park', rect(0, 0, 10, 10), { binding: { parcels: [], coverage: 'none' } });
        const overlapping = structureRecord('neighbour', 'square', rect(8, 0, 18, 10), { applied: true, binding: { parcels: [], coverage: 'none' } });
        const chained = structureRecord('chained', 'lake', rect(16, 0, 26, 10), { applied: true, binding: { parcels: [], coverage: 'none' } });
        const far = structureRecord('far', 'park', rect(500, 500, 510, 510), { applied: true, binding: { parcels: [], coverage: 'none' } });
        const touching = structureRecord('touching', 'park', rect(10, 20, 20, 30), { applied: true, binding: { parcels: [], coverage: 'none' } });
        const { manager } = await harness({ records: [seed, overlapping, chained, far, touching] });

        const closure = manager._localFormationClosure([seed], []);
        expect(closure.records.map(record => record.proposalId).sort()).toEqual(['chained', 'neighbour', 'seed']);
    });

    it('lets a cadastral-only plan skip the geometric pass entirely', async () => {
        const a = { proposalId: 'a', applied: true, cadastreParcelIds: ['HR-1'] };
        const b = { proposalId: 'b', applied: true, cadastreParcelIds: ['HR-2'] };
        const { manager } = await harness({ records: [a, b] });
        expect(manager._openGroundInteractions([a], [a, b])).toBeNull();
    });

    it('takes an overlapping bare-ground proposal off the map when another is applied on the same spot', async () => {
        const first = structureRecord('first', 'park', rect(0, 0, 10, 10), { binding: { parcels: [], coverage: 'none' } });
        const second = structureRecord('second', 'square', rect(5, 0, 15, 10), { binding: { parcels: [], coverage: 'none' } });
        const supersession = require('../../frontend/js/proposal-supersession.js');
        install('collectAppliedProposalAlternatives', supersession.collectAppliedProposalAlternatives);
        const { manager, fabric } = await harness({ records: [first, second] });
        await expect(manager.applyProposal('first')).resolves.toBe(true);
        await expect(manager.applyProposal('second')).resolves.toBe(true);
        expect(globalThis.proposalStorage.getProposal('first').applied).toBe(false);
        expect(fabric.list().map(feature => feature.properties.producedByProposalId)).toEqual(['second']);
    });
});

describe('two proposals on the same open ground', () => {
    it('lets the newer take the older one\'s ground piece, without double cover, and gives it back on unapply', async () => {
        const older = structureRecord('older', 'park', rect(0, 0, 10, 10), { binding: { parcels: [], coverage: 'none' } });
        const newer = structureRecord('newer', 'square', rect(6, 0, 16, 10), { binding: { parcels: [], coverage: 'none' } });
        newer.createdAt = '2026-10-03T00:00:00.000Z';
        const { manager, fabric } = await harness({ records: [older, newer] });
        await expect(manager.applyProposal('older')).resolves.toBe(true);
        // The create path (instant create) derives the new record without parking the older one.
        await expect(manager.deriveForNewProposal(globalThis.proposalStorage.getProposal('newer'))).resolves.toMatchObject({ ok: true, goalKey: 'square' });

        const pieces = fabric.list();
        const area = feature => turf.area(feature);
        const union = pieces.reduce((acc, feature) => (acc ? turf.union(acc, feature) : feature), null);
        // A partition: the pieces' areas add up to their union (no ground covered twice).
        expect(pieces.reduce((sum, feature) => sum + area(feature), 0)).toBeCloseTo(area(union), 0);
        const newerBody = pieces.find(feature => feature.properties.producedByProposalId === 'newer');
        expect(area(newerBody)).toBeCloseTo(area(turf.feature(rect(6, 0, 16, 10))), 0);
        const olderLeft = pieces.filter(feature => feature.properties.producedByProposalId === 'older');
        expect(olderLeft).toHaveLength(1);
        expect(olderLeft[0].properties.parcelId).toBe('older-1');
        expect(area(olderLeft[0])).toBeCloseTo(area(turf.feature(rect(0, 0, 6, 10))), 0);
        expect(newerBody.properties.groundIds).toHaveLength(2);

        await expect(manager.unapplyProposal('newer')).resolves.toBe(true);
        const after = fabric.list();
        expect(after).toHaveLength(1);
        expect(after[0].properties.parcelId).toBe('older-1');
        expect(area(after[0])).toBeCloseTo(area(turf.feature(rect(0, 0, 10, 10))), 0);
    });
});

describe('boot replay of a plan on open ground only', () => {
    it('re-derives every applied record when there is no cadastre at all (explore)', async () => {
        const park = structureRecord('park-boot', 'park', rect(0, 0, 10, 10), { applied: true, binding: { parcels: [], coverage: 'none' } });
        const square = structureRecord('square-boot', 'square', rect(5, 0, 15, 10), { applied: true, binding: { parcels: [], coverage: 'none' } });
        square.createdAt = '2026-10-03T00:00:00.000Z';
        const { manager, fabric } = await harness({ records: [park, square] });
        const result = await manager.rebuildAppliedFabric({ silent: true });
        expect(result).toMatchObject({ ok: true, applied: 2, failed: [] });
        expect(fabric.list().map(feature => feature.properties.producedByProposalId).sort()).toEqual(['park-boot', 'square-boot']);
        expect(globalThis.parks).toHaveLength(1);
        expect(globalThis.squares).toHaveLength(1);
        // A second rebuild is a no-op on the result (stale ground pieces are reset, not duplicated).
        const again = await manager.rebuildAppliedFabric({ silent: true });
        expect(again).toMatchObject({ ok: true, applied: 2 });
        expect(fabric.list()).toHaveLength(2);
    });
});

describe('corridors on bare ground', () => {
    it('applies a road with an empty declaration and no arrangement on open ground', async () => {
        const road = {
            proposalId: 'road-bare',
            title: 'Road',
            goal: 'road-track',
            applied: false,
            createdAt: '2026-10-02T00:00:00.000Z',
            cadastreParcelIds: [],
            roadProposal: { definition: { polygon: rect(-5, 4, 40, 6), points: [[LAT, LON], [LAT, LON + 4e-3]], width: 6 } }
        };
        const HR2 = parcel('HR-330264-2', rect(100, 0, 110, 10));
        const { manager, fabric } = await harness({ facts: [HR1, HR2], records: [road] });
        await expect(manager.applyProposal('road-bare')).resolves.toBe(true);
        expect(globalThis.proposalStorage.getProposal('road-bare').applied).toBe(true);
        expect(liveIds(fabric)).toEqual(['HR-330264-1', 'HR-330264-2']);
        // A later cadastral derivation with that road standing does not trip over its empty scope.
        await expect(manager.integrateCadastralGround([HR2])).resolves.toMatchObject({ ok: true });
    });

    it('still refuses a corridor whose binding names parcels its declaration lacks', async () => {
        const road = {
            proposalId: 'road-undeclared',
            title: 'Road',
            goal: 'road-track',
            applied: true,
            cadastreParcelIds: [],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'complete' },
            roadProposal: { definition: { polygon: rect(-5, 4, 40, 6), points: [[LAT, LON], [LAT, LON + 4e-3]], width: 6 } }
        };
        const HR2 = parcel('HR-330264-2', rect(100, 0, 110, 10));
        const { manager } = await harness({ facts: [HR1, HR2], records: [road] });
        await expect(manager.integrateCadastralGround([HR2]))
            .rejects.toMatchObject({ code: 'corridor-cadastre-scope-missing' });
    });
});

describe('the site rule for parcels a structure covers in part', () => {
    it('cuts the parcel at the body edge outside a replay too, keeping its outside part with its owner', async () => {
        const drawn = structureRecord('sq-partial', 'square', rect(5, 0, 15, 10), {
            declared: ['HR-330264-1'],
            binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'complete', source: 'server' }
        });
        const { manager, fabric } = await harness({ facts: [HR1], records: [drawn] });
        const [hr1] = fabric.list();
        const options = {
            _parcelMutation: {
                fabric: fabric.beginMutation({ kind: 'test' }),
                storage: { getItem: () => null, setItem() {}, removeItem() {}, forEach() {} },
                agents: null,
                afterCommit() {}
            }
        };
        manager._rebuildInProgress = false;
        const result = await manager._formStructureParcel('sq-partial', drawn, { kind: 'square' }, rect(5, 0, 15, 10),
            ['HR-330264-1'], 'sq-partial', [hr1], options);
        expect(result.ok).toBe(true);
        const pieces = options._parcelMutation.fabric.list();
        const body = pieces.find(feature => feature.properties.structureType === 'square');
        expect(turf.area(body)).toBeCloseTo(turf.area(turf.feature(rect(5, 0, 15, 10))), 0);
        const outside = pieces.filter(feature => feature !== body);
        expect(outside.length).toBe(2);
        outside.forEach(feature => {
            expect(feature.properties.cadastreParcelIds).toEqual(['HR-330264-1']);
            expect(feature.properties.ownershipDetails.owners[0].name).toBe('Owner HR-330264-1');
        });
        options._parcelMutation.fabric.rollback();
    });
});

// The road tool offers "Build through" when a road crosses an applied park/square/lake ("the road
// cuts through; the rest stays as it is"). Apply must agree: a corridor later in the formation order
// takes its ground out of the structure, on open ground and on cadastral ground alike, and an older
// road still refuses a newer structure over it (nothing is built over a street).
describe('a road built through an applied park', () => {
    const PARK = rect(0, 0, 20, 10);
    const supersession = require('../../frontend/js/proposal-supersession.js');
    const ROAD = rect(-5, 4, 40, 6);
    const road = (id, extra = {}) => ({
        proposalId: id,
        title: id,
        goal: 'road-track',
        applied: false,
        createdAt: '2026-10-02T00:00:00.000Z',
        cadastreParcelIds: [],
        roadProposal: { id, definition: { polygon: ROAD, points: [[LAT + 5 * U, LON - 5 * U], [LAT + 5 * U, LON + 40 * U]], width: 6 } },
        ...extra
    });
    const areaOf = geometry => turf.area(turf.feature(geometry));
    const overlap = (a, b) => {
        const hit = turf.intersect(turf.feature(a), turf.feature(b));
        return hit ? turf.area(hit) : 0;
    };

    it('cuts a bare-ground park in two where the road crosses, and gives it back on unapply', async () => {
        const park = structureRecord('bt-park', 'park', PARK, { binding: { parcels: [], coverage: 'none' } });
        const authored = JSON.stringify(park.structureProposal.geometry);
        const { manager, fabric } = await harness({ records: [park, road('bt-road')] });
        // Explicit "Apply to map" checks applied alternatives: a crossed park is not one.
        install('collectAppliedProposalAlternatives', supersession.collectAppliedProposalAlternatives);
        await expect(manager.applyProposal('bt-park')).resolves.toBe(true);

        await expect(manager.applyProposal('bt-road')).resolves.toBe(true);
        const parkPieces = fabric.list().filter(feature => feature.properties.structureType === 'park');
        expect(parkPieces).toHaveLength(2);
        const expected = areaOf(PARK) - overlap(PARK, ROAD);
        expect(parkPieces.reduce((sum, feature) => sum + turf.area(feature), 0)).toBeCloseTo(expected, -1);
        parkPieces.forEach(feature => expect(overlap(feature.geometry, ROAD)).toBeLessThan(0.25));
        // The drawn park is the carved body too, and the record keeps its authored geometry.
        expect(globalThis.parks).toHaveLength(1);
        expect(overlap(globalThis.parks[0].geometry, ROAD)).toBeLessThan(0.25);
        expect(JSON.stringify(globalThis.proposalStorage.getProposal('bt-park').structureProposal.geometry)).toBe(authored);

        await expect(manager.unapplyProposal('bt-road')).resolves.toBe(true);
        const whole = fabric.list().filter(feature => feature.properties.structureType === 'park');
        expect(whole).toHaveLength(1);
        expect(turf.area(whole[0])).toBeCloseTo(areaOf(PARK), -1);
    });

    it('cuts a park on a cadastral parcel, with no double cover of the parcel', async () => {
        const P = parcel('HR-330264-7', rect(-10, -5, 50, 15));
        const declared = { declared: ['HR-330264-7'], binding: { parcels: [{ parcelId: 'HR-330264-7' }], coverage: 'complete', source: 'server' } };
        const park = structureRecord('park-cad', 'park', PARK, declared);
        const { manager, fabric } = await harness({ facts: [P], records: [park, road('road-cad', { cadastreParcelIds: ['HR-330264-7'], binding: declared.binding })] });
        await expect(manager.applyProposal('park-cad')).resolves.toBe(true);

        // The road tool's create path (what follows the "Build through" prompt).
        await expect(manager.deriveForNewProposal(globalThis.proposalStorage.getProposal('road-cad'))).resolves.toMatchObject({ ok: true });
        expect(manager.getLastApplyFailure('road-cad')).toBeNull();
        const pieces = fabric.list();
        const parkPieces = pieces.filter(feature => feature.properties.structureType === 'park');
        const roadPieces = pieces.filter(feature => feature.properties.producedByProposalId === 'road-cad');
        expect(parkPieces).toHaveLength(2);
        expect(roadPieces).toHaveLength(1);
        parkPieces.forEach(feature => expect(overlap(feature.geometry, roadPieces[0].geometry)).toBeLessThan(0.25));
        // The pieces partition the parcel exactly.
        expect(pieces.reduce((sum, feature) => sum + turf.area(feature), 0)).toBeCloseTo(turf.area(P), -1);
    });

    it('still refuses a newer park laid over an applied road', async () => {
        const older = road('road-first', { createdAt: '2026-09-30T00:00:00.000Z' });
        const park = structureRecord('park-later', 'park', PARK, { binding: { parcels: [], coverage: 'none' } });
        const { manager, fabric } = await harness({ records: [older, park] });
        await expect(manager.applyProposal('road-first')).resolves.toBe(true);
        await expect(manager.applyProposal('park-later')).resolves.toBe(false);
        expect(manager.getLastApplyFailure('park-later')).toMatch(/stand on .* of the applied road/);
        expect(fabric.list().some(feature => feature.properties.structureType === 'park')).toBe(false);
    });

    it('keeps stored decorations to the carved ground', () => {
        const { decorationsOnGround } = require('../../frontend/js/proposals/apply/structures.js');
        const at = (x, y) => [LON + x * U, LAT + y * U];
        const carved = turf.difference(turf.feature(PARK), turf.feature(ROAD)).geometry;
        const out = decorationsOnGround({
            trees: [at(2, 2), at(2, 5), at(2, 8)],
            paths: [[at(1, 1), at(1, 3), at(1, 5), at(1, 7), at(1, 9)]],
            ponds: [[at(3, 7), at(5, 7), at(5, 9), at(3, 7)], [at(3, 3), at(5, 3), at(5, 5), at(3, 3)]],
            fountain: at(10, 5),
            version: 3
        }, carved, turf);
        expect(out.trees).toEqual([at(2, 2), at(2, 8)]);
        expect(out.paths).toEqual([[at(1, 1), at(1, 3)], [at(1, 7), at(1, 9)]]);
        expect(out.ponds).toEqual([[at(3, 7), at(5, 7), at(5, 9), at(3, 7)]]);
        expect(out.fountain).toBeNull();
        expect(out.version).toBe(3);
    });
});
