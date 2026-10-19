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

function load(records) {
    const shown = [];
    const openPublishTermsDialog = vi.fn();
    const store = new Map(records.map(record => [record.proposalId, record]));
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
        currentProposalDetailsContext: null,
        proposalStorage: { getProposal: id => store.get(id) || null, getAllProposals: () => Array.from(store.values()) },
        showUploadProposalModal: record => shown.push(record.proposalId),
        showEphemeralMessage: () => {}
    });
    runInContext(source, context, { filename: 'frontend/js/proposals/sharing-routes.js' });
    return { context, shown, openPublishTermsDialog, store };
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
});
