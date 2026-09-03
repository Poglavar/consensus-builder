import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { setProposalApplied } = require('../../frontend/js/proposals/status.js');

describe('ProposalManager mutation boundary', () => {
    let previousStorage;
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
        previousStorage = globalThis.proposalStorage;
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

    it('restores state and rethrows the original error', async () => {
        const cause = new Error('geometry exploded');
        ProposalManager._applyProposalTransactionBody = async (proposalId, options) => {
            options._parcelMutation.proposals.getProposal(proposalId).value = 'mutated';
            throw cause;
        };

        await expect(ProposalManager.applyProposal('target', { replay: true })).rejects.toBe(cause);
        expect(store.getProposal('target').value).toBe('before');
        expect(store.batchDepth).toBe(0);
    });

    it('rolls back the tentative applied flag when a new proposal cannot materialize', async () => {
        const targetIdentity = store.getProposal('target');
        ProposalManager.rematerializeFlatScope = async () => ({
            ok: false,
            failed: [{ proposalId: 'target', reason: 'cadastral ground is incomplete' }]
        });

        await expect(ProposalManager.deriveForNewProposal(targetIdentity)).resolves.toBeNull();

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
});
