// Dogs in the 3D life layer: walked on a lead by adults in the simulation (life/life-agents.js),
// drawn as breeds of their own build (three-life.js dogParts), the lead running hand to collar.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lifeGraph = require('../../frontend/js/life/life-graph.js');
const { buildWalkableSurface } = require('../../frontend/js/life/life-surface.js');
const { createSimulation, DOG_BREEDS, LEASH_M } = require('../../frontend/js/life/life-agents.js');
const threeLife = require('../../frontend/js/three-life.js');
const THREE = require('three');

const identity = (lng, lat) => [lng, lat];
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

// A big pedestrian square with two buildings in it: plenty of walkers, so plenty of dogs.
function plaza() {
    const b = lifeGraph.createGraphBuilder();
    b.addSquare({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-120, -120, 120, 120)] } }, identity);
    b.addBlockedFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-60, -20, -20, 20)] } }, identity);
    b.addBlockedFeature({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(20, -20, 60, 20)] } }, identity);
    const graph = b.build();
    return { graph, surface: buildWalkableSurface({ bounds: [-140, -140, 140, 140], ...graph.surface }) };
}

// Dog-frame point through a part's matrix.
function partPoint(part, local) {
    const e = new Array(16);
    threeLife.writeMatrix(e, 0, 0, 0, 0, part.yaw || 0, part.a, part.sx, part.sy, part.sz, part.ox, part.oy, part.oz);
    return [0, 1, 2].map(r => e[r] * local[0] + e[4 + r] * local[1] + e[8 + r] * local[2] + e[12 + r]);
}
const dogOf = breed => ({ ...DOG_BREEDS[breed], breed, x: 0, y: 0, z: 0, heading: 0, nose: 0, wag: 0 });

describe('dogs in the life simulation', () => {
    it('go with adults walking on their own, several breeds, without changing the crowd', () => {
        const { graph, surface } = plaza();
        const sim = createSimulation(graph, surface, { seed: 5, maxPeople: 200, maxVehicles: 0 });
        expect(sim.dogs.length).toBeGreaterThan(5);
        for (const dog of sim.dogs) {
            const owner = sim.people[dog.owner];
            expect(owner.child).toBe(false);
            expect(owner.partner).toBe(null);
            expect(owner.dog).toBe(dog.id);
        }
        expect(new Set(sim.dogs.map(d => d.breed)).size).toBeGreaterThanOrEqual(3);
        expect(sim.stats().dogs).toBe(sim.dogs.length);
    });

    it('keep within the lead of their walker and off footprints while walking and sniffing', () => {
        const { graph, surface } = plaza();
        const sim = createSimulation(graph, surface, { seed: 9, maxPeople: 200, maxVehicles: 0 });
        let moved = 0, sniffed = 0;
        const start = sim.dogs.map(d => [d.x, d.y]);
        for (let t = 0; t < 600; t++) {
            sim.step(0.1);
            for (const dog of sim.dogs) {
                const owner = sim.people[dog.owner];
                expect(Math.hypot(dog.x - owner.x, dog.y - owner.y)).toBeLessThanOrEqual(LEASH_M + 3);
                expect(surface.isBlocked(dog.x, dog.y)).toBe(false);
                if (dog.nose > 0.9) sniffed++;
            }
        }
        sim.dogs.forEach((d, i) => { if (Math.hypot(d.x - start[i][0], d.y - start[i][1]) > 5) moved++; });
        expect(moved).toBeGreaterThan(sim.dogs.length / 2);
        expect(sniffed).toBeGreaterThan(0);
    });
});

describe('dog figures', () => {
    it('stand every breed on its four feet, head and tail clear of the body', () => {
        for (const breed of Object.keys(DOG_BREEDS)) {
            const d = dogOf(breed);
            const parts = threeLife.dogParts(d, 0);
            parts.legs.forEach(leg => expect(partPoint(leg, [0, 0, -1])[2]).toBeCloseTo(0, 9));
            const back = d.legM + d.depthM;
            expect(Math.max(...[1, -1].map(x => partPoint(parts.body, [x, 0, 0.5])[2]))).toBeCloseTo(back, 9);   // the top of the body is the back
            expect(partPoint(parts.body, [0, 0, 1])[0]).toBeCloseTo(d.bodyM / 2, 9);
            expect(parts.head.oz).toBeGreaterThan(back);
            expect(partPoint(parts.snout, [0, 0, 1])[0]).toBeGreaterThan(parts.head.ox);
            const tip = partPoint(parts.tail, [0, 0, -1]);
            expect(tip[0]).toBeLessThan(-d.bodyM / 2);
            expect(Math.sign(tip[2] - parts.tail.oz)).toBe(Math.sign(d.tailRad));
            parts.ears.forEach(ear => expect(partPoint(ear, [0, 0, -1])[2] > ear.oz).toBe(d.earsUp));
        }
        expect(DOG_BREEDS.dachshund.legM).toBeLessThan(DOG_BREEDS.shepherd.legM / 3);
    });

    it('trot in diagonal pairs and lower the head to sniff', () => {
        const d = dogOf('labrador');
        const legs = threeLife.dogParts(d, 0.4).legs;
        const footX = leg => partPoint(leg, [0, 0, -1])[0] - leg.ox;
        expect(footX(legs[0])).toBeCloseTo(footX(legs[3]), 9);   // front left with rear right
        expect(footX(legs[1])).toBeCloseTo(footX(legs[2]), 9);
        expect(footX(legs[0])).toBeCloseTo(-footX(legs[1]), 9);
        const sniffing = threeLife.dogParts({ ...d, nose: 1 }, 0);
        expect(sniffing.head.oz).toBeLessThan(threeLife.dogParts(d, 0).head.oz - 0.2);
        expect(partPoint(sniffing.snout, [0, 0, 1])[2]).toBeLessThan(sniffing.snout.oz);
    });

    it('run the lead from the walker\'s hand on the dog\'s side to its collar', () => {
        const owner = { x: 0, y: 0, z: 0, heading: 0, height: 1.75 };
        const d = { ...dogOf('labrador'), x: 1, y: 0.5, side: 1 };
        const parts = threeLife.dogParts(d, 0);
        const lead = threeLife.leashSegment(owner, d, parts.collar);
        expect(lead.y).toBeGreaterThan(0);
        const end = partPoint({ ox: 0, oy: 0, oz: 0, yaw: 0, a: lead.a, sx: 1, sy: 1, sz: lead.len }, [0, 0, -1]);
        const c = Math.cos(lead.yaw), s = Math.sin(lead.yaw);
        const world = [lead.x + c * end[0] - s * end[1], lead.y + s * end[0] + c * end[1], lead.z + end[2]];
        expect(world[0]).toBeCloseTo(d.x + parts.collar.ox, 9);
        expect(world[1]).toBeCloseTo(d.y, 9);
        expect(world[2]).toBeCloseTo(parts.collar.oz, 9);
    });

    it('draw any number of dogs in three more draws, and none without dogs', () => {
        const layer = threeLife.create({ THREE, k: 1 });
        const people = [{ x: 0, y: 0, z: 0, heading: 0, height: 1.7, stride: 0, colors: { skin: 0xffffff, shirt: 0, legs: 0 } }];
        layer.setSimulation({ vehicles: [], people, step() {} });
        const without = layer.stats().drawCalls;
        const dogs = [0, 1].map(id => ({ ...dogOf('beagle'), id, owner: 0, side: 1, stride: 0, amp: 1, coat: DOG_BREEDS.beagle.coats[0], x: id, y: 1 }));
        layer.setSimulation({ vehicles: [], people, dogs, step() {} });
        expect(layer.stats().drawCalls).toBe(without + 3);
        expect(layer.stats().dogs).toBe(2);
        const limbs = layer.group.children.find(mesh => mesh.count === 16);
        expect(limbs).toBeTruthy();
        expect([...limbs.instanceMatrix.array.slice(7 * 16, 8 * 16)].some(x => x !== 0)).toBe(true);   // the lead is drawn
        layer.dispose();
    });
});
