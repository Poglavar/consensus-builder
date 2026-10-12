// Shift+drag box selection (frontend/js/parcels/ui/box-select.js): a parcel joins the selection when
// its outline touches the box, not when only its bounding rectangle does.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { booleanIntersects } from '@turf/turf';

const require = createRequire(import.meta.url);
const { parcelsInBox } = require('../../frontend/js/parcels/ui/box-select.js');

const square = (id, w, s, e, n) => ({
    id, bounds: [w, s, e, n],
    feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }
});
// An L-shaped parcel whose bounding rectangle covers the box's corner while its outline does not.
const ell = {
    id: 'ell', bounds: [0, 0, 10, 10],
    feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10], [0, 0]]] } }
};

describe('parcels in a Shift+drag box', () => {
    it('takes parcels the box touches or contains and leaves those its rectangle only overlaps', () => {
        const candidates = [square('inside', 5, 5, 6, 6), square('crossing', 7, 7, 12, 12), square('outside', 20, 20, 21, 21), ell];
        expect(parcelsInBox(candidates, [4, 4, 8, 8], booleanIntersects)).toEqual(['inside', 'crossing']);
    });

    it('counts an edge touch as touching', () => {
        expect(parcelsInBox([square('edge', 8, 4, 9, 5)], [4, 4, 8, 8], booleanIntersects)).toEqual(['edge']);
    });
});
