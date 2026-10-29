// A formed piece is its shape cut to the parcels it consumes, and the pieces a formation writes must
// tile the ground they replace (docs/geometry-tolerances.md step 5): the map apply runs the fabric's
// partition check (live-fabric.js checkCadastreScope) before it writes, as a private read
// (agreement-headless.js) does, and refuses a design that fails it with the draft unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const status = require('../../frontend/js/proposals/status.js');
const footprintParts = require('../../frontend/js/proposals/footprint-parts.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const parcelArrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const parcelContiguity = require('../../frontend/js/proposals/parcel-contiguity.js');
const applyRoute = require('../../frontend/js/proposals/apply/route.js');
const applyStructures = require('../../frontend/js/proposals/apply/structures.js');
const finalize = require('../../frontend/js/proposals/apply/finalize.js');
const ground = require('../../frontend/js/geometry-tolerances.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const AgreementHeadless = require('../../frontend/js/agreement-headless.js');

// Two parcels side by side near Zagreb, in units of 1e-3 degree (~78 m east, ~111 m north):
// HR-A covers x 0..2, HR-B x 2..4 (y 0..2).
const LON = 15.96, LAT = 45.80, U = 1e-3;
const at = (x, y) => [LON + x * U, LAT + y * U];
const rect = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] });
const parcel = (id, geometry) => ({
    type: 'Feature',
    properties: { parcelId: id, cadastreParcelIds: [id], BROJ_CESTICE: id.slice(3) },
    geometry
});
const PARCELS = [parcel('HR-A', rect(0, 0, 2, 2)), parcel('HR-B', rect(2, 0, 4, 2))];

// A take over HR-A whose east edge carries a spike 0.4 mm wide reaching 5 cm into HR-B: debris by
// the shared rule (no 1 mm circle fits), so HR-B is no host, yet its tip lies 5 cm outside HR-A.
const SPIKE_HALF_WIDTH = 0.0002 / 111000 / U;
const SPIKE_LENGTH = 0.05 / 77600 / U;
const takeWithSpike = { type: 'Polygon', coordinates: [[
    at(1, 0.5), at(2, 0.5), at(2, 1 - SPIKE_HALF_WIDTH), at(2 + SPIKE_LENGTH, 1), at(2, 1 + SPIKE_HALF_WIDTH), at(2, 1.5), at(1, 1.5), at(1, 0.5)
]] };

const installed = new Map();
function install(name, value) {
    if (!installed.has(name)) installed.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    globalThis[name] = value;
}

beforeEach(() => {
    install('window', globalThis);
    install('turf', turf);
    install('__formationEdit', formationEdit);
    install('__parcelArrangement', parcelArrangement);
    install('__applyRoute', applyRoute);
    install('__planOrder', planOrder);
    install('__footprintParts', footprintParts);
    install('__parcelContiguity', parcelContiguity);
    install('GeometryTolerances', ground);
    install('ProposalApplyStructures', applyStructures);
    install('createLiveParcelFabric', createLiveParcelFabric);
    install('ProposalManager', ProposalManager);
    install('appliedOf', status.isApplied);
    install('lifecycleOf', status.getLifecycleStatus);
    install('persistAppliedProposal', finalize.persistAppliedProposal);
    install('refreshProposalUIAfterApply', finalize.refreshProposalUIAfterApply);
    install('_normalizeProposalId', value => (value === undefined || value === null ? null : String(value)));
    install('_resolveRootParcelNumberFromProperties', props => (props && (props.rootParcelNumber || props.BROJ_CESTICE)) || '');
    install('_calculateGeoJsonArea', geometry => turf.area(turf.feature(geometry)));
    install('updateStatus', () => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    installed.forEach(({ existed, value }, name) => {
        if (existed) globalThis[name] = value; else delete globalThis[name];
    });
    installed.clear();
});

// The map side: the real ProposalManager over a live-fabric draft seeded with the two parcels.
async function mapApply() {
    const fabric = createLiveParcelFabric({ geometry: turf });
    const seed = fabric.beginMutation({ kind: 'test-seed' });
    seed.seedCadastre(structuredClone(PARCELS));
    await seed.prepare();
    seed.publish();
    const mutation = fabric.beginMutation({ kind: 'apply' });
    const failures = [];
    const manager = Object.create(ProposalManager);
    manager._lastApplyFailureByProposalId = new Map();
    manager._setLastApplyFailure = (_id, failure) => { failures.push(failure); };
    manager._markParcelProducedByProposal = () => {};
    manager._appliedRoadOverlappedByTaking = () => null;
    const options = { _parcelMutation: { fabric: mutation } };
    const form = take => manager._formBuildingParcel('p-b', { title: 'Corner house', author: 'Ana' }, {}, take,
        ['HR-A', 'HR-B'], 'p-b', mutation.getMany(['HR-A', 'HR-B']).features, options);
    return { mutation, failures, form };
}

// The private read: the same building as a design row over the same two parcels.
function headlessRead(take) {
    const content = {
        goal: 'single',
        title: 'Corner house',
        author: 'Ana',
        authoredAt: '2026-01-01T00:00:00.000Z',
        buildingProposal: {},
        geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: take }] }
    };
    return AgreementHeadless.materialize({
        designs: [{ cid: 'p-b', content, parcelIds: ['HR-A', 'HR-B'] }],
        parcels: structuredClone(PARCELS).map(feature => ({ ...feature, id: feature.properties.parcelId }))
    });
}

// Every vertex of `piece` inside `host` or on its boundary within NOISE_M.
function verticesOutside(piece, host) {
    const ring = turf.polygonToLine(host);
    return turf.coordAll(piece).filter(vertex => !turf.booleanPointInPolygon(vertex, host)
        && turf.pointToLineDistance(vertex, ring, { units: 'meters' }) > ground.NOISE_M);
}

// Drops every remainder a building formation mints: its pieces then leave a hole in their host.
function dropRemainders() {
    const assign = ProposalManager._assignSyntheticChildIdentities;
    vi.spyOn(ProposalManager, '_assignSyntheticChildIdentities').mockImplementation(function (proposalId, children, opts) {
        assign.call(this, proposalId, children, opts);
        children.splice(1);
    });
}

describe('a formed piece is its shape cut to the parcels it consumes', () => {
    it('cuts off the spike the shared rule calls debris, so no vertex lies outside its parcel', async () => {
        expect(verticesOutside(turf.feature(takeWithSpike), PARCELS[0]).length).toBeGreaterThan(0);
        expect(ground.isGround(turf, ground.uncoveredBy(turf, turf.feature(takeWithSpike), [PARCELS[0]]))).toBe(false);
        const { mutation, failures, form } = await mapApply();
        const result = await form(takeWithSpike);
        expect(failures).toEqual([]);
        expect(result.ok).toBe(true);
        const building = mutation.list().find(feature => feature.properties.buildingParcel);
        expect(building.properties.cadastreParcelIds).toEqual(['HR-A']);
        expect(verticesOutside(building, PARCELS[0])).toEqual([]);
        // HR-B was never consumed and the result tiles both parcels.
        expect(mutation.get('HR-B')).toBeTruthy();
        expect(mutation.checkCadastreScope(['HR-A', 'HR-B'])).toMatchObject({ cadastreIds: expect.arrayContaining(['HR-A', 'HR-B']) });
        mutation.rollback();
    });
});

describe('the map apply runs the partition check before it writes', () => {
    it('refuses a design whose pieces would leave a hole, naming it, with the draft unchanged', async () => {
        dropRemainders();
        const { mutation, failures, form } = await mapApply();
        const before = mutation.list();
        const result = await form(rect(1, 0.5, 3, 1.5));
        expect(result.ok).toBe(false);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ code: 'formation-partition-invalid', partitionCode: 'live-fabric-replacement-hole' });
        expect(failures[0].message).toContain('Corner house');
        expect(mutation.list()).toEqual(before);
        mutation.rollback();
    });

    it('widens the checked scope to every parcel a piece in it also occupies', async () => {
        const { mutation } = await mapApply();
        const merged = parcel('HR-AB#p-1', rect(0, 0, 4, 2));
        merged.properties.cadastreParcelIds = ['HR-A', 'HR-B'];
        merged.properties.producedByProposalId = 'p-merge';
        expect(mutation.checkCadastreScope(['HR-A'], { remove: ['HR-A', 'HR-B'], add: [merged] }))
            .toEqual({ cadastreIds: ['HR-A', 'HR-B'], pieces: 1 });
        mutation.rollback();
    });
});

describe('the private read and the map apply give the same verdict', () => {
    it('accepts the same design with the same pieces', async () => {
        const { mutation, form } = await mapApply();
        expect((await form(rect(1, 0.5, 3, 1.5))).ok).toBe(true);
        const mapPieces = mutation.list().map(feature => feature.geometry).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        mutation.rollback();
        const read = await headlessRead(rect(1, 0.5, 3, 1.5));
        const readPieces = read.fabric.list().map(feature => feature.geometry).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        expect(readPieces).toEqual(mapPieces);
    });

    it('refuses the same design with the same code', async () => {
        dropRemainders();
        const { mutation, failures, form } = await mapApply();
        expect((await form(rect(1, 0.5, 3, 1.5))).ok).toBe(false);
        mutation.rollback();
        await expect(headlessRead(rect(1, 0.5, 3, 1.5))).rejects.toMatchObject({ code: failures[0].code });
        expect(failures[0].code).toBe('formation-partition-invalid');
    });
});
