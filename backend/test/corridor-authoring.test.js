import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const geometry = require('../../frontend/js/corridor-geometry.js');
const authoring = require('../../frontend/js/proposals/corridor-authoring.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const P = (lat, lng, extra = {}) => ({ lat, lng, ...extra });
const clone = value => JSON.parse(JSON.stringify(value));

function corridor(id, segments, options = {}) {
    const definition = {
        points: clone(segments),
        segments: clone(segments),
        segmentIds: segments.map((_, index) => `${id || 'new'}-${index}`),
        metadata: { isTrack: options.track === true },
        ...(options.tunnels ? { tunnels: clone(options.tunnels) } : {})
    };
    return {
        ...(id ? { proposalId: id } : {}),
        applied: options.applied !== false,
        title: id || 'New corridor',
        roadProposal: { definition },
        ...(options.identity || {})
    };
}

const plan = (newProposal, existing, options = {}) => authoring.planCorridorAuthoring(
    newProposal,
    existing,
    {
        geometry,
        isApplied: record => record.applied === true,
        isTrack: definition => definition.metadata?.isTrack === true,
        ...options
    }
);

const installedGlobals = new Map();
function installGlobal(name, value) {
    if (!installedGlobals.has(name)) {
        installedGlobals.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

afterEach(() => {
    delete global.corridorTunnelEdgeKey;
    for (const [name, prior] of installedGlobals) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    installedGlobals.clear();
    vi.restoreAllMocks();
});

function managerHarness(existing, derive) {
    const records = new Map(existing.map(record => [String(record.proposalId), record]));
    const addProposal = vi.fn(function addProposalToDraft(proposal, options = {}) {
        const stored = clone(proposal);
        stored.proposalId = 'new-road';
        stored.roadProposal.id = 'new-road';
        stored.roadProposal.proposalId = 'new-road';
        this.proposals.set('new-road', stored);
        this.save();
        return 'new-road';
    });
    const storage = {
        proposals: records,
        nextProposalId: 1,
        _suspendSaveCount: 0,
        _hasPendingSave: false,
        beginBatch() { this._suspendSaveCount += 1; },
        endBatch() { this._suspendSaveCount -= 1; },
        save: vi.fn(),
        getAllProposals() { return [...this.proposals.values()]; },
        getProposal(id) { return this.proposals.get(String(id)) || null; },
        addProposal,
        _indexProposal: vi.fn(function indexProposal(record) {
            this.proposals.set(String(record.proposalId), record);
        }),
        snapshotForMutation() {
            return { records: new Map([...this.proposals].map(([id, record]) => [id, clone(record)])), nextProposalId: this.nextProposalId };
        },
        createMutationDraft(snapshot) {
            const draft = Object.create(this);
            draft.proposals = new Map([...snapshot.records].map(([id, record]) => [id, clone(record)]));
            draft.nextProposalId = snapshot.nextProposalId;
            draft.save = vi.fn();
            return draft;
        },
        serializeMutationDraft: () => null,
        publishMutationDraft(draft) {
            for (const id of [...this.proposals.keys()]) if (!draft.proposals.has(id)) this.proposals.delete(id);
            draft.proposals.forEach((record, id) => {
                const current = this.proposals.get(id);
                if (current) {
                    Object.keys(current).forEach(key => delete current[key]);
                    Object.assign(current, clone(record));
                } else this.proposals.set(id, clone(record));
            });
        }
    };
    const browserRoot = {
        CorridorAuthoring: authoring,
        CorridorGeometry: geometry
    };
    installGlobal('window', browserRoot);
    installGlobal('proposalStorage', storage);
    installGlobal('setProposalApplied', (record, applied) => { record.applied = applied === true; });
    installGlobal('commitReplacementSupersession', () => null);
    const manager = {
        createCorridorProposalAtomically: ProposalManager.createCorridorProposalAtomically,
        _createCorridorProposalTransactionBody: ProposalManager._createCorridorProposalTransactionBody,
        _enqueueFabricChange: operation => operation(),
        rematerializeCorridorScope: derive,
        _clearLastApplyFailure: vi.fn(),
        _refreshUIAfterProposalChange: vi.fn()
    };
    return { manager, records, storage, addProposal };
}

describe('atomic corridor authoring plan', () => {
    it('writes a snapped T node into the existing road while keeping two proposal records', () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const originals = clone({ through, branch });

        const result = plan(branch, [through]);

        expect(result.proposal).not.toBe(branch);
        expect(result.existingChanges).toHaveLength(1);
        expect(result.existingChanges[0].proposalId).toBe('through');
        expect(result.existingChanges[0].definition.points).toHaveLength(2);
        expect(result.proposal.roadProposal.definition.points).toHaveLength(1);
        expect(result.junctionRecords).toBe(1);
        expect({ through, branch }).toEqual(originals);
    });

    it('nodes both records at an X crossing before either is persisted', () => {
        const eastWest = corridor('east-west', [[P(0, -5), P(0, 5)]]);
        const northSouth = corridor(null, [[P(-5, 0), P(5, 0)]]);

        const result = plan(northSouth, [eastWest]);

        expect(result.existingChanges[0].definition.points).toHaveLength(2);
        expect(result.proposal.roadProposal.definition.points).toHaveLength(2);
        const oldNodes = result.existingChanges[0].definition.points.flat();
        const newNodes = result.proposal.roadProposal.definition.points.flat();
        expect(oldNodes.some(point => point.lat === 0 && point.lng === 0)).toBe(true);
        expect(newNodes.some(point => point.lat === 0 && point.lng === 0)).toBe(true);
    });

    it('touches only applied corridors of the same kind', () => {
        const newRoad = corridor(null, [[P(0, -5), P(0, 5)]]);
        const parkedRoad = corridor('parked', [[P(-5, 0), P(5, 0)]], { applied: false });
        const track = corridor('track', [[P(-5, 0), P(5, 0)]], { track: true });
        const farRoad = corridor('far', [[P(20, 20), P(20, 25)]]);

        const result = plan(newRoad, [parkedRoad, track, farRoad]);

        expect(result.existingChanges).toEqual([]);
        expect(result.junctionRecords).toBe(0);
        expect(result.proposal.roadProposal.definition.points).toHaveLength(1);
    });

    it('does not turn a protected crossing into a junction', () => {
        global.corridorTunnelEdgeKey = (a, b) => [
            `${a.lat.toFixed(7)},${a.lng.toFixed(7)}`,
            `${b.lat.toFixed(7)},${b.lng.toFixed(7)}`
        ].sort().join('|');
        const protectedKey = global.corridorTunnelEdgeKey(P(0, -5), P(0, 5));
        const bridge = corridor('bridge', [[P(0, -5), P(0, 5)]], {
            tunnels: [{ edgeKey: protectedKey }]
        });
        const under = corridor(null, [[P(-5, 0), P(5, 0)]]);

        const result = plan(under, [bridge]);

        expect(result.existingChanges).toEqual([]);
        expect(result.proposal.roadProposal.definition.points).toHaveLength(1);
    });

    it('is deterministic regardless of proposal-store iteration order', () => {
        const newRoad = corridor(null, [[P(0, -10), P(0, 10)]]);
        const left = corridor('a-left', [[P(-5, -2), P(5, -2)]]);
        const right = corridor('b-right', [[P(-5, 2), P(5, 2)]]);

        const forward = plan(newRoad, [left, right]);
        const reverse = plan(newRoad, [right, left]);

        expect(reverse).toEqual(forward);
        expect(forward.existingChanges.map(change => change.proposalId)).toEqual(['a-left', 'b-right']);
    });

    it('persists a converged network that needs no repair after a JSON round trip', () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const result = plan(branch, [through]);
        const persisted = JSON.parse(JSON.stringify([
            {
                ...through,
                roadProposal: {
                    ...through.roadProposal,
                    definition: result.existingChanges[0].definition
                }
            },
            { ...result.proposal, proposalId: 'new-road' }
        ]));
        const entries = persisted.map(record => {
            const definition = record.roadProposal.definition;
            return {
                segments: clone(definition.points),
                segmentIds: clone(definition.segmentIds),
                segmentProfiles: clone(definition.segmentProfiles || {})
            };
        });

        const secondPass = geometry.normalizeCorridorNetwork(entries, { toleranceMeters: 0 });

        expect(secondPass.every(entry => entry.changed === false)).toBe(true);
    });

    it('does not silently heal a nearby endpoint that the drawing did not actually snap', () => {
        const through = corridor('through', [[P(43, 15), P(43, 15.001)]]);
        const nearbyBranch = corridor(null, [[P(43.001, 15.0005), P(43.0000001, 15.0005)]]);

        const result = plan(nearbyBranch, [through]);

        expect(result.existingChanges).toEqual([]);
        expect(result.junctionRecords).toBe(0);
    });

    it('detaches only identities of copies published elsewhere', () => {
        const record = corridor('local-id', [[P(0, 0), P(0, 1)]], {
            identity: {
                serverProposalId: 42,
                chainProposalId: 'chain-42',
                tokenId: 'token-42',
                onchain: { account: 'x' },
                hash: 'published-hash',
                author: 'Ana'
            }
        });

        const removed = authoring.detachPublishedIdentity(record);

        expect(Object.keys(removed).sort()).toEqual([
            'chainProposalId', 'hash', 'onchain', 'serverProposalId', 'tokenId'
        ]);
        expect(record.proposalId).toBe('local-id');
        expect(record.author).toBe('Ana');
        expect(record.roadProposal).toBeTruthy();
    });
});

describe('corridor authoring commit boundary', () => {
    it('persists both sides of a T before deriving its ground', async () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]], {
            identity: { serverProposalId: 77 }
        });
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const derive = vi.fn(async (records, options) => {
            expect(records[0].proposalId).toBe('new-road');
            expect(records[0].roadProposal.definition.points).toHaveLength(1);
            expect(options._parcelMutation.proposals.getProposal('through')
                .roadProposal.definition.points).toHaveLength(2);
            // The committed record stays visible and unchanged until durable publication.
            expect(through.roadProposal.definition.points).toHaveLength(1);
            return { ok: true, failed: [] };
        });
        const { manager, records, addProposal } = managerHarness([through], derive);

        const result = await manager.createCorridorProposalAtomically(branch);

        expect(result.ok).toBe(true);
        expect(result.topology.changedProposalIds).toEqual(['through']);
        expect(addProposal).toHaveBeenCalledWith(expect.any(Object), { emitEvent: false });
        expect(records.get('new-road').applied).toBe(true);
        expect(through.serverProposalId).toBeUndefined();
        expect(derive).toHaveBeenCalledOnce();
    });

    it('restores every touched road and removes the provisional proposal when derivation fails', async () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]], {
            identity: { serverProposalId: 77, hash: 'published' }
        });
        const original = clone(through);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const derive = vi.fn(async () => ({
            ok: false,
            failed: [{ reason: 'ground derivation failed' }]
        }));
        const { manager, records } = managerHarness([through], derive);

        const result = await manager.createCorridorProposalAtomically(branch);

        expect(result).toEqual({
            ok: false,
            proposalId: null,
            reason: 'ground derivation failed'
        });
        expect(records.has('new-road')).toBe(false);
        expect(records.get('through')).toBe(through);
        expect(through).toEqual(original);
    });
});
