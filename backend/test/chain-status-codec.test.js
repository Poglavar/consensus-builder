import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { STATUS_BY_CODE, decodeProposalStatus } = require('../../frontend/js/proposals/chain-status.js');
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
