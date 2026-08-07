// Upload identity is geometry/content based; consent additionally binds flat cadastral targets.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let sharing;

const base = () => ({
    goal: 'road-track',
    offer: 1000,
    parentParcelIds: ['HR-1-824#p-old-2'],
    geometry: { type: 'Polygon', coordinates: [[[16, 45.8], [16.001, 45.8], [16.001, 45.801], [16, 45.8]]] },
    roadProposal: {
        definition: { width: 5, points: [{ lat: 45.8, lng: 16 }, { lat: 45.801, lng: 16.001 }] },
        parentParcelIds: ['HR-1-824#p-old-2']
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

    it('does not move when parent lists churn — top level or nested', () => {
        const reference = sharing.proposalContentFingerprint(base());
        const churned = base();
        churned.parentParcelIds = ['HR-1-824#c-newgen-1', 'HR-1-823/1'];
        churned.roadProposal.parentParcelIds = ['HR-1-824#c-newgen-1'];
        expect(sharing.proposalContentFingerprint(churned)).toBe(reference);
    });

    it('moves when the content actually changes', () => {
        const wider = base();
        wider.roadProposal.definition.width = 7.5;
        expect(sharing.proposalContentFingerprint(wider)).not.toBe(sharing.proposalContentFingerprint(base()));
    });
});

describe('proposalConsentFingerprint', () => {
    it('is c-prefixed and DOES move with the parent lists (the consent-binding semantics)', () => {
        const a = sharing.proposalConsentFingerprint(base());
        expect(a).toMatch(/^c-/);
        const churned = base();
        churned.parentParcelIds = ['HR-1-999'];
        expect(sharing.proposalConsentFingerprint(churned)).not.toBe(a);
    });

    it('the two versions never collide in prefix space', () => {
        expect(sharing.proposalContentFingerprint(base()).startsWith('c2-')).toBe(true);
        expect(sharing.proposalConsentFingerprint(base()).startsWith('c2-')).toBe(false);
    });
});
