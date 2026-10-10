// A new publication's city follows its site, never the view it was drawn in (projections.md §10 M8,
// proposals/publication-city.js). Real coverage (frontend/data/world-coverage.json) and the real
// source catalogue: a Zagreb street drawn while New York is loaded must not be bound against New
// York's cadastre, an explore site in a live city must not be bound as open ground, and a Split site
// drawn from Zagreb's view (one countrywide cadastre) is Split's.
import { describe, it, expect, vi } from 'vitest';
import { resolvePublicationCity, sharesCadastre, SITE_IN_OTHER_CITY } from '../proposals/publication-city.js';
import { checkProposalBinding, publicationCityOf, BINDING_CODES } from '../proposals/binding.js';

const AT = {
    zagreb: { lat: 45.8131, lon: 15.9775 },
    split: { lat: 43.5081, lon: 16.4402 },
    osijek: { lat: 45.5550, lon: 18.6955 }, // Croatia, beyond every city's own area
    manhattan: { lat: 40.7580, lon: -73.9855 },
    oakland: { lat: 37.7461, lon: -122.1715 }, // Oakland's configured centre (its declared area is 3 km)
    sanFrancisco: { lat: 37.7913, lon: -122.4065 },
    dusseldorf: { lat: 51.2180, lon: 6.7826 },
    steppe: { lat: 48.0, lon: 70.0 } // central Kazakhstan: no app cadastre
};
const place = (city, at, parcelSourceId) => resolvePublicationCity({ city, parcelSourceId, ...at });
const refusalOf = fn => { try { fn(); } catch (error) { return error; } throw new Error('expected a refusal'); };

describe('which city a publication belongs to', () => {
    it('keeps the requested city inside its own area', () => {
        expect(place('zagreb', AT.zagreb)).toBe('zagreb');
        expect(place('new_york', AT.manhattan)).toBe('new_york');
        expect(place('san_francisco', AT.sanFrancisco)).toBe('san_francisco');
    });

    it('moves a site in another city that reads the same cadastre to that city', () => {
        // Croatia's countrywide cadastre: the binding is identical, the record is listed in Split
        expect(place('zagreb', AT.split)).toBe('split');
        // North Rhine-Westphalia's state cadastre serves Cologne and Düsseldorf alike
        expect(place('cologne', AT.dusseldorf)).toBe('dusseldorf');
    });

    it('keeps the requested city in its countrywide cadastre beyond every city\'s area', () => {
        expect(place('zagreb', AT.osijek)).toBe('zagreb');
        expect(place('split', AT.osijek)).toBe('split');
    });

    it('refuses a site that only another city\'s cadastre covers, naming that city', () => {
        // the bug that started this: a Zagreb street with New York loaded
        const zagrebFromNewYork = refusalOf(() => place('new_york', AT.zagreb));
        expect(zagrebFromNewYork).toMatchObject({ code: SITE_IN_OTHER_CITY, status: 422, city: 'new_york', siteCity: 'zagreb' });
        expect(zagrebFromNewYork.message).toMatch(/zagreb/);
        // 21 km apart, different county sources: Oakland's parcels are not San Francisco's
        expect(refusalOf(() => place('san_francisco', AT.oakland))).toMatchObject({ code: SITE_IN_OTHER_CITY, siteCity: 'oakland' });
    });

    it('lets explore publish only where no app cadastre covers the site', () => {
        expect(place('explore', AT.steppe)).toBe('explore');
        expect(refusalOf(() => place('explore', AT.manhattan))).toMatchObject({ code: SITE_IN_OTHER_CITY, siteCity: 'new_york' });
        // Croatia is covered everywhere, by its countrywide cadastre
        expect(refusalOf(() => place('explore', AT.osijek))).toMatchObject({ code: SITE_IN_OTHER_CITY, siteCity: 'zagreb' });
        expect(refusalOf(() => place('new_york', AT.osijek))).toMatchObject({ code: SITE_IN_OTHER_CITY, siteCity: 'zagreb' });
    });

    it('leaves a site no app cadastre covers to the requested city\'s own source', () => {
        expect(place('new_york', AT.steppe)).toBe('new_york');
    });

    it('places a request naming no city where its site is, so no record goes without one', () => {
        expect(place(null, AT.zagreb)).toBe('zagreb');
        expect(place(null, AT.oakland)).toBe('oakland');
        expect(place(null, AT.steppe)).toBe('explore');
    });
});

describe('two cities share a cadastre only when one source serves both', () => {
    it('Croatian cities share theirs; Zagreb and New York, both defaulting to the server\'s own, do not', () => {
        expect(sharesCadastre('zagreb', 'split')).toBe(true);
        expect(sharesCadastre('zagreb', 'new_york')).toBe(false);
        expect(sharesCadastre('san_francisco', 'oakland')).toBe(false);
    });

    it('an explicitly chosen source decides: it must serve both cities', () => {
        expect(sharesCadastre('zagreb', 'split', 'hr-dgu-oss-dkp-cestice')).toBe(true);
        expect(sharesCadastre('cologne', 'dusseldorf', 'de-nrw-lika-flurstueck')).toBe(true);
        expect(sharesCadastre('cologne', 'dusseldorf', 'fr-ign-parcellaire-express')).toBe(false);
        expect(sharesCadastre('zagreb', 'split', 'no-such-source')).toBe(false);
        // the source chosen for the request does not serve Split: no move, a refusal; beyond every
        // city's area, in the requested city's own country, that source decides
        expect(refusalOf(() => place('zagreb', AT.split, 'no-such-source'))).toMatchObject({ code: SITE_IN_OTHER_CITY, siteCity: 'split' });
        expect(place('zagreb', AT.osijek, 'no-such-source')).toBe('zagreb');
    });
});

describe('the binding of a new publication is measured in the city its site lies in', () => {
    const square = ({ lat, lon }, d = 0.0003) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });

    it('refuses before any cadastre is queried', async () => {
        const db = { query: vi.fn() };
        const result = await checkProposalBinding(db, { type: 'building', goal: 'buildings' }, [], { site: square(AT.zagreb), city: 'new_york' });
        expect(result).toMatchObject({ ok: false, status: 422, code: BINDING_CODES.siteInOtherCity, siteCity: 'zagreb' });
        expect(db.query).not.toHaveBeenCalled();
    });

    it('places the preview binding the same way', () => {
        expect(publicationCityOf({ site: square(AT.split), city: 'zagreb' })).toBe('split');
        expect(publicationCityOf({ site: square(AT.zagreb), city: null })).toBe('zagreb');
        expect(() => publicationCityOf({ site: square(AT.zagreb), city: 'new_york' })).toThrow(/zagreb/);
    });
});
