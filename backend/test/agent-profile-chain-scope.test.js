// Characterize the connected-wallet loader's profile boundary and asynchronous result ownership. The
// wallet fills only the profile's parcels: designs are not minted, so it names no chain proposals
// (plan-design-agreement.md, M3).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const walletScope = createRequire(import.meta.url)('../../frontend/js/agent-wallet-scope.js');

const source = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');
const node = parse(source, { sourceType: 'script' }).program.body.find(n => n.id?.name === 'loadAgentChainData');
const loaderSource = source.slice(node.start, node.end);
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function harness() {
    let walletState = { status: 'connected', accounts: ['wallet-a'], chainId: '0x1' };
    let localParcels = [];
    const requested = deferred();
    const response = deferred();
    let modal = { dataset: { agentId: 'user' }, isConnected: true };
    const lists = () => Object.fromEntries(['parcels', 'created'].map(key => [key, { data: [], loaded: 0 }]));
    const fetchParcels = vi.fn(() => { requested.resolve(); return response.promise; });
    const merge = vi.fn(() => true);
    const cache = vi.fn();
    const errors = vi.fn();
    const context = vm.createContext({
        window: {
            AgentWalletScope: walletScope,
            walletManager: { getState: () => walletState, getProvider: () => ({}) },
            ChainDataLoader: {
                resolveContractAddress: async (_chain, name) => name === 'ParcelNFT' ? 'parcel-contract' : null,
                getParcelsFromChain: fetchParcels
            },
            ethers: {}
        },
        document: { querySelector: () => modal },
        console: { log() {}, debug() {}, warn() {} },
        getAgentDialogCache: () => null,
        getCurrentAgentWalletScope: () => walletScope.connected({ evm: walletState }),
        getAgentParcelDetails: () => localParcels,
        agentDialogListData: lists(), agentWalletObservations: {}, agentDialogFetchPromises: new Map(), AGENT_DIALOG_CACHE_TTL_MS: 60000,
        setListLoading() {}, replaceAgentDialogListData: merge, renderFirstPageForList() {}, setSectionCount() {},
        setAgentDialogCache: cache, setListError: errors
    });
    vm.runInContext(loaderSource, context);
    const load = (isUser = true) => context.loadAgentChainData({ id: 'user' }, isUser);
    const switchProfile = (id = 'other') => {
        modal.isConnected = false;
        modal = { dataset: { agentId: id }, isConnected: true };
        context.agentDialogListData = lists();
    };
    return { context, load, requested, response, fetchParcels, merge, cache, errors, switchProfile, setWallet: state => { walletState = state; }, setLocal: ids => { localParcels = ids.map(id => ({ id })); } };
}

describe('connected-wallet profile scope', () => {
    it('does not query the connected wallet for another agent', async () => {
        const h = harness();
        await h.load(false);
        expect(h.fetchParcels).not.toHaveBeenCalled();
        expect(h.merge).not.toHaveBeenCalled();
        expect(h.cache).not.toHaveBeenCalled();
    });
    it('merges a completed wallet observation into its current profile, parcels only', async () => {
        const h = harness();
        const loading = h.load();
        await h.requested.promise;
        h.response.resolve([{ parcelId: 'wallet-parcel' }]);
        await loading;
        expect(h.fetchParcels).toHaveBeenCalledWith('wallet-a', '0x1', 'parcel-contract');
        expect(h.merge.mock.calls).toEqual([['parcels', ['wallet-parcel']]]);
        expect(h.context.agentWalletObservations.user).toMatchObject({ scope: { walletAddress: 'wallet-a', chainId: '0x1' }, contractAddress: 'parcel-contract', parcelIds: ['wallet-parcel'] });
        expect(h.cache).toHaveBeenCalledWith('user', expect.objectContaining({ scope: { walletAddress: 'wallet-a', chainId: '0x1' } }));
    });
    it.each(['other', 'user'])('discards late observations after replacing the dialog with %s', async id => {
        const h = harness();
        const loading = h.load();
        await h.requested.promise;
        h.switchProfile(id);
        h.response.resolve([{ parcelId: 'old-wallet-parcel' }]);
        await loading;
        expect(h.merge).not.toHaveBeenCalled();
        expect(h.context.agentWalletObservations).toEqual({});
        expect(h.cache).not.toHaveBeenCalled();
    });
    it('does not put a late request error into another profile', async () => {
        const h = harness();
        const loading = h.load();
        await h.requested.promise;
        h.switchProfile();
        h.response.reject(new Error('offline'));
        await loading;
        expect(h.errors).not.toHaveBeenCalled();
    });
    it('allows a reopened profile to fetch without reusing its abandoned request', async () => {
        const h = harness();
        const first = h.load();
        await h.requested.promise;
        h.switchProfile('user');
        const secondRequested = deferred();
        h.fetchParcels.mockImplementationOnce(() => { secondRequested.resolve(); return Promise.resolve([{ parcelId: 'new-observation' }]); });
        const second = h.load();
        await secondRequested.promise;
        await second;
        h.response.resolve([{ parcelId: 'old-observation' }]);
        await first;
        expect(h.fetchParcels).toHaveBeenCalledTimes(2);
        expect(h.merge).toHaveBeenCalledWith('parcels', ['new-observation']);
        expect(h.merge).not.toHaveBeenCalledWith('parcels', ['old-observation']);
    });
    it.each([
        { status: 'connected', accounts: ['wallet-b'], chainId: '0x1' },
        { status: 'connected', accounts: ['wallet-a'], chainId: '0x2' },
        { status: 'disconnected', accounts: [], chainId: '0x1' }
    ])('discards a late observation after wallet scope changes to %j', async state => {
        const h = harness();
        const loading = h.load();
        await h.requested.promise;
        h.setWallet(state);
        h.response.resolve([{ parcelId: 'stale-parcel' }]);
        await loading;
        expect(h.merge).not.toHaveBeenCalled();
        expect(h.context.agentWalletObservations).toEqual({});
        expect(h.cache).not.toHaveBeenCalled();
    });
    it('replaces an old observation with an empty result without claiming local assignments as chain evidence', async () => {
        const h = harness();
        h.setLocal(['model-parcel']);
        h.context.agentWalletObservations.user = { scope: { chainId: '0x1', walletAddress: 'wallet-a' }, contractAddress: 'parcel-contract', parcelIds: ['old-parcel'] };
        const loading = h.load();
        await h.requested.promise;
        h.response.resolve([]);
        await loading;
        expect(h.context.agentWalletObservations.user.parcelIds).toEqual([]);
        expect(h.merge).toHaveBeenCalledWith('parcels', ['model-parcel']);
    });
});
