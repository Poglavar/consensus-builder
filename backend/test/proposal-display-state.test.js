// One derivation of a proposal's displayed state (frontend/js/proposals/display-state.js): the ladder
// rung, Minted from a mint record only, and no "Applied" or map action for a cancelled proposal. A
// cancelled proposal (781 on the local stack) used to read Published + Applied with an Unapply button.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const displayState = require('../../frontend/js/proposals/display-state.js');
const { getSerialProposalId } = require('../../frontend/js/proposals/sharing.js');

const published = (extra = {}) => ({ proposalId: 'c2-uh980k1g32gls', serverProposalId: '781', ...extra });
const stateOf = (proposal, inputs = {}) => displayState.of(proposal, { lifecycleKey: undefined, serial: proposal.serverProposalId || null, ...inputs });

describe('proposal display state', () => {
    it('requires the production row-reference predicate before displaying Published', () => {
        for (const record of [{ proposalId: '42' }, { id: 42 }, { proposalId: 'p-local', serverProposalId: 'authored' }]) {
            expect(getSerialProposalId(record)).toBeNull();
            expect(displayState.of({ ...record, lifecycleStatus: 'Active' }, { serial: getSerialProposalId(record) }))
                .toMatchObject({ rung: 'draft', published: false });
        }
        for (const serverProposalId of [42, '42']) {
            const record = { proposalId: 'p-local', serverProposalId, lifecycleStatus: 'Active' };
            expect(getSerialProposalId(record)).toBe('42');
            expect(displayState.of(record, { serial: getSerialProposalId(record) })).toMatchObject({ rung: 'published', published: true });
        }
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
            .toMatchObject({ rung: 'executed', applied: true, modifier: null });
    });

    it('calls a numeric server serial Published, never Minted', () => {
        const serialOnly = { proposalId: '780', serverProposalId: '780', lifecycleStatus: 'Active' };
        expect(displayState.hasMintRecord(serialOnly)).toBe(false);
        expect(stateOf(serialOnly, { applied: false, lifecycleKey: 'active' })).toMatchObject({ rung: 'published', minted: false });
    });

    it('calls a proposal Minted only from a mint record, and keeps it Minted when cancelled', () => {
        expect(displayState.hasMintRecord(published({ isMinted: true }))).toBe(true);
        expect(displayState.hasMintRecord(published({ onchain: { transactionHash: '0xabc' } }))).toBe(true);
        expect(displayState.hasMintRecord(published({ nft: { contract: 'Prog', tokenId: 'Mint' } }))).toBe(true);
        expect(displayState.hasMintRecord(published({ onchain: { contractAddress: '0xc', proposalId: '7' } }))).toBe(true);
        expect(displayState.hasMintRecord(published({ isMinted: false, onchain: null, nft: null }))).toBe(false);

        const mintedCancelled = published({ lifecycleStatus: 'Cancelled', isMinted: true, onchain: { transactionHash: '0xabc' } });
        expect(stateOf(mintedCancelled, { applied: true, lifecycleKey: 'cancelled' }))
            .toMatchObject({ rung: 'minted', minted: true, applied: false, mapAction: null, modifier: 'cancelled' });
    });

    it('labels each rung through the translator it is given', () => {
        const seen = [];
        const label = displayState.rungLabel('minted', (key, fallback) => { seen.push(key); return `${fallback}!`; });
        expect(label).toBe('Minted!');
        expect(seen).toEqual(['panel.proposal.lifecycle.minted']);
        expect(displayState.rungLabel('nonsense')).toBe('Draft');
    });

    it('qualifies recorded execution without upgrading a mint reference to proof of realization', () => {
        for (const proposal of [{ lifecycleStatus: 'Executed' }, published({ lifecycleStatus: 'Executed', isMinted: true })]) {
            const { rung } = stateOf(proposal);
            expect(displayState.rungLabel(rung)).toBe('Execution recorded');
            expect(displayState.rungHint(rung)).toContain('does not verify payment, legal registration or physical construction');
        }
        expect(displayState.rungHint('published')).toBe('');
        expect(displayState.rungHint('executed', (key, fallback) => `${key}: ${fallback}`))
            .toContain('panel.proposal.lifecycle.executedHint: This record reports execution.');
    });

    it('displays awaiting funding as an open modifier without asserting owner acceptance', () => {
        expect(stateOf(published({ lifecycleStatus: 'Active', funded: false }), { lifecycleKey: 'awaiting-funding' }))
            .toMatchObject({ rung: 'published', modifier: 'awaiting-funding', modifierTone: 'cb-badge--published' });
    });
});
