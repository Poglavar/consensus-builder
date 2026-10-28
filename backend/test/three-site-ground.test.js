import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { contextTreesOutsideCorridors, sidewalkMaterial, fencePositions } = require('../../frontend/js/three-site-ground.js');
const turf = require('@turf/turf');

describe('context trees around applied corridors', () => {
    const road = (geometry, applied = true) => ({ applied, features: [turf.feature(geometry, { source: 'road-definition' })] });
    const box = (west, south, east, north) => turf.bboxPolygon([west, south, east, north]).geometry;
    const readers = () => ({ turf, isAppliedCorridor: p => p.applied, featureSets: vi.fn(p => ({ primaryFeatures: p.features })) });

    it('clears trees inside and on road boundaries while retaining nearby trees without moving them', () => {
        const trees = [[0, 0], [1, .5], [1.001, .5], [4, 4]];
        const original = structuredClone(trees);
        const deps = readers();
        const retained = contextTreesOutsideCorridors(trees, [road(box(-1, -1, 1, 1))], deps);
        expect(retained).toEqual([trees[2], trees[3]]);
        expect(retained[0]).toBe(trees[2]);
        expect(trees).toEqual(original);
        expect(deps.featureSets).toHaveBeenCalledWith(expect.anything(), { includeBuildingGeometry: false });
    });

    it('uses the actual footprint rather than its bounding box, preserving holes and clearing disconnected junction pieces', () => {
        const main = box(0, 0, 4, 4);
        main.coordinates.push(box(1, 1, 3, 3).coordinates[0]);
        const multi = turf.multiPolygon([main.coordinates, box(5, 5, 6, 6).coordinates]).geometry;
        const trees = [[.5, .5], [2, 2], [5.5, 5.5], [4.5, 4.5]];
        expect(contextTreesOutsideCorridors(trees, [road(multi)], readers())).toEqual([trees[1], trees[3]]);
    });

    it('does not clear an unapplied road and restores source trees when a road is unapplied', () => {
        const proposal = road(box(-1, -1, 1, 1));
        const trees = [[0, 0], [2, 2]];
        expect(contextTreesOutsideCorridors(trees, [proposal], readers())).toEqual([trees[1]]);
        proposal.applied = false;
        const deps = readers();
        expect(contextTreesOutsideCorridors(trees, [proposal], deps)).toEqual(trees);
        expect(deps.featureSets).not.toHaveBeenCalled();
    });

    it('ignores observed sites and unrelated primary geometry, and never coerces invalid coordinates to real positions', () => {
        const proposal = { applied: true, features: [turf.feature(box(-3, -3, 3, 3), { source: 'proposal-site' })] };
        const trees = [[0, 0], null, [null, 0], [0, '0'], [NaN, 0], [0, Infinity], [1]];
        expect(contextTreesOutsideCorridors(trees, [proposal], readers())).toEqual([[0, 0]]);
        expect(contextTreesOutsideCorridors([[0, 0]], [], readers())).toEqual([[0, 0]]);
    });

    it('checks all applied corridors and skips precise polygon queries for distant trees', () => {
        const deps = readers();
        deps.turf = { ...turf, booleanPointInPolygon: vi.fn(turf.booleanPointInPolygon) };
        const trees = [[0, 0], [10, 10], [20, 20]];
        expect(contextTreesOutsideCorridors(trees, [road(box(-1, -1, 1, 1)), road(box(9, 9, 11, 11))], deps)).toEqual([trees[2]]);
        expect(deps.turf.booleanPointInPolygon).toHaveBeenCalledTimes(2);
    });
});

describe('site ground', () => {
    it('uses the ordinary sidewalk shader rather than the square texture', () => {
        const THREE = { MeshLambertMaterial: class { constructor(options) { Object.assign(this, options); } } };
        const ground = { paveTexture: vi.fn(material => material) };
        const material = sidewalkMaterial(THREE, ground, 0.7);
        expect(ground.paveTexture).toHaveBeenCalledWith(material, 0.7);
        expect(material.color).toBe(0xcdccc8);
        expect(material.map).toBeUndefined();
    });
    it('closes a fence with metre heights and posts at most three metres apart', () => {
        const geometry = { type: 'Polygon', coordinates: [[[0, 0], [24, 0], [24, 24], [0, 24], [0, 0]]] };
        const positions = fencePositions(geometry, point => point, 0.5);
        const segments = Array.from({ length: positions.length / 6 }, (_, i) => positions.slice(i * 6, i * 6 + 6));
        const posts = segments.filter(([x, y, , endX, endY]) => x === endX && y === endY);
        expect(posts).toHaveLength(16);
        expect(posts.every(post => post[2] === 0.08 && post[5] === 1.3)).toBe(true);
        expect(segments).toContainEqual([0, 24, 1.3, 0, 0, 1.3]);
        expect(posts.slice(0, 4).map(post => post[0])).toEqual([0, 6, 12, 18]);
    });
    it('supports disconnected plots and skips zero-length boundary segments', () => {
        const ring = [[0, 0], [0, 0], [3, 0], [0, 3], [0, 0]];
        const geometry = { type: 'MultiPolygon', coordinates: [[ring], [ring]] };
        const positions = fencePositions(geometry, point => point);
        expect(positions.every(Number.isFinite)).toBe(true);
        expect(positions.length).toBe(2 * fencePositions({ type: 'Polygon', coordinates: [ring] }, point => point).length);
    });
});

describe('standing building footprints for the vacant-plot rule', () => {
    const { standingBuildingFootprints } = require('../../frontend/js/three-site-ground.js');
    // A 10 m box: floor and roof carry the outline, the four walls project to zero-area strips.
    const box = (west, south, east, north, height) => {
        const ring = z => [[west, south, z], [east, south, z], [east, north, z], [west, north, z], [west, south, z]];
        const wall = (a, b) => ({ type: 'Polygon', coordinates: [[[...a, 0], [...b, 0], [...b, height], [...a, height], [...a, 0]]] });
        return { object_id: 'b1', faces: [
            { type: 'Polygon', coordinates: [ring(0)] }, { type: 'Polygon', coordinates: [ring(height)] },
            wall([west, south], [east, south]), wall([east, south], [east, north]),
            wall([east, north], [west, north]), wall([west, north], [west, south])
        ] };
    };
    const building = box(15.97, 45.81, 15.97013, 45.81009, 12);

    it('projects roof and floor faces to 2D ground and drops the walls', () => {
        const footprints = standingBuildingFootprints([building], () => null, turf);
        expect(footprints).toHaveLength(2);
        footprints.forEach(feature => {
            expect(turf.area(feature)).toBeGreaterThan(90);
            expect(feature.geometry.coordinates[0].every(c => c.length === 2)).toBe(true);
        });
    });
    it('follows the demolition verdict: a razed building occupies nothing, a cut one only its remainder', () => {
        expect(standingBuildingFootprints([building], () => ({ remainder: null, demolished: {} }), turf)).toEqual([]);
        const remainder = turf.bboxPolygon([15.97, 45.81, 15.97005, 45.81009]).geometry;
        const cut = standingBuildingFootprints([building], () => ({ remainder, demolished: {} }), turf);
        expect(cut).toHaveLength(1);
        expect(cut[0].geometry).toEqual(remainder);
    });
    it('ignores malformed meshes instead of failing the ground build', () => {
        expect(standingBuildingFootprints([null, { faces: 'x' }, { faces: [{ type: 'Polygon', coordinates: [[[0, 0]]] }] }], () => null, turf)).toEqual([]);
    });
});
