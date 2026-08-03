// parcel-contiguity.js — a parcel is ONE connected piece of ground. A cut landing in two
// disconnected areas mints two parcels, never one parcel in two places.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pc;

beforeAll(() => {
    pc = require('../../frontend/js/proposals/parcel-contiguity.js');
});

const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

function polygon(x0, y0, x1, y1, properties = {}) {
    return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [ring(x0, y0, x1, y1)] } };
}

function multi(boxes, properties = {}) {
    return {
        type: 'Feature',
        properties,
        geometry: { type: 'MultiPolygon', coordinates: boxes.map(b => [ring(...b)]) }
    };
}

// Area of an axis-aligned polygon part, good enough to exercise the threshold logic.
const areaOf = f => {
    const r = f.geometry.coordinates[0];
    const xs = r.map(p => p[0]);
    const ys = r.map(p => p[1]);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
};

describe('partCount / isContiguous', () => {
    it('counts a polygon as one piece, holes included', () => {
        const withHole = {
            type: 'Feature', properties: {},
            geometry: { type: 'Polygon', coordinates: [ring(0, 0, 10, 10), ring(3, 3, 6, 6)] }
        };
        expect(pc.partCount(withHole)).toBe(1);
        expect(pc.isContiguous(withHole)).toBe(true);
    });

    it('counts each disconnected member of a MultiPolygon', () => {
        const m = multi([[0, 0, 5, 5], [20, 20, 25, 25]]);
        expect(pc.partCount(m)).toBe(2);
        expect(pc.isContiguous(m)).toBe(false);
    });

    it('is zero for non-polygonal input', () => {
        expect(pc.partCount({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } })).toBe(0);
        expect(pc.partCount(null)).toBe(0);
    });
});

describe('explodeToContiguousParts', () => {
    it('returns the feature untouched when it is already one piece', () => {
        const p = polygon(0, 0, 5, 5);
        expect(pc.explodeToContiguousParts(p)).toEqual([p]);
    });

    it('splits a two-part parcel into two single-polygon features', () => {
        const parts = pc.explodeToContiguousParts(multi([[0, 0, 5, 5], [20, 20, 25, 25]], { ownerKey: 'o1' }));
        expect(parts).toHaveLength(2);
        parts.forEach(part => expect(part.geometry.type).toBe('Polygon'));
        expect(parts[0].properties.ownerKey).toBe('o1');
    });

    it('never carries the parent identity onto the pieces', () => {
        const parts = pc.explodeToContiguousParts(
            multi([[0, 0, 5, 5], [20, 20, 25, 25]], { parcelId: 'HR-1-2#c-road-1', BROJ_CESTICE: '1/2', syntheticIndex: 1, keep: 'yes' })
        );
        parts.forEach(part => {
            expect(part.properties.parcelId).toBeUndefined();
            expect(part.properties.BROJ_CESTICE).toBeUndefined();
            expect(part.properties.syntheticIndex).toBeUndefined();
            expect(part.properties.keep).toBe('yes');
        });
    });

    it('drops sub-threshold slivers when given an area function', () => {
        const parts = pc.explodeToContiguousParts(multi([[0, 0, 10, 10], [50, 50, 50.2, 50.2]]), { minAreaM2: 1, areaOf });
        expect(parts).toHaveLength(1);
        expect(areaOf(parts[0])).toBe(100);
    });

    it('keeps the largest piece rather than minting nothing when all are sub-threshold', () => {
        const parts = pc.explodeToContiguousParts(multi([[0, 0, 0.5, 0.5], [9, 9, 9.2, 9.2]]), { minAreaM2: 100, areaOf });
        expect(parts).toHaveLength(1);
        expect(areaOf(parts[0])).toBeCloseTo(0.25, 5);
    });
});

describe('explodeAll', () => {
    it('expands only the offending entries and preserves order', () => {
        const out = pc.explodeAll([
            polygon(0, 0, 1, 1, { tag: 'a' }),
            multi([[10, 10, 11, 11], [20, 20, 21, 21]], { tag: 'b' }),
            polygon(30, 30, 31, 31, { tag: 'c' })
        ]);
        expect(out.map(f => f.properties.tag)).toEqual(['a', 'b', 'b', 'c']);
        out.forEach(f => expect(pc.isContiguous(f)).toBe(true));
    });

    it('skips empties and tolerates a non-array', () => {
        expect(pc.explodeAll(null)).toEqual([]);
        expect(pc.explodeAll([null, undefined])).toEqual([]);
    });
});
