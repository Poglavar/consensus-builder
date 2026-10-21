// Validate ownership shaping and transaction-local joint agents. A parcel layout's apply carries owners
// over from the ground instead (land-readjustment-audit.test.js); this shaping stays for the agreement.
import { describe, it, expect } from 'vitest';
import ownership from '../../frontend/js/reparcellization-ownership.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const agentsSource = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');

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

    it('rejects unassigned placeholder labels but keeps stable owner keys with real labels', () => {
        for (const label of ['Unassigned', 'Sin asignar', 'Nedodijeljeno', 'Nedodeljeno']) {
            expect(() => ownership.shapeSliceOwnership({ owners: [{ ownerKey: 'stable-owner-key', displayName: label, share: 1 }] }))
                .toThrow(/unassigned placeholder/);
        }
        expect(ownership.shapeSliceOwnership({ owners: [
            { ownerKey: 'unassigned', displayName: 'A real owner', share: 1 }
        ] }).owners[0]).toMatchObject({ ownerKey: 'unassigned', name: 'A real owner' });
        expect(() => ownership.shapeSliceOwnership({ ownerKey: 'owner-a', displayName: 'Sin asignar' }))
            .toThrow(/unassigned placeholder/);
    });

    it('preserves unrepresented open-ground plots and rejects contradictory owner rows', () => {
        expect(ownership.shapeSliceOwnership({ ownerKey: 'open-ground', owners: [] }))
            .toEqual({ owners: [], jointPool: false });
        expect(ownership.shapeSliceOwnership({ ownerKey: 'open-ground', owners: [
            { ownerKey: 'open-ground', displayName: 'Open ground', share: 1 }
        ] })).toEqual({ owners: [], jointPool: false });
        expect(ownership.shapeSliceOwnership({ unrepresentedGround: true })).toEqual({ owners: [], jointPool: false });
        expect(ownership.shapeSliceOwnership({ unrepresentedGround: true, owners: [
            { ownerKey: 'open-ground', displayName: 'Open ground', share: 1, unrepresentedGround: true }
        ] })).toEqual({ owners: [], jointPool: false });
        expect(() => ownership.shapeSliceOwnership({ ownerKey: 'open-ground', owners: [
            { ownerKey: 'a', displayName: 'Ana', share: 1 }
        ] })).toThrow(/complete sentinel allocation/);
        expect(() => ownership.shapeSliceOwnership({ ownerKey: 'open-ground', owners: [
            { ownerKey: 'open-ground', displayName: 'Open ground', share: 0.5 }
        ] })).toThrow(/complete sentinel allocation/);
        expect(() => ownership.shapeSliceOwnership({ ownerKey: 'open-ground', owners: [
            { ownerKey: 'open-ground', displayName: 'Open ground', share: 0.5 },
            { ownerKey: 'a', displayName: 'Ana', share: 0.5 }
        ] })).toThrow(/complete sentinel allocation/);
        expect(() => ownership.shapeSliceOwnership({ owners: [
            { ownerKey: 'open-ground', displayName: 'Open ground', share: 1 }
        ] })).toThrow(/open-ground accounting sentinel/);
        expect(() => ownership.shapeSliceOwnership({ owners: [
            { ownerKey: 'a', displayName: 'Ana', share: 0.5 },
            { ownerKey: 'b', displayName: 'Boris', share: 0.5, unrepresentedGround: true }
        ] })).toThrow(/unrepresented ground/);
        expect(() => ownership.shapeSliceOwnership({ ownerKey: 'owner-a', unrepresentedGround: true }))
            .toThrow(/cannot also name a represented owner/);
        expect(() => ownership.shapeSliceOwnership({ noOwner: true }))
            .toThrow(/noOwner marker is retired/);
        expect(() => ownership.shapeSliceOwnership({ owners: [
            { ownerKey: 'open-ground', share: 1, noOwner: true }
        ] })).toThrow(/noOwner marker is retired/);
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

    it('persists joint-pool membership and shares through agent storage reload', () => {
        const backing = new Map();
        const runAgents = () => {
            const context = {
                console, window: {},
                PersistentStorage: {
                    getItem: key => backing.get(key) || null,
                    setItem: (key, value) => backing.set(key, value),
                    ensureReady: fn => fn()
                }
            };
            vm.createContext(context);
            vm.runInContext(agentsSource, context);
            return context;
        };

        const firstContext = runAgents();
        const id = firstContext.getOrCreateJointPoolAgent('Ana / Boris', [
            { agentId: 'agent-a', name: 'Ana', share: 0.6 },
            { agentId: 'agent-b', name: 'Boris', share: 0.4 }
        ]);
        expect(backing.has('consensus_agents')).toBe(true);

        const reloadedContext = runAgents();
        expect(reloadedContext.window.agentStorage.getAgent(id)).toMatchObject({
            jointPool: true,
            members: [
                { agentId: 'agent-a', name: 'Ana', share: 0.6 },
                { agentId: 'agent-b', name: 'Boris', share: 0.4 }
            ]
        });
    });
});
