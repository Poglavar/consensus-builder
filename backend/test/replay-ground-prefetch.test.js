// Replay-ground integration contract.
//
// Cache, request coalescing, batching and retry policy belong to CadastralParcelRepository and are
// tested exhaustively in proposal-ground-service.test.js. ProposalManager makes one repository
// request for the complete replay and passes its explicit fabric mutation through unchanged; it
// never implements a second cache/fetch path of its own.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');

const managerSource = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');

const saved = new Map();
function installGlobal(name, value) {
    if (!saved.has(name)) {
        saved.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
    vi.restoreAllMocks();
});

const member = index => ({
    proposalId: `road-${index}`,
    goal: 'road-track',
    cadastreParcelIds: [`HR-ROAD-${index}`],
    roadProposal: { definition: { polygon: { type: 'Polygon', coordinates: [] } } }
});

describe('ProposalManager replay-ground boundary', () => {
    it('asks the repository once for the whole replay and passes the active fabric draft', async () => {
        const mutation = Object.freeze({ id: 'fabric-1' });
        const onProgress = vi.fn();
        const ensureProposalGround = vi.fn(async records => ({
            members: records.length,
            cachedMembers: records.length,
            loadedMembers: 0,
            idRequests: 0,
            footprintRequests: 0,
            parcels: records.length,
            missingIds: [],
            elapsed: 4
        }));
        installGlobal('CadastralParcelRepository', { ensureProposalGround });
        const manager = {
            _lastReplayGroundProfile: null,
            _loadReplayGround: ProposalManager._loadReplayGround
        };
        const records = [member(0), member(1), member(2)];

        await expect(manager._loadReplayGround(records, {
            purpose: 'replay',
            onProgress,
            _parcelMutation: { fabric: mutation }
        })).resolves.toBe(4);

        expect(ensureProposalGround).toHaveBeenCalledOnce();
        expect(ensureProposalGround).toHaveBeenCalledWith(records, {
            purpose: 'replay',
            onProgress,
            mutation
        });
        expect(manager._lastReplayGroundProfile.members).toBe(3);
    });

    it('does no repository work for an empty replay', async () => {
        const ensureProposalGround = vi.fn();
        installGlobal('CadastralParcelRepository', { ensureProposalGround });
        const manager = { _loadReplayGround: ProposalManager._loadReplayGround };

        await expect(manager._loadReplayGround([])).resolves.toBe(0);
        await expect(manager._loadReplayGround(null)).resolves.toBe(0);
        expect(ensureProposalGround).not.toHaveBeenCalled();
    });

    it('fails the transaction when the repository explicitly reports absent cadastre', async () => {
        installGlobal('CadastralParcelRepository', {
            ensureProposalGround: vi.fn(async () => ({ missingIds: ['HR-MISSING'], elapsed: 1 }))
        });
        const manager = { _loadReplayGround: ProposalManager._loadReplayGround };

        await expect(manager._loadReplayGround([member(0)])).rejects.toMatchObject({
            code: 'cadastral-ground-absent',
            parcelIds: ['HR-MISSING']
        });
    });

    it('contains no direct cadastral transport or renderer lookup', () => {
        const start = managerSource.indexOf('async _loadReplayGround(');
        const body = managerSource.slice(start, managerSource.indexOf('\n    },', start));
        expect(body).toContain('ensureProposalGround');
        expect(body).not.toMatch(/fetch\s*\(/);
        expect(body).not.toContain('parcelLayer');
        expect(body).not.toContain('PersistentStorage');
    });
});

describe('a shared corridor package materialises as one cadastral mutation', () => {
    it('marks every road first and rematerialises their combined corridor scope once', async () => {
        const roadA = member(0);
        const roadB = member(1);
        const records = new Map([[roadA.proposalId, roadA], [roadB.proposalId, roadB]]);
        installGlobal('proposalStorage', {
            getProposal: id => records.get(String(id)) || null,
            save: vi.fn()
        });
        installGlobal('setProposalApplied', (record, applied) => { record.applied = applied === true; });
        installGlobal('window', { __planOrder: planOrder, CorridorNetworkNodes: { normalize: vi.fn() } });

        const rematerialize = vi.fn(async () => ({
            ok: true,
            applied: 2,
            failed: [],
            cadastreParcelIds: ['HR-ROAD-0', 'HR-ROAD-1']
        }));
        const manager = {
            materializeCorridorBatch: ProposalManager.materializeCorridorBatch,
            rematerializeCorridorScope: rematerialize,
            _setLastApplyFailure: vi.fn()
        };
        const context = {
            proposals: globalThis.proposalStorage,
            afterCommit: callback => callback()
        };

        const result = await manager.materializeCorridorBatch(
            [roadA.proposalId, roadB.proposalId],
            { _parcelMutation: context }
        );

        expect(result.ok, result.reason).toBe(true);
        expect(result.appliedIds).toEqual([roadA.proposalId, roadB.proposalId]);
        expect(roadA.applied).toBe(true);
        expect(roadB.applied).toBe(true);
        expect(rematerialize).toHaveBeenCalledOnce();
        expect(rematerialize.mock.calls[0][0]).toEqual([roadA, roadB]);
        expect(rematerialize.mock.calls[0][1]).toEqual(expect.objectContaining({
            _parcelMutation: context,
            silent: false,
            deferSave: true
        }));
    });

    it('does not reject a corridor package because part of a ribbon has no parcel host', async () => {
        const roads = Array.from({ length: 3 }, (_, index) => member(index));
        const track = member(3);
        track.cadastreParcelIds = ['HR-TRACK-A', 'HR-TRACK-B'];
        const records = [...roads, track];
        const byId = new Map(records.map(record => [record.proposalId, record]));
        installGlobal('proposalStorage', {
            getProposal: id => byId.get(String(id)) || null,
            save: vi.fn()
        });
        installGlobal('setProposalApplied', (record, applied) => { record.applied = applied === true; });
        installGlobal('window', {
            __planOrder: planOrder,
            __cadastreAncestry: {
                loadedCadastreCoverage: record => record === track
                    ? { ids: ['HR-TRACK-A'], coverage: 0.5 }
                    : { ids: record.cadastreParcelIds, coverage: 1 }
            },
            CorridorNetworkNodes: { normalize: vi.fn() }
        });

        const localMaterialize = vi.fn(async (_seed, resolution) => ({
            ok: resolution.complete,
            failed: [],
            cadastreParcelIds: resolution.cadastreParcelIds
        }));
        const manager = {
            materializeCorridorBatch: ProposalManager.materializeCorridorBatch,
            rematerializeCorridorScope: ProposalManager.rematerializeCorridorScope,
            _corridorScopeSeeds: ProposalManager._corridorScopeSeeds,
            _loadReplayGround: vi.fn(async () => 0),
            _rematerializeResolvedScope: localMaterialize,
            _setLastApplyFailure: vi.fn()
        };
        const context = {
            proposals: globalThis.proposalStorage,
            afterCommit: callback => callback()
        };

        const result = await manager.materializeCorridorBatch(
            records.map(record => record.proposalId),
            { _parcelMutation: context }
        );

        expect(result.ok, result.reason).toBe(true);
        const resolution = localMaterialize.mock.calls[0][1];
        expect(resolution.complete).toBe(true);
        expect(resolution.cadastreParcelIds).toEqual(expect.arrayContaining([
            'HR-ROAD-0', 'HR-ROAD-1', 'HR-ROAD-2', 'HR-TRACK-A', 'HR-TRACK-B'
        ]));
    });

    it('never routes a corridor batch through strict formation-ground resolution', () => {
        const batchStart = managerSource.indexOf('async materializeCorridorBatch(');
        const batch = managerSource.slice(batchStart, managerSource.indexOf('\n    },', batchStart));
        const scopeStart = managerSource.indexOf('async rematerializeCorridorScope(');
        const scope = managerSource.slice(scopeStart, managerSource.indexOf('\n    },', scopeStart));
        expect(batch).toContain('rematerializeCorridorScope');
        expect(batch).not.toContain('rematerializeFlatScope');
        expect(scope).toContain('_rematerializeResolvedScope');
        expect(scope).not.toContain('rematerializeFlatScope');
    });
});

describe('the replay fold itself never fetches', () => {
    const start = managerSource.indexOf('async _rebuildPass(');
    const pass = managerSource.slice(start, managerSource.indexOf('\n    },', start));

    it('loads all ground before the ordered member loop', () => {
        expect(pass.indexOf('_loadReplayGround')).toBeLessThan(pass.indexOf('for (const proposal of appliedList)'));
    });

    it('contains no per-member cadastral transport', () => {
        const loop = pass.slice(pass.indexOf('for (const proposal of appliedList)'));
        expect(loop).not.toMatch(/fetchParcels|ensureIds|ensureFootprint|ensureBounds/);
    });
});
