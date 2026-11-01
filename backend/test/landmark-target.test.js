import { describe, it, expect } from 'vitest';
import { landmarkTarget, rankLandmarkParcels } from '../places/landmark-target.js';

const polygon = (coordinates, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [coordinates] } });
const bridgeLine = (coordinates, osmId = 'bridge-1') => ({
    type: 'Feature', properties: { osmId, name: 'London Bridge', category: 'bridge', bridge: 'yes' },
    geometry: { type: 'LineString', coordinates }
});
const parcel = (parcelId, coordinates) => polygon(coordinates, { parcelId });
const rectangle = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];

describe('landmarkTarget', () => {
    it('anchors a southwest edge on the actual rotated bridge outline and ranks the nearer west parcel', () => {
        // A 30-degree rotated outline whose south-west support is an actual corner.
        const outline = [[-0.001, 51.000], [-0.0006, 51.0004], [-0.0002, 51.000], [-0.0006, 50.9996], [-0.001, 51.000]];
        const line = bridgeLine([[-0.0009, 51], [-0.0003, 51]], 'rotated');
        const result = landmarkTarget({ features: [line, polygon(outline, { osmId: 'rotated', name: 'London Bridge', category: 'bridge' })], osmId: 'rotated', relation: 'edge', direction: 'southwest' });
        expect(result).not.toBeNull();
        expect(result.interpretation.geometryKind).toBe('outline');
        const [ax, ay] = result.anchor;
        expect(outline.slice(0, -1).some((a, i) => {
            const b = outline[i + 1], cross = (ax - a[0]) * (b[1] - a[1]) - (ay - a[1]) * (b[0] - a[0]);
            return Math.abs(cross) < 1e-12 && ax >= Math.min(a[0], b[0]) && ax <= Math.max(a[0], b[0]) && ay >= Math.min(a[1], b[1]) && ay <= Math.max(a[1], b[1]);
        })).toBe(true);

        const nearWest = parcel('west-near', rectangle(ax - 0.00014, ay - 0.00003, ax - 0.00008, ay + 0.00003));
        const farSouthwest = parcel('southwest-far', rectangle(ax - 0.0006, ay - 0.0006, ax - 0.00054, ay - 0.00054));
        const ranked = rankLandmarkParcels({ target: result, parcels: [farSouthwest, nearWest], maxDistanceM: 50 });
        expect(ranked.map(row => row.parcelId)).toEqual(['west-near']);
    });

    it('does not merge a distant same-name object into the seed line', () => {
        const seed = bridgeLine([[0, 51], [0.001, 51]], 'a');
        const distant = bridgeLine([[0.02, 51], [0.021, 51]], 'b');
        const result = landmarkTarget({ features: [seed, distant], osmId: 'a', relation: 'end', direction: 'east' });
        expect(result.landmarkGeometry.coordinates).toEqual(seed.geometry.coordinates);
    });

    it('stitches only connected line parts and chooses a real terminal for end', () => {
        const seed = bridgeLine([[0, 51], [0.001, 51]], 'a');
        const connected = bridgeLine([[0.00100001, 51], [0.002, 51]], 'b');
        const distant = bridgeLine([[0.02, 51], [0.021, 51]], 'c');
        const result = landmarkTarget({ features: [seed, connected, distant], osmId: 'a', relation: 'end', direction: 'east' });
        expect(result.landmarkGeometry.coordinates).toHaveLength(2);
        expect(result.anchor).toEqual([0.002, 51]);
    });

    it('uses connected centerline evidence to find the related full outline', () => {
        const approach = bridgeLine([[0, 0], [0.001, 0]], 'approach');
        const bridge = bridgeLine([[0.001, 0], [0.002, 0]], 'body');
        const outline = polygon(rectangle(0.001, -0.0001, 0.002, 0.0001), { osmId: 'outline', name: 'London Bridge', category: 'bridge' });
        const result = landmarkTarget({ features: [approach, bridge, outline], osmId: 'approach', relation: 'end', direction: 'east' });
        expect(result.interpretation.geometryKind).toBe('outline');
        expect(result.landmarkGeometry).toEqual(outline.geometry);
    });

    it('rejects a branched or disconnected MultiLineString network', () => {
        const seed = { ...bridgeLine([[0, 0], [0.001, 0]], 'branch'), geometry: { type: 'MultiLineString', coordinates: [
            [[0, 0], [0.001, 0]], [[0.001, 0], [0.002, 0]], [[0.001, 0], [0.001, 0.001]]
        ] } };
        expect(landmarkTarget({ features: [seed], osmId: 'branch', relation: 'end', direction: 'east' })).toBeNull();
    });

    it('rejects a disconnected closed cycle alongside a valid line path', () => {
        const seed = { ...bridgeLine([[0, 0], [0.001, 0]], 'cycle'), geometry: { type: 'MultiLineString', coordinates: [
            [[0, 0], [0.001, 0]], [[0.001, 0], [0.002, 0]],
            [[0.01, 0.01], [0.011, 0.01]], [[0.011, 0.01], [0.0105, 0.011]], [[0.0105, 0.011], [0.01, 0.01]]
        ] } };
        expect(landmarkTarget({ features: [seed], osmId: 'cycle', relation: 'end', direction: 'east' })).toBeNull();
    });

    it('chooses an exterior support edge, never a polygon hole boundary', () => {
        const seed = bridgeLine([[0.0005, 0], [0.0015, 0]], 'hole');
        const outline = { type: 'Feature', properties: { osmId: 'hole', name: 'London Bridge', category: 'bridge' }, geometry: {
            type: 'Polygon', coordinates: [rectangle(0, 0, 0.002, 0.001), rectangle(0.0007, 0.0003, 0.0013, 0.0007)]
        }};
        const result = landmarkTarget({ features: [seed, outline], osmId: 'hole', relation: 'edge', direction: 'north' });
        expect(result.anchor[1]).toBe(0.001);
        expect(result.geometry.coordinates).toEqual([[0.002, 0.001], [0, 0.001]]);
    });

    it('never chooses a zero-length edge at the ring’s repeated first corner', () => {
        const outline = polygon([[0.002, 0.001], [0.002, 0], [0, 0], [0, 0.001], [0.002, 0.001]], {
            osmId: 'corner-first', name: 'London Bridge', category: 'bridge'
        });
        const result = landmarkTarget({ features: [outline], osmId: 'corner-first', relation: 'edge', direction: 'north' });
        expect(result.geometry.coordinates[0]).not.toEqual(result.geometry.coordinates[1]);
        expect(result.anchor).toEqual([0.001, 0.001]);
    });

    it('refuses a disjoint MultiPolygon seed when no unambiguous outline exists', () => {
        const disjoint = { type: 'Feature', properties: { osmId: 'disjoint', name: 'London Bridge', category: 'bridge' }, geometry: {
            type: 'MultiPolygon', coordinates: [rectangle(0, 0, 0.001, 0.001), rectangle(0.01, 0.01, 0.011, 0.011)].map(ring => [ring])
        }};
        expect(landmarkTarget({ features: [disjoint], osmId: 'disjoint', relation: 'corner', direction: 'southwest' })).toBeNull();
    });

    it('ranks by nearest parcel boundary point rather than centroid', () => {
        const seed = bridgeLine([[0.0005, 0], [0.0015, 0]], 'rank');
        const outline = polygon(rectangle(0, 0, 0.002, 0.001), { osmId: 'rank', name: 'London Bridge', category: 'bridge' });
        const target = landmarkTarget({ features: [seed, outline], osmId: 'rank', relation: 'edge', direction: 'north' });
        const near = parcel('near', rectangle(0.0008, 0.0011, 0.0012, 0.0013));
        const centroidNear = parcel('centroid-near', rectangle(0.0008, 0.00135, 0.0012, 0.00155));
        const ranked = rankLandmarkParcels({ target, parcels: [centroidNear, near, structuredClone(near)], maxDistanceM: 50 });
        expect(ranked.map(x => x.parcelId)).toEqual(['near', 'centroid-near']);
        expect(ranked[0].point[1]).toBeCloseTo(0.0011, 7);
    });

    it('rejects parcels on the wrong side and parcels occupying the landmark', () => {
        const seed = bridgeLine([[0.0005, 0], [0.0015, 0]], 'side');
        const outline = polygon(rectangle(0, 0, 0.002, 0.001), { osmId: 'side', name: 'London Bridge', category: 'bridge' });
        const target = landmarkTarget({ features: [seed, outline], osmId: 'side', relation: 'edge', direction: 'north' });
        const south = parcel('south', rectangle(0.0008, -0.0002, 0.0012, -0.0001));
        const overlaps = parcel('overlap', rectangle(0.0008, 0.0008, 0.0012, 0.0012));
        expect(rankLandmarkParcels({ target, parcels: [south, overlaps] })).toEqual([]);
    });

    it('applies the directional side tolerance in metres for nearby parcels on both sides', () => {
        const outline = polygon(rectangle(0, 0, 0.002, 0.00005), { osmId: 'thin', name: 'Bridge', category: 'bridge' });
        const target = landmarkTarget({ features: [outline], osmId: 'thin', relation: 'edge', direction: 'north' });
        const south = parcel('south', rectangle(0.0009, -0.0001, 0.0011, -0.00005));
        const north = parcel('north', rectangle(0.0009, 0.0001, 0.0011, 0.00015));
        expect(rankLandmarkParcels({ target, parcels: [south, north], maxDistanceM: 50 }).map(p => p.parcelId)).toEqual(['north']);
    });

    it('does not mutate source features or parcels', () => {
        const seed = bridgeLine([[0.0005, 0], [0.0015, 0]], 'immutable');
        const outline = polygon(rectangle(0, 0, 0.002, 0.001), { osmId: 'immutable', name: 'London Bridge', category: 'bridge' });
        const near = parcel('near', rectangle(0.0008, 0.0011, 0.0012, 0.0013));
        const before = structuredClone([seed, outline, near]);
        const target = landmarkTarget({ features: [seed, outline], osmId: 'immutable', relation: 'edge', direction: 'north' });
        rankLandmarkParcels({ target, parcels: [near] });
        expect([seed, outline, near]).toEqual(before);
    });

    it('uses the full exterior outline for beside when direction is omitted', () => {
        const seed = bridgeLine([[0.0005, 0], [0.0015, 0]], 'beside');
        const outline = { type: 'Feature', properties: { osmId: 'beside', name: 'London Bridge', category: 'bridge' }, geometry: {
            type: 'Polygon', coordinates: [rectangle(0, 0, 0.002, 0.001), rectangle(0.0007, 0.0003, 0.0013, 0.0007)]
        }};
        const target = landmarkTarget({ features: [seed, outline], osmId: 'beside', relation: 'beside' });
        expect(target.geometry.type).toBe('MultiLineString');
        expect(target.geometry.coordinates).toEqual([rectangle(0, 0, 0.002, 0.001)]);
    });

    it('keeps an open centerline open when measuring distance', () => {
        const seed = bridgeLine([[0, 0], [0.001, 0], [0.001, 0.001]], 'open');
        const target = landmarkTarget({ features: [seed], osmId: 'open', relation: 'beside' });
        const nearArtificialChord = parcel('chord', rectangle(0.00045, 0.00045, 0.0005, 0.0005));
        expect(rankLandmarkParcels({ target, parcels: [nearArtificialChord], maxDistanceM: 45 })).toEqual([]);
    });

    it('accepts navigation direction aliases and numeric bearings for rotated polygon ends', () => {
        const u = Math.SQRT1_2, w = 0.0001, l = 0.001;
        const pointAt = (a, b) => [a * u - b * u, a * u + b * u];
        const outline = [pointAt(-l, -w), pointAt(l, -w), pointAt(l, w), pointAt(-l, w), pointAt(-l, -w)];
        const source = polygon(outline, { osmId: 'rotated-end', name: 'London Bridge', category: 'bridge' });
        const alias = landmarkTarget({ features: [source], osmId: 'rotated-end', relation: 'end', direction: 'up-right' });
        const bearing = landmarkTarget({ features: [source], osmId: 'rotated-end', relation: 'end', direction: 45 });
        expect(alias.anchor).toEqual(bearing.anchor);
        expect(alias.anchor[0]).toBeGreaterThan(0.0006);
        expect(alias.anchor[1]).toBeGreaterThan(0.0006);
    });
});
