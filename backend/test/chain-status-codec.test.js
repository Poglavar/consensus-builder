import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { STATUS_BY_CODE, decodeProposalStatus, confirmedAcceptanceLifecycle } = require('../../frontend/js/proposals/chain-status.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function enumMembers(source, enumName) {
    const match = source.match(new RegExp(`enum\\s+${enumName}\\s*\\{([^}]+)\\}`));
    if (!match) return [];
    return match[1]
        .split(',')
        .map(value => value.replace(/\/\/.*$/gm, '').replace(/\s*=.*$/, '').trim())
        .filter(Boolean);
}

describe('proposal chain lifecycle codec', () => {
    it('decodes the four canonical ordinals and rejects everything else', () => {
        expect(STATUS_BY_CODE).toEqual(['Active', 'Executed', 'Cancelled', 'Expired']);
        expect([0, 1n, '2', 3].map(decodeProposalStatus)).toEqual(STATUS_BY_CODE);
        expect(decodeProposalStatus(-1)).toBe('Unknown');
        expect(decodeProposalStatus(4)).toBe('Unknown');
        expect(decodeProposalStatus('nope')).toBe('Unknown');
        for (const value of [null, undefined, true, false, '', ' ', [], {}, NaN, 1.5]) {
            expect(decodeProposalStatus(value)).toBe('Unknown');
        }
    });

    const nft = { chain: '84532', contract: `0x${'a'.repeat(40)}`, tokenId: '5' };
    const result = { chainId: '84532', contractAddress: nft.contract, proposalId: '5', blockNumber: 42,
        lifecycle: { statusCode: 1, blockNumber: 42 } };

    it('uses the confirmed block status for the exact submitted and current EVM identity', () => {
        expect(confirmedAcceptanceLifecycle(result, nft, { ...nft, chain: '0x14a34', tokenId: 5 })).toBe('Executed');
        expect(confirmedAcceptanceLifecycle({ ...result, lifecycle: { statusCode: 0, blockNumber: 42 } }, nft, nft)).toBe('Active');
    });

    it('rejects missing, unknown, stale-block and mismatched receipt observations', () => {
        for (const value of [null, { ...result, lifecycle: null }, { ...result, blockNumber: null },
            { ...result, lifecycle: { statusCode: null, blockNumber: 42 } },
            { ...result, lifecycle: { statusCode: 9, blockNumber: 42 } },
            { ...result, lifecycle: { statusCode: 1, blockNumber: 41 } },
            { ...result, chainId: '1' }, { ...result, proposalId: '6' },
            { ...result, contractAddress: `0x${'b'.repeat(40)}` }]) {
            expect(confirmedAcceptanceLifecycle(value, nft, nft)).toBeNull();
        }
    });

    it('refuses an NFT identity changed while the wallet was open', () => {
        for (const changed of [null, { ...nft, chain: '1' }, { ...nft, tokenId: '6' },
            { ...nft, contract: `0x${'b'.repeat(40)}` }]) {
            expect(confirmedAcceptanceLifecycle(result, nft, changed)).toBeNull();
            expect(confirmedAcceptanceLifecycle(result, changed, nft)).toBeNull();
        }
    });

    it('matches the Solidity ProposalStatus declaration order', () => {
        const source = readFileSync(path.join(ROOT, 'blockchain/contracts/ProposalNFT.sol'), 'utf8');
        expect(enumMembers(source, 'ProposalStatus')).toEqual(STATUS_BY_CODE);
    });

    it('matches the Solana ProposalStatus declaration order', () => {
        const source = readFileSync(path.join(ROOT, 'blockchain/solana/programs/proposal_nft/src/lib.rs'), 'utf8');
        expect(enumMembers(source, 'ProposalStatus')).toEqual(STATUS_BY_CODE);
    });
});
