// Street parcels from OSM road lines (frontend/js/osm-road-coverage.js): a parcel is a road when the
// lines' corridors together cover more than half of it, so a wide street carrying two carriageways
// counts, while a plot beside a street and a footway drawn over its carriageway do not.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const Coverage = require('../../frontend/js/osm-road-coverage.js');

// Metres east/north of a point in Split, as [lng, lat].
const LAT0 = 43.5081, LNG0 = 16.4402;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const at = (x, y) => [LNG0 + x * M_LNG, LAT0 + y * M_LAT];
const rect = (west, south, east, north) => turf.polygon([[at(west, south), at(east, south), at(east, north), at(west, north), at(west, south)]]);
const line = (y, from = -50, to = 50) => turf.lineString([at(from, y), at(to, y)]);

describe('street parcels from OSM road lines', () => {
    // A 20 m wide street parcel, 60 m long, carrying a carriageway each way 8 m apart.
    const street = rect(-30, -10, 30, 10);
    const carriageways = Coverage.roadCorridors([line(-4), line(4)], turf);

    it('marks a wide street that no single way covers half of', () => {
        expect(Coverage.coversAsRoad(street, carriageways.slice(0, 1), turf)).toBe(false);
        expect(Coverage.coversAsRoad(street, carriageways.slice(1), turf)).toBe(false);
        expect(Coverage.coversAsRoad(street, carriageways, turf)).toBe(true);
    });

    it('marks a narrow street under one way', () => {
        expect(Coverage.coversAsRoad(rect(-30, -3, 30, 3), Coverage.roadCorridors([line(0)], turf), turf)).toBe(true);
    });

    it('counts a footway drawn over its carriageway once', () => {
        expect(Coverage.coversAsRoad(street, Coverage.roadCorridors([line(0), line(0)], turf), turf)).toBe(false);
    });

    it('leaves a plot beside the street alone', () => {
        const plot = rect(-10, 11, 10, 31);
        expect(Coverage.coversAsRoad(plot, carriageways, turf)).toBe(false);
        expect(Coverage.coversAsRoad(plot, Coverage.roadCorridors([line(10)], turf), turf)).toBe(false);
    });

    it('leaves out a road feature without geometry', () => {
        expect(Coverage.roadCorridors([null, { type: 'Feature', geometry: null }, line(0)], turf)).toHaveLength(1);
    });

    it('counts a piece turf cannot clip as uncovered, and says so', () => {
        const failing = { ...turf, intersect: () => { throw new Error('clip failed'); } };
        const heard = [];
        expect(Coverage.coversAsRoad(street, carriageways, failing, operation => heard.push(operation))).toBe(false);
        expect(heard).toEqual(['intersect', 'intersect']);
    });
});
