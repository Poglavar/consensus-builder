// format.js — the one place numbers, areas, money, percentages and dates are turned into text, keyed
// to the UI language (docs/design-language.md). Before this file every surface called
// toLocaleString('hr-HR') or toFixed() on its own, so one offer read "431.000 USDT", "€431.000" and
// "431,000 USDT" in one session. Pure (no DOM); UMD so backend/test/frontend-format.test.js runs it
// headlessly. In the browser it is window.CbFormat and reads the language from window.i18n.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CbFormat = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // The UI language → the Intl locale that renders it. English uses day-month order and a
    // comma thousands separator; Serbian is written in Latin script in this app.
    const LOCALES = Object.freeze({ en: 'en-GB', hr: 'hr-HR', es: 'es-ES', sr: 'sr-Latn-RS' });
    const FALLBACK_LANG = 'en';
    const NARROW_NBSP = ' ';
    const NBSP = ' ';

    // Digits a currency is shown with when the caller does not say: fiat and stablecoins whole,
    // chain gas tokens to four places.
    const CURRENCY_DIGITS = Object.freeze({ EUR: 0, USD: 0, USDC: 2, USDT: 2, ETH: 4, SOL: 4 });

    const formatterCache = new Map();

    function currentLanguage() {
        try {
            const i18n = typeof window !== 'undefined' ? window.i18n : null;
            const lang = i18n && typeof i18n.getLanguage === 'function' ? i18n.getLanguage() : null;
            return LOCALES[lang] ? lang : FALLBACK_LANG;
        } catch (_) {
            return FALLBACK_LANG;
        }
    }

    function localeFor(lang) {
        return LOCALES[lang] || LOCALES[lang === undefined ? currentLanguage() : FALLBACK_LANG];
    }

    function isFiniteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function numberFormatter(locale, options) {
        const key = locale + '|' + JSON.stringify(options);
        let f = formatterCache.get(key);
        if (!f) {
            f = new Intl.NumberFormat(locale, options);
            formatterCache.set(key, f);
        }
        return f;
    }

    // A missing or non-numeric value renders as the caller's `missing` text (default empty), never
    // as 0: Number(null) is 0 and that has already produced "0 m" sea level under a railway.
    function formatNumber(value, options = {}) {
        if (!isFiniteNumber(value)) return options.missing === undefined ? '' : options.missing;
        const locale = localeFor(options.lang);
        const maximumFractionDigits = options.maxFractionDigits === undefined ? 0 : options.maxFractionDigits;
        const minimumFractionDigits = options.minFractionDigits === undefined
            ? Math.min(0, maximumFractionDigits)
            : options.minFractionDigits;
        return numberFormatter(locale, { minimumFractionDigits, maximumFractionDigits }).format(value);
    }

    function formatInteger(value, options = {}) {
        return formatNumber(value, Object.assign({}, options, { maxFractionDigits: 0 }));
    }

    // "3,522 m²" (en) / "3.522 m²" (hr); square metres always, so areas stay comparable across a
    // panel. Whole metres above 100 m², one decimal below.
    function formatArea(squareMetres, options = {}) {
        if (!isFiniteNumber(squareMetres)) return options.missing === undefined ? '' : options.missing;
        const digits = options.maxFractionDigits === undefined
            ? (Math.abs(squareMetres) < 100 ? 1 : 0)
            : options.maxFractionDigits;
        return formatNumber(squareMetres, Object.assign({}, options, { maxFractionDigits: digits })) + NARROW_NBSP + 'm²';
    }

    // "12.5 m" / "1,240 m": lengths in metres, one decimal under 100 m.
    function formatLength(metres, options = {}) {
        if (!isFiniteNumber(metres)) return options.missing === undefined ? '' : options.missing;
        const digits = options.maxFractionDigits === undefined
            ? (Math.abs(metres) < 100 ? 1 : 0)
            : options.maxFractionDigits;
        return formatNumber(metres, Object.assign({}, options, { maxFractionDigits: digits })) + NARROW_NBSP + 'm';
    }

    // Amount then code, never a symbol: "431,000 USDT", "0.0100 ETH", "17,608,916 EUR". One rule for
    // fiat, stablecoins and gas tokens, so a card never mixes "€" with "USDT".
    function formatMoney(amount, currency, options = {}) {
        if (!isFiniteNumber(amount)) return options.missing === undefined ? '' : options.missing;
        const code = String(currency || '').toUpperCase();
        const digits = options.maxFractionDigits === undefined
            ? (CURRENCY_DIGITS[code] === undefined ? 2 : CURRENCY_DIGITS[code])
            : options.maxFractionDigits;
        const minDigits = options.minFractionDigits === undefined ? (digits > 0 && Math.abs(amount) < 1 ? digits : 0) : options.minFractionDigits;
        const number = formatNumber(amount, Object.assign({}, options, { maxFractionDigits: digits, minFractionDigits: minDigits }));
        return code ? number + NBSP + code : number;
    }

    // "75%" from a ratio (0.75) or, with { ofHundred: true }, from a percentage number (75).
    function formatPercent(value, options = {}) {
        if (!isFiniteNumber(value)) return options.missing === undefined ? '' : options.missing;
        const pct = options.ofHundred ? value : value * 100;
        const digits = options.maxFractionDigits === undefined ? 0 : options.maxFractionDigits;
        return formatNumber(pct, Object.assign({}, options, { maxFractionDigits: digits })) + '%';
    }

    function toDate(value) {
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
        if (typeof value === 'number' && Number.isFinite(value)) {
            // Seconds (chain timestamps) or milliseconds: anything under 10^11 is seconds.
            const d = new Date(value < 1e11 ? value * 1000 : value);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        if (typeof value === 'string' && value.trim()) {
            const d = new Date(value);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        return null;
    }

    function dateFormatter(locale, options) {
        const key = 'd|' + locale + '|' + JSON.stringify(options);
        let f = formatterCache.get(key);
        if (!f) {
            f = new Intl.DateTimeFormat(locale, options);
            formatterCache.set(key, f);
        }
        return f;
    }

    // "3 Oct 2026, 00:26" (en) / "3. lis 2026. 00:26" (hr): medium date, short time, 24-hour where
    // the locale is.
    function formatDateTime(value, options = {}) {
        const date = toDate(value);
        if (!date) return options.missing === undefined ? '' : options.missing;
        const fmt = { dateStyle: 'medium', timeStyle: 'short' };
        if (options.timeZone) fmt.timeZone = options.timeZone;
        return dateFormatter(localeFor(options.lang), fmt).format(date);
    }

    function formatDate(value, options = {}) {
        const date = toDate(value);
        if (!date) return options.missing === undefined ? '' : options.missing;
        const fmt = { dateStyle: 'medium' };
        if (options.timeZone) fmt.timeZone = options.timeZone;
        return dateFormatter(localeFor(options.lang), fmt).format(date);
    }

    function formatTime(value, options = {}) {
        const date = toDate(value);
        if (!date) return options.missing === undefined ? '' : options.missing;
        const fmt = { timeStyle: 'short' };
        if (options.timeZone) fmt.timeZone = options.timeZone;
        return dateFormatter(localeFor(options.lang), fmt).format(date);
    }

    return Object.freeze({
        LOCALES,
        localeFor,
        currentLanguage,
        formatNumber,
        formatInteger,
        formatArea,
        formatLength,
        formatMoney,
        formatPercent,
        formatDateTime,
        formatDate,
        formatTime
    });
});
