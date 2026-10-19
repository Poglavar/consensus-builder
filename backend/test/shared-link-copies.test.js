import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const links = require('../../frontend/js/proposals/shared-link-copies.js');

describe('published shared-link copies', () => {
    it('matches a numeric URL only through the explicit publication row', () => {
        const local = { proposalId: '42', id: 42, nft: { tokenId: '42' }, applied: true };
        const copy = { proposalId: 'my-published-copy', serverProposalId: '42' };
        expect([...links.match([local], ['42'])]).toEqual([]);
        expect(links.match([local, copy], ['42']).get('42')).toBe(copy);
    });

    it('resolves an authored URL through the fetched publication row, not local key equality', () => {
        const local = { proposalId: 'authored-key', serverProposalId: '99' };
        const copy = { proposalId: 'custom-local-key', serverProposalId: '42' };
        const payload = new Map([['authored-key', { id: 42, proposalId: 'authored-key' }]]);
        expect([...links.match([local, copy], ['authored-key'])]).toEqual([]);
        expect(links.match([local, copy], ['authored-key'], payload).get('authored-key')).toBe(copy);
        expect([...links.match([local, copy], ['wrong-key'], payload)]).toEqual([]);
    });

    it('does not let a local fork or unresolved source claim stand in for a linked publication', () => {
        const source = { proposalId: 'source', serverProposalId: '42' };
        const fork = { proposalId: 'fork', replacementOfProposalId: 'source', sourceProposalId: '42', applied: true };
        expect([...links.match([fork], ['42'])]).toEqual([]);
        expect(links.match([source, fork], ['42']).get('42')).toBe(source);
    });

    it('rejects ambiguous row copies rather than choosing an arbitrary applied record', () => {
        expect(() => links.match([{ proposalId: 'a', serverProposalId: '42' },
            { proposalId: 'b', serverProposalId: 42 }], ['42']))
            .toThrow('Multiple local copies declare published row 42');
    });

    it('can resolve two URL references to one local copy without changing any records', () => {
        const record = { proposalId: 'local', serverProposalId: '42' };
        const before = structuredClone(record);
        const matches = links.match([record], ['42', 'authored'], new Map([['authored', { id: 42, proposalId: 'authored' }]]));
        expect([...matches.keys()]).toEqual(['42', 'authored']);
        expect([...new Set(matches.values())]).toEqual([record]);
        expect(record).toEqual(before);
    });

    it('does not infer rows from generic IDs, invalid row references or mismatched fetched identities', () => {
        expect(links.rowId('local-42')).toBeNull();
        expect(links.rowId(0)).toBeNull();
        expect(links.referenceRowId('authored', { id: 42, proposalId: 'different' })).toBeNull();
        expect([...links.match([{ proposalId: 'x', id: 42 }], ['42'])]).toEqual([]);
    });
});
