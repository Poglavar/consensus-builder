import { describe, expect, it } from 'vitest';
import { parcelToSlug, parcelIdToCity } from '../ens/slug.js';

describe('parcelToSlug', () => {
    it('lowercases and keeps simple ids intact', () => {
        expect(parcelToSlug('US-NY-6201001005440048')).toBe('us-ny-6201001005440048');
    });

    it('collapses the slash in Zagreb ids to a hyphen', () => {
        expect(parcelToSlug('HR-335258-4341/2')).toBe('hr-335258-4341-2');
    });

    it('lowercases Buenos Aires SMP letters', () => {
        expect(parcelToSlug('001-005-027A')).toBe('001-005-027a');
    });

    it('collapses runs of separators and trims edges', () => {
        expect(parcelToSlug('HR--335258//4341 ')).toBe('hr-335258-4341');
    });

    it('returns empty string for empty/nullish input', () => {
        expect(parcelToSlug('')).toBe('');
        expect(parcelToSlug(null)).toBe('');
        expect(parcelToSlug(undefined)).toBe('');
    });
});

describe('parcelIdToCity', () => {
    const cases = [
        ['HR-335258-4341/2', 'zagreb', 'zg'],
        ['US-NY-6201001005440048', 'new_york', 'ny'],
        ['US-CO-12345', 'colorado', 'co'],
        ['SI-99', 'ljubljana', 'lj'],
        ['SR-70840-123', 'belgrade', 'bg'],
        ['001-005-027A', 'buenos_aires', 'ba'],
    ];

    it.each(cases)('maps %s to the right city', (id, cityId, cityCode) => {
        const result = parcelIdToCity(id);
        expect(result).toMatchObject({ cityId, cityCode });
        expect(result.cityName).toBeTruthy();
    });

    it('returns null for ids without a recognizable prefix', () => {
        expect(parcelIdToCity('garbage')).toBeNull();
        expect(parcelIdToCity('')).toBeNull();
        expect(parcelIdToCity(null)).toBeNull();
    });

    it('does not confuse US-NY with US-CO', () => {
        expect(parcelIdToCity('US-NY-1').cityId).toBe('new_york');
        expect(parcelIdToCity('US-CO-1').cityId).toBe('colorado');
    });
});
