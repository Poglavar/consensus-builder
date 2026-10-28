// People in the life simulation (frontend/js/life/life-agents.js): crowd sizing from walkable area,
// wandering that never enters footprints or strolls along carriageways, pauses, walk-cycle phase,
// and surface replacement keeping the crowd in place.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lifeGraph = require('../../frontend/js/life/life-graph.js');
const { buildWalkableSurface, CLASS } = require('../../frontend/js/life/life-surface.js');
const { createSimulation, PERSON_PER_M2, PAIR_GAP_M } = require('../../frontend/js/life/life-agents.js');

const identity = (lng, lat) => [lng, lat];
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

// A block: two crossing streets with sidewalks, a plaza, a footway and two buildings.
function blockScene() {
    const b = lifeGraph.createGraphBuilder();
    b.addOsmRoads([
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-150, 0], [150, 0]] }, properties: { highway_type: 'residential', tags: { lanes: '2' } } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, -150], [0, 150]] }, properties: { highway_type: 'tertiary', tags: { lanes: '2' } } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[20, 20], [60, 60]] }, properties: { highway_type: 'footway', tags: {} } }
    ], identity);
    b.addSquare({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(30, -70, 80, -20)] }, properties: { decorations: { fountain: { coordinate: [55, -45], radius: 3 } } } }, identity);
    b.addBlockedFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-70, 10, -20, 50)] } }, identity);
    b.addBlockedFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-70, -60, -20, -15)] } }, identity);
    const graph = b.build();
    const surface = buildWalkableSurface({ bounds: [-170, -170, 170, 170], ...graph.surface });
    return { graph, surface };
}

describe('people population', () => {
    it('retains the authored square density when a large OSM context consumes the crowd cap', () => {
        const b = lifeGraph.createGraphBuilder();
        b.addSquare({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-50, -100, 50, -50)] } }, identity);
        b.addOsmRoads([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-290, 20, 290, 290)] },
            properties: { highway_type: 'pedestrian', tags: { area: 'yes' } } }], identity);
        const graph = b.build();
        const surface = buildWalkableSurface({ bounds: [-300, -300, 300, 300], ...graph.surface });
        const sim = createSimulation(graph, surface, { seed: 3, maxPeople: 64, maxVehicles: 0 });
        const inSquare = sim.people.filter(p => p.x >= -50 && p.x <= 51 && p.y >= -100 && p.y <= -50);
        expect(sim.people).toHaveLength(64);
        expect(inSquare.length).toBeGreaterThanOrEqual(Math.round(surface.stats.authoredPreferredAreaM2 * PERSON_PER_M2));
        expect(sim.people.some(p => p.y > 20)).toBe(true);
    });

    it('excludes blocked footprints from the authored walking allocation', () => {
        const b = lifeGraph.createGraphBuilder();
        b.addPark({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-50, -50, 50, 50)] } }, identity);
        b.addBlockedFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-60, -60, 60, 60)] } }, identity);
        b.addOsmRoads([{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-150, 100], [150, 100]] },
            properties: { highway_type: 'footway' } }], identity);
        const graph = b.build();
        const surface = buildWalkableSurface({ bounds: [-170, -170, 170, 170], ...graph.surface });
        expect(surface.stats.authoredPreferredAreaM2).toBe(0);
        const sim = createSimulation(graph, surface, { seed: 3, maxPeople: 64, maxVehicles: 0 });
        expect(sim.people.length).toBeGreaterThan(0);
        expect(sim.people.every(p => surface.classAt(p.x, p.y) === CLASS.PREFERRED)).toBe(true);
        expect(sim.people.every(p => p.y > 90)).toBe(true);
    });

    it('sizes the crowd from the walkable area and respects the cap', () => {
        const { graph, surface } = blockScene();
        const expected = Math.round((surface.stats.preferredAreaM2 + 0.05 * surface.stats.openAreaM2) * PERSON_PER_M2);
        const sim = createSimulation(graph, surface, { seed: 3, maxPeople: 500, maxVehicles: 0 });
        expect(sim.people.length).toBe(expected);
        expect(sim.vehicles.length).toBe(0);
        const capped = createSimulation(graph, surface, { seed: 3, maxPeople: 10, maxVehicles: 0 });
        expect(capped.people.length).toBe(10);
    });

    it('spawns everyone in preferred walking space with a height and a destination', () => {
        const { graph, surface } = blockScene();
        const sim = createSimulation(graph, surface, { seed: 11, maxPeople: 64, maxVehicles: 0 });
        expect(sim.people.length).toBeGreaterThan(20);
        for (const p of sim.people) {
            expect(surface.classAt(p.x, p.y)).toBe(CLASS.PREFERRED);
            expect(p.height).toBeGreaterThan(1.1);
            expect(p.height).toBeLessThan(1.95);
            expect(p.target === null || Array.isArray(p.target)).toBe(true);
        }
    });

    it('has no people without a surface', () => {
        const { graph } = blockScene();
        const sim = createSimulation(graph, null, { seed: 1, maxPeople: 64, maxVehicles: 0 });
        expect(sim.people.length).toBe(0);
        sim.step(1);
    });
});

describe('wandering', () => {
    it('never enters a footprint or stands in a carriageway run, over two simulated minutes', () => {
        const { graph, surface } = blockScene();
        const sim = createSimulation(graph, surface, { seed: 21, maxPeople: 64, maxVehicles: 0 });
        let inBlocked = 0, inRoad = 0, moved = 0, samples = 0;
        const start = sim.people.map(p => [p.x, p.y]);
        for (let t = 0; t < 1200; t++) {
            sim.step(0.1);
            for (const p of sim.people) {
                samples++;
                const c = surface.classAt(p.x, p.y);
                if (c === CLASS.BLOCKED) inBlocked++;
                if (c === CLASS.CARRIAGEWAY) inRoad++;
                expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
            }
        }
        sim.people.forEach((p, i) => { if (Math.hypot(p.x - start[i][0], p.y - start[i][1]) > 5) moved++; });
        expect(inBlocked).toBe(0);
        // Crossing a 7 m street at 1 m/s takes a handful of 0.1 s samples; strolling along it would not.
        expect(inRoad / samples).toBeLessThan(0.12);
        expect(moved).toBeGreaterThan(sim.people.length * 0.8);
    });

    it('walks at its own speed, advances the stride while walking and lets it rest while waiting', () => {
        const { graph, surface } = blockScene();
        const sim = createSimulation(graph, surface, { seed: 8, maxPeople: 64, maxVehicles: 0 });
        const p = sim.people.find(person => person.target && person.wait === 0);
        expect(p).toBeTruthy();
        const before = { x: p.x, y: p.y, stride: p.stride };
        sim.step(0.5);
        const d = Math.hypot(p.x - before.x, p.y - before.y);
        expect(d).toBeGreaterThan(0.3);
        expect(d).toBeLessThanOrEqual(p.speed * 0.5 + 1e-6);
        expect(p.stride).toBeGreaterThan(before.stride);

        let sawWait = false;
        for (let t = 0; t < 1200 && !sawWait; t++) {
            sim.step(0.1);
            for (const q of sim.people) {
                if (q.wait > 0) {
                    const stride = q.stride;
                    const x = q.x, y = q.y;
                    sim.step(0.1);
                    expect(q.stride).toBe(stride);
                    expect(q.x).toBe(x);
                    expect(q.y).toBe(y);
                    expect(q.amp).toBeLessThan(1);
                    sawWait = true;
                    break;
                }
            }
        }
        expect(sawWait).toBe(true);
    });

    it('is deterministic for a seed', () => {
        const { graph, surface } = blockScene();
        const a = createSimulation(graph, surface, { seed: 42, maxPeople: 40, maxVehicles: 0 });
        const b = createSimulation(graph, surface, { seed: 42, maxPeople: 40, maxVehicles: 0 });
        const c = createSimulation(graph, surface, { seed: 43, maxPeople: 40, maxVehicles: 0 });
        for (let t = 0; t < 100; t++) { a.step(0.1); b.step(0.1); c.step(0.1); }
        expect(a.people.map(p => [p.x, p.y])).toEqual(b.people.map(p => [p.x, p.y]));
        expect(a.people.map(p => [p.x, p.y])).not.toEqual(c.people.map(p => [p.x, p.y]));
    });
});

describe('pairs and children', () => {
    it('sets some walkers out in pairs, half of the companions children, and no one marches in step', () => {
        const { graph, surface } = blockScene();
        const sim = createSimulation(graph, surface, { seed: 5, maxPeople: 64, maxVehicles: 0 });
        const companions = sim.people.filter(p => p.partner != null);
        expect(companions.length).toBeGreaterThan(4);
        expect(companions.length).toBeLessThan(sim.people.length / 2);
        expect(companions.some(p => p.child)).toBe(true);
        expect(companions.some(p => !p.child)).toBe(true);
        for (const c of companions) {
            const leader = sim.people[c.partner];
            expect(leader.partner).toBeNull();
            expect(Math.hypot(c.x - leader.x, c.y - leader.y)).toBeLessThanOrEqual(PAIR_GAP_M + 1e-6);
            expect(c.speed).toBeGreaterThan(leader.speed);
            expect(c.stride).not.toBe(leader.stride);
            expect(c.gait).not.toBe(leader.gait);
        }
        for (const p of sim.people) {
            if (p.child) { expect(p.height).toBeGreaterThanOrEqual(1.1); expect(p.height).toBeLessThanOrEqual(1.4); }
            else expect(p.height).toBeGreaterThanOrEqual(1.55);
            expect(p.gait).toBeGreaterThanOrEqual(0.85); expect(p.gait).toBeLessThanOrEqual(1.15);
            expect(p.swing).toBeGreaterThanOrEqual(0.75); expect(p.swing).toBeLessThanOrEqual(1.1);
        }
    });

    it('keeps a companion beside its partner over two simulated minutes, never in a footprint, crossing streets with them and resting with them', () => {
        const { graph, surface } = blockScene();
        const sim = createSimulation(graph, surface, { seed: 5, maxPeople: 64, maxVehicles: 0 });
        const companions = sim.people.filter(p => p.partner != null);
        let far = 0, samples = 0, restedTogether = 0, walkedTogether = 0, inRoad = 0, together = 0;
        for (let t = 0; t < 1200; t++) {
            const before = companions.map(c => [c.x, c.y, c.stride]);
            sim.step(0.1);
            companions.forEach((c, i) => {
                const leader = sim.people[c.partner];
                samples++;
                expect(surface.isBlocked(c.x, c.y)).toBe(false);
                if (surface.classAt(c.x, c.y) === CLASS.CARRIAGEWAY) inRoad++;
                const gap = Math.hypot(c.x - leader.x, c.y - leader.y);
                if (gap > 3) far++;
                if (gap < 1.2) together++;
                const stood = c.x === before[i][0] && c.y === before[i][1] && c.stride === before[i][2];
                if (leader.wait > 0 && gap < 1.2 && stood) restedTogether++;
                if (leader.wait === 0 && gap < 1.2 && !stood) walkedTogether++;
            });
        }
        expect(far / samples).toBeLessThan(0.02);
        expect(inRoad / samples).toBeLessThan(0.12); // crosses the street with its partner, never strolls along it
        expect(restedTogether).toBeGreaterThan(0);
        expect(together / samples).toBeGreaterThan(0.8);
        expect(walkedTogether / samples).toBeGreaterThan(0.25); // the rest is standing together while the partner pauses
    });
});

describe('replaceSurface', () => {
    it('keeps the crowd, moves anyone now inside a footprint and drops legs through it', () => {
        const { graph, surface } = blockScene();
        const sim = createSimulation(graph, surface, { seed: 5, maxPeople: 64, maxVehicles: 0 });
        const count = sim.people.length;
        // A new building lands on the north sidewalk of the east–west street.
        const b = lifeGraph.createGraphBuilder();
        b.addOsmRoads([
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-150, 0], [150, 0]] }, properties: { highway_type: 'residential', tags: { lanes: '2' } } },
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, -150], [0, 150]] }, properties: { highway_type: 'tertiary', tags: { lanes: '2' } } }
        ], identity);
        b.addBlockedFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(20, 3, 150, 12)] } }, identity);
        const next = buildWalkableSurface({ bounds: [-170, -170, 170, 170], ...b.build().surface });
        sim.replaceSurface(next);
        expect(sim.people.length).toBeGreaterThanOrEqual(count);
        for (const p of sim.people) {
            expect(next.isWalkable(p.x, p.y)).toBe(true);
            if (p.target) expect(next.legOk(p.x, p.y, p.target[0], p.target[1])).toBe(true);
        }
        sim.step(5);
        for (const p of sim.people) expect(next.classAt(p.x, p.y)).not.toBe(CLASS.BLOCKED);
    });
});
