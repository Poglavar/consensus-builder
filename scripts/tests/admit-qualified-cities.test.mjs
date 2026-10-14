import { describe, expect, it } from 'vitest';
import { validateCountryConfig } from '../admit-qualified-cities.mjs';

describe('admission country configuration', () => {
    it('accepts a matching ISO country, valid locale, and supported ISO currency', () => {
        expect(validateCountryConfig({ countryCode: 'KE', currency: { locale: 'sw-KE', code: 'KES' } }, 'KE'))
            .toEqual({ countryCode: 'KE', currency: { locale: 'sw-KE', code: 'KES' } });
    });

    it('rejects missing or mismatched country metadata', () => {
        expect(() => validateCountryConfig({ currency: { locale: 'en-KE', code: 'KES' } })).toThrow(/countryCode/);
        expect(() => validateCountryConfig({ countryCode: 'KE', currency: { locale: 'en-KE', code: 'KES' } }, 'TZ'))
            .toThrow(/match/);
    });

    it('rejects invalid locales and non-ISO currency codes', () => {
        expect(() => validateCountryConfig({ countryCode: 'KE', currency: { locale: 'not a locale', code: 'KES' } })).toThrow(/locale/);
        expect(() => validateCountryConfig({ countryCode: 'KE', currency: { locale: 'en-KE', code: 'ZZZ' } })).toThrow(/ISO-4217/);
    });

    it('does not treat unknown two-letter codes as ISO countries', () => {
        expect(() => validateCountryConfig({ countryCode: 'ZZ', currency: { locale: 'en', code: 'USD' } })).toThrow(/ISO-3166/);
    });
});
