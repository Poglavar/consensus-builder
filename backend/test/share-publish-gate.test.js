// Share goes through the one publish step (proposal-kinds.md M2b): the real shareSingleProposal
// sends a local proposal whose terms were never chosen to the create dialog first and shares the
// record that dialog saves; a record with terms, or a published one, opens the share dialog at once.
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
    const proposeExistingProposal = vi.fn();
    const store = new Map(records.map(record => [record.proposalId, record]));
    const window = {
        ProposalKind,
        ProposalPublishTerms,
        isPublishedProposalRecord: record => !!record.serverProposalId,
        proposeExistingProposal
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
    return { context, shown, proposeExistingProposal, store };
}

describe('Share and the publish step', () => {
    it('sends a quick drawing to the create dialog, then shares what it saved', () => {
        const { context, shown, proposeExistingProposal, store } = load([{ proposalId: 'p-draft', goal: 'park' }]);
        context.shareSingleProposal('p-draft');
        expect(shown).toEqual([]);
        expect(proposeExistingProposal).toHaveBeenCalledOnce();
        const [sourceId, options] = proposeExistingProposal.mock.calls[0];
        expect(sourceId).toBe('p-draft');
        store.set('p-saved', { proposalId: 'p-saved', kind: 'community-vote', termsConfirmed: true });
        options.afterCreate('p-saved');
        expect(shown).toEqual(['p-saved']);
    });

    it('shares a record with chosen terms, or a published one, straight away', () => {
        const { context, shown, proposeExistingProposal } = load([
            { proposalId: 'p-terms', kind: 'owner-deal', termsConfirmed: true },
            { proposalId: 'p-server', serverProposalId: '812' }
        ]);
        context.shareSingleProposal('p-terms');
        context.shareSingleProposal('p-server');
        expect(shown).toEqual(['p-terms', 'p-server']);
        expect(proposeExistingProposal).not.toHaveBeenCalled();
    });
});
