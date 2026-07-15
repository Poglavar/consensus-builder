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
    it('reports not-yet-wired for solana/canton and bad refs', async () => {
        expect((await loadChainProposalFromRef({ chainType: 'solana' })).reason).toBe('chain-not-supported');
        expect((await loadChainProposalFromRef({ chainType: 'canton' })).reason).toBe('chain-not-supported');
        expect((await loadChainProposalFromRef(null)).reason).toBe('bad-ref');
    });
});
