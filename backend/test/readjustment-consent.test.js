// Exercise the local LR consent adapter with the same abstract-rights runtime loaded by the app.
import { createHmac } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const deal = require('../../frontend/js/reparcellization-deal.js');
const approval = require('../../frontend/js/proposals/approval.js');
const ownership = require('../../frontend/js/reparcellization-ownership.js');
const turf = require('@turf/turf');
const source = readFileSync(new URL('../../frontend/js/proposals/execution.js', import.meta.url), 'utf8');
const coreSource = readFileSync(new URL('../../frontend/js/proposals/core.js', import.meta.url), 'utf8');
const approvalSource = readFileSync(new URL('../../frontend/js/proposals/approval.js', import.meta.url), 'utf8');
const providerSource = readFileSync(new URL('../../frontend/js/proposals/approval-providers.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../../frontend/js/proposals/approval-runtime.js', import.meta.url), 'utf8');
const shaSource = readFileSync(new URL('../../frontend/vendor/noble-hashes-1.8.0/sha256.js', import.meta.url), 'utf8');
const validationSource = readFileSync(new URL('../../frontend/js/reparcellization-validation.js', import.meta.url), 'utf8');
const reviewSource = readFileSync(new URL('../../frontend/js/proposals/approval-review.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../../frontend/js/proposals/approval-panel.js', import.meta.url), 'utf8');
const geometry = { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] };
const signingSecret = 'test-only owner decision key';

function fixture() {
    const proposal = {
        proposalId: 'lr-consent', goal: 'reparcellization', lifecycleStatus: 'Active', funded: true,
        cadastreParcelIds: ['base-a', 'base-b'], offer: 30, offerCurrency: 'EUR', lens: ['court-member-a'],
        approvalConfig: {
            schema: 'proposal-approval/v1',
            rights: {
                schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'rights-snapshot-1' },
                parcels: [
                    { parcelId: 'base-a', complete: true, areaM2: 100, owners: [
                        { ownerId: 'owner-a', share: '1/1', name: 'Alice Example' }
                    ] },
                    { parcelId: 'base-b', complete: true, areaM2: 100, owners: [
                        { ownerId: 'owner-b', share: '1/1', name: 'Bob Example' }
                    ] }
                ]
            },
            policy: { type: 'unanimous' }
        },
        reparcellization: {
            poolGeometry: geometry,
            polygons: [{ geometry, owners: [{ ownerKey: 'owner-a', share: 0.6 }, { ownerKey: 'owner-b', share: 0.4 }], jointPool: true }],
            ownerShares: [
                { ownerKey: 'owner-a', cashOffer: 10, displayName: 'Alice Example' },
                { ownerKey: 'owner-b', cashOffer: 20, displayName: 'Bob Example' }
            ]
        },
        // These forged legacy fields must not grant abstract approval.
        acceptedParcelIds: ['base-a', 'base-b'],
        ownerAcceptances: { 'base-a': { acceptedOwnerKeys: ['owner-a'], ownerOrder: ['owner-a'], acceptedBy: { 'owner-a': { acceptedAt: 'old' } } } }
    };
    let currentActor = { id: 'owner-a', name: 'Alice Example' };
    let nftInfo = null;
    const saves = [];
    const showAlert = vi.fn();
    const bridge = { acceptProposal: vi.fn(async () => ({ accepted: true })) };
    const context = createContext({
        ...approval,
        TextEncoder,
        // Like storage.js getProposalI18nHelper without a loaded language: the fallback, interpolated.
        getProposalI18nHelper: () => (_key, fallback, params = {}) => String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (key in params ? params[key] : match)),
        getCurrentUserAgent: () => currentActor,
        getProposalNftInfo: () => nftInfo,
        turf,
        getLifecycleStatus: proposalValue => proposalValue.lifecycleStatus,
        isProposalExpired: () => false,
        proposalStorage: {
            getProposal: id => id === proposal.proposalId ? proposal : null,
            _indexProposal: vi.fn(), save: () => saves.push(JSON.parse(JSON.stringify(proposal)))
        },
        proposalRecipientConsentSatisfied: () => true,
        isVoteProposal: () => false,
        isNonBindingProposal: () => false,
        showProposalAlertMessage: showAlert,
        showStyledAlert: showAlert,
        alert: showAlert,
        updateShowProposalsButton: vi.fn(),
        autoApplyExecutedProposalToMap: vi.fn(), applyProposalOwnershipTransfer: vi.fn(),
        CbFormat: require('../../frontend/js/format.js'),
        escapeHtml: require('../../frontend/js/shared-utils.js').escapeHtml,
        normalizeParcelId: id => String(id), normalizeParcelIdList: ids => ids.map(String),
        // The Accept review dialog (approval-panel.js) is the user path; it needs no DOM to refuse.
        document: {}, solanaWalletManager: { on: vi.fn() },
        console: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    });
    // The app resolves these browser APIs from window; using the VM global keeps both paths aligned.
    context.window = context;
    runInContext(shaSource, context);
    runInContext(approvalSource, context);
    context.ReparcellizationOwnership = ownership;
    context.ReparcellizationDeal = deal;
    runInContext(validationSource, context);
    runInContext(providerSource, context);
    runInContext(runtimeSource, context);
    context.ReparcellizationDeal = deal;
    runInContext(reviewSource, context);
    runInContext(coreSource, context);
    runInContext(source, context);
    runInContext(panelSource, context);
    context.autoApplyExecutedProposalToMap = vi.fn();
    context.applyProposalOwnershipTransfer = vi.fn();

    const sign = statement => createHmac('sha256', signingSecret)
        .update(approval.stableStringify(statement), 'utf8').digest('hex');
    const signDecision = vi.fn(async ({ statement }) => sign(statement));
    context.ProposalApprovalAuthorities.register('test-lens-signer', {
        authorize: ({ ownerId, actor, contextHash }) => {
            if (actor?.id !== ownerId) return null;
            return {
                rights: { contextHash, member: 'court-member-a', evidenceRef: `rights:${ownerId}` },
                authority: { contextHash, member: 'court-member-a', evidenceRef: `authority:${ownerId}`, ownerId, actorId: actor.id }
            };
        },
        signDecision,
        verifyReceipt: ({ receipt, statement }) => receipt.decisionProof === sign(statement)
    });
    return {
        context, proposal, saves, showAlert, bridge, signDecision,
        setActor(actor) { currentActor = actor; },
        setNft(value) { nftInfo = value; }
    };
}

describe('fixed readjustment consent', () => {
    it('binds each owner receipt to the whole cash deal, lapses changed terms, and archives the old receipt on re-consent', async () => {
        const { context, proposal, saves, setActor } = fixture();

        // Legacy parcel acceptances and the caller-provided accepted parcel list do not count.
        expect(context.buildProposalOwnerAcceptanceSummary(proposal).acceptedOwners).toBe(0);
        expect(proposal.acceptedParcelIds).toEqual([]);
        expect(proposal.ownerAcceptances['base-a'].acceptedOwnerKeys).toEqual(['owner-a']);

        // An authenticated profile may consent only for its matching rights identity. Forged UI
        // metadata must not make Bob an approver for Alice.
        setActor({ id: 'owner-b', name: 'Bob Example' });
        await context.acceptProposal(proposal.proposalId, 'base-a', 'owner-a', { acceptedByAgentId: 'owner-a' });
        expect(proposal.ownerApprovals).toBeUndefined();
        expect(context.getProposalOwnerAcceptanceState(proposal, 'base-a').entries[0])
            .toMatchObject({ key: 'owner-a', displayName: 'Owner A', accepted: false, canAccept: false });

        setActor({ id: 'owner-a', name: 'Alice Example' });
        const first = await context.acceptProposal(proposal.proposalId, 'base-a', 'owner-a', { acceptedByAgentId: 'owner-b' });
        expect(first).toMatchObject({ ownerKey: 'owner-a', ownerAccepted: true, parcelAccepted: true, proposalExecuted: false });
        const firstReceipt = structuredClone(proposal.ownerApprovals['owner-a']);
        expect(firstReceipt).toMatchObject({ actorId: 'owner-a', decision: 'approve', effectHash: deal.fingerprint(proposal), providerId: 'test-lens-signer' });
        expect(firstReceipt).not.toHaveProperty('acceptedByAgentId');
        expect(context.ProposalApprovalAuthorities.verifyReceipt(proposal, firstReceipt)).toBe(true);
        expect(context.buildProposalOwnerAcceptanceSummary(proposal)).toMatchObject({ acceptedOwners: 1, totalOwners: 2 });
        const reloaded = JSON.parse(JSON.stringify(proposal));
        expect(context.ProposalApprovalAuthorities.verifyReceipt(reloaded, reloaded.ownerApprovals['owner-a'])).toBe(true);
        expect(context.ProposalApprovalRuntime.summary(reloaded, deal.fingerprint(reloaded)).acceptedOwners).toBe(1);

        // Rebalance the per-owner cash while retaining the whole-agreement total.
        proposal.reparcellization.ownerShares[0].cashOffer = 20;
        proposal.reparcellization.ownerShares[1].cashOffer = 10;
        setActor({ id: 'owner-b', name: 'Bob Example' });
        const afterEdit = await context.acceptProposal(proposal.proposalId, 'base-b', 'owner-b');
        expect(afterEdit).toMatchObject({ ownerKey: 'owner-b', parcelAccepted: true, proposalExecuted: false });
        expect(proposal.ownerApprovals['owner-a']).toMatchObject({ effectHash: firstReceipt.effectHash });
        expect(context.ProposalApprovalRuntime.summary(proposal, deal.fingerprint(proposal)))
            .toMatchObject({ acceptedOwners: 1, passed: false });
        expect(proposal.acceptedParcelIds).toEqual(['base-b']);
        expect(context.autoApplyExecutedProposalToMap).not.toHaveBeenCalled();
        setActor({ id: 'owner-a', name: 'Alice Example' });
        expect(context.getProposalOwnerAcceptanceState(proposal, 'base-a').entries[0])
            .toMatchObject({ accepted: false, termsChanged: true, canAccept: true });

        // Same owner accepts the new cash split: the old signed receipt is preserved as history,
        // while the new signed receipt is the only one counted for the current deal.
        const final = await context.acceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(final).toMatchObject({ proposalExecuted: true });
        expect(proposal.ownerApprovals['owner-a'].effectHash).toBe(deal.fingerprint(proposal));
        expect(proposal.ownerApprovals['owner-a'].effectHash).not.toBe(firstReceipt.effectHash);
        expect(proposal.ownerApprovalHistory).toEqual([firstReceipt]);
        expect(context.ProposalApprovalRuntime.summary(proposal, deal.fingerprint(proposal)))
            .toMatchObject({ acceptedOwners: 2, passed: true });
        expect(context.autoApplyExecutedProposalToMap).toHaveBeenCalledTimes(1);
        expect(saves.length).toBe(3);
    });

    it('rejects forged receipts and keeps cash-review owner labels anonymous and escaped', () => {
        const { context, proposal } = fixture();
        const hash = deal.fingerprint(proposal);
        const contextHash = approval.contextHash(proposal);
        proposal.ownerApprovals = {
            'owner-a': {
                ownerId: 'owner-a', actorId: 'owner-a', effectHash: hash, decision: 'approve', providerId: 'test-lens-signer',
                acceptedAt: '2026-10-11T00:00:00.000Z', decisionProof: 'forged',
                evidence: {
                    rights: { contextHash, member: 'court-member-a', evidenceRef: 'caller-claim' },
                    authority: { contextHash, member: 'court-member-a', evidenceRef: 'caller-claim', ownerId: 'owner-a', actorId: 'owner-a' }
                }
            }
        };
        expect(context.ProposalApprovalRuntime.summary(proposal, hash).acceptedOwners).toBe(0);

        proposal.reparcellization.ownerShares[0].displayName = '<img src=x onerror=alert(1)>';
        const html = context.buildReadjustmentCashReviewHtml(proposal);
        expect(html).toContain('Owner A');
        expect(html).toContain('Owner B');
        expect(html).not.toContain('Alice Example');
        expect(html).not.toContain('Bob Example');
        expect(html).not.toContain('<img');
        expect(html).toContain('30.00');
    });

    it('labels cash offers by the rights snapshot and names a recipient outside it', () => {
        const { context, proposal } = fixture();
        // A ledger key that is not an owner in the rights snapshot must not borrow "Owner A".
        proposal.reparcellization.ownerShares = [
            { ownerKey: 'owner-b', cashOffer: 20 },
            { ownerKey: 'Alice Example', cashOffer: 10 }
        ];
        const rows = [...context.buildReadjustmentCashReviewHtml(proposal).matchAll(/<li data-money-[^>]*>\s*<span>([^<]*)<\/span>\s*<strong>([^<]*)<\/strong>/g)]
            .map(match => [match[1], match[2]]);
        // Snapshot owners come first in label order; a recipient outside the snapshot follows them.
        expect(rows).toEqual([['Owner B', 'receives 20.00\u00a0EUR'], ['Recipient outside the ownership snapshot', 'receives 10.00\u00a0EUR'],
            ['Sponsor', 'pays in 30.00\u00a0EUR']]);
    });

    it('rejects unknown owner slots and invalid deals before opening the wallet flow', async () => {
        const { context, proposal, bridge, showAlert, setNft } = fixture();
        context.window.ProposalChainBridge = bridge;
        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'forged-owner');
        expect(bridge.acceptProposal).not.toHaveBeenCalled();
        expect(proposal.ownerApprovals).toBeUndefined();
        expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('selected lens'), expect.anything());

        setNft({ tokenId: '1', chain: 'ethereum' });
        proposal.reparcellization.polygons[0].owners[0].share = 0.1;
        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('Complete and correct'), expect.anything());
        expect(bridge.acceptProposal).not.toHaveBeenCalled();
        expect(proposal.ownerApprovals).toBeUndefined();
    });

    it('rejects invalid geometry before invoking an approval signer', async () => {
        const { context, proposal, signDecision, showAlert, setActor } = fixture();
        setActor({ id: 'owner-a', name: 'Alice Example' });
        proposal.reparcellization.polygons[0].geometry = {
            type: 'Polygon', coordinates: [[[1, 1], [2, 2], [2, 1], [1, 2], [1, 1]]]
        };

        await context.handleUserAcceptProposal(proposal.proposalId, 'base-a', 'owner-a');

        expect(signDecision).not.toHaveBeenCalled();
        expect(proposal.ownerApprovals).toBeUndefined();
        expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('Complete and correct'), expect.anything());
    });

    it('a signed withdrawal preserves an existing execution and map application', async () => {
        const { context, proposal, setActor } = fixture();
        setActor({ id: 'owner-a', name: 'Alice Example' });
        await context.acceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        const approvalReceipt = proposal.ownerApprovals['owner-a'];
        Object.assign(proposal, { lifecycleStatus: 'Executed', executedAt: '2026-10-01T10:00:00.000Z', applied: true });
        const result = await context.rejectProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(result).toMatchObject({ ownerKey: 'owner-a', ownerAccepted: false, parcelAccepted: false });
        expect(proposal.ownerApprovals['owner-a']).toBeUndefined();
        expect(proposal.ownerApprovalHistory).toContainEqual(approvalReceipt);
        expect(proposal.acceptedParcelIds).toEqual([]);
        expect(proposal).toMatchObject({ lifecycleStatus: 'Executed', executedAt: '2026-10-01T10:00:00.000Z', applied: true });
        expect(context.autoApplyExecutedProposalToMap).not.toHaveBeenCalled();
        expect(context.applyProposalOwnershipTransfer).not.toHaveBeenCalled();
    });

    it('records valid positive-cash approvals but does not execute while funding is unspecified', async () => {
        const { context, proposal, setActor } = fixture();
        delete proposal.funded;

        setActor({ id: 'owner-a', name: 'Alice Example' });
        const first = await context.acceptProposal(proposal.proposalId, 'base-a', 'owner-a');
        expect(first).toMatchObject({ ownerAccepted: true, proposalExecuted: false });

        setActor({ id: 'owner-b', name: 'Bob Example' });
        const final = await context.acceptProposal(proposal.proposalId, 'base-b', 'owner-b');

        expect(final).toMatchObject({ ownerAccepted: true, proposalExecuted: false });
        expect(proposal.lifecycleStatus).toBe('Active');
        expect(proposal.executedAt).toBeUndefined();
        expect(context.autoApplyExecutedProposalToMap).not.toHaveBeenCalled();
    });
});
