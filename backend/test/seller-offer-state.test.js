// Keep seller intent, funding and consent distinct, and prevent purchases after the offer closes.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

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
        transferParcelOwnership: transfer
    });
    context.window = context;
    sources.forEach(source => runInContext(source, context));
    return { context, proposal, save, transfer };
}

describe('seller offer state', () => {
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
        expect(context.claimSaleOffer(proposal.proposalId, 'buyer')).toBe(false);
        expect(proposal.lifecycleStatus).toBe(lifecycleStatus);
        expect(save).not.toHaveBeenCalled();
        expect(transfer).not.toHaveBeenCalled();
    });

    it('closes a past-deadline sale even before a lifecycle refresh is stored', () => {
        const { context, proposal, save, transfer } = fixture({ expiresAt: '2000-01-01T00:00:00.000Z' });
        expect(context.getProposalLifecycleKey(proposal)).toBe('expired');
        expect(context.claimSaleOffer(proposal.proposalId, 'buyer')).toBe(false);
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
