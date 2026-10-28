// Unit tests for the pure helpers of the 3D-life renderer (frontend/js/three-life.js): the instance
// matrix layout, vehicle part proportions, and walking and riding figure poses. No THREE needed.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeMatrix, writeHidden, vehicleParts, personParts, riderParts } = require('../../frontend/js/three-life.js');
const { VEHICLE_KINDS } = require('../../frontend/js/life/life-agents.js');

// Reference M = T(p) · Rz(yaw) · T(o) · Ry(a) · S(s) from plain row-major 4×4 products.
const multiply = (A, B) => A.map((row, r) => B[0].map((_, c) => row.reduce((sum, value, k) => sum + value * B[k][c], 0)));
const translate = (x, y, z) => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]];
const rotateZ = t => [[Math.cos(t), -Math.sin(t), 0, 0], [Math.sin(t), Math.cos(t), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const rotateY = t => [[Math.cos(t), 0, Math.sin(t), 0], [0, 1, 0, 0], [-Math.sin(t), 0, Math.cos(t), 0], [0, 0, 0, 1]];
const scale = (x, y, z) => [[x, 0, 0, 0], [0, y, 0, 0], [0, 0, z, 0], [0, 0, 0, 1]];
const columnMajor = M => [0, 1, 2, 3].flatMap(c => [0, 1, 2, 3].map(r => M[r][c]));
function reference({ p, yaw, a, s, o }) {
    return columnMajor([translate(...p), rotateZ(yaw), translate(...o), rotateY(a), scale(...s)].reduce(multiply));
}

function written({ p = [0, 0, 0], yaw = 0, a = 0, s = [1, 1, 1], o = [0, 0, 0] }) {
    const e = new Array(16);
    writeMatrix(e, 0, ...p, yaw, a, ...s, ...o);
    return e;
}
// The matrix the renderer writes for a part of a figure standing at the origin facing +x.
const partMatrix = part => written({ a: part.a || 0, s: [part.sx, part.sy, part.sz], o: [part.ox, part.oy, part.oz] });
// A local point through a column-major matrix.
const apply = (e, [x, y, z]) => [0, 1, 2].map(r => e[r] * x + e[4 + r] * y + e[8 + r] * z + e[12 + r]);

function expectClose(actual, expected, digits = 9) {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));
}

const vehicle = kind => ({ kind, ...VEHICLE_KINDS[kind] });
// Axis-aligned extent of a box part: box geometry spans x and y ±0.5 and z 0..1 before scaling.
const extent = part => ({
    x: [part.ox - part.sx / 2, part.ox + part.sx / 2], y: [part.oy - part.sy / 2, part.oy + part.sy / 2], z: [part.oz, part.oz + part.sz]
});

describe('writeMatrix', () => {
    it('writes scale and translation in three.js column-major order', () => {
        expectClose(written({ p: [10, 20, 30], s: [2, 3, 4] }), [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1]);
    });

    it('turns local x to +y and local y to −x at a yaw of 90°', () => {
        const e = written({ yaw: Math.PI / 2, s: [2, 3, 4] });
        expectClose(e.slice(0, 3), [0, 2, 0]);
        expectClose(e.slice(4, 7), [-3, 0, 0]);
        expectClose(e.slice(8, 11), [0, 0, 4]);
    });

    it('applies the offset in the agent frame, so it turns with the yaw', () => {
        expectClose(written({ p: [5, 6, 7], yaw: Math.PI / 2, o: [1, 0, 0] }).slice(12, 15), [5, 7, 7]);
        expectClose(written({ p: [5, 6, 7], yaw: Math.PI / 2, o: [0, 0, 2] }).slice(12, 15), [5, 6, 9]);
    });

    it('swings about the local y axis: a = 90° turns local z to +x and local x to −z', () => {
        const e = written({ a: Math.PI / 2 });
        expectClose(e.slice(8, 11), [1, 0, 0]);
        expectClose(e.slice(0, 3), [0, 0, -1]);
        expectClose(e.slice(4, 7), [0, 1, 0]);
    });

    it('matches T(p)·Rz(yaw)·T(o)·Ry(a)·S(s) for arbitrary poses and leaves its neighbours alone', () => {
        let state = 12345;
        const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 * 20 - 10; };
        for (let i = 0; i < 25; i++) {
            const pose = { p: [random(), random(), random()], yaw: random(), a: random(), s: [random(), random(), random()], o: [random(), random(), random()] };
            const target = new Array(48).fill(7);
            writeMatrix(target, 16, ...pose.p, pose.yaw, pose.a, ...pose.s, ...pose.o);
            expectClose(target.slice(16, 32), reference(pose), 9);
            expect(target.slice(0, 16).concat(target.slice(32))).toEqual(new Array(32).fill(7));
        }
    });

    it('carries a vehicle part forward along its heading: a northbound car has its front axle north', () => {
        const car = vehicle('car');
        const front = vehicleParts(car).wheels.find(wheel => wheel.ox > 0);
        const e = new Array(16);
        writeMatrix(e, 0, 100, 50, 0, Math.PI / 2, 0, front.r, front.w, front.r, front.ox, front.oy, front.oz);
        expect(e[13]).toBeCloseTo(50 + front.ox, 9);
        expect(e[12]).toBeCloseTo(100 - front.oy, 9);
    });
});

describe('writeHidden', () => {
    it('zeroes exactly the 16 entries at the offset', () => {
        const target = new Array(48).fill(7);
        writeHidden(target, 16);
        expect(target.slice(16, 32)).toEqual(new Array(16).fill(0));
        expect(target.slice(0, 16).concat(target.slice(32))).toEqual(new Array(32).fill(7));
    });
});

describe('vehicleParts', () => {
    it('gives a car a lower body to the waistline, a cabin on top of it, and four wheels on two axles', () => {
        const car = vehicle('car');
        const parts = vehicleParts(car);
        const body = extent(parts.body), cabin = extent(parts.glass);
        expect(body.z[0]).toBeCloseTo(car.clearance, 9);
        expect(body.z[1]).toBeCloseTo(0.88, 9);
        expect(cabin.z[0]).toBeCloseTo(body.z[1], 9); // the cabin sits on the body…
        expect(cabin.z[1]).toBeCloseTo(car.height, 9); // …and makes the roof
        expect(cabin.x[0]).toBeGreaterThanOrEqual(body.x[0]); // within the body's footprint
        expect(cabin.x[1]).toBeLessThanOrEqual(body.x[1]);
        expect(cabin.y[1] - cabin.y[0]).toBeLessThan(car.width);
        expect(parts.wheels).toHaveLength(4);
        expect(parts.wheels.filter(wheel => Math.abs(wheel.ox - car.frontAxle) < 1e-9 && wheel.steers)).toHaveLength(2);
        expect(parts.wheels.filter(wheel => Math.abs(wheel.ox + car.rearAxle) < 1e-9 && !wheel.steers)).toHaveLength(2);
        expect(parts.wheels.filter(wheel => wheel.oy > 0)).toHaveLength(2);
        expect(parts.rider).toBeNull();
    });

    it('gives a motorcycle two in-line wheels, a body from its clearance to its height, no glass and a rider', () => {
        const moto = vehicle('moto');
        const parts = vehicleParts(moto);
        expect(parts.glass).toBeNull();
        expect(parts.rider).toBe(true);
        expect(parts.wheels.map(wheel => wheel.ox)).toEqual([0.7, -0.7]);
        parts.wheels.forEach(wheel => {
            expect(wheel.oy).toBe(0);
            expect(wheel.ox + wheel.r).toBeLessThanOrEqual(moto.len / 2); // inside the bike's length
        });
        const body = extent(parts.body);
        expect(body.z[0]).toBeCloseTo(moto.clearance, 9);
        expect(body.z[1]).toBeCloseTo(moto.height, 9);
        expect(body.y[1] - body.y[0]).toBeCloseTo(moto.width, 9);
    });

    it('gives a bus a window band standing proud of its sides on long axles', () => {
        const bus = vehicle('bus');
        const parts = vehicleParts(bus);
        expect(parts.glass.sy).toBeGreaterThan(parts.body.sy);
        expect(parts.glass.sx).toBeLessThan(parts.body.sx);
        const body = extent(parts.body), band = extent(parts.glass);
        expect(band.z[0]).toBeGreaterThan(body.z[0]);
        expect(band.z[1]).toBeLessThan(body.z[1]);
        expect(parts.wheels).toHaveLength(4);
        expect(parts.wheels.map(wheel => wheel.ox)).toEqual([bus.frontAxle, bus.frontAxle, -bus.rearAxle, -bus.rearAxle]);
        expect(bus.frontAxle + bus.rearAxle).toBeCloseTo(5.9, 9); // a 12 m city bus's wheelbase
    });

    it('keeps every glass part visible outside its opaque body and every wheel on the road, flush inside the sides', () => {
        for (const kind of Object.keys(VEHICLE_KINDS)) {
            const v = vehicle(kind);
            const parts = vehicleParts(v);
            if (parts.glass) {
                const body = extent(parts.body), glass = extent(parts.glass);
                const hidden = ['x', 'y', 'z'].every(axis => glass[axis][0] >= body[axis][0] && glass[axis][1] <= body[axis][1]);
                expect(hidden, `${kind} glass is enclosed by its body`).toBe(false);
            }
            parts.wheels.forEach(wheel => {
                expect(wheel.oz).toBe(v.wheelRadius);
                expect(Math.abs(wheel.oy) + wheel.w / 2).toBeLessThanOrEqual(v.width / 2 + 1e-9);
            });
        }
    });
});

describe('personParts', () => {
    it('stands a 1.75 m figure with its head centre at 1.62 m and 0.80 m legs hanging from the hips to the ground', () => {
        const figure = personParts(1.75, 0);
        expect(figure.head.oz).toBeCloseTo(1.62, 9);
        figure.legs.forEach(leg => {
            expect(leg.oz).toBeCloseTo(0.80, 9);
            expect(leg.sz).toBeCloseTo(0.80, 9);
            // The limb mesh spans local z −1..0: its far end is the foot.
            expectClose(apply(partMatrix(leg), [0, 0, -1]), [0, leg.oy, 0]);
        });
        // The torso column (local z 0..1) runs from the hips to just under the head.
        expect(apply(partMatrix(figure.body), [0, 0, 0])[2]).toBeCloseTo(0.80, 9);
        const neck = apply(partMatrix(figure.body), [0, 0, 1])[2];
        const chin = figure.head.oz - figure.head.sz;
        expect(chin - neck).toBeGreaterThanOrEqual(0);
        expect(chin - neck).toBeLessThan(0.05);
        figure.arms.forEach(arm => expect(apply(partMatrix(arm), [0, 0, -1])[2]).toBeGreaterThan(0.5)); // hands at hip height
    });

    it('scales every part with the figure height', () => {
        const child = personParts(1.15, 0);
        expect(child.head.oz).toBeCloseTo(1.62 * 1.15 / 1.75, 9);
        child.legs.forEach(leg => expect(apply(partMatrix(leg), [0, 0, -1])[2]).toBeCloseTo(0, 9));
    });

    it('gives a child a bigger head and shorter legs for its height, standing on the ground under its own head top', () => {
        const h = 1.2, child = personParts(h, 0, true), scaled = personParts(h, 0);
        expect(child.head.sx / h).toBeGreaterThan(scaled.head.sx / h * 1.3);
        expect(child.legs[0].sz / h).toBeLessThan(scaled.legs[0].sz / h);
        child.legs.forEach(leg => expect(apply(partMatrix(leg), [0, 0, -1])[2]).toBeCloseTo(0, 9));
        expect(child.head.oz + child.head.sz).toBeCloseTo(h, 2);
        const neck = apply(partMatrix(child.body), [0, 0, 1])[2];
        expect(child.head.oz - child.head.sz - neck).toBeGreaterThanOrEqual(0);
        expect(child.head.oz - child.head.sz - neck).toBeLessThan(0.05);
        expect(personParts(h, 0.3, true).legs[1].a).toBe(-0.3);
    });

    it('swings the legs in opposition and counter-swings the arms', () => {
        const swing = 0.3;
        const figure = personParts(1.75, swing);
        expect(figure.legs[0].a).toBe(swing);
        expect(figure.legs[1].a).toBe(-swing);
        expect(figure.arms[0].a).toBeCloseTo(-0.8 * swing, 12);
        expect(figure.arms[1].a).toBeCloseTo(0.8 * swing, 12);
        // In space: one foot goes back as the other goes forward, and each hand opposes its own-side foot.
        const foot = side => apply(partMatrix(figure.legs[side]), [0, 0, -1])[0];
        const hand = side => apply(partMatrix(figure.arms[side]), [0, 0, -1])[0];
        expect(Math.sign(foot(0))).toBe(-Math.sign(foot(1)));
        expect(Math.sign(hand(0))).toBe(-Math.sign(foot(0)));
        expect(Math.sign(hand(1))).toBe(-Math.sign(foot(1)));
    });
});

describe('riderParts', () => {
    it("puts the rider's thighs forward and hands out toward the handlebars", () => {
        const rider = riderParts();
        rider.legs.forEach(leg => expect(apply(partMatrix(leg), [0, 0, -1])[0]).toBeGreaterThan(leg.ox + 0.3));
        rider.arms.forEach(arm => {
            const hand = apply(partMatrix(arm), [0, 0, -1]);
            expect(hand[0]).toBeGreaterThan(arm.ox + 0.3);
            expect(hand[0]).toBeLessThan(VEHICLE_KINDS.moto.len / 2);
        });
        expect(rider.body.oz).toBeGreaterThan(VEHICLE_KINDS.moto.clearance); // seated on the bike, not below it
    });

    it('leans the torso forward, so the head and shoulders sit on top of it', () => {
        const rider = riderParts();
        const hips = apply(partMatrix(rider.body), [0, 0, 0]);
        const neck = apply(partMatrix(rider.body), [0, 0, 1]); // the column spans local z 0..1
        expect(neck[0] - hips[0], 'torso lean (+ is forward, x is the direction of travel)').toBeGreaterThan(0);
        expect(Math.abs(rider.head.ox - neck[0]), 'head centre ahead of the neck').toBeLessThan(0.1);
    });
});
