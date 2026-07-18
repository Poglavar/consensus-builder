import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    normalizeDecorations,
    boundaryFeature,
    hasExplicitDecorationDesign,
    translateCoordinateCollection
} = require('../../frontend/js/structure-geometry-editor.js');

describe('structure geometry editor data normalization', () => {
    it('upgrades a legacy square fountain and normalizes bench bearings', () => {
        const normalized = normalizeDecorations('square', {
            fountain: [15.9, 45.8],
            benches: [{ coordinate: [15.91, 45.81], bearing: -15 }]
        });

        expect(normalized.fountains).toEqual([[15.9, 45.8]]);
        expect(normalized.benches).toEqual([{ coordinate: [15.91, 45.81], bearing: 345 }]);
    });

    it('keeps only valid park point and path coordinates', () => {
        const normalized = normalizeDecorations('park', {
            trees: [[15.9, 45.8], ['bad', 45.8]],
            paths: [[[15.9, 45.8], [15.91, 45.81]], [[15.9, 45.8]]]
        });

        expect(normalized.trees).toEqual([[15.9, 45.8]]);
        expect(normalized.paths).toEqual([[[15.9, 45.8], [15.91, 45.81]]]);
    });

    it('normalizes park benches as first-class point objects', () => {
        const normalized = normalizeDecorations('park', {
            benches: [{ coordinate: [15.9, 45.8], bearing: 400 }, [15.91, 45.81], { coordinate: ['bad', 45.8] }]
        });

        expect(normalized.benches).toEqual([
            { coordinate: [15.9, 45.8], bearing: 40 },
            { coordinate: [15.91, 45.81], bearing: 0 }
        ]);
    });

    it('normalizes square stalls and statues as plain coordinate lists', () => {
        const normalized = normalizeDecorations('square', {
            stalls: [[15.9, 45.8], ['bad', 45.8]],
            statues: [[15.92, 45.82], null]
        });

        expect(normalized.stalls).toEqual([[15.9, 45.8]]);
        expect(normalized.statues).toEqual([[15.92, 45.82]]);
    });

    it('accepts polygon features and rejects point geometry as boundaries', () => {
        const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        expect(boundaryFeature({ type: 'Feature', properties: {}, geometry: polygon })).toEqual({ type: 'Feature', properties: {}, geometry: polygon });
        expect(boundaryFeature({ type: 'Point', coordinates: [0, 0] })).toBeNull();
    });

    it('treats an explicitly emptied design as saved, but not a legacy empty object', () => {
        expect(hasExplicitDecorationDesign('park', { trees: [], paths: [], version: 3 })).toBe(true);
        expect(hasExplicitDecorationDesign('square', { fountains: [] })).toBe(true);
        expect(hasExplicitDecorationDesign('park', {})).toBe(false);
        expect(hasExplicitDecorationDesign('square', null)).toBe(false);
    });

    it('translates an entire path or area without changing its shape', () => {
        const source = [[15.9, 45.8], [15.91, 45.81], [15.92, 45.8]];
        const moved = translateCoordinateCollection(source, 0.02, -0.01);

        [[15.92, 45.79], [15.93, 45.8], [15.94, 45.79]].forEach((expected, index) => {
            expect(moved[index][0]).toBeCloseTo(expected[0], 10);
            expect(moved[index][1]).toBeCloseTo(expected[1], 10);
        });
        expect(source).toEqual([[15.9, 45.8], [15.91, 45.81], [15.92, 45.8]]);
    });
});
