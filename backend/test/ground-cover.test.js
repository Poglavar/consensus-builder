// The ground under the 3D model view: the server's land-cover grid (backend/decor/ground-cover.js:
// ESA tile names, the cell grid, OpenStreetMap overrides, the colour samples, caching and the route)
// and the renderer's pure part (frontend/js/three-ground-cover.js: how a look is coloured from its
// sample, and the texture bytes a payload becomes).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mapTiles, colourTiles, gridFor, createGroundCoverProvider, LOOKS, MAX_CELLS } from '../decor/ground-cover.js';
import { setupDecorRoute } from '../routes/decor.js';

const require = createRequire(import.meta.url);
const Cover = require('../../frontend/js/three-ground-cover.js');

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const LOOK = Object.fromEntries(LOOKS.map((name, id) => [name, id]));

describe('ESA tiles and the cell grid', () => {
    it('names the 3° map tiles and 1° colour tiles by their south-west corner, both hemispheres', () => {
        expect(mapTiles([77.07, 43.785, 77.11, 43.81]).map(t => t.url.split('/').pop()))
            .toEqual(['ESA_WorldCover_10m_2021_v200_N42E075_Map.tif']);
        expect(colourTiles([77.07, 43.785, 77.11, 43.81]).map(t => t.url.split('/').slice(-2).join('/')))
            .toEqual(['N43/ESA_WorldCover_10m_2021_v200_N43E077_S2RGBNIR.tif']);
        // Bogotá: south of 6° N and west of Greenwich.
        expect(mapTiles([-74.1, 4.6, -74.05, 4.65])[0].url).toMatch(/_N03W075_Map\.tif$/);
        expect(colourTiles([-74.1, -0.2, -74.05, 0.1]).map(t => t.url.split('/').pop()))
            .toEqual(['ESA_WorldCover_10m_2021_v200_S01W075_S2RGBNIR.tif', 'ESA_WorldCover_10m_2021_v200_N00W075_S2RGBNIR.tif']);
    });

    it('lays about 20 m cells, never more than the cap', () => {
        const grid = gridFor([16, 45.8, 16.026, 45.818]);
        expect(grid.cols).toBeGreaterThan(95);
        expect(grid.cols).toBeLessThan(110);
        expect(grid.rows).toBeGreaterThan(95);
        const huge = gridFor([16, 45, 16.5, 45.5]);
        expect([huge.cols, huge.rows]).toEqual([MAX_CELLS, MAX_CELLS]);
    });
});

// A GeoTIFF stand-in: answers every window with `value(band, col, row)` over the window's cells.
function fakeTiff(value) {
    return {
        readRasters: vi.fn(async ({ width, height, samples }) => samples.map(band => {
            const out = new Uint16Array(width * height);
            for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) out[r * width + c] = value(band, c, r, width, height);
            return out;
        }))
    };
}

describe('the ground cover provider', () => {
    // West half grassland (30), east half built-up (50); the colour composite is dry steppe in the
    // west half (red 1600, NIR 2200) and lush in the east (red 600, NIR 3000).
    const area = box(77.08, 43.79, 77.1, 43.8);
    function provider({ landcover = [], missing = false } = {}) {
        const open = vi.fn(async url => {
            if (missing) throw new Error('Error fetching data.');
            if (url.endsWith('_Map.tif')) return fakeTiff((band, c, r, width) => (c < width / 2 ? 30 : 50));
            return fakeTiff((band, c, r, width) => [c < width / 2 ? 1600 : 600, 1300, 900, c < width / 2 ? 2200 : 3000][band]);
        });
        const reader = { features: vi.fn(async () => ({ tiles: 1, features: landcover })) };
        const fetchImpl = vi.fn(async () => ({ status: missing === 'outage' ? 503 : 404 }));
        return { open, reader, cover: createGroundCoverProvider({ open, reader, fetchImpl }) };
    }
    const decode = result => Array.from(Buffer.from(result.looks, 'base64'));

    it('reads one look per cell, a median colour and vegetation index per look, and caches the answer', async () => {
        const { open, reader, cover } = provider();
        const result = await cover.near(area, 0);
        const looks = decode(result);
        expect(looks).toHaveLength(result.cols * result.rows);
        expect(looks[0]).toBe(LOOK.grass);
        expect(looks[result.cols - 1]).toBe(LOOK.built);
        expect(result.counts.grass + result.counts.built).toBe(looks.length);
        // Grass sits in the dry west half; built-up ground keeps the renderer's pavement, so no sample.
        expect(result.palette.grass.ndvi).toBeCloseTo((2200 - 1600) / (2200 + 1600), 2);
        expect(result.palette.grass.rgb[0]).toBe(Math.round(255 * 1600 / 2600));
        expect(result.palette).not.toHaveProperty('built');
        expect(result.attribution).toMatch(/CC BY 4\.0/);
        expect(open).toHaveBeenCalledTimes(2);

        expect(await cover.near(area, 0)).toBe(result);
        expect(open).toHaveBeenCalledTimes(2);
        expect(reader.features).toHaveBeenCalledTimes(1);
    });

    it('lets OpenStreetMap sand or rock decide the cells it covers', async () => {
        const sand = { type: 'Feature', properties: { class: 'sand' }, geometry: box(77.0, 43.79, 77.085, 43.81) };
        const wood = { type: 'Feature', properties: { class: 'wood' }, geometry: box(77.0, 43.79, 77.11, 43.81) };
        const { cover } = provider({ landcover: [sand, wood] });
        const result = await cover.near(area, 0);
        const looks = decode(result);
        expect(looks[0]).toBe(LOOK.sand);
        expect(looks[Math.floor(result.cols / 2) - 1]).toBe(LOOK.grass);
        expect(looks).not.toContain(LOOK.forest); // a wood is the green layer's, not the cover's
    });

    it('leaves the open sea (no tile) without a look, and fails on an outage so it is asked again', async () => {
        const { cover } = provider({ missing: true });
        const result = await cover.near(area, 0);
        expect(new Set(decode(result))).toEqual(new Set([LOOK.none]));
        expect(result.palette).toEqual({});
        const down = provider({ missing: 'outage' });
        await expect(down.cover.near(area, 0)).rejects.toThrow(/fetching/);
        await expect(down.cover.near(area, 0)).rejects.toThrow(/fetching/);
        expect(down.open.mock.calls.length).toBeGreaterThan(2);
    });
});

describe('GET /decor/ground', () => {
    function app() {
        const routes = {};
        return { routes, get: (path, handler) => { routes['GET ' + path] = handler; }, post: () => {} };
    }
    const response = () => {
        const res = { statusCode: 200 };
        res.status = code => { res.statusCode = code; return res; };
        res.json = body => { res.body = body; return res; };
        return res;
    };

    it('answers the cover for the area and 502 when it cannot be read', async () => {
        const server = app();
        const groundProvider = { near: vi.fn(async () => ({ cols: 1, rows: 1, looks: 'AQ==' })) };
        setupDecorRoute(server, { query: vi.fn() }, { groundProvider, waterProvider: { near: vi.fn() }, greenProvider: { near: vi.fn() } });
        const res = response();
        await server.routes['GET /decor/ground']({ query: { bbox: '77.08,43.79,77.1,43.8', buffer_meters: '1000' } }, res);
        expect(res.body).toMatchObject({ cols: 1, looks: 'AQ==' });
        expect(groundProvider.near).toHaveBeenCalledWith(box(77.08, 43.79, 77.1, 43.8), 1000);

        const failing = app();
        setupDecorRoute(failing, { query: vi.fn() }, { groundProvider: { near: async () => { throw new Error('timed out'); } },
            waterProvider: { near: vi.fn() }, greenProvider: { near: vi.fn() } });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const bad = response();
        await failing.routes['GET /decor/ground']({ query: { bbox: '77.08,43.79,77.1,43.8' } }, bad);
        expect(bad.statusCode).toBe(502);
    });
});

describe('the renderer: colours and texture bytes', () => {
    it('keeps a dry place in its sampled colour and turns a lush one its own green', () => {
        const dry = Cover.lookColor('grass', { rgb: [161, 133, 100], ndvi: 0.25, samples: 400 });
        expect(dry).toEqual([161, 133, 100]);
        const lush = Cover.lookColor('grass', { rgb: [79, 89, 60], ndvi: 0.65, samples: 400 });
        expect(lush).toEqual(Cover.COLORS.grass);
        expect(Cover.lookColor('grass', undefined)).toEqual(Cover.COLORS.grass);
        // A beach in a park reads green from coarse colour cells: sand keeps its own colour then.
        expect(Cover.lookColor('sand', { rgb: [74, 91, 66], ndvi: 0.46, samples: 400 })).toEqual(Cover.COLORS.sand);
        expect(Cover.lookColor('sand', { rgb: [181, 144, 108], ndvi: 0.2, samples: 400 })).toEqual([181, 144, 108]);
        expect(Cover.lookColor('built', { rgb: [1, 2, 3], ndvi: 0.1, samples: 400 })).toEqual(Cover.COLORS.built);
    });

    it('turns a payload into weights and colours with the south row first, and the mean beyond it', () => {
        // Two rows, north = built-up, south = sand.
        const payload = {
            bbox: [0, 0, 1, 1], cols: 2, rows: 2, lookNames: LOOKS,
            looks: Buffer.from([LOOK.built, LOOK.built, LOOK.sand, LOOK.sand]).toString('base64'),
            palette: { sand: { rgb: [200, 180, 140], ndvi: 0.1, samples: 50 } }
        };
        const data = Cover.coverData(payload);
        // Texture row 0 is the south: sand, painted in its sample, no paving.
        expect(Array.from(data.tint.slice(0, 4))).toEqual([200, 180, 140, 0]);
        expect(Array.from(data.mix.slice(0, 4))).toEqual(Cover.PATTERNS.sand.slice(0, 4).map(v => Math.round(v * 255)));
        // The north row is paved, in the pavement colour.
        expect(Array.from(data.tint.slice(8, 12))).toEqual([...Cover.COLORS.built, 255]);
        expect(data.fallback.mix[4]).toBeCloseTo(0.5, 6);
        expect(data.fallback.color).toEqual([200, 180, 140].map((value, i) => Math.round((value + Cover.COLORS.built[i]) / 2)));
        expect(Cover.coverData({ ...payload, looks: 'AA==' })).toBeNull();
    });
});
