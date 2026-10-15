// Physical sizes, handling and visual identity for the traffic simulator vehicle types.
(function exposeTrafficVehicles(root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TrafficVehicles = api;
})(typeof window === 'undefined' ? null : window, function createTrafficVehicles() {
    'use strict';
    const types = Object.freeze({
        car: Object.freeze({ type: 'car', label: 'Automobil', length: 4.4, width: 1.8, turnRadius: 4.8, cruiseFactor: 1,
            livery: 'civilian', roofBar: null }),
        bus: Object.freeze({ type: 'bus', label: 'Gradski autobus', length: 12, width: 2.5, turnRadius: 10, cruiseFactor: .8,
            livery: 'city-blue', bodyColor: '#1687bd', accentColor: '#f2f5ef', roofBar: null }),
        police: Object.freeze({ type: 'police', label: 'Policijsko vozilo', length: 4.7, width: 1.9, turnRadius: 5, cruiseFactor: 1,
            livery: 'police-white-blue', bodyColor: '#f7f8f3', accentColor: '#176fc1', roofBar: '#258cff' }),
        ambulance: Object.freeze({ type: 'ambulance', label: 'Hitna pomoć', length: 6.1, width: 2.2, turnRadius: 6, cruiseFactor: 1,
            livery: 'medical-white-red', bodyColor: '#fffdf5', accentColor: '#d6423c', roofBar: '#e3433e' })
    });
    const choices = [['car', .88], ['bus', .96], ['police', .985], ['ambulance', 1]];

    function get(type = 'car') {
        if (type == null) type = 'car';
        if (Object.hasOwn(types, type)) return types[type];
        throw new RangeError(`Unknown traffic vehicle type: ${type}`);
    }

    function pick(random = Math.random) {
        if (typeof random !== 'function') throw new TypeError('Vehicle selection requires a random function');
        const value = random();
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Random value must be between 0 and 1');
        return get(choices.find(([, edge]) => value < edge)?.[0] || 'ambulance');
    }

    return { get, pick, types };
});
