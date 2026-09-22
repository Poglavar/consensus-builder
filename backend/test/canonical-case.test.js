import { describe, expect, it } from 'vitest';
import { canonicalCaseConfig, canonicalProposalBody, DEFAULT_CASE_ID } from '../agents/canonical-case.js';

describe('canonical hackathon case', () => {
    it('defaults to a small plural real-parcel set and low-value devnet actions', () => {
        const config = canonicalCaseConfig();
        expect(config.proposalId).toBe(DEFAULT_CASE_ID);
        expect(config.parcelIds).toHaveLength(3);
        expect(config.parcelIds.every(id => id.startsWith('HR-'))).toBe(true);
        expect(config.amounts).toEqual({ donationUsdc: '0.05', pledgeUsdc: '0.10', yesUsdc: '0.01', noUsdc: '0.01' });
    });

    it('refuses a one-parcel golden case', () => {
        expect(() => canonicalCaseConfig({ parcels: ['HR-1-1'] })).toThrow(/at least two/);
    });

    it('publishes the exact minted parcel set and shared agent provenance', () => {
        const config = canonicalCaseConfig({ proposalId: 'case-1', parcels: ['HR-1-2', 'HR-1-1'] });
        const body = canonicalProposalBody({
            config, runId: 'run-1', proposer: { name: 'planner', wallet: 'wallet' },
            mint: { proposalPda: 'proposal-pda', signature: 'mint-tx' }, apiBase: 'https://api.example.test/'
        });
        expect(body).toMatchObject({
            proposalId: 'case-1', cadastreParcelIds: ['HR-1-2', 'HR-1-1'], isConditional: true,
            facets: { ownership: 'to-city' },
            agent: { persona: 'planner', controller: 'algorithm', run_id: 'run-1' },
            onchain: { proposalId: 'proposal-pda', transactionHash: 'mint-tx' },
            nft: { tokenId: 'proposal-pda' }, isMinted: true
        });
        expect(body.sourceUrl).toBe('https://api.example.test/hackathon/cases/case-1');
    });
});
