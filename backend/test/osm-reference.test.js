// Unit tests for the pure parts of the OSM buildings reference layer: the Overpass `out geom;`
// element → GeoJSON conversion, the height tag reading, and the bbox query builder. No network.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { overpassElementsToGeoJSON, buildOverpassQuery, osmHeightMeters, osmCellsForBbox } = require('../buildings/osm-reference.js');

// A square way (open — first != last) with a building tag, as Overpass returns it with `out geom;`.
const wayEl = (id, tags = { building: 'yes' }) => ({
    type: 'way',
    id,
    tags,
    geometry: [
        { lat: 45.80, lon: 15.90 },
        { lat: 45.80, lon: 15.91 },
        { lat: 45.81, lon: 15.91 },
        { lat: 45.81, lon: 15.90 }
    ]
});

describe('overpassElementsToGeoJSON', () => {
    it('turns a building way into a closed Polygon feature keyed by OSM id', () => {
        const fc = overpassElementsToGeoJSON([wayEl(123)]);
        expect(fc.features).toHaveLength(1);
        const f = fc.features[0];
        expect(f.id).toBe('w123');
        expect(f.geometry.type).toBe('Polygon');
        const ring = f.geometry.coordinates[0];
        // GeoJSON is [lon, lat], and the ring is closed (first === last).
        expect(ring[0]).toEqual([15.90, 45.80]);
        expect(ring[ring.length - 1]).toEqual(ring[0]);
        expect(ring).toHaveLength(5);
    });

    it('builds a MultiPolygon from a relation\'s OUTER members and ignores inner courtyards', () => {
        const rel = {
            type: 'relation',
            id: 7,
            tags: { building: 'yes', type: 'multipolygon' },
            members: [
                { type: 'way', role: 'outer', geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }] },
                { type: 'way', role: 'inner', geometry: [{ lat: 0.2, lon: 0.2 }, { lat: 0.2, lon: 0.3 }, { lat: 0.3, lon: 0.3 }] }
            ]
        };
        const fc = overpassElementsToGeoJSON([rel]);
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].id).toBe('r7');
        expect(fc.features[0].geometry.type).toBe('MultiPolygon');
        expect(fc.features[0].geometry.coordinates).toHaveLength(1); // only the outer ring
    });

    it('skips non-building elements and degenerate rings', () => {
        const notBuilding = { type: 'way', id: 1, tags: { highway: 'residential' }, geometry: wayEl(1).geometry };
        const twoPoint = { type: 'way', id: 2, tags: { building: 'yes' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] };
        const fc = overpassElementsToGeoJSON([notBuilding, twoPoint]);
        expect(fc.features).toHaveLength(0);
    });

    it('caps the feature count and flags truncation', () => {
        const many = Array.from({ length: 5 }, (_, i) => wayEl(i));
        const fc = overpassElementsToGeoJSON(many, 3);
        expect(fc.features).toHaveLength(3);
        expect(fc.truncated).toBe(true);
    });

    it('passes through a mapped height, else null', () => {
        const withHeight = overpassElementsToGeoJSON([wayEl(1, { building: 'yes', height: '12.5' })]);
        expect(withHeight.features[0].properties.height_m).toBeCloseTo(12.5, 6);
        const plain = overpassElementsToGeoJSON([wayEl(2)]);
        expect(plain.features[0].properties.height_m).toBeNull();
    });
});

describe('osmHeightMeters', () => {
    it('prefers an explicit height tag in metres', () => {
        expect(osmHeightMeters({ height: '9' })).toBe(9);
    });
    it('falls back to building:levels at ~3 m per storey', () => {
        expect(osmHeightMeters({ 'building:levels': '4' })).toBe(12);
    });
    it('is null when nothing usable is tagged', () => {
        expect(osmHeightMeters({ building: 'yes' })).toBeNull();
        expect(osmHeightMeters(null)).toBeNull();
    });
});

describe('buildOverpassQuery', () => {
    it('orders the bbox as Overpass wants (south,west,north,east)', () => {
        // Input bbox is [minLon, minLat, maxLon, maxLat] = [W, S, E, N].
        const q = buildOverpassQuery([15.90, 45.80, 15.91, 45.81]);
        expect(q).toContain('(45.8,15.9,45.81,15.91)');
        expect(q).toContain('way["building"]');
        expect(q).toContain('relation["building"]');
    });
});

// The grid is what makes the cache a cache: keying on the raw viewport minted a new key for every
// few metres of pan, so all but the first request went to Overpass and it answered with 429/504.
describe('osmCellsForBbox', () => {
    it('snaps to the grid, so a small pan lands on the SAME cell', () => {
        const a = osmCellsForBbox([15.9741, 45.8028, 15.9774, 45.8045], 0.005);
        const b = osmCellsForBbox([15.9743, 45.8030, 15.9776, 45.8047], 0.005);
        expect(a.map(cell => cell.key)).toEqual(b.map(cell => cell.key));
    });

    it('covers a viewport that straddles a boundary with every cell it touches', () => {
        const cells = osmCellsForBbox([15.9990, 45.7990, 16.0010, 45.8010], 0.005);
        expect(cells.length).toBe(4);
        cells.forEach(cell => {
            const [w, s, e, n] = cell.bbox;
            expect(e - w).toBeCloseTo(0.005, 9);
            expect(n - s).toBeCloseTo(0.005, 9);
        });
        // The cell keys are exact — float noise in a key is a permanent cache miss.
        expect(new Set(cells.map(cell => cell.key)).size).toBe(4);
        expect(cells.some(cell => cell.key === '15.995,45.795')).toBe(true);
    });

    it('always returns at least the cell a degenerate-thin box sits in', () => {
        const cells = osmCellsForBbox([15.9741, 45.8028, 15.9742, 45.8029], 0.005);
        expect(cells.length).toBe(1);
        expect(cells[0].bbox[0]).toBeLessThanOrEqual(15.9741);
        expect(cells[0].bbox[2]).toBeGreaterThanOrEqual(15.9742);
    });
});

describe('cold cells share one Overpass request', () => {
    it('fetches every missing cell of a bbox in one request and caches each cell', async () => {
        const { createOverpassCellSource, buildOverpassQuery, overpassElementsToGeoJSON } = await import('../buildings/osm-reference.js');
        const way = (id, lon, lat) => ({ type: 'way', id, tags: { building: 'yes' }, geometry: [
            { lon, lat }, { lon: lon + 0.0001, lat }, { lon: lon + 0.0001, lat: lat + 0.0001 }, { lon, lat: lat + 0.0001 }
        ] });
        const calls = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            calls.push(decodeURIComponent(String(init.body)));
            return { ok: true, json: async () => ({ elements: [way(1, 30.0012, 10.0012), way(2, 30.0112, 10.0062)] }) };
        };
        try {
            const source = createOverpassCellSource({ label: 'test', buildQuery: buildOverpassQuery, convert: overpassElementsToGeoJSON });
            const bbox = [30.0, 10.0, 30.0149, 10.0099]; // 3 × 2 cells of 0.005°
            const first = await source(bbox);
            expect(calls).toHaveLength(1);
            expect(first.features.map(f => f.id).sort()).toEqual(['w1', 'w2']);
            expect(first.partial).toBe(false);
            const again = await source([30.011, 10.006, 30.0149, 10.0099]);
            expect(calls).toHaveLength(1);
            expect(again.features.map(f => f.id)).toEqual(['w2']);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe('each Overpass endpoint has its own throttle and cache', () => {
    it('keeps a mirror answering while the default backs off, and never serves its answers to the default', async () => {
        const { createOverpassCellSource, buildOverpassQuery, overpassElementsToGeoJSON } = await import('../buildings/osm-reference.js');
        const way = (id, lon, lat) => ({ type: 'way', id, tags: { building: 'yes' }, geometry: [
            { lon, lat }, { lon: lon + 0.0001, lat }, { lon: lon + 0.0001, lat: lat + 0.0001 }, { lon, lat: lat + 0.0001 }
        ] });
        const mirror = 'https://mirror.example/api/interpreter';
        const calls = [];
        const realFetch = globalThis.fetch;
        // The default endpoint throttles; the mirror answers.
        globalThis.fetch = async url => {
            calls.push(String(url));
            return { ok: false, status: 429, text: async () => 'rate limited' };
        };
        const mirrorFetch = async url => {
            calls.push(String(url));
            return { ok: true, json: async () => ({ elements: [way(9, 40.0012, 20.0012)] }) };
        };
        try {
            const source = createOverpassCellSource({ label: 'test', buildQuery: buildOverpassQuery, convert: overpassElementsToGeoJSON });
            const bbox = [40.0, 20.0, 40.004, 20.004];
            await expect(source(bbox)).rejects.toMatchObject({ status: 503 });
            const fromMirror = await source(bbox, { overpassUrl: mirror, fetchImpl: mirrorFetch });
            expect(fromMirror.features.map(f => f.id)).toEqual(['w9']);
            // The default is still cooling off and holds nothing: the mirror's cell is not its cell.
            const before = calls.length;
            const error = await source(bbox).catch(e => e);
            expect(error.status).toBe(503);
            expect(error.retryAfter).toBeGreaterThan(0);
            expect(calls.length).toBe(before);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe('a failed combined request', () => {
    it('is not retried cell by cell, so a dead server fails once and fast', async () => {
        const { createOverpassCellSource, buildOverpassQuery, overpassElementsToGeoJSON } = await import('../buildings/osm-reference.js');
        let calls = 0;
        const dead = async () => { calls += 1; throw new Error('Public source request aborted or timed out.'); };
        const source = createOverpassCellSource({ label: 'test', buildQuery: buildOverpassQuery, convert: overpassElementsToGeoJSON });
        const bbox = [50.0, 30.0, 50.0149, 30.0099]; // 3 × 2 cells
        await expect(source(bbox, { overpassUrl: 'https://dead.example/api/interpreter', fetchImpl: dead })).rejects.toThrow();
        expect(calls).toBe(1);
    });
});

describe('our endpoint chain: Tracestrack first, the public server after', () => {
    const way = (id, lon, lat) => ({ type: 'way', id, tags: { building: 'yes' }, geometry: [
        { lon, lat }, { lon: lon + 0.0001, lat }, { lon: lon + 0.0001, lat: lat + 0.0001 }, { lon, lat: lat + 0.0001 }
    ] });
    async function withChain(key, publicUrl, fetchFn, run) {
        const saved = { key: process.env.TRACESTRACK_API_KEY, url: process.env.OVERPASS_URL, fetch: globalThis.fetch };
        const logs = [];
        const spies = ['log', 'warn', 'error'].map(level => vi.spyOn(console, level).mockImplementation((...args) => logs.push(args.join(' '))));
        process.env.TRACESTRACK_API_KEY = key;
        process.env.OVERPASS_URL = publicUrl;
        globalThis.fetch = fetchFn;
        try { return await run(logs); } finally {
            spies.forEach(spy => spy.mockRestore());
            globalThis.fetch = saved.fetch;
            if (saved.key === undefined) delete process.env.TRACESTRACK_API_KEY; else process.env.TRACESTRACK_API_KEY = saved.key;
            if (saved.url === undefined) delete process.env.OVERPASS_URL; else process.env.OVERPASS_URL = saved.url;
        }
    }

    it('asks Tracestrack first, with the Referer its dashboard checks', async () => {
        const { createOverpassCellSource, buildOverpassQuery, overpassElementsToGeoJSON } = await import('../buildings/osm-reference.js');
        const calls = [];
        await withChain('aaaa1111bbbb2222cccc3333', 'https://public-a.example/api/interpreter', async (url, init) => {
            calls.push({ url: String(url), referer: init.headers.Referer });
            return { ok: true, json: async () => ({ elements: [way(3, 60.0012, 40.0012)] }) };
        }, async () => {
            const source = createOverpassCellSource({ label: 'test', buildQuery: buildOverpassQuery, convert: overpassElementsToGeoJSON });
            const fc = await source([60.0, 40.0, 60.004, 40.004]);
            expect(fc.features.map(f => f.id)).toEqual(['w3']);
        });
        expect(calls).toEqual([{ url: 'https://api.tracestrack.com/overpass/aaaa1111bbbb2222cccc3333/interpreter', referer: 'https://urbangametheory.xyz/' }]);
    });

    it('falls through to the public server when Tracestrack refuses, stops asking it, and never prints the key', async () => {
        const { createOverpassCellSource, buildOverpassQuery, overpassElementsToGeoJSON } = await import('../buildings/osm-reference.js');
        const key = 'dddd4444eeee5555ffff6666';
        const calls = [];
        await withChain(key, 'https://public-b.example/api/interpreter', async url => {
            calls.push(new URL(String(url)).hostname);
            return String(url).includes('tracestrack')
                ? { ok: false, status: 403, text: async () => 'Referrer mismatch.' }
                : { ok: true, json: async () => ({ elements: [way(4, 61.0012, 41.0012)] }) };
        }, async logs => {
            const source = createOverpassCellSource({ label: 'test', buildQuery: buildOverpassQuery, convert: overpassElementsToGeoJSON });
            expect((await source([61.0, 41.0, 61.004, 41.004])).features.map(f => f.id)).toEqual(['w4']);
            await source([61.1, 41.1, 61.104, 41.104]);
            expect(logs.join('\n')).not.toContain(key);
        });
        // The refusal sends the first request on to the public server; the next one skips Tracestrack.
        expect(calls).toEqual(['api.tracestrack.com', 'public-b.example', 'public-b.example']);
    });

    it('reports when to try again once every endpoint is backing off, without the key in the error', async () => {
        const { createOverpassCellSource, buildOverpassQuery, overpassElementsToGeoJSON } = await import('../buildings/osm-reference.js');
        const key = 'gggg7777hhhh8888iiii9999';
        await withChain(key, 'https://public-c.example/api/interpreter', async () => ({ ok: false, status: 429, text: async () => 'slow down' }), async () => {
            const source = createOverpassCellSource({ label: 'test', buildQuery: buildOverpassQuery, convert: overpassElementsToGeoJSON });
            const error = await source([62.0, 42.0, 62.004, 42.004]).catch(e => e);
            expect(error.status).toBe(503);
            expect(error.retryAfter).toBeGreaterThan(0);
            expect(String(error.message)).not.toContain(key);
        });
    });
});
