// Share goes through the one publish step (proposal-kinds.md M2b): the real shareSingleProposal
// sends a local proposal whose terms were never chosen to the terms dialog first, which appends
// them to that same record, then shares it; a record with terms, or a published one, opens the
// share dialog at once.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url)), 'utf8');
const ProposalKind = require('../../frontend/js/proposals/proposal-kind.js');
const ProposalPublishTerms = require('../../frontend/js/proposals/publish-terms.js');
const API_BASE = 'https://api.example.test';

function load(records, rowCopies = [], currentProposalDetailsContext = null) {
    const shown = [];
    const openPublishTermsDialog = vi.fn();
    const store = new Map(records.map(record => [record.proposalId, record]));
    const getProposalByServerRowId = vi.fn((rowId, apiBase) => rowCopies.find(record =>
        String(record.serverProposalId) === String(rowId) && record.publicationApiBase === apiBase) || null);
    const window = {
        ProposalKind,
        ProposalPublishTerms,
        isPublishedProposalRecord: record => !!record.serverProposalId,
        openPublishTermsDialog
    };
    const context = createContext({
        window,
        console,
        guestPolicyBlocks: () => false,
        getProposalI18nHelper: () => (_key, fallback) => fallback,
        getShareI18nHelper: () => (_key, fallback) => fallback,
        getProposalKey: record => record.proposalId,
        currentProposalDetailsContext,
        proposalStorage: {
            getProposal: id => store.get(id) || null,
            getAllProposals: () => Array.from(store.values()),
            getProposalByServerRowId
        },
        resolveBackendBaseUrl: () => API_BASE,
        showUploadProposalModal: record => shown.push(record.proposalId),
        showEphemeralMessage: () => {}
    });
    runInContext(source, context, { filename: 'frontend/js/proposals/sharing-routes.js' });
    return { context, shown, openPublishTermsDialog, store, getProposalByServerRowId };
}

describe('Share and the publish step', () => {
    it('sends a quick drawing to the terms dialog, then shares that same record', () => {
        const { context, shown, openPublishTermsDialog, store } = load([{ proposalId: 'p-draft', goal: 'park' }]);
        context.shareSingleProposal('p-draft');
        expect(shown).toEqual([]);
        expect(openPublishTermsDialog).toHaveBeenCalledOnce();
        const [recordId, options] = openPublishTermsDialog.mock.calls[0];
        expect(recordId).toBe('p-draft');
        Object.assign(store.get('p-draft'), { kind: 'community-vote', termsConfirmed: true });
        options.afterSave('p-draft');
        expect(shown).toEqual(['p-draft']);
    });

    it('shares a record with chosen terms, or a published one, straight away', () => {
        const { context, shown, openPublishTermsDialog } = load([
            { proposalId: 'p-terms', kind: 'owner-deal', termsConfirmed: true },
            { proposalId: 'p-server', serverProposalId: '812' }
        ]);
        context.shareSingleProposal('p-terms');
        context.shareSingleProposal('p-server');
        expect(shown).toEqual(['p-terms', 'p-server']);
        expect(openPublishTermsDialog).not.toHaveBeenCalled();
    });

    it('resolves a publication row only in the current API and ignores generic id aliases', () => {
        const row = { proposalId: 'local-row-copy', serverProposalId: '99', publicationApiBase: API_BASE,
            kind: 'owner-deal', termsConfirmed: true };
        const { context, shown, getProposalByServerRowId } = load([
            { proposalId: 'local-alias', id: '99', kind: 'owner-deal', termsConfirmed: true }
        ], [row]);
        context.shareSingleProposal('99');
        expect(getProposalByServerRowId).toHaveBeenCalledWith('99', API_BASE);
        expect(shown).toEqual(['local-row-copy']);
    });

    it('does not resolve the same row number from another publication API', () => {
        const foreignRow = { proposalId: 'foreign-row-copy', serverProposalId: '99',
            publicationApiBase: 'https://other.example.test', kind: 'owner-deal', termsConfirmed: true };
        const { context, shown, getProposalByServerRowId } = load([], [foreignRow]);
        context.shareSingleProposal('99');
        expect(getProposalByServerRowId).toHaveBeenCalledWith('99', API_BASE);
        expect(shown).toEqual([]);
    });

    it('does not share a record merely because its generic id matches a requested row', () => {
        const { context, shown, getProposalByServerRowId } = load([
            { proposalId: 'local-alias', id: '99', kind: 'owner-deal', termsConfirmed: true }
        ]);
        context.shareSingleProposal('99');
        expect(getProposalByServerRowId).toHaveBeenCalledWith('99', API_BASE);
        expect(shown).toEqual([]);
    });

    it('does not treat a details-context generic id as a publication-row reference', () => {
        const contextProposal = { id: '99', kind: 'owner-deal', termsConfirmed: true };
        const { context, shown, getProposalByServerRowId } = load([], [], contextProposal);
        context.shareSingleProposal('99');
        expect(getProposalByServerRowId).toHaveBeenCalledWith('99', API_BASE);
        expect(shown).toEqual([]);
    });
});
