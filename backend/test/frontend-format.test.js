// The shared formatter (frontend/js/format.js): one rendering per language for numbers, areas, money
// and dates. These tests pin the conventions docs/design-language.md promises, so a surface that
// formats on its own (toLocaleString('hr-HR') in an English UI) is a visible deviation, and a
// missing value never renders as 0.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CbFormat = require('../../frontend/js/format.js');

describe('CbFormat locales', () => {
    it('maps every UI language to an Intl locale and falls back to English', () => {
        expect(CbFormat.localeFor('en')).toBe('en-GB');
        expect(CbFormat.localeFor('hr')).toBe('hr-HR');
        expect(CbFormat.localeFor('es')).toBe('es-ES');
        expect(CbFormat.localeFor('sr')).toBe('sr-Latn-RS');
        expect(CbFormat.localeFor('xx')).toBe('en-GB');
    });

    it('reads English outside a browser', () => {
        expect(CbFormat.currentLanguage()).toBe('en');
    });
});

describe('numbers and areas', () => {
    it('groups thousands per language', () => {
        expect(CbFormat.formatNumber(3522, { lang: 'en' })).toBe('3,522');
        expect(CbFormat.formatNumber(3522, { lang: 'hr' })).toBe('3.522');
        expect(CbFormat.formatNumber(3522.6, { lang: 'en' })).toBe('3,523');
        expect(CbFormat.formatNumber(2.4, { lang: 'en', maxFractionDigits: 1 })).toBe('2.4');
        expect(CbFormat.formatNumber(2.4, { lang: 'hr', maxFractionDigits: 1 })).toBe('2,4');
    });

    it('renders a missing value as missing, never as 0', () => {
        expect(CbFormat.formatNumber(null, { lang: 'en' })).toBe('');
        expect(CbFormat.formatNumber(undefined, { lang: 'en', missing: '–' })).toBe('–');
        expect(CbFormat.formatNumber(NaN, { lang: 'en' })).toBe('');
        expect(CbFormat.formatNumber('12', { lang: 'en' })).toBe('');
        expect(CbFormat.formatArea(null, { lang: 'en' })).toBe('');
        expect(CbFormat.formatMoney(null, 'EUR', { lang: 'en' })).toBe('');
        expect(CbFormat.formatDateTime(null, { lang: 'en' })).toBe('');
    });

    it('formats areas in square metres with a narrow space, one decimal under 100', () => {
        expect(CbFormat.formatArea(3522, { lang: 'en' })).toBe('3,522 m²');
        expect(CbFormat.formatArea(3522, { lang: 'hr' })).toBe('3.522 m²');
        expect(CbFormat.formatArea(42.37, { lang: 'en' })).toBe('42.4 m²');
        expect(CbFormat.formatLength(1240.2, { lang: 'en' })).toBe('1,240 m');
        expect(CbFormat.formatLength(12.46, { lang: 'en' })).toBe('12.5 m');
    });

    it('formats percentages from ratios or from hundreds', () => {
        expect(CbFormat.formatPercent(0.75, { lang: 'en' })).toBe('75%');
        expect(CbFormat.formatPercent(75, { lang: 'en', ofHundred: true })).toBe('75%');
        expect(CbFormat.formatPercent(0.14286, { lang: 'en', maxFractionDigits: 1 })).toBe('14.3%');
    });
});

describe('money', () => {
    it('is amount then code, with per-currency digits', () => {
        expect(CbFormat.formatMoney(431000, 'USDT', { lang: 'en' })).toBe('431,000 USDT');
        expect(CbFormat.formatMoney(431000, 'usdt', { lang: 'hr' })).toBe('431.000 USDT');
        expect(CbFormat.formatMoney(17608916, 'EUR', { lang: 'en' })).toBe('17,608,916 EUR');
        expect(CbFormat.formatMoney(0.01, 'ETH', { lang: 'en' })).toBe('0.0100 ETH');
        expect(CbFormat.formatMoney(19.71, 'ETH', { lang: 'en' })).toBe('19.71 ETH');
        expect(CbFormat.formatMoney(5.32, 'SOL', { lang: 'en', maxFractionDigits: 2 })).toBe('5.32 SOL');
    });

    it('leaves out the code when there is none', () => {
        expect(CbFormat.formatMoney(12, '', { lang: 'en' })).toBe('12');
    });
});

describe('dates', () => {
    const when = new Date(Date.UTC(2026, 9, 3, 22, 26)); // 2026-10-03 22:26 UTC

    it('renders medium date + short time per language, in a fixed zone', () => {
        expect(CbFormat.formatDateTime(when, { lang: 'en', timeZone: 'UTC' })).toBe('3 Oct 2026, 22:26');
        expect(CbFormat.formatDate(when, { lang: 'en', timeZone: 'UTC' })).toBe('3 Oct 2026');
        expect(CbFormat.formatTime(when, { lang: 'en', timeZone: 'UTC' })).toBe('22:26');
        expect(CbFormat.formatDateTime(when, { lang: 'hr', timeZone: 'UTC' })).toMatch(/^3\. lis 2026\. 22:26$/);
    });

    it('accepts ISO strings, milliseconds and chain seconds', () => {
        const iso = CbFormat.formatDateTime('2026-10-03T22:26:00Z', { lang: 'en', timeZone: 'UTC' });
        const ms = CbFormat.formatDateTime(when.getTime(), { lang: 'en', timeZone: 'UTC' });
        const seconds = CbFormat.formatDateTime(Math.floor(when.getTime() / 1000), { lang: 'en', timeZone: 'UTC' });
        expect(iso).toBe('3 Oct 2026, 22:26');
        expect(ms).toBe(iso);
        expect(seconds).toBe(iso);
        expect(CbFormat.formatDateTime('not a date', { lang: 'en' })).toBe('');
    });
});
