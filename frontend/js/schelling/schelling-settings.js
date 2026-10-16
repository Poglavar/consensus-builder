// The Schelling plan's settings: what may be chosen (local street spacing and width, plot size),
// their ranges, and their form in the address bar (?schelling=<block face>-<street width>-<plot>,
// e.g. 120-12-16), so a link shows what its author saw. Pure (backend/test/schelling-settings.test.js).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SchellingSettings = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const RANGES = Object.freeze({
        targetBlockM: Object.freeze({ min: 60, max: 240, step: 10 }),
        streetWidthM: Object.freeze({ min: 8, max: 20, step: 1 })
    });
    // Plot sizes as the share of a block: 1 = whole blocks, then two rows halved 0..5 times.
    const PLOT_DENOMINATORS = Object.freeze([1, 2, 4, 8, 16, 32, 64]);
    const DEFAULTS = Object.freeze({ targetBlockM: 120, streetWidthM: 12, plotLevel: 3 });

    const levelOfDenominator = denominator => (denominator === 1 ? null : Math.log2(denominator) - 1);
    const denominatorOfLevel = level => (level === null ? 1 : 2 * 2 ** level);

    function snap(value, { min, max, step }, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, min + Math.round((number - min) / step) * step));
    }

    // Any input to valid settings: out-of-range values are brought into range, unknown ones default.
    function normalize(input = {}) {
        const plot = input.plotLevel === null ? 1 : denominatorOfLevel(Number.isInteger(input.plotLevel) ? input.plotLevel : DEFAULTS.plotLevel);
        return {
            targetBlockM: snap(input.targetBlockM, RANGES.targetBlockM, DEFAULTS.targetBlockM),
            streetWidthM: snap(input.streetWidthM, RANGES.streetWidthM, DEFAULTS.streetWidthM),
            plotLevel: PLOT_DENOMINATORS.includes(plot) ? levelOfDenominator(plot) : DEFAULTS.plotLevel
        };
    }

    function format(settings) {
        const value = normalize(settings);
        return `${value.targetBlockM}-${value.streetWidthM}-${denominatorOfLevel(value.plotLevel)}`;
    }

    // The address form back to settings; null when the text is not one.
    function parse(text) {
        const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-(\d+)$/.exec(String(text || '').trim());
        if (!match) return null;
        const denominator = Number(match[3]);
        if (!PLOT_DENOMINATORS.includes(denominator)) return null;
        return normalize({ targetBlockM: Number(match[1]), streetWidthM: Number(match[2]), plotLevel: levelOfDenominator(denominator) });
    }

    return { RANGES, PLOT_DENOMINATORS, DEFAULTS, normalize, format, parse, levelOfDenominator, denominatorOfLevel };
});
