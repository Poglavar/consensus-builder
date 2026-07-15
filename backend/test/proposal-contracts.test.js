// Unit tests for frontend/js/proposal-contracts.js — resolving which ProposalNFT contracts to read
// for a city: per-city config if present, else the global Base Sepolia fallback.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveProposalContracts, DEFAULT_PROPOSAL_CONTRACTS } = require('../../frontend/js/proposal-contracts.js');

describe('resolveProposalContracts', () => {
    it('uses the city\'s own proposalContracts when configured', () => {
        const cityConfig = { blockchain: { proposalContracts: [{ chainId: '1', contractAddress: '0xabc' }] } };
        expect(resolveProposalContracts(cityConfig)).toEqual([{ chainId: '1', contractAddress: '0xabc' }]);
    });

    it('falls back to the global Base Sepolia contract when the city has none', () => {
        expect(resolveProposalContracts(null)).toEqual(DEFAULT_PROPOSAL_CONTRACTS);
        expect(resolveProposalContracts({})).toEqual(DEFAULT_PROPOSAL_CONTRACTS);
        expect(resolveProposalContracts({ blockchain: {} })).toEqual(DEFAULT_PROPOSAL_CONTRACTS);
        expect(resolveProposalContracts({ blockchain: { proposalContracts: [] } })).toEqual(DEFAULT_PROPOSAL_CONTRACTS);
        expect(DEFAULT_PROPOSAL_CONTRACTS[0].chainId).toBe('84532'); // Base Sepolia
    });

    it('drops malformed per-city entries and falls back if none remain', () => {
        const cityConfig = { blockchain: { proposalContracts: [{ chainId: null }, { contractAddress: '' }] } };
        expect(resolveProposalContracts(cityConfig)).toEqual(DEFAULT_PROPOSAL_CONTRACTS);
    });

    it('accepts an explicit fallback override', () => {
        const custom = [{ chainId: '11155111', contractAddress: '0xdead' }];
        expect(resolveProposalContracts(null, custom)).toEqual(custom);
    });
});
