// Verify the browser's local owner-state adapter never promotes aggregate flags into decisions.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const bookkeeping = require('../../frontend/js/proposals/owner-acceptance.js');
const flow = require('../../frontend/js/proposals/ownership-flow.js');
const status = require('../../frontend/js/proposals/status.js');
const chainStatus = require('../../frontend/js/proposals/chain-status.js');
const execution = readFileSync(new URL('../../frontend/js/proposals/execution.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../../frontend/js/proposals/core.js', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');
const agentActions = parse(agents, { sourceType: 'script' }).program.body
    .filter(node => node.type === 'FunctionDeclaration' && ['executeAgentAction', 'buildProposalLogLinkAgent'].includes(node.id.name))
    .map(node => agents.slice(node.start, node.end)).join('\n');

function fixture() {
    const proposal = { proposalId: 'local-consent', goal: 'as-is', lifecycleStatus: 'Active', applied: false,
        cadastreParcelIds: ['base-a'], acceptedParcelIds: ['base-a'] };
    const agent = { id: 'actor-a', name: 'Actor A', proposalsAccepted: [], proposalsExecuted: [], ethBalance: 100 };
    const alert = vi.fn();
    const bridge = { acceptProposal: vi.fn() };
    const context = createContext({
        ...bookkeeping, ...status, __ownershipFlow: flow, setTimeout: vi.fn(), console: { debug: vi.fn(), error: vi.fn() },
        getOwnerSlotsForParcel: () => [{ key: 'owner-a', displayName: 'Owner A' }],
        getCurrentUserAgent: () => agent,
        proposalConsentFingerprint: () => 'terms-a', normalizeParcelId: id => String(id), normalizeParcelIdList: ids => ids.map(String),
        proposalStorage: { getProposal: () => proposal, save: vi.fn() },
        showProposalAlertMessage: alert, ProposalChainBridge: bridge,
        ProposalChainStatus: chainStatus,
        getProposalNftInfo: () => ({ chain: 'evm', tokenId: '1', contract: 'fixture' }),
        ProposalManager: { applyProposal: vi.fn() }, transferParcelOwnership: vi.fn(),
        resolveProposalRecipientAgentId: () => 'recipient-a',
        PersistentStorage: { getItem: () => 'actor-a' },
        AgentSupportSimulation: { settle: vi.fn() },
        agentStorage: { updateAgent: vi.fn() },
        document: { getElementById: () => null, querySelector: () => null },
        showProposalInfo: vi.fn(), updateStatus: vi.fn(),
        addUserActionToGameLog: vi.fn()
    });
    context.window = context;
    runInContext(core, context);
    runInContext(execution, context);
    runInContext(agentActions, context);
    context.showProposalAlertMessage = alert;
    context.refreshProposalOwnerAcceptanceUI = vi.fn();
    context.restoreProposalDetailsScroll = vi.fn();
    return { context, proposal, agent, alert, bridge };
}

function seedAcceptance(proposal) {
    proposal.ownerAcceptances = bookkeeping.normalizeOwnerAcceptances({
        'base-a': { ownerOrder: ['owner-a'], acceptedOwnerKeys: ['owner-a'],
            acceptedBy: { 'owner-a': { effectHash: 'terms-a', agentId: 'actor-a' } } }
    });
}

describe('local owner consent evidence', () => {
    it('refuses unknown lifecycle before a wallet or local acceptance and hides Accept', async () => {
        const { context, proposal, bridge, alert } = fixture();
        delete proposal.lifecycleStatus;
        const state = context.getProposalOwnerAcceptanceState(proposal, 'base-a');
        expect(state.entries[0].canAccept).toBe(false);
        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(bridge.acceptProposal).not.toHaveBeenCalled();
        expect(await context.acceptProposal(proposal.proposalId, 'base-a', 'owner-a')).toBeNull();
        expect(proposal.ownerAcceptances['base-a'].acceptedOwnerKeys).toEqual([]);
        expect(alert).toHaveBeenCalledWith('proposal_lifecycle_unknown', expect.stringContaining('status is unknown'));
        expect(context.proposalStorage.save).not.toHaveBeenCalled();
    });
    function chainAcceptance(context, bridge, code = 1) {
        const nft = { chain: '84532', contract: `0x${'a'.repeat(40)}`, tokenId: '5' };
        context.getProposalNftInfo = () => nft;
        bridge.acceptProposal.mockResolvedValue({ chainId: nft.chain, contractAddress: nft.contract, proposalId: '5',
            blockNumber: 42, lifecycle: { statusCode: code, blockNumber: 42 } });
        return nft;
    }

    it.each([['Active', 0], ['Executed', 1]])('reads %s from confirmed EVM acceptance without model or payment effects', async (lifecycleStatus, code) => {
        const { context, proposal, agent, bridge, alert } = fixture();
        chainAcceptance(context, bridge, code);
        context.document.getElementById = id => id === 'proposal-details-content'
            ? { dataset: { proposalId: proposal.proposalId } } : null;
        proposal.applied = true;
        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(proposal).toMatchObject({ lifecycleStatus, applied: true, acceptedParcelIds: ['base-a'] });
        expect(proposal.executedAt).toBeUndefined();
        expect(agent.proposalsAccepted).toEqual([proposal.proposalId]);
        expect(agent.proposalsExecuted).toEqual([]);
        expect(agent.ethBalance).toBe(100);
        expect(context.ProposalManager.applyProposal).not.toHaveBeenCalled();
        expect(context.transferParcelOwnership).not.toHaveBeenCalled();
        expect(context.AgentSupportSimulation.settle).not.toHaveBeenCalled();
        expect(alert).not.toHaveBeenCalled();
        expect(context.showProposalInfo).toHaveBeenCalledWith(proposal, 'base-a', true);
        expect(context.updateStatus).toHaveBeenLastCalledWith('Acceptance recorded on chain.');
    });

    it('does not replace a different proposal panel after wallet confirmation', async () => {
        const { context, proposal, bridge } = fixture();
        chainAcceptance(context, bridge);
        context.document.getElementById = id => id === 'proposal-details-content'
            ? { dataset: { proposalId: 'different-proposal' } } : null;
        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(proposal.lifecycleStatus).toBe('Executed');
        expect(context.showProposalInfo).not.toHaveBeenCalled();
    });

    it.each([null, { statusCode: null, blockNumber: 42 }, { statusCode: 9, blockNumber: 42 }])(
        'preserves confirmed consent and old lifecycle when status is unavailable: %s', async lifecycle => {
            const { context, proposal, bridge, alert } = fixture();
            const nft = chainAcceptance(context, bridge);
            bridge.acceptProposal.mockResolvedValue({ chainId: nft.chain, contractAddress: nft.contract, proposalId: '5', blockNumber: 42, lifecycle });
            await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');
            expect(proposal.lifecycleStatus).toBe('Active');
            expect(proposal.acceptedParcelIds).toEqual(['base-a']);
            expect(bridge.acceptProposal).toHaveBeenCalledOnce();
            expect(alert).toHaveBeenCalledWith('acceptance_confirmed_status_unavailable', expect.stringContaining('Acceptance was confirmed'));
        });

    it('still refreshes the chain lifecycle if local consent bookkeeping cannot complete', async () => {
        const { context, proposal, bridge, agent } = fixture();
        chainAcceptance(context, bridge);
        context.document.getElementById = id => id === 'proposal-details-content'
            ? { dataset: { proposalId: proposal.proposalId } } : null;
        context.acceptProposal = vi.fn(async () => null);
        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(proposal.lifecycleStatus).toBe('Executed');
        expect(context.showProposalInfo).toHaveBeenCalledWith(proposal, 'base-a', true);
        expect(context.updateStatus).toHaveBeenLastCalledWith('Acceptance recorded on chain.');
        expect(agent.proposalsAccepted).toEqual([]);
        expect(context.ProposalManager.applyProposal).not.toHaveBeenCalled();
    });

    it.each([true, false, undefined])('final local acceptance records consent only with funded=%s', async funded => {
        const { context, proposal } = fixture();
        if (funded !== undefined) proposal.funded = funded;
        const result = await context.acceptProposal(proposal.proposalId, 'base-a', 'owner-a', { acceptedByAgentId: 'actor-a' });
        expect(result).toMatchObject({ ownerAccepted: true, parcelAccepted: true });
        expect(result).not.toHaveProperty('proposalExecuted');
        expect(proposal.ownerAcceptances['base-a'].acceptedBy['owner-a']).toMatchObject({ effectHash: 'terms-a', agentId: 'actor-a' });
        expect(proposal.acceptedParcelIds).toEqual(['base-a']);
        expect(proposal).toMatchObject({ lifecycleStatus: 'Active', applied: false });
        expect(proposal.executedAt).toBeUndefined();
        expect(proposal.funded).toBe(funded);
        expect(context.ProposalManager.applyProposal).not.toHaveBeenCalled();
        expect(context.transferParcelOwnership).not.toHaveBeenCalled();
    });

    it('a human acceptance records accepted activity without an execution claim', async () => {
        const { context, proposal, agent, bridge } = fixture();
        proposal.funded = true;
        context.getProposalNftInfo = () => null;
        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(agent.proposalsAccepted).toEqual([proposal.proposalId]);
        expect(agent.proposalsExecuted).toEqual([]);
        expect(context.addUserActionToGameLog).toHaveBeenCalledWith(expect.stringContaining('recorded acceptance'));
        expect(context.agentStorage.updateAgent).toHaveBeenCalledWith(agent.id, { proposalsAccepted: [proposal.proposalId] });
        expect(bridge.acceptProposal).not.toHaveBeenCalled();
        expect(proposal.lifecycleStatus).toBe('Active');
    });

    it('an agent acceptance leaves simulated support and balances unchanged', async () => {
        const { context, proposal, agent } = fixture();
        Object.assign(proposal, { funded: true, budget: 10,
            simulatedPledges: [{ agentId: agent.id, amount: 40, status: 'Active' }],
            simulatedDonations: [{ agentId: agent.id, amount: 10, status: 'Escrowed' }] });
        const before = JSON.stringify({ pledges: proposal.simulatedPledges, donations: proposal.simulatedDonations });
        const message = await context.executeAgentAction(agent, { type: 'accept', proposalId: proposal.proposalId, parcelId: 'base-a', ownerKey: 'owner-a' });
        expect(message).toContain('accepted proposal');
        expect(agent.proposalsAccepted).toEqual([proposal.proposalId]);
        expect(agent.proposalsExecuted).toEqual([]);
        expect(agent.ethBalance).toBe(100);
        expect(proposal.budget).toBe(10);
        expect(JSON.stringify({ pledges: proposal.simulatedPledges, donations: proposal.simulatedDonations })).toBe(before);
        expect(context.AgentSupportSimulation.settle).not.toHaveBeenCalled();
        expect(context.ProposalManager.applyProposal).not.toHaveBeenCalled();
        expect(context.transferParcelOwnership).not.toHaveBeenCalled();
        expect(proposal.lifecycleStatus).toBe('Active');
        expect(proposal.executedAt).toBeUndefined();
    });

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
