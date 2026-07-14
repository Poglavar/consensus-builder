// The one place that turns an ownership share or a proposal offer into display text.
//
// It exists because the same two formatters were re-implemented inline in several UI files and the
// copies disagreed: a fallback percent formatter stripped trailing zeros from WHOLE numbers, so a
// 100% owner rendered as "1%" (and 50% as "5%"); and the offer formatter rounded to the nearest
// integer, so every agent proposal — budgets are 0.01–0.05 ETH — displayed its offer as "0 ETH".
// Keeping one tested copy is what stops those from drifting back.
//
// No DOM, no Leaflet: plain values in, strings out, so backend/test can require() it.

(function (global) {
    'use strict';

    // A percentage value already in the 0–100 range → "12.5%". Trailing zeros are trimmed only
    // AFTER a decimal point, never from a whole number — that is the bug the inline copies had.
    function formatPercentValue(value) {
        if (!Number.isFinite(value)) {
            return '';
        }
        const abs = Math.abs(value);
        const decimals = abs >= 10 ? 0 : (abs >= 1 ? 1 : 2);
        const formatted = value.toFixed(decimals);
        const cleaned = formatted.includes('.') ? formatted.replace(/\.?0+$/, '') : formatted;
        return `${cleaned}%`;
    }

    // A raw share string ("50%", "1/2", "0.5", "50") → a normalized percent string. A bare number
    // <= 1 is read as a fraction (0.5 → "50%"); a bare number > 1 is read as an already-percent
    // value (50 → "50%"). Fractions like "1/2" need a parseFraction resolver; pass one in options,
    // else the global is used (browser). Returns the input unchanged if it can't be parsed.
    function formatSharePercent(shareText, options = {}) {
        const share = (shareText || '').toString().trim();
        if (!share) {
            return '';
        }
        if (share.endsWith('%')) {
            return share;
        }
        const parse = typeof options.parseFraction === 'function'
            ? options.parseFraction
            : (typeof global.parseFraction === 'function' ? global.parseFraction : null);
        if (parse && share.includes('/')) {
            const fraction = parse(share);
            if (fraction && Number.isFinite(fraction.numerator) && Number.isFinite(fraction.denominator) && fraction.denominator !== 0) {
                const pct = (fraction.numerator / fraction.denominator) * 100;
                if (Number.isFinite(pct)) {
                    return formatPercentValue(pct);
                }
            }
        }
        const num = Number(share);
        if (Number.isFinite(num)) {
            const pct = num <= 1 ? num * 100 : num;
            return formatPercentValue(pct);
        }
        return share;
    }

    // A proposal's offer → { symbol, value, suffix, display } or null when there is no positive
    // offer. EUR is rounded and locale-grouped (€1.000); every other currency is treated as crypto
    // and keeps sub-unit precision (0.03 ETH stays "0.03 ETH", never "0 ETH").
    function formatOffer(rawValue, currencyRaw) {
        const amount = Number(rawValue);
        if (!Number.isFinite(amount) || amount <= 0) {
            return null;
        }
        const currency = (typeof currencyRaw === 'string' ? currencyRaw : (currencyRaw || 'ETH'))
            .toString().toUpperCase();
        const isEur = currency === 'EUR';
        const symbol = isEur ? '€' : '';
        const suffix = (currency && !isEur) ? ` ${currency}` : '';
        let value;
        if (isEur) {
            value = Math.round(amount).toLocaleString('hr-HR');
        } else {
            const fixed = amount >= 1 ? amount.toFixed(2) : amount.toFixed(4);
            // Trim trailing zeros so 0.0300 → 0.03, but keep at least one digit after the point
            // absent (a whole number like "5.00" → "5").
            value = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
        }
        return { symbol, value, suffix, display: `${symbol}${value}${suffix}` };
    }

    if (typeof window !== 'undefined') {
        window.formatPercentValue = formatPercentValue;
        window.formatSharePercent = formatSharePercent;
        window.formatOffer = formatOffer;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { formatPercentValue, formatSharePercent, formatOffer };
    }
})(typeof window !== 'undefined' ? window : globalThis);
