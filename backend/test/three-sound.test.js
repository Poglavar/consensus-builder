// City sound of the 3D model view (frontend/js/three-sound.js): traffic level and direction from
// the vehicles around the camera, the events that interrupt it, and the noise it is made of.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sound = require('../../frontend/js/three-sound.js');

// A camera 2 m up at the origin, its right hand toward +x.
const listener = { x: 0, y: 0, z: 2, rightX: 1, rightY: 0 };
const car = (x, y, v = 14) => ({ kind: 'car', x, y, z: 0, v });

describe('city sound', () => {
    it('plays traffic louder the nearer and faster it is, half level at the reference distance', () => {
        const ref = Math.sqrt(sound.REFERENCE_M ** 2 - 4);
        expect(sound.trafficLevels([car(0, ref)], listener).rumble).toBeCloseTo(0.5, 6);
        const near = sound.trafficLevels([car(0, 8)], listener), far = sound.trafficLevels([car(0, 80)], listener);
        expect(near.rumble).toBeGreaterThan(far.rumble);
        const idling = sound.trafficLevels([car(0, 8, 0)], listener);
        expect(idling.hiss).toBe(0);
        expect(idling.rumble).toBeGreaterThan(0);
        expect(idling.rumble).toBeLessThan(near.rumble);
        expect(sound.trafficLevels([{ ...car(0, 30), kind: 'bus' }], listener).rumble).toBeGreaterThan(sound.trafficLevels([car(0, 30)], listener).rumble);
        expect(sound.trafficLevels([], listener)).toEqual({ rumble: 0, hiss: 0, pan: 0 });
    });

    it('pans traffic toward the side it is on', () => {
        expect(sound.trafficLevels([car(20, 0)], listener).pan).toBeGreaterThan(0.9);
        expect(sound.trafficLevels([car(-20, 0)], listener).pan).toBeLessThan(-0.9);
        expect(sound.trafficLevels([car(0, 20)], listener).pan).toBeCloseTo(0, 9);
        expect(sound.trafficLevels([car(0, 0)], { ...listener, z: 200 }).pan).toBe(0);
    });

    it('lets dogs in earshot bark, queues hoot and birds sing by day near the ground only', () => {
        const always = () => 0;
        const dogs = [{ x: 500, y: 0, z: 0, bark: 300 }, { x: 10, y: 0, z: 0, bark: 600 }];
        const events = sound.rollEvents({ dt: 0.1, dogs, vehicles: [car(0, 30, 0)], listener, night: 0, rng: always });
        expect(events.map(e => e.type)).toEqual(['bark', 'horn', 'birds']);
        expect(events[0].voice).toBe(600);
        expect(events[0].pan).toBeGreaterThan(0.9);
        const moving = sound.rollEvents({ dt: 0.1, dogs: [], vehicles: [car(0, 30, 10)], listener, night: 0, rng: always });
        expect(moving.map(e => e.type)).toEqual(['birds']);
        expect(sound.rollEvents({ dt: 0.1, dogs: [], vehicles: [], listener, night: 1, rng: always })).toEqual([]);
        expect(sound.rollEvents({ dt: 0.1, dogs: [], vehicles: [], listener: { ...listener, z: sound.BIRDS_BELOW_M + 1 }, night: 0, rng: always })).toEqual([]);
        expect(sound.rollEvents({ dt: 0.1, dogs, vehicles: [car(0, 30, 0)], listener, night: 0, rng: () => 0.999 })).toEqual([]);
    });

    it('hums quieter at night and from high above', () => {
        expect(sound.humLevel(1, 10)).toBeLessThan(sound.humLevel(0, 10));
        expect(sound.humLevel(0, 3000)).toBeCloseTo(sound.humLevel(0, 0) / 2, 9);
    });

    it('makes pink and brown noise filling −1…1, brown darker than pink', () => {
        let seed = 1;
        const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        const pink = sound.fillNoise(new Float32Array(48000), 'pink', rng);
        const brown = sound.fillNoise(new Float32Array(48000), 'brown', rng);
        for (const noise of [pink, brown]) expect(Math.max(...noise.map(Math.abs))).toBeCloseTo(1, 5);
        const roughness = n => n.reduce((sum, x, i) => i ? sum + Math.abs(x - n[i - 1]) : 0, 0) / n.length;
        expect(roughness(brown)).toBeLessThan(roughness(pink) / 3);
    });
});
