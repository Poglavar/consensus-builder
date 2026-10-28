// Generated flights: a design orbit keeps the design in view while descending; a plan tour orbits the
// farthest pair of buildings and winds between obstacles; the playback curve never enters a building.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const Flight = require('../../frontend/js/camera-flight.js');
const Auto = require('../../frontend/js/camera-flight-auto.js');

const building = (x, y, w, d, top) => ({ min: [x - w / 2, y - d / 2], max: [x + w / 2, y + d / 2], top });
// Rendered heights for these boxes on a 2 m grid over the generator's own bounds.
function field(subjects, extra = []) {
    const [x0, y0, x1, y1] = Auto.bounds(subjects), cell = 2;
    const cols = Math.ceil((x1 - x0) / cell), rows = Math.ceil((y1 - y0) / cell), heights = new Float32Array(cols * rows);
    for (const b of [...subjects.flatMap(s => s.buildings), ...extra]) {
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const x = x0 + (c + .5) * cell, y = y0 + (r + .5) * cell;
            if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1]) heights[r * cols + c] = Math.max(heights[r * cols + c], b.top);
        }
    }
    return Auto.grid({ origin: [x0, y0], cell, cols, rows, heights });
}
const rotate = (q, v) => {
    const [x, y, z, w] = q, [vx, vy, vz] = v;
    const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const unitTo = (from, to) => { const d = to.map((x, i) => x - from[i]), n = Math.hypot(...d); return d.map(x => x / n); };
const angle = (a, b) => Math.acos(Math.min(1, a.reduce((s, x, i) => s + x * b[i], 0))) * 180 / Math.PI;
function record(result) {
    return { schema: Flight.SCHEMA, title: 'Generated', designCids: [], view: { at: '52,-1,18', mode: 'model', settings: {} },
        frame: { lat: 52, lng: -1, datum: 'model-ground' }, fov: 45, speedMps: result.speedMps, route: result.route, looks: [], interiors: [], cues: [] };
}
// Every playback sample: inside a building footprint it must be above the roof.
function insideBuildings(result, boxes) {
    const flight = Flight.compile(record(result)), hits = [];
    for (let t = 0; t <= flight.duration; t += .05) {
        const [x, y, z] = flight.evaluate(t).position;
        for (const b of boxes) if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z <= b.top) hits.push([t, x, y, z]);
    }
    return hits;
}

describe('generated camera flights', () => {
    it('aims a level camera at the target', () => {
        const eye = [10, -40, 30], target = [0, 0, 5], q = Auto.lookAt(eye, target);
        expect(Math.hypot(...q)).toBeCloseTo(1, 9);
        expect(angle(rotate(q, [0, 0, -1]), unitTo(eye, target))).toBeLessThan(1e-4);
        expect(Math.abs(rotate(q, [1, 0, 0])[2])).toBeLessThan(1e-9);
        expect(rotate(q, [0, 1, 0])[2]).toBeGreaterThan(0);
    });

    it('flies in to one design and orbits it from high to low, looking at it throughout', () => {
        const tower = building(0, 0, 20, 16, 30), subjects = [{ id: 'd1', buildings: [tower], outline: [] }];
        const neighbours = [building(70, 0, 16, 16, 18), building(-60, 50, 12, 30, 22)];
        const result = Auto.generate({ subjects, field: field(subjects, neighbours) });
        expect(result.kind).toBe('design');
        expect(Flight.validate(record(result))).toBeNull();
        const orbit = result.route.slice(1), target = [0, 0, 30 * .45];
        expect(orbit[0].position[2]).toBeGreaterThan(orbit[orbit.length - 1].position[2] + 30);
        // Approach starts well outside the orbit; every orbit view stays on its radius and aims at the design.
        const radius = Math.hypot(orbit[0].position[0], orbit[0].position[1]);
        expect(Math.hypot(...result.route[0].position.slice(0, 2))).toBeGreaterThan(radius * 2);
        for (const point of orbit) {
            expect(Math.abs(Math.hypot(point.position[0], point.position[1]) - radius)).toBeLessThan(1e-3);
            expect(angle(rotate(point.quaternion, [0, 0, -1]), unitTo(point.position, target))).toBeLessThan(.01);
        }
        // Between views the slerped aim stays on the design, and the curve never enters a building.
        const flight = Flight.compile(record(result)), times = Flight.timeline(record(result));
        for (let t = times.arrivals[1]; t <= flight.duration; t += .25) {
            const pose = flight.evaluate(t);
            expect(angle(rotate(pose.quaternion, [0, 0, -1]), unitTo(pose.position, target))).toBeLessThan(3);
        }
        expect(insideBuildings(result, [tower, ...neighbours])).toEqual([]);
        expect(flight.duration).toBeGreaterThan(30); expect(flight.duration).toBeLessThan(70);
    });

    it('climbs an orbit view until a taller neighbour no longer hides the design', () => {
        const target = building(0, 0, 20, 16, 18), subjects = [{ id: 'd', buildings: [target], outline: [] }];
        const neighbour = building(25, 0, 8, 40, 54), ground = field(subjects, [neighbour]);
        const result = Auto.generate({ subjects, field: ground }), aim = [0, 0, 18 * .45];
        const own = { min: target.min, max: target.max };
        expect(result.route.slice(1).every(p => Auto.sees(ground, p.position, aim, own))).toBe(true);
        // Without the rule the low end of the descent would look straight into the neighbour.
        expect(Auto.sees(ground, [35.5, 0, 12], aim, own)).toBe(false);
        expect(insideBuildings(result, [target, neighbour])).toEqual([]);
    });

    it('tours a plan from its farthest pair of buildings, winding between towers it cannot fly over', () => {
        const west = building(-220, 0, 20, 20, 20), middle = building(-40, 60, 14, 14, 12), east = building(220, 0, 20, 20, 24);
        const subjects = [{ id: 'a', buildings: [west], outline: [] }, { id: 'b', buildings: [middle], outline: [] }, { id: 'c', buildings: [east], outline: [] }];
        // A row of 80 m towers across the straight line, with one 30 m street through it at y ≈ -120.
        const wall = [building(0, 40, 30, 300, 80), building(0, -235, 30, 170, 80)];
        const result = Auto.generate({ subjects, field: field(subjects, wall) });
        expect(result.kind).toBe('plan');
        expect(Flight.validate(record(result))).toBeNull();
        const route = result.route, first = route[0].position, last = route[route.length - 1].position;
        expect(Math.hypot(first[0] + 220, first[1])).toBeLessThan(60);
        expect(Math.hypot(last[0] - 220, last[1])).toBeLessThan(60);
        // The towers are taller than anything the path would climb to: it goes through the street.
        expect(insideBuildings(result, [west, middle, east, ...wall])).toEqual([]);
        const crossing = route.filter(p => Math.abs(p.position[0]) < 20);
        expect(crossing.length).toBeGreaterThan(0);
        expect(crossing.every(p => p.position[1] < -110 && p.position[1] > -150 && p.position[2] < 80)).toBe(true);
        expect(Auto.obstructions(route, field(subjects, wall))).toEqual([]);
    });

    it('tours designs without buildings between their outlines, and varies by seed', () => {
        const subjects = [{ id: 'park', buildings: [], outline: [[-150, -80], [150, -80], [150, 80], [-150, 80]] },
            { id: 'square', buildings: [], outline: [[-20, -20], [20, -20], [20, 20], [-20, 20]] }];
        const ground = field(subjects), result = Auto.generate({ subjects, field: ground });
        expect(Flight.validate(record(result))).toBeNull();
        expect(Auto.generate({ subjects, field: ground })).toEqual(result);
        // Stops are the two designs' outline centres; another seed may reverse the tour or its turn.
        const first = result.route[0].position, last = result.route[result.route.length - 1].position;
        expect(Math.min(Math.hypot(first[0], first[1]), Math.hypot(last[0], last[1]))).toBeLessThan(61);
        const others = [1, 2, 3, 4, 5].map(seed => Auto.generate({ subjects, field: ground, seed }));
        expect(others[2]).toEqual(Auto.generate({ subjects, field: ground, seed: 3 }));
        expect(others.some(other => JSON.stringify(other.route) !== JSON.stringify(result.route))).toBe(true);
        for (const other of others) expect(Flight.validate(record(other))).toBeNull();
        // One design with only an outline is orbited like any other design.
        const lone = Auto.generate({ subjects: subjects.slice(0, 1), field: field(subjects.slice(0, 1)) });
        expect(lone.kind).toBe('design'); expect(Flight.validate(record(lone))).toBeNull();
    });

    it('reports a straight route through a building as obstructed', () => {
        const block = building(0, 0, 40, 40, 30), subjects = [{ id: 'd', buildings: [block], outline: [] }];
        const route = [[-100, 0, 10], [100, 0, 10]].map((position, i) => ({ id: 'p' + i, position, quaternion: [0, 0, 0, 1],
            travelSeconds: null, holdSeconds: 0, turn: null }));
        expect(Auto.obstructions(route, field(subjects)).length).toBeGreaterThan(0);
        route.forEach(p => { p.position[2] = 40; });
        expect(Auto.obstructions(route, field(subjects))).toEqual([]);
    });

    it('refuses subjects with nothing to fly around', () => {
        expect(() => Auto.generate({ subjects: [], field: null })).toThrow(/Choose a design/);
        expect(() => Auto.bounds([{ id: 'x', buildings: [], outline: [] }])).toThrow(/nothing to fly around/);
    });
});
