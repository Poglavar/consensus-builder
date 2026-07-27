// Unit tests for frontend/js/proposals/chain-proposal-loader.js — the reconstruct-from-location
// dispatch. The real chain read is browser/wallet-only, so ChainDataLoader / proposalStorage / fetch
// are stubbed on the global here to verify the COMPOSITION (right args, metadata pull, import call).
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadChainProposalFromRef, resolveMetadataUrl } = require('../../frontend/js/proposals/chain-proposal-loader.js');

const EVM_REF = { chainType: 'evm', chainId: '84532', contract: '0xC', tokenId: '5' };

afterEach(() => {
    delete global.ChainDataLoader;
    delete global.proposalStorage;
    delete global.fetch;
    delete global.resolveResourceUrl;
});

describe('resolveMetadataUrl', () => {
    it('maps ipfs:// to a gateway and passes through http', () => {
        expect(resolveMetadataUrl('ipfs://abc')).toBe('https://ipfs.io/ipfs/abc');
        expect(resolveMetadataUrl('https://x/y.json')).toBe('https://x/y.json');
        expect(resolveMetadataUrl(null)).toBeNull();
    });
});

describe('loadChainProposalFromRef (EVM)', () => {
    it('reads the token, pulls its metadata, and imports the reconstructed proposal', async () => {
        const calls = {};
        global.ChainDataLoader = {
            getProposalsByIds: async (chainId, contract, ids) => {
                calls.read = { chainId, contract, ids };
                return [{ proposalId: '5', imageURI: 'ipfs://meta', lens: ['0xL'], parentParcelIds: ['HR-1'] }];
            }
        };
        global.fetch = async (url) => {
            calls.fetched = url;
            return { ok: true, json: async () => ({ properties: { geometry: { some: 'geom' } } }) };
        };
        global.proposalStorage = {
            importOnChainProposal: (arg) => { calls.imported = arg; return { proposalId: '5', geometry: { some: 'geom' } }; }
        };

        const result = await loadChainProposalFromRef(EVM_REF);

        expect(result.ok).toBe(true);
        expect(result.proposal.proposalId).toBe('5');
        // Read with the ref's coordinates.
        expect(calls.read).toEqual({ chainId: '84532', contract: '0xC', ids: ['5'] });
        // Metadata URI (from imageURI) resolved through the ipfs gateway.
        expect(calls.fetched).toBe('https://ipfs.io/ipfs/meta');
        // Import got the chain row + fetched metadata + onchain coordinates.
        expect(calls.imported.onchain).toEqual({ chainId: '84532', contractAddress: '0xC', proposalId: '5', metadata: { properties: { geometry: { some: 'geom' } } } });
    });

    it('reports chain-unavailable when the loader/wallet is not present (no wallet)', async () => {
        expect(await loadChainProposalFromRef(EVM_REF)).toEqual({ ok: false, reason: 'chain-unavailable' });
    });

    it('reports not-found when the token returns nothing', async () => {
        global.ChainDataLoader = { getProposalsByIds: async () => [] };
        global.proposalStorage = { importOnChainProposal: () => ({}) };
        expect((await loadChainProposalFromRef(EVM_REF)).reason).toBe('not-found');
    });

    it('surfaces a read failure instead of throwing', async () => {
        global.ChainDataLoader = { getProposalsByIds: async () => { throw new Error('rpc down'); } };
        global.proposalStorage = { importOnChainProposal: () => ({}) };
        const r = await loadChainProposalFromRef(EVM_REF);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('read-failed');
    });
});

describe('loadChainProposalFromRef (dispatch)', () => {
    it('handles bad refs and unknown chains; evm/solana/canton are all wired now', async () => {
        expect((await loadChainProposalFromRef(null)).reason).toBe('bad-ref');
        expect((await loadChainProposalFromRef({ chainType: 'dogecoin' })).reason).toBe('unknown-chain');
        // Wired chains with no environment present → chain-unavailable (they need their wallet/loader).
        expect((await loadChainProposalFromRef({ chainType: 'solana', chainId: 'devnet', contract: 'P', tokenId: 'A' })).reason).toBe('chain-unavailable');
        expect((await loadChainProposalFromRef({ chainType: 'canton', chainId: 'devnet', contract: 'canton', tokenId: 'C' })).reason).toBe('chain-unavailable');
    });
});

describe('loadChainProposalFromRef (Solana)', () => {
    const SOL_REF = { chainType: 'solana', chainId: 'devnet', contract: 'PROG', tokenId: 'ACCT' };

    it('reads the account, pulls metadata, and imports the reconstructed proposal', async () => {
        const calls = {};
        global.solanaWeb3 = { PublicKey: function (a) { this.a = a; } };
        global.SolanaChainDataLoader = {
            getConnection: () => ({ getAccountInfo: async (pk) => { calls.addr = pk.a; return { data: new Uint8Array(32) }; } }),
            parseProposalAccount: (data, address) => ({ proposalId: address, parentParcelIds: ['HR-9'], metadataUri: 'ipfs://m', lens: [] })
        };
        global.fetch = async (url) => { calls.fetched = url; return { ok: true, json: async () => ({ properties: {} }) }; };
        global.proposalStorage = { importOnChainProposal: (arg) => { calls.imported = arg; return { proposalId: 'ACCT' }; } };

        const result = await loadChainProposalFromRef(SOL_REF);
        expect(result.ok).toBe(true);
        expect(calls.addr).toBe('ACCT');
        expect(calls.fetched).toBe('https://ipfs.io/ipfs/m');
        expect(calls.imported.onchain.chainType).toBe('solana');
        delete global.solanaWeb3; delete global.SolanaChainDataLoader;
    });

    it('reports chain-unavailable without the Solana loader/wallet', async () => {
        expect((await loadChainProposalFromRef(SOL_REF)).reason).toBe('chain-unavailable');
    });
});

describe('loadChainProposalFromRef (Canton)', () => {
    const CANTON_REF = { chainType: 'canton', chainId: 'devnet', contract: 'canton', tokenId: 'CID123' };

    it('is canton-private when there is no identity', async () => {
        global.CantonMode = { getParty: () => null };
        global.proposalStorage = { importOnChainProposal: () => ({}) };
        global.getBackendBase = () => 'http://api';
        global.fetch = async () => ({ ok: true, json: async () => ({ proposals: [] }) });
        expect((await loadChainProposalFromRef(CANTON_REF)).reason).toBe('canton-private');
        delete global.CantonMode; delete global.getBackendBase;
    });

    it('is canton-private when the identity is not a party to this proposal (absent)', async () => {
        global.CantonMode = { getParty: () => 'party::abc' };
        global.proposalStorage = { importOnChainProposal: () => ({}) };
        global.getBackendBase = () => 'http://api';
        global.fetch = async () => ({ ok: true, json: async () => ({ proposals: [{ contractId: 'OTHER' }] }) });
        expect((await loadChainProposalFromRef(CANTON_REF)).reason).toBe('canton-private');
        delete global.CantonMode; delete global.getBackendBase;
    });

    it('reconstructs when the identity IS a party (contractId matches)', async () => {
        const calls = {};
        global.CantonMode = { getParty: () => 'party::abc' };
        global.getBackendBase = () => 'http://api';
        global.fetch = async (url) => {
            if (String(url).includes('/canton/proposals')) {
                calls.read = url;
                return { ok: true, json: async () => ({ proposals: [{ contractId: 'CID123', parcelId: 'HR-7', price: '100', imageUri: 'ipfs://m' }] }) };
            }
            return { ok: true, json: async () => ({ properties: {} }) };
        };
        global.proposalStorage = { importOnChainProposal: (arg) => { calls.imported = arg; return { proposalId: 'CID123' }; } };

        const result = await loadChainProposalFromRef(CANTON_REF);
        expect(result.ok).toBe(true);
        expect(String(calls.read)).toContain('/canton/proposals?party=party%3A%3Aabc');
        expect(calls.imported.onchain.chainType).toBe('canton');
        expect(calls.imported.parentParcelIds).toEqual(['HR-7']);
        delete global.CantonMode; delete global.getBackendBase;
    });
});
