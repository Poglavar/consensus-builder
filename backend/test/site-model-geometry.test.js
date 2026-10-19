// Site review geometry: stored site models become storey prisms and placed-plan slabs in local metres.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { localFrame, placedSlabs, storeyPrisms, statusColour } = require('../../frontend/js/site-model-geometry.js');

const footprint = { type: 'Polygon', coordinates: [[[15.98, 45.8], [15.9813, 45.8], [15.9813, 45.8002], [15.98, 45.8002], [15.98, 45.8]]] };
const model = {
    envelope: { footprint, storeys: [
        { level: 0, label: 'Pr', elevationM: 0, heightM: 5.2, outline: 'footprint', heightBasis: '3 printed elevations' },
        { level: 1, label: '1. kat', elevationM: 5.2, heightM: 3.3, outline: 'footprint', heightBasis: '3 printed elevations' },
        { level: 2, label: 'Uk', elevationM: 8.5, heightM: 3.3, outline: 'recessed', heightBasis: 'estimated' }] },
    placements: [
        { unitId: 'A-1-2', floor: 1, status: 'placed', best: { outline: [[15.98, 45.8], [15.9801, 45.8], [15.9801, 45.80009], [15.98, 45.80009], [15.98, 45.8]] } },
        { unitId: 'X', floor: null, status: 'ambiguous', best: { outline: [[15.98, 45.8], [15.9801, 45.8], [15.9801, 45.80009], [15.98, 45.8]] } },
        { unitId: 'Y', floor: 1, status: 'unplaced', best: null },
    ],
};

describe('site model geometry', () => {
    it('projects the footprint into local metres around its first vertex', () => {
        const frame = localFrame(model);
        const [x, y] = frame.toLocal([15.9813, 45.8002]);
        expect(x).toBeCloseTo(0.0013 * 111320 * Math.cos(45.8 * Math.PI / 180), 3);
        expect(y).toBeCloseTo(0.0002 * 110574, 3);
        expect(localFrame({ envelope: { footprint: null } })).toBeNull();
    });

    it('stacks one prism per storey and marks recessed and estimated storeys', () => {
        const prisms = storeyPrisms(model);
        expect(prisms.map(p => [p.level, p.z0, p.z1])).toEqual([[0, 0, 5.2], [1, 5.2, 8.5], [2, 8.5, 11.8]]);
        expect(prisms[2]).toMatchObject({ recessed: true, estimated: true });
        expect(prisms[0].ring).toHaveLength(4);
    });

    it('lifts fitted plans to their storey and leaves unknown floors at ground level', () => {
        const slabs = placedSlabs(model);
        expect(slabs.map(s => [s.unitId, s.z, s.floorKnown, s.colour])).toEqual([['A-1-2', 5.2, true, statusColour('placed')], ['X', 0, false, statusColour('ambiguous')]]);
    });
});
