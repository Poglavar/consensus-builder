import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeDecorations, boundaryFeature } = require('../../frontend/js/structure-geometry-editor.js');

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

    it('accepts polygon features and rejects point geometry as boundaries', () => {
        const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        expect(boundaryFeature({ type: 'Feature', properties: {}, geometry: polygon })).toEqual({ type: 'Feature', properties: {}, geometry: polygon });
        expect(boundaryFeature({ type: 'Point', coordinates: [0, 0] })).toBeNull();
    });
});
