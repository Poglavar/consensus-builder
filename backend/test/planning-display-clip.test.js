// A zone cut to a map cell keeps a valid outline: parts and holes outside the cell are dropped, never
// left as empty rings that made the whole zone fail validation and vanish from the map.
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { clipToBounds } from '../planning/display-clip.js';
import { validateGeometry } from '../parcels/source-contract.js';

const square = (x0, y0, x1, y1) => turf.bboxPolygon([x0, y0, x1, y1]).geometry.coordinates[0];

describe('a zone clipped to a map cell', () => {
    it('drops a part outside the cell and keeps the part inside', () => {
        const zone = turf.multiPolygon([[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]]);
        const clipped = clipToBounds(zone, [0.5, 0.5, 2, 2]);
        expect(validateGeometry(clipped)).toBe(true);
        expect(clipped.type).toBe('Polygon');
        expect(turf.area(turf.feature(clipped))).toBeCloseTo(turf.area(turf.bboxPolygon([0.5, 0.5, 1, 1])), -2);
        // Unclipped by this module, the same cut fails validation: the zone vanished from the map.
        expect(validateGeometry(turf.bboxClip(zone, [0.5, 0.5, 2, 2]).geometry)).toBe(false);
    });
    it('drops a hole outside the cell, keeps one inside, and gives null when nothing is inside', () => {
        const zone = turf.polygon([square(0, 0, 10, 10), square(1, 1, 2, 2), square(7, 7, 8, 8)]);
        const clipped = clipToBounds(zone, [0, 0, 5, 5]);
        expect(validateGeometry(clipped)).toBe(true);
        expect(clipped.coordinates).toHaveLength(2);
        expect(clipToBounds(turf.polygon([square(0, 0, 1, 1)]), [3, 3, 4, 4])).toBeNull();
    });
});
