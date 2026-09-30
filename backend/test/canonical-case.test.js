import { describe, expect, it } from 'vitest';
import {
    canonicalCaseConfig, canonicalProposalBody, canonicalTerminalActions, DEFAULT_CASE_ID, DEFAULT_EXECUTED_CASE_ID
} from '../agents/canonical-case.js';

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

describe('executed canonical case', () => {
    it('defaults to a second plural real-parcel set with its own public id', () => {
        const config = canonicalCaseConfig({ outcome: 'executed' });
        expect(config.proposalId).toBe(DEFAULT_EXECUTED_CASE_ID);
        expect(config.proposalId).not.toBe(DEFAULT_CASE_ID);
        expect(config.outcome).toBe('executed');
        expect(config.parcelIds).toHaveLength(2);
        expect(config.parcelIds.every(id => id.startsWith('HR-'))).toBe(true);
        expect(config.name).toMatch(/Borovje/);
        expect(config.rationale).toMatch(/accepts/);
    });

    it('keeps the cancelled defaults and text for the golden case', () => {
        const config = canonicalCaseConfig();
        expect(config.outcome).toBe('cancelled');
        expect(config.name).toBe('Borovje three-parcel civic courtyard');
    });

    it('refuses an unknown outcome and lists both terminal action plans', () => {
        expect(() => canonicalCaseConfig({ outcome: 'expired' })).toThrow(/outcome must be one of cancelled, executed/);
        expect(canonicalTerminalActions('cancelled')).toEqual(['cancel', 'resolve', 'refund_donation', 'void_pledge', 'claim_no']);
        expect(canonicalTerminalActions('executed')).toEqual(['certify_parcels', 'accept_parcels', 'resolve', 'release_donations', 'fulfill_pledge', 'claim_yes']);
    });

    it('publishes the case name and rationale from the config', () => {
        const config = canonicalCaseConfig({ outcome: 'executed', name: 'Custom title' });
        const body = canonicalProposalBody({
            config, runId: 'run-2', proposer: { name: 'planner', wallet: 'wallet' },
            mint: { proposalPda: 'pda', signature: 'tx' }, apiBase: 'https://api.example.test'
        });
        expect(body.name).toBe('Custom title');
        expect(body.title).toBe('Custom title');
        expect(body.description).toBe(config.rationale);
        expect(body.agent.rationale).toBe(config.rationale);
    });
});
