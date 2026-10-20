import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const links = require('../../frontend/js/proposals/shared-link-copies.js');
const API = 'https://api.example.test';
const match = (records, references, fetched) => links.match(records, references, fetched, API);

describe('published shared-link copies', () => {
    it('requires the requested API and never matches a bare row or another store', () => {
        const bare = { proposalId: 'bare', serverProposalId: '42' };
        const foreign = { proposalId: 'foreign', serverProposalId: '42', publicationApiBase: 'https://elsewhere.example.test' };
        const current = { proposalId: 'current', serverProposalId: '42', publicationApiBase: API };
        expect([...match([bare, foreign], ['42'])]).toEqual([]);
        expect([...links.match([current], ['42'])]).toEqual([]);
        expect(match([bare, foreign, current], ['42']).get('42')).toBe(current);
    });
    it('matches a numeric URL only through the explicit publication row', () => {
        const local = { proposalId: '42', id: 42, nft: { tokenId: '42' }, applied: true };
        const copy = { proposalId: 'my-published-copy', publicationApiBase: API, serverProposalId: '42' };
        expect([...match([local], ['42'])]).toEqual([]);
        expect(match([local, copy], ['42']).get('42')).toBe(copy);
    });

    it('resolves an authored URL through the fetched publication row, not local key equality', () => {
        const local = { proposalId: 'authored-key', publicationApiBase: API, serverProposalId: '99' };
        const copy = { proposalId: 'custom-local-key', publicationApiBase: API, serverProposalId: '42' };
        const payload = new Map([['authored-key', { id: 42, proposalId: 'authored-key' }]]);
        expect([...match([local, copy], ['authored-key'])]).toEqual([]);
        expect(match([local, copy], ['authored-key'], payload).get('authored-key')).toBe(copy);
        expect([...match([local, copy], ['wrong-key'], payload)]).toEqual([]);
    });

    it('does not let a local fork or unresolved source claim stand in for a linked publication', () => {
        const source = { proposalId: 'source', publicationApiBase: API, serverProposalId: '42' };
        const fork = { proposalId: 'fork', replacementOfProposalId: 'source', sourceProposalId: '42', applied: true };
        expect([...match([fork], ['42'])]).toEqual([]);
        expect(match([source, fork], ['42']).get('42')).toBe(source);
    });

    it('rejects ambiguous row copies rather than choosing an arbitrary applied record', () => {
        expect(() => match([{ proposalId: 'a', publicationApiBase: API, serverProposalId: '42' },
            { proposalId: 'b', publicationApiBase: API, serverProposalId: 42 }], ['42']))
            .toThrow('Multiple local copies declare published row 42');
    });

    it('can resolve two URL references to one local copy without changing any records', () => {
        const record = { proposalId: 'local', publicationApiBase: API, serverProposalId: '42' };
        const before = structuredClone(record);
        const matches = match([record], ['42', 'authored'], new Map([['authored', { id: 42, proposalId: 'authored' }]]));
        expect([...matches.keys()]).toEqual(['42', 'authored']);
        expect([...new Set(matches.values())]).toEqual([record]);
        expect(record).toEqual(before);
    });

    it('does not infer rows from generic IDs, invalid row references or mismatched fetched identities', () => {
        expect(links.rowId('local-42')).toBeNull();
        expect(links.rowId(0)).toBeNull();
        expect(links.referenceRowId('authored', { id: 42, proposalId: 'different' })).toBeNull();
        expect([...match([{ proposalId: 'x', id: 42 }], ['42'])]).toEqual([]);
    });
});
