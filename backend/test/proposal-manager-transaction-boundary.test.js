import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { setProposalApplied } = require('../../frontend/js/proposals/status.js');

describe('ProposalManager mutation boundary', () => {
    let previousStorage;
    let previousTurf;
    let originalApplyBody;
    let originalUnapplyBody;
    let originalRefresh;
    let originalRebuild;
    let originalDerive;
    let originalRematerialize;
    let originalResolvedRematerialize;
    let originalLoadReplayGround;
    let originalCollectAlternatives;
    let previousSetProposalApplied;
    let store;

    beforeEach(() => {
        ProposalManager._lastApplyFailureByProposalId.clear();
        previousStorage = globalThis.proposalStorage;
        previousTurf = globalThis.turf;
        globalThis.turf = turf;
        originalApplyBody = ProposalManager._applyProposalTransactionBody;
        originalUnapplyBody = ProposalManager._unapplyProposalTransactionBody;
        originalRefresh = ProposalManager._refreshUIAfterProposalChange;
        originalRebuild = ProposalManager.rebuildAppliedFabric;
        originalDerive = ProposalManager.deriveForNewProposal;
        originalRematerialize = ProposalManager.rematerializeFlatScope;
        originalResolvedRematerialize = ProposalManager._rematerializeResolvedScope;
        originalLoadReplayGround = ProposalManager._loadReplayGround;
        originalCollectAlternatives = ProposalManager._collectAppliedAlternativesForExplicitApply;
        previousSetProposalApplied = globalThis.setProposalApplied;

        const proposals = new Map([
            ['target', { proposalId: 'target', applied: false, value: 'before' }],
            ['conflict', { proposalId: 'conflict', applied: true, value: 'before' }]
        ]);
        store = {
            proposals,
            nextProposalId: 3,
            batchDepth: 0,
            saves: 0,
            beginBatch() { this.batchDepth += 1; },
            endBatch() { this.batchDepth -= 1; },
            save() { this.saves += 1; },
            getProposal(id) { return this.proposals.get(String(id)); },
            getAllProposals() { return [...this.proposals.values()]; },
            removeProposal(id) { return this.proposals.delete(String(id)); },
            _indexProposal(record) { this.proposals.set(String(record.proposalId), record); },
            snapshotForMutation() {
                return {
                    records: new Map([...this.proposals].map(([id, record]) => [id, structuredClone(record)])),
                    nextProposalId: this.nextProposalId
                };
            },
            createMutationDraft(snapshot) {
                const draft = Object.create(this);
                draft.proposals = new Map([...snapshot.records].map(([id, record]) => [id, structuredClone(record)]));
                draft.nextProposalId = snapshot.nextProposalId;
                draft.save = () => {};
                return draft;
            },
            serializeMutationDraft: () => null,
            publishMutationDraft(draft) {
                for (const id of [...this.proposals.keys()]) if (!draft.proposals.has(id)) this.proposals.delete(id);
                draft.proposals.forEach((record, id) => {
                    const current = this.proposals.get(id);
                    if (current) {
                        Object.keys(current).forEach(key => delete current[key]);
                        Object.assign(current, structuredClone(record));
                    } else this.proposals.set(id, structuredClone(record));
                });
            }
        };
        globalThis.proposalStorage = store;
        globalThis.setProposalApplied = setProposalApplied;
        ProposalManager._refreshUIAfterProposalChange = () => {};
    });

    afterEach(() => {
        if (previousTurf === undefined) delete globalThis.turf; else globalThis.turf = previousTurf;
        ProposalManager._applyProposalTransactionBody = originalApplyBody;
        ProposalManager._unapplyProposalTransactionBody = originalUnapplyBody;
        ProposalManager._refreshUIAfterProposalChange = originalRefresh;
        ProposalManager.rebuildAppliedFabric = originalRebuild;
        ProposalManager.deriveForNewProposal = originalDerive;
        ProposalManager.rematerializeFlatScope = originalRematerialize;
        ProposalManager._rematerializeResolvedScope = originalResolvedRematerialize;
        ProposalManager._loadReplayGround = originalLoadReplayGround;
        ProposalManager._collectAppliedAlternativesForExplicitApply = originalCollectAlternatives;
        if (previousSetProposalApplied === undefined) delete globalThis.setProposalApplied;
        else globalThis.setProposalApplied = previousSetProposalApplied;
        if (previousStorage === undefined) delete globalThis.proposalStorage;
        else globalThis.proposalStorage = previousStorage;
    });

    it('restores all proposal records when an apply returns false after nested conflict parking', async () => {
        const targetIdentity = store.proposals.get('target');
        const conflictIdentity = store.proposals.get('conflict');

        ProposalManager._unapplyProposalTransactionBody = async (proposalId, options) => {
            const proposal = options._parcelMutation.proposals.getProposal(proposalId);
            proposal.applied = false;
            proposal.value = 'parked';
            return true;
        };
        ProposalManager._applyProposalTransactionBody = async function (proposalId, options) {
            const draftStore = options._parcelMutation.proposals;
            const proposal = draftStore.getProposal(proposalId);
            proposal.applied = true;
            proposal.value = 'partially-applied';
            draftStore.proposals.set('created-during-apply', { proposalId: 'created-during-apply' });
            await this.unapplyProposal('conflict', {
                skipConfirm: true,
                skipRebuild: true,
                _parcelMutation: options._parcelMutation
            });
            return false;
        };

        await expect(ProposalManager.applyProposal('target', { replay: true })).resolves.toBe(false);
        expect(store.proposals.get('target')).toBe(targetIdentity);
        expect(store.proposals.get('conflict')).toBe(conflictIdentity);
        expect(targetIdentity).toEqual({ proposalId: 'target', applied: false, value: 'before' });
        expect(conflictIdentity).toEqual({ proposalId: 'conflict', applied: true, value: 'before' });
        expect(store.proposals.has('created-during-apply')).toBe(false);
        expect(store.batchDepth).toBe(0);
    });

    it('chooses every plan member together and releases only their geometric rivals', async () => {
        store.proposals.set('second', { proposalId: 'second', applied: false });
        store.proposals.set('untouched', { proposalId: 'untouched', applied: true });
        const rebuilt = [];
        ProposalManager._collectAppliedAlternativesForExplicitApply = (_member, candidates, options) => {
            expect(candidates.map(record => record.proposalId)).toEqual(['conflict', 'untouched']);
            return [options._parcelMutation.proposals.getProposal('conflict')];
        };
        ProposalManager.rebuildAppliedFabric = async options => {
            rebuilt.push(options._parcelMutation.proposals.getAllProposals().map(record => [record.proposalId, record.applied]));
            expect(options.resetProposalIds).toEqual(['conflict']);
            return { ok: true, failed: [] };
        };
        const result = await ProposalManager.applyProposalPlan(['target', 'second', 'target']);
        expect(result.ok).toBe(true);
        expect(result.releasedIds).toEqual(['conflict']);
        expect(rebuilt).toEqual([[['target', true], ['conflict', false], ['second', true], ['untouched', true]]]);
        expect(store.getProposal('target').applied).toBe(true);
        expect(store.getProposal('second').applied).toBe(true);
        expect(store.getProposal('conflict').applied).toBe(false);
        expect(store.getProposal('untouched').applied).toBe(true);
    });

    it('keeps the entire previous composition when any incoming plan member refuses', async () => {
        store.proposals.set('second', { proposalId: 'second', applied: false });
        const before = structuredClone([...store.proposals]);
        ProposalManager._collectAppliedAlternativesForExplicitApply = (_member, _candidates, options) => [options._parcelMutation.proposals.getProposal('conflict')];
        ProposalManager.rebuildAppliedFabric = async options => {
            expect(options._parcelMutation.proposals.getProposal('conflict').applied).toBe(false);
            return { ok: false, failed: [{ proposalId: 'second', code: 'bad-ground', reason: 'Ground missing' }] };
        };
        await expect(ProposalManager.applyProposalPlan(['target', 'second'])).resolves.toBe(false);
        expect([...store.proposals]).toEqual(before);
        expect(ProposalManager._lastFailedPlanApplySummary.failed[0].code).toBe('bad-ground');
    });

    it('identifies every unavailable member and distinguishes missing records from withdrawn designs', async () => {
        store.proposals.set('withdrawn', { proposalId: 'withdrawn', title: 'Withdrawn park', lifecycleStatus: 'Cancelled', applied: false });
        const before = structuredClone([...store.proposals]);
        await expect(ProposalManager.applyProposalPlan(['target', 'missing-road', 'withdrawn'])).resolves.toBe(false);
        expect([...store.proposals]).toEqual(before);
        expect(ProposalManager._lastFailedPlanApplySummary.failed).toEqual([
            { proposalId: 'missing-road', title: null, code: 'proposal-not-found', reason: expect.stringContaining('no longer available') },
            { proposalId: 'withdrawn', title: 'Withdrawn park', code: 'proposal-cancelled', reason: expect.stringContaining('withdrawn') }
        ]);
    });

    it('restores state and rethrows the original error', async () => {
        const cause = new Error('geometry exploded');
        ProposalManager._applyProposalTransactionBody = async (proposalId, options) => {
            options._parcelMutation.proposals.getProposal(proposalId).value = 'mutated';
            throw cause;
        };

        await expect(ProposalManager.applyProposal('target', { replay: true })).rejects.toBe(cause);
        expect(store.getProposal('target').value).toBe('before');
        expect(ProposalManager.getLastApplyFailure('target')).toBe('geometry exploded');
        expect(store.batchDepth).toBe(0);
    });

    it('rolls back the tentative applied flag when a new proposal cannot materialize', async () => {
        const targetIdentity = store.getProposal('target');
        ProposalManager.rematerializeFlatScope = async () => ({
            ok: false,
            failed: [{ proposalId: 'target', reason: 'cadastral ground is incomplete' }]
        });

        await expect(ProposalManager.deriveForNewProposal(targetIdentity)).resolves.toBeNull();
        expect(ProposalManager.getLastApplyFailure('target')).toBe('cadastral ground is incomplete');

        expect(store.getProposal('target')).toBe(targetIdentity);
        expect(targetIdentity).toEqual({ proposalId: 'target', applied: false, value: 'before' });
    });

    it('clears records only after their standing output is restored in the same mutation', async () => {
        store.getProposal('conflict').cadastreParcelIds = ['HR-1'];
        ProposalManager._loadReplayGround = async () => ({ ok: true });
        ProposalManager._rematerializeResolvedScope = async (records, scope) => {
            expect(records.map(record => record.proposalId)).toEqual(['conflict']);
            expect(records.every(record => record.applied === false)).toBe(true);
            expect(scope.cadastreParcelIds).toEqual(['HR-1']);
            expect(store.getAllProposals()).toHaveLength(2); // committed state is still visible
            return { ok: true, failed: [] };
        };

        await expect(ProposalManager.clearAllProposals()).resolves.toEqual({ ok: true, count: 2 });

        expect(store.getAllProposals()).toEqual([]);
    });

    it('keeps every record when clear cannot restore the standing fabric', async () => {
        store.getProposal('conflict').cadastreParcelIds = ['HR-1'];
        ProposalManager._loadReplayGround = async () => ({ ok: true });
        ProposalManager._rematerializeResolvedScope = async () => ({ ok: false, failed: [{ reason: 'no' }] });

        await expect(ProposalManager.clearAllProposals()).resolves.toBe(false);

        expect(store.getProposal('target').applied).toBe(false);
        expect(store.getProposal('conflict').applied).toBe(true);
        expect(store.getAllProposals()).toHaveLength(2);
    });

    it('makes the explicitly applied alternative the only standing member', async () => {
        ProposalManager._collectAppliedAlternativesForExplicitApply = (_proposal, _records, options) => (
            [options._parcelMutation.proposals.getProposal('conflict')]
        );
        ProposalManager.deriveForNewProposal = async () => ({ ok: true });

        await expect(ProposalManager.applyProposal('target')).resolves.toBe(true);

        expect(store.getProposal('target').applied).toBe(true);
        expect(store.getProposal('conflict').applied).toBe(false);
    });

    it('rematerializes an explicitly displaced rival without adding a geometry-only pseudo proposal', async () => {
        store.getProposal('target').goal = 'park';
        store.getProposal('target').cadastreParcelIds = ['HR-1'];
        store.getProposal('conflict').goal = 'park';
        store.getProposal('conflict').cadastreParcelIds = ['HR-1'];
        const footprint = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [[[15, 43], [15.001, 43], [15.001, 43.001], [15, 43.001], [15, 43]]]
            }
        };
        ProposalManager._collectAppliedAlternativesForExplicitApply = (_proposal, _records, options) => (
            [options._parcelMutation.proposals.getProposal('conflict')]
        );
        ProposalManager.rematerializeFlatScope = async records => {
            expect(records.map(record => record.proposalId)).toEqual(['target', 'conflict']);
            return { ok: true, failed: [] };
        };

        const previousWindow = globalThis.window;
        globalThis.window = { __planOrder: { footprintOf: () => footprint } };
        try {
            await expect(ProposalManager.applyProposal('target')).resolves.toBe(true);
        } finally {
            if (previousWindow === undefined) delete globalThis.window;
            else globalThis.window = previousWindow;
        }
    });

    it('resolves released records to authored records in the same local scope', async () => {
        store.getProposal('target').goal = 'park';
        store.getProposal('target').cadastreParcelIds = ['HR-2'];
        store.getProposal('conflict').goal = 'park';
        store.getProposal('conflict').cadastreParcelIds = ['HR-1'];
        store.getProposal('conflict').applied = false;
        ProposalManager.rematerializeFlatScope = async records => {
            expect(records.map(record => record.proposalId)).toEqual(['target', 'conflict']);
            return { ok: true, failed: [] };
        };

        await expect(ProposalManager.deriveForNewProposal(store.getProposal('target'), {
            releasedRecords: [{ proposalId: 'conflict' }]
        })).resolves.toMatchObject({ applied: true });
    });

    it('keeps ownership-only proposals out of the fabric mutation path', async () => {
        const offer = {
            proposalId: 'offer',
            goal: 'ownership-transfer-to-me',
            cadastreParcelIds: ['HR-1'],
            applied: false
        };
        store.proposals.set(offer.proposalId, offer);
        ProposalManager.deriveForNewProposal = async () => {
            throw new Error('an ownership offer has no map derivation');
        };

        await expect(ProposalManager.applyProposal(offer.proposalId)).resolves.toBe(true);

        expect(store.getProposal(offer.proposalId)).toBe(offer);
        expect(offer.applied).toBe(false);
        expect(store.saves).toBe(0);
        expect(store.batchDepth).toBe(0);
    });

    it('restores the previous alternative when the derivation removes the chosen proposal', async () => {
        let targetDerivations = 0;
        let componentRestores = 0;
        ProposalManager._collectAppliedAlternativesForExplicitApply = (_proposal, _records, options) => (
            [options._parcelMutation.proposals.getProposal('conflict')]
        );
        ProposalManager.deriveForNewProposal = async proposal => {
            targetDerivations += 1;
            setProposalApplied(proposal, false, { stamp: false });
            return { ok: true };
        };
        ProposalManager.rematerializeFlatScope = async () => {
            componentRestores += 1;
            return { ok: true, failed: [] };
        };

        await expect(ProposalManager.applyProposal('target')).resolves.toBe(false);

        // The authored record map and private fabric draft roll back together. There is no second
        // repair derivation after a failed transaction.
        expect(targetDerivations).toBe(1);
        expect(componentRestores).toBe(0);
        expect(store.getProposal('target')).toEqual({ proposalId: 'target', applied: false, value: 'before' });
        expect(store.getProposal('conflict')).toEqual({ proposalId: 'conflict', applied: true, value: 'before' });
    });

    // User decision 2026-10-17: a local, unpublished record is edited in place.
    describe('updateProposalInPlace', () => {
        beforeEach(() => {
            Object.assign(store.getProposal('target'), {
                goal: 'park', applied: true, createdAt: '2026-10-01T10:00:00.000Z',
                structureProposal: { kind: 'park' }, cadastreParcelIds: ['HR-1']
            });
            Object.assign(store.getProposal('conflict'), { goal: 'buildings', buildingProposal: {}, cadastreParcelIds: ['HR-1'] });
        });
        const edited = () => ({
            goal: 'park', value: 'after', structureProposal: { kind: 'park' }, cadastreParcelIds: ['HR-1', 'HR-2'],
            proposalOrigin: { relation: 'revision', source: { localProposalId: 'target' } }, proposalDraftId: 'draft-1'
        });

        it('keeps the id and the record count, and re-derives the old and new ground', async () => {
            let seeds = null;
            ProposalManager.rematerializeFlatScope = async records => {
                seeds = records.map(record => ({ id: record.proposalId, parcels: record.cadastreParcelIds }));
                return { ok: true, failed: [] };
            };

            await expect(ProposalManager.updateProposalInPlace('target', edited())).resolves.toMatchObject({ applied: true, proposalId: 'target' });

            expect([...store.proposals.keys()]).toEqual(['target', 'conflict']);
            const target = store.getProposal('target');
            expect(target).toMatchObject({ proposalId: 'target', value: 'after', applied: true, createdAt: '2026-10-01T10:00:00.000Z' });
            expect(target.cadastreParcelIds).toEqual(['HR-1', 'HR-2']);
            // An in-place edit keeps its prior origin, never a revision pointing at itself.
            expect(target.proposalOrigin).toBeUndefined();
            expect(target.sourceProposalId).toBeUndefined();
            expect(target.replacementOfProposalId).toBeUndefined();
            expect(seeds).toEqual([{ id: 'target', parcels: ['HR-1'] }, { id: 'target', parcels: ['HR-1', 'HR-2'] }]);
            expect(store.getProposal('conflict').applied).toBe(true);
        });

        it('takes the confirmed dependents off the map in the same transaction', async () => {
            let seedIds = null;
            ProposalManager.rematerializeFlatScope = async records => {
                seedIds = records.map(record => record.proposalId);
                return { ok: true, failed: [] };
            };

            await expect(ProposalManager.updateProposalInPlace('target', edited(), { unapplyIds: ['conflict'] }))
                .resolves.toMatchObject({ unappliedIds: ['conflict'] });

            expect(store.getProposal('conflict').applied).toBe(false);
            expect(seedIds).toEqual(['target', 'target', 'conflict']);
        });

        // User decision 2026-10-18: a converted or moved design overlapping an applied proposal
        // goes through the same conflict step as any apply (claims.js appliedRivals).
        it('takes the applied records on the ground it now stands on off the map, as an apply does', async () => {
            let seedIds = null;
            ProposalManager.rematerializeFlatScope = async records => {
                seedIds = records.map(record => record.proposalId);
                return { ok: true, failed: [] };
            };
            ProposalManager._collectAppliedAlternativesForExplicitApply = (proposal, _records, options) => {
                expect(proposal.value).toBe('after');
                return [options._parcelMutation.proposals.getProposal('conflict')];
            };

            await expect(ProposalManager.updateProposalInPlace('target', edited()))
                .resolves.toMatchObject({ applied: true, unappliedIds: ['conflict'] });

            expect(store.getProposal('target').applied).toBe(true);
            expect(store.getProposal('conflict').applied).toBe(false);
            // The rival's ground is re-derived with the edit, as for an explicit apply.
            expect(seedIds).toEqual(['target', 'target', 'conflict']);
        });

        it('leaves the record and its dependents as they were when the ground refuses the edit', async () => {
            ProposalManager.rematerializeFlatScope = async () => ({ ok: false, failed: [{ proposalId: 'target', message: 'ground missing' }] });

            await expect(ProposalManager.updateProposalInPlace('target', edited(), { unapplyIds: ['conflict'] })).resolves.toBeNull();

            expect(store.getProposal('target').value).toBe('before');
            expect(store.getProposal('conflict').applied).toBe(true);
            expect(ProposalManager.getLastApplyFailure('target')).toBe('ground missing');
        });
    });
});
