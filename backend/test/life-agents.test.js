// Unit tests for the 3D-life vehicle simulation (frontend/js/life/life-agents.js) on small drive-only
// graphs: determinism, population caps, acceleration, car-following, junction choice, dead ends, step().
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lifeGraph = require('../../frontend/js/life/life-graph.js');
const { createSimulation, VEHICLE_KINDS } = require('../../frontend/js/life/life-agents.js');

const ACCEL = 2.5; // m/s², the module's acceleration limit
const SLOW_MS = 30000; // ceiling for the long simulations on a busy machine; they take ~1 s when quiet
const project = (x, y) => [x, y];

const street = (tags, coordinates) => ({
    type: 'Feature', properties: { highway_type: tags.highway, tags: { sidewalk: 'no', ...tags } },
    geometry: { type: 'LineString', coordinates }
});
function graphOf(features) {
    const builder = lifeGraph.createGraphBuilder();
    builder.addOsmRoads(features, project);
    return builder.build();
}
// No walkable surface, so no people: nobody else draws from the seeded random stream and every
// outcome below is the vehicles' own.
const simulate = (graph, options) => createSimulation(graph, null, options);

// A 300 m single-lane loop of four oneway 75 m edges: traffic circulates forever.
const loopGraph = () => graphOf([[[0, 0], [75, 0]], [[75, 0], [75, 75]], [[75, 75], [0, 75]], [[0, 75], [0, 0]]]
    .map(coordinates => street({ highway: 'residential', oneway: 'yes' }, coordinates)));
// Two two-way streets crossing at a shared vertex: a 4-way junction with four dead-end arms.
const crossGraph = () => graphOf([
    street({ highway: 'residential' }, [[-60, 0], [0, 0], [60, 0]]),
    street({ highway: 'residential' }, [[0, -60], [0, 0], [0, 60]])
]);

const vehicleState = sim => sim.vehicles.map(v => ({ track: v.track, s: v.s, v: v.v, x: v.x, y: v.y, heading: v.heading }));

// Arc-length position of each loop track's start, following each track's single continuation.
function loopOffsets(graph) {
    const offsets = new Map();
    let track = graph.tracks[0], at = 0;
    while (!offsets.has(track.id)) {
        offsets.set(track.id, at);
        at += track.len;
        track = graph.tracks[graph.nodes.get(track.to).out[0]];
    }
    return { offsets, total: at };
}

// Smallest bumper-to-bumper gap between neighbours around the loop; negative means overlap.
function loopClearance(sim, loop) {
    const sorted = sim.vehicles.map(v => ({ v, at: loop.offsets.get(v.track) + v.s })).sort((a, b) => a.at - b.at);
    let min = Infinity;
    sorted.forEach((a, i) => {
        const b = sorted[(i + 1) % sorted.length];
        const ahead = b.at - a.at + (i === sorted.length - 1 ? loop.total : 0);
        min = Math.min(min, ahead - (a.v.len + b.v.len) / 2);
    });
    return min;
}

// Two vehicles on the same track proper (s ≥ 0), entered from different tracks, overlapping.
function mergeOverlap(vehicles, cameFrom) {
    for (const a of vehicles) {
        for (const b of vehicles) {
            if (a.id >= b.id || a.track !== b.track || a.s < 0 || b.s < 0) continue;
            if (cameFrom[a.id] == null || cameFrom[b.id] == null || cameFrom[a.id] === cameFrom[b.id]) continue;
            if (Math.abs(a.s - b.s) < (a.len + b.len) / 2 - 0.2) return [a, b];
        }
    }
    return null;
}

// Smallest |Δs| − (len_a + len_b)/2 over all pairs of vehicles on the same track.
function sameTrackClearance(vehicles) {
    let min = Infinity;
    for (let i = 0; i < vehicles.length; i++) {
        for (let j = i + 1; j < vehicles.length; j++) {
            const a = vehicles[i], b = vehicles[j];
            if (a.track === b.track) min = Math.min(min, Math.abs(a.s - b.s) - (a.len + b.len) / 2);
        }
    }
    return min;
}

describe('createSimulation: population', () => {
    it('is deterministic for a seed and differs between seeds', () => {
        const run = seed => {
            const sim = simulate(crossGraph(), { seed });
            for (let i = 0; i < 100; i++) sim.step(0.1);
            return vehicleState(sim);
        };
        expect(run(5).length).toBeGreaterThan(5);
        expect(run(5)).toEqual(run(5));
        expect(run(6)).not.toEqual(run(5));
    });

    it('spawns one vehicle per 45 lane-metres, only on drive lanes, up to the cap', () => {
        const graph = graphOf([street({ highway: 'residential' }, [[0, 0], [2000, 0]])]); // 2 lanes × 2 km
        for (const seed of [1, 2, 3]) {
            const sim = simulate(graph, { seed });
            expect(sim.vehicles).toHaveLength(Math.round(4000 / 45));
            sim.vehicles.forEach(v => expect(graph.tracks[v.track].kind).toBe('drive'));
            expect(sim.stats()).toMatchObject({ vehicles: sim.vehicles.length, driveLength: 4000 });
        }
        expect(simulate(graph, { seed: 1, maxVehicles: 50 }).vehicles).toHaveLength(50);
        expect(simulate(graph, { seed: 1, maxVehicles: 0 }).vehicles).toHaveLength(0);
        const long = graphOf([street({ highway: 'residential' }, [[0, 0], [10000, 0]])]);
        expect(simulate(long, { seed: 1 }).vehicles).toHaveLength(100); // default cap
    });

    it('puts no vehicles on a network without drive lanes', () => {
        const footOnly = graphOf([street({ highway: 'footway' }, [[0, 0], [300, 0]])]);
        expect(simulate(footOnly, { seed: 1 }).vehicles).toHaveLength(0);
    });

    it("builds each vehicle to its kind's dimensions with a speed factor within ±15 %", () => {
        const graph = graphOf([street({ highway: 'residential' }, [[0, 0], [2000, 0]])]);
        const sim = simulate(graph, { seed: 2 });
        expect(new Set(sim.vehicles.map(v => v.kind)).size).toBeGreaterThan(1);
        sim.vehicles.forEach(v => {
            const spec = VEHICLE_KINDS[v.kind];
            expect(v).toMatchObject({ len: spec.len, width: spec.width, height: spec.height, clearance: spec.clearance, wheelRadius: spec.wheelRadius });
            expect(v.speedFactor).toBeGreaterThanOrEqual(spec.speedFactor * 0.85);
            expect(v.speedFactor).toBeLessThanOrEqual(spec.speedFactor * 1.15);
        });
    });
});

describe('vehicles: motion', () => {
    it('accelerates a lone vehicle from 0.6 × cruise toward cruise without exceeding it', () => {
        const graph = graphOf([street({ highway: 'residential', oneway: 'yes' }, [[0, 0], [2000, 0]])]);
        const sim = simulate(graph, { seed: 1, maxVehicles: 1 });
        const [vehicle] = sim.vehicles;
        const track = graph.tracks[vehicle.track];
        const cruise = track.speed * vehicle.speedFactor;
        expect(vehicle.v).toBeCloseTo(0.6 * cruise, 9);
        expect(vehicle.s).toBeLessThan(track.len - 50); // a free lane ahead for the whole second
        const s0 = vehicle.s, v0 = vehicle.v;
        sim.step(1);
        const advanced = vehicle.s - s0;
        expect(advanced).toBeGreaterThan(v0);
        expect(advanced).toBeLessThan(cruise);
        expect(Math.abs(advanced - (v0 + 0.5 * ACCEL))).toBeLessThan(0.2); // v0·t + ½·a·t²
        expect(vehicle.v).toBeCloseTo(Math.min(cruise, v0 + ACCEL), 9);
        expect(vehicle.x).toBeCloseTo(vehicle.s, 9); // on the lane: x = s along y = 0
        expect(vehicle.y).toBeCloseTo(0, 9);
    });

    it('never lets car-following run a vehicle into the one ahead on a single-lane loop', () => {
        const graph = loopGraph();
        const loop = loopOffsets(graph);
        const violations = [];
        let seedsRun = 0;
        for (let seed = 1; seed <= 12; seed++) {
            const sim = simulate(graph, { seed, vehicleSpacingM: 8 });
            // Spawning across a node can already overlap (next test); judge following from a clear start.
            if (loopClearance(sim, loop) < 0) continue;
            seedsRun++;
            expect(sim.vehicles.length).toBeGreaterThanOrEqual(12);
            for (let i = 1; i <= 1200 && violations.length === 0; i++) {
                sim.step(0.05);
                const clearance = Math.min(sameTrackClearance(sim.vehicles), loopClearance(sim, loop));
                const broken = sim.vehicles.find(v => !(Number.isFinite(v.v) && v.v >= 0 && Number.isFinite(v.x) && Number.isFinite(v.y)));
                if (clearance < -0.2 || broken) violations.push({ seed, t: i * 0.05, clearance, broken: broken && broken.id });
            }
        }
        expect(seedsRun).toBeGreaterThanOrEqual(5);
        expect(violations).toEqual([]);
    }, SLOW_MS);

    it('spawns vehicles clear of each other along the loop, including across nodes', () => {
        const graph = loopGraph();
        const loop = loopOffsets(graph);
        const overlapping = [];
        for (let seed = 1; seed <= 12; seed++) {
            const sim = simulate(graph, { seed, vehicleSpacingM: 8 });
            expect(sameTrackClearance(sim.vehicles)).toBeGreaterThan(0); // within one track spawning keeps its distance
            const clearance = loopClearance(sim, loop);
            if (clearance < 0) overlapping.push({ seed, clearance: Number(clearance.toFixed(2)) });
        }
        expect(overlapping).toEqual([]);
    });

    it('never lets two vehicles merging onto one exit track from different approaches overlap on it', () => {
        const graph = crossGraph();
        const conflicts = [];
        for (let seed = 1; seed <= 5; seed++) {
            const sim = simulate(graph, { seed, vehicleSpacingM: 15 });
            const previous = sim.vehicles.map(v => v.track);
            const cameFrom = sim.vehicles.map(() => null); // the track each vehicle entered its current one from
            for (let i = 1; i <= 1200; i++) {
                sim.step(0.05);
                sim.vehicles.forEach(v => {
                    if (v.track === previous[v.id]) return;
                    const from = graph.tracks[previous[v.id]];
                    cameFrom[v.id] = from.to === graph.tracks[v.track].from ? from.id : null;
                    previous[v.id] = v.track;
                });
                const pair = mergeOverlap(sim.vehicles, cameFrom);
                if (pair) {
                    const [a, b] = pair;
                    conflicts.push({ seed, t: Number((i * 0.05).toFixed(2)), track: a.track, from: [cameFrom[a.id], cameFrom[b.id]], s: [a.s, b.s].map(s => Number(s.toFixed(2))) });
                    break;
                }
            }
        }
        expect(conflicts).toEqual([]);
    }, SLOW_MS);

    it('respawns a vehicle that reaches a dead end onto a drive track', () => {
        const graph = graphOf([
            street({ highway: 'residential', oneway: 'yes' }, [[0, 0], [200, 0]]), // dead end at x = 200
            street({ highway: 'residential' }, [[0, 100], [300, 100]]) // a separate two-way street
        ]);
        const deadEnd = graph.tracks.find(track => track.wayId === 'osm:0');
        expect(graph.nodes.get(deadEnd.to).out).toEqual([]);
        const sim = simulate(graph, { seed: 1 });
        const previous = sim.vehicles.map(v => ({ track: v.track, s: v.s }));
        const respawns = [], pastTheEnd = [];
        for (let i = 1; i <= 600; i++) {
            sim.step(0.1);
            for (const v of sim.vehicles) {
                const before = previous[v.id];
                const track = graph.tracks[v.track];
                if (before.track === deadEnd.id && (v.track !== deadEnd.id || v.s < before.s - 1)) {
                    respawns.push({ kind: track.kind, s: v.s, len: track.len, joinLen: v.joinLen, v: v.v, entry: 0.6 * track.speed * v.speedFactor });
                }
                if (v.s > track.len) pastTheEnd.push({ t: i * 0.1, id: v.id, s: v.s, len: track.len });
                previous[v.id] = { track: v.track, s: v.s };
            }
        }
        expect(respawns.length).toBeGreaterThan(0);
        respawns.forEach(r => {
            expect(r.kind).toBe('drive');
            expect(r.s).toBeGreaterThanOrEqual(-r.joinLen);
            expect(r.s).toBeLessThanOrEqual(r.len);
            expect(r.v).toBeCloseTo(r.entry, 9); // re-enters at 0.6 × cruise, like a fresh spawn
        });
        expect(pastTheEnd).toEqual([]); // nobody is left past the end of a track
    }, SLOW_MS);

    it('takes every exit of a 4-way junction and never U-turns there, only at the dead ends', () => {
        const graph = crossGraph();
        const centre = lifeGraph.nodeKey(0, 0);
        const transitions = [];
        for (const seed of [1, 2, 3]) {
            const sim = simulate(graph, { seed });
            const previous = sim.vehicles.map(v => v.track);
            for (let i = 0; i < 1200; i++) { // 120 s
                sim.step(0.1);
                for (const v of sim.vehicles) {
                    if (v.track === previous[v.id]) continue;
                    transitions.push({ from: previous[v.id], to: v.track });
                    previous[v.id] = v.track;
                }
            }
        }
        const track = id => graph.tracks[id];
        // Always onward through the node it reached.
        expect(transitions.filter(({ from, to }) => track(to).from !== track(from).to)).toEqual([]);
        const atCentre = transitions.filter(({ from }) => track(from).to === centre);
        const atEnds = transitions.filter(({ from }) => track(from).to !== centre);
        const uTurn = ({ from, to }) => track(to).to === track(from).from;
        expect(atCentre.length).toBeGreaterThan(20);
        expect(atCentre.filter(uTurn)).toEqual([]);
        expect(new Set(atCentre.map(({ to }) => to)).size).toBe(graph.nodes.get(centre).out.length);
        expect(atEnds.length).toBeGreaterThan(0);
        expect(atEnds.every(uTurn)).toBe(true); // a dead-end arm offers only the way back
    }, SLOW_MS);
});

describe('step', () => {
    it('ignores zero, negative, NaN and missing time steps', () => {
        const sim = simulate(crossGraph(), { seed: 3 });
        sim.step(0.5);
        const before = JSON.stringify(sim.vehicles);
        sim.step(0);
        sim.step(-1);
        sim.step(NaN);
        sim.step(undefined);
        expect(JSON.stringify(sim.vehicles)).toBe(before);
    });

    it('integrates a long frame as at most one second of 0.1 s sub-steps', () => {
        const graph = loopGraph();
        const loop = loopOffsets(graph);
        const fresh = () => simulate(graph, { seed: 4, vehicleSpacingM: 20 });
        const long = fresh(), oneSecond = fresh(), tenths = fresh();
        const startAt = long.vehicles.map(v => loop.offsets.get(v.track) + v.s);
        long.step(5);
        oneSecond.step(1);
        for (let i = 0; i < 10; i++) tenths.step(0.1);
        expect(vehicleState(long)).toEqual(vehicleState(oneSecond));
        expect(vehicleState(tenths)).toEqual(vehicleState(oneSecond));
        long.vehicles.forEach((v, i) => {
            const advanced = (loop.offsets.get(v.track) + v.s - startAt[i] + loop.total) % loop.total;
            expect(advanced).toBeLessThanOrEqual(graph.tracks[v.track].speed * v.speedFactor + 1e-9);
        });
    });
});
