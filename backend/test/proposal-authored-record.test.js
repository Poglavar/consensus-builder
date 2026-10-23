import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const authored = require('../../frontend/js/proposals/authored-record.js');

const oneBuilding = () => ({
    type: 'Feature',
    properties: { massing: true, height: 18, variationSeed: 731 },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0], [0, 0]],
            [[0.003, 0.003], [0.007, 0.003], [0.007, 0.007], [0.003, 0.007], [0.003, 0.003]]
        ]
    }
});

function blockRecord(buildings, blockMassing, geometryMetadata = {}) {
    return {
        proposalId: 'single-block',
        goal: 'buildings',
        buildingProposal: { typologyType: 'block' },
        geometry: { ...geometryMetadata, buildings, blockMassing }
    };
}

describe('proposal authored building geometry compaction', () => {
    it('removes only an identical single-building massing projection and retains the rendered feature', () => {
        const feature = oneBuilding();
        const massing = JSON.parse(JSON.stringify(feature));
        // Deep equality does not depend on JSON object key insertion order.
        massing.properties = { variationSeed: 731, height: 18, massing: true };
        const input = blockRecord([feature], massing, { layoutVersion: 2, source: 'authoring' });
        const before = JSON.stringify(input);
        const cleaned = authored.cleanFeatureContainers(input);

        expect(cleaned.geometry).not.toHaveProperty('blockMassing');
        expect(cleaned.geometry).toMatchObject({ layoutVersion: 2, source: 'authoring' });
        expect(cleaned.geometry.buildings).toEqual([feature]);
        expect(cleaned.geometry.buildings[0].geometry.coordinates).toHaveLength(2);
        expect(JSON.stringify(input)).toBe(before);
        expect(Buffer.byteLength(JSON.stringify(cleaned.geometry))).toBeLessThan(
            Buffer.byteLength(JSON.stringify(input.geometry)) * 0.6
        );
    });

    it('keeps distinct authored massing, including differing properties or geometry', () => {
        const feature = oneBuilding();
        const differentProperties = { ...oneBuilding(), properties: { massing: true, height: 22, variationSeed: 731 } };
        const differentShape = oneBuilding();
        differentShape.geometry.coordinates[0][1][1] = 0.02;

        for (const massing of [differentProperties, differentShape]) {
            const cleaned = authored.cleanFeatureContainers(blockRecord([feature], massing));
            expect(cleaned.geometry.blockMassing).toEqual(massing);
        }
    });

    it('keeps block massing when there are multiple authored buildings', () => {
        const first = oneBuilding();
        const second = oneBuilding();
        second.properties.height = 24;
        const cleaned = authored.cleanFeatureContainers(blockRecord([first, second], first));
        expect(cleaned.geometry.buildings).toHaveLength(2);
        expect(cleaned.geometry.blockMassing).toEqual(first);
    });

    it('is a pure shallow-copy projection and leaves unrelated geometry unchanged', () => {
        const feature = oneBuilding();
        const geometry = { buildings: [feature], blockMassing: JSON.parse(JSON.stringify(feature)), metadata: { keep: true } };
        const compacted = authored.compactBuildingGeometry(geometry);
        expect(compacted).not.toBe(geometry);
        expect(compacted).toEqual({ buildings: [feature], metadata: { keep: true } });
        expect(geometry).toHaveProperty('blockMassing');
        const unrelated = { groundSurface: feature };
        expect(authored.compactBuildingGeometry(unrelated)).toBe(unrelated);
    });
});
