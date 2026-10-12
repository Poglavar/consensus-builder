// Heuristic site scoring: agreeing clues add up, contradictions subtract, close calls stay open.
import { describe, expect, it } from 'vitest';
import { houseNumberOf, rankSites, sameStreet, scoreCandidate } from '../floor-plans/site-scoring.js';

const observedAt = Date.parse('2026-10-12');
const avenueVPermit = { caseId: 'P20240414-1500597-Z01', klasa: 'UP/I-361-03/24-01/000607', kind: 'Građevinska dozvola',
    works: 'građenje zgrade', use: 'mješovite namjene (stambeno poslovna)', finalOn: '2024-07-31', streets: ['Strojarska cesta 19'] };
const officePermit = { caseId: 'P20220719-893128-Z01', kind: 'Građevinska dozvola', works: 'građenje zgrade',
    use: 'poslovne namjene', finalOn: '2022-09-22', streets: ['Ulica grada Vukovara 49'] };
const roadPermit = { caseId: 'P20221230-1007187-Z01', kind: 'Građevinska dozvola', works: null, worksDetail: 'javna rasvjeta u prometnici',
    finalOn: '2022-08-17', streets: ['Strojarska cesta'] };
const newBuildAd = { addresses: [], streets: [{ street: 'Strojarska cesta' }, { street: 'Ulica grada Vukovara' }], pin: { lat: 45.8011, lng: 15.9888 },
    klasa: [], parcels: [], units: null, newBuild: true };

describe('street and number helpers', () => {
    it('treats inflected and abbreviated forms of one street as the same street', () => {
        expect(sameStreet('Strojarska cesta 19', 'Strojarska')).toBe(true);
        // Colloquial "Vukovarska" is Ulica grada Vukovara; Ilica and Ilirski trg are different places.
        expect(sameStreet('Ulica grada Vukovara 49', 'Vukovarska')).toBe(true);
        expect(sameStreet('Ilica 10', 'Ilirski trg')).toBe(false);
        expect(sameStreet('Savska cesta 41', 'Strojarska')).toBe(false);
        expect(sameStreet('Jurišićeva ulica 26', 'Jurišićevoj ulici')).toBe(true);
        expect(houseNumberOf('Strojarska cesta 19, Zagreb')).toBe('19');
        expect(houseNumberOf('Ilica 10/1')).toBe('10/1');
    });
});

describe('site scoring', () => {
    it('places Avenue V on the residential new-build permit, not the office next door or the road works', () => {
        const result = rankSites([
            { id: 'avenue-v', permits: [avenueVPermit], pinDistanceM: 64 },
            { id: 'office', permits: [officePermit], pinDistanceM: 230 },
            { id: 'road', permits: [roadPermit], pinDistanceM: 120 },
        ], newBuildAd, { observedAt });
        expect(result.ranked[0].id).toBe('avenue-v');
        expect(result.ranked.at(-1).id).toBe('road');
        expect(result.ranked[0].reasons.map(r => r.code)).toEqual(
            expect.arrayContaining(['permit-street', 'pin-close', 'recent-building-permit', 'residential-use']));
        expect(['probable', 'located']).toContain(result.status);
    });

    it('reads a labelled street and a district like a local: Roots on Držićeva, not the nearby Radnička', () => {
        const signals = { addresses: [], streets: [{ street: 'Avenija Marina Držića', basis: 'address-label' }], nearbyStreets: [{ street: 'Radnička cesta' }],
            titleText: 'zagreb, trnje, avenija marina drzica', klasa: [], parcels: [], units: 20, newBuild: true };
        const drzic = { id: 'd', parcels: [{ kc: '272', koName: 'Trnje' }], permits: [{ caseId: 'P1', kind: 'Građevinska dozvola', works: null,
            use: 'stambene namjene', finalOn: '2023-01-03', streets: ['AVENIJA MARINA DRŽIĆA 21'] }] };
        const radnicka = { id: 'r', parcels: [{ kc: '1', koName: 'Peščenica' }], permits: [{ caseId: 'P2', kind: 'Građevinska dozvola', works: 'građenje zgrade',
            use: 'poslovne namjene', finalOn: '2024-01-01', streets: ['Radnička cesta 173V'] }] };
        const result = rankSites([radnicka, drzic], signals, { observedAt });
        expect(result.ranked[0].id).toBe('d');
        expect(result.ranked[0].reasons.map(r => r.code)).toEqual(expect.arrayContaining(['permit-street-stated', 'district', 'recent-building-permit']));
    });

    it('a cited KLASA or parcel decides on its own', () => {
        const signals = { ...newBuildAd, klasa: ['UP/I-361-03/24-01/000607'] };
        expect(scoreCandidate({ id: 'a', permits: [avenueVPermit] }, signals, { observedAt }).score).toBeGreaterThanOrEqual(0.9);
        const parcel = scoreCandidate({ id: 'b', parcels: [{ kc: '381/1' }] }, { ...newBuildAd, parcels: ['381/1'] }, { observedAt });
        expect(parcel.reasons.map(r => r.code)).toContain('parcel');
    });

    it('an exact official address point outweighs a pin alone, and a variant counts less', () => {
        const signals = { addresses: [{ street: 'Ilica', number: '10/1' }], streets: [], klasa: [], parcels: [], newBuild: false };
        const exact = scoreCandidate({ id: 'x', addressPoints: [{ matchKind: 'exact', street: 'Ilica', number: '10/1' }] }, signals);
        const variant = scoreCandidate({ id: 'y', addressPoints: [{ matchKind: 'base', street: 'Ilica', number: '10' }] }, signals);
        const pinOnly = scoreCandidate({ id: 'z', pinDistanceM: 3 }, signals);
        expect(exact.score).toBeGreaterThan(variant.score);
        expect(variant.score).toBeGreaterThan(pinOnly.score);
        const field = scoreCandidate({ id: 'f', addressPoints: [{ matchKind: 'exact', basis: 'explicit-location', street: 'Ilica', number: '10/1' }] }, signals);
        expect(field.score).toBeGreaterThan(exact.score);
        expect(rankSites([{ id: 'f', addressPoints: [{ matchKind: 'exact', basis: 'explicit-location' }] },
            { id: 'v', addressPoints: [{ matchKind: 'base' }] }], signals).status).toBe('located');
    });

    it('prefers the address point in the settlement the posting names', () => {
        const signals = { addresses: [{ street: 'Preradovićeva', number: '11' }], streets: [], klasa: [], parcels: [], newBuild: false, locality: 'Zagreb' };
        const result = rankSites([
            { id: 'sesvete', addressPoints: [{ matchKind: 'exact', basis: 'explicit-location', street: 'Ulica Petra Preradovića', number: '11', settlement: 'Sesvete' }] },
            { id: 'centre', addressPoints: [{ matchKind: 'exact', basis: 'explicit-location', street: 'Preradovićeva ulica', number: '11', settlement: 'Zagreb' }] },
        ], signals);
        expect(result.ranked[0].id).toBe('centre');
        expect(result.status).toBe('located');
    });

    it('counts one address match per site: an exact point is not topped up by a variant of the same address', () => {
        const signals = { addresses: [{ street: 'Ilica', number: '10/1' }], streets: [], klasa: [], parcels: [], newBuild: false };
        const both = scoreCandidate({ id: 'b', addressPoints: [{ matchKind: 'exact', street: 'Ilica', number: '10/1' }, { matchKind: 'base', street: 'Ilica', number: '10' }] }, signals);
        expect(both.reasons.map(r => r.code)).toEqual(['address-point']);
    });

    it('two equally supported sites are a close call for the adjudicator, not a pick', () => {
        const result = rankSites([{ id: 'a', pinDistanceM: 20, permits: [avenueVPermit] }, { id: 'b', pinDistanceM: 25, permits: [avenueVPermit] }],
            newBuildAd, { observedAt });
        expect(result.status).toBe('ambiguous');
    });

    it('matching unit counts add weight; nothing at all leaves the posting unresolved', () => {
        const withUnits = scoreCandidate({ id: 'a', permits: [{ ...avenueVPermit, units: 74 }] }, { ...newBuildAd, units: 74 }, { observedAt });
        expect(withUnits.reasons.map(r => r.code)).toContain('units');
        expect(rankSites([], newBuildAd).status).toBe('unresolved');
    });
});

describe('street types', () => {
    it('treats a different stated street type as a different street', () => {
        expect(sameStreet('Ulica kneza Branimira 8', 'Obala kneza Branimira')).toBe(false);
        expect(sameStreet('Odranska ulica BB', 'Odranska zavrtnica')).toBe(false);
        expect(sameStreet('Jarunski odvojak 3', 'Jarunska ulica')).toBe(false);
        expect(sameStreet('Strojarska cesta 19', 'Strojarska')).toBe(true);
        expect(sameStreet('Ulica grada Vukovara 49', 'Vukovarska')).toBe(true);
    });
});
