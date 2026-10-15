// Verifies physical envelopes, handling values and deterministic type proportions.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Vehicles = require('../../frontend/traffic/vehicles.js');

describe('traffic vehicle definitions', () => {
    it('provides the requested physical dimensions, turn radii and handling factors', () => {
        expect(Vehicles.get()).toMatchObject({ type: 'car', length: 4.4, width: 1.8, turnRadius: 4.8, cruiseFactor: 1 });
        expect(Vehicles.get('bus')).toMatchObject({ type: 'bus', length: 12, width: 2.5, turnRadius: 10, cruiseFactor: .8, livery: 'city-blue' });
        expect(Vehicles.get('police')).toMatchObject({ type: 'police', length: 4.7, width: 1.9, turnRadius: 5, roofBar: '#258cff' });
        expect(Vehicles.get('ambulance')).toMatchObject({ type: 'ambulance', length: 6.1, width: 2.2, turnRadius: 6, roofBar: '#e3433e', livery: 'medical-white-red' });
        expect(Object.isFrozen(Vehicles.get('bus'))).toBe(true);
    });

    it('selects exact car, bus, police and ambulance shares from seeded quantiles', () => {
        expect([0, .879999, .88, .959999, .96, .984999, .985, .999999, 1]
            .map(value => Vehicles.pick(() => value).type))
            .toEqual(['car', 'car', 'bus', 'bus', 'police', 'police', 'ambulance', 'ambulance', 'ambulance']);
    });

    it('rejects unknown vehicle names and malformed random sources', () => {
        expect(() => Vehicles.get('tram')).toThrow(RangeError);
        expect(() => Vehicles.pick(1)).toThrow(TypeError);
        expect(() => Vehicles.pick(() => 1.1)).toThrow(RangeError);
    });
});
