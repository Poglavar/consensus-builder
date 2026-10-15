// Checks bounded steering searches, complete road footprints and forward/reverse path continuity.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Geometry = require('../../frontend/traffic/geometry.js');
const Maneuvers = require('../../frontend/traffic/maneuvers.js');
const Vehicles = require('../../frontend/traffic/vehicles.js');
const Collision = require('../../frontend/traffic/collision.js');

const car = Vehicles.get('car');
const bus = Vehicles.get('bus');
const straightRoad = (width = 8) => [{ path: Geometry.path([[-40, 0], [40, 0]]), width }];
const difference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function turningGoal() {
    return { route: Geometry.path([[30, 2], [-30, 2]]), kind: 'turnaround',
        landing: { laneId: 'opposite', mode: 'lane' } };
}

function sampleBody(plan, start, onPose) {
    let previous = start;
    for (const segment of plan.segments) {
        for (let s = 0; s <= segment.path.length + 1e-8; s += .2) {
            const routePose = Geometry.sample(segment.path, Math.min(s, segment.path.length));
            const current = { ...routePose, angle: routePose.angle + (segment.gear < 0 ? Math.PI : 0) };
            onPose(current, previous);
            previous = current;
        }
    }
    return previous;
}

describe('traffic low-speed maneuvers', () => {
    it('checks the complete vehicle footprint against road width at different headings', () => {
        const space = new Maneuvers.Space(straightRoad(8));
        expect(space.contains({ x: 0, y: 0, angle: 0 }, car)).toBe(true);
        expect(space.contains({ x: 0, y: 0, angle: Math.PI / 2 }, car)).toBe(true);
        expect(space.contains({ x: 0, y: 0, angle: 0 }, bus)).toBe(true);
        expect(space.contains({ x: 0, y: 0, angle: Math.PI / 2 }, bus)).toBe(false);
        expect(new Maneuvers.Space(straightRoad(12))
            .contains({ x: 0, y: 0, angle: Math.PI / 2 }, bus)).toBe(true);
    });

    it('finds and incrementally advances a collision-free forward/reverse/forward car turnaround', () => {
        const space = new Maneuvers.Space(straightRoad(8));
        const start = { x: 0, y: -2, angle: 0 };
        const clear = pose => space.contains(pose, car);
        const search = new Maneuvers.Search({ start, vehicle: car, goals: [turningGoal()], clear,
            maxNodes: 2400, maxDistance: 24 });
        while (!search.done) {
            const before = search.nodes;
            search.advance(7);
            expect(search.nodes - before).toBeLessThanOrEqual(7);
        }
        const plan = search.result;
        expect(plan).toBeTruthy();
        expect(plan.segments.map(segment => segment.gear)).toEqual([1, -1, 1]);
        expect(plan.landing).toMatchObject({ laneId: 'opposite', mode: 'lane' });
        expect(Maneuvers.validate(plan, clear, start)).toBe(true);

        for (const segment of plan.segments) {
            for (let i = 1; i < segment.path.points.length - 1; i++) {
                const before = segment.path.points[i - 1], at = segment.path.points[i], after = segment.path.points[i + 1];
                const incoming = Math.atan2(at[1] - before[1], at[0] - before[0]);
                const outgoing = Math.atan2(after[1] - at[1], after[0] - at[0]);
                const run = (Math.hypot(at[0] - before[0], at[1] - before[1])
                    + Math.hypot(after[0] - at[0], after[1] - at[1])) / 2;
                expect(Math.abs(difference(outgoing, incoming)) / run)
                    .toBeLessThanOrEqual(1 / car.turnRadius + .002);
            }
        }
        sampleBody(plan, start, (current, previous) => {
            expect(clear(current)).toBe(true);
            expect(Math.hypot(current.x - previous.x, current.y - previous.y)).toBeLessThanOrEqual(.21);
            expect(Math.abs(difference(current.angle, previous.angle))).toBeLessThan(.15);
        });
        const landing = Geometry.sample(plan.segments.at(-1).path, plan.segments.at(-1).path.length);
        expect(landing.y).toBeCloseTo(2, 1);
        expect(Math.cos(landing.angle)).toBeLessThan(-.99);
    });

    it('respects the node and travel bounds when a feasible goal is unavailable', () => {
        const start = { x: 0, y: -2, angle: 0 };
        const capped = new Maneuvers.Search({ start, vehicle: car, goals: [turningGoal()],
            clear: () => true, maxNodes: 5, maxDistance: 24 });
        while (!capped.done) capped.advance(2);
        expect(capped.result).toBeNull();
        expect(capped.nodes).toBeLessThanOrEqual(5);

        const distanceLimited = new Maneuvers.Search({ start, vehicle: car, goals: [turningGoal()],
            clear: () => true, maxNodes: 100, maxDistance: .25 });
        while (!distanceLimited.done) distanceLimited.advance(10);
        expect(distanceLimited.result).toBeNull();
        expect(distanceLimited.nodes).toBe(1);
    });

    it('rejects a turnaround blocked by a full-width barricade instead of jumping through it', () => {
        const space = new Maneuvers.Space(straightRoad(8));
        const barricade = { pose: { x: 0, y: 0, angle: 0 }, length: 80, width: .5 };
        const clear = pose => space.contains(pose, car)
            && !Collision.overlapsRectangle(pose, barricade.pose, barricade.length, barricade.width);
        const plan = Maneuvers.find({ start: { x: 0, y: -2, angle: 0 }, vehicle: car,
            goals: [turningGoal()], clear, maxNodes: 1200, maxDistance: 24 });
        expect(plan).toBeNull();
    });

    it('respects the minimum steering radius and keeps body heading stable in reverse', () => {
        const radius = car.turnRadius;
        for (const gear of [1, -1]) {
            const points = Maneuvers.primitive({ x: 0, y: 0, angle: .2 }, gear, 1, radius, 1.4);
            for (let i = 1; i < points.length; i++) {
                const before = points[i - 1], current = points[i];
                const distance = Math.hypot(current.x - before.x, current.y - before.y);
                expect(Math.abs(difference(current.angle, before.angle)) / distance)
                    .toBeLessThanOrEqual(1 / radius + .002);
            }
        }
        const reverse = Maneuvers.primitive({ x: 0, y: 0, angle: 0 }, -1, 0, radius, 2);
        expect(reverse.at(-1).x).toBeCloseTo(-2, 2);
        expect(reverse.at(-1).y).toBeCloseTo(0, 4);
        expect(reverse.at(-1).angle).toBeCloseTo(0, 6);
    });
});
