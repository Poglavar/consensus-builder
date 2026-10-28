// Green areas for the 3D scene (decor/openfreemap-green.js, decor/openfreemap-tiles.js and POST
// /decor/green): which landcover classes become lawn, meadow or forest, clipping to the scene, one
// shared tile read for water and green, and the route that serves it in every city.
import { describe, it, expect, vi } from 'vitest';
import * as turf from '@turf/turf';
import { greenLook, greenFromTileFeatures, createGreenProvider } from '../decor/openfreemap-green.js';
import { createWaterProvider } from '../decor/openfreemap-water.js';
import { createTileReader } from '../decor/openfreemap-tiles.js';
import { setupDecorRoute } from '../routes/decor.js';

const bbox = [15.976, 45.809, 15.980, 45.812];
const square = (x, y, d) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const feature = (geometry, properties) => ({ type: 'Feature', geometry, properties: { layer: 'landcover', ...properties } });

describe('green looks', () => {
    it('reads tended grass as lawn, rough grass and farmland as meadow, woods as forest, the rest not at all', () => {
        expect(greenLook({ class: 'grass', subclass: 'park' })).toBe('lawn');
        expect(greenLook({ class: 'grass', subclass: 'garden' })).toBe('lawn');
        expect(greenLook({ class: 'grass', subclass: 'grass' })).toBe('lawn');
        expect(greenLook({ class: 'grass', subclass: 'meadow' })).toBe('meadow');
        expect(greenLook({ class: 'grass', subclass: 'scrub' })).toBe('meadow');
        expect(greenLook({ class: 'farmland', subclass: 'vineyard' })).toBe('meadow');
        expect(greenLook({ class: 'wood', subclass: 'forest' })).toBe('forest');
        expect(greenLook({ class: 'sand' })).toBeNull();
        expect(greenLook({ class: 'wetland' })).toBeNull();
    });

    it('clips pieces to the scene and keeps only polygons', () => {
        const areas = greenFromTileFeatures([
            feature(square(15.975, 45.808, 0.01), { class: 'grass', subclass: 'park' }),
            feature(square(15.977, 45.810, 0.001), { class: 'wood', subclass: 'wood' }),
            feature({ type: 'LineString', coordinates: [[15.977, 45.81], [15.978, 45.81]] }, { class: 'grass', subclass: 'grass' }),
            feature(square(16.1, 45.9, 0.001), { class: 'grass', subclass: 'grass' }),
            feature(square(15.977, 45.810, 0.001), { class: 'sand' })
        ], bbox);
        expect(areas.map(a => a.kind)).toEqual(['lawn', 'forest']);
        expect(turf.bbox(areas[0].geometry)).toEqual(bbox);
    });
});

describe('one tile read for water and green', () => {
    it('fetches a covering tile once and serves both layers from it', async () => {
        // A z14 tile with nothing in it decodes to no layers; the point is how often it is fetched.
        const fetchImpl = vi.fn(async url => url.endsWith('/planet')
            ? { ok: true, json: async () => ({ tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] }) }
            : { ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
        const reader = createTileReader({ fetchImpl });
        const geometry = { type: 'Point', coordinates: [15.978, 45.8105] };
        const [water, green] = await Promise.all([
            createWaterProvider({ reader }).near(geometry, 100),
            createGreenProvider({ reader }).near(geometry, 100)
        ]);
        expect(water.count).toBe(0);
        expect(green.count).toBe(0);
        const tileFetches = fetchImpl.mock.calls.filter(([url]) => url.endsWith('.pbf'));
        expect(new Set(tileFetches.map(([url]) => url)).size).toBe(tileFetches.length);
        expect(tileFetches.length).toBeGreaterThan(0);
    });
});

describe('POST /decor/green', () => {
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

    it('serves green areas for a geometry and answers 502 when the tiles cannot be read', async () => {
        const server = app();
        const greenProvider = { near: vi.fn(async () => ({ areas: [{ geometry: square(0, 0, 1), kind: 'lawn' }], count: 1, source: 'openfreemap' })) };
        setupDecorRoute(server, { query: vi.fn(async () => ({ rows: [] })) }, { greenProvider, waterProvider: { near: vi.fn() } });
        const res = response();
        await server.routes['POST /decor/green']({ body: { geometry: { type: 'Point', coordinates: [15.978, 45.81] }, buffer_meters: 300 } }, res);
        expect(res.body).toMatchObject({ count: 1, source: 'openfreemap' });
        expect(greenProvider.near).toHaveBeenCalledWith({ type: 'Point', coordinates: [15.978, 45.81] }, 300);

        const failing = app();
        setupDecorRoute(failing, { query: vi.fn() }, { greenProvider: { near: async () => { throw new Error('OpenFreeMap HTTP 503'); } }, waterProvider: { near: vi.fn() } });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const bad = response();
        await failing.routes['POST /decor/green']({ body: { geometry: { type: 'Point', coordinates: [15.978, 45.81] } } }, bad);
        expect(bad.statusCode).toBe(502);
    });
});
