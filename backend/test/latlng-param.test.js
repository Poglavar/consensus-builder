// Unit tests for frontend/js/latlng-param.js — the ?latlng= deep-link parser (pure string parsing,
// no DOM/map). Covers the query-string, URLSearchParams and bare-value forms plus range validation.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseLatLngParam } = require('../../frontend/js/latlng-param.js');

describe('parseLatLngParam', () => {
    it('parses a bare lat,lng value', () => {
        expect(parseLatLngParam('45.8131,15.9775')).toEqual({ lat: 45.8131, lng: 15.9775, zoom: null });
    });

    it('parses an optional zoom as the third component', () => {
        expect(parseLatLngParam('45.8131,15.9775,18')).toEqual({ lat: 45.8131, lng: 15.9775, zoom: 18 });
    });

    it('reads the value out of a full query string', () => {
        expect(parseLatLngParam('?city=zagreb&latlng=40.7,-74.0,12')).toEqual({ lat: 40.7, lng: -74.0, zoom: 12 });
    });

    it('reads the value out of a URLSearchParams', () => {
        expect(parseLatLngParam(new URLSearchParams('latlng=-33.86,151.2'))).toEqual({ lat: -33.86, lng: 151.2, zoom: null });
    });

    it('accepts negative coordinates on both axes', () => {
        expect(parseLatLngParam('-33.8688,-70.0')).toEqual({ lat: -33.8688, lng: -70.0, zoom: null });
    });

    it('returns null when the param is absent', () => {
        expect(parseLatLngParam('?city=zagreb')).toBeNull();
        expect(parseLatLngParam('')).toBeNull();
        expect(parseLatLngParam(null)).toBeNull();
        expect(parseLatLngParam(undefined)).toBeNull();
    });

    it('rejects out-of-range latitude and longitude', () => {
        expect(parseLatLngParam('91,15')).toBeNull();
        expect(parseLatLngParam('45,181')).toBeNull();
    });

    it('rejects a non-numeric or malformed value', () => {
        expect(parseLatLngParam('foo,bar')).toBeNull();
        expect(parseLatLngParam('45.81')).toBeNull();
        expect(parseLatLngParam('45.81,15.98,18,99')).toBeNull();
    });

    it('rejects an out-of-band zoom', () => {
        expect(parseLatLngParam('45.81,15.98,-1')).toBeNull();
        expect(parseLatLngParam('45.81,15.98,23')).toBeNull();
    });
});
