// Profile links name exact browser keys ({ localProposalId }) and nothing else: a key never resolves
// through a published row, and a profile names no chain records, since designs are not minted
// (plan-design-agreement.md, M3).
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const links = require('../../frontend/js/agent-proposal-links.js');
const records = [
    { proposalId: '77', title: 'Numeric local draft' },
    { proposalId: 'published-copy', serverProposalId: '77' },
    { proposalId: 'sited', cadastreParcelIds: ['HR-1', 'HR-2'] }
];

describe('local profile links', () => {
    it('resolves a link only to the record whose browser key it names', () => {
        expect(links.resolve(links.local('77'), records).title).toBe('Numeric local draft');
        expect(links.resolve(links.local(' published-copy '), records).proposalId).toBe('published-copy');
        expect(links.resolve(links.local('7'), records)).toBeNull();
    });
    it('does not resolve a missing local key through a server row', () => {
        expect(links.resolve(links.local('77'), records.slice(1))).toBeNull();
    });
    it('builds links from a profile key list and merges repeated keys in order', () => {
        expect(links.locals(['77', 'sited'])).toEqual([{ localProposalId: '77' }, { localProposalId: 'sited' }]);
        expect(links.key(links.local('77'))).toBe('77');
        expect(links.merge([links.local('sited'), links.local('77'), links.local('sited')])).toEqual(links.locals(['sited', '77']));
        expect(links.merge(null)).toEqual([]);
    });
    it('refuses empty keys and links that name no local key, such as a former chain link', () => {
        expect(() => links.local('  ')).toThrow('A local proposal key is required');
        expect(() => links.locals(['77', null])).toThrow('A local proposal key is required');
        expect(() => links.resolve('77', records)).toThrow('one local proposal key');
        const chainLink = { chainRef: { chainType: 'evm', chainId: '84532', contract: '0xabc', tokenId: '77' } };
        expect(() => links.resolve(chainLink, records)).toThrow('one local proposal key');
        expect(() => links.merge([links.local('77'), chainLink])).toThrow('one local proposal key');
        expect(() => links.key({ localProposalId: ' ' })).toThrow('one local proposal key');
    });
});

const source = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');
const openNode = parse(source, { sourceType: 'script' }).program.body.find(node => node.id?.name === 'openAgentProposalLink');
function navigation(proposals = records) {
    const focus = vi.fn(); const close = vi.fn();
    const context = vm.createContext({
        window: { AgentProposalLinks: links }, getAgentProposalRecords: () => proposals,
        selectAndHighlightProposal: focus, closeAgentDialog: close
    });
    vm.runInContext(source.slice(openNode.start, openNode.end), context);
    return { open: context.openAgentProposalLink, focus, close };
}
describe('profile link navigation', () => {
    it('closes the dialog and focuses the record with that key, on its first parcel', async () => {
        const n = navigation();
        await n.open(links.local('sited'));
        expect(n.close).toHaveBeenCalledOnce();
        expect(n.focus).toHaveBeenCalledWith('sited', 'HR-1', true);
        await n.open(links.local('77'));
        expect(n.focus).toHaveBeenLastCalledWith('77', null, true);
    });
    it('does not open a published row for a missing numeric local key', async () => {
        const n = navigation(records.slice(1)); await n.open(links.local('77'));
        expect(n.focus).not.toHaveBeenCalled(); expect(n.close).not.toHaveBeenCalled();
    });
});
