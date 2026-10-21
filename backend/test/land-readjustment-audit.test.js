// Ownership carried over to the parcels a layout forms (plan-design-agreement.md, M1 (a)): a plot
// inside one parcel keeps that parcel's owner, a plot straddling several is held jointly with
// pro-rata shares, ground with no recorded owner stays unowned, and a remainder keeps its parent's
// owner. The layout never names an owner; the real agents.js helpers write the per-piece records.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const contiguity = require('../../frontend/js/proposals/parcel-contiguity.js');
const { _applyParcelLayoutProposal } = require('../../frontend/js/proposals/apply/parcels.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
require('../../frontend/js/proposal-parcel-identity.js');
const agentsSource = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');

const saved = {};
const globalKeys = [
    '_normalizeProposalId', 'updateStatus', 'turf', 'window',
    '_resolveRootParcelIdFromProperties', '_resolveRootParcelNumberFromProperties',
    '_calculateGeoJsonArea', 'persistAppliedProposal', 'refreshProposalUIAfterApply',
    'transferParcelOwnership', 'getOrCreateJointPoolAgent', 'getOrCreateCityAgent', 'getOrCreateAgentForRecipient'
];

// Rectangles near Zagreb in units of 1e-3 degree (≈ 78 m east, 111 m north).
function rect(x0, y0, x1, y1) {
    const LON = 15.96, LAT = 45.80;
    return {
        type: 'Polygon',
        coordinates: [[
            [LON + x0 * 1e-3, LAT + y0 * 1e-3], [LON + x1 * 1e-3, LAT + y0 * 1e-3],
            [LON + x1 * 1e-3, LAT + y1 * 1e-3], [LON + x0 * 1e-3, LAT + y1 * 1e-3],
            [LON + x0 * 1e-3, LAT + y0 * 1e-3]
        ]]
    };
}

// Three cadastral parcels side by side, each with the registry owners the parcel panel shows.
const parcel = (id, x0, x1) => ({
    type: 'Feature', geometry: rect(x0, 0, x1, 2), properties: {
        parcelId: id, BROJ_CESTICE: id.slice(3), rootParcelId: id, rootParcelNumber: id.slice(3), cadastreParcelIds: [id],
        ownershipDetails: { owners: [{ name: `Registry owner of ${id}`, percentageShare: 100 }] }
    }
});
const HR_A = () => parcel('HR-A', 0, 2);
const HR_B = () => parcel('HR-B', 2, 4);
const HR_C = () => parcel('HR-C', 4, 6);

// The browser-local owner records (parcel_<id>_owner → agent id) of the parcel mutation.
function storageOf(rows) {
    const map = new Map(Object.entries(rows));
    return {
        rows: map,
        getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
        setItem: (key, value) => map.set(String(key), String(value)),
        removeItem: key => map.delete(String(key)),
        forEach: iterator => map.forEach((value, key) => iterator(value, key))
    };
}

function agentsOf(list) {
    const agents = new Map(list.map(agent => [agent.id, { ...agent }]));
    return {
        agents,
        getAgent: id => agents.get(id),
        getAllAgents: () => Array.from(agents.values()),
        addAgent: agent => { agents.set(agent.id, agent); return agent.id; },
        updateAgent: (id, updates) => { if (agents.has(id)) Object.assign(agents.get(id), updates); }
    };
}

const PEOPLE = [{ id: 'agent-ana', name: 'Ana' }, { id: 'agent-boris', name: 'Boris' }];

// agents.js run as the browser runs it; any write to the global store would be a leak out of the
// transaction, so that store refuses writes.
function realAgentHelpers() {
    const context = {
        console: { ...console, log: () => {} }, Date, Math, JSON, Set, Map, Array, String, Number, Object, window: {},
        PersistentStorage: { getItem: () => null, setItem: () => { throw new Error('global store write'); }, ensureReady: fn => fn() }
    };
    vm.createContext(context);
    vm.runInContext(agentsSource, context);
    return context;
}

function manager(parents) {
    return {
        added: [],
        _resolveLiveFormationParents: () => ({
            ok: true,
            ids: parents.map(feature => feature.properties.parcelId),
            cadastreIds: parents.map(feature => feature.properties.parcelId),
            features: parents
        }),
        _assignSyntheticChildIdentities(...args) { return ProposalManager._assignSyntheticChildIdentities(...args); },
        _addFeaturesToMap(features) { this.added.push(...features); },
        _markParcelProducedByProposal: vi.fn(),
        _consumeFeaturesFromLiveFabric: vi.fn(),
        _setLastApplyFailure: vi.fn(),
        _applyParcelLayoutProposal
    };
}

function layoutRecord(pool, plots) {
    return {
        goal: 'parcel-layout',
        cadastreParcelIds: ['HR-A', 'HR-B', 'HR-C'],
        parcelLayout: { algorithm: 'manual', pool, plots: plots.map(geometry => ({ geometry, source: 'manual' })) }
    };
}

async function apply({ parents, pool, plots, ownerRows, agents = PEOPLE, corridors = null }) {
    const apply = manager(parents);
    if (corridors) apply._groundAfterLaterCorridors = corridors;
    const storage = storageOf(ownerRows);
    const agentStore = agentsOf(agents);
    const ok = await apply._applyParcelLayoutProposal('layout', layoutRecord(pool, plots), {
        _parcelMutation: { storage, agents: agentStore }
    });
    expect(ok).toBe(true);
    const own = role => apply.added.filter(feature => feature.properties.readjustmentPiece?.role === role);
    const rowOf = feature => storage.getItem(`parcel_${feature.properties.parcelId}_owner`);
    return { plots: own('plot'), remainders: own('remainder'), storage, agentStore, rowOf };
}

const single = (ownerKey, name) => ({
    owners: [{ name, ownerLabel: name, ownerKey, percentageShare: 100, actualShareText: '100%' }],
    jointPool: false
});

beforeEach(() => {
    globalKeys.forEach(key => { saved[key] = globalThis[key]; });
    globalThis._normalizeProposalId = value => value == null ? '' : String(value);
    globalThis.updateStatus = vi.fn();
    globalThis.turf = turf;
    globalThis.window = { __formationEdit: formationEdit, __parcelContiguity: contiguity, turf };
    globalThis._resolveRootParcelIdFromProperties = (props, explicit) =>
        props?.cadastreParcelIds?.[0] || props?.rootParcelId || explicit || null;
    globalThis._resolveRootParcelNumberFromProperties = props => props?.rootParcelNumber || null;
    globalThis._calculateGeoJsonArea = geometry => turf.area({ type: 'Feature', properties: {}, geometry });
    globalThis.persistAppliedProposal = vi.fn();
    globalThis.refreshProposalUIAfterApply = vi.fn();
    const helpers = realAgentHelpers();
    globalThis.transferParcelOwnership = vi.fn(helpers.transferParcelOwnership);
    globalThis.getOrCreateJointPoolAgent = vi.fn(helpers.getOrCreateJointPoolAgent);
    // A layout decides nothing about who gets land: these must never be reached.
    globalThis.getOrCreateCityAgent = vi.fn(() => 'agent_city');
    globalThis.getOrCreateAgentForRecipient = vi.fn(name => `recipient:${name}`);
});

afterEach(() => {
    globalKeys.forEach(key => {
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
    });
    vi.restoreAllMocks();
});

describe('a parcel layout carries ownership over', () => {
    it('keeps the owner of the one parcel a plot stands in, as that owner\'s own agent', async () => {
        const { plots, rowOf } = await apply({
            parents: [HR_A(), HR_B()], pool: rect(0, 0, 4, 2), plots: [rect(0, 0, 2, 2), rect(2, 0, 4, 2)],
            ownerRows: { 'parcel_HR-A_owner': 'agent-ana', 'parcel_HR-B_owner': 'agent-boris' }
        });
        expect(plots).toHaveLength(2);
        expect(plots[0].properties.ownershipDetails).toEqual(single('agent-ana', 'Ana'));
        expect(plots[1].properties.ownershipDetails).toEqual(single('agent-boris', 'Boris'));
        expect(plots.map(feature => feature.properties.jointPool)).toEqual([false, false]);
        expect(plots.map(rowOf)).toEqual(['agent-ana', 'agent-boris']);
        expect(globalThis.getOrCreateJointPoolAgent).not.toHaveBeenCalled();
        expect(globalThis.getOrCreateCityAgent).not.toHaveBeenCalled();
        expect(globalThis.getOrCreateAgentForRecipient).not.toHaveBeenCalled();
    });

    it('holds a plot that straddles two parcels jointly, pro rata by the ground it takes from each', async () => {
        const { plots, rowOf, agentStore } = await apply({
            parents: [HR_A(), HR_B()], pool: rect(0, 0, 4, 2), plots: [rect(0, 0, 1, 2), rect(1, 0, 4, 2)],
            ownerRows: { 'parcel_HR-A_owner': 'agent-ana', 'parcel_HR-B_owner': 'agent-boris' }
        });
        const straddling = plots[1];
        // A third of it was Ana's parcel, two thirds Boris's.
        const holding = straddling.properties.ownershipDetails;
        expect(holding.jointPool).toBe(true);
        expect(straddling.properties.jointPool).toBe(true);
        expect(holding.owners.map(owner => owner.ownerKey)).toEqual(['agent-boris', 'agent-ana']);
        expect(holding.owners[0].percentageShare).toBeCloseTo(200 / 3, 6);
        expect(holding.owners[1].percentageShare).toBeCloseTo(100 / 3, 6);
        expect(holding.owners.map(owner => owner.actualShareText)).toEqual(['66.7%', '33.3%']);
        // The piece's record names a deterministic joint holder whose members are the two owners.
        const jointId = rowOf(straddling);
        expect(jointId).toMatch(/^agent_joint_pool_/);
        const joint = agentStore.getAgent(jointId);
        expect(joint).toMatchObject({ jointPool: true, name: 'Boris / Ana' });
        expect(joint.members.map(member => member.agentId)).toEqual(['agent-ana', 'agent-boris']);
        expect(joint.members[0].share).toBeCloseTo(1 / 3, 9);
        expect(joint.members[1].share).toBeCloseTo(2 / 3, 9);
        // The plot wholly inside HR-A stays Ana's alone.
        expect(plots[0].properties.ownershipDetails).toEqual(single('agent-ana', 'Ana'));
        expect(rowOf(plots[0])).toBe('agent-ana');
    });

    it('gives one owner of several parcels the straddling plot alone', async () => {
        const { plots, rowOf } = await apply({
            parents: [HR_A(), HR_B()], pool: rect(0, 0, 4, 2), plots: [rect(0, 0, 1, 2), rect(1, 0, 4, 2)],
            ownerRows: { 'parcel_HR-A_owner': 'agent-ana', 'parcel_HR-B_owner': 'agent-ana' }
        });
        expect(plots[1].properties.ownershipDetails).toEqual(single('agent-ana', 'Ana'));
        expect(rowOf(plots[1])).toBe('agent-ana');
        expect(globalThis.getOrCreateJointPoolAgent).not.toHaveBeenCalled();
    });

    it('leaves ground with no recorded owner unowned', async () => {
        const { plots, rowOf } = await apply({
            parents: [HR_B(), HR_C()], pool: rect(2, 0, 6, 2), plots: [rect(2, 0, 4, 2), rect(4, 0, 6, 2)],
            ownerRows: { 'parcel_HR-B_owner': 'agent-boris' }
        });
        expect(plots[0].properties.ownershipDetails).toEqual(single('agent-boris', 'Boris'));
        expect(plots[1].properties).not.toHaveProperty('ownershipDetails');
        expect(plots[1].properties).not.toHaveProperty('jointPool');
        expect(rowOf(plots[1])).toBeNull();
    });

    it('keeps the parent\'s owner on a remainder outside the pool', async () => {
        const { remainders, rowOf } = await apply({
            parents: [HR_A(), HR_B()], pool: rect(0, 0, 3, 2), plots: [rect(0, 0, 2, 2), rect(2, 0, 3, 2)],
            ownerRows: { 'parcel_HR-A_owner': 'agent-ana', 'parcel_HR-B_owner': 'agent-boris' }
        });
        expect(remainders).toHaveLength(1);
        expect(rowOf(remainders[0])).toBe('agent-boris');
        // The remainder is the parent's parcel made smaller: it shows what the parcel showed.
        expect(remainders[0].properties.ownershipDetails).toEqual({
            owners: [{ name: 'Registry owner of HR-B', percentageShare: 100 }]
        });
    });

    it('holds each connected part of a plot a later road splits by the ground under that part', async () => {
        const { plots, rowOf } = await apply({
            parents: [HR_A(), HR_B()], pool: rect(0, 0, 4, 2), plots: [rect(0, 0, 1, 2), rect(1, 0, 4, 2)],
            ownerRows: { 'parcel_HR-A_owner': 'agent-ana', 'parcel_HR-B_owner': 'agent-boris' },
            // The road takes x 2..3 out of the straddling plot: one part is left on each parcel.
            corridors: () => ({
                corridorIds: ['later-road'],
                geometries: [rect(0, 0, 1, 2), { type: 'MultiPolygon', coordinates: [rect(1, 0, 2, 2).coordinates, rect(3, 0, 4, 2).coordinates] }]
            })
        });
        // Both parts come from the straddling plot (its anchors name both parcels).
        const parts = plots.filter(feature => feature.properties.cadastreParcelIds.length === 2);
        expect(parts).toHaveLength(2);
        const byWest = parts.sort((a, b) => turf.bbox(a)[0] - turf.bbox(b)[0]);
        expect(byWest.map(rowOf)).toEqual(['agent-ana', 'agent-boris']);
        expect(byWest.map(feature => feature.properties.ownershipDetails)).toEqual([single('agent-ana', 'Ana'), single('agent-boris', 'Boris')]);
        expect(globalThis.getOrCreateJointPoolAgent).not.toHaveBeenCalled();
    });
});
