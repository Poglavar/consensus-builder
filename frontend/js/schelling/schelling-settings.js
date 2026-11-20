// The Schelling plan's settings: the plan type (the meridians and parallels by default, or a
// Burning Man city), what may be chosen in each (local street spacing and width; the Man's place,
// Esplanade, rings, block depth, street width and 12:00 bearing), the plot size both share, their
// ranges, and their form in the address bar, so a link shows what its author saw:
//   ?schelling=<block face>-<street width>-<plot>                      e.g. 120-12-16
//   ?schelling=bm-<esplanade>-<rings>-<depth>-<street>-<plot>-<bearing>@<lat>,<lng>
// Pure (backend/test/schelling-settings.test.js).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SchellingSettings = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const TYPES = Object.freeze(['meridians', 'burning-man']);
    const STREET_WIDTH = Object.freeze({ min: 8, max: 20, step: 1 });
    const RANGES = Object.freeze({
        targetBlockM: Object.freeze({ min: 60, max: 240, step: 10 }),
        streetWidthM: STREET_WIDTH,
        burningMan: Object.freeze({
            esplanadeM: Object.freeze({ min: 150, max: 1500, step: 10 }),
            rings: Object.freeze({ min: 1, max: 12, step: 1 }),
            blockDepthM: Object.freeze({ min: 20, max: 200, step: 1 }),
            streetWidthM: STREET_WIDTH,
            bearingDeg: Object.freeze({ min: 0, max: 355, step: 5 })
        })
    });
    // Plot sizes as the share of a block: 1 = whole blocks, then two rows halved 0..5 times.
    const PLOT_DENOMINATORS = Object.freeze([1, 2, 4, 8, 16, 32, 64]);
    // The Man has no default place: the layer puts him where the map is when the type is chosen.
    const DEFAULTS = Object.freeze({
        type: 'meridians', targetBlockM: 120, streetWidthM: 12, plotLevel: 3,
        burningMan: Object.freeze({ centre: null, esplanadeM: 760, rings: 11, blockDepthM: 76, streetWidthM: 12, bearingDeg: 0 })
    });

    const levelOfDenominator = denominator => (denominator === 1 ? null : Math.log2(denominator) - 1);
    const denominatorOfLevel = level => (level === null ? 1 : 2 * 2 ** level);

    function snap(value, { min, max, step }, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, min + Math.round((number - min) / step) * step));
    }

    // The bearing 12:00 points to goes round: 360 is 0 again.
    function bearingOf(value, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        const { step } = RANGES.burningMan.bearingDeg;
        return (((Math.round(number / step) * step) % 360) + 360) % 360;
    }

    // A place on the map to a micro-degree (about 0.1 m), or null.
    function centreOf(value) {
        const lat = Number(value?.lat);
        const lng = Number(value?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
        return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
    }

    // Any input to valid settings: out-of-range values are brought into range, unknown ones default.
    function normalize(input = {}) {
        const plot = input.plotLevel === null ? 1 : denominatorOfLevel(Number.isInteger(input.plotLevel) ? input.plotLevel : DEFAULTS.plotLevel);
        const man = input.burningMan || {};
        const ranges = RANGES.burningMan;
        const defaults = DEFAULTS.burningMan;
        return {
            type: TYPES.includes(input.type) ? input.type : DEFAULTS.type,
            targetBlockM: snap(input.targetBlockM, RANGES.targetBlockM, DEFAULTS.targetBlockM),
            streetWidthM: snap(input.streetWidthM, RANGES.streetWidthM, DEFAULTS.streetWidthM),
            plotLevel: PLOT_DENOMINATORS.includes(plot) ? levelOfDenominator(plot) : DEFAULTS.plotLevel,
            burningMan: {
                centre: centreOf(man.centre),
                esplanadeM: snap(man.esplanadeM, ranges.esplanadeM, defaults.esplanadeM),
                rings: snap(man.rings, ranges.rings, defaults.rings),
                blockDepthM: snap(man.blockDepthM, ranges.blockDepthM, defaults.blockDepthM),
                streetWidthM: snap(man.streetWidthM, ranges.streetWidthM, defaults.streetWidthM),
                bearingDeg: bearingOf(man.bearingDeg, defaults.bearingDeg)
            }
        };
    }

    // Settings with a part laid over them (what an address says over what a viewer had): the
    // other type's settings, and the Man's place when the part does not give one, are kept.
    function merge(base, part) {
        const from = normalize(base || {});
        return normalize({ ...from, ...(part || {}), burningMan: { ...from.burningMan, ...(part?.burningMan || {}) } });
    }

    // The address form of the chosen type only.
    function format(settings) {
        const value = normalize(settings);
        const plot = denominatorOfLevel(value.plotLevel);
        if (value.type === 'burning-man') {
            const man = value.burningMan;
            const at = man.centre ? `@${man.centre.lat},${man.centre.lng}` : '';
            return `bm-${man.esplanadeM}-${man.rings}-${man.blockDepthM}-${man.streetWidthM}-${plot}-${man.bearingDeg}${at}`;
        }
        return `${value.targetBlockM}-${value.streetWidthM}-${plot}`;
    }

    const NUMBER = '(\\d+(?:\\.\\d+)?)';
    const SIGNED = '(-?\\d+(?:\\.\\d+)?)';
    const MERIDIANS_FORM = new RegExp(`^${NUMBER}-${NUMBER}-(\\d+)$`);
    const BURNING_MAN_FORM = new RegExp(`^bm-${NUMBER}-(\\d+)-${NUMBER}-${NUMBER}-(\\d+)-${NUMBER}(?:@${SIGNED},${SIGNED})?$`);

    // The address form back to the part of the settings it carries (the type, its settings and the
    // plot size); null when the text is not one. Lay it over other settings with merge().
    function parse(text) {
        const value = String(text || '').trim();
        const meridians = MERIDIANS_FORM.exec(value);
        if (meridians) {
            const denominator = Number(meridians[3]);
            if (!PLOT_DENOMINATORS.includes(denominator)) return null;
            const settings = normalize({ targetBlockM: Number(meridians[1]), streetWidthM: Number(meridians[2]), plotLevel: levelOfDenominator(denominator) });
            return { type: 'meridians', targetBlockM: settings.targetBlockM, streetWidthM: settings.streetWidthM, plotLevel: settings.plotLevel };
        }
        const man = BURNING_MAN_FORM.exec(value);
        if (!man) return null;
        const denominator = Number(man[5]);
        if (!PLOT_DENOMINATORS.includes(denominator)) return null;
        const settings = normalize({
            type: 'burning-man', plotLevel: levelOfDenominator(denominator),
            burningMan: {
                esplanadeM: Number(man[1]), rings: Number(man[2]), blockDepthM: Number(man[3]), streetWidthM: Number(man[4]), bearingDeg: Number(man[6]),
                centre: man[7] === undefined ? null : { lat: Number(man[7]), lng: Number(man[8]) }
            }
        });
        const { centre, ...rest } = settings.burningMan;
        if (man[7] !== undefined && !centre) return null;
        return { type: 'burning-man', plotLevel: settings.plotLevel, burningMan: centre ? { ...rest, centre } : rest };
    }

    return { TYPES, RANGES, PLOT_DENOMINATORS, DEFAULTS, normalize, merge, format, parse, levelOfDenominator, denominatorOfLevel };
});
