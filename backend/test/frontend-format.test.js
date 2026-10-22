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

describe('CbFormat.parseDecimal (typed amounts)', () => {
    it('reads what was typed by the UI language\'s own rules, the ones numbers are shown with', () => {
        expect(CbFormat.parseDecimal('2.500', { lang: 'hr' })).toBe(2500);
        expect(CbFormat.parseDecimal('2.500', { lang: 'en' })).toBe(2.5);
        expect(CbFormat.parseDecimal('2,5', { lang: 'hr' })).toBe(2.5);
        expect(CbFormat.parseDecimal('1.234,5', { lang: 'hr' })).toBe(1234.5);
        expect(CbFormat.parseDecimal('1,234.5', { lang: 'en' })).toBe(1234.5);
        expect(CbFormat.parseDecimal('1 234,5', { lang: 'hr' })).toBe(1234.5);
        expect(CbFormat.parseDecimal('1.000.000', { lang: 'hr' })).toBe(1000000);
        expect(CbFormat.parseDecimal('0.5', { lang: 'en' })).toBe(0.5);
        expect(CbFormat.parseDecimal(',5', { lang: 'hr' })).toBe(0.5);
    });

    it('refuses what the language\'s rules do not allow instead of guessing', () => {
        expect(CbFormat.parseDecimal('0.5', { lang: 'hr' })).toBeNaN();
        expect(CbFormat.parseDecimal('2,5', { lang: 'en' })).toBeNaN();
        expect(CbFormat.parseDecimal('1.2.3', { lang: 'en' })).toBeNaN();
        expect(CbFormat.parseDecimal('12,34', { lang: 'en' })).toBeNaN();
        expect(CbFormat.parseDecimal('abc', { lang: 'en' })).toBeNaN();
        expect(CbFormat.parseDecimal('.', { lang: 'en' })).toBeNaN();
    });

    it('gives null for nothing, never 0', () => {
        expect(CbFormat.parseDecimal('', { lang: 'en' })).toBe(null);
        expect(CbFormat.parseDecimal(null, { lang: 'en' })).toBe(null);
    });

    it('round-trips every language: what is shown reads back as the same number', () => {
        for (const lang of ['en', 'hr', 'es', 'sr']) {
            for (const value of [0.5, 2.5, 2500, 1234.5, 1000000.125]) {
                expect(CbFormat.parseDecimal(CbFormat.formatNumber(value, { lang, maxFractionDigits: 8 }), { lang })).toBe(value);
            }
        }
    });

    it('keeps a fractional offer through the offer field helpers (proposals/lifecycle.js)', () => {
        const { parseProposalOfferValue, formatProposalOfferValue } = require('../../frontend/js/proposals/lifecycle.js');
        expect(parseProposalOfferValue('0.5')).toBe(0.5);
        expect(parseProposalOfferValue('')).toBe(0);
        expect(parseProposalOfferValue('x')).toBeNaN();
        expect(formatProposalOfferValue(0.5)).toBe('0.5');
        expect(formatProposalOfferValue('1234.5')).toBe('1,234.5');
        expect(parseProposalOfferValue(formatProposalOfferValue(0.125))).toBe(0.125);
    });
});

// The viewer's locale (i18n.getLocale) decides how a number or date is written; the currency of an
// amount is never changed by it.
describe('the viewer locale', () => {
    const when = new Date(Date.UTC(2026, 9, 3, 22, 26));
    function withLocale(lang, locale, run) {
        const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
        const previous = globalThis.window;
        globalThis.window = { i18n: { getLanguage: () => lang, getLocale: () => locale } };
        try { return run(); } finally {
            if (had) globalThis.window = previous; else delete globalThis.window;
        }
    }

    it('writes US English dates month first with a 12-hour clock', () => {
        withLocale('en', 'en-US', () => {
            expect(CbFormat.localeFor()).toBe('en-US');
            expect(CbFormat.formatDate(when, { timeZone: 'UTC' })).toBe('Oct 3, 2026');
            expect(CbFormat.formatDateTime(when, { timeZone: 'UTC' })).toMatch(/^Oct 3, 2026, 10:26\s?PM$/);
        });
    });

    it('keeps British English day first', () => {
        withLocale('en', 'en-GB', () => {
            expect(CbFormat.formatDate(when, { timeZone: 'UTC' })).toBe('3 Oct 2026');
        });
    });

    it('uses a language default when the asked language is not the viewer one', () => {
        withLocale('en', 'en-US', () => {
            expect(CbFormat.localeFor('hr')).toBe('hr-HR');
        });
    });

    it('writes sterling as amount then code, whole pounds, in any locale', () => {
        withLocale('en', 'en-US', () => {
            expect(CbFormat.formatMoney(431000.4, 'GBP')).toBe('431,000 GBP');
        });
        withLocale('hr', 'hr-HR', () => {
            expect(CbFormat.formatMoney(431000.4, 'GBP')).toBe('431.000 GBP');
        });
    });
});
