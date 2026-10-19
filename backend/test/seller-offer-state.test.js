// Keep seller intent, funding and consent distinct, and prevent purchases after the offer closes.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { stripLocalProposalState } from '../proposals/serializer.js';

const require = createRequire(import.meta.url);
const records = require('../../frontend/js/proposals/formation-depth.js');
const chainRecord = require('../../frontend/js/proposals/chain-record.js');
const fingerprints = require('../../frontend/js/proposals/sharing.js');

const sources = ['status', 'proposal-kind', 'lifecycle', 'execution'].map(name =>
    readFileSync(new URL(`../../frontend/js/proposals/${name}.js`, import.meta.url), 'utf8'));

function fixture(extra = {}) {
    const proposal = {
        proposalId: 'seller-offer', goal: 'ownership-transfer-from-me', lifecycleStatus: 'Active',
        funded: false, cadastreParcelIds: ['parcel-a'], acceptedParcelIds: [], ownerAcceptances: {},
        ownershipTransferProposal: { direction: 'from-me', recipientScope: 'any' }, ...extra
    };
    const transfer = vi.fn();
    const save = vi.fn();
    const context = createContext({
        getProposalI18nHelper: () => (_key, fallback) => fallback,
        proposalStorage: { getAllProposals: () => [proposal], save },
        transferParcelOwnership: transfer,
        PersistentStorage: { getItem: () => 'seller' },
        showEphemeralMessage: vi.fn()
    });
    context.window = context;
    sources.forEach(source => runInContext(source, context));
    return { context, proposal, save, transfer };
}

describe('seller offer state', () => {
    it('simulates ownership once without altering authored terms, funding, consent or shared lifecycle', () => {
        const { context, proposal, save, transfer } = fixture();
        const before = structuredClone(proposal);
        const hashes = [fingerprints.proposalContentFingerprint(before), fingerprints.proposalConsentFingerprint(before)];
        expect(context.simulateSaleOfferPurchase(proposal.proposalId, 'buyer')).toBe(true);
        expect(transfer).toHaveBeenCalledExactlyOnceWith('parcel-a', 'seller', 'buyer');
        expect(save).toHaveBeenCalledOnce();
        const { localPurchaseSimulation, ...after } = proposal;
        expect(after).toEqual(before);
        expect(localPurchaseSimulation).toMatchObject({ buyerAgentId: 'buyer', cadastreParcelIds: ['parcel-a'] });
        expect(Number.isFinite(Date.parse(localPurchaseSimulation.simulatedAt))).toBe(true);
        expect(localPurchaseSimulation.cadastreParcelIds).not.toBe(proposal.cadastreParcelIds);
        expect([fingerprints.proposalContentFingerprint(proposal), fingerprints.proposalConsentFingerprint(proposal)]).toEqual(hashes);
        expect(context.getProposalLifecycleKey(proposal)).toBe('awaiting-funding');
        expect(context.showEphemeralMessage).toHaveBeenCalledWith('Purchase simulated in this browser. No payment was made.', 4000, 'success');
        expect(context.simulateSaleOfferPurchase(proposal.proposalId, 'another-buyer')).toBe(false);
        expect(save).toHaveBeenCalledOnce();
        expect(transfer).toHaveBeenCalledOnce();
    });

    it('cannot record a successful simulation without the ownership writer', () => {
        const { context, proposal, save } = fixture();
        delete context.transferParcelOwnership;
        expect(context.simulateSaleOfferPurchase(proposal.proposalId, 'buyer')).toBe(false);
        expect(proposal).not.toHaveProperty('localPurchaseSimulation');
        expect(save).not.toHaveBeenCalled();
    });

    it('keeps the result in local records but excludes it from sharing, publication and chain metadata', () => {
        const { context, proposal } = fixture();
        context.simulateSaleOfferPurchase(proposal.proposalId, 'buyer');
        const before = structuredClone(proposal);
        expect(records.stripDerivedRecordData(proposal).localPurchaseSimulation).toEqual(proposal.localPurchaseSimulation);
        const gate = records.preparePublishRecord(proposal);
        expect(gate.verdict.flat).toBe(true);
        for (const portable of [gate.proposal, stripLocalProposalState(proposal), chainRecord.authoredRecord(proposal)]) {
            expect(portable).not.toHaveProperty('localPurchaseSimulation');
            expect(portable.ownershipTransferProposal).toEqual(before.ownershipTransferProposal);
        }
        expect(context.isProposalOpenSaleOffer(gate.proposal)).toBe(true);
        expect(proposal).toEqual(before);
    });

    it('shows funding readiness independently of the consent tally', () => {
        const { context, proposal } = fixture();
        expect(context.getProposalLifecycleKey(proposal)).toBe('awaiting-funding');
        expect(context.getProposalLifecycleLabel('awaiting-funding')).toBe('Awaiting funding');
        expect(context.getProposalLifecycleClass('awaiting-funding')).toBe('active');
        expect(context.isProposalOpenSaleOffer(proposal)).toBe(true);
        proposal.acceptedParcelIds = ['parcel-a'];
        expect(context.getProposalLifecycleKey(proposal)).toBe('awaiting-funding');
        proposal.funded = true;
        expect(context.getProposalLifecycleKey(proposal)).toBe('active');
    });

    it.each(['Executed', 'Cancelled', 'Expired'])('keeps %s ahead of unfunded sale intent', lifecycleStatus => {
        const { context, proposal, save, transfer } = fixture({ lifecycleStatus });
        expect(context.getProposalLifecycleKey(proposal)).toBe(lifecycleStatus.toLowerCase());
        expect(context.isProposalOpenSaleOffer(proposal)).toBe(false);
        expect(context.simulateSaleOfferPurchase(proposal.proposalId, 'buyer')).toBe(false);
        expect(proposal.lifecycleStatus).toBe(lifecycleStatus);
        expect(save).not.toHaveBeenCalled();
        expect(transfer).not.toHaveBeenCalled();
    });

    it('closes a past-deadline sale even before a lifecycle refresh is stored', () => {
        const { context, proposal, save, transfer } = fixture({ expiresAt: '2000-01-01T00:00:00.000Z' });
        expect(context.getProposalLifecycleKey(proposal)).toBe('expired');
        expect(context.simulateSaleOfferPurchase(proposal.proposalId, 'buyer')).toBe(false);
        expect(proposal.lifecycleStatus).toBe('Active');
        expect(save).not.toHaveBeenCalled();
        expect(transfer).not.toHaveBeenCalled();
    });

    it.each([
        { lifecycleStatus: 'draft' },
        { kind: 'owner-vote' },
        { ownershipTransferProposal: { direction: 'from-me', status: 'sold' } }
    ])('does not offer a draft, vote or sold record for purchase: %j', extra => {
        const { context, proposal } = fixture(extra);
        expect(context.isProposalOpenSaleOffer(proposal)).toBe(false);
    });
});
