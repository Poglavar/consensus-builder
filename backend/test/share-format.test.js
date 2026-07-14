// Unit tests for frontend/js/parcels/share-format.js — the shared ownership-share and offer
// formatters. These pin two live bugs the inline copies had: a 100% owner rendering as "1%", and a
// sub-1-ETH offer rounding to "0 ETH". Both are asserted against the CORRECT behaviour, so they go
// red against the pre-extraction code and stay green after.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatPercentValue, formatSharePercent, formatOffer } = require('../../frontend/js/parcels/share-format.js');

describe('formatPercentValue', () => {
    it('keeps whole percentages whole (the "100% → 1%" bug)', () => {
        expect(formatPercentValue(100)).toBe('100%');
        expect(formatPercentValue(50)).toBe('50%');
        expect(formatPercentValue(20)).toBe('20%');
    });

    it('trims trailing zeros only after a decimal point', () => {
        expect(formatPercentValue(12.5)).toBe('13%'); // >=10 → 0 decimals, rounds
        expect(formatPercentValue(2.5)).toBe('2.5%');
        expect(formatPercentValue(0.25)).toBe('0.25%');
        expect(formatPercentValue(1)).toBe('1%');
    });

    it('returns empty string for non-finite input', () => {
        expect(formatPercentValue(NaN)).toBe('');
        expect(formatPercentValue(undefined)).toBe('');
    });
});

describe('formatSharePercent', () => {
    it('passes through an explicit percent', () => {
        expect(formatSharePercent('50%')).toBe('50%');
    });

    it('reads a bare number > 1 as an already-percent value', () => {
        expect(formatSharePercent('50')).toBe('50%');
        expect(formatSharePercent('100')).toBe('100%');
    });

    it('reads a bare number <= 1 as a fraction', () => {
        expect(formatSharePercent('0.5')).toBe('50%');
        expect(formatSharePercent('1')).toBe('100%');
    });

    it('resolves a "1/2" fraction with an injected parseFraction', () => {
        const parseFraction = text => {
            const [n, d] = text.split('/').map(Number);
            return { numerator: n, denominator: d };
        };
        expect(formatSharePercent('1/2', { parseFraction })).toBe('50%');
        expect(formatSharePercent('1/3', { parseFraction })).toBe('33%'); // >=10 → 0 decimals
        expect(formatSharePercent('1/8', { parseFraction })).toBe('13%'); // 12.5 → 0 decimals → 13%
    });

    it('rounds a "1/8" share the way formatPercentValue does', () => {
        const parseFraction = text => {
            const [n, d] = text.split('/').map(Number);
            return { numerator: n, denominator: d };
        };
        expect(formatSharePercent('1/40', { parseFraction })).toBe('2.5%'); // 2.5 → 1 decimal
    });

    it('returns the input unchanged when it cannot be parsed', () => {
        expect(formatSharePercent('abc')).toBe('abc');
        expect(formatSharePercent('')).toBe('');
    });
});

describe('formatOffer', () => {
    it('keeps a sub-1-ETH offer visible (the "0 ETH" bug)', () => {
        expect(formatOffer(0.03, 'ETH')).toEqual({
            symbol: '', value: '0.03', suffix: ' ETH', display: '0.03 ETH'
        });
        expect(formatOffer(0.05, 'ETH').display).toBe('0.05 ETH');
        expect(formatOffer(0.01, 'ETH').display).toBe('0.01 ETH');
    });

    it('rounds and locale-groups EUR', () => {
        const eur = formatOffer(1000, 'EUR');
        expect(eur.symbol).toBe('€');
        expect(eur.suffix).toBe('');
        // hr-HR groups thousands with a dot
        expect(eur.value).toBe('1.000');
        expect(eur.display).toBe('€1.000');
    });

    it('trims trailing zeros on crypto amounts >= 1', () => {
        expect(formatOffer(1.5, 'ETH').value).toBe('1.5');
        expect(formatOffer(5, 'ETH').value).toBe('5');
    });

    it('defaults the currency to ETH', () => {
        expect(formatOffer(0.02).suffix).toBe(' ETH');
    });

    it('returns null for a zero, negative, or missing offer', () => {
        expect(formatOffer(0, 'ETH')).toBeNull();
        expect(formatOffer(-1, 'ETH')).toBeNull();
        expect(formatOffer(null, 'ETH')).toBeNull();
        expect(formatOffer('nope', 'ETH')).toBeNull();
    });
});
