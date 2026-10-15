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
    it('describes a stopped manoeuvre as waiting and a running search as planning', () => {
        const vehicle = car();
        vehicle.maneuver = { kind: 'yield' };
        expect(Drivers.view(vehicle).maneuver).toBe('waiting');
        vehicle.speed = .5;
        expect(Drivers.view(vehicle).maneuver).toBe('yield');
        vehicle.planning = true;
        expect(Drivers.view(vehicle).maneuver).toBe('planning');
        vehicle.planning = false; vehicle.maneuver = null;
        vehicle.change = { recovery: true }; vehicle.speed = 0;
        expect(Drivers.view(vehicle).maneuver).toBe('waiting');
        vehicle.speed = .5;
        expect(Drivers.view(vehicle).maneuver).toBe('bypass');
    });

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

function fits(car, speed, clearance, dt, ratio = 1) {
    const headway = car.driver.headway / ratio;
    const cap = 10 / ratio;
    return speed * dt + Math.min(cap, speed * headway)
        <= clearance + Math.min(cap, Math.max(0, car.speed) * headway) + 1e-10;
}

describe('following speed limit', () => {
    it('allows a stopped follower to move into a small positive clearance', () => {
        const car = { speed: 0, driver: { headway: 1.07 } };
        const clearance = .214, dt = .1;
        const speed = Drivers.followingSpeedLimit(car, clearance, dt);

        expect(speed).toBeCloseTo(.214 / 1.17, 10);
        expect(speed).toBeGreaterThan(0);
        expect(fits(car, speed, clearance, dt)).toBe(true);
    });

    it('accounts for the follower current speed contribution', () => {
        const car = { speed: 4, driver: { headway: 1.07 } };
        const clearance = .5, dt = .1;
        const speed = Drivers.followingSpeedLimit(car, clearance, dt);

        expect(speed).toBeCloseTo((clearance + 4 * 1.07) / (dt + 1.07), 10);
        expect(speed).toBeGreaterThan(car.speed);
        expect(fits(car, speed, clearance, dt)).toBe(true);
    });

    it('uses the capped headway branch when the solved speed exceeds its threshold', () => {
        const car = { speed: 20, driver: { headway: 1.07 } };
        const clearance = 3, dt = .1;
        const speed = Drivers.followingSpeedLimit(car, clearance, dt);

        expect(speed).toBeCloseTo(30, 10);
        expect(speed).toBeGreaterThan(10 / car.driver.headway);
        expect(fits(car, speed, clearance, dt)).toBe(true);
    });

    it('scales headway clearance by the route station ratio', () => {
        const car = { speed: 0, driver: { headway: 1.2 } };
        const clearance = .6, dt = .1, ratio = 2;
        const speed = Drivers.followingSpeedLimit(car, clearance, dt, ratio);

        expect(speed).toBeCloseTo(clearance / (dt + car.driver.headway / ratio), 10);
        expect(fits(car, speed, clearance, dt, ratio)).toBe(true);
    });

    it('preserves unlimited defaults when there is no driver or finite clearance', () => {
        expect(Drivers.followingSpeedLimit({ speed: 0 }, .2, .1)).toBe(Infinity);
        expect(Drivers.followingSpeedLimit({ speed: 0, driver: { headway: 1 } }, Infinity, .1)).toBe(Infinity);
    });
});
