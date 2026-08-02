// The two proposal-content fingerprints (sharing.js): v2 `c2-` is the upload identity and must be
// blind to parent-parcel lists everywhere (top level AND inside typology payloads) — derived-name
// churn must not move a share id; v1 `c-` (legacy) still hashes them, byte-compatible with every
// id already on the server, and is what content-only consent binds to (an offer's parcel targets
// are part of its terms).

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

describe('proposalContentFingerprintLegacy (v1)', () => {
    it('is c-prefixed and DOES move with the parent lists (the consent-binding semantics)', () => {
        const a = sharing.proposalContentFingerprintLegacy(base());
        expect(a).toMatch(/^c-/);
        const churned = base();
        churned.parentParcelIds = ['HR-1-999'];
        expect(sharing.proposalContentFingerprintLegacy(churned)).not.toBe(a);
    });

    it('the two versions never collide in prefix space', () => {
        expect(sharing.proposalContentFingerprint(base()).startsWith('c2-')).toBe(true);
        expect(sharing.proposalContentFingerprintLegacy(base()).startsWith('c2-')).toBe(false);
    });
});
