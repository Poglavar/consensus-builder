// Walkable-surface grid (frontend/js/life/life-surface.js): classification paint order, leg
// validation across carriageways, target and spawn sampling, and the graph → surface hand-off.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const surfaceApi = require('../../frontend/js/life/life-surface.js');
const lifeGraph = require('../../frontend/js/life/life-graph.js');
const { mulberry32 } = require('../../frontend/js/life/life-agents.js');
const { buildWalkableSurface, CLASS, Z_LEVELS } = surfaceApi;

const identity = (lng, lat) => [lng, lat];
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

describe('buildWalkableSurface paint order', () => {
    const surface = buildWalkableSurface({
        bounds: [-50, -50, 50, 50],
        bands: [{ pts: [[-50, 0], [50, 0]], halfWidth: 8, zcode: 0 }],
        carriageways: [{ pts: [[-50, 0], [50, 0]], halfWidth: 3.5 }],
        fills: [{ rings: [square(10, 10, 40, 40)], zcode: 1 }],
        blocked: [{ rings: [square(-40, 10, -10, 40)] }, { x: 25, y: 25, r: 3 }]
    });

    it('classifies the carriageway, its sidewalk band, open ground and the outside', () => {
        expect(surface.classAt(0, 0)).toBe(CLASS.CARRIAGEWAY);
        expect(surface.classAt(0, 6)).toBe(CLASS.PREFERRED);
        expect(surface.classAt(0, -6)).toBe(CLASS.PREFERRED);
        expect(surface.classAt(0, 20)).toBe(CLASS.OPEN);
        expect(surface.classAt(0, 200)).toBe(CLASS.BLOCKED);
    });

    it('paints footprints over everything and fills plazas with their height', () => {
        expect(surface.classAt(-25, 25)).toBe(CLASS.BLOCKED);
        expect(surface.classAt(15, 15)).toBe(CLASS.PREFERRED);
        expect(surface.zAt(15, 15)).toBe(Z_LEVELS[1]);
        expect(surface.classAt(25, 25)).toBe(CLASS.BLOCKED); // the fountain disc inside the plaza
        expect(surface.isWalkable(15, 15)).toBe(true);
        expect(surface.isWalkable(-25, 25)).toBe(false);
        expect(surface.isWalkable(0, 0)).toBe(false);
    });

    it('counts cells and areas consistently', () => {
        const s = surface.stats;
        expect(s.cellM).toBe(1);
        expect(s.cells).toBe(s.preferred + s.open + s.carriageway + s.blocked);
        expect(s.preferredAreaM2).toBe(s.preferred * s.cellM * s.cellM);
        expect(s.blocked).toBeGreaterThan(900 - 50); // the 30×30 building plus the fountain
    });
});

describe('legOk', () => {
    const surface = buildWalkableSurface({
        bounds: [-100, -100, 100, 100],
        carriageways: [{ pts: [[-100, 0], [100, 0]], halfWidth: 5 }, { pts: [[60, -100], [60, 100]], halfWidth: 20 }],
        blocked: [{ rings: [square(-30, 20, -10, 40)] }]
    });

    it('allows a short perpendicular street crossing', () => {
        expect(surface.legOk(0, -15, 0, 15)).toBe(true);
    });

    it('refuses a stroll along the carriageway or across a very wide one', () => {
        expect(surface.legOk(-40, 0, 40, 0)).toBe(false);
        expect(surface.legOk(60, -60, 60, 60)).toBe(false);
        expect(surface.legOk(30, 30, 90, 30)).toBe(false); // 40 m of carriageway on the wide road
    });

    it('never passes through a footprint', () => {
        expect(surface.legOk(-40, 30, 0, 30)).toBe(false);
        expect(surface.legOk(-40, 50, 0, 50)).toBe(true);
    });
});

describe('randomTarget and randomSpawn', () => {
    const surface = buildWalkableSurface({
        bounds: [-60, -60, 60, 60],
        bands: [{ pts: [[-60, 0], [60, 0]], halfWidth: 8 }],
        carriageways: [{ pts: [[-60, 0], [60, 0]], halfWidth: 3 }],
        blocked: [{ rings: [square(-60, 20, 60, 60)] }]
    });
    const rng = mulberry32(5);

    it('returns walkable, reachable destinations at least 6 m away', () => {
        for (let i = 0; i < 50; i++) {
            const target = surface.randomTarget(0, 6, 40, rng);
            expect(target).not.toBeNull();
            expect(surface.isWalkable(target[0], target[1])).toBe(true);
            expect(Math.hypot(target[0], target[1] - 6)).toBeGreaterThanOrEqual(6);
            expect(surface.legOk(0, 6, target[0], target[1])).toBe(true);
        }
    });

    it('prefers the sidewalk band when asked to', () => {
        let preferred = 0;
        for (let i = 0; i < 200; i++) {
            const target = surface.randomTarget(0, 6, 40, rng, 1);
            if (target && surface.classAt(target[0], target[1]) === CLASS.PREFERRED) preferred++;
        }
        expect(preferred).toBe(200);
    });

    it('spawns in preferred space and never inside a footprint', () => {
        for (let i = 0; i < 100; i++) {
            const p = surface.randomSpawn(rng);
            expect(surface.classAt(p[0], p[1])).toBe(CLASS.PREFERRED);
        }
    });

    it('grows the cell for a large scene instead of exceeding the budget', () => {
        const big = buildWalkableSurface({ bounds: [0, 0, 5000, 5000] });
        expect(big.stats.cells).toBeLessThanOrEqual(1.6e6);
        expect(big.cell).toBeGreaterThan(1);
    });
});

describe('graph → surface hand-off', () => {
    it('paints OSM streets, sidewalks, footways, pedestrian areas, parks and blocked footprints', () => {
        const b = lifeGraph.createGraphBuilder();
        b.addOsmRoads([
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-100, 0], [100, 0]] }, properties: { highway_type: 'residential', tags: { lanes: '2' } } },
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 30], [0, 80]] }, properties: { highway_type: 'footway', tags: {} } },
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[40, 30], [80, 30], [80, 70], [40, 70], [40, 30]] }, properties: { highway_type: 'pedestrian', tags: { area: 'yes' } } }
        ], identity);
        b.addPark({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-80, 30, -40, 70)] }, properties: { decorations: { paths: [[[-78, 32], [-42, 68]]] } } }, identity);
        b.addBlockedFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(10, -60, 50, -20)] } }, identity);
        const graph = b.build();
        expect(graph.stats.carriageways).toBe(1);
        expect(graph.stats.bands).toBe(4); // two sidewalks, the footway, the park path
        expect(graph.stats.fills).toBe(2);
        expect(graph.stats.blocked).toBe(1);
        const surface = buildWalkableSurface({ bounds: [-120, -120, 120, 120], ...graph.surface });
        expect(surface.classAt(0, 0)).toBe(CLASS.CARRIAGEWAY);
        // Crossing the street means stepping down onto the sunk asphalt, by the same kerb the ground draws.
        expect(surface.zAt(0, 0)).toBe(-lifeGraph.KERB_M);
        expect(Z_LEVELS[surfaceApi.ZCODE.ROAD]).toBe(-lifeGraph.KERB_M);
        expect(surface.zAt(0, 5.5)).toBe(0);
        expect(surface.classAt(0, 5.5)).toBe(CLASS.PREFERRED);    // sidewalk band beyond 3.5 m
        expect(surface.classAt(0, 55)).toBe(CLASS.PREFERRED);     // footway
        expect(surface.classAt(60, 50)).toBe(CLASS.PREFERRED);    // pedestrian area
        expect(surface.classAt(-60, 50)).toBe(CLASS.PREFERRED);   // park lawn
        expect(surface.zAt(-60, 50)).toBe(Z_LEVELS[1]);
        expect(surface.zAt(-60, 50.1)).toBeGreaterThan(0);
        expect(surface.classAt(30, -40)).toBe(CLASS.BLOCKED);     // building
        expect(surface.classAt(0, -40)).toBe(CLASS.OPEN);         // a parcel: walkable, not preferred
    });

    it('blocks the ground under a face-mesh building from its roof, ignoring wall slivers', () => {
        const b = lifeGraph.createGraphBuilder();
        const base = [[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]];
        const faces = [];
        for (let i = 0; i < base.length - 1; i++) {
            const a = base[i], c = base[i + 1];
            faces.push({ type: 'Polygon', coordinates: [[[a[0], a[1], 0], [c[0], c[1], 0], [c[0], c[1], 9], [a[0], a[1], 9], [a[0], a[1], 0]]] });
        }
        faces.push({ type: 'Polygon', coordinates: [base.map(p => [p[0], p[1], 9])] });
        b.addBlockedFeature({ faces }, identity);
        const graph = b.build();
        expect(graph.stats.blocked).toBe(1);
        const surface = buildWalkableSurface({ bounds: [-10, -10, 30, 20], ...graph.surface });
        expect(surface.classAt(10, 5)).toBe(CLASS.BLOCKED);
        expect(surface.classAt(10, 12)).toBe(CLASS.OPEN);
        expect(surface.classAt(-5, 5)).toBe(CLASS.OPEN);
    });

    it('paints corridor sidewalks as kerb-height preferred space and its lanes as carriageway', () => {
        const b = lifeGraph.createGraphBuilder();
        b.addCorridor({
            id: 'c', zLift: 0.05, segments: [{
                id: 's', points: [[-50, 0], [50, 0]], spans: [
                    { type: 'sidewalk', width: 2, left: 5, right: 3 },
                    { type: 'driving', width: 3, direction: 'backward', left: 3, right: 0 },
                    { type: 'driving', width: 3, direction: 'forward', left: 0, right: -3 },
                    { type: 'sidewalk', width: 2, left: -3, right: -5 }]
            }]
        });
        const graph = b.build();
        const surface = buildWalkableSurface({ bounds: [-60, -20, 60, 20], ...graph.surface });
        expect(surface.stats.authoredPreferredAreaM2).toBeGreaterThan(300);
        const spawn = surface.randomSpawn(mulberry32(7), true);
        expect(surface.classAt(...spawn)).toBe(CLASS.PREFERRED);
        expect(Math.abs(spawn[1])).toBeGreaterThan(3);
        expect(Math.abs(spawn[1])).toBeLessThan(6);
        expect(surface.classAt(0, 0)).toBe(CLASS.CARRIAGEWAY);
        expect(surface.classAt(0, 2.5)).toBe(CLASS.CARRIAGEWAY);
        expect(surface.classAt(0, 4)).toBe(CLASS.PREFERRED);
        expect(surface.zAt(0, 4)).toBe(Z_LEVELS[3]);
        expect(surface.classAt(0, -4)).toBe(CLASS.PREFERRED);
        expect(surface.classAt(0, 10)).toBe(CLASS.OPEN);
    });
});
