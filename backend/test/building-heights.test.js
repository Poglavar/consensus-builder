// Heights for footprints that may carry none (buildings/building-heights.js): measured beats storeys
// beats a seeded estimate, the estimate is stable per building id, and its range follows the OSM
// building type before the footprint area.

import { describe, it, expect } from 'vitest';
import { resolveBuildingHeight, footprintAreaM2 } from '../buildings/building-heights.js';

const square = metres => {
    const d = metres / 111320;
    return { type: 'Polygon', coordinates: [[[0, 0], [d, 0], [d, d], [0, d], [0, 0]]] };
};

describe('building heights', () => {
    it('prefers a measured height, then storeys × 3 m', () => {
        expect(resolveBuildingHeight({ id: 'w1', heightM: 21.5, levels: 4 })).toEqual({ heightM: 21.5, floors: 4, source: 'measured' });
        expect(resolveBuildingHeight({ id: 'w1', heightM: null, levels: 5 })).toEqual({ heightM: 15, floors: 5, source: 'levels' });
        expect(resolveBuildingHeight({ id: 'w1', heightM: '0', levels: '2' })).toEqual({ heightM: 6, floors: 2, source: 'levels' });
    });

    it('estimates a stable height per building id, within its range', () => {
        const a = resolveBuildingHeight({ id: 'w42', building: 'apartments' });
        expect(resolveBuildingHeight({ id: 'w42', building: 'apartments' })).toEqual(a);
        expect(a.source).toBe('estimated');
        expect(a.floors).toBeGreaterThanOrEqual(3);
        expect(a.floors).toBeLessThanOrEqual(8);
        expect(a.heightM).toBe(a.floors * 3);
        const spread = new Set(Array.from({ length: 50 }, (_, i) => resolveBuildingHeight({ id: `w${i}`, building: 'apartments' }).floors));
        expect(spread.size).toBeGreaterThan(2);
    });

    it('keeps typed small structures at one storey and sizes untyped ones by area', () => {
        expect(resolveBuildingHeight({ id: 'w9', building: 'garage', areaM2: 5000 }).floors).toBe(1);
        for (let i = 0; i < 30; i++) {
            expect(resolveBuildingHeight({ id: `s${i}`, building: 'yes', areaM2: 30 }).floors).toBeLessThanOrEqual(2);
            expect(resolveBuildingHeight({ id: `b${i}`, building: 'yes', areaM2: 3000 }).floors).toBeGreaterThanOrEqual(3);
        }
    });

    it('measures a footprint area in square metres', () => {
        expect(footprintAreaM2(square(20))).toBeGreaterThan(380);
        expect(footprintAreaM2(square(20))).toBeLessThan(420);
        expect(footprintAreaM2(null)).toBe(0);
    });
});
