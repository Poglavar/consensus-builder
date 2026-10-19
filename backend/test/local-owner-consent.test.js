// Verify the browser's local owner-state adapter never promotes aggregate flags into decisions.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const bookkeeping = require('../../frontend/js/proposals/owner-acceptance.js');
const flow = require('../../frontend/js/proposals/ownership-flow.js');
const status = require('../../frontend/js/proposals/status.js');
const execution = readFileSync(new URL('../../frontend/js/proposals/execution.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../../frontend/js/proposals/core.js', import.meta.url), 'utf8');

function fixture() {
    const proposal = { proposalId: 'local-consent', goal: 'as-is', cadastreParcelIds: ['base-a'], acceptedParcelIds: ['base-a'] };
    const alert = vi.fn();
    const bridge = { acceptProposal: vi.fn() };
    const context = createContext({
        ...bookkeeping, ...status, __ownershipFlow: flow, setTimeout: vi.fn(), console: { debug: vi.fn(), error: vi.fn() },
        getOwnerSlotsForParcel: () => [{ key: 'owner-a', displayName: 'Owner A' }],
        getCurrentUserAgent: () => ({ id: 'actor-a' }),
        proposalConsentFingerprint: () => 'terms-a', normalizeParcelId: id => String(id), normalizeParcelIdList: ids => ids.map(String),
        proposalStorage: { getProposal: () => proposal, save: vi.fn() },
        showProposalAlertMessage: alert, ProposalChainBridge: bridge,
        getProposalNftInfo: () => ({ chain: 'evm', tokenId: '1', contract: 'fixture' })
    });
    context.window = context;
    runInContext(core, context);
    runInContext(execution, context);
    context.showProposalAlertMessage = alert;
    return { context, proposal, alert, bridge };
}

function seedAcceptance(proposal) {
    proposal.ownerAcceptances = bookkeeping.normalizeOwnerAcceptances({
        'base-a': { ownerOrder: ['owner-a'], acceptedOwnerKeys: ['owner-a'],
            acceptedBy: { 'owner-a': { effectHash: 'terms-a', agentId: 'actor-a' } } }
    });
}

describe('local owner consent evidence', () => {
    it.each(['Active', 'Executed'])('withdrawing local consent preserves %s lifecycle and map state', async lifecycleStatus => {
        const { context, proposal } = fixture();
        Object.assign(proposal, { lifecycleStatus, executedAt: '2026-10-01T10:00:00.000Z', applied: true });
        seedAcceptance(proposal);
        const result = await context.rejectProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(result).toMatchObject({ ownerKey: 'owner-a', parcelAccepted: false });
        expect(proposal.ownerAcceptances['base-a'].acceptedOwnerKeys).toEqual([]);
        expect(proposal.acceptedParcelIds).toEqual([]);
        expect(proposal).toMatchObject({ lifecycleStatus, executedAt: '2026-10-01T10:00:00.000Z', applied: true });
        expect(context.proposalStorage.save).toHaveBeenCalledOnce();
    });

    it('allows an applied Active conditional proposal to reach the chain withdrawal', async () => {
        const { context, proposal, bridge, alert } = fixture();
        Object.assign(proposal, { lifecycleStatus: 'Active', isConditional: true, applied: true });
        seedAcceptance(proposal);
        bridge.withdrawAcceptance = vi.fn(async () => ({}));
        // Stop after the chain boundary; rendering and local removal are exercised separately.
        context.rejectProposal = vi.fn(async () => null);
        await context.handleUserRejectProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(bridge.withdrawAcceptance).toHaveBeenCalledWith({ proposalId: '1', parcelId: 'base-a', chainId: 'evm', contractAddress: 'fixture' });
        expect(context.rejectProposal).toHaveBeenCalledWith(proposal.proposalId, 'base-a', 'owner-a');
        expect(alert).not.toHaveBeenCalled();
    });

    it.each([
        { lifecycleStatus: 'Executed', isConditional: true, code: 'cannot_withdraw_executed_proposal' },
        { lifecycleStatus: 'Active', isConditional: false, code: 'cannot_withdraw_non_conditional' }
    ])('retains the chain withdrawal guard for $code', async ({ code, ...fields }) => {
        const { context, proposal, bridge, alert } = fixture();
        Object.assign(proposal, fields, { applied: false });
        seedAcceptance(proposal);
        bridge.withdrawAcceptance = vi.fn();
        await context.handleUserRejectProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(bridge.withdrawAcceptance).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalledWith(code, expect.any(String));
        expect(proposal.ownerAcceptances['base-a'].acceptedOwnerKeys).toEqual(['owner-a']);
    });

    it('reading state drops unsupported aggregate flags without inventing an owner decision', () => {
        const { context, proposal } = fixture();
        const state = context.getProposalOwnerAcceptanceState(proposal, 'base-a');
        expect(state.entries[0]).toMatchObject({ accepted: false, acceptedAt: null, canAccept: true });
        expect(proposal.acceptedParcelIds).toEqual([]);
        expect(proposal.ownerAcceptances['base-a'].acceptedBy).toEqual({});
    });

    it('hashless records remain inspectable but do not count or acquire timestamps', () => {
        const { context, proposal } = fixture();
        proposal.ownerAcceptances = bookkeeping.normalizeOwnerAcceptances({
            'base-a': { owners: {}, ownerOrder: ['owner-a'], acceptedOwnerKeys: ['owner-a'], acceptedBy: {} }
        });
        expect(context.getProposalOwnerAcceptanceState(proposal, 'base-a').entries[0])
            .toMatchObject({ accepted: false, acceptedAt: null, termsChanged: false });
        expect(context.buildProposalOwnerAcceptanceSummaryFast(proposal).acceptedOwners).toBe(0);
        expect(proposal.acceptedParcelIds).toEqual([]);
        expect(proposal.ownerAcceptances['base-a'].acceptedOwnerKeys).toEqual(['owner-a']);
    });

    it('labels changed terms only when an earlier recorded commitment differs', () => {
        const { context, proposal } = fixture();
        proposal.ownerAcceptances = bookkeeping.normalizeOwnerAcceptances({
            'base-a': { ownerOrder: ['owner-a'], acceptedOwnerKeys: ['owner-a'], acceptedBy: { 'owner-a': { effectHash: 'terms-before' } } }
        });
        expect(context.getProposalOwnerAcceptanceState(proposal, 'base-a').entries[0])
            .toMatchObject({ accepted: false, termsChanged: true });
        context.proposalConsentFingerprint = () => null;
        expect(context.getProposalOwnerAcceptanceState(proposal, 'base-a').entries[0].termsChanged).toBe(false);
    });

    it('does not count even matching records when the validity evaluator is unavailable', () => {
        const { context, proposal } = fixture();
        proposal.ownerAcceptances = bookkeeping.normalizeOwnerAcceptances({
            'base-a': { ownerOrder: ['owner-a'], acceptedOwnerKeys: ['owner-a'], acceptedBy: { 'owner-a': { effectHash: 'terms-a' } } }
        });
        delete context.__ownershipFlow;
        expect(context.getProposalOwnerAcceptanceState(proposal, 'base-a').entries[0].accepted).toBe(false);
        expect(proposal.acceptedParcelIds).toEqual([]);
    });

    it('refreshes the tally after adding an owner to the parcel roster', () => {
        const { context, proposal } = fixture();
        proposal.ownerAcceptances = bookkeeping.normalizeOwnerAcceptances({
            'base-a': { ownerOrder: ['owner-a'], acceptedOwnerKeys: ['owner-a'], acceptedBy: { 'owner-a': { effectHash: 'terms-a' } } }
        });
        context.getOwnerSlotsForParcel = () => [{ key: 'owner-a' }, { key: 'owner-b' }];
        expect(context.getProposalOwnerAcceptanceState(proposal, 'base-a').entries.map(entry => entry.accepted)).toEqual([true, false]);
        expect(proposal.acceptedParcelIds).toEqual([]);
    });

    it('refuses missing current terms before a chain call or local receipt write', async () => {
        const { context, proposal, alert, bridge } = fixture();
        context.proposalConsentFingerprint = () => null;
        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(bridge.acceptProposal).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalledWith('proposal_terms_unavailable', expect.any(String));
        expect(await context.acceptProposal(proposal.proposalId, 'base-a', 'owner-a')).toBeNull();
        expect(proposal.ownerAcceptances).toBeUndefined();
        expect(context.proposalStorage.save).not.toHaveBeenCalled();
    });
});
