// Unit tests for frontend/js/reparcellization-shares.js — how a reparcellization plan reads owner
// shares and normalizes them to fractions of the whole. The headline pin is the bare-"50" bug: a
// user typing "50" means 50%, so it must agree with "1/2", not swamp it 99:1.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseShareValue, normalizeOwnerSlots } = require('../../frontend/js/reparcellization-shares.js');

describe('parseShareValue', () => {
    it('reads a bare number > 1 as a percentage (the "50" → 0.5 fix)', () => {
        expect(parseShareValue('50')).toBe(0.5);
        expect(parseShareValue('100')).toBe(1);
        expect(parseShareValue('25')).toBe(0.25);
    });

    it('reads a decimal in [0,1] as an already-fraction', () => {
        expect(parseShareValue('0.5')).toBe(0.5);
        expect(parseShareValue('0.25')).toBe(0.25);
        expect(parseShareValue('1')).toBe(1);
    });

    it('reads explicit percents and fractions', () => {
        expect(parseShareValue('50%')).toBe(0.5);
        expect(parseShareValue('1/2')).toBe(0.5);
        expect(parseShareValue('1/4')).toBe(0.25);
        expect(parseShareValue('2/3')).toBeCloseTo(0.6667, 4);
    });

    it('agrees between "50", "50%", "1/2" and "0.5" — all mean half', () => {
        const half = [parseShareValue('50'), parseShareValue('50%'), parseShareValue('1/2'), parseShareValue('0.5')];
        expect(new Set(half)).toEqual(new Set([0.5]));
    });

    it('rejects garbage and a zero denominator', () => {
        expect(parseShareValue('abc')).toBeNaN();
        expect(parseShareValue('')).toBeNaN();
        expect(parseShareValue('1/0')).toBeNaN();
        expect(parseShareValue(null)).toBeNaN();
        expect(parseShareValue(undefined)).toBeNaN();
    });
});

describe('normalizeOwnerSlots', () => {
    it('splits a "50" + "1/2" pair 50/50, not 99/1 (the drift bug)', () => {
        const out = normalizeOwnerSlots([
            { shareText: '50' },
            { shareText: '1/2' }
        ]);
        expect(out.map(o => o.fraction)).toEqual([0.5, 0.5]);
    });

    it('normalizes three real percents to fractions summing to 1', () => {
        const out = normalizeOwnerSlots([
            { shareText: '50%' },
            { shareText: '25%' },
            { shareText: '25%' }
        ]);
        expect(out.map(o => o.fraction)).toEqual([0.5, 0.25, 0.25]);
        expect(out.reduce((s, o) => s + o.fraction, 0)).toBeCloseTo(1, 10);
    });

    it('prefers shareDetail over shareText when present', () => {
        const out = normalizeOwnerSlots([
            { shareText: '1', shareDetail: '1/4' },
            { shareText: '1', shareDetail: '3/4' }
        ]);
        expect(out.map(o => o.fraction)).toEqual([0.25, 0.75]);
    });

    it('falls back to an equal split when no slot has a positive share', () => {
        const out = normalizeOwnerSlots([
            { shareText: 'abc' },
            { shareText: '' },
            { shareText: '0' }
        ]);
        expect(out.map(o => o.fraction)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    });

    it('returns [] for an empty or non-array input', () => {
        expect(normalizeOwnerSlots([])).toEqual([]);
        expect(normalizeOwnerSlots(null)).toEqual([]);
    });
});
