// Water for the 3D scene (decor/openfreemap-water.js and GET /decor/water): which z14 tiles cover a
// scene, which tile features become water (areas clipped, lines widened, tunnels dropped), and the
// route that serves it in every city.
import { describe, it, expect, vi } from 'vitest';
import * as turf from '@turf/turf';
import { createWaterProvider, tilesForBbox, waterFromTileFeatures } from '../decor/openfreemap-water.js';
import { tileBbox } from '../decor/openfreemap-tiles.js';
import { setupDecorRoute } from '../routes/decor.js';

const bbox = [2.345, 48.853, 2.353, 48.858];
const square = (x, y, d) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const feature = (geometry, properties) => ({ type: 'Feature', geometry, properties });

describe('water tiles', () => {
    it('covers a scene with the z14 tiles it touches', () => {
        expect(tilesForBbox([2.3515, 48.856, 2.3529, 48.857])).toEqual([{ z: 14, x: 8299, y: 5636 }]);
        expect(tilesForBbox(bbox).length).toBeGreaterThanOrEqual(1);
    });

    it('names a valid overview tile by its exact WGS84 boundary', () => {
        const world = tileBbox(0, 0, 0);
        expect(world[0]).toBe(-180); expect(world[2]).toBe(180);
        expect(world[1]).toBeCloseTo(-85.0511287798066, 12); expect(world[3]).toBeCloseTo(85.0511287798066, 12);
        const overview = tileBbox(9, 365, 187);
        expect(overview[0]).toBe(76.640625); expect(overview[2]).toBe(77.34375);
        expect(overview[1]).toBeCloseTo(43.06888777416962, 12); expect(overview[3]).toBeCloseTo(43.58039085560785, 12);
        expect(tileBbox(9, 512, 0)).toBeNull();
    });

    it('clips areas to the scene, widens lines by their class, and leaves tunnels out', () => {
        const areas = waterFromTileFeatures([
            feature(square(2.340, 48.850, 0.02), { layer: 'water', class: 'river' }),
            feature({ type: 'LineString', coordinates: [[2.346, 48.855], [2.352, 48.855]] }, { layer: 'waterway', class: 'stream' }),
            feature({ type: 'LineString', coordinates: [[2.346, 48.856], [2.352, 48.856]] }, { layer: 'waterway', class: 'canal', brunnel: 'tunnel' }),
            feature(square(2.40, 48.90, 0.001), { layer: 'water', class: 'pond' })
        ], bbox);
        // The pond lies outside the scene and the canal runs in a tunnel: neither is drawn.
        expect(areas.map(a => a.kind)).toEqual(['river', 'waterway']);
        const [river, stream] = areas;
        expect(turf.bbox(river.geometry)).toEqual(bbox);
        // A stream is 3 m wide: about 1.5 m either side of its line.
        const [, s, , n] = turf.bbox(stream.geometry);
        expect((n - s) * 111320).toBeCloseTo(3, 0);
        expect(turf.booleanWithin(turf.feature(stream.geometry), turf.bboxPolygon(bbox))).toBe(true);
    });
});

describe('overview water tiles', () => {
    it('uses the requested source zoom and gives rivers a latitude-aware display width at regional scale', async () => {
        const reader = { tile: vi.fn(async () => ({ tiles: 1, features: [
            feature({ type: 'LineString', coordinates: [[76.7, 43.2], [77.1, 43.2]] }, { layer: 'waterway', class: 'river' }),
            feature({ type: 'LineString', coordinates: [[76.7, 43.25], [77.1, 43.25]] }, { layer: 'waterway', class: 'ditch' })
        ] })) };
        const provider = createWaterProvider({ reader, now: () => 0 });
        const result = await provider.tile(9, 365, 187);
        expect(reader.tile).toHaveBeenCalledWith(9, 365, 187, ['water', 'waterway']);
        const [, riverSouth, , riverNorth] = turf.bbox(result.areas[0].geometry);
        const [, ditchSouth, , ditchNorth] = turf.bbox(result.areas[1].geometry);
        // At 43°N and z9, 0.9 of a 512 px tile is roughly 99 m. A 1.5 m ditch stays 1.5 m.
        expect((riverNorth - riverSouth) * 111320).toBeGreaterThan(90);
        expect((ditchNorth - ditchSouth) * 111320).toBeCloseTo(1.5, 0);
        expect(result).toMatchObject({ source: 'openfreemap', z: 9, x: 365, y: 187, count: 2 });
        const regional = await provider.tile(7, 91, 46);
        const [, regionalSouth, , regionalNorth] = turf.bbox(regional.areas[0].geometry);
        // At z7 the same source river holds about 0.9 of a 512 px tile, roughly 400 m at 43°N.
        expect((regionalNorth - regionalSouth) * 111320).toBeGreaterThan(350);
        await expect(provider.tile(15, 0, 0)).resolves.toBeNull();
    });
});

describe('GET /decor/water', () => {
    function app() {
        const routes = {};
        return { routes, get: (path, handler) => { routes['GET ' + path] = handler; }, post: (path, handler) => { routes['POST ' + path] = handler; } };
    }
    const response = () => {
        const res = { statusCode: 200 };
        res.status = code => { res.statusCode = code; return res; };
        res.json = body => { res.body = body; return res; };
        return res;
    };

    it('serves water in every city and is listed as a layer even where no scenery is ingested', async () => {
        const server = app();
        const waterProvider = { near: vi.fn(async () => ({ areas: [{ geometry: square(0, 0, 1), kind: 'ocean' }], count: 1, source: 'openfreemap' })) };
        setupDecorRoute(server, { query: vi.fn(async () => ({ rows: [] })) }, { waterProvider });
        const layers = response();
        await server.routes['GET /decor/layers']({ query: { bbox: '2.34,48.84,2.36,48.86' } }, layers);
        expect(layers.body.layers).toContain('water');
        const water = response();
        await server.routes['GET /decor/water']({ query: { bbox: '2.35,48.85,2.35,48.85', buffer_meters: '300' } }, water);
        expect(water.body).toMatchObject({ count: 1, source: 'openfreemap' });
        expect(waterProvider.near).toHaveBeenCalledWith({ type: 'Point', coordinates: [2.35, 48.85] }, 300);
        // A box is read as its rectangle; a malformed one is refused before the tiles are asked.
        await server.routes['GET /decor/water']({ query: { bbox: '2.34,48.84,2.36,48.86' } }, response());
        expect(waterProvider.near).toHaveBeenLastCalledWith({ type: 'Polygon', coordinates: [[[2.34, 48.84], [2.36, 48.84], [2.36, 48.86], [2.34, 48.86], [2.34, 48.84]]] }, 150);
        const bad = response();
        await server.routes['GET /decor/water']({ query: { bbox: '2.36,48.84,2.34' } }, bad);
        expect(bad.statusCode).toBe(400);
        expect(waterProvider.near).toHaveBeenCalledTimes(2);
    });

    it('answers 502 when the tiles cannot be read, so the scene draws without water', async () => {
        const server = app();
        setupDecorRoute(server, { query: vi.fn() }, { waterProvider: { near: async () => { throw new Error('OpenFreeMap HTTP 503'); } } });
        const res = response();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await server.routes['GET /decor/water']({ query: { bbox: '2.35,48.85,2.35,48.85' } }, res);
        expect(res.statusCode).toBe(502);
    });

    it('serves cacheable overview tiles and refuses invalid coordinates', async () => {
        const server = app();
        const waterProvider = { near: vi.fn(), tile: vi.fn(async (z, x, y) => ({ areas: [], count: 0, source: 'openfreemap', z, x, y })) };
        setupDecorRoute(server, { query: vi.fn() }, { waterProvider });
        const headers = {};
        const res = response();
        res.set = (name, value) => { headers[name] = value; return res; };
        await server.routes['GET /decor/water/tile/:z/:x/:y']({ params: { z: '9', x: '365', y: '186' } }, res);
        expect(waterProvider.tile).toHaveBeenCalledWith(9, 365, 186);
        expect(res.body).toMatchObject({ z: 9, x: 365, y: 186 });
        expect(headers['Cache-Control']).toBe('public, max-age=21600');
        const bad = response();
        await server.routes['GET /decor/water/tile/:z/:x/:y']({ params: { z: '9', x: '512', y: '0' } }, bad);
        expect(bad.statusCode).toBe(400);
    });
});
