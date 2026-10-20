// Proposal lineage uses typed local and publication origins; identifiers from those namespaces
// never match by their string value alone.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Lineage = require('../../frontend/js/proposals/lineage.js');
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const API_A = 'https://api-a.example.test';
const API_B = 'https://api-b.example.test';

describe('publishedOrigin', () => {
    it('qualifies a published local source with its explicit publication store', () => {
        vi.stubGlobal('getBackendBase', () => API_B);
        const record = {
            proposalId: 'child',
            proposalOrigin: {
                relation: 'revision',
                source: { kind: 'local', localProposalId: 'source' },
                title: 'Original'
            }
        };
        const source = { proposalId: 'source', serverProposalId: 17, publicationApiBase: API_A, title: 'Original' };

        expect(Lineage.publishedOrigin(record, id => id === 'source' ? source : null)).toEqual({
            relation: 'revision',
            source: { kind: 'publication', apiBase: API_A, proposalRowId: '17' },
            title: 'Original'
        });
    });

    it('keeps a source with only a bare server row unknown in the portable relationship', () => {
        vi.stubGlobal('getBackendBase', () => API_B);
        const record = {
            proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: 'source' }, title: 'Source' }
        };
        expect(Lineage.publishedOrigin(record, () => ({ proposalId: 'source', serverProposalId: '17' })))
            .toEqual({ relation: 'copy', source: null, title: 'Source' });
    });

    it('keeps an unpublished local source unknown in the portable record', () => {
        const origin = { relation: 'copy', source: { kind: 'local', localProposalId: 'source' }, title: 'Draft' };
        expect(Lineage.publishedOrigin({ proposalOrigin: origin }, () => ({ proposalId: 'source' })))
            .toEqual({ ...origin, source: null });
    });
});

describe('localDerived and mergeDerived', () => {
    it('finds relationships through matching typed local and publication references', () => {
        const original = { proposalId: 'p-original', serverProposalId: '879', publicationApiBase: API_A, title: 'Original' };
        const localFork = {
            proposalId: 'p-local-fork',
            proposalOrigin: { relation: 'revision', source: { kind: 'local', localProposalId: 'p-original' }, title: 'Original' }
        };
        const publishedFork = {
            proposalId: 'p-published-fork', serverProposalId: '901', publicationApiBase: API_A,
            proposalOrigin: { relation: 'revision', source: { kind: 'publication', apiBase: API_A, proposalRowId: '879' }, title: 'Original' }
        };
        const unrelated = {
            proposalId: 'p-unrelated',
            proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: 'elsewhere' }, title: 'Elsewhere' }
        };
        expect(Lineage.localDerived(original, [original, localFork, publishedFork, unrelated]).map(record => record.proposalId))
            .toEqual(['p-local-fork', 'p-published-fork']);
    });

    it('does not equate local key 17 with publication row 17 or match another publication store', () => {
        const original = { proposalId: 'p-original', serverProposalId: '17', publicationApiBase: API_A };
        const localKey17 = { proposalId: '17', title: 'Independent local draft' };
        const localReferenceTo17 = {
            proposalId: 'local-reference',
            proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: '17' }, title: 'Draft 17' }
        };
        const wrongStoreReference = {
            proposalId: 'wrong-store',
            proposalOrigin: { relation: 'revision', source: { kind: 'publication', apiBase: API_B, proposalRowId: '17' }, title: 'Other store row 17' }
        };
        const correctPublicationReference = {
            proposalId: 'correct-store',
            proposalOrigin: { relation: 'revision', source: { kind: 'publication', apiBase: API_A, proposalRowId: '17' }, title: 'Original' }
        };

        expect(Lineage.localDerived(original, [original, localKey17, localReferenceTo17, wrongStoreReference]))
            .toEqual([]);
        expect(Lineage.localDerived(original, [original, wrongStoreReference, correctPublicationReference]))
            .toEqual([correctPublicationReference]);
    });

    it('lists published forks first and deduplicates copies only within the same publication store', () => {
        vi.stubGlobal('getBackendBase', () => API_A);
        const server = [{ proposalRowId: 901, publicationApiBase: API_A, title: 'Fork B', author: 'Owner C', status: 'Active', landFork: true }];
        const local = [
            { proposalId: 'p-a', title: 'Fork A', landFork: false },
            { proposalId: 'p-copy-a', serverProposalId: '901', publicationApiBase: API_A, title: 'Local copy' },
            { proposalId: 'p-copy-b', serverProposalId: '901', publicationApiBase: API_B, title: 'Other store row' }
        ];
        const merged = Lineage.mergeDerived(server, local, { backendBase: API_A });
        expect(merged.map(entry => [entry.proposalRowId, entry.localProposalId, entry.title, entry.published, entry.landFork]))
            .toEqual([
                ['901', undefined, 'Fork B', true, true],
                [undefined, 'p-a', 'Fork A', false, false],
                [undefined, 'p-copy-b', 'Other store row', true, false]
            ]);
    });

    it('keeps local keys separate from row IDs and requires valid row IDs for server entries', () => {
        const merged = Lineage.mergeDerived([{ authoredProposalId: 'p-no-row' }, { proposalRowId: 'invalid' }], [
            { proposalId: '42', serverProposalId: 'invalid' },
            { proposalId: 'p-independent' }
        ]);
        expect(merged.map(entry => [entry.proposalRowId, entry.localProposalId, entry.published])).toEqual([
            [undefined, '42', false], [undefined, 'p-independent', false]
        ]);
    });
});

describe('source presentation and publication evidence', () => {
    it.each(['external', 'unresolved', 'not-found'])('clears a stale local link for a %s source result', resolution => {
        let replacement = null;
        const staleLink = {
            textContent: 'Old local source',
            matches: selector => selector === '.proposal-based-on-link',
            replaceWith: node => { replacement = node; }
        };
        vi.stubGlobal('document', { createElement: () => ({ textContent: '', className: '' }) });
        vi.stubGlobal('getProposalI18nHelper', () => (key, fallback, params) => fallback.replace('{{name}}', params.name));
        const container = { querySelector: () => staleLink };

        Lineage.patchSourceRow(container, { resolution, reference: { kind: 'publication', apiBase: API_B, proposalRowId: '17' }, title: 'Source' });
        expect(replacement.className).toBe('proposal-based-on-name');
        expect(replacement.textContent).toContain('Source');
    });

    it('links only a source resolved to a row in the current publication store', () => {
        let replacement = null;
        const name = {
            textContent: 'Source', matches: () => false,
            replaceWith: node => { replacement = node; }
        };
        vi.stubGlobal('document', { createElement: () => ({ setAttribute(name, value) { this[name] = value; } }) });
        Lineage.patchSourceRow({ querySelector: () => name }, {
            resolution: 'resolved', reference: { kind: 'local', localProposalId: 'source' }, proposalRowId: '17', title: 'Source'
        });
        expect(replacement).toMatchObject({ className: 'cb-link proposal-based-on-link', textContent: 'Source', 'data-lineage-row-id': '17' });
    });

    it('requires qualified publication or mint evidence and ignores generic hash and lifecycle labels', () => {
        expect(Lineage.isPublished({ hash: 'abc', lifecycleStatus: 'published' })).toBe(false);
        expect(Lineage.isPublished({ serverProposalId: '17' })).toBe(false);
        expect(Lineage.isPublished({ serverProposalId: '17', publicationApiBase: API_A })).toBe(true);
        expect(Lineage.isPublished({ isMinted: true })).toBe(true);
    });

    it('preserves current origin, land fork and draft metadata on in-place edits', () => {
        const source = {
            proposalId: 'draft', createdAt: '2026-10-01',
            proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: 'source' }, title: 'Source' },
            landFork: { kind: 'overlap' }, proposalDraftId: 'draft-group', proposalDraftRevision: 3,
            authorAgentId: 'agent', lifecycleStatus: 'Draft', termsConfirmed: true
        };
        const out = Lineage.inPlaceRecord(source, { title: 'Edited' });
        expect(out).toMatchObject({
            proposalId: 'draft', createdAt: '2026-10-01', proposalOrigin: source.proposalOrigin,
            landFork: source.landFork, proposalDraftId: 'draft-group', proposalDraftRevision: 3,
            authorAgentId: 'agent', lifecycleStatus: 'Draft', termsConfirmed: true
        });
    });
});

describe('qualified lineage navigation', () => {
    it('opens only the explicit local copy of a server row', async () => {
        const published = { proposalId: 'p-published', serverProposalId: '42', publicationApiBase: API_A };
        const getProposal = vi.fn(() => ({ proposalId: '42', title: 'Unrelated draft' }));
        const getProposalByServerRowId = vi.fn(() => published);
        const openProposalFromList = vi.fn();
        vi.stubGlobal('proposalStorage', { getProposal, getProposalByServerRowId });
        vi.stubGlobal('getBackendBase', () => API_A);
        vi.stubGlobal('openProposalFromList', openProposalFromList);
        await Lineage.open({ proposalRowId: '42', publicationApiBase: API_A });
        expect(getProposal).not.toHaveBeenCalled();
        expect(getProposalByServerRowId).toHaveBeenCalledWith('42', API_A);
        expect(openProposalFromList).toHaveBeenCalledWith('p-published', expect.objectContaining({ proposal: published }));
    });

    it('imports a server row when no explicitly linked local copy exists', async () => {
        const published = { proposalId: 'p-imported', serverProposalId: '42', publicationApiBase: API_A };
        const importServerProposal = vi.fn(async () => published);
        const openProposalFromList = vi.fn();
        vi.stubGlobal('proposalStorage', { getProposalByServerRowId: () => null });
        vi.stubGlobal('importServerProposal', importServerProposal);
        vi.stubGlobal('openProposalFromList', openProposalFromList);
        vi.stubGlobal('getBackendBase', () => API_A);
        await Lineage.open({ proposalRowId: '42', publicationApiBase: API_A });
        expect(importServerProposal).toHaveBeenCalledWith('42');
        expect(openProposalFromList).toHaveBeenCalledWith('p-imported', expect.objectContaining({ proposal: published }));
    });

    it('does not open a bare publication row using the current backend as an inferred store', async () => {
        const importServerProposal = vi.fn();
        const openProposalFromList = vi.fn();
        vi.stubGlobal('proposalStorage', { getProposalByServerRowId: vi.fn() });
        vi.stubGlobal('getBackendBase', () => API_A);
        vi.stubGlobal('importServerProposal', importServerProposal);
        vi.stubGlobal('openProposalFromList', openProposalFromList);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await Lineage.open({ proposalRowId: '42' });
        expect(importServerProposal).not.toHaveBeenCalled();
        expect(openProposalFromList).not.toHaveBeenCalled();
    });

    it('never imports a missing local link or substitutes a row alias', async () => {
        const importServerProposal = vi.fn();
        const openProposalFromList = vi.fn();
        vi.stubGlobal('proposalStorage', { getProposal: () => ({ proposalId: 'p-row-copy', serverProposalId: '42' }) });
        vi.stubGlobal('importServerProposal', importServerProposal);
        vi.stubGlobal('openProposalFromList', openProposalFromList);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await Lineage.open({ localProposalId: '42' });
        expect(importServerProposal).not.toHaveBeenCalled();
        expect(openProposalFromList).not.toHaveBeenCalled();
    });
});
