// Guards common draft approval publication and blocks unsupported mint before wallet side effects.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const createSource = readFileSync(new URL('../../frontend/js/proposals/create.js', import.meta.url), 'utf8');
const uploadSource = readFileSync(new URL('../../frontend/js/proposals/dialog-upload.js', import.meta.url), 'utf8');
const approvalSource = readFileSync(new URL('../../frontend/js/proposals/approval.js', import.meta.url), 'utf8');
const cryptoSource = readFileSync(new URL('../../frontend/vendor/noble-hashes-1.8.0/sha256.js', import.meta.url), 'utf8');
const kindSource = readFileSync(new URL('../../frontend/js/proposals/proposal-kind.js', import.meta.url), 'utf8');
const termsSource = readFileSync(new URL('../../frontend/js/proposals/publish-terms.js', import.meta.url), 'utf8');

function loadCreateHelpers() {
    const context = createContext({ TextEncoder });
    context.window = context;
    runInContext(cryptoSource, context);
    runInContext(approvalSource, context);
    runInContext(kindSource, context);
    runInContext(termsSource, context);
    runInContext(createSource, context);
    return context;
}

function approvalConfig() {
    return {
        schema: 'proposal-approval/v1',
        rights: {
            schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'snapshot-1' },
            parcels: [{ parcelId: 'parcel-a', complete: true, areaM2: 20, owners: [{ ownerId: 'owner-a', share: '1/1' }] }]
        },
        policy: { type: 'unanimous' }, clientOnlyAuthorityResolver: { trusted: true }
    };
}

describe('proposal create approval publication boundary', () => {
    it('copies canonical draft rights and the exact lens including empty, and clears receipts on the new snapshot', () => {
        const context = loadCreateHelpers();
        const proposal = {
            proposalId: 'published-copy', goal: 'park', cadastreParcelIds: ['parcel-a'], acceptedParcelIds: ['parcel-a'],
            ownerAcceptances: { 'parcel-a': { acceptedOwnerKeys: ['owner-a'] } },
            ownerApprovals: { 'owner-a': { decision: 'approve', decisionProof: 'old' } },
            ownerApprovalHistory: [{ decision: 'approve', decisionProof: 'old' }]
        };
        const draftFields = { approvalConfig: approvalConfig(), lens: [] };
        const usedDraftLens = context.applyPublishingDraftApproval(proposal, draftFields);

        expect(usedDraftLens).toBe(true);
        expect(proposal.approvalConfig).toEqual({
            schema: 'proposal-approval/v1',
            rights: {
                schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'snapshot-1' },
                parcels: [{ parcelId: 'parcel-a', complete: true, areaM2: 20, owners: [{ ownerId: 'owner-a', share: '1/1' }] }]
            },
            policy: { type: 'unanimous' }
        });
        expect(proposal).toHaveProperty('lens', []);
        expect(proposal.ownerApprovals).toEqual({});
        expect(proposal.ownerApprovalHistory).toBeUndefined();
        expect(proposal.ownerAcceptances).toEqual({});
        expect(proposal.acceptedParcelIds).toEqual([]);
        expect(proposal.approvalConfig).not.toHaveProperty('clientOnlyAuthorityResolver');

        draftFields.lens.push('later-edit');
        expect(proposal.lens).toEqual([]);
    });

    it('leaves legacy non-approval records unchanged and only skips mint for unsupported governed proposals', () => {
        const context = loadCreateHelpers();
        const legacy = { goal: 'park', acceptedParcelIds: ['parcel-a'], ownerAcceptances: { a: { accepted: true } } };
        expect(context.applyPublishingDraftApproval(legacy, { lens: [] })).toBe(true);
        expect(legacy).not.toHaveProperty('approvalConfig');
        expect(legacy).not.toHaveProperty('ownerApprovals');
        expect(legacy.acceptedParcelIds).toEqual(['parcel-a']);
        expect(legacy.ownerAcceptances).toEqual({ a: { accepted: true } });

        // A draft whose author set no approval publishes without a setup, so any chain mints it;
        // no goal forces a default setup.
        const geometryOnly = { goal: 'park', kind: 'owner-deal' };
        context.applyPublishingDraftApproval(geometryOnly, { approvalConfig: null, lens: [] });
        expect(geometryOnly).not.toHaveProperty('approvalConfig');
        const layout = { goal: 'parcel-layout', kind: null };
        context.applyPublishingDraftApproval(layout, { approvalConfig: null, lens: [] });
        expect(layout).not.toHaveProperty('approvalConfig');
        expect(layout).not.toHaveProperty('ownerApprovals');
        // Owners do not decide a community vote, so a setup carried from its source is dropped.
        const vote = { goal: 'park', kind: 'community-vote', approvalConfig: approvalConfig() };
        context.applyPublishingDraftApproval(vote, { approvalConfig: approvalConfig(), lens: [] });
        expect(vote).not.toHaveProperty('approvalConfig');

        const oldAdapter = {};
        expect(context.shouldSkipUnsupportedApprovalMint({ approvalConfig: approvalConfig() }, oldAdapter)).toBe(true);
        expect(context.shouldSkipUnsupportedApprovalMint({ approvalConfig: null }, oldAdapter)).toBe(false);
        const capableAdapter = { supportsProposalApproval: schema => schema === 'proposal-approval/v1' };
        expect(context.shouldSkipUnsupportedApprovalMint({ approvalConfig: approvalConfig() }, capableAdapter)).toBe(false);
    });

    it('refuses to project a parcel layout for upload before anything leaves the device', () => {
        const context = loadCreateHelpers();
        const layout = { proposalId: 'layout-1', goal: 'parcel-layout', parcelLayout: { plots: [] } };
        expect(() => context.buildUploadReadyProposal(layout))
            .toThrow('Parcel layouts are shared together with their agreement. Coming soon.');
        expect(layout).not.toHaveProperty('author');
    });

    it('runs create and upload mint guards before parcel-NFT and wallet side effects', () => {
        const preflight = createSource.indexOf('shouldSkipUnsupportedApprovalMint({');
        const parcelCheck = createSource.indexOf('await checkParcelsHaveNFTs(parcelIds, chainId)');
        expect(preflight).toBeGreaterThan(-1);
        expect(preflight).toBeLessThan(parcelCheck);

        // The upload dialog asks the connected wallet's adapter (only Solana commits an approval
        // setup), so its guard follows wallet connection but precedes every side effect.
        const uploadHandler = uploadSource.indexOf("mintButton.addEventListener('click'");
        const approvalGuard = uploadSource.indexOf("window.ProposalChainBridge?.supportsProposalApproval?.('proposal-approval/v1') !== true", uploadHandler);
        const walletConnection = uploadSource.indexOf('const walletManager = window.walletManager', uploadHandler);
        const mintRecord = uploadSource.indexOf('window.__mintBinding.prepareForMint(proposal)', uploadHandler);
        const metadataUpload = uploadSource.indexOf('window.ProposalPublishMint.mint(', uploadHandler);
        expect(approvalGuard).toBeGreaterThan(walletConnection);
        expect(approvalGuard).toBeLessThan(mintRecord);
        expect(approvalGuard).toBeLessThan(metadataUpload);
    });
});
