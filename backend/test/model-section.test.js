// Tests for frontend/js/model-section.js: the storeys X-ray finds in an uploaded building model's
// horizontal surfaces, and the height its section cuts at.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const section = require('../../frontend/js/model-section.js');

// A slab's top and bottom faces, each a floor plate of `areaM2`.
const slab = (topM, areaM2, thicknessM = 0.4) => [{ z: topM, areaM2 }, { z: topM - thicknessM, areaM2 }];

describe('model storeys', () => {
    // A building with one basement, three storeys and a roof, plus the flat bits a model carries.
    const faces = [
        ...slab(-3.5, 1200), ...slab(0, 900), ...slab(3.5, 800), ...slab(7, 800), ...slab(10.5, 800),
        // stair treads every 17 cm, a table, window sills: none is a floor
        ...Array.from({ length: 20 }, (_, i) => ({ z: 0.17 * (i + 1), areaM2: 1.2 })),
        { z: 4.25, areaM2: 2 }, { z: 0.9, areaM2: 0.3 }
    ];

    it('finds each slab as one storey at its top, the ground storey as level 0 and the roof as none', () => {
        expect(section.storeysOf(faces).map(storey => [storey.level, storey.elevationM])).toEqual([[-1, -3.5], [0, 0], [1, 3.5], [2, 7]]);
    });

    it('is independent of face order and has no storeys without horizontal surfaces', () => {
        expect(section.storeysOf([...faces].reverse())).toEqual(section.storeysOf(faces));
        expect(section.storeysOf([])).toEqual([]);
        expect(section.storeysOf([{ z: Number.NaN, areaM2: 10 }, { z: 1, areaM2: -4 }])).toEqual([]);
    });

    it('cuts 1.2 m above the chosen storey, the highest when none is chosen', () => {
        const storeys = section.storeysOf(faces);
        expect(section.sectionHeightM(storeys, null)).toBeCloseTo(8.2);
        expect(section.sectionHeightM(storeys, 0)).toBeCloseTo(1.2);
        expect(section.sectionHeightM(storeys, -1)).toBeCloseTo(-2.3);
        // a level the model lacks: the nearest storey below, or the lowest
        expect(section.sectionHeightM(storeys, 9)).toBeCloseTo(8.2);
        expect(section.sectionHeightM(storeys, -4)).toBeCloseTo(-2.3);
        expect(section.sectionHeightM([], null)).toBeNull();
    });
});
