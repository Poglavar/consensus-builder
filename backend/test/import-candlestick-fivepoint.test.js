// The FivePoint plan importer's conversion: one volume per height zone of each development block
// (parks skipped, mid-block breaks cut out, edges pulled in), one clipped tower box per encouraged
// tower location, heights in metres with storeys derived.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as turf from '@turf/turf';
import { buildRecords, convertPlan } from '../scripts/import-candlestick-fivepoint.mjs';

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
        expect(zones.filter(feature => feature.properties.sourceFeatureId === 'CN-1-1')).toHaveLength(2);
        expect(zones.some(feature => feature.properties.id === 'CN-1-2')).toBe(true);
        expect(zones.find(feature => feature.properties.sourceFeatureId === 'CN-1-1').properties).toMatchObject({ type: 'proposedBuildingSingle', block: 'CN-1', landUse: 'Residential Density II', height: 19.81, levels: 6 });
        expect(zones.find(feature => feature.properties.id === 'CN-1-2').properties).toMatchObject({ height: 25.91, levels: 8, name: 'Residential Density II · 85 ft' });
        expect(out.skippedBlocks).toEqual(['CN-12 (Parks and Open Space)']);
        expect(out.blockCount).toBe(2);
        expect(out.heightsFt).toEqual({ 65: 2, 85: 1, 220: 1 });
    });

    it('pulls each zone in from its edges and keeps the mid-block break open', () => {
        const out = convertPlan(layers());
        const firstParts = out.features.filter(feature => feature.properties.sourceFeatureId === 'CN-1-1');
        const first = turf.multiPolygon(firstParts.map(feature => feature.geometry.coordinates));
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

    it('writes one ordinary Freeform proposal per plan feature, preserving its full geometry and properties', () => {
        const stats = convertPlan(layers());
        const records = buildRecords({ program: {}, stats, city: 'san_francisco', proposalId: 'plan', expiresInDays: 0 });
        expect(records).toHaveLength(stats.features.length);
        expect(records.map(record => record.proposalId)).toEqual(stats.features.map(feature => feature.properties.id).map(id =>
            `plan-${id.toLowerCase()}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`));
        records.forEach((record, index) => {
            expect(record).toMatchObject({ goal: 'single', typologyType: 'single', primaryType: 'Urban Rule', site: stats.features[index].geometry });
            expect(record.buildingProposal).toMatchObject({ typologyType: 'single', createdFrom: 'blockify', parameters: { typology: 'single', height: stats.features[index].properties.height, rotation: 0, footprintMode: 'polygon' } });
            expect(record.geometry.buildings).toEqual([stats.features[index]]);
            expect(record).not.toHaveProperty('buildingGeometry');
            expect(record).not.toHaveProperty('buildingProperties');
            expect(record.buildingProposal).not.toHaveProperty('buildingFeature');
            expect(record.buildingProposal.parameters).not.toHaveProperty('mode');
        });
    });
});


describe('ordinary building volume partitioning', () => {
    it('keeps disconnected pieces and holes and assigns overlapping ground to the taller building', async () => {
        const { partitionBuildingFootprints, polygonBuildingParts } = await import('../scripts/lib/building-import-geometry.mjs');
        const outer = [[16,45],[16.004,45],[16.004,45.004],[16,45.004],[16,45]];
        const hole = [[16.001,45.001],[16.001,45.002],[16.002,45.002],[16.002,45.001],[16.001,45.001]];
        const lower = turf.polygon([outer,hole], { id: 'courtyard', height: 15, floors: 5 });
        const tower = turf.polygon([[[16.003,45],[16.004,45],[16.004,45.001],[16.003,45.001],[16.003,45]]], { id: 'tower', height: 45 });
        const input = structuredClone([lower,tower]);
        const output = partitionBuildingFootprints([lower,tower]);
        expect([lower,tower]).toEqual(input);
        const keptTower = output.find(feature => feature.properties.id === 'tower');
        expect(keptTower.geometry).toEqual(tower.geometry);
        expect(output.find(feature => feature.properties.id === 'courtyard').geometry.coordinates[1]).toEqual(hole);
        const unionBefore = turf.union(lower,tower);
        const unionAfter = output.reduce((acc,feature) => acc ? turf.union(acc,feature) : feature,null);
        const lost=turf.difference(unionBefore,unionAfter), added=turf.difference(unionAfter,unionBefore);
        expect(lost ? turf.area(lost) : 0).toBeLessThan(0.01);
        expect(added ? turf.area(added) : 0).toBeLessThan(0.01);
        expect(turf.area(unionAfter)).toBeCloseTo(turf.area(unionBefore),4);
        for (let i=0;i<output.length;i++) for(let j=i+1;j<output.length;j++) {
            const overlap=turf.intersect(output[i],output[j]);
            expect(overlap ? turf.area(overlap) : 0).toBeLessThan(0.01);
        }
        const multi = turf.multiPolygon([lower.geometry.coordinates, tower.geometry.coordinates], { id: 'parts', height: 12 });
        const parts=polygonBuildingParts([multi]);
        expect(parts.map(feature => feature.properties.id)).toEqual(['parts-part-1','parts-part-2']);
        expect(parts[0].geometry.coordinates).toEqual(lower.geometry.coordinates);
        expect(parts[1].geometry.coordinates).toEqual(tower.geometry.coordinates);
    });
});
