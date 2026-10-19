import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { DEVNET_GENESIS_HASH } from '../oracle/proposal-lifecycle.js';
const require = createRequire(import.meta.url);
const references = require('../../frontend/js/proposals/chain-ref.js');
const status = require('../../frontend/js/proposals/chain-status.js');
const authored = require('../../frontend/js/proposals/authored-record.js');

function boot(family, records = [], options = {}) {
    const storage = {
        getAllProposals: () => records,
        addProposal: vi.fn(record => records.push(record)),
        importOnChainProposal: vi.fn(), save: vi.fn()
    };
    const getProposal = vi.fn(async () => [['parcel-a'], true, 'ipfs://record', true, options.statusCode ?? 1, 0n, 0n, 0n, 0n, 0n]);
    const getGenesisHash = vi.fn(async () => options.genesisHash === undefined ? DEVNET_GENESIS_HASH : options.genesisHash);
    const getAccountInfo = vi.fn(async () => ({ data: new Uint8Array([1]),
        owner: { toBase58: () => options.programOwner ?? 'ProgramAbC' } }));
    const getAllProposals = vi.fn(async () => options.proposals ?? [{ proposalId: 'AccountXyZ' }]);
    const updateStatus = vi.fn();
    const context = {
        console: { log() {}, warn() {}, error() {} },
        ChainProposalRef: references, ProposalChainStatus: status, ProposalAuthoredRecord: authored,
        getCityConfig: () => ({ blockchain: { solanaProposalContracts: [{ cluster: options.cluster ?? 'devnet', programAddress: 'ProgramAbC' }] } }),
        updateStatus,
        proposalStorage: storage, walletManager: { isConnected: () => true, getProvider: () => ({}) },
        ethers: {
            BrowserProvider: class { async getNetwork() { return { chainId: options.network ?? 84532n }; } },
            Contract: class { getProposal = getProposal; async ownerOf() { return 'mint-owner'; } }
        },
        solanaWalletManager: { getState: () => ({ status: 'connected', accounts: ['wallet'] }) },
        solanaWeb3: { PublicKey: class { constructor(value) { this.value = value; } } },
        SolanaChainDataLoader: {
            getConnection: () => ({ getGenesisHash, getAccountInfo }), getAllProposals,
            parseProposalAccount: () => ({ cadastreParcelIds: ['parcel-a'], statusCode: options.statusCode ?? 1 })
        }
    };
    context.window = context;
    vm.createContext(context);
    const file = family === 'evm' ? 'blockchain-sync.js' : 'solana/blockchain-sync.js';
    vm.runInContext(readFileSync(new URL(`../../frontend/js/${file}`, import.meta.url), 'utf8'), context);
    return { api: family === 'evm' ? context.BlockchainSync : context.SolanaBlockchainSync, storage, getProposal,
        getGenesisHash, getAccountInfo, getAllProposals, updateStatus };
}

describe('blockchain sync uses qualified proposal identity', () => {
    it('does not turn an unrelated draft on the same parcels into an EVM token', async () => {
        const draft = { proposalId: 'draft', title: 'Draft', cadastreParcelIds: ['parcel-a'], lifecycleStatus: 'Active' };
        const before = structuredClone(draft);
        const { api, storage } = boot('evm', [draft]);
        expect(await api.syncSingle('84532', '0xABC', 7)).toBe(true);
        expect(draft).toEqual(before);
        expect(storage.addProposal).toHaveBeenCalledWith(expect.objectContaining({ proposalId: '84532-0xabc-7', lifecycleStatus: 'Executed' }));
    });
    it('refreshes only the exact EVM reference, including an unknown observed status', async () => {
        const record = { proposalId: 'local-key', cadastreParcelIds: ['parcel-a'], lifecycleStatus: 'Active', applied: true,
            onchain: { chainId: '84532', contractAddress: '0xabc', proposalId: '7' } };
        const { api, storage } = boot('evm', [record], { statusCode: 255 });
        expect(await api.syncSingle('0x14a34', '0xABC', 7)).toBe(true);
        expect(record.proposalId).toBe('local-key');
        expect(record.lifecycleStatus).toBe('Unknown');
        expect(record.applied).toBe(true);
        expect(storage.save).toHaveBeenCalledOnce();
        expect(storage.addProposal).not.toHaveBeenCalled();
    });
    it('refuses a direct EVM sync on a different wallet network before reading or writing', async () => {
        const { api, storage, getProposal } = boot('evm', [], { network: 1n });
        expect(await api.syncSingle('84532', '0xabc', 7)).toBe(false);
        expect(getProposal).not.toHaveBeenCalled();
        expect(storage.addProposal).not.toHaveBeenCalled();
        expect(storage.save).not.toHaveBeenCalled();
    });
    it('does not match a Solana draft by parcel set and preserves program case', async () => {
        const draft = { proposalId: 'draft', cadastreParcelIds: ['parcel-a'] };
        const before = structuredClone(draft);
        const { api, storage } = boot('solana', [draft]);
        expect(await api.syncSingle('devnet', 'ProgramAbC', 'AccountXyZ')).toBe(true);
        expect(draft).toEqual(before);
        expect(storage.importOnChainProposal).not.toHaveBeenCalled();
        expect(storage.addProposal).toHaveBeenCalledWith(expect.objectContaining({
            proposalId: 'solana-devnet-ProgramAbC-AccountXyZ',
            nft: { chain: 'solana-devnet', contract: 'ProgramAbC', tokenId: 'AccountXyZ' }
        }));
    });
    it('refreshes the exact Solana reference with unknown state preserved', async () => {
        const record = { proposalId: 'local-key', onchain: { chainId: 'solana-devnet', contractAddress: 'ProgramAbC', proposalId: 'AccountXyZ' } };
        const { api, storage } = boot('solana', [record], { statusCode: 255 });
        expect(await api.syncSingle('devnet', 'ProgramAbC', 'AccountXyZ')).toBe(true);
        expect(storage.importOnChainProposal).toHaveBeenCalledWith(expect.objectContaining({
            contractAddress: 'ProgramAbC', lifecycleStatus: 'Unknown' }));
        expect(storage.addProposal).not.toHaveBeenCalled();
    });
    it('rejects Solana accounts owned by another program without touching the store', async () => {
        const { api, storage } = boot('solana', [], { programOwner: 'programabc' });
        expect(await api.syncSingle('devnet', 'ProgramAbC', 'AccountXyZ')).toBe(false);
        expect(storage.addProposal).not.toHaveBeenCalled();
        expect(storage.importOnChainProposal).not.toHaveBeenCalled();
    });

    it.each(['wrong-network', null, ''])('rejects an unverified Solana network before listing, reading or writing: %j', async genesisHash => {
        const { api, storage, getAccountInfo, getAllProposals, updateStatus } = boot('solana', [], { genesisHash });
        expect(await api.syncSingle('devnet', 'ProgramAbC', 'AccountXyZ')).toBe(false);
        expect(await api.sync()).toMatchObject({ totalSynced: 0, contracts: [{ synced: 0, error: 'Solana RPC network does not match devnet.' }] });
        expect(getAccountInfo).not.toHaveBeenCalled();
        expect(getAllProposals).not.toHaveBeenCalled();
        expect(storage.addProposal).not.toHaveBeenCalled();
        expect(storage.importOnChainProposal).not.toHaveBeenCalled();
        expect(storage.save).not.toHaveBeenCalled();
        expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('sync incomplete'));
        expect(updateStatus).not.toHaveBeenCalledWith('No new Solana proposals');
    });

    it('rejects unsupported clusters and failed network reads without defaulting to devnet', async () => {
        const { api, getGenesisHash, getAccountInfo, getAllProposals } = boot('solana', [], { cluster: 'testnet' });
        expect(await api.sync()).toMatchObject({ totalSynced: 0, contracts: [{ error: expect.stringContaining('devnet deployment only') }] });
        expect(getGenesisHash).not.toHaveBeenCalled();
        getGenesisHash.mockRejectedValueOnce(new Error('rpc down'));
        expect(await api.syncSingle('devnet', 'ProgramAbC', 'AccountXyZ')).toBe(false);
        expect(getAccountInfo).not.toHaveBeenCalled();
        expect(getAllProposals).not.toHaveBeenCalled();
    });

    it('retains successful import counts and reports a network change before the next account read', async () => {
        const { api, storage, getGenesisHash, getAccountInfo, updateStatus } = boot('solana', [], {
            proposals: [{ proposalId: 'AccountOne' }, { proposalId: 'AccountTwo' }]
        });
        getGenesisHash.mockResolvedValueOnce(DEVNET_GENESIS_HASH).mockResolvedValueOnce(DEVNET_GENESIS_HASH).mockResolvedValueOnce('wrong-network');
        expect(await api.sync()).toMatchObject({ totalSynced: 1, contracts: [{ synced: 1, error: 'Solana RPC network does not match devnet.' }] });
        expect(getAccountInfo).toHaveBeenCalledTimes(1);
        expect(storage.addProposal).toHaveBeenCalledTimes(1);
        expect(updateStatus).toHaveBeenCalledWith('Solana sync incomplete; 1 proposal(s) synced. Solana RPC network does not match devnet.');
    });
});
