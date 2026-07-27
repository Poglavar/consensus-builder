// How a reparcellization plan reads owner shares. A share can be written as a percent ("50%"), a
// fraction ("1/2"), a decimal fraction ("0.5") or a bare number ("50"). These become relative
// weights that normalizeOwnerSlots turns into fractions of the whole.
//
// It exists as its own module because parseShareValue had a live bug: a bare "50" was read as the
// literal weight 50, not as 50%, so a "50" owner sitting next to a "1/2" owner normalized to
// 99% / 1% instead of 50 / 50 — a wrong land allocation, silently. A bare number > 1 is now read as
// a percentage the user typed without the sign.
//
// No DOM, no turf — plain values in, so backend/test can require() it.

(function (global) {
    'use strict';

    function parseShareValue(rawValue) {
        if (!rawValue && rawValue !== 0) return NaN;
        const value = String(rawValue).trim();
        if (!value) return NaN;
        const percentMatch = value.match(/^(\d+(?:\.\d+)?)\s*%$/);
        if (percentMatch) {
            const pct = parseFloat(percentMatch[1]);
            return Number.isFinite(pct) ? pct / 100 : NaN;
        }
        const fractionMatch = value.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (fractionMatch) {
            const numerator = parseFloat(fractionMatch[1]);
            const denominator = parseFloat(fractionMatch[2]);
            if (denominator === 0) return NaN;
            return numerator / denominator;
        }
        const asNumber = parseFloat(value);
        if (Number.isFinite(asNumber) && asNumber >= 0) {
            // A bare number > 1 is a percentage typed without the sign ("50" = 50%); a bare number
            // in [0, 1] is already a fraction ("0.5" = 50%). This is what lets "50" and "1/2" agree.
            return asNumber > 1 ? asNumber / 100 : asNumber;
        }
        return NaN;
    }

    function normalizeOwnerSlots(slots) {
        if (!Array.isArray(slots) || !slots.length) return [];
        const parsed = slots.map(slot => {
            const fromText = parseShareValue(slot.shareText);
            const fromDetail = parseShareValue(slot.shareDetail);
            let value = Number.isFinite(fromDetail) ? fromDetail : fromText;
            if (!Number.isFinite(value) || value <= 0) {
                value = 0;
            }
            return { slot, value };
        });
        const total = parsed.reduce((sum, entry) => sum + entry.value, 0);
        if (total <= 0) {
            const equalShare = 1 / parsed.length;
            return parsed.map(entry => ({ slot: entry.slot, fraction: equalShare }));
        }
        return parsed.map(entry => ({ slot: entry.slot, fraction: entry.value / total }));
    }

    const api = { parseShareValue, normalizeOwnerSlots };

    if (typeof window !== 'undefined') {
        window.ReparcellizationShares = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
