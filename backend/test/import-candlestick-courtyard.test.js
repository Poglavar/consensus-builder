// The Candlestick courtyard importer's conversion: UTM 10N footprints become WGS84 building features
// with the model's heights; two-part footprints survive as MultiPolygons; artefacts are dropped
// and reported rather than silently kept or lost.
import { describe, expect, it } from 'vitest';
import { buildingHeightM, convertBuildings, footprintToWgs84 } from '../scripts/import-candlestick-courtyard.mjs';

// A small square near the tower centre of the published model (UTM 10N metres).
const SQUARE = [[554200, 4174300], [554220, 4174300], [554220, 4174320], [554200, 4174320], [554200, 4174300]];
const plates = (...tops) => tops.map((top, index) => ({ properties: { level: index + 1, z_top_m: top } }));

describe('footprintToWgs84', () => {
    it('reprojects a polygon into longitude/latitude at Candlestick Point and closes the ring', () => {
        const out = footprintToWgs84({ type: 'Polygon', coordinates: [SQUARE] });
        expect(out.type).toBe('Polygon');
        const [lon, lat] = out.coordinates[0][0];
        expect(lon).toBeCloseTo(-122.385, 2);
        expect(lat).toBeCloseTo(37.7144, 3);
        expect(out.coordinates[0][0]).toEqual(out.coordinates[0][out.coordinates[0].length - 1]);
    });

    it('keeps every usable part of a two-part footprint and drops artefacts', () => {
        const shifted = SQUARE.map(([x, y]) => [x + 50, y]);
        expect(footprintToWgs84({ type: 'MultiPolygon', coordinates: [[SQUARE], [shifted]] }).type).toBe('MultiPolygon');
        expect(footprintToWgs84({ type: 'MultiPolygon', coordinates: [[SQUARE], [[[1, 1], [1, 1], [1, 1], [1, 1]]]] }).type).toBe('Polygon');
        expect(footprintToWgs84({ type: 'Polygon', coordinates: [[[554200, 4174300]]] })).toBeNull();
        expect(footprintToWgs84({ type: 'Point', coordinates: [554200, 4174300] })).toBeNull();
    });
});

describe('buildingHeightM', () => {
    it('takes the top of the highest floorplate, else levels times a floor height', () => {
        expect(buildingHeightM({ occupied_floorplates: plates(3.6576, 6.7056, 9.7536) })).toBe(9.75);
        expect(buildingHeightM({ source_control_properties: { levels: 5 } })).toBe(16);
        expect(buildingHeightM({})).toBeNull();
    });
});

describe('convertBuildings', () => {
    it('produces building features with the properties the map reads and counts what it dropped', () => {
        const model = { buildings: [
            { id: 'A', block_id: 'F001', footprint_area_m2: 400, footprint_utm_m: { type: 'Polygon', coordinates: [SQUARE] }, source_control_properties: { levels: 3, program: 'Mixed' }, occupied_floorplates: plates(3.6576, 6.7, 9.75) },
            { id: 'B', block_id: 'F001', footprint_area_m2: 400, footprint_utm_m: { type: 'MultiPolygon', coordinates: [[SQUARE], [SQUARE.map(([x, y]) => [x + 60, y])]] }, source_control_properties: { levels: 6 }, occupied_floorplates: plates(21.95) },
            { id: 'C', footprint_utm_m: { type: 'Polygon', coordinates: [[[1, 1]]] }, source_control_properties: { levels: 5 } },
            { id: 'D', footprint_utm_m: { type: 'Polygon', coordinates: [SQUARE] } }
        ] };
        const out = convertBuildings(model);
        expect(out.features.map(f => f.properties.id)).toEqual(['A', 'B']);
        expect(out.features[0].properties).toMatchObject({ type: 'proposedBuilding', block: 'F001', name: 'Mixed', levels: 3, height: 9.75 });
        expect(out.features[1].geometry.type).toBe('MultiPolygon');
        expect(out.dropped).toEqual(['C', 'D']);
        expect(out.levelsHistogram).toEqual({ 3: 1, 6: 1 });
        expect(out.footprintM2).toBe(800);
    });
});
