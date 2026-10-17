// Unit tests for frontend/js/proposals/publish-terms.js: one builder turns a kind and its terms
// into record fields for every publish path (proposal-kinds.md).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publishFields, voteDays } = require('../../frontend/js/proposals/publish-terms.js');
const NOW = Date.UTC(2026, 9, 17);

describe('publishFields', () => {
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
        const unset = { schema: 'proposal-approval/v1', rights: null, policy: { type: 'unanimous' } };
        expect(approvalSetupFor({ kind: 'owner-deal', fromDraft: true })).toBe(null);
        expect(approvalSetupFor({ kind: 'owner-deal', approvalConfig: set, fromDraft: true })).toBe(set);
        expect(approvalSetupFor({ kind: 'owner-vote', approvalConfig: set })).toBe(set);
        expect(approvalSetupFor({ kind: 'community-vote', approvalConfig: set, fromDraft: true })).toBe(null);
        expect(approvalSetupFor({ kind: 'community-vote', readjustment: true, fromDraft: true })).toEqual(unset);
        expect(approvalSetupFor({ kind: 'owner-deal', readjustment: true, approvalConfig: set })).toBe(set);
        expect(approvalSetupFor({ kind: 'owner-deal', readjustment: true })).toBe(null);
    });

    it('refuses a vote for an owner\'s sale offer, and an unknown kind', () => {
        expect(() => publishFields({ kind: 'community-vote' }, { saleOffer: true })).toThrow(/owner deal/);
        expect(publishFields({ kind: 'owner-deal', offer: 10 }, { saleOffer: true }).kind).toBe('owner-deal');
        expect(() => publishFields({ kind: 'petition' })).toThrow(/Unknown proposal kind/);
    });
});
