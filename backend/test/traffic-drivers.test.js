// Checks seeded driver spacing, delay, mood recovery and restrained horn timing.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Drivers = require('../../frontend/traffic/drivers.js');

function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function car(vehicleType = 'car', speed = 0, random = () => 0) {
    return { vehicleType, speed, driver: Drivers.create(random) };
}

describe('traffic driver profiles and behavior', () => {
    it('creates stable seeded profiles with individual patience and spacing', () => {
        const first = Drivers.create(seeded(523), 17);
        const repeat = Drivers.create(seeded(523), 17);
        const other = Drivers.create(seeded(524), 17);

        expect(first).toEqual(repeat);
        expect(first).not.toEqual(other);
        expect(first).toMatchObject({ stuckFor: 0, totalDelay: 0, frustration: 0, honkCount: 0, nextTryAt: 17 });
        expect(first.gap).toBeGreaterThanOrEqual(.8);
        expect(first.gap).toBeLessThanOrEqual(10);
        expect(first.headway).toBeGreaterThanOrEqual(.6);
        expect(first.headway).toBeLessThanOrEqual(1.8);
        expect(first.patience).toBeGreaterThanOrEqual(12);
        expect(first.patience).toBeLessThanOrEqual(42);
        expect(first.reaction).toBeGreaterThanOrEqual(.8);
        expect(first.reaction).toBeLessThanOrEqual(2.3);
        expect(first.gap).not.toBe(other.gap);
        expect(first.patience).not.toBe(other.patience);
    });

    it('leaves more room behind longer vehicles and at higher following speeds', () => {
        const follower = car('car');
        const compactLeader = car('car');
        const busLeader = car('bus');
        expect(Drivers.gap(follower, busLeader)).toBeGreaterThan(Drivers.gap(follower, compactLeader));

        follower.speed = 8;
        expect(Drivers.gap(follower, compactLeader)).toBeGreaterThan(Drivers.gap({ ...follower, speed: 0 }, compactLeader));
    });

    it('accumulates stopped delay and frustration, then recovers mood during smooth travel', () => {
        const vehicle = car('car');
        for (let second = 1; second <= 50; second++) Drivers.update(vehicle, 1, 0, false, () => 1, second);

        const jammed = Drivers.view(vehicle);
        expect(jammed.stuckFor).toBe(50);
        expect(vehicle.driver.totalDelay).toBe(50);
        expect(jammed.impatient).toBe(true);
        expect(jammed.mood).toBe('angry');

        for (let second = 51; second <= 145; second++) Drivers.update(vehicle, 1, 2, false, () => 1, second);
        const recovered = Drivers.view(vehicle);
        expect(recovered.stuckFor).toBe(0);
        expect(recovered.mood).toBe('happy');
        expect(vehicle.driver.totalDelay).toBe(50);
    });

    it('does not honk before impatience or while stopped for a red light, and respects cooldown', () => {
        const vehicle = car('car');
        vehicle.driver.nextHonkAt = 0;
        const always = () => 0;

        for (let second = 1; second <= 11; second++) Drivers.update(vehicle, 1, 0, false, always, 100);
        expect(Drivers.view(vehicle).impatient).toBe(false);
        expect(Drivers.view(vehicle).honkCount).toBe(0);

        for (let second = 12; second <= 14; second++) Drivers.update(vehicle, 1, 0, true, always, 100);
        expect(Drivers.view(vehicle).impatient).toBe(true);
        expect(Drivers.view(vehicle).honkCount).toBe(0);

        Drivers.update(vehicle, 1, 0, false, always, 100);
        expect(Drivers.view(vehicle).honkCount).toBe(1);
        Drivers.update(vehicle, 1, 0, false, always, 101);
        expect(Drivers.view(vehicle).honkCount).toBe(1);
    });
});
