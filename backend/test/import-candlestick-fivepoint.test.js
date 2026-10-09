// The FivePoint plan importer's conversion: one volume per height zone of each development block
// (parks skipped, mid-block breaks cut out, edges pulled in), one clipped tower box per encouraged
// tower location, heights in metres with storeys derived.
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { convertPlan } from '../scripts/import-candlestick-fivepoint.mjs';

// Two 100 m blocks side by side near Candlestick Point (WGS84), one of them a park.
const block = (id, lonMin, landUse, extra = {}) => ({
    type: 'Feature',
    properties: { block_id: id, neighborhood: 'Candlestick North', land_use: landUse, max_height_ft_2024: 65, ...extra },
    geometry: { type: 'Polygon', coordinates: [[[lonMin, 37.7140], [lonMin + 0.0011, 37.7140], [lonMin + 0.0011, 37.7149], [lonMin, 37.7149], [lonMin, 37.7140]]] }
});
const zone = (blockId, lonMin, lonMax, heightFt) => ({
    type: 'Feature',
    properties: { block_id: blockId, height_ft: heightFt },
    geometry: { type: 'Polygon', coordinates: [[[lonMin, 37.7140], [lonMax, 37.7140], [lonMax, 37.7149], [lonMin, 37.7149], [lonMin, 37.7140]]] }
});
const layers = () => ({
    blocks: { type: 'FeatureCollection', features: [block('CN-1', -122.3840, 'Residential Density II'), block('CN-12', -122.3828, 'Parks and Open Space')] },
    zones: { type: 'FeatureCollection', features: [zone('CN-1', -122.3840, -122.38345, 65), zone('CN-1', -122.38345, -122.3829, 85), zone('CN-12', -122.3828, -122.3817, 40)] },
    towers: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { tower: 'A', max_height_ft: 220, block_id: 'CN-1' }, geometry: { type: 'Point', coordinates: [-122.38395, 37.71488] } }] },
    breaks: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { kind: 'mid_block_break' }, geometry: { type: 'Polygon', coordinates: [[[-122.38370, 37.7140], [-122.38360, 37.7140], [-122.38360, 37.7149], [-122.38370, 37.7149], [-122.38370, 37.7140]]] } }] }
});

describe('convertPlan', () => {
    it('makes one volume per height zone of a development block and skips park blocks', () => {
        const out = convertPlan(layers());
        const zones = out.features.filter(feature => feature.properties.source === 'height zone');
        expect(zones.map(feature => feature.properties.id)).toEqual(['CN-1-1', 'CN-1-2']);
        expect(zones[0].properties).toMatchObject({ type: 'proposedBuilding', block: 'CN-1', landUse: 'Residential Density II', height: 19.81, levels: 6 });
        expect(zones[1].properties).toMatchObject({ height: 25.91, levels: 8, name: 'Residential Density II · 85 ft' });
        expect(out.skippedBlocks).toEqual(['CN-12 (Parks and Open Space)']);
        expect(out.blockCount).toBe(2);
        expect(out.heightsFt).toEqual({ 65: 1, 85: 1, 220: 1 });
    });

    it('pulls each zone in from its edges and keeps the mid-block break open', () => {
        const out = convertPlan(layers());
        const first = out.features.find(feature => feature.properties.id === 'CN-1-1');
        const zoneArea = turf.area(turf.polygon(layers().zones.features[0].geometry.coordinates));
        expect(turf.area(first)).toBeLessThan(zoneArea * 0.97);
        // The break runs through the first zone: its centre line is no longer inside the footprint.
        expect(turf.booleanPointInPolygon(turf.point([-122.38365, 37.71445]), first)).toBe(false);
        expect(turf.booleanPointInPolygon(turf.point([-122.38385, 37.71445]), first)).toBe(true);
    });

    it('stands a tower box at the encouraged location, clipped to its block', () => {
        const out = convertPlan(layers());
        const tower = out.features.find(feature => feature.properties.id === 'tower-A');
        expect(tower.properties).toMatchObject({ name: 'Tower A · 220 ft', height: 67.06, levels: 21, block: 'CN-1', source: 'encouraged tower location' });
        const area = turf.area(tower);
        // A 34 m square is 1,156 m²; the location sits near the block's north edge, so the box is clipped.
        expect(area).toBeGreaterThan(300);
        expect(area).toBeLessThan(1000);
        const blockFeature = turf.feature(layers().blocks.features[0].geometry);
        // Nothing of the box stands outside its block (turf 6.5: two-argument difference).
        const outside = turf.difference(tower, blockFeature);
        expect(outside ? turf.area(outside) : 0).toBeLessThan(1);
    });
});
