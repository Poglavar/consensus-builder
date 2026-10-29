// Building cells (frontend/js/building-cells.js): the cells over a view or a 3D anchor on the parcel
// grid, nearest first, and the loader that answers each cell wholly from the city's ordered sources.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cellsAround, cellsCovering, createCellLoader } = require('../../frontend/js/building-cells.js');

// A WGS84 dataset (Bogotá's parcel grid is 0.0025°): easting = lng, northing = lat.
const degrees = { toDataset: (lat, lng) => [lng, lat], toLatLng: (easting, northing) => [northing, easting] };
// A metric dataset: a local equirectangular projection around Zagreb, 100 m parcel cells.
const metric = {
    toDataset: (lat, lng) => [(lng - 15.97) * 111320 * Math.cos(45.81 * Math.PI / 180), (lat - 45.81) * 110540],
    toLatLng: (easting, northing) => [45.81 + northing / 110540, 15.97 + easting / (111320 * Math.cos(45.81 * Math.PI / 180))]
};

describe('building cells', () => {
    it('lists the cells within a radius nearest first, the anchor cell at distance 0', () => {
        const cells = cellsAround({ centre: [-74.1063, 4.6189], radiusM: 300, gridSize: 0.0025, ...degrees });
        expect(cells.length).toBeGreaterThan(4);
        expect(cells[0].distanceM).toBe(0);
        expect(cells.every((cell, i) => i === 0 || cell.distanceM >= cells[i - 1].distanceM)).toBe(true);
        expect(cells.every(cell => cell.distanceM <= 300)).toBe(true);
        expect(cells[0].key).toMatch(/^1:-29643,1847$/);
        const [w, s, e, n] = cells[0].bbox;
        expect([w <= -74.1063, e >= -74.1063, s <= 4.6189, n >= 4.6189]).toEqual([true, true, true, true]);
    });

    it('groups a fine parcel grid into building cells about 300 m wide', () => {
        const [cell] = cellsAround({ centre: [15.975, 45.812], radiusM: 50, gridSize: 100, ...metric });
        expect(cell.key.startsWith('3:')).toBe(true);
        const side = (cell.bbox[3] - cell.bbox[1]) * 110540;
        expect(side).toBeCloseTo(300, 0);
    });

    it('covers a box with every cell that touches it', () => {
        const cells = cellsCovering({ box: [-74.110, 4.615, -74.105, 4.620], gridSize: 0.0025, ...degrees });
        // -74.110..-74.105 by 4.615..4.620 is two columns and two rows of 0.0025°: its edges lie on cell lines.
        expect(cells.map(cell => cell.key).sort()).toEqual(['1:-29644,1846', '1:-29644,1847', '1:-29643,1846', '1:-29643,1847'].sort());
    });
});

describe('cell loader', () => {
    const cell = (key, distanceM) => ({ key, bbox: [0, 0, 1, 1], distanceM });

    it('asks for the nearest cells first and serves a whole answer from its cache afterwards', async () => {
        const request = vi.fn(async ({ bbox }) => ({ items: [{ id: bbox.join() }], complete: true }));
        const loader = createCellLoader({ request, concurrency: 1 });
        const order = [];
        await loader.load({ kind: 'near', sources: ['city'], cells: [cell('far', 200), cell('near', 0), cell('mid', 90)],
            onCell: c => order.push(c.key) });
        expect(order).toEqual(['near', 'mid', 'far']);
        const again = await loader.load({ kind: 'near', sources: ['city'], cells: [cell('near', 0)] });
        expect(request).toHaveBeenCalledTimes(3);
        expect(again).toMatchObject({ total: 1, loaded: 1, cached: 1 });
    });

    it('answers a cell the city source fails from the stand-in, and leaves the failed source alone for its retry time', async () => {
        let clock = 0;
        const request = vi.fn(async ({ source, bbox }) => (source === 'city' ? { unavailable: true, retryAfter: 60 }
            : { items: [{ id: `osm-${bbox.join()}` }], complete: true }));
        const loader = createCellLoader({ request, now: () => clock, concurrency: 1 });
        const results = [];
        const summary = await loader.load({ kind: 'footprints', sources: ['city', 'osm'], cells: [cell('a', 0), cell('b', 1)],
            onCell: (c, result) => results.push([c.key, result.source, result.standIn]) });
        expect(results).toEqual([['a', 'osm', true], ['b', 'osm', true]]);
        expect(request.mock.calls.map(([call]) => call.source)).toEqual(['city', 'osm', 'osm']);
        expect(summary).toMatchObject({ loaded: 2, standIn: 2, failed: 0 });
        // A stand-in cell is not cached: once the back-off is over the city source is asked again.
        clock = 61000;
        request.mockImplementation(async () => ({ items: [{ id: 'city' }], complete: true }));
        const later = [];
        await loader.load({ kind: 'footprints', sources: ['city', 'osm'], cells: [cell('a', 0)], onCell: (_c, result) => later.push(result.source) });
        expect(later).toEqual(['city']);
    });

    it('lets a stand-in fill a cell the city survey has nothing in, and keeps the city\'s empty answer when it cannot', async () => {
        const request = vi.fn(async ({ source, bbox }) => (source === 'city' ? { items: [], complete: true }
            : bbox[0] === 5 ? { items: [{ id: 'shed' }], complete: true } : { items: [], complete: true }));
        const loader = createCellLoader({ request, concurrency: 1 });
        const results = [];
        await loader.load({ kind: 'near', sources: ['city', 'osm'], cells: [{ key: 'edge', bbox: [5, 0, 6, 1], distanceM: 0 }, { key: 'park', bbox: [0, 0, 1, 1], distanceM: 1 }],
            onCell: (c, result) => results.push([c.key, result.source, result.items.length]) });
        expect(results).toEqual([['edge', 'osm', 1], ['park', 'city', 0]]);
        expect(loader.isCached('near', ['city', 'osm'], 'park')).toBe(true);
        expect(loader.isCached('near', ['city', 'osm'], 'edge')).toBe(false);
    });

    it('fails a cell our server refuses, with its status, instead of asking a stand-in', async () => {
        const request = vi.fn(async ({ source }) => { if (source === 'city') throw Object.assign(new Error('HTTP 405'), { status: 405 }); return { items: [{ id: 'osm' }], complete: true }; });
        const summary = await createCellLoader({ request }).load({ kind: 'near', sources: ['city', 'osm'], cells: [cell('a', 0)] });
        expect(summary).toMatchObject({ failed: 1, status: 405, standIn: 0 });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('reports a cell no source answers as failed, uncached, with the longest retry time', async () => {
        const request = vi.fn(async ({ source }) => ({ unavailable: true, retryAfter: source === 'city' ? 30 : 90 }));
        const loader = createCellLoader({ request });
        const summary = await loader.load({ kind: 'near', sources: ['city', 'osm'], cells: [cell('a', 0)] });
        expect(summary).toMatchObject({ total: 1, loaded: 0, failed: 1, retryAfter: 90 });
        expect(loader.isCached('near', ['city', 'osm'], 'a')).toBe(false);
    });
});
