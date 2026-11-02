// The block-boundary Overpass source keeps tagged ways and their identities for model-side filtering.
import { describe, expect, it, vi } from 'vitest';
import { blockRoadsToGeoJSON, buildBlockRoadQuery, fetchBlockRoads } from '../streets/block-roads.js';

const line = [{ lon: 15.1, lat: 45.1 }, { lon: 15.2, lat: 45.2 }];
const way = (id, tags, geometry = line) => ({ type: 'way', id, tags, geometry });

describe('block boundary source', () => {
    it('queries all tagged road, rail, waterway, coastline, and water ways in Overpass box order', () => {
        const query = buildBlockRoadQuery([15, 45, 16, 46]);

        expect(query).toContain('way["highway"](45,15,46,16)');
        expect(query).toContain('way["railway"](45,15,46,16)');
        expect(query).toContain('way["waterway"](45,15,46,16)');
        expect(query).toContain('way["natural"~"^(coastline|water)$"](45,15,46,16)');
        expect(query).toContain('out geom;');
    });

    it('converts every boundary way, preserves tags and identity, deduplicates, and skips relations', () => {
        const coastline = [[15.1, 45.1], [15.2, 45.2], [15.1, 45.1]];
        const ways = [
            way(1, { highway: 'footway', name: 'Canal Walk', surface: 'gravel' }),
            way(2, { highway: 'track' }),
            way(3, { railway: 'tram', bridge: 'yes' }),
            way(4, { waterway: 'river', name: 'River' }),
            way(5, { waterway: 'canal' }),
            way(6, { waterway: 'stream' }),
            way(7, { natural: 'coastline' }, coastline.map(([lon, lat]) => ({ lon, lat }))),
            way(8, { natural: 'water', water: 'lake' }, coastline.map(([lon, lat]) => ({ lon, lat }))),
            way(1, { highway: 'footway', name: 'duplicate' }),
            { type: 'relation', id: 9, tags: { waterway: 'river' }, members: [] },
            way(10, { building: 'yes' })
        ];

        const result = blockRoadsToGeoJSON(ways);

        expect(result.features.map(feature => feature.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']);
        expect(result.features[0].properties).toMatchObject({ osm_id: 'w1', highway: 'footway', name: 'Canal Walk', surface: 'gravel' });
        expect(result.features[2].properties).toMatchObject({ osm_id: 'w3', railway: 'tram', bridge: 'yes' });
        expect(result.features[3].properties).toMatchObject({ osm_id: 'w4', waterway: 'river', name: 'River' });
        expect(result.features[6].geometry).toEqual({ type: 'LineString', coordinates: coastline });
        expect(result.truncated).toBe(false);
    });

    it('keeps feature caps, incomplete-response errors, and mocked fetch behavior bounded', async () => {
        const elements = [way(1, { highway: 'path' }), way(2, { waterway: 'stream' })];
        expect(blockRoadsToGeoJSON(elements, 1)).toMatchObject({ truncated: true, features: [{ id: 'w1' }] });
        expect(() => blockRoadsToGeoJSON(elements, 10, { remark: 'runtime timeout' })).toThrow(/incomplete/i);

        const source = vi.fn(async () => blockRoadsToGeoJSON(elements));
        await expect(fetchBlockRoads([15, 45, 15.01, 45.01], { source })).resolves.toMatchObject({
            type: 'FeatureCollection', source: 'overpass', bbox: [15, 45, 15.01, 45.01], features: [{ id: 'w1' }, { id: 'w2' }]
        });
        expect(source).toHaveBeenCalledExactlyOnceWith([15, 45, 15.01, 45.01], expect.anything());
    });
});
