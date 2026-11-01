// Highlight by use (building-use-highlight.js): which storeys of a building light up for the ticked
// storey uses, how 2D styles a footprint, and how the 3D pass swaps and restores mesh materials,
// with a band material for a building lit in part.
import { describe, expect, it, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const use = require('../../frontend/js/building-use.js');
const highlight = require('../../frontend/js/building-use-highlight.js');

const mesh = (storeys, material = { id: 'own' }) => ({ isMesh: true, material, userData: storeys ? { buildingStoreys: storeys } : {} });
const group = (...children) => ({ traverse: visit => children.forEach(visit) });
const materials = () => ({
    materialFor: category => ({ id: `lit:${category}` }),
    faded: { id: 'faded' },
    bandMaterial: bands => ({ id: 'bands', bands, disposed: false, dispose() { this.disposed = true; } })
});

beforeEach(() => highlight.clear());

describe('a building\'s storey uses', () => {
    it('follows its stated use, storey by storey', () => {
        expect(highlight.storeysOf({ use: 'mixed' }, { floors: 4 })).toEqual(['shop', 'office', 'residential', 'residential']);
        expect(highlight.storeysOf({ use: 'office', floors: 3 })).toEqual(['office', 'office', 'office']);
        expect(highlight.storeysOf({}, { floors: 3 })).toEqual(['none']);
    });
    it('gives a housing rule building the suggested layout\'s ground floor: shops under a Block of five storeys or more', () => {
        expect(highlight.storeysOf({ urbanRule: { typology: 'block' } }, { floors: 5 })).toEqual(['shop', 'residential', 'residential', 'residential', 'residential']);
        expect(highlight.storeysOf({ urbanRule: { typology: 'block' } }, { floors: 4 })).toEqual(new Array(4).fill('residential'));
        expect(highlight.storeysOf({ urbanRule: { typology: 'row' } }, { floors: 6 })).toEqual(new Array(6).fill('residential'));
        expect(highlight.storeysOf({ urbanRule: { typology: 'parcelBased' } }, { floors: 2 })).toEqual(['residential', 'residential']);
        expect(use.autoGroundFloorUse('block', 5)).toBe('commercial');
    });
    it('counts storeys from the height when none are stated', () => {
        expect(highlight.storeysOf({ use: 'residential-shops' }, { heightM: 10 })).toEqual(['shop', 'residential', 'residential']);
    });
});

describe('the ticked uses', () => {
    it('merge a building\'s storeys into lit and faded bands', () => {
        highlight.setSelected('shop', true);
        expect(highlight.bands(['shop', 'residential', 'residential', 'residential'])).toEqual([
            { category: 'shop', lit: true, from: 0, to: 0.25 }, { category: null, lit: false, from: 0.25, to: 1 }]);
        highlight.setSelected('residential', true);
        expect(highlight.bands(['shop', 'residential']).map(band => band.category)).toEqual(['shop', 'residential']);
    });
    it('style a 2D footprint by its highest ticked storey, fade the rest, and leave the map alone with nothing ticked', () => {
        const base = { color: '#123456', fillColor: '#123456', fillOpacity: 0.4 };
        expect(highlight.style2d(base, ['shop', 'residential'])).toBe(base);
        highlight.setSelected('shop', true);
        expect(highlight.style2d(base, ['shop', 'residential'])).toMatchObject({ fillColor: highlight.COLORS.shop, fillOpacity: 0.85 });
        expect(highlight.style2d(base, ['office'])).toMatchObject({ fillColor: '#123456', opacity: 0.25 });
        highlight.setSelected('residential', true);
        expect(highlight.style2d(base, ['shop', 'residential']).fillColor).toBe(highlight.COLORS.residential);
    });
    it('tell the views when they change, once per change', () => {
        let calls = 0;
        const off = highlight.onChange(() => { calls += 1; });
        highlight.setSelected('office', true); highlight.setSelected('office', true); highlight.clear(); highlight.clear();
        off();
        expect(calls).toBe(2);
        expect(() => highlight.setSelected('spaceport', true)).toThrow(/Unknown storey use/);
    });
});

describe('the 3D pass', () => {
    it('lights whole buildings, bands a building lit in part, fades the rest, and restores every mesh', () => {
        const office = mesh(['office', 'office']), shops = mesh(['shop', 'residential', 'residential']), untagged = mesh(null);
        const helper = mesh(['office']); helper.userData.depth = true;
        const groups = [group(office, shops, untagged, helper)];
        const deps = { ...materials(), skip: object => object.userData.depth === true };
        expect(highlight.apply3d(groups, deps)).toBe(0);
        highlight.setSelected('office', true);
        highlight.setSelected('shop', true);
        highlight.apply3d(groups, deps);
        expect(office.material.id).toBe('lit:office');
        expect(shops.material.id).toBe('bands');
        expect(shops.material.bands.map(band => [band.color, band.opacity])).toEqual([[highlight.COLORS.shop, 1], [highlight.COLORS.none, highlight.FADED_OPACITY]]);
        expect(untagged.material.id).toBe('faded');
        expect(helper.material.id).toBe('own');
        const banded = shops.material;
        highlight.clear();
        highlight.apply3d(groups, deps);
        expect([office, shops, untagged].map(object => object.material.id)).toEqual(['own', 'own', 'own']);
        expect(banded.disposed).toBe(true);
        expect(highlight.apply3d(groups, deps)).toBe(0);
    });
});
