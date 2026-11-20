// The Schelling plan's settings survive the address bar: what a link says is what its reader sees,
// and nothing outside the ranges (or a different arterial lattice) can be smuggled in. Both plan
// types: the meridians and parallels (the default) and a Burning Man city.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Settings = require('../../frontend/js/schelling/schelling-settings.js');
const Grid = require('../../frontend/js/parcels/schelling-grid.js');
const BurningMan = require('../../frontend/js/schelling/burning-man-plan.js');

describe('Schelling plan settings', () => {
    it('default to the meridian plan, with each module’s own defaults', () => {
        const { type, targetBlockM, streetWidthM, plotLevel, burningMan } = Settings.DEFAULTS;
        expect(type).toBe('meridians');
        expect({ targetBlockM, streetWidthM, plotLevel }).toEqual(Grid.DEFAULTS);
        const { centre, ...man } = burningMan;
        expect(centre).toBeNull();
        expect(man).toEqual(BurningMan.DEFAULTS);
        expect(Settings.format(Settings.DEFAULTS)).toBe('120-12-16');
    });

    it('round-trip the meridian plan through the address form', () => {
        for (const settings of [{ targetBlockM: 90, streetWidthM: 15, plotLevel: null }, { targetBlockM: 240, streetWidthM: 8, plotLevel: 0 }, { targetBlockM: 120, streetWidthM: 12, plotLevel: 3 }]) {
            expect(Settings.parse(Settings.format(settings))).toEqual({ type: 'meridians', ...settings });
        }
        expect(Settings.parse('100-10-1')).toEqual({ type: 'meridians', targetBlockM: 100, streetWidthM: 10, plotLevel: null });
        expect(Settings.parse('100-10-64').plotLevel).toBe(5);
    });

    it('round-trip a Burning Man city through the address form, the Man’s place included', () => {
        const settings = Settings.normalize({
            type: 'burning-man', plotLevel: 2,
            burningMan: { centre: { lat: 40.786958, lng: -119.202994 }, esplanadeM: 500, rings: 6, blockDepthM: 60, streetWidthM: 10, bearingDeg: 45 }
        });
        const text = Settings.format(settings);
        expect(text).toBe('bm-500-6-60-10-8-45@40.786958,-119.202994');
        expect(Settings.merge(Settings.DEFAULTS, Settings.parse(text))).toEqual(settings);
        // Without a place the address keeps the reader's Man where they had him.
        const elsewhere = Settings.merge(Settings.DEFAULTS, { burningMan: { centre: { lat: 45.8, lng: 15.98 } } });
        const read = Settings.merge(elsewhere, Settings.parse('bm-500-6-60-10-8-45'));
        expect(read.type).toBe('burning-man');
        expect(read.burningMan.centre).toEqual({ lat: 45.8, lng: 15.98 });
        // A meridian link switches the type and keeps the city's settings for later.
        const back = Settings.merge(settings, Settings.parse('120-12-16'));
        expect(back.type).toBe('meridians');
        expect(back.burningMan).toEqual(settings.burningMan);
    });

    it('bring values into range and refuse what is not a setting', () => {
        expect(Settings.parse('5-100-8')).toEqual({ type: 'meridians', targetBlockM: 60, streetWidthM: 20, plotLevel: 2 });
        expect(Settings.parse('123-12-16').targetBlockM).toBe(120);
        expect(Settings.parse('120-12-3')).toBeNull();
        expect(Settings.parse('120-12')).toBeNull();
        expect(Settings.parse('')).toBeNull();
        expect(Settings.normalize({ targetBlockM: 'x', plotLevel: 9 })).toEqual(Settings.DEFAULTS);
        expect(Settings.normalize({ type: 'hexagons' }).type).toBe('meridians');
        expect(Settings.parse('bm-9999-40-1-99-16-372@91,15')).toBeNull();
        expect(Settings.parse('bm-9999-40-1-99-16-372').burningMan).toEqual({ esplanadeM: 1500, rings: 12, blockDepthM: 20, streetWidthM: 20, bearingDeg: 10 });
        expect(Settings.parse('bm-760-11-76-12-3-0')).toBeNull();
    });

    it('always make a plan the grid can lay out', () => {
        const { RANGES } = Settings;
        for (const lat of [0, 45.8, -34.6, 60.2, 70]) {
            for (const targetBlockM of [RANGES.targetBlockM.min, RANGES.targetBlockM.max]) {
                for (const streetWidthM of [RANGES.streetWidthM.min, RANGES.streetWidthM.max]) {
                    expect(() => Grid.planFor({ lat, targetBlockM, streetWidthM })).not.toThrow();
                }
            }
        }
    });

    it('always make a Burning Man city the plan can lay out', () => {
        const ranges = Settings.RANGES.burningMan;
        const ends = range => [range.min, range.max];
        for (const esplanadeM of ends(ranges.esplanadeM)) {
            for (const rings of ends(ranges.rings)) {
                for (const blockDepthM of ends(ranges.blockDepthM)) {
                    for (const streetWidthM of ends(ranges.streetWidthM)) {
                        const plan = BurningMan.planFor({ centre: { lat: 60, lng: 10 }, esplanadeM, rings, blockDepthM, streetWidthM, bearingDeg: 355 });
                        expect(BurningMan.blockOf(plan, 0, 0).properties.area_m2).toBeGreaterThan(0);
                    }
                }
            }
        }
    });
});
