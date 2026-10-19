// Local proposal removal has one durable input: the proposal's flat cadastral anchors. It never
// reconstructs ancestry from generated IDs or Leaflet geometry, and its record/fabric changes
// commit or roll back together.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { setProposalApplied } = require('../../frontend/js/proposals/status.js');

const touched = new Map();
function install(name, value) {
    if (!touched.has(name)) {
        touched.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

afterEach(() => {
    for (const [name, previous] of touched) {
        if (previous.existed) globalThis[name] = previous.value;
        else delete globalThis[name];
    }
    touched.clear();
    vi.restoreAllMocks();
});

function fabricHarness() {
    let active = null;
    const fabric = {
        beginMutation: vi.fn(() => {
            if (active) throw new Error('nested fabric transaction');
            active = {
                prepare: vi.fn(async () => {}),
                publish: vi.fn(() => { active = null; return { revision: 1 }; }),
                rollback: vi.fn(() => { active = null; return true; })
            };
            return active;
        })
    };
    return fabric;
}

function storageFor(records) {
    const proposals = new Map(records.map(record => [String(record.proposalId), record]));
    return {
        proposals,
        nextProposalId: 10,
        getProposal(id) { return this.proposals.get(String(id)) || null; },
        getAllProposals() { return Array.from(this.proposals.values()); },
        beginBatch: vi.fn(),
        endBatch: vi.fn(),
        save: vi.fn(),
        _indexProposal: vi.fn(function indexProposal(record) {
            this.proposals.set(String(record.proposalId), record);
        }),
        snapshotForMutation() {
            return { records: new Map([...this.proposals].map(([id, value]) => [id, structuredClone(value)])), nextProposalId: this.nextProposalId };
        },
        createMutationDraft(snapshot) {
            const draft = Object.create(this);
            draft.proposals = new Map([...snapshot.records].map(([id, value]) => [id, structuredClone(value)]));
            draft.nextProposalId = snapshot.nextProposalId;
            draft.save = () => {};
            return draft;
        },
        serializeMutationDraft: () => null,
        publishMutationDraft(draft) {
            draft.proposals.forEach((value, id) => {
                const current = this.proposals.get(id);
                Object.keys(current).forEach(key => delete current[key]);
                Object.assign(current, structuredClone(value));
            });
        }
    };
}

function managerFor(record, overrides = {}) {
    const fabric = fabricHarness();
    const storage = storageFor([record]);
    const restore = vi.fn(async () => ({
        ok: true,
        applied: 0,
        failed: [],
        cadastreParcelIds: record.cadastreParcelIds.slice(),
        proposalIds: [],
        fabric: { parcels: record.cadastreParcelIds.length }
    }));
    install('proposalStorage', storage);
    install('setProposalApplied', setProposalApplied);
    install('window', {
        LiveParcelFabric: fabric,
        parks: [], squares: [], lakes: [], transitStations: [], proposedBuildings: []
    });
    const manager = {
        _rebuildInProgress: false,
        _recordedCadastreScope: ProposalManager._recordedCadastreScope,
        _clearDerivedRecordState: ProposalManager._clearDerivedRecordState,
        _unapplyProposalTransactionBody: ProposalManager._unapplyProposalTransactionBody,
        _loadReplayGround: vi.fn(async () => {
            manager._lastReplayGroundProfile = { missingIds: [], unavailableMembers: 0 };
            return 0;
        }),
        _rematerializeResolvedScope: restore,
        _refreshUIAfterProposalChange: vi.fn(),
        unapplyProposal: ProposalManager.unapplyProposal,
        ...overrides
    };
    return { manager, fabric, storage, restore };
}

describe('flat cadastral scope', () => {
    it('uses only the proposal record and never generated child identities', () => {
        const record = {
            proposalId: 'park',
            cadastreParcelIds: ['HR-A', 'HR-B'],
            parentParcelIds: ['HR-A', 'HR-B'],
            childParcelIds: ['HR-A#park-1']
        };

        expect(ProposalManager._recordedCadastreScope([record])).toEqual({
            cadastreParcelIds: ['HR-A', 'HR-B'],
            complete: true
        });
    });

    it('treats durable cadastral identities as opaque values', () => {
        const record = { proposalId: 'opaque', cadastreParcelIds: ['HR-A#old-1'] };
        expect(ProposalManager._recordedCadastreScope([record])).toEqual({
            cadastreParcelIds: ['HR-A#old-1'],
            complete: true
        });
    });

    it('closes only over standing formations that share explicit cadastral anchors', () => {
        const seed = { proposalId: 'seed', applied: false, cadastreParcelIds: ['HR-A'] };
        const bridge = { proposalId: 'bridge', applied: true, cadastreParcelIds: ['HR-A', 'HR-B'] };
        const neighbour = { proposalId: 'neighbour', applied: true, cadastreParcelIds: ['HR-B'] };
        const road = { proposalId: 'road', applied: true, goal: 'road-track', cadastreParcelIds: ['HR-B', 'HR-Z'] };
        const remote = { proposalId: 'remote', applied: true, cadastreParcelIds: ['HR-C'] };
        install('proposalStorage', storageFor([seed, bridge, neighbour, road, remote]));

        const closure = ProposalManager._localFormationClosure([seed], ['HR-A']);

        expect(closure.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(closure.records.map(record => record.proposalId)).toEqual(['seed', 'bridge', 'neighbour']);
    });
});

describe('atomic local unapply', () => {
    it('loads and restores exactly the recorded scope in one root transaction', async () => {
        const record = {
            proposalId: 'park',
            title: 'Park',
            goal: 'park',
            applied: true,
            cadastreParcelIds: ['HR-A', 'HR-B'],
            childParcelIds: ['HR-A#park-1'],
            structureProposal: { kind: 'park' }
        };
        const flatResolver = vi.fn(() => { throw new Error('must not inspect geometry'); });
        const corridorResolver = vi.fn(() => { throw new Error('must not inspect geometry'); });
        const { manager, fabric, storage, restore } = managerFor(record, {
            _flatScopeSeeds: flatResolver,
            _corridorScopeSeeds: corridorResolver
        });

        await expect(manager.unapplyProposal('park')).resolves.toBe(true);

        expect(record.applied).toBe(false);
        expect(manager._loadReplayGround).toHaveBeenCalledOnce();
        expect(manager._loadReplayGround).toHaveBeenCalledWith([record], expect.objectContaining({ purpose: 'unapply' }));
        expect(restore).toHaveBeenCalledOnce();
        expect(restore.mock.calls[0][0]).toEqual([record]);
        expect(restore.mock.calls[0][1]).toEqual({ cadastreParcelIds: ['HR-A', 'HR-B'], complete: true });
        expect(restore.mock.calls[0][2]).toEqual(expect.objectContaining({
            purpose: 'unapply',
            _parcelMutation: expect.any(Object)
        }));
        expect(flatResolver).not.toHaveBeenCalled();
        expect(corridorResolver).not.toHaveBeenCalled();
        expect(fabric.beginMutation).toHaveBeenCalledOnce();
        const mutation = fabric.beginMutation.mock.results[0].value;
        expect(mutation.publish).toHaveBeenCalledOnce();
        expect(mutation.rollback).not.toHaveBeenCalled();
    });

    it('restores the authored record and discards the fabric draft when local restoration fails', async () => {
        const record = {
            proposalId: 'building',
            applied: true,
            appliedAt: '2026-01-01T00:00:00.000Z',
            cadastreParcelIds: ['HR-A'],
            childParcelIds: ['HR-A#building-1'],
            buildingProposal: { type: 'block' }
        };
        const { manager, fabric, restore } = managerFor(record);
        restore.mockResolvedValue({ ok: false, failed: [{ reason: 'clip failed' }] });

        await expect(manager.unapplyProposal('building')).resolves.toBe(false);

        expect(record.applied).toBe(true);
        expect(record.appliedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(record.childParcelIds).toEqual(['HR-A#building-1']);
        const mutation = fabric.beginMutation.mock.results[0].value;
        expect(mutation.publish).not.toHaveBeenCalled();
        expect(mutation.rollback).toHaveBeenCalledOnce();
    });

    it('does not change either side when cadastral ground is unavailable', async () => {
        const record = {
            proposalId: 'park', applied: true, cadastreParcelIds: ['HR-A'],
            childParcelIds: ['HR-A#park-1'], structureProposal: { kind: 'park' }
        };
        const { manager, fabric, restore } = managerFor(record);
        manager._loadReplayGround.mockImplementation(async () => {
            manager._lastReplayGroundProfile = { missingIds: ['HR-A'], unavailableMembers: 0 };
        });

        await expect(manager.unapplyProposal('park')).resolves.toBe(false);

        expect(record.applied).toBe(true);
        expect(record.childParcelIds).toEqual(['HR-A#park-1']);
        expect(restore).not.toHaveBeenCalled();
        const mutation = fabric.beginMutation.mock.results[0].value;
        expect(mutation.rollback).toHaveBeenCalledOnce();
    });
});

describe('generated parcel provenance', () => {
    it('mints one-hop output identities from explicit original cadastral anchors', () => {
        const child = {
            type: 'Feature',
            properties: {
                parcelId: 'temporary',
                cadastreParcelIds: ['HR-A', 'HR-B'],
                BROJ_CESTICE: '1'
            },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
        };

        ProposalManager._assignSyntheticChildIdentities('proposal', [child]);

        expect(child.properties.parcelId).toContain('#');
        expect(child.properties.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(child.properties.baseParcelIds).toBeUndefined();
        expect(child.properties.parentParcelIds).toBeUndefined();
        expect(child.properties.producedByProposalId).toBe('proposal');
        expect(child.properties.ancestorProposal).toBeUndefined();
    });
});

describe('unapply source contract', () => {
    it('does not route removal through apply-time geometry resolution or Leaflet', () => {
        const source = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');
        const start = source.indexOf('async unapplyProposal(proposalId, options = {})');
        const end = source.indexOf('async _unapplyProposalTransactionBody', start);
        const body = source.slice(start, end);

        expect(body).toContain('_recordedCadastreScope');
        expect(body).toContain('_rematerializeResolvedScope');
        expect(body).not.toContain('rematerializeFlatScope');
        expect(body).not.toContain('rematerializeCorridorScope');
        expect(body).not.toContain('_flatScopeSeeds');
        expect(body).not.toContain('parcelLayer');
        expect(body).not.toContain('toGeoJSON');
    });
});
