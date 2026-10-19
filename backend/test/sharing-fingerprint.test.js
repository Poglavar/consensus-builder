// Upload identity is geometry/content based; consent additionally binds flat cadastral targets.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let sharing;

const base = () => ({
    goal: 'road-track',
    offer: 1000,
    cadastreParcelIds: ['HR-1-824'],
    geometry: { type: 'Polygon', coordinates: [[[16, 45.8], [16.001, 45.8], [16.001, 45.801], [16, 45.8]]] },
    roadProposal: {
        definition: { width: 5, points: [{ lat: 45.8, lng: 16 }, { lat: 45.801, lng: 16.001 }] }
    }
});

beforeAll(() => {
    sharing = require('../../frontend/js/proposals/sharing.js');
});

describe('proposalContentFingerprint (v2, upload identity)', () => {
    it('is c2-prefixed and stable', () => {
        const a = sharing.proposalContentFingerprint(base());
        expect(a).toMatch(/^c2-/);
        expect(sharing.proposalContentFingerprint(base())).toBe(a);
    });

    it('does not silently normalize a retired nested parcel declaration', () => {
        const reference = sharing.proposalContentFingerprint(base());
        const churned = base();
        churned.parentParcelIds = ['HR-1-824#c-newgen-1', 'HR-1-823/1'];
        churned.roadProposal.parentParcelIds = ['HR-1-824#c-newgen-1'];
        expect(sharing.proposalContentFingerprint(churned)).not.toBe(reference);
    });

    it('commits the kind only when a record has one, so older records keep their fingerprints', () => {
        const reference = sharing.proposalContentFingerprint(base());
        expect(sharing.proposalContentFingerprint({ ...base(), kind: undefined })).toBe(reference);
        const deal = sharing.proposalContentFingerprint({ ...base(), kind: 'owner-deal' });
        const vote = sharing.proposalContentFingerprint({ ...base(), offer: null, kind: 'community-vote' });
        expect(deal).not.toBe(reference);
        expect(vote).not.toBe(deal);
    });

    it('moves when the content actually changes', () => {
        const wider = base();
        wider.roadProposal.definition.width = 7.5;
        expect(sharing.proposalContentFingerprint(wider)).not.toBe(sharing.proposalContentFingerprint(base()));
    });
});

describe('proposalConsentFingerprint', () => {
    it('binds configured approvals to full content and terms with SHA-256, excluding receipt state', () => {
        const original = { ...base(), approvalConfig: { schema: 'proposal-approval/v1', rights: null },
            lens: ['member-a'], expiresAt: '2027-01-01T00:00:00Z', depositPercent: 10 };
        const hash = sharing.proposalConsentFingerprint(original);
        expect(hash).toMatch(/^consent1-sha256:[a-f0-9]{64}$/);
        for (const changed of [
            { offer: 2000 }, { expiresAt: '2027-02-01T00:00:00Z' }, { depositPercent: 20 },
            { lens: ['member-b'] }, { facets: { ownership: 'public' } },
            { roadProposal: { definition: { ...original.roadProposal.definition, width: 12 } } }
        ]) expect(sharing.proposalConsentFingerprint({ ...original, ...changed })).not.toBe(hash);
        expect(sharing.proposalConsentFingerprint({ ...original,
            ownerApprovals: { 'owner-a': { effectHash: hash } }, acceptedParcelIds: ['HR-1-824'] })).toBe(hash);
    });

    it('is c-prefixed and moves with the cadastral scope (the consent-binding semantics)', () => {
        const a = sharing.proposalConsentFingerprint(base());
        expect(a).toMatch(/^c-/);
        const churned = base();
        churned.cadastreParcelIds = ['HR-1-999'];
        expect(sharing.proposalConsentFingerprint(churned)).not.toBe(a);
    });

    it('the two versions never collide in prefix space', () => {
        expect(sharing.proposalContentFingerprint(base()).startsWith('c2-')).toBe(true);
        expect(sharing.proposalConsentFingerprint(base()).startsWith('c2-')).toBe(false);
    });
});
