import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { mapModeModelScripts } from './helpers/map-mode-loader.mjs';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { partitionLakeBasin } = require('../../frontend/js/three-lake-basin.js');
const sanitize = require('../../frontend/js/three-mesh-sanitize.js');
const clip = (operation, a, b) => turf[operation](a, b);
const rectangle = (west, south, east, north) => turf.polygon([
    [[west, south], [east, south], [east, north], [west, north], [west, south]]
]);
const lake = rectangle(0, 0, 20, 20);
const water = rectangle(4, 4, 16, 16);
const graphics = {
    shore: turf.difference(lake, water).geometry,
    transition: turf.difference(rectangle(2, 2, 18, 18), water).geometry,
    water: water.geometry,
    fish: []
};

describe('recessed lake solids', () => {
    it('partitions the 2D overlay into disjoint shore and shelf without holes or extra land', () => {
        const original = structuredClone(graphics);
        const parts = partitionLakeBasin(lake.geometry, graphics, clip);
        const shore = turf.feature(parts.shore), shelf = turf.feature(parts.transition);
        expect(turf.intersect(shore, shelf)).toBeNull();
        expect(turf.intersect(shore, water)).toBeNull();
        expect(turf.intersect(shelf, water)).toBeNull();
        const union = turf.union(turf.union(shore, shelf), water);
        expect(turf.difference(lake, union)).toBeNull();
        expect(turf.difference(union, lake)).toBeNull();
        expect(parts.water).toEqual(water.geometry);
        expect(parts.transition).toEqual(graphics.transition);
        expect(graphics).toEqual(original);
    });

    it('preserves islands and separate basin components', () => {
        const second = rectangle(30, 0, 50, 20);
        const secondWater = turf.difference(rectangle(34, 4, 46, 16), rectangle(38, 8, 42, 12));
        const base = turf.union(lake, second);
        const waters = turf.union(water, secondWater);
        const shelves = turf.union(turf.feature(graphics.transition),
            turf.difference(rectangle(32, 2, 48, 18), rectangle(34, 4, 46, 16)));
        const parts = partitionLakeBasin(base.geometry, {
            shore: turf.difference(base, waters).geometry,
            transition: shelves.geometry, water: waters.geometry
        }, clip);
        expect(parts.shore.type).toBe('MultiPolygon');
        expect(turf.booleanPointInPolygon([40, 10], turf.feature(parts.shore))).toBe(true);
        expect(turf.intersect(turf.feature(parts.shore), shelves)).toBeNull();
        const merged = turf.union(turf.union(turf.feature(parts.shore), shelves), waters);
        expect(turf.difference(base, merged)).toBeNull();
        expect(turf.difference(merged, base)).toBeNull();
    });

    it('keeps a shore without a shelf and draws only water when graphics are unavailable', () => {
        expect(partitionLakeBasin(lake.geometry, { ...graphics, transition: null }, clip).shore).toEqual(graphics.shore);
        expect(partitionLakeBasin(lake.geometry, null, clip)).toEqual({
            shore: null, transition: null, water: lake.geometry
        });
    });

    it('propagates clipping failures instead of drawing overlapping solids', () => {
        expect(() => partitionLakeBasin(lake.geometry, graphics, () => {
            throw new Error('failed to partition');
        })).toThrow('failed to partition');
    });

    it('loads the partition helper before the 3D renderer', () => {
        const scripts = mapModeModelScripts();
        expect(scripts.indexOf('js/three-lake-basin.js')).toBeGreaterThanOrEqual(0);
        expect(scripts.indexOf('js/three-lake-basin.js')).toBeLessThan(scripts.indexOf('js/three-mode.js'));
    });

    it('builds one visible wall at the water edge using actual Three.js extrusion', () => {
        const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
        const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
        const context = {
            THREE, console, coordsToXY: point => point, meshSanitize: sanitize,
            window: { lakes: [{ ...lake, properties: { lakeGraphics: graphics } }],
                __threeLakeBasin: { partitionLakeBasin }, __parcelArrangement: { clip } },
            markOwnedMaterial() {}, markOwnedGeometry() {}, attachBuildingDepthPrepass() {},
            reportThreeClip(_operation, error) { throw error; }
        };
        vm.createContext(context);
        vm.runInContext(extract('    function arrayOfLngLatRingsToShape(', '    function polygonFeatureToBorderLines(')
            + extract('    function buildLakes3D(', '    // Shared procedural station models'), context);
        const ground = new THREE.Group();
        context.buildLakes3D(ground, new THREE.Group());
        ground.updateMatrixWorld(true);
        // Look horizontally from open water below the shelf top, above the shared basin floor.
        const ray = new THREE.Raycaster(new THREE.Vector3(10, 10, -1.1), new THREE.Vector3(0, 1, 0));
        const hits = ray.intersectObjects(ground.children, false);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.filter(hit => Math.abs(hit.distance - hits[0].distance) < 0.001)).toHaveLength(1);
        expect(hits[0].object.material.color.getHex()).toBe(0x3c92d6);
        expect(hits[0].distance).toBeCloseTo(6);
        ground.children.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });
    });
});
