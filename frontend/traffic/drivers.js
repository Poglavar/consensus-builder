// Seeded driver differences and accumulated delay; independent of animation and wall-clock time.
(function (root, factory) {
    const vehicles = typeof module !== 'undefined' && module.exports ? require('./vehicles.js') : root.TrafficVehicles;
    const api = factory(vehicles);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficDrivers = api;
})(typeof window !== 'undefined' ? window : null, function (Vehicles) {
    'use strict';
    const clamp = value => Math.max(0, Math.min(1, value));
    function create(random, time = 0) {
        return {
            gap: .8 + 9.2 * random() ** 2,
            headway: .6 + random() * 1.2,
            patience: 12 + random() * 30,
            reaction: .8 + random() * 1.5,
            priority: random(),
            stuckFor: 0, totalDelay: 0, frustration: 0, honkCount: 0,
            nextTryAt: time, nextHonkAt: time + 30 + random() * 40
        };
    }
    function gap(follower, leader) {
        const body = (Vehicles.get(follower.vehicleType).length + Vehicles.get(leader.vehicleType).length) / 2;
        return body + (follower.driver ? follower.driver.gap
            + Math.min(10, Math.max(0, follower.speed) * follower.driver.headway) : .4);
    }
    function update(car, dt, distance, red, random, time) {
        const d = car.driver;
        if (!d) return;
        const slow = distance / dt < .4;
        d.stuckFor = slow ? d.stuckFor + dt : 0;
        if (slow) d.totalDelay += dt;
        d.frustration = clamp(d.frustration + dt * (slow && d.stuckFor > 2
            ? (red ? .0025 : .012) * 20 / d.patience : slow ? 0 : -.009));
        if (!red && d.stuckFor > d.patience && time >= d.nextHonkAt) {
            if (random() < .4) d.honkCount++;
            d.nextHonkAt = time + 20 + random() * 40;
        }
    }
    function view(car) {
        const d = car.driver;
        const frustration = d?.frustration || 0;
        return {
            mood: frustration >= .75 ? 'angry' : frustration >= .4 ? 'unhappy' : frustration >= .12 ? 'neutral' : 'happy',
            stuckFor: d?.stuckFor || 0,
            impatient: !!d && d.stuckFor >= d.patience,
            maneuver: car.maneuver?.kind || (car.planning ? 'planning' : car.change?.recovery ? 'bypass' : null),
            honkCount: d?.honkCount || 0
        };
    }
    return { create, gap, update, view };
});
