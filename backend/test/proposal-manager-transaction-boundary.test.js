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
            getAllProposals() { return [...this.proposals.values()]; }
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
        ProposalManager._collectAppliedAlternativesForExplicitApply = originalCollectAlternatives;
        if (previousSetProposalApplied === undefined) delete globalThis.setProposalApplied;
        else globalThis.setProposalApplied = previousSetProposalApplied;
        if (previousStorage === undefined) delete globalThis.proposalStorage;
        else globalThis.proposalStorage = previousStorage;
    });

    it('restores all proposal records when an apply returns false after nested conflict parking', async () => {
        const targetIdentity = store.proposals.get('target');
        const conflictIdentity = store.proposals.get('conflict');

        ProposalManager._unapplyProposalTransactionBody = async (proposalId) => {
            const proposal = store.getProposal(proposalId);
            proposal.applied = false;
            proposal.value = 'parked';
            return true;
        };
        ProposalManager._applyProposalTransactionBody = async function (proposalId, options) {
            const proposal = store.getProposal(proposalId);
            proposal.applied = true;
            proposal.value = 'partially-applied';
            store.proposals.set('created-during-apply', { proposalId: 'created-during-apply' });
            await this.unapplyProposal('conflict', {
                skipConfirm: true,
                _mutationTransaction: options._mutationTransaction
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
        ProposalManager._applyProposalTransactionBody = async proposalId => {
            store.getProposal(proposalId).value = 'mutated';
            throw cause;
        };

        await expect(ProposalManager.applyProposal('target', { replay: true })).rejects.toBe(cause);
        expect(store.getProposal('target').value).toBe('before');
        expect(store.batchDepth).toBe(0);
    });

    it('makes the explicitly applied alternative the only standing member', async () => {
        ProposalManager._collectAppliedAlternativesForExplicitApply = () => [store.getProposal('conflict')];
        ProposalManager.deriveForNewProposal = async () => ({ applied: true });

        await expect(ProposalManager.applyProposal('target')).resolves.toBe(true);

        expect(store.getProposal('target').applied).toBe(true);
        expect(store.getProposal('conflict').applied).toBe(false);
    });

    it('restores the previous alternative when the derivation removes the chosen proposal', async () => {
        let targetDerivations = 0;
        let componentRestores = 0;
        ProposalManager._collectAppliedAlternativesForExplicitApply = () => [store.getProposal('conflict')];
        ProposalManager.deriveForNewProposal = async () => {
            targetDerivations += 1;
            setProposalApplied(store.getProposal('target'), false, { stamp: false });
            return { applied: true };
        };
        ProposalManager.rematerializeFlatScope = async () => {
            componentRestores += 1;
            return { ok: true, failed: [] };
        };

        await expect(ProposalManager.applyProposal('target')).resolves.toBe(false);

        // One attempted target derivation, then one cadastre-first component replay after the
        // authored record map is restored. There is no payload undo or per-alternative restore.
        expect(targetDerivations).toBe(1);
        expect(componentRestores).toBe(1);
        expect(store.getProposal('target')).toEqual({ proposalId: 'target', applied: false, value: 'before' });
        expect(store.getProposal('conflict')).toEqual({ proposalId: 'conflict', applied: true, value: 'before' });
    });
});
