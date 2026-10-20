// Profile navigation never confuses local keys, publication rows or chain tokens.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const links = require('../../frontend/js/agent-proposal-links.js');
const onchain = (chainId, contractAddress, proposalId) => ({ chainId, contractAddress, proposalId });
const records = [
    { proposalId: '77', title: 'Numeric local draft' },
    { proposalId: 'published-copy', serverProposalId: '77' },
    { proposalId: 'chain-one', onchain: onchain('0x1', '0xABC', '77') },
    { proposalId: 'chain-two', onchain: onchain('0x2', '0xABC', '77') },
    { proposalId: 'other-contract', onchain: onchain('0x1', '0xDEF', '77') }
];

describe('qualified profile links', () => {
    it('keeps colliding local keys and scoped chain tokens separate', () => {
        expect(links.resolve(links.local('77'), records).title).toBe('Numeric local draft');
        expect(links.resolve(links.chain(1, '0xabc', 77), records).proposalId).toBe('chain-one');
        expect(links.resolve(links.chain(2, '0xabc', 77), records).proposalId).toBe('chain-two');
        expect(links.resolve(links.chain(1, '0xdef', 77), records).proposalId).toBe('other-contract');
    });
    it('does not resolve a missing local key through a server row or chain alias', () => {
        expect(links.resolve(links.local('77'), records.slice(1))).toBeNull();
        expect(links.resolve(links.chain(3, '0xabc', 77), records)).toBeNull();
    });
    it('merges an actual local copy with its qualified chain link while keeping the colliding draft', () => {
        expect(links.merge([links.local('77'), links.local('chain-one'), links.chain(1, '0xabc', 77)], records))
            .toEqual([links.local('77'), links.local('chain-one')]);
    });
    it('deduplicates equivalent EVM locations without merging different contracts', () => {
        expect(links.merge([links.chain(1, '0xABC', 77), links.chain('0x1', '0xabc', '0x4d'), links.chain(1, '0xdef', 77)], []).length).toBe(2);
    });
    it('preserves case-sensitive Solana accounts', () => {
        expect(links.merge([links.chain('solana-devnet', 'Program', 'Account'), links.chain('solana-devnet', 'Program', 'account')], []).length).toBe(2);
    });
    it('refuses incomplete, ambiguous or unqualified link formats', () => {
        expect(() => links.chain(null, 'contract', '77')).toThrow('complete');
        expect(() => links.resolve('77', records)).toThrow();
        expect(() => links.resolve({ localProposalId: '77', chainRef: links.chain(1, 'contract', 77).chainRef }, records)).toThrow('one local');
        expect(() => links.resolve(links.chain(1, '0xabc', 77), [...records, { proposalId: 'duplicate', onchain: onchain(1, '0xabc', 77) }])).toThrow('Multiple');
    });
});

const source = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');
const openNode = parse(source, { sourceType: 'script' }).program.body.find(node => node.id?.name === 'openAgentProposalLink');
function navigation(proposals = records) {
    const focus = vi.fn(); const chainRead = vi.fn(); const close = vi.fn(); const seen = vi.fn();
    const context = vm.createContext({
        window: { AgentProposalLinks: links }, getAgentProposalRecords: () => proposals,
        selectAndHighlightProposal: focus, handleChainProposalRoute: chainRead, closeAgentDialog: close,
        userNotifications: { markProposalAsSeen: seen }
    });
    vm.runInContext(source.slice(openNode.start, openNode.end), context);
    return { open: context.openAgentProposalLink, focus, chainRead, close, seen };
}
describe('profile link navigation', () => {
    it('focuses the local copy of a chain token even when a local draft has that token as its key', async () => {
        const n = navigation(); await n.open(links.chain(1, '0xabc', 77), true);
        expect(n.focus).toHaveBeenCalledWith('chain-one', null, true);
        expect(n.seen).toHaveBeenCalledWith('chain-one');
        expect(n.chainRead).not.toHaveBeenCalled();
    });
    it('does not open a published row for a missing numeric local key', async () => {
        const n = navigation(records.slice(1)); await n.open(links.local('77'));
        expect(n.focus).not.toHaveBeenCalled(); expect(n.chainRead).not.toHaveBeenCalled(); expect(n.close).not.toHaveBeenCalled();
    });
    it('passes an unloaded chain reference intact to the chain reader', async () => {
        const n = navigation(); const link = links.chain(3, '0xabc', 77); await n.open(link);
        expect(n.chainRead).toHaveBeenCalledWith(link.chainRef); expect(n.focus).not.toHaveBeenCalled();
    });
});
