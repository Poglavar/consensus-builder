// Public and private land of a plan, and the present state of its land as a plan of its own
// (frontend/js/proposals/present-state.js): OpenStreetMap parks and squares, road parcels and
// existing buildings, measured with real turf and plan-yield's areas.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
const require = createRequire(import.meta.url);
const State = require('../../frontend/js/proposals/present-state.js');
const planYield = require('../../frontend/js/proposals/plan-yield.js');

const ops = { areaOf: feature => planYield.geometryAreaM2(feature), intersect: (a, b) => turf.intersect(a, b), difference: (a, b) => turf.difference(a, b) };
// A square of `size` degrees at (x, y), as a parcel or piece feature.
const box = (x, y, size, properties = {}) => ({ type: 'Feature', properties,
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] } });
const node = (lon, lat) => ({ lon, lat });

describe('OpenStreetMap parks and squares', () => {
    it('asks for parks, squares and pedestrian areas in the box', () => {
        const query = State.publicSpaceQuery([15.9, 45.8, 15.91, 45.81]);
        expect(query).toContain('way["leisure"="park"](45.8,15.9,45.81,15.91)');
        expect(query).toContain('way["place"="square"]');
        expect(query).toContain('way["highway"="pedestrian"]["area"="yes"]');
        expect(query).toContain('out geom;');
    });

    it('reads closed ways and multipolygon relations with their holes, and skips what does not close', () => {
        const ring = [node(0, 0), node(1, 0), node(1, 1), node(0, 1), node(0, 0)];
        const hole = [node(0.2, 0.2), node(0.4, 0.2), node(0.4, 0.4), node(0.2, 0.2)];
        const { features, skipped } = State.publicSpacesFromOverpass([
            { type: 'way', id: 1, tags: { leisure: 'park' }, geometry: ring },
            { type: 'relation', id: 2, tags: { place: 'square', type: 'multipolygon' }, members: [
                { type: 'way', ref: 10, role: 'outer', geometry: ring.slice(0, 3) },
                { type: 'way', ref: 11, role: 'outer', geometry: ring.slice(2) },
                { type: 'way', ref: 12, role: 'inner', geometry: hole }] },
            { type: 'relation', id: 3, tags: { leisure: 'park', type: 'multipolygon' }, members: [
                { type: 'way', ref: 13, role: 'outer', geometry: ring.slice(0, 3) }] },
            { type: 'way', id: 4, tags: { highway: 'residential' }, geometry: ring }
        ]);
        expect(features.map(f => [f.id, f.properties.kind, f.geometry.type])).toEqual([['w1', 'park', 'Polygon'], ['r2', 'square', 'Polygon']]);
        expect(features[1].geometry.coordinates).toHaveLength(2);
        expect(skipped).toBe(1);
    });
});

describe('public and private land', () => {
    const parcelA = box(15.9, 45.8, 0.001, { parcelId: 'A' });
    const parcelB = box(15.901, 45.8, 0.001, { parcelId: 'B' });
    const road = box(15.902, 45.8, 0.001, { parcelId: 'R' });
    const area = feature => ops.areaOf(feature);

    it('splits untouched land as it is today: road parcels and park cover are public', () => {
        const park = box(15.9, 45.8, 0.0005);
        const split = State.splitLand({ cadastral: [parcelA, parcelB, road], isRoad: id => id === 'R', spaces: [park], ops });
        expect(split.publicLandM2).toBeCloseTo(area(road) + area(park), 0);
        expect(split.privateLandM2).toBeCloseTo(area(parcelA) - area(park) + area(parcelB), 0);
    });

    it('counts a design’s corridor and park pieces as public and its plots as private', () => {
        const park = box(15.901, 45.8, 0.0005, { parcelId: 'B#p-1', cadastreParcelIds: ['B'], producedByProposalId: 'park', structureType: 'park' });
        const plot = box(15.9015, 45.8, 0.0005, { parcelId: 'B#p-2', cadastreParcelIds: ['B'], producedByProposalId: 'layout' });
        const corridor = box(15.9, 45.8, 0.001, { parcelId: 'A#c-1', cadastreParcelIds: ['A'], producedByProposalId: 'road' });
        // The untouched road parcel's own identity entry is not a design piece.
        const identity = { ...road, properties: { parcelId: 'R', cadastreParcelIds: ['R'] } };
        const split = State.splitLand({ pieces: [park, plot, identity], corridors: [corridor], cadastral: [parcelA, parcelB, road],
            isRoad: id => id === 'R', spaces: [box(15.9, 45.8, 0.01)], ops });
        expect(split.publicLandM2).toBeCloseTo(area(corridor) + area(park) + area(road), 0);
        expect(split.privateLandM2).toBeCloseTo(area(plot), 0);
    });

    it('never counts more park cover than the parcel has', () => {
        const spaces = [box(15.9, 45.8, 0.01), box(15.9, 45.8, 0.01)];
        expect(State.coveredM2(parcelA, spaces, ops)).toBeCloseTo(area(parcelA), 3);
    });
});

describe('existing buildings as freeform buildings', () => {
    it('clips each building to the parcels it stands on and measures it as plan-yield measures a design', () => {
        const parcels = new Map([['A', box(15.9, 45.8, 0.001, { parcelId: 'A' })], ['B', box(15.901, 45.8, 0.001, { parcelId: 'B' })]]);
        // One building straddling A and B and beyond, 4 floors; one with no height at all.
        const wide = { id: 'w7', geometry: box(15.9005, 45.8, 0.002, {}).geometry, height_m: null, floors: 4 };
        const unknown = { id: 'w8', geometry: box(15.9001, 45.8001, 0.0002, {}).geometry, height_m: null, floors: null };
        const surveyed = State.builtRecords({ regions: new Map([['A', [{ id: 's1', geometry: box(15.9001, 45.8001, 0.0002).geometry, height_m: 18.39, floors: null }]]]), parcelsById: parcels, ops });
        expect(surveyed[0].buildingProposal.buildings[0].properties).toMatchObject({ height: 18.39 });
        expect(surveyed[0].buildingProposal.buildings[0].properties).not.toHaveProperty('floors');
        const records = State.builtRecords({ regions: new Map([['A', [wide, unknown]], ['B', [wide]]]), parcelsById: parcels, ops, floorHeightM: 3 });
        expect(records.map(r => r.proposalId)).toEqual(['built:w7', 'built:w8']);
        expect(records[0].buildingProposal.buildings[0].geometry.type).toBe('MultiPolygon');
        const result = planYield.planYield(records, { floorHeightM: 3 });
        const inside = [...parcels.values()].reduce((sum, parcel) => sum + ops.areaOf(turf.intersect(box(15.9005, 45.8, 0.002), parcel)), 0);
        expect(result.total.buildings).toBe(2);
        expect(result.total.unmeasuredBuildings).toBe(1);
        expect(result.total.grossFloorAreaM2).toBeCloseTo(inside * 4, 0);
    });
});

describe('existing buildings a plan leaves standing', () => {
    const record = (id, feature) => ({ proposalId: `built:${id}`, applied: true,
        buildingProposal: { buildings: [{ ...feature, properties: { type: 'proposedBuilding', height: 9, floorHeightM: 3 } }] } });
    // A 0.0002° square building: about 15 × 22 m.
    const whole = record('a', box(15.9, 45.8, 0.0002));
    const halved = record('b', box(15.901, 45.8, 0.0002));
    const grazed = record('c', box(15.902, 45.8, 0.0002));

    it('removes what a design clears, keeps the rest of a cut building, and ignores a graze', () => {
        const regions = [
            box(15.8999, 45.7999, 0.0004),                      // covers building a
            box(15.9011, 45.7999, 0.0004),                      // covers half of building b
            box(15.90219999, 45.7999, 0.0004)                   // touches building c by a hair
        ];
        const left = State.remainingBuildings({ built: [whole, halved, grazed], regions, ops });
        expect(left.map(r => r.proposalId)).toEqual(['built:b', 'built:c']);
        const halfArea = ops.areaOf(left[0].buildingProposal.buildings[0]);
        expect(halfArea / ops.areaOf(halved.buildingProposal.buildings[0])).toBeCloseTo(0.5, 1);
        expect(left[1]).toBe(grazed);
    });

    it('adds remaining and new floor area before deriving apartments once', () => {
        const designs = planYield.planYield([whole], {});
        const remaining = planYield.planYield([halved], {});
        const total = planYield.combinedTotal([designs.total, remaining.total], designs.assumptions);
        expect(total.buildings).toBe(2);
        expect(total.grossFloorAreaM2).toBeCloseTo(designs.total.grossFloorAreaM2 + remaining.total.grossFloorAreaM2, 6);
        expect(total.apartments).toBe(planYield.planYield([whole, halved], {}).total.apartments);
    });
});

describe('where parks and squares are read', () => {
    const park = { type: 'way', id: 1, tags: { leisure: 'park' }, geometry: [node(0, 0), node(1, 0), node(1, 1), node(0, 0)] };
    const windowWith = fetch => ({ fetch, getBackendBase: () => 'https://api.example' });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

    it('asks our server first and public Overpass not at all when it answers', async () => {
        const fetch = vi.fn(async () => json(200, { features: [{ id: 'w1' }] }));
        const spaces = await State.browser(windowWith(fetch)).publicSpaces([15.9, 45.8, 15.91, 45.81]);
        expect(spaces).toEqual([{ id: 'w1' }]);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe('https://api.example/osm-public-spaces?bbox=15.9%2C45.8%2C15.91%2C45.81&crs=EPSG%3A4326');
    });

    it('falls back to public Overpass when our server cannot answer', async () => {
        const fetch = vi.fn(async url => (url.startsWith('https://api.example') ? json(503, { error: 'busy' }) : json(200, { elements: [park] })));
        const spaces = await State.browser(windowWith(fetch)).publicSpaces([15.9, 45.8, 15.91, 45.811]);
        expect(spaces.map(f => f.id)).toEqual(['w1']);
        expect(fetch.mock.calls[1][0]).toMatch(/^https:\/\/overpass-api\.de\/api\/interpreter\?data=/);
    });
});
