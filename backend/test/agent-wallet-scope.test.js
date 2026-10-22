// Wallet observations are reusable only inside their connected account/network scope.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const scope = createRequire(import.meta.url)('../../frontend/js/agent-wallet-scope.js');
const proposalLinks = createRequire(import.meta.url)('../../frontend/js/agent-proposal-links.js');
const evm = { chainId: '0x1', walletAddress: '0xAbC' };

describe('agent wallet scope', () => {
    it('normalizes EVM network notation and address case', () => {
        expect(scope.matches(evm, { chainId: 1, walletAddress: '0xabc' })).toBe(true);
        expect(scope.normalize(evm)).toEqual({ chainId: '0x1', walletAddress: '0xabc' });
    });
    it('keeps Solana accounts and clusters distinct', () => {
        const sol = { chainId: 'solana-devnet', walletAddress: 'AbC' };
        expect(scope.matches(sol, { ...sol, walletAddress: 'abc' })).toBe(false);
        expect(scope.matches(sol, { ...sol, chainId: 'solana-mainnet-beta' })).toBe(false);
    });
    it('requires connected state and a complete network/account scope', () => {
        expect(scope.connected({ evm: { status: 'disconnected', accounts: ['a'], chainId: 1 } })).toBeNull();
        expect(scope.connected({ evm: { status: 'connected', accounts: [], chainId: 1 } })).toBeNull();
        expect(scope.connected({ solana: { status: 'connected', accounts: ['A'] } })).toBeNull();
        expect(scope.normalize({ chainId: 'invalid', walletAddress: 'a' })).toBeNull();
        expect(scope.normalize({ chainId: 0, walletAddress: 'a' })).toBeNull();
        expect(scope.matches(null, null)).toBe(false);
    });
    it('uses the connected Solana scope when both wallet managers are connected', () => {
        expect(scope.connected({ evm: { status: 'connected', accounts: ['a'], chainId: 1 }, solana: { status: 'connected', accounts: ['B'] }, solanaCluster: 'devnet' }))
            .toEqual({ chainId: 'solana-devnet', walletAddress: 'B' });
    });
    it('reads only observations with matching scope and a declared contract', () => {
        const record = { scope: evm, contractAddress: 'contract', parcelIds: ['p1', 'p1', '', null, 'p2'] };
        expect(scope.parcelIds(record, evm)).toEqual(['p1', 'p2']);
        expect(scope.parcelIds(record, { ...evm, walletAddress: 'other' })).toEqual([]);
        expect(scope.parcelIds(record, { ...evm, chainId: 2 })).toEqual([]);
        expect(scope.parcelIds(record, null)).toEqual([]);
        expect(scope.parcelIds({ ...record, contractAddress: null }, evm)).toEqual([]);
        expect(scope.parcelIds(['p1'], evm)).toEqual([]);
    });
    it('bounds cache reuse by its fetch time and current scope', () => {
        const cache = { scope: evm, lastFetchedAt: 1000 };
        expect(scope.fresh(cache, evm, 60999, 60000)).toBe(true);
        expect(scope.fresh(cache, evm, 61000, 60000)).toBe(false);
        expect(scope.fresh(cache, evm, 999, 60000)).toBe(false);
        expect(scope.fresh(cache, { ...evm, walletAddress: 'other' }, 2000, 60000)).toBe(false);
        expect(scope.fresh({ scope: evm }, evm, 2000, 60000)).toBe(false);
    });
});

// Exercise both production ownership readers and the initial profile lists, not copied logic.
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import vm from 'node:vm';
const source = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');
const names = new Set(['forEachPersistentParcelOwnership', 'getAgentOwnedParcels', 'buildAgentOwnedParcelIndex', 'getAgentObservedWalletParcels', 'normalizeParcelEntries', 'ensureAgentDialogListState']);
const functions = parse(source, { sourceType: 'script' }).program.body.filter(node => names.has(node.id?.name)).map(node => source.slice(node.start, node.end)).join('\n');
function readers() {
    let active = evm;
    let userControlled = true;
    const writes = [];
    const context = vm.createContext({
        window: { AgentWalletScope: scope, AgentProposalLinks: proposalLinks },
        PersistentStorage: new Map([['parcel_model-parcel_owner', 'user']]),
        agentStorage: { getAgent: () => ({ userControlled }) },
        getCurrentAgentWalletScope: () => active,
        agentWalletObservations: { user: { scope: evm, contractAddress: 'contract', parcelIds: ['wallet-parcel'] } },
        agentDialogListData: null,
        AGENT_DIALOG_PAGE_SIZES: { parcels: 50, created: 20 },
        setAgentDialogCache: (...args) => writes.push(args)
    });
    vm.runInContext(functions, context);
    return { context, writes, setScope: value => { active = value; }, setUser: value => { userControlled = value; } };
}

describe('wallet evidence in ownership readers', () => {
    it('adds matching observations to both the query and index without rewriting model storage', () => {
        const h = readers();
        expect(h.context.getAgentOwnedParcels('user')).toEqual(['model-parcel', 'wallet-parcel']);
        expect(h.context.buildAgentOwnedParcelIndex().get('user')).toEqual(['model-parcel', 'wallet-parcel']);
        expect([...h.context.PersistentStorage.keys()]).toEqual(['parcel_model-parcel_owner']);
    });
    it.each([null, { chainId: 2, walletAddress: '0xAbC' }, { chainId: 1, walletAddress: 'other' }])('excludes observations outside the active scope %j', active => {
        const h = readers(); h.setScope(active);
        expect(h.context.getAgentOwnedParcels('user')).toEqual(['model-parcel']);
        expect(h.context.buildAgentOwnedParcelIndex().get('user')).toEqual(['model-parcel']);
    });
    it('excludes chain observations after the agent stops being user-controlled', () => {
        const h = readers(); h.setUser(false);
        expect(h.context.getAgentOwnedParcels('user')).toEqual(['model-parcel']);
        expect(h.context.buildAgentOwnedParcelIndex().get('user')).toEqual(['model-parcel']);
    });
    it('initializes the parcels and created lists without writing or advancing a chain snapshot', () => {
        const h = readers();
        const created = proposalLinks.locals(['design', 'other-design', 'design']);
        const result = h.context.ensureAgentDialogListState('user', ['model-parcel'], created);
        expect(Object.keys(result)).toEqual(['parcels', 'created']);
        expect(result.parcels.data).toEqual([{ id: 'model-parcel', number: 'model-parcel', proposalCount: 0 }]);
        expect(result.created.data).toEqual(proposalLinks.locals(['design', 'other-design']));
        expect(h.writes).toEqual([]);
    });
});
