// Parcel anchor status (Tools tab): the public RPC defaults that let prod check Base Sepolia without a
// page-level override, and the rule that only ParcelAnchor.isAnchored answering false may be reported
// as "not minted" — an RPC failure must surface as "couldn't check", never as absence.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let fetchParcelTokenId;

beforeAll(() => {
    // The anchor key is computed with the page's ethers (window.ethers in the browser).
    globalThis.ethers = require('ethers');
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

describe('fetchParcelTokenId (ParcelAnchor.isAnchored)', () => {
    // uint256(keccak256("HR-1-2")): the anchor key (ParcelAnchor.keyOf), the claim portal's token id.
    const HR_1_2_KEY = 46574286646118026331295551521940897681015316371188223526490482874706276787279n;
    const contractThrowing = error => ({ isAnchored: async () => { throw error; } });

    it('returns the anchor key of an anchored parcel, asking isAnchored for that parcel id', async () => {
        const asked = [];
        const contract = { isAnchored: async parcelId => { asked.push(parcelId); return true; } };
        await expect(fetchParcelTokenId(contract, 'HR-1-2')).resolves.toBe(HR_1_2_KEY);
        expect(asked).toEqual(['HR-1-2']);
    });

    it('maps isAnchored false to TOKEN_NOT_MINTED', async () => {
        const contract = { isAnchored: async () => false };
        await expect(fetchParcelTokenId(contract, 'HR-1-2')).rejects.toThrow('TOKEN_NOT_MINTED');
    });

    it('rethrows a network failure or revert instead of calling the parcel unanchored', async () => {
        const network = Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK_ERROR' });
        await expect(fetchParcelTokenId(contractThrowing(network), 'HR-1-2')).rejects.toBe(network);
        const revert = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
        await expect(fetchParcelTokenId(contractThrowing(revert), 'HR-1-2')).rejects.toBe(revert);
    });
});

describe('buildParcelAnchorExplorerUrl', () => {
    it('links an EVM anchor to the ParcelAnchor contract page, never a token page', () => {
        const url = globalThis.ParcelsUIClaim.buildParcelAnchorExplorerUrl({
            chainId: '84532', chainSlug: 'base-sepolia',
            contractAddress: '0x6785a94694af9455C42F49849027736ABdd1aE2D', tokenId: '5'
        });
        expect(url).toBe('https://sepolia.basescan.org/address/0x6785a94694af9455C42F49849027736ABdd1aE2D');
    });

    it('links a Solana parcel to its account page on the cluster', () => {
        const url = globalThis.ParcelsUIClaim.buildParcelAnchorExplorerUrl({
            chainId: 'solana', chainSlug: 'solana-devnet', contractAddress: 'Prog111', tokenId: 'Acct111'
        });
        expect(url).toBe('https://explorer.solana.com/address/Acct111?cluster=devnet');
    });
});
