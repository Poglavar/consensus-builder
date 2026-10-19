// Unit tests for frontend/js/proposals/chain-ref.js — the unified proposal URL scheme. Pure string
// parsing: /proposals/<chainType>/<chainId>:<contract>:<tokenId> ⇄ ChainRef.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseChainProposalRef, buildChainProposalPath, chainRefFromProposal, identityKey, sameReference, findByReference } = require('../../frontend/js/proposals/chain-ref.js');

describe('parseChainProposalRef', () => {
    it('parses an EVM proposal location', () => {
        expect(parseChainProposalRef('/proposals/evm/84532/0x6c3AdE19/5')).toEqual({
            chainType: 'evm', chainId: '84532', contract: '0x6c3AdE19', tokenId: '5'
        });
    });

    it('accepts solana and canton chain types', () => {
        expect(parseChainProposalRef('/proposals/solana/devnet/PROG/MINT').chainType).toBe('solana');
        expect(parseChainProposalRef('/proposals/canton/net/pkg/cid').chainType).toBe('canton');
    });

    it('returns null for a server path or an unknown chain type', () => {
        expect(parseChainProposalRef('/proposals/12')).toBeNull();
        expect(parseChainProposalRef('/proposals/1,2,3')).toBeNull();
        expect(parseChainProposalRef('/proposals/bitcoin/a/b/c')).toBeNull();
        expect(parseChainProposalRef('/proposals/evm/onlyone')).toBeNull(); // needs 3 coords
        expect(parseChainProposalRef('/other')).toBeNull();
    });

    it('round-trips with buildChainProposalPath', () => {
        const ref = { chainType: 'evm', chainId: '84532', contract: '0xabc', tokenId: '9' };
        const path = buildChainProposalPath(ref);
        expect(path).toBe('/proposals/evm/84532/0xabc/9');
        expect(parseChainProposalRef(path)).toEqual(ref);
    });
});

describe('buildChainProposalPath', () => {
    it('returns null for incomplete or bad refs', () => {
        expect(buildChainProposalPath(null)).toBeNull();
        expect(buildChainProposalPath({ chainType: 'evm', chainId: '1', contract: '0x' })).toBeNull(); // no tokenId
        expect(buildChainProposalPath({ chainType: 'doge', chainId: '1', contract: '0x', tokenId: '1' })).toBeNull();
    });
});

describe('chainRefFromProposal', () => {
    it('reads nft.* coordinates first', () => {
        const p = { nft: { chain: '84532', contract: '0xC', tokenId: '7' } };
        expect(chainRefFromProposal(p)).toEqual({ chainType: 'evm', chainId: '84532', contract: '0xC', tokenId: '7' });
    });

    it('falls back to onchain.* coordinates', () => {
        const p = { onchain: { chainId: '11155111', contractAddress: '0xD', proposalId: '3' } };
        expect(chainRefFromProposal(p)).toEqual({ chainType: 'evm', chainId: '11155111', contract: '0xD', tokenId: '3' });
    });

    it('returns null when the proposal has no on-chain coordinates', () => {
        expect(chainRefFromProposal({})).toBeNull();
        expect(chainRefFromProposal(null)).toBeNull();
    });
});

describe('chainRefFromProposal — Solana detection', () => {
    it('infers solana from a "solana-<cluster>" chainId and strips the prefix', () => {
        const p = { onchain: { chainId: 'solana-devnet', contractAddress: 'PROG', proposalId: 'ACCT' } };
        expect(chainRefFromProposal(p)).toEqual({ chainType: 'solana', chainId: 'devnet', contract: 'PROG', tokenId: 'ACCT' });
    });
    it('respects an explicit chainType over inference', () => {
        const p = { chainType: 'evm', onchain: { chainId: '84532', contractAddress: '0xC', proposalId: '3' } };
        expect(chainRefFromProposal(p).chainType).toBe('evm');
    });
    it('uses the bare cluster for a mirrored receipt with an explicit chainType', () => {
        const p = { onchain: { chainType: 'solana', chainId: 'solana-devnet', contractAddress: 'PROG', proposalId: 'ACCT' } };
        expect(chainRefFromProposal(p)).toEqual({ chainType: 'solana', chainId: 'devnet', contract: 'PROG', tokenId: 'ACCT' });
    });
});

describe('chainRefFromProposal — Canton detection', () => {
    it('infers canton from a "canton-<network>" chainId and strips the prefix', () => {
        const p = { onchain: { chainId: 'canton-devnet', contractAddress: 'canton', proposalId: 'CID123' } };
        expect(chainRefFromProposal(p)).toEqual({ chainType: 'canton', chainId: 'devnet', contract: 'canton', tokenId: 'CID123' });
    });
});

describe('qualified chain proposal identity', () => {
    const evm = { chainType: 'evm', chainId: '84532', contract: '0xAbC', tokenId: '7' };
    it('normalizes EVM numeric identities and address case', () => {
        expect(sameReference(evm, { ...evm, chainId: '0x14a34', contract: '0xabc', tokenId: '0x7' })).toBe(true);
        for (const change of [{ chainId: '1' }, { contract: '0xdef' }, { tokenId: '8' }]) {
            expect(sameReference(evm, { ...evm, ...change })).toBe(false);
        }
    });
    it('preserves Solana and Canton program and account case', () => {
        for (const chainType of ['solana', 'canton']) {
            const ref = { chainType, chainId: 'devnet', contract: 'Program', tokenId: 'Account' };
            expect(sameReference(ref, { ...ref, chainId: `${chainType}-devnet` })).toBe(true);
            expect(sameReference(ref, { ...ref, contract: 'program' })).toBe(false);
            expect(sameReference(ref, { ...ref, tokenId: 'account' })).toBe(false);
        }
    });
    it('rejects incomplete references and ambiguous local matches', () => {
        expect(identityKey({ ...evm, contract: '' })).toBeNull();
        expect(identityKey({ ...evm, chainId: 'unknown' })).toBeNull();
        expect(identityKey({ ...evm, chainId: '0' })).toBeNull();
        expect(() => findByReference([], { ...evm, tokenId: null })).toThrow('complete chain');
        const record = { proposalId: 'local-key', nft: { chain: '84532', contract: '0xabc', tokenId: '7' } };
        expect(findByReference([{ proposalId: '7' }, record], evm)).toBe(record);
        expect(() => findByReference([record, { ...record, proposalId: 'other-key' }], evm)).toThrow('Multiple local');
    });
});
