// The Schelling plan's settings survive the address bar: what a link says is what its reader sees,
// and nothing outside the ranges (or a different arterial lattice) can be smuggled in.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Settings = require('../../frontend/js/schelling/schelling-settings.js');
const Grid = require('../../frontend/js/parcels/schelling-grid.js');

describe('Schelling plan settings', () => {
    it('default to the grid module’s defaults', () => {
        expect(Settings.DEFAULTS).toEqual(Grid.DEFAULTS);
        expect(Settings.format(Settings.DEFAULTS)).toBe('120-12-16');
    });

    it('round-trip through the address form', () => {
        for (const settings of [{ targetBlockM: 90, streetWidthM: 15, plotLevel: null }, { targetBlockM: 240, streetWidthM: 8, plotLevel: 0 }, Settings.DEFAULTS]) {
            expect(Settings.parse(Settings.format(settings))).toEqual(settings);
        }
        expect(Settings.parse('100-10-1')).toEqual({ targetBlockM: 100, streetWidthM: 10, plotLevel: null });
        expect(Settings.parse('100-10-64').plotLevel).toBe(5);
    });

    it('bring values into range and refuse what is not a setting', () => {
        expect(Settings.parse('5-100-8')).toEqual({ targetBlockM: 60, streetWidthM: 20, plotLevel: 2 });
        expect(Settings.parse('123-12-16').targetBlockM).toBe(120);
        expect(Settings.parse('120-12-3')).toBeNull();
        expect(Settings.parse('120-12')).toBeNull();
        expect(Settings.parse('')).toBeNull();
        expect(Settings.normalize({ targetBlockM: 'x', plotLevel: 9 })).toEqual(Settings.DEFAULTS);
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
});
