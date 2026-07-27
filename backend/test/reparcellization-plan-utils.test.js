import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    computeJointProRataShares,
    deriveCourtyardFromFootprint,
    splitPlanPerParcel
} = require('../../frontend/js/reparcellization-plan-utils.js');

describe('computeJointProRataShares', () => {
    it('assigns shares in proportion to recipient weights', () => {
        const shares = computeJointProRataShares([
            { ownerKey: 'a', weight: 2 },
            { ownerKey: 'b', weight: 1 }
        ]);

        expect(shares[0].ownerKey).toBe('a');
        expect(shares[0].share).toBeCloseTo(2 / 3);
        expect(shares[1].ownerKey).toBe('b');
        expect(shares[1].share).toBeCloseTo(1 / 3);
    });

    it('falls back to equal shares when all weights are zero', () => {
        expect(computeJointProRataShares([
            { ownerKey: 'a', weight: 0 },
            { ownerKey: 'b', weight: 0 }
        ])).toEqual([
            { ownerKey: 'a', share: 0.5 },
            { ownerKey: 'b', share: 0.5 }
        ]);
    });

    it('corrects the final uneven share so the sum is exactly one', () => {
        const shares = computeJointProRataShares([
            { ownerKey: 'a', weight: 7 },
            { ownerKey: 'b', weight: 3 },
            { ownerKey: 'c', weight: 1 }
        ]);

        expect(shares.reduce((sum, entry) => sum + entry.share, 0)).toBe(1);
    });

    it('assigns the whole pool to a single recipient', () => {
        expect(computeJointProRataShares([
            { ownerKey: 'only', weight: 12 }
        ])).toEqual([{ ownerKey: 'only', share: 1 }]);
    });
});

describe('deriveCourtyardFromFootprint', () => {
    const outer = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]];
    const hole = [[1, 1], [1, 4], [4, 4], [4, 1], [1, 1]];

    it('turns a polygon interior ring into a courtyard polygon', () => {
        const result = deriveCourtyardFromFootprint({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [outer, hole] }
        });

        expect(result.geometry.type).toBe('Polygon');
        expect(result.geometry.coordinates[0]).toEqual(hole.slice().reverse());
    });

    it('collects holes from every part of a multipolygon', () => {
        const secondOuter = outer.map(([x, y]) => [x + 10, y]);
        const secondHole = hole.map(([x, y]) => [x + 10, y]);
        const result = deriveCourtyardFromFootprint({
            type: 'MultiPolygon',
            coordinates: [[outer], [secondOuter, secondHole]]
        });

        expect(result.geometry).toEqual({
            type: 'Polygon',
            coordinates: [secondHole.slice().reverse()]
        });
    });

    it('returns null for a footprint without an interior ring', () => {
        expect(deriveCourtyardFromFootprint({
            type: 'Polygon',
            coordinates: [outer]
        })).toBeNull();
    });
});

function rectangle(id, minX, minY, maxX, maxY) {
    return {
        type: 'Feature',
        properties: id ? { parcelId: id } : {},
        geometry: {
            type: 'Polygon',
            coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]
        }
    };
}

function rectangleBounds(feature) {
    const ring = feature.geometry.coordinates[0];
    const xs = ring.map(point => point[0]);
    const ys = ring.map(point => point[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function fakePlanarTurf() {
    return {
        area(feature) {
            const [minX, minY, maxX, maxY] = rectangleBounds(feature);
            return (maxX - minX) * (maxY - minY);
        },
        intersect(a, b) {
            const aa = rectangleBounds(a);
            const bb = rectangleBounds(b);
            const bounds = [Math.max(aa[0], bb[0]), Math.max(aa[1], bb[1]), Math.min(aa[2], bb[2]), Math.min(aa[3], bb[3])];
            return bounds[2] > bounds[0] && bounds[3] > bounds[1]
                ? rectangle(null, ...bounds)
                : null;
        },
        difference(a, b) {
            const overlap = this.intersect(a, b);
            if (!overlap) return a;
            const aa = rectangleBounds(a);
            const bb = rectangleBounds(overlap);
            if (bb[0] <= aa[0] && bb[1] <= aa[1] && bb[2] >= aa[2] && bb[3] >= aa[3]) return null;
            if (bb[1] <= aa[1] && bb[3] >= aa[3] && bb[2] >= aa[2]) return rectangle(null, aa[0], aa[1], bb[0], aa[3]);
            throw new Error('Fake turf only supports a right-edge subtraction');
        },
        union(a) {
            return a;
        }
    };
}

describe('splitPlanPerParcel', () => {
    it('builds a remainder/sliver plan and skips parcels outside the courtyard', () => {
        const owners = new Map([
            ['a', [{ ownerKey: 'owner-a', displayName: 'Owner A', color: '#111111', share: 1 }]],
            ['b', [{ ownerKey: 'owner-b', displayName: 'Owner B', color: '#222222', share: 1 }]]
        ]);
        const jointOwners = [
            { ownerKey: 'owner-a', displayName: 'Owner A', color: '#111111', share: 0.5 },
            { ownerKey: 'owner-b', displayName: 'Owner B', color: '#222222', share: 0.5 }
        ];
        const result = splitPlanPerParcel({
            parcelFeatures: [rectangle('a', 0, 0, 10, 10), rectangle('b', 10, 0, 20, 10)],
            jointPolygons: [rectangle(null, 5, 0, 10, 10)],
            parcelOwnerIndex: owners,
            jointOwners
        }, fakePlanarTurf());

        expect(result[0].skipped).toBe(false);
        expect(result[0].polygons[0].owners).toEqual(owners.get('a'));
        expect(result[0].polygons[1].owners).toEqual(jointOwners);
        expect(result[0].polygons[1].jointPool).toBe(true);
        expect(result[1]).toEqual({ parcelId: 'b', skipped: true });
    });
});
