// Canonical chain locations (proposals/chain-reader.js normalizeChainRef), which the agents' publication
// mirror still names.
import { describe, expect, it } from 'vitest';
import { normalizeChainRef } from '../proposals/chain-reader.js';

const SOL_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const SOL_ADDRESS = '11111111111111111111111111111111';

describe('normalizeChainRef', () => {
    it('canonicalizes configured EVM and Solana locations', () => {
        expect(normalizeChainRef({ chainType: 'EVM', chainId: '0x14a34', contract: '0xFf162bC8De48AA39582c9389D60a7487b6330342', tokenId: '0005' }))
            .toEqual({ chainType: 'evm', chainId: '84532', contract: '0xFf162bC8De48AA39582c9389D60a7487b6330342', tokenId: '5' });
        expect(normalizeChainRef({ chainType: 'solana', chainId: 'devnet', contract: SOL_PROGRAM, tokenId: SOL_ADDRESS }))
            .toEqual({ chainType: 'solana', chainId: 'solana-devnet', contract: SOL_PROGRAM, tokenId: SOL_ADDRESS });
    });

    it('rejects unknown deployments, substituted contracts, and Canton public mirroring', () => {
        expect(() => normalizeChainRef({ chainType: 'evm', chainId: '84532', contract: '0x0000000000000000000000000000000000000001', tokenId: '1' }))
            .toThrow(expect.objectContaining({ status: 422, code: 'chain-proof-invalid' }));
        expect(() => normalizeChainRef({ chainType: 'solana', chainId: 'mainnet-beta', contract: SOL_PROGRAM, tokenId: SOL_ADDRESS }))
            .toThrow(expect.objectContaining({ status: 422 }));
        expect(() => normalizeChainRef({ chainType: 'canton', chainId: 'devnet', contract: 'canton', tokenId: 'cid' }))
            .toThrow(expect.objectContaining({ status: 422, code: 'chain-mirror-private' }));
        expect(() => normalizeChainRef({ chainType: 'evm', chainId: '84532', contract: '0xFf162bC8De48AA39582c9389D60a7487b6330342', tokenId: '9'.repeat(79) }))
            .toThrow(expect.objectContaining({ status: 422, code: 'chain-proof-invalid' }));
        expect(() => normalizeChainRef({ chainType: 'evm', chainId: '84532', contract: '0xFf162bC8De48AA39582c9389D60a7487b6330342', tokenId: ((1n << 256n) - 1n + 1n).toString() }))
            .toThrow(expect.objectContaining({ status: 422, code: 'chain-proof-invalid' }));
    });
});
