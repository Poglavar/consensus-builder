// One derivation of a proposal's displayed state (frontend/js/proposals/display-state.js): the ladder
// rung, Published only while a design still hashes to the CID it was published as at this index
// (proposals/design-sync.js publishedCid), never Minted (designs are not minted,
// plan-design-agreement.md M3), and no "Applied" or map action for a cancelled proposal. A cancelled
// proposal (781 on the local stack) used to read Published + Applied with an Unapply button.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const displayState = require('../../frontend/js/proposals/display-state.js');
const { publishedCid } = require('../../frontend/js/proposals/design-sync.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const lifecycleEvidence = require('../../frontend/js/proposals/lifecycle-evidence.js');
const API = 'https://api.example';

const SITE = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]] };
const design = (extra = {}) => ({ proposalId: 'p-781', goal: 'park', title: 'Pocket park', site: SITE,
    createdAt: '2026-10-01T12:00:00.000Z', structureProposal: { kind: 'park', geometry: SITE }, ...extra });
// A design published at API: it carries the CID its content hashes to. Lifecycle and application
// fields are not content, so they leave the CID as it is.
const published = (extra = {}) => {
    const record = design(extra);
    return { ...record, published: { cid: DesignRecord.cidOf(record), publishedAt: '2026-10-02T08:00:00.000Z', apiBase: API } };
};
const stateOf = (proposal, inputs = {}) => displayState.of(proposal, { lifecycleKey: undefined, serial: publishedCid(proposal, API), ...inputs });
const observedExecuted = () => lifecycleEvidence.projectLifecycleEvidence({
    lifecycleStatus: 'Executed',
    chainRead: {
        status: 'Executed', observedAt: '2026-10-19T12:00:00.000Z',
        chainRef: { chainType: 'solana', chainId: 'solana-devnet', contract: 'program', tokenId: '7' }
    }
});

afterEach(() => vi.unstubAllGlobals());

describe('proposal display state', () => {
    it('displays Published only while the design still hashes to the CID it was published as at this index', () => {
        const record = published({ lifecycleStatus: 'Active' });
        expect(publishedCid(record, API)).toBe(record.published.cid);
        expect(displayState.of(record, { serial: publishedCid(record, API) })).toMatchObject({ rung: 'published', published: true });
        for (const draft of [
            design({ lifecycleStatus: 'Active' }),
            // Edited in place after publishing: another design than the one published.
            { ...record, title: 'Pocket park, wider' },
            // Published to another index.
            { ...record, published: { ...record.published, apiBase: 'https://elsewhere.example' } },
            { ...record, published: { ...record.published, cid: 'not-a-cid' } },
            // A server row number is no publication.
            design({ lifecycleStatus: 'Active', serverProposalId: '781', publicationApiBase: API }),
            // Nor is a mint record, and it is no rung of its own: designs are not minted (M3).
            design({ lifecycleStatus: 'Active', isMinted: true, onchain: { transactionHash: '0xabc' }, nft: { contract: 'Prog', tokenId: 'Mint' } })
        ]) {
            expect(publishedCid(draft, API)).toBeNull();
            expect(displayState.of(draft, { serial: publishedCid(draft, API) })).toMatchObject({ rung: 'draft', published: false });
        }
    });

    it('reads the published CID from window.DesignSync when the caller passes none', () => {
        const record = published({ lifecycleStatus: 'Active' });
        expect(displayState.of(record, { lifecycleKey: 'active' })).toMatchObject({ rung: 'draft', published: false });
        const ask = vi.fn(proposal => publishedCid(proposal, API));
        vi.stubGlobal('DesignSync', { publishedCid: ask });
        expect(displayState.of(record, { lifecycleKey: 'active' })).toMatchObject({ rung: 'published', published: true });
        expect(ask).toHaveBeenCalledWith(record);
    });

    it('shows unavailable lifecycle without inferring it from publication or map application', () => {
        expect(stateOf(published({ applied: true }), { applied: true }))
            .toMatchObject({ lifecycle: 'Unknown', rung: 'published', modifier: 'unknown', applied: true, mapAction: 'unapply' });
    });
    it('shows a cancelled proposal applied in this browser as neither Applied nor unappliable', () => {
        const state = stateOf(published({ lifecycleStatus: 'Cancelled', applied: true }), { applied: true, lifecycleKey: 'cancelled' });
        expect(state).toMatchObject({
            lifecycle: 'Cancelled',
            rung: 'published',
            applied: false,
            mapAction: null,
            modifier: 'cancelled',
            modifierTone: 'cb-badge--expired'
        });
        expect(displayState.isApplicable(published({ lifecycleStatus: 'Cancelled' }))).toBe(false);
    });

    it('keeps Applied and Unapply for an active applied proposal, Apply for an unapplied one', () => {
        expect(stateOf(published({ lifecycleStatus: 'Active' }), { applied: true, lifecycleKey: 'active' }))
            .toMatchObject({ applied: true, mapAction: 'unapply', modifier: null, rung: 'published' });
        expect(stateOf(published({ lifecycleStatus: 'Active' }), { applied: false, lifecycleKey: 'active' }))
            .toMatchObject({ applied: false, mapAction: 'apply' });
        expect(displayState.isApplicable(published({ lifecycleStatus: 'Active' }))).toBe(true);
    });

    it('reads an expired or executed proposal as still applicable, with its own modifier', () => {
        expect(stateOf(published({ lifecycleStatus: 'Expired' }), { applied: true, lifecycleKey: 'expired' }))
            .toMatchObject({ applied: true, mapAction: 'unapply', modifier: 'expired' });
        expect(stateOf(published({ lifecycleStatus: 'Executed' }), { applied: true, lifecycleKey: 'executed' }))
            .toMatchObject({ rung: 'execution-unverified', applied: true, modifier: null });
    });

    it('labels each rung through the translator it is given', () => {
        const seen = [];
        const label = displayState.rungLabel('published', (key, fallback) => { seen.push(key); return `${fallback}!`; });
        expect(label).toBe('Published!');
        expect(seen).toEqual(['common.lifecycle.published']);
        expect(displayState.rungLabel('execution-unverified', (key, fallback) => `${key}: ${fallback}`))
            .toBe('panel.proposal.lifecycle.executionUnverified: Execution reported; verification unavailable');
        expect(displayState.rungLabel('nonsense')).toBe('Draft');
    });

    it('qualifies recorded execution without upgrading it to proof of realization', () => {
        const claimed = { lifecycleStatus: 'Executed' };
        const invalidEvidence = published({
            lifecycleStatus: 'Executed',
            lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'observed', status: 'Cancelled', observedAt: '2026-10-19T12:00:00.000Z' }
        });
        for (const proposal of [claimed, invalidEvidence, published({ lifecycleStatus: 'Executed' })]) {
            const { rung } = stateOf(proposal);
            expect(rung).toBe('execution-unverified');
            expect(displayState.rungLabel(rung)).toBe('Execution reported; verification unavailable');
            expect(displayState.rungHint(rung)).toContain('does not verify payment, legal registration or physical construction');
        }
        const observed = observedExecuted();
        expect(observed.lifecycleEvidence.state).toBe('observed');
        expect(stateOf(published({ ...observed })).rung).toBe('executed');
        expect(stateOf(published({ ...observed }), { lifecycleKey: 'execution-unverified' }).rung).toBe('executed');
        expect(displayState.rungHint('published')).toBe('');
        expect(displayState.rungHint('executed', (key, fallback) => `${key}: ${fallback}`))
            .toContain('panel.proposal.lifecycle.executedHint: This record reports execution.');
    });

    it('displays awaiting funding as an open modifier without asserting owner acceptance', () => {
        expect(stateOf(published({ lifecycleStatus: 'Active', funded: false }), { lifecycleKey: 'awaiting-funding' }))
            .toMatchObject({ rung: 'published', modifier: 'awaiting-funding', modifierTone: 'cb-badge--published' });
    });
});
