// Parcel NFT status (Tools tab): the public RPC defaults that let prod check Base Sepolia without a
// page-level override, and the rule that only the contract's own "Parcel does not exist" revert may
// be reported as "not minted" — an RPC failure must surface as "couldn't check", never as absence.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let fetchParcelTokenId;

beforeAll(() => {
    require('../../frontend/js/parcels/blockchain.js');
    require('../../frontend/js/parcels/ui/claim.js');
    fetchParcelTokenId = globalThis.ParcelsUIClaim.fetchParcelTokenId;
});

describe('parcel claim RPC defaults', () => {
    it('resolves the public Base Sepolia endpoint for 84532 and its aliases', () => {
        expect(globalThis.resolveRpcUrlForChain('84532')).toBe('https://sepolia.base.org');
        expect(globalThis.resolveRpcUrlForChain(84532)).toBe('https://sepolia.base.org');
        expect(globalThis.resolveRpcUrlForChain('0x14a34')).toBe('https://sepolia.base.org');
        expect(globalThis.resolveRpcUrlForChain('base-sepolia')).toBe('https://sepolia.base.org');
    });

    it('still lets a page-level override win', () => {
        // The resolver reads overrides from window/self, which node lacks.
        globalThis.self = globalThis;
        globalThis.CLAIM_RPC_URLS = { '84532': 'https://rpc.example.test' };
        try {
            expect(globalThis.resolveRpcUrlForChain('84532')).toBe('https://rpc.example.test');
        } finally {
            delete globalThis.CLAIM_RPC_URLS;
            delete globalThis.self;
        }
    });
});

describe('fetchParcelTokenId', () => {
    const contractThrowing = error => ({ tokenIdForParcelId: async () => { throw error; } });

    it('returns the token id when the parcel is minted', async () => {
        const contract = { tokenIdForParcelId: async () => 7n };
        await expect(fetchParcelTokenId(contract, 'HR-1-2')).resolves.toBe(7n);
    });

    it('maps the contract revert "Parcel does not exist" to TOKEN_NOT_MINTED', async () => {
        const revert = Object.assign(new Error('execution reverted: "ParcelNFT: Parcel does not exist"'), {
            code: 'CALL_EXCEPTION',
            reason: 'ParcelNFT: Parcel does not exist'
        });
        await expect(fetchParcelTokenId(contractThrowing(revert), 'HR-1-2')).rejects.toThrow('TOKEN_NOT_MINTED');
    });

    it('rethrows a network failure instead of calling the parcel unminted', async () => {
        const network = Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK_ERROR' });
        await expect(fetchParcelTokenId(contractThrowing(network), 'HR-1-2')).rejects.toBe(network);
    });
});
