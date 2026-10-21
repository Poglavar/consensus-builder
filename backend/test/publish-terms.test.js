// Unit tests for frontend/js/proposals/publish-terms.js: one builder turns a kind and its terms
// into record fields for every publish path (proposal-kinds.md).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publishFields, voteDays } = require('../../frontend/js/proposals/publish-terms.js');
const NOW = Date.UTC(2026, 9, 17);

describe('authoredOffer', () => {
    const { authoredOffer } = require('../../frontend/js/proposals/publish-terms.js');

    it('requires explicit numeric consideration and currency, preserving zero', () => {
        expect(authoredOffer({ offer: 0, offerCurrency: ' eur ' })).toEqual({ amount: 0, currency: 'EUR' });
        expect(authoredOffer({ kind: 'owner-deal', offer: 1500.25, offerCurrency: 'USDC', decayEnabled: true, decayPercent: 50 }))
            .toEqual({ amount: 1500.25, currency: 'USDC' });
        for (const offer of [null, undefined, '', '100', true, -1, Infinity, NaN]) {
            expect(authoredOffer({ offer, offerCurrency: 'EUR' })).toBeNull();
        }
        for (const offerCurrency of [null, undefined, '', ' ', 123]) {
            expect(authoredOffer({ offer: 100, offerCurrency })).toBeNull();
        }
    });

    it('never substitutes budgets, atomic balances, generic currencies or vote money', () => {
        for (const record of [null, {}, { budget: 100, budgetCurrency: 'EUR' },
            { ethBalance: 1e18, tokenBalance: 1e6, currency: 'USDC' },
            { offer: 100, currency: 'EUR' }, { offer: 100, budgetCurrency: 'EUR' },
            ...['owner-vote', 'community-vote', 'unknown'].map(kind => ({ kind, offer: 100, offerCurrency: 'EUR' }))]) {
            expect(authoredOffer(record)).toBeNull();
        }
    });
});

describe('publishFields', () => {
    it('displays only explicit, consistent payout terms for a positive binding offer', () => {
        const { payoutMode } = require('../../frontend/js/proposals/publish-terms.js');
        for (const record of [{}, { offer: null, isConditional: false }, { offer: true, isConditional: true },
            { kind: 'other', offer: 100, isConditional: true }, { offer: 0, disbursementMode: 'partial' },
            { offer: 100 }, { offer: 100, isConditional: 'true' }, { offer: 100, disbursementMode: 'other' },
            { offer: 100, disbursementMode: 'partial', isConditional: true },
            { kind: 'owner-vote', offer: 100, isConditional: true },
            { kind: 'community-vote', offer: 100, isConditional: false }]) expect(payoutMode(record)).toBeNull();
        expect(payoutMode({ offer: 100, isConditional: true })).toBe('conditional');
        expect(payoutMode({ offer: '100', disbursementMode: 'partial' })).toBe('partial');
        expect(payoutMode({ offer: 100, isConditional: false })).toBe('partial');
        expect(payoutMode({ offer: 100, isConditional: true, disbursementMode: 'conditional' })).toBe('conditional');
    });

    it('gives a vote no money and a deadline in whole days', () => {
        for (const kind of ['owner-vote', 'community-vote']) {
            const fields = publishFields({ kind, offer: 5000, depositEnabled: true, decayEnabled: true, isConditional: true, voteExpiryDays: 30 }, { now: NOW });
            expect(fields).toMatchObject({
                kind, offer: null, budget: null, isConditional: false, disbursementMode: null,
                decayEnabled: false, depositEnabled: false, voteExpiryDays: 30,
                expiresAt: new Date(NOW + 30 * 86400000).toISOString()
            });
        }
    });

    it('runs a vote for the full year when no period, or too long a period, is given', () => {
        expect(voteDays(undefined)).toBe(365);
        expect(voteDays(0)).toBe(365);
        expect(voteDays(900)).toBe(365);
        expect(voteDays('14')).toBe(14);
    });

    it('keeps an owner deal\'s money terms, clamped to their ranges', () => {
        const fields = publishFields({
            kind: 'owner-deal', offer: '2500', offerCurrency: 'EUR', isConditional: true, expiresAt: '2027-01-01T00:00:00.000Z',
            decayEnabled: true, decayPercent: 400, decayDurationMs: 60000, depositEnabled: true, depositPercent: 1
        }, { now: NOW });
        expect(fields).toEqual({
            kind: 'owner-deal', offer: 2500, budget: 2500, offerCurrency: 'EUR', budgetCurrency: 'EUR',
            isConditional: true, disbursementMode: 'conditional', expiresAt: '2027-01-01T00:00:00.000Z',
            decayEnabled: true, decayPercent: 100, decayDurationMs: 60000, depositEnabled: true, depositPercent: 10
        });
    });

    it('writes no kind for a local draft and never invents an offer', () => {
        const fields = publishFields({}, { now: NOW });
        expect(fields).not.toHaveProperty('kind');
        expect(fields.offer).toBe(0);
        expect(fields.expiresAt).toBe(null);
    });

    it('confirms a local record under the plan\'s kind, keeping a deal\'s own money and a sale offer a deal', () => {
        const { confirmedRecordFields, needsTerms } = require('../../frontend/js/proposals/publish-terms.js');
        expect(confirmedRecordFields({ offer: 900, offerCurrency: 'EUR' }, 'community-vote', { now: NOW }))
            .toMatchObject({ kind: 'community-vote', offer: null, voteExpiryDays: 365, termsConfirmed: true });
        expect(confirmedRecordFields({ offer: 900, offerCurrency: 'EUR' }, 'owner-deal', { now: NOW }))
            .toMatchObject({ kind: 'owner-deal', offer: 900, offerCurrency: 'EUR', termsConfirmed: true });
        expect(confirmedRecordFields({ goal: 'ownership-transfer-from-me', offer: 50 }, 'community-vote', { now: NOW }).kind).toBe('owner-deal');
        expect(needsTerms({})).toBe(true);
        expect(needsTerms({ termsConfirmed: true })).toBe(false);
        expect(needsTerms({ serverProposalId: '9' }, { isPublished: r => !!r.serverProposalId })).toBe(false);
    });

    it('starts a fork from the kind its source was chosen under', () => {
        const { chosenKind } = require('../../frontend/js/proposals/publish-terms.js');
        const isPublished = r => !!r.serverProposalId;
        expect(chosenKind({ kind: 'owner-vote' })).toBe('owner-vote');
        // A published record from before kinds reads as an owner deal; a local drawing chose nothing.
        expect(chosenKind({ serverProposalId: '9', offer: 100 }, { isPublished })).toBe('owner-deal');
        expect(chosenKind({ termsConfirmed: true })).toBe('owner-deal');
        expect(chosenKind({ goal: 'park', offer: 0 }, { isPublished })).toBe(null);
        expect(chosenKind(null)).toBe(null);
    });

    it('gives a record an approval setup only where owners decide by one', () => {
        const { approvalSetupFor } = require('../../frontend/js/proposals/publish-terms.js');
        const set = { schema: 'proposal-approval/v1', rights: { parcels: [] }, policy: { type: 'unanimous' } };
        expect(approvalSetupFor({ kind: 'owner-deal' })).toBe(null);
        expect(approvalSetupFor({ kind: 'owner-deal', approvalConfig: set })).toBe(set);
        expect(approvalSetupFor({ kind: 'owner-vote', approvalConfig: set })).toBe(set);
        expect(approvalSetupFor({ kind: 'community-vote', approvalConfig: set })).toBe(null);
        // No goal forces a default setup any more: a parcel layout carries none of its own.
        expect(approvalSetupFor({ kind: null })).toBe(null);
    });

    it('refuses to publish a parcel layout, which leaves the device with its agreement', () => {
        const { publishRefusal, assertPublishable } = require('../../frontend/js/proposals/publish-terms.js');
        const layout = { goal: 'parcel-layout', parcelLayout: { plots: [] } };
        expect(publishRefusal(layout)).toEqual({
            code: 'parcel-layout-publish-later',
            message: 'Parcel layouts are shared together with their agreement. Coming soon.'
        });
        expect(() => assertPublishable(layout)).toThrow(/shared together with their agreement/);
        expect(publishRefusal({ goal: 'park' })).toBe(null);
        expect(publishRefusal(null)).toBe(null);
        expect(() => assertPublishable({ goal: 'road-track' })).not.toThrow();
    });

    it('appends terms to an existing record without touching its design', () => {
        const { termsInPlace } = require('../../frontend/js/proposals/publish-terms.js');
        const drawing = { proposalId: 'p1', goal: 'park', structureProposal: { kind: 'park' }, approvalConfig: { rights: null } };
        const vote = termsInPlace(drawing, { kind: 'community-vote', offer: 900, voteExpiryDays: 30 }, { name: 'Pocket park', description: 'd', author: 'A', now: NOW });
        expect(vote).toMatchObject({ kind: 'community-vote', offer: null, voteExpiryDays: 30, title: 'Pocket park', author: 'A', termsConfirmed: true, approvalConfig: null });
        expect(vote).not.toHaveProperty('structureProposal');
        const deal = termsInPlace(drawing, { kind: 'owner-deal', offer: 0.5, offerCurrency: 'ETH' }, { name: 'n', now: NOW });
        expect(deal).toMatchObject({ kind: 'owner-deal', offer: 0.5, offerCurrency: 'ETH', approvalConfig: { rights: null } });
        // An owner's sale offer stays a deal whatever the dialog said.
        expect(termsInPlace({ goal: 'ownership-transfer-from-me' }, { kind: 'community-vote', offer: 10 }, { now: NOW }).kind).toBe('owner-deal');
    });

    it('refuses a vote for an owner\'s sale offer, and an unknown kind', () => {
        expect(() => publishFields({ kind: 'community-vote' }, { saleOffer: true })).toThrow(/owner deal/);
        expect(publishFields({ kind: 'owner-deal', offer: 10 }, { saleOffer: true }).kind).toBe('owner-deal');
        expect(() => publishFields({ kind: 'petition' })).toThrow(/Unknown proposal kind/);
    });
});
