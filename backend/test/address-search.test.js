// Unit tests for frontend/js/address-search.js — pure URL building and Nominatim response parsing
// (no DOM/map/network). The browser wiring in the module is inert under node (no document).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildNominatimUrl, parseGeocodeResults, pickBestResult } = require('../../frontend/js/address-search.js');

describe('buildNominatimUrl', () => {
    it('builds a jsonv2 query with the encoded search term', () => {
        const url = buildNominatimUrl('Trg bana Jelačića, Zagreb');
        expect(url).toContain('https://nominatim.openstreetmap.org/search?');
        expect(url).toContain('format=jsonv2');
        expect(url).toContain('q=Trg+bana+Jela%C4%8Di%C4%87a%2C+Zagreb');
        expect(url).toContain('limit=5');
    });

    it('honours a custom limit and countrycodes', () => {
        const url = buildNominatimUrl('Split', { limit: 1, countrycodes: 'hr' });
        expect(url).toContain('limit=1');
        expect(url).toContain('countrycodes=hr');
    });

    it('returns an empty string for a blank query', () => {
        expect(buildNominatimUrl('')).toBe('');
        expect(buildNominatimUrl('   ')).toBe('');
        expect(buildNominatimUrl(null)).toBe('');
    });
});

describe('parseGeocodeResults', () => {
    const raw = [
        {
            lat: '45.8131', lon: '15.9775', display_name: 'Zagreb, Croatia',
            boundingbox: ['45.7', '45.9', '15.8', '16.1']
        },
        { lat: 'not-a-number', lon: '15.0' },
        { lat: '43.5081', lon: '16.4402', display_name: 'Split' }
    ];

    it('parses lat/lon strings and converts boundingbox to Leaflet bounds', () => {
        const results = parseGeocodeResults(raw);
        expect(results).toHaveLength(2); // the NaN row is dropped
        expect(results[0]).toMatchObject({ lat: 45.8131, lng: 15.9775, displayName: 'Zagreb, Croatia' });
        expect(results[0].boundingBox).toEqual([[45.7, 15.8], [45.9, 16.1]]);
    });

    it('leaves boundingBox null when absent', () => {
        expect(parseGeocodeResults(raw)[1].boundingBox).toBeNull();
    });

    it('accepts a JSON string and returns [] for junk', () => {
        expect(parseGeocodeResults(JSON.stringify(raw))).toHaveLength(2);
        expect(parseGeocodeResults('not json')).toEqual([]);
        expect(parseGeocodeResults(null)).toEqual([]);
        expect(parseGeocodeResults({})).toEqual([]);
    });
});

describe('pickBestResult', () => {
    it('returns the first valid result', () => {
        const best = pickBestResult([{ lat: '1', lon: '2', display_name: 'A' }]);
        expect(best).toMatchObject({ lat: 1, lng: 2, displayName: 'A' });
    });

    it('returns null when nothing usable', () => {
        expect(pickBestResult([])).toBeNull();
        expect(pickBestResult([{ lat: 'x', lon: 'y' }])).toBeNull();
    });
});
