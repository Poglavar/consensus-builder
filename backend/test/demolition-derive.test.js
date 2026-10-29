// Demolitions derived from design geometry (frontend/js/demolition-derive.js): razed, cut, passed
// under or untouched, against the union of every taker's land, whichever order the takers come in.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { derive } = require('../../frontend/js/demolition-derive.js');

// A square in degrees near 16°E 46°N: 0.0001° is about 8 m east and 11 m north.
const box = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
const at = (x, y, size = 0.0001) => box(16 + x, 46 + y, 16 + x + size, 46 + y + size);

describe('demolition derive', () => {
    const road = { proposalId: 'road', region: box(16, 46, 16.0003, 46.0001) };

    it('razes a building inside the land, cuts one reaching into it and leaves one it grazes', () => {
        const { records, tunnelled } = derive({ takers: [road], buildings: [
            { key: 'gdi-3d:inside', geometry: at(0.0001, 0.00002, 0.00005) },
            { key: 'gdi-3d:straddling', geometry: box(16.0001, 46.00005, 16.0002, 46.00025) },
            { key: 'gdi-3d:grazed', geometry: box(16.0001, 46.0000999, 16.0002, 46.0003) },
            { key: 'gdi-3d:away', geometry: at(0.001, 0.001) }
        ] }, turf);
        expect([...records.keys()].sort()).toEqual(['gdi-3d:inside', 'gdi-3d:straddling']);
        expect(records.get('gdi-3d:inside')).toMatchObject({ proposalIds: ['road'] });
        expect(records.get('gdi-3d:inside').remainder).toBeUndefined();
        const cut = records.get('gdi-3d:straddling');
        expect(cut.remainder && cut.demolishedPart).toBeTruthy();
        expect(turf.area(turf.feature(cut.remainder))).toBeGreaterThan(turf.area(turf.feature(cut.demolishedPart)));
        expect(tunnelled.size).toBe(0);
    });

    it('cuts against the union of the takers, so their order changes nothing', () => {
        const building = { key: 'osm:1', geometry: box(16, 46, 16.0002, 46.0002) };
        const west = { proposalId: 'west', region: box(15.9999, 45.9999, 16.00009, 46.0003) };
        const east = { proposalId: 'east', region: box(16.00011, 45.9999, 16.0003, 46.0003) };
        const one = derive({ takers: [west, east], buildings: [building] }, turf).records.get('osm:1');
        const other = derive({ takers: [east, west], buildings: [building] }, turf).records.get('osm:1');
        // Each alone leaves more than half; together they leave a sliver, so the building goes whole.
        expect(derive({ takers: [west], buildings: [building] }, turf).records.get('osm:1').remainder).toBeTruthy();
        expect(one.remainder).toBeUndefined();
        expect(other.remainder).toBeUndefined();
        expect(one.proposalIds.slice().sort()).toEqual(['east', 'west']);
    });

    it('passes under a building over a road tunnel and takes it where the road is at the surface', () => {
        const tunnelled = { proposalId: 'road', region: road.region, tunnels: [box(16.00005, 45.9999, 16.00025, 46.0002)] };
        const result = derive({ takers: [tunnelled], buildings: [
            { key: 'gdi-3d:above', geometry: at(0.0001, 0.00002, 0.00005) },
            { key: 'gdi-3d:surface', geometry: at(0, 0.00002, 0.00003) }
        ] }, turf);
        expect([...result.tunnelled.keys()]).toEqual(['gdi-3d:above']);
        expect([...result.records.keys()]).toEqual(['gdi-3d:surface']);
    });

    it('keeps buildings of two sources apart even when their ids are equal', () => {
        const { records } = derive({ takers: [road], buildings: [
            { key: 'gdi-3d:7', geometry: at(0.0001, 0.00002, 0.00005) },
            { key: 'osm:7', geometry: at(0.002, 0.002) }
        ] }, turf);
        expect([...records.keys()]).toEqual(['gdi-3d:7']);
    });

    it('reports a building it cannot measure instead of dropping the whole pass', () => {
        const broken = { intersect: () => { throw new Error('ring'); }, union: turf.union, difference: turf.difference, area: turf.area };
        const result = derive({ takers: [road], buildings: [{ key: 'osm:bad', geometry: at(0.0001, 0.00002, 0.00005) }] }, broken);
        expect(result.records.size).toBe(0);
        expect(result.failures.map(failure => failure.key)).toEqual(['osm:bad']);
    });
});
