// Parcel NFT status (Tools tab): the public RPC defaults that let prod check Base Sepolia without a
// page-level override, and the rule that only the contract's own "Parcel does not exist" revert may
// be reported as "not minted" — an RPC failure must surface as "couldn't check", never as absence.

import { describe, it, expect, beforeAll, vi } from 'vitest';
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

    it('lets the configured provider (EVM_RPC_URLS from rpc-config.js) win', () => {
        // The resolver reads the configuration from window/self, which node lacks.
        globalThis.self = globalThis;
        globalThis.EVM_RPC_URLS = { '84532': 'https://rpc.example.test' };
        try {
            expect(globalThis.resolveRpcUrlForChain('84532')).toBe('https://rpc.example.test');
            expect(globalThis.resolveRpcUrlForChain('11155111')).toBe('https://ethereum-sepolia-rpc.publicnode.com');
        } finally {
            delete globalThis.EVM_RPC_URLS;
            delete globalThis.self;
        }
    });
});

describe('Parcel Builder city gate', () => {
    it('allows Zagreb and refuses every other city before opening the external tool', () => {
        const previous = {
            CityConfigManager: globalThis.CityConfigManager,
            open: globalThis.open,
            updateStatus: globalThis.updateStatus
        };
        const open = vi.fn();
        const updateStatus = vi.fn();
        let cityId = 'zagreb';
        globalThis.CityConfigManager = { getCurrentCityId: () => cityId };
        globalThis.open = open;
        globalThis.updateStatus = updateStatus;
        try {
            expect(globalThis.ParcelsUIClaim.isParcelBuilderAvailable()).toBe(true);
            cityId = 'london';
            expect(globalThis.ParcelsUIClaim.isParcelBuilderAvailable()).toBe(false);
            expect(globalThis.ParcelsUIClaim.openParcelBuilder()).toBe(false);
            expect(open).not.toHaveBeenCalled();
            expect(updateStatus).toHaveBeenCalledWith('Not available in this city');
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
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
