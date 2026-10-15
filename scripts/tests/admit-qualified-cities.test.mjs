import { describe, expect, it } from 'vitest';
import { currencyFor, sourceActivationDecision, validateCountryConfig } from '../admit-qualified-cities.mjs';

describe('admission country configuration', () => {
    it('accepts a matching ISO country, valid locale, and supported ISO currency', () => {
        expect(validateCountryConfig({ countryCode: 'KE', currency: { locale: 'sw-KE', code: 'KES' } }, 'KE'))
            .toEqual({ countryCode: 'KE', currency: { locale: 'sw-KE', code: 'KES' } });
        expect(validateCountryConfig({ countryCode: 'ET', currency: { locale: 'am-ET', code: 'ETB' } }, 'ET'))
            .toEqual({ countryCode: 'ET', currency: { locale: 'am-ET', code: 'ETB' } });
        expect(currencyFor('ET', null)).toEqual({ locale: 'am-ET', code: 'ETB' });
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

describe('qualified source activation policy', () => {
    it('promotes only a new, nine-gate-qualified candidate into its admitted default scope', () => {
        const candidate = { id: 'new-source', defaultForCity: false, cityIds: ['wup2025:6353'] };
        const { eligible, descriptor, activation } = sourceActivationDecision(candidate);
        expect(eligible).toBe(true);
        expect(descriptor).toMatchObject({ id: candidate.id, defaultForCity: true, cityIds: [] });
        expect(candidate).toMatchObject({ defaultForCity: false, cityIds: ['wup2025:6353'] });
        expect(activation).toMatchObject({ policy: 'newly_qualified_city_default', defaultForCity: true,
            scope: 'admitted_city_ids', candidateDefaultForCity: false });
    });

    it('does not promote a source that is already cataloged as opt-in', () => {
        const existing = { id: 'existing-opt-in', defaultForCity: false, cityIds: ['ljubljana'] };
        const decision = sourceActivationDecision({ id: existing.id }, existing);
        expect(decision.eligible).toBe(false);
        expect(decision.descriptor).toBe(existing);
        expect(existing.defaultForCity).toBe(false);
    });
});
