import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

describe('ProposalManager mutation boundary', () => {
    let previousStorage;
    let originalApplyBody;
    let originalUnapplyBody;
    let originalRefresh;
    let store;

    beforeEach(() => {
        previousStorage = globalThis.proposalStorage;
        originalApplyBody = ProposalManager._applyProposalTransactionBody;
        originalUnapplyBody = ProposalManager._unapplyProposalTransactionBody;
        originalRefresh = ProposalManager._refreshUIAfterProposalChange;

        const proposals = new Map([
            ['target', { proposalId: 'target', applied: false, value: 'before' }],
            ['conflict', { proposalId: 'conflict', applied: true, value: 'before' }]
        ]);
        store = {
            proposals,
            proposalIndexByHash: new Map(),
            nextProposalId: 3,
            batchDepth: 0,
            saves: 0,
            beginBatch() { this.batchDepth += 1; },
            endBatch() { this.batchDepth -= 1; },
            save() { this.saves += 1; },
            getProposal(id) { return this.proposals.get(String(id)); },
            _invalidateAncestorIndex() {}
        };
        globalThis.proposalStorage = store;
        ProposalManager._refreshUIAfterProposalChange = () => {};
    });

    afterEach(() => {
        ProposalManager._applyProposalTransactionBody = originalApplyBody;
        ProposalManager._unapplyProposalTransactionBody = originalUnapplyBody;
        ProposalManager._refreshUIAfterProposalChange = originalRefresh;
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

        await expect(ProposalManager.applyProposal('target')).resolves.toBe(false);
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

        await expect(ProposalManager.applyProposal('target')).rejects.toBe(cause);
        expect(store.getProposal('target').value).toBe('before');
        expect(store.batchDepth).toBe(0);
    });
});
