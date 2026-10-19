// Headless checks for ordering and walk-band presentation of detected urban blocks.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rankBlocks, walkBand, blockColor, WALK_COLORS } = require('../../frontend/js/urban-blocks-model.js');

describe('urban block ranking and walk colors', () => {
    it('ranks by raw perimeter, breaks ties by ascending ID, and preserves the detection result', () => {
        const features = [
            { id: 'block-z', properties: { perimeterM: 200, color: '#aabbcc' } },
            { id: 'block-b', properties: { perimeterM: 300, color: '#112233' } },
            { id: 'block-a', properties: { perimeterM: 300, color: '#445566' } },
            { id: 'block-small', properties: { perimeterM: 100, color: '#778899' } }
        ];
        const originalOrder = features.slice();
        const originalProperties = features.map(feature => ({ ...feature.properties }));

        const ranked = rankBlocks(features);

        expect(ranked).not.toBe(features);
        expect(ranked).toEqual([features[2], features[1], features[0], features[3]]);
        expect(features).toEqual(originalOrder);
        expect(features.map(feature => feature.properties)).toEqual(originalProperties);
    });

    it('keeps the exact walking-time threshold within the band', () => {
        expect(walkBand(15, 15)).toBe('within');
        expect(walkBand(15.01, 15)).toBe('over');
        expect(walkBand(14.99, 15)).toBe('within');
    });

    it('uses the saved feature color outside walk mode and restores it after threshold changes', () => {
        const feature = { id: 'osm-block-42', properties: { perimeterM: 1000, walkMinutes: 12, color: '#9c97ce' } };
        const original = structuredClone(feature);

        expect(blockColor(feature, 'blocks', 10)).toBe('#9c97ce');
        expect(blockColor(feature, 'walk', 12)).toBe(WALK_COLORS.within);
        expect(blockColor(feature, 'walk', 10)).toBe(WALK_COLORS.over);
        expect(blockColor(feature, 'walk', 15)).toBe(WALK_COLORS.within);
        expect(blockColor(feature, 'blocks', 15)).toBe('#9c97ce');
        expect(feature).toEqual(original);
    });
});
