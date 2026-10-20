// Verify typed local and publication origins cannot cross identifier namespaces.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Origin = require('../../frontend/js/proposals/origin.js');
const backendBase = 'https://api.example';
const localOrigin = {
    relation: 'revision', source: { kind: 'local', localProposalId: '17' }, title: 'Source'
};

describe('qualified proposal origin', () => {
    it('never resolves a browser key as an equal-looking published row', () => {
        const records = [{ proposalId: 'another', serverProposalId: '17' }];
        expect(Origin.resolveLocal(localOrigin, records, backendBase)).toBeNull();
        const original = { proposalId: '17' };
        expect(Origin.resolveLocal(localOrigin, [...records, original], backendBase)).toBe(original);
    });

    it('requires the publication store as well as the row and refuses ambiguous local copies', () => {
        const origin = Origin.fromRecord({ proposalId: 'source', serverProposalId: '17', publicationApiBase: backendBase }, { backendBase });
        const wrongStore = { proposalId: 'wrong', serverProposalId: '17', publicationApiBase: 'https://elsewhere.example' };
        expect(Origin.resolveLocal(origin, [wrongStore], backendBase)).toBeNull();
        const correct = { proposalId: 'source', serverProposalId: '17', publicationApiBase: backendBase };
        expect(Origin.resolveLocal(origin, [wrongStore, correct], backendBase)).toBe(correct);
        expect(() => Origin.resolveLocal(origin, [correct, { ...correct, proposalId: 'duplicate' }], backendBase))
            .toThrow(/multiple local copies/);
    });

    it('keeps a bare server row local instead of qualifying it with the current backend', () => {
        const bare = { proposalId: 'source', serverProposalId: '17' };
        const origin = Origin.fromRecord(bare, { backendBase });
        expect(origin.source).toEqual({ kind: 'local', localProposalId: 'source' });
        expect(Origin.resolveLocal({ relation: 'copy', source: { kind: 'publication', apiBase: backendBase, proposalRowId: '17' } }, [bare], backendBase))
            .toBeNull();
    });

    it('preserves a source published after the fork, without mutating local history', () => {
        const published = { proposalId: '17', serverProposalId: '28', publicationApiBase: backendBase, title: 'Source' };
        expect(Origin.portable(localOrigin, { findLocal: () => published, backendBase })).toEqual({
            relation: 'revision', source: { kind: 'publication', apiBase: backendBase, proposalRowId: '28' }, title: 'Source'
        });
        expect(localOrigin.source).toEqual({ kind: 'local', localProposalId: '17' });
    });

    it('does not export an unpublished browser key as a portable identity', () => {
        expect(Origin.portable(localOrigin, { findLocal: () => ({ proposalId: '17' }), backendBase }))
            .toEqual({ relation: 'revision', source: null, title: 'Source' });
        expect(Origin.portable(localOrigin, { findLocal: () => ({ proposalId: '17', serverProposalId: '28' }), backendBase }))
            .toEqual({ relation: 'revision', source: null, title: 'Source' });
    });

    it('requires an explicit reference kind, positive row and credential-free API base', () => {
        for (const source of [
            { proposalId: '17' },
            { kind: 'publication', proposalRowId: '17' },
            { kind: 'publication', proposalRowId: '0', apiBase: backendBase },
            { kind: 'publication', proposalRowId: '17', apiBase: 'https://user:password@api.example' }
        ]) expect(() => Origin.normalize({ relation: 'copy', source })).toThrow(/qualified/);
        expect(Origin.sameReference(localOrigin.source, { kind: 'publication', apiBase: backendBase, proposalRowId: '17' })).toBe(false);
    });
});
