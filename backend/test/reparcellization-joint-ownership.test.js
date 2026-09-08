// Validate ownership shaping, rejection before mutation, and transaction-local joint agents.
import { describe, it, expect } from 'vitest';
import ownership from '../../frontend/js/reparcellization-ownership.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { _applyReparcellizationProposal } = require('../../frontend/js/proposals/apply/parcels.js');
const agentsSource = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');

function square(x = 0) {
    return { type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] };
}

describe('reparcellization joint ownership shaping', () => {
    it('writes complete 60/40 ownership details', () => {
        const result = ownership.shapeSliceOwnership({ owners: [
            { ownerKey: 'a', displayName: 'Ana', share: 0.6 },
            { ownerKey: 'b', displayName: 'Boris', share: 0.4 }
        ] });
        expect(result.jointPool).toBe(false);
        expect(result.owners.map(owner => owner.percentageShare)).toEqual([60, 40]);
        expect(result.owners[0]).toMatchObject({ name: 'Ana', ownerLabel: 'Ana', ownerKey: 'a', actualShareText: '60%' });
    });

    it('rejects malformed shares before a caller can mutate state', () => {
        expect(() => ownership.validatePlanOwnership([
            { ownerKey: 'a', displayName: 'Ana', share: 0.7 },
            { owners: [{ ownerKey: 'b', displayName: 'Boris', share: 0.2 }] }
        ])).toThrow(/sum to 1/);
        expect(() => ownership.shapeSliceOwnership({ owners: [] })).toThrow(/at least one/);
        expect(() => ownership.shapeSliceOwnership({ owners: [{ ownerKey: 'a', share: 0 }] })).toThrow(/invalid share/);
    });

    it('keeps the established single-owner format at 100%', () => {
        const result = ownership.shapeSliceOwnership({ ownerKey: 'a', displayName: 'Ana', percent: 0.2 });
        expect(result).toEqual({
            owners: [{ name: 'Ana', ownerLabel: 'Ana', ownerKey: 'a', percentageShare: 100, actualShareText: '100%' }],
            jointPool: false
        });
    });

    it('keeps authored jointPool separate from co-owner count', () => {
        expect(ownership.shapeSliceOwnership({ jointPool: true, owners: [
            { ownerKey: 'a', displayName: 'Ana', share: 1 }
        ] }).jointPool).toBe(true);
        expect(ownership.shapeSliceOwnership({ owners: [
            { ownerKey: 'a', displayName: 'Ana', share: 0.6 },
            { ownerKey: 'b', displayName: 'Boris', share: 0.4 }
        ] }).jointPool).toBe(false);
    });

    it('rejects boolean and numeric-string shares', () => {
        expect(() => ownership.shapeSliceOwnership({ owners: [{ ownerKey: 'a', share: true }] })).toThrow(/invalid share/);
        expect(() => ownership.shapeSliceOwnership({ owners: [{ ownerKey: 'a', share: '0.5' }, { ownerKey: 'b', share: 0.5 }] })).toThrow(/invalid share/);
    });

    it('rejects malformed ownership in the real apply method before map or transfer calls', async () => {
        const old = {};
        const keys = ['ReparcellizationOwnership', '_normalizeProposalId', '_calculateGeoJsonArea', '_getParcelIdFromFeature', '_ensureParcelIdOnProperties', 'updateStatus'];
        keys.forEach(key => { old[key] = globalThis[key]; });
        const added = [], transferred = [];
        globalThis.ReparcellizationOwnership = ownership;
        globalThis._normalizeProposalId = String;
        globalThis._calculateGeoJsonArea = () => 1;
        globalThis._getParcelIdFromFeature = feature => feature.properties.parcelId;
        globalThis._ensureParcelIdOnProperties = () => {};
        globalThis.updateStatus = () => {};
        const manager = {
            _resolveLiveFormationParents: () => ({ ok: true, ids: ['P1'], cadastreIds: ['P1'], features: [{ type: 'Feature', geometry: square(), properties: { parcelId: 'P1' } }] }),
            _addFeaturesToMap: async features => added.push(features),
            _markParcelProducedByProposal: () => {},
            _setLastApplyFailure: () => {}
        };
        const data = { reparcellization: { polygons: [{ geometry: square(), owners: [{ ownerKey: 'a', displayName: 'Ana', share: 0.7 }, { ownerKey: 'b', displayName: 'Boris', share: 0.2 }] }] } };
        await expect(_applyReparcellizationProposal.call(manager, 'p', data, { _parcelMutation: { storage: { setItem: () => { transferred.push('storage'); } } } })).rejects.toThrow(/sum to 1/);
        expect(added).toHaveLength(0);
        expect(transferred).toHaveLength(0);
        keys.forEach(key => { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; });
    });

    it('creates deterministic joint pools in the transaction agent store only', () => {
        // Purpose: characterize the real canonical registry helper without browser globals.
        const context = { console, Date, Math, JSON, Set, Map, Array, String, Number, Object, window: {},
            PersistentStorage: { getItem: () => null, setItem: () => { throw new Error('global store write'); }, ensureReady: fn => fn() } };
        vm.createContext(context);
        vm.runInContext(agentsSource, context);
        const globalStore = context.window.agentStorage;
        const staged = new Map();
        const txnStore = {
            getAgent: id => staged.get(id),
            getAllAgents: () => Array.from(staged.values()),
            addAgent: agent => { staged.set(agent.id, agent); return agent.id; }
        };
        const first = context.getOrCreateJointPoolAgent('Ana / Boris', [
            { agentId: 'agent-b', name: 'Boris', share: 0.4 },
            { agentId: 'agent-a', name: 'Ana', share: 0.6 }
        ], { agentStore: txnStore });
        const second = context.getOrCreateJointPoolAgent('reordered', [
            { agentId: 'agent-a', name: 'Ana', share: 0.6 },
            { agentId: 'agent-b', name: 'Boris', share: 0.4 }
        ], { agentStore: txnStore });
        expect(first).toBe(second);
        expect(staged.get(first)).toMatchObject({ jointPool: true });
        expect(staged.get(first).members).toEqual([
            { agentId: 'agent-a', name: 'Ana', share: 0.6 },
            { agentId: 'agent-b', name: 'Boris', share: 0.4 }
        ]);
        expect(globalStore.getAllAgents()).toHaveLength(0);
    });
});
