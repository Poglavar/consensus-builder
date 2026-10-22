// Verify typed origins (proposals/origin.js): a source is a local key or a published design's CID,
// the two namespaces never cross, and a local key never travels outside this browser.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Origin = require('../../frontend/js/proposals/origin.js');
const Cid = require('../../frontend/js/cid.js');
const CID = Cid.cidOfObject({ schema: 'design/v1', title: 'Source' });
const published = (proposalId, cid = CID) => ({ proposalId, title: 'Source', published: { cid, publishedAt: null, apiBase: 'https://api.example' } });
const localOrigin = {
    relation: 'revision', source: { kind: 'local', localProposalId: '17' }, title: 'Source'
};

describe('typed proposal origin', () => {
    it('resolves a local key only to the record with that key, never to an equal-looking CID or id', () => {
        const records = [{ proposalId: 'another', id: '17' }, published('elsewhere')];
        expect(Origin.resolveLocal(localOrigin, records)).toBeNull();
        const original = { proposalId: '17' };
        expect(Origin.resolveLocal(localOrigin, [...records, original])).toBe(original);
    });

    it('names a published source by its CID and resolves it to the local copy holding that design', () => {
        const origin = Origin.fromRecord(published('source'), { relation: 'copy' });
        expect(origin).toEqual({ relation: 'copy', source: { kind: 'design', cid: CID }, title: 'Source' });
        const other = published('other', Cid.cidOfObject({ schema: 'design/v1', title: 'Other' }));
        expect(Origin.resolveLocal(origin, [other, { proposalId: CID }])).toBeNull();
        const copy = published('design-copy');
        expect(Origin.resolveLocal(origin, [other, copy])).toBe(copy);
    });

    it('names an unpublished source by its local key, the caller\'s key first', () => {
        expect(Origin.fromRecord({ proposalId: 'source', title: 'Draft' }).source).toEqual({ kind: 'local', localProposalId: 'source' });
        expect(Origin.fromRecord({}, { localProposalId: 'draft-source' }).source).toEqual({ kind: 'local', localProposalId: 'draft-source' });
        expect(Origin.fromRecord({ proposalId: 'x', published: { cid: 'not-a-cid' } }).source).toEqual({ kind: 'local', localProposalId: 'x' });
        expect(() => Origin.fromRecord({})).toThrow(/no qualified identity/);
    });

    it('carries a source published after the fork as its CID, without mutating local history', () => {
        expect(Origin.portable(localOrigin, { findLocal: () => published('17') })).toEqual({
            relation: 'revision', source: { kind: 'design', cid: CID }, title: 'Source'
        });
        expect(localOrigin.source).toEqual({ kind: 'local', localProposalId: '17' });
    });

    it('does not export an unpublished browser key as a portable identity', () => {
        expect(Origin.portable(localOrigin, { findLocal: () => ({ proposalId: '17' }) }))
            .toEqual({ relation: 'revision', source: null, title: 'Source' });
        expect(Origin.portable(localOrigin, { findLocal: () => published('another') }))
            .toEqual({ relation: 'revision', source: null, title: 'Source' });
        expect(Origin.portable(localOrigin)).toEqual({ relation: 'revision', source: null, title: 'Source' });
    });

    it('requires an explicit reference kind, a local key or a design CID, and nothing else', () => {
        for (const source of [
            { proposalId: '17' },
            { kind: 'local' },
            { kind: 'local', localProposalId: '17', cid: CID },
            { kind: 'design', cid: 'bafy-not-a-cid' },
            { kind: 'design', cid: CID, localProposalId: '17' },
            // The server-row references of the proposal table are gone (M2).
            { kind: 'publication', proposalRowId: '17', apiBase: 'https://api.example' }
        ]) expect(() => Origin.normalize({ relation: 'copy', source })).toThrow(/local key or a design CID/);
        expect(() => Origin.normalize({ relation: 'adopt', source: null })).toThrow(/copy, revision or rebind/);
        expect(Origin.normalize(null)).toBeNull();
    });

    it('normalises the API base a design is published at, refusing credentials, queries and other schemes', () => {
        expect(Origin.apiBase('https://api.example/')).toBe('https://api.example');
        expect(Origin.apiBase('https://user:password@api.example')).toBeNull();
        expect(Origin.apiBase('https://api.example/?x=1')).toBeNull();
        expect(Origin.apiBase('ftp://api.example')).toBeNull();
        expect(Origin.apiBase('')).toBeNull();
    });
});
