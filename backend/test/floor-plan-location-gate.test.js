// The relaxed source gate: any location signal keeps a posting; a neighbourhood-only ad does not.
import { beforeAll, describe, expect, it } from 'vitest';
import { eligibleListingSql, listingQualifies, qualifyPageEvidence } from '../floor-plans/source-policy.js';
import { zagrebStreetIndex } from '../floor-plans/site-candidates.js';

const listing = (extra = {}) => ({ assets: [], links: [], listing: { sourceId: '1', title: 'Novogradnja, Zagreb', ...extra } });
const page = body => `<html><body><main>${body}</main><footer>Agencija d.o.o., Ilica 1, Zagreb</footer></body></html>`;

beforeAll(async () => {
    await zagrebStreetIndex({ query: async () => ({ rows: [{ street_name: 'Avenija Marina Držića' }, { street_name: 'Ilica' }] }) });
});

describe('location signal gate', () => {
    it('keeps a new build that names its street but no house number', () => {
        const evidence = qualifyPageEvidence(page('<p>Zagreb, Trnje, Avenija Marina Držića, 20 stambenih jedinica.</p>'),
            'https://agency.test/novogradnja/1', listing());
        expect(evidence.listing.explicitLocation).toBeNull();
        expect(evidence.listing.locationSignals.streets).toMatchObject([{ street: 'Avenija Marina Držića', quote: 'Avenija Marina Držića' }]);
        expect(evidence.listing.hasLocationSignal).toBe(true);
        expect(listingQualifies(evidence.listing)).toBe(true);
    });

    it('keeps a posting with only a map pin or a cited permit', () => {
        const pinned = qualifyPageEvidence(page('<p>Stan u novogradnji.</p>'), 'https://agency.test/n/2', listing({ coordinates: { lat: 45.8, lng: 15.99 } }));
        expect(listingQualifies(pinned.listing)).toBe(true);
        const permit = qualifyPageEvidence(page('<p>Građevinska dozvola KLASA: UP/I-361-03/24-01/000607.</p>'), 'https://agency.test/n/3', listing());
        expect(permit.listing.locationSignals.klasa).toEqual(['UP/I-361-03/24-01/000607']);
        expect(listingQualifies(permit.listing)).toBe(true);
    });

    it('drops a neighbourhood-only ad, and the agency footer address does not count', () => {
        const evidence = qualifyPageEvidence(page('<p>Stan, Zagreb, Trešnjevka, 55 m2.</p>'), 'https://agency.test/n/4', listing());
        expect(evidence.listing.hasLocationSignal).toBe(false);
        expect(listingQualifies(evidence.listing)).toBe(false);
        expect(listingQualifies({ ...evidence.listing, hasLocationSignal: true, sourceEvidenceStatus: 'not-a-listing' })).toBe(false);
    });

    it('the eligibility SQL accepts the signal flag as an alternative to an explicit address', () => {
        expect(eligibleListingSql('l')).toMatch(/OR l\.facts->>'hasLocationSignal'='true'\)/);
    });
});
