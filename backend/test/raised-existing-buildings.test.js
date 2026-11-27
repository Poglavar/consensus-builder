// Based on existing buildings: the shared builder the Block editor and the MCP Block constructor
// both redraw existing buildings with (frontend/js/raised-existing-buildings.js).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const Raised = require('../../frontend/js/raised-existing-buildings.js');
const planYield = require('../../frontend/js/proposals/plan-yield.js');

const square = (west, south, size, properties = {}) => turf.polygon([[[west, south], [west + size, south], [west + size, south + size],
    [west, south + size], [west, south]]], properties);
const site = square(16, 45, 0.001).geometry;
const settings = (overrides = {}) => ({ ...Raised.DEFAULTS, ...overrides });

describe('raised existing buildings', () => {
    it('keeps only the buildings at least half inside the site, keyed by source and id', () => {
        const inside = square(16.0001, 45.0001, 0.0002, { id: 7, source: 'osm', height_m: 9 });
        const straddling = square(16.00095, 45.0001, 0.0002, { id: 8, source: 'osm', height_m: 9 });
        const kept = Raised.footprintsOnSite([inside, straddling], site, turf);
        expect(kept.map(footprint => footprint.id)).toEqual(['osm:7']);
        expect(kept[0]).toMatchObject({ source: 'osm', height_m: 9, geometry: inside.geometry });
    });

    it('redraws each footprint at the stated storeys, with its storey height, roof and the building it extends', () => {
        const footprints = [{ id: 'osm:1', height_m: 9, geometry: square(16, 45, 0.0001).geometry },
            { id: 'osm:2', floors: 2, geometry: square(16.0002, 45, 0.0001).geometry }];
        const exact = Raised.raise(footprints, settings({ rule: 'exact', proposedHeightFloors: 4, floorHeightM: 3.5, roof: 'mansard' }), { blockName: 'Terrace' });
        expect(exact.map(feature => feature.properties)).toEqual([
            { type: 'proposedBuilding', block: 'Terrace', basedOnExisting: true, sourceBuildingId: 'osm:1', existingHeight: 9, height: 14, floorHeightM: 3.5, roof: 'mansard', buildingIndex: 0 },
            { type: 'proposedBuilding', block: 'Terrace', basedOnExisting: true, sourceBuildingId: 'osm:2', existingHeight: 7, height: 14, floorHeightM: 3.5, roof: 'mansard', buildingIndex: 1 }
        ]);
        expect(exact[0].geometry).toEqual(footprints[0].geometry);
        expect(exact[0].geometry).not.toBe(footprints[0].geometry);
        // A flat roof is no roof property, as the editor has always saved it.
        expect(Raised.raise(footprints, settings({ roof: 'flat' }))[0].properties).not.toHaveProperty('roof');
    });

    it('adds storeys to each known height and leaves out a building whose height is unknown', () => {
        const footprints = [{ id: 'a', height_m: '9', geometry: site }, { id: 'b', geometry: site }];
        const raised = Raised.raise(footprints, settings({ rule: 'additional', additionalFloors: 0, floorHeightM: 3, roof: 'mansard' }));
        expect(raised.map(feature => [feature.properties.sourceBuildingId, feature.properties.height])).toEqual([['a', 9]]);
        expect(Raised.heightsKnown(footprints)).toBe(true);
        expect(Raised.heightsKnown([{ id: 'b', height_m: null, floors: 0 }])).toBe(false);
    });

    it('measures the storeys before and after by the design\'s storey height', () => {
        // 3.5 m storeys: 9 m is 3 storeys before, 14 m is 4 after. Without the storey height on the
        // building, Plan stats read 14 m at its 3 m default as 5 storeys.
        const [house] = Raised.raise([{ id: 'a', height_m: 9, geometry: square(16, 45, 0.0001).geometry }],
            settings({ rule: 'exact', proposedHeightFloors: 4, floorHeightM: 3.5 }));
        const measured = planYield.measureBuilding(house, null, {});
        expect(measured.floors).toBe(4);
        expect(measured.keptGfaM2 / measured.gfaM2).toBeCloseTo(3 / 4, 6);
    });

    it('saves the parameters the editor reopens the design from', () => {
        expect(Raised.parameters(settings({ rule: 'additional', additionalFloors: 0, roof: 'mansard' }))).toEqual({
            mode: 'existing', typology: 'block', rule: 'additional', proposedHeightFloors: 6, additionalFloors: 0,
            floorHeightM: 3.5, roof: 'mansard', algorithm: null });
    });
});
