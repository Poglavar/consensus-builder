// GlobalBuildingAtlas on demand (buildings/global-building-atlas.js): tile naming, reading only the row
// groups under a box, the atlas as a building source, and its predicted heights for other sources'
// buildings that state neither height nor storeys, through the provider core and the registry.
import { describe, expect, it, vi } from 'vitest';
import { createAtlasBuildingProvider, createAtlasHeightEstimator, createAtlasReader, tileNamesFor } from '../buildings/global-building-atlas.js';
import { createOsmProvider } from '../buildings/osm-3d.js';
import { createBuildingProviders } from '../buildings/index.js';

const square = (x, y, d = 0.0001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const row = (source, id, x, y, height, d = 0.0001) => ({ source, id, height, bbox: { xmin: x, ymin: y, xmax: x + d, ymax: y + d }, geometry: square(x, y, d) });

// A tile of two row groups: the first around 77.0/43.6, the second far east.
function fakeTile(rows) {
    const groups = [
        { rowStart: 0, rowEnd: rows.west.length, bbox: [77.0, 43.6, 77.01, 43.61] },
        { rowStart: rows.west.length, rowEnd: rows.west.length + rows.east.length, bbox: [79.0, 44.0, 79.01, 44.01] }
    ];
    const all = [...rows.west, ...rows.east];
    return { groups, readRows: vi.fn(async (start, end) => all.slice(start, end)) };
}

describe('GlobalBuildingAtlas', () => {
    it('names the 5° tiles a box touches the way the atlas does', () => {
        expect(tileNamesFor([76.96, 43.40, 76.98, 43.42])).toEqual(['e075_n45_e080_n40']);
        expect(tileNamesFor([74.99, 43.4, 75.01, 43.41])).toEqual(['e070_n45_e075_n40', 'e075_n45_e080_n40']);
        expect(tileNamesFor([-1, -1, -0.5, -0.5])).toEqual(['w005_n00_e000_s05']);
    });

    it('reads only the row groups under the box, keeps them, and finds no buildings where the atlas has no tile', async () => {
        const tile = fakeTile({ west: [row('osm', '1', 77.001, 43.601, 9), row('ms', 'K_1_2', 77.009, 43.609, 4)], east: [row('ms', 'K_9', 79.001, 44.001, 6)] });
        const openTile = vi.fn(async url => url.includes('e075_n45_e080_n40') ? tile : null);
        const reader = createAtlasReader({ openTile });
        const found = await reader.buildingsIn([77.0005, 43.6005, 77.002, 43.602]);
        expect(found.map(entry => [entry.kind, entry.id, entry.heightM])).toEqual([['osm', '1', 9]]);
        expect(tile.readRows).toHaveBeenCalledTimes(1);
        expect(tile.readRows).toHaveBeenCalledWith(0, 2);
        await reader.buildingsIn([77.008, 43.608, 77.01, 43.61]);
        expect(tile.readRows).toHaveBeenCalledTimes(1);
        expect(openTile).toHaveBeenCalledTimes(1);
        expect(await reader.buildingsIn([-0.9, -0.9, -0.8, -0.8])).toEqual([]);
    });

    it('throws when a tile cannot be read, and tries it again on the next read', async () => {
        const openTile = vi.fn().mockRejectedValueOnce(Object.assign(new Error('atlas tile HEAD 503'), { status: 503 }))
            .mockResolvedValueOnce(fakeTile({ west: [row('ms', 'K_1', 77.001, 43.601, 5)], east: [] }));
        const reader = createAtlasReader({ openTile });
        await expect(reader.buildingsIn([77.0, 43.6, 77.002, 43.602])).rejects.toThrow('503');
        expect((await reader.buildingsIn([77.0, 43.6, 77.002, 43.602])).length).toBe(1);
    });

    it('draws its own buildings at their predicted height, and an implausible prediction as an ordinary estimate', async () => {
        const reader = { buildingsIn: async () => [
            { id: 'K_1', kind: 'ms', heightM: 7.5, bbox: [77.001, 43.601, 77.0011, 43.6011], geometry: square(77.001, 43.601) },
            { id: 'K_2', kind: 'ms', heightM: null, bbox: [77.003, 43.601, 77.0031, 43.6011], geometry: square(77.003, 43.601) }
        ] };
        const result = await createAtlasBuildingProvider({ reader }).near(square(77.0, 43.6, 0.005), 0);
        const byId = Object.fromEntries(result.buildings.map(model => [model.object_id, model]));
        expect(result.source).toBe('global-building-atlas');
        expect(byId['GBA-ms-K_1']).toMatchObject({ z_max: 7.5, height_source: 'estimated', height_estimate_source: 'global-building-atlas' });
        expect(byId['GBA-ms-K_2'].height_estimate_source).toBeUndefined();
    });

    it('gives another source its prediction only for buildings without a stated height or storeys', async () => {
        const reader = { buildingsIn: vi.fn(async () => [
            { id: '11', kind: 'osm', heightM: 12, bbox: [77.001, 43.601, 77.0011, 43.6011], geometry: square(77.001, 43.601) },
            { id: '12', kind: 'osm', heightM: 30, bbox: [77.002, 43.601, 77.0021, 43.6011], geometry: square(77.002, 43.601) },
            // Microsoft's footprint under a national building that has no OSM id.
            { id: 'K_3', kind: 'ms', heightM: 18, bbox: [77.00402, 43.601, 77.00412, 43.6011], geometry: square(77.00402, 43.601) }
        ]) };
        const features = [
            { type: 'Feature', id: 'w11', geometry: square(77.001, 43.601), properties: { osm_id: 'w11' } },
            { type: 'Feature', id: 'w12', geometry: square(77.002, 43.601), properties: { osm_id: 'w12', levels: 4 } },
            { type: 'Feature', id: 'KZ-NSDI-B-1', geometry: square(77.004, 43.601), properties: {} },
            { type: 'Feature', id: 'w99', geometry: square(77.008, 43.601), properties: { osm_id: 'w99' } }
        ];
        const provider = createOsmProvider(null, { fetchStaged: async () => null, fetchLive: async () => ({ type: 'FeatureCollection', features }) });
        const area = square(77.0, 43.6, 0.01);
        const result = await provider.near(area, 0, { estimateHeights: createAtlasHeightEstimator({ reader }) });
        const byId = Object.fromEntries(result.buildings.map(model => [model.object_id, model]));
        expect(byId.w11).toMatchObject({ z_max: 12, height_source: 'estimated', height_estimate_source: 'global-building-atlas' });
        expect(byId.w12).toMatchObject({ z_max: 12, height_source: 'levels' });
        expect(byId.w12.height_estimate_source).toBeUndefined();
        expect(byId['KZ-NSDI-B-1']).toMatchObject({ z_max: 18, height_estimate_source: 'global-building-atlas' });
        expect(byId.w99.height_estimate_source).toBeUndefined();
        // Without the request option the same buildings keep the type estimate.
        const plain = await provider.near(area, 0);
        expect(plain.buildings.some(model => model.height_estimate_source)).toBe(false);
    });

    it('says when the predictions could not be read, and still draws the buildings', async () => {
        const features = [{ type: 'Feature', id: 'w1', geometry: square(77.001, 43.601), properties: { osm_id: 'w1' } }];
        const provider = createOsmProvider(null, { fetchStaged: async () => null, fetchLive: async () => ({ type: 'FeatureCollection', features }) });
        const result = await provider.near(square(77.0, 43.6, 0.01), 0, { estimateHeights: async () => { throw new Error('atlas down'); } });
        expect(result.count).toBe(1);
        expect(result.heightEstimatesUnavailable).toBe(true);
    });

    it('is a registered building source, and only the atlas may be asked for height estimates', () => {
        const providers = createBuildingProviders(null, {});
        expect(typeof providers.resolveSource('global-building-atlas').near).toBe('function');
        expect(typeof providers.heightEstimator('global-building-atlas')).toBe('function');
        expect(providers.heightEstimator(undefined)).toBeNull();
        expect(() => providers.heightEstimator('satellite')).toThrow(expect.objectContaining({ status: 400 }));
    });
});
