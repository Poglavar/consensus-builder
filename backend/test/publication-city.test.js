// A new publication's city follows its site, never the view it was drawn in (projections.md §10 M8,
// location-first.md phase 4, proposals/publication-city.js). Real coverage
// (frontend/data/world-coverage.json) and the real source catalogue: a Zagreb street drawn while New
// York is loaded is Zagreb's and bound against Zagreb's cadastre, an explore site in a live city is
// that city's, and nothing is refused for where it was drawn from.
import { describe, it, expect } from 'vitest';
import { resolvePublicationCity, sourceServes } from '../proposals/publication-city.js';
import { publicationCityOf } from '../proposals/binding.js';

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
const place = (city, at, parcelSourceId) => resolvePublicationCity({ city, parcelSourceId, ...at }).city;
const sourceOf = (city, at, parcelSourceId) => resolvePublicationCity({ city, parcelSourceId, ...at }).parcelSourceId;

describe('which city a publication belongs to', () => {
    it('is the city whose parcels apply at the site, whatever city the request names', () => {
        expect(place('zagreb', AT.zagreb)).toBe('zagreb');
        expect(place('new_york', AT.manhattan)).toBe('new_york');
        // the bug that started this: a Zagreb street with New York loaded
        expect(place('new_york', AT.zagreb)).toBe('zagreb');
        expect(place('zagreb', AT.split)).toBe('split');
        expect(place('cologne', AT.dusseldorf)).toBe('dusseldorf');
        // 21 km apart, different county sources: Oakland's parcels are not San Francisco's
        expect(place('san_francisco', AT.oakland)).toBe('oakland');
    });

    it('files an explore site in a covered place under that place', () => {
        expect(place('explore', AT.manhattan)).toBe('new_york');
        // Croatia is covered everywhere, by its countrywide cadastre
        expect(place('explore', AT.osijek)).toBe(place(null, AT.osijek));
        expect(place('new_york', AT.osijek)).toBe(place(null, AT.osijek));
    });

    it('leaves a site no app cadastre covers to the requested city\'s own source, else explore', () => {
        expect(place('new_york', AT.steppe)).toBe('new_york');
        expect(place('explore', AT.steppe)).toBe('explore');
        expect(place(null, AT.steppe)).toBe('explore');
    });

    it('places a request naming no city where its site is, so no record goes without one', () => {
        expect(place(null, AT.zagreb)).toBe('zagreb');
        expect(place(null, AT.oakland)).toBe('oakland');
    });
});

describe('the source that binds a publication', () => {
    it('is the requested one where it serves the placed city, else the placed city\'s own', () => {
        expect(sourceServes('oss-wfs', 'zagreb')).toBe(true);
        expect(sourceServes('oss-wfs', 'new_york')).toBe(false);
        expect(sourceOf('zagreb', AT.zagreb, 'oss-wfs')).toBe('oss-wfs');
        expect(sourceServes('hr-dgu-oss-dkp-cestice', 'split')).toBe(true);
        expect(sourceServes('no-such-source', 'split')).toBe(false);
        expect(sourceOf('zagreb', AT.split, 'hr-dgu-oss-dkp-cestice')).toBe('hr-dgu-oss-dkp-cestice');
        expect(sourceOf('cologne', AT.dusseldorf, 'de-nrw-lika-flurstueck')).toBe('de-nrw-lika-flurstueck');
        // a source chosen for the view's city does not follow the site into a city it does not serve
        expect(sourceOf('cologne', AT.dusseldorf, 'fr-ign-parcellaire-express')).toBe(null);
        expect(sourceOf('zagreb', AT.split, 'no-such-source')).toBe(null);
        expect(sourceOf('zagreb', AT.split)).toBe(null);
    });
});

describe('the binding of a new publication is measured in the city its site lies in', () => {
    const square = ({ lat, lon }, d = 0.0003) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });

    it('places the preview binding the same way', () => {
        expect(publicationCityOf({ site: square(AT.zagreb), city: 'zagreb', parcelSourceId: 'oss-wfs' })).toEqual({ city: 'zagreb', parcelSourceId: 'oss-wfs' });
        expect(publicationCityOf({ site: square(AT.split), city: 'zagreb' })).toEqual({ city: 'split', parcelSourceId: null });
        expect(publicationCityOf({ site: square(AT.zagreb), city: null })).toEqual({ city: 'zagreb', parcelSourceId: null });
        expect(publicationCityOf({ site: square(AT.zagreb), city: 'new_york' })).toEqual({ city: 'zagreb', parcelSourceId: null });
    });

    it('still refuses a source the requested city does not have, as a malformed request', () => {
        expect(() => publicationCityOf({ site: square(AT.zagreb), city: 'zagreb', parcelSourceId: 'fr-ign-parcellaire-express' }))
            .toThrow(/not configured for this city/);
    });
});
