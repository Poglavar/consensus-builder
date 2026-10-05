// Water for the 3D scene (decor/openfreemap-water.js and POST /decor/water): which z14 tiles cover a
// scene, which tile features become water (areas clipped, lines widened, tunnels dropped), and the
// route that serves it in every city.
import { describe, it, expect, vi } from 'vitest';
import * as turf from '@turf/turf';
import { tilesForBbox, waterFromTileFeatures } from '../decor/openfreemap-water.js';
import { setupDecorRoute } from '../routes/decor.js';

const bbox = [2.345, 48.853, 2.353, 48.858];
const square = (x, y, d) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const feature = (geometry, properties) => ({ type: 'Feature', geometry, properties });

describe('water tiles', () => {
    it('covers a scene with the z14 tiles it touches', () => {
        expect(tilesForBbox([2.3515, 48.856, 2.3529, 48.857])).toEqual([{ z: 14, x: 8299, y: 5636 }]);
        expect(tilesForBbox(bbox).length).toBeGreaterThanOrEqual(1);
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
    });
});

describe('POST /decor/water', () => {
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
        setupDecorRoute(server, { query: vi.fn() }, { waterProvider });
        const layers = response();
        await server.routes['GET /decor/layers']({ query: { city: 'paris' } }, layers);
        expect(layers.body.layers).toContain('water');
        const water = response();
        await server.routes['POST /decor/water']({ body: { geometry: { type: 'Point', coordinates: [2.35, 48.85] }, buffer_meters: 300 } }, water);
        expect(water.body).toMatchObject({ count: 1, source: 'openfreemap' });
        expect(waterProvider.near).toHaveBeenCalledWith({ type: 'Point', coordinates: [2.35, 48.85] }, 300);
    });

    it('answers 502 when the tiles cannot be read, so the scene draws without water', async () => {
        const server = app();
        setupDecorRoute(server, { query: vi.fn() }, { waterProvider: { near: async () => { throw new Error('OpenFreeMap HTTP 503'); } } });
        const res = response();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await server.routes['POST /decor/water']({ body: { geometry: { type: 'Point', coordinates: [2.35, 48.85] } } }, res);
        expect(res.statusCode).toBe(502);
    });
});
