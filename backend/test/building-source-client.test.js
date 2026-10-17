// Where the browser's building requests go (frontend/js/building-source-client.js): a city on
// Overture's tiles is answered in the browser in the endpoints' own shapes, other sources go to the
// backend, and a server source with `fallback: 'overture-tiles'` (Bogotá's cadastre) falls back to
// the tiles when it fails or finds nothing. Which city's source that is follows where the request
// lies (getCityConfigAt), and no city is sent (location-first.md).

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const client = require('../../frontend/js/building-source-client.js');
const OvertureTiles = require('../../frontend/js/overture-tiles.js');
const FootprintProvider = require('../../frontend/js/footprint-provider.js');

const box = (x, y, d = 0.0001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const building = (id, x, y, props = {}) => ({ type: 'Feature', id, geometry: box(x, y), properties: { measured_height_m: null, levels: null, building: null, ...props } });

// A page: the city config, a backend reached through fetch, and the tile source replaced by a stub.
function page({ buildings, server = null, tileFeatures = [], configAt = null }) {
    const calls = { server: [], tiles: 0 };
    const global = {
        turf,
        FootprintProvider,
        OvertureTiles: {
            ...OvertureTiles,
            createOvertureTilesSource: () => ({ featuresIn: async () => { calls.tiles += 1; return { features: tileFeatures }; } })
        },
        pmtiles: { PMTiles: function () {} },
        getBackendBase: () => 'http://backend.test',
        CityConfigManager: {
            getCurrentCityConfig: () => ({ buildings }),
            ...(configAt ? { getCityConfigAt: (lat, lon) => ({ buildings: configAt(lat, lon) }) } : {})
        },
        fetch: async (url, init) => {
            calls.server.push({ url, body: JSON.parse(init.body) });
            if (typeof server === 'function') return server(url);
            return { ok: true, status: 200, json: async () => server };
        }
    };
    return { global, calls };
}

beforeEach(() => client._reset());

describe('building source client', () => {
    it('routes by the city source', () => {
        expect(client.routeFor({ source: 'overture-tiles' })).toBe('local');
        expect(client.routeFor({ source: 'cadastre', sourceId: 'building.x', fallback: 'overture-tiles' })).toBe('server-then-local');
        expect(client.routeFor({ source: 'gdi' })).toBe('server');
        expect(client.routeFor({ source: 'overture' })).toBe('server');
        // A person's own source replaces the tiles.
        expect(client.routeFor({ source: 'overture-tiles', sourceId: 'building.mine' })).toBe('server');
    });

    it('answers a city on Overture tiles in the browser, in the endpoints\' shapes', async () => {
        const { global, calls } = page({ buildings: { source: 'overture-tiles' }, tileFeatures: [
            building('w1', 10, 10, { measured_height_m: 30 }),
            building('gers-2', 10.0002, 10, { levels: 4 })
        ] });
        const near = await client.request('/buildings/near', { geometry: box(10, 10), buffer_meters: 100 }, { global });
        expect(near).toMatchObject({ count: 2, source: 'overture-tiles-3d', heights: { measured: 1, levels: 1, estimated: 0 } });
        expect(near.buildings.map(b => [b.object_id, b.z_max])).toEqual([['w1', 30], ['gers-2', 12]]);

        const footprints = await client.request('/buildings/footprints', { geometry: box(9.9999, 9.9999, 0.001) }, { global });
        expect(footprints).toMatchObject({ supported: true, count: 2, source: 'overture-tiles-footprints', truncated: false });
        expect(footprints.footprints[0]).toMatchObject({ id: 'w1', height_m: 30, floors: null });

        const under = await client.request('/buildings/under', { regions: [
            { key: 'a', geometry: box(10, 10, 0.00005) }, { key: 'b', geometry: box(11, 11) }
        ] }, { global });
        expect(under).toMatchObject({ supported: true, truncated: true }); // regions a degree apart: too wide for one read
        const close = await client.request('/buildings/under', { regions: [
            { key: 'a', geometry: box(10, 10, 0.00005) }, { key: 'b', geometry: box(10.001, 10.001) }
        ] }, { global });
        expect(close.truncated).toBe(false);
        expect(close.regions.a.map(f => f.id)).toEqual(['w1']);
        expect(close.regions.b).toEqual([]);
        expect(calls.server).toHaveLength(0);
    });

    it('sends every other source to the backend without the city a caller still names', async () => {
        const answer = { buildings: [{ object_id: 'z1' }], count: 1, source: 'zagreb-3d' };
        const { global, calls } = page({ buildings: { source: 'gdi' }, server: answer });
        const body = { geometry: box(15.97, 45.8), buffer_meters: 300, city: 'zagreb' };
        expect(await client.request('/buildings/near', body, { global })).toEqual(answer);
        expect(calls.server).toEqual([{ url: 'http://backend.test/buildings/near', body: { geometry: box(15.97, 45.8), buffer_meters: 300 } }]);
        expect(calls.tiles).toBe(0);
    });

    it("follows the request's place, not the session's city", async () => {
        // The session booted on Overture tiles; the request lies where a city with its own survey applies.
        const answer = { buildings: [{ object_id: 'z1' }], count: 1, source: 'zagreb-3d' };
        const seen = [];
        const configAt = (lat, lon) => { seen.push([lat, lon]); return lat > 40 ? { source: 'cadastre', sourceId: 'building.there' } : { source: 'overture-tiles' }; };
        const { global, calls } = page({ buildings: { source: 'overture-tiles' }, server: answer, configAt, tileFeatures: [building('w1', 10, 10)] });
        expect(await client.request('/buildings/near', { geometry: box(15.97, 45.8) }, { global })).toEqual(answer);
        expect(calls.server[0].body.source).toBe('building.there');
        expect(seen[0][0]).toBeCloseTo(45.80005, 6);
        // and back on the tiles where the place says so
        const near = await client.request('/buildings/near', { geometry: box(10, 10) }, { global });
        expect(near.source).toBe('overture-tiles-3d');
        expect(calls.server).toHaveLength(1);
        // a demolition scan is placed by its first region
        await client.request('/buildings/under', { regions: [{ key: 'a', geometry: box(15.97, 45.8) }] }, { global });
        expect(calls.server).toHaveLength(2);
    });

    it('fails loudly when the backend errors and there is no fallback', async () => {
        const { global } = page({ buildings: { source: 'gdi' }, server: () => ({ ok: false, status: 502, json: async () => ({}) }) });
        await expect(client.request('/buildings/near', { geometry: box(0, 0) }, { global })).rejects.toThrow(/502/);
    });

    describe('a server source with Overture behind it (Bogotá)', () => {
        const buildings = { source: 'cadastre', sourceId: 'building.bogota', fallback: 'overture-tiles' };
        const tileFeatures = [building('gers-9', 10, 10)];

        it('uses the server answer when it has buildings', async () => {
            const answer = { buildings: [{ object_id: 'CUSTOM-B-1' }], count: 1, source: 'custom-3d' };
            const { global, calls } = page({ buildings, server: answer, tileFeatures });
            expect(await client.request('/buildings/near', { geometry: box(10, 10), source: 'building.bogota' }, { global })).toEqual(answer);
            expect(calls.server[0].body.source).toBe('building.bogota');
            expect(calls.tiles).toBe(0);
        });

        it('reads the tiles when the server source is unavailable, errors or has nothing there', async () => {
            for (const server of [
                { buildings: [], count: 0, source: 'custom-3d', unavailable: true, retryAfter: 30 },
                () => ({ ok: false, status: 500, json: async () => ({}) }),
                { buildings: [], count: 0, source: 'custom-3d' }
            ]) {
                client._reset();
                const { global, calls } = page({ buildings, server, tileFeatures });
                const near = await client.request('/buildings/near', { geometry: box(10, 10) }, { global });
                expect(near).toMatchObject({ count: 1, source: 'overture-tiles-3d' });
                expect(calls.tiles).toBe(1);
            }
        });

        it('keeps an empty demolition scan from the server: empty regions mean "scanned, nothing there"', async () => {
            const answer = { supported: true, regions: { a: [] }, truncated: false, source: 'custom-footprints' };
            const { global, calls } = page({ buildings, server: answer, tileFeatures });
            expect(await client.request('/buildings/under', { regions: [{ key: 'a', geometry: box(10, 10) }] }, { global })).toEqual(answer);
            expect(calls.tiles).toBe(0);
        });

        it('does not swallow an aborted request', async () => {
            const { global } = page({ buildings, server: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
            await expect(client.request('/buildings/near', { geometry: box(10, 10) }, { global })).rejects.toThrow('aborted');
        });
    });
});
