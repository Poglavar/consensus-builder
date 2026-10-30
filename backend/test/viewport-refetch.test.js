// Panning must not re-ask for data already known: the viewport grid and answer cache shared by the
// planning and designs feeds (planning/scene.js), the per-record bounds memo of the sidebar count
// (proposals/counts.js), curated road ids keyed by repository grid cells (parcels/ground-service.js),
// the batched road registry write (road-parcels.js) and the building fetch that skips covered views
// (map-core.js, parcels/controller.js).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const scene = require('../../frontend/js/planning/scene.js');
const counts = require('../../frontend/js/proposals/counts.js');
const Cid = require('../../frontend/js/cid.js');
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');
const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('viewport cells', () => {
    it('snaps a view outward to whole cells sized to the view', () => {
        const view = [15.97500, 45.80300, 15.98260, 45.80600];
        const size = scene.viewportCellSize(view);
        expect(size).toBe(0.001);
        const snapped = scene.snapBbox(view, size);
        expect(snapped).toEqual([15.975, 45.803, 15.983, 45.806]);
        expect(scene.bboxContains(snapped, view)).toBe(true);
        // A box on the grid snaps to itself; snapping is idempotent.
        expect(scene.snapBbox(snapped, size)).toEqual(snapped);
        // A wide view gets cells a power of two of the base unit, about eight across it.
        expect(scene.viewportCellSize([15.9, 45.7, 16.1, 45.9])).toBe(0.032);
        expect(scene.snapBbox([15.9, 45.7, 16.1, 45.9])).toEqual([15.872, 45.696, 16.128, 45.92]);
        expect(scene.snapBbox([16, 45, 16, 45], 0.001)).toEqual([16, 45, 16.001, 45.001]);
        expect(() => scene.snapBbox([16, 45, null, 46])).toThrow(TypeError);
    });

    it('a small pan stays inside the snapped area of the view it left', () => {
        const view = [15.97611, 45.80381, 15.98147, 45.80519];
        const snapped = scene.snapBbox(view);
        const shift = 0.0006;
        const panned = [view[0] + shift, view[1], view[2] + shift, view[3]];
        expect(scene.bboxContains(snapped, view)).toBe(true);
        expect(scene.bboxContains(scene.snapBbox(panned), panned)).toBe(true);
    });

    it('measures area as the API does', () => {
        // 0.01 x 0.01 degrees at the equator: 1.1132 km x 1.1057 km
        expect(scene.bboxAreaKm2([0, -0.005, 0.01, 0.005])).toBeCloseTo(1.1132 * 1.1057, 4);
        expect(Number.isNaN(scene.bboxAreaKm2(null))).toBe(true);
    });
});

describe('viewport answer cache', () => {
    it('answers any view inside a stored area, and only fresh ones', async () => {
        let time = 0;
        const cache = scene.createViewportCache({ limit: 4, maxAgeMs: 1000, now: () => time });
        await cache.load('s', [0, 0, 1, 1], async () => 'whole');
        expect(cache.find('s', [0.2, 0.2, 0.8, 0.8]).value).toBe('whole');
        expect(cache.find('s', [0.5, 0.5, 1.5, 1])).toBeNull();
        expect(cache.find('other', [0.2, 0.2, 0.8, 0.8])).toBeNull();
        time = 1000;
        expect(cache.find('s', [0.2, 0.2, 0.8, 0.8])).toBeNull();
        expect(cache.size).toBe(0);
    });

    it('evicts the least recently used area beyond its limit', async () => {
        const cache = scene.createViewportCache({ limit: 2 });
        await cache.load('s', [0, 0, 1, 1], async () => 'a');
        await cache.load('s', [1, 0, 2, 1], async () => 'b');
        cache.find('s', [0, 0, 1, 1]); // a is now the most recent
        await cache.load('s', [2, 0, 3, 1], async () => 'c');
        expect(cache.find('s', [1, 0, 2, 1])).toBeNull();
        expect(cache.find('s', [0, 0, 1, 1]).value).toBe('a');
        expect(cache.find('s', [2, 0, 3, 1]).value).toBe('c');
    });

    it('shares one request per area, stores nothing on failure and cancels only unwanted requests', async () => {
        const cache = scene.createViewportCache();
        const reply = deferred();
        const loader = vi.fn(() => reply.promise);
        const first = cache.load('s', [0, 0, 1, 1], loader);
        const joined = cache.load('s', [0, 0, 1, 1], loader);
        expect(loader).toHaveBeenCalledTimes(1);
        reply.resolve('x');
        expect((await first).value).toBe('x');
        expect(await joined).toBe(await first);
        expect(cache.load('s', [0, 0, 1, 1], loader)).resolves.toMatchObject({ value: 'x' });
        expect(loader).toHaveBeenCalledTimes(1);

        await expect(cache.load('s', [5, 5, 6, 6], async () => { throw new Error('down'); })).rejects.toThrow('down');
        expect(cache.find('s', [5, 5, 6, 6])).toBeNull();

        const signals = {};
        const hold = key => signal => { signals[key] = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); };
        const kept = cache.load('s', [7, 7, 8, 8], hold('kept'));
        const dropped = cache.load('s', [9, 9, 10, 10], hold('dropped'));
        cache.abortExcept([cache.keyOf('s', [7, 7, 8, 8])]);
        await expect(dropped).rejects.toMatchObject({ name: 'AbortError' });
        expect(signals.kept.aborted).toBe(false);
        cache.clear();
        await expect(kept).rejects.toMatchObject({ name: 'AbortError' });
        expect(cache.size).toBe(0);
    });
});

describe('planning cells', () => {
    it('covers a view with whole grid cells, nearest its centre first', () => {
        const view = [15.97611, 45.80381, 15.98147, 45.80519];
        const cells = scene.viewCells(view, [45.8045, 15.9788]);
        const size = scene.PLANNING_CELL_DEGREES;
        expect(cells.length).toBe(3 * 2);
        for (const cell of cells) {
            expect(cell.bbox[2] - cell.bbox[0]).toBeCloseTo(size, 9);
            expect(scene.bboxIntersects(cell.bbox, view)).toBe(true);
        }
        expect(cells[0].distanceM).toBe(0);
        expect(cells.map(cell => cell.distanceM)).toEqual([...cells.map(cell => cell.distanceM)].sort((a, b) => a - b));
        // Every cell stays well inside the API's 0.5 km² envelope limit, at the equator too.
        expect(scene.bboxAreaKm2(scene.viewCells([-74.09, 4.61, -74.088, 4.612])[0].bbox)).toBeLessThan(0.1);
    });

    it('merges cell answers: an item over a cell line once, source counts summed', () => {
        const merged = scene.mergeAnswers([
            { envelopes: true, sources: ['s'], items: [{ id: 'a' }, { id: 'b' }], unavailable: [{ parcelId: 'p1' }], summaries: [{ sourceId: 's', withGeometry: 2, label: 'S' }], omitted: 1 },
            { envelopes: true, sources: ['s'], items: [{ id: 'b' }, { id: 'c' }], unavailable: [{ parcelId: 'p1' }, { parcelId: 'p2' }], summaries: [{ sourceId: 's', withGeometry: 3, label: 'S' }], omitted: 0 }
        ]);
        expect(merged.items.map(item => item.id)).toEqual(['a', 'b', 'c']);
        expect(merged.unavailable.map(entry => entry.parcelId)).toEqual(['p1', 'p2']);
        expect(merged.summaries).toEqual([{ sourceId: 's', withGeometry: 5, label: 'S' }]);
        expect(merged.omitted).toBe(1);
        expect(merged.envelopes).toBe(true);
        expect(scene.mergeAnswers([])).toBe(null);
    });
});

describe('load view', () => {
    const LoadView = require('../../frontend/js/load-view.js');
    it('reads a 3D camera as the 2D zoom showing the same width, around the given centre', () => {
        // The reported Bogotá camera: 267 m from its target, a 1080 px window.
        const view = LoadView.ofCamera({ targetLat: 4.62, targetLng: -74.07, range: 267 }, [4.6135, -74.0838], 1080);
        expect(view.mode).toBe('3d');
        expect(view.zoom).toBeCloseTo(18.25, 1);
        expect(view.centre).toEqual([4.6135, -74.0838]);
        expect((view.bbox[0] + view.bbox[2]) / 2).toBeCloseTo(-74.0838, 9);
        expect((view.bbox[3] - view.bbox[1]) * 110570).toBeCloseTo(534, 0);
        // Farther out the zoom falls, under the permitted layer's zoom-in line of 16 by about 1.2 km.
        expect(LoadView.ofCamera({ range: 1500 }, [4.6135, -74.0838], 1080).zoom).toBeLessThan(16);
        // Up close it still loads a street's width.
        expect((LoadView.ofCamera({ range: 5 }, [45.8, 16], 1080).bbox[3] - LoadView.ofCamera({ range: 5 }, [45.8, 16], 1080).bbox[1]) * 110570).toBeCloseTo(150, 0);
        expect(LoadView.ofCamera(null, [45.8, 16], 1080)).toBe(null);
    });
});

describe('planning view refresh', () => {
    // planning/views.js refresh() with its collaborators stubbed and the real viewport cache.
    function planningHarness({ view, zoom = 19, descriptor = { id: 'src', parcelStudy: true, capabilities: { areas: false } }, fail = () => null }) {
        const source = read('../../frontend/js/planning/views.js');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const functions = ['refresh', 'invalidate'].map(name => {
            const node = body.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === name);
            return source.slice(node.start, node.end);
        });
        const state = { selectedId: null, zoningAreas: 'off' };
        const loadViewport = vi.fn(async url => {
            const bbox = new URL(url).searchParams.get('bbox');
            const error = fail(url);
            if (error) throw error;
            return { items: [{ id: `${new URL(url).pathname}:${bbox}`, role: 'permitted' }], sources: [descriptor], summaries: [], unavailable: [], omitted: 0 };
        });
        const box = { current: view, zoom };
        const context = vm.createContext({
            URL, console: { ...console, error: vi.fn() }, Promise, Math, Array, ready: true, catalogReady: true, core: scene, request: 0, items: [], payload: null, status: 'loading', progress: null,
            viewCache: scene.createViewportCache({ limit: 2048 }), CELL_CONCURRENCY: 2, assembled: '', failedCells: 0,
            policy: () => ({ permitted: 'ghost' }), store: { get: () => state, select: vi.fn() }, selected: () => null,
            ensureSources: async () => true, sourceOptions: [descriptor], sourceId: descriptor.id, scenarioId: '', scenarioParam: () => '',
            drawMap: vi.fn(), render() {}, notifyGeometry() {}, restoreSelection() {},
            root: {
                LoadView: { current: () => ({ mode: '2d', bbox: box.current, zoom: box.zoom,
                    centre: [(box.current[1] + box.current[3]) / 2, (box.current[0] + box.current[2]) / 2] }) },
                CityConfigManager: { getCurrentCityId: () => 'zagreb' }, getBackendBase: () => 'http://api', PlanningFeed: { loadViewport }
            }
        });
        vm.runInContext(functions.join('\n'), context);
        const asked = () => loadViewport.mock.calls.map(([url]) => `${new URL(url).pathname} ${new URL(url).searchParams.get('bbox')}`);
        return { context, loadViewport, box, asked };
    }
    const cellsOf = view => scene.viewCells(view, [(view[1] + view[3]) / 2, (view[0] + view[2]) / 2]);

    it('asks for each cell of the view once, nearest its centre first; a pan asks only for new cells, a pan back for nothing', async () => {
        const view = [15.97611, 45.80381, 15.98147, 45.80519];
        const { context, box, asked } = planningHarness({ view });
        await context.refresh();
        const cells = cellsOf(view);
        // Two answers per cell: the envelopes and the source's own results.
        expect(asked().sort()).toEqual(cells.flatMap(cell => ['/planning/envelopes', '/planning/representations'].map(path => `${path} ${cell.bbox.join(',')}`)).sort());
        expect(asked()[0]).toBe(`/planning/envelopes ${cells[0].bbox.join(',')}`);
        expect(context.status).toBe('ready');
        expect(context.items).toHaveLength(cells.length * 2);

        box.current = view.map((value, index) => value + (index % 2 ? 0 : 0.003));
        const before = asked().length;
        await context.refresh();
        const fresh = cellsOf(box.current).filter(cell => !cells.some(known => known.key === cell.key));
        expect(fresh.length).toBeGreaterThan(0);
        expect(asked().length - before).toBe(fresh.length * 2);

        box.current = view;
        await context.refresh();
        expect(asked().length - before).toBe(fresh.length * 2);
        expect(context.items).toHaveLength(cells.length * 2);

        // A pan inside the same cells: same answers, nothing asked and nothing redrawn.
        box.current = view.map((value, index) => value + (index % 2 ? 0.00001 : 0.0001));
        const draws = context.drawMap.mock.calls.length;
        await context.refresh();
        expect(asked().length - before).toBe(fresh.length * 2);
        expect(context.drawMap.mock.calls.length).toBe(draws);
    });

    it('a view larger than one request allows loads every cell, drawing as they land', async () => {
        // The reported Bogotá view: 0.93 km², over the API's 0.5 km² envelope limit per request.
        const view = [-74.08870, 4.61033, -74.07900, 4.61674];
        expect(scene.bboxAreaKm2(view)).toBeGreaterThan(0.5);
        const { context, asked } = planningHarness({ view });
        await context.refresh();
        expect(asked()).toHaveLength(cellsOf(view).length * 2);
        expect(context.status).toBe('ready');
        expect(context.items).toHaveLength(cellsOf(view).length * 2);
        // The first cell, each quarter and the end each redraw.
        expect(context.drawMap.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('zoomed out past 16 asks for nothing and reads as zoom in', async () => {
        const { context, loadViewport } = planningHarness({ view: [15.96, 45.80, 15.98, 45.81], zoom: 15.5 });
        await context.refresh();
        expect(loadViewport).not.toHaveBeenCalled();
        expect(context.status).toBe('zoom');
    });

    it('a cell that fails once is asked again, alone, after the rest', async () => {
        const view = [15.97611, 45.80381, 15.98147, 45.80519];
        const broken = cellsOf(view)[1].bbox.join(',');
        let failures = 1;
        const { context, asked } = planningHarness({ view, fail: url => String(url).includes('/planning/envelopes') && new URL(url).searchParams.get('bbox') === broken && failures-- > 0
            ? Object.assign(new Error('HTTP 503'), { status: 503 }) : null });
        await context.refresh();
        expect(context.status).toBe('ready');
        expect(context.failedCells).toBe(0);
        expect(asked().at(-1)).toBe(`/planning/envelopes ${broken}`);
        expect(asked().filter(entry => entry === `/planning/envelopes ${broken}`)).toHaveLength(2);
        expect(context.items).toHaveLength(cellsOf(view).length * 2);
    });

    it('a cell that fails twice leaves the others drawn, and asking again reads only that cell', async () => {
        const view = [15.97611, 45.80381, 15.98147, 45.80519];
        const broken = cellsOf(view)[1].bbox.join(',');
        let failing = true;
        const { context, asked } = planningHarness({ view, fail: url => failing && String(url).includes('/planning/envelopes') && new URL(url).searchParams.get('bbox') === broken
            ? Object.assign(new Error('HTTP 502'), { status: 502 }) : null });
        await context.refresh();
        expect(context.status).toBe('ready');
        expect(context.failedCells).toBe(1);
        expect(context.items).toHaveLength(cellsOf(view).length * 2 - 1);
        failing = false;
        const before = asked().length;
        context.assembled = '';
        await context.refresh();
        expect(asked().slice(before)).toEqual([`/planning/envelopes ${broken}`]);
        expect(context.failedCells).toBe(0);
        expect(context.items).toHaveLength(cellsOf(view).length * 2);
    });

    it('a source refusing every cell reads as zoom in', async () => {
        const { context } = planningHarness({ view: [15.97611, 45.80381, 15.98147, 45.80519],
            fail: () => Object.assign(new Error('HTTP 400'), { status: 400 }) });
        await context.refresh();
        expect(context.status).toBe('zoom');
        expect(context.items).toEqual([]);
    });
});

describe('local proposal bounds memo', () => {
    it('walks a record once until it changes', () => {
        let reads = 0;
        const geometry = { type: 'Polygon', coordinates: [[[16, 45.8], [16.01, 45.8], [16.01, 45.81], [16, 45.8]]] };
        const record = { id: 'p-1', updatedAt: '2026-10-01', get geometry() { reads += 1; return geometry; } };
        const view = { west: 15.99, south: 45.79, east: 16.02, north: 45.82 };
        expect(counts.proposalIntersectsBounds(record, view)).toBe(true);
        expect(counts.proposalIntersectsBounds(record, { west: 17, south: 45, east: 18, north: 46 })).toBe(false);
        expect(reads).toBe(1);
        expect(counts.proposalBounds(record)).toEqual([16, 45.8, 16.01, 45.81]);
        expect(reads).toBe(1);
        record.updatedAt = '2026-10-02';
        counts.proposalBounds(record);
        expect(reads).toBe(2);
        // A different record object under the same id is measured anew.
        const copy = { id: 'p-1', updatedAt: '2026-10-02', geometry: { type: 'Point', coordinates: [17, 46] } };
        expect(counts.proposalBounds(copy)).toEqual([17, 46, 17, 46]);
        expect(counts.proposalBounds({ id: 'empty' })).toBeNull();
    });
});

describe('explore designs by area', () => {
    const site = (lon, lat) => ({ type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.0002, lat], [lon + 0.0002, lat + 0.0002], [lon, lat]]] });
    const row = (n, lon, lat) => ({ cid: Cid.cidOfObject({ schema: 'design/v1', n }), title: `Design ${n}`, goal: 'park', city: 'zagreb',
        createdAt: '2026-10-21T10:00:00.000Z', binding: { parcels: [] }, content: { site: site(lon, lat) } });
    function designs({ rows, area }) {
        const cache = { proposals: [], count: null, loading: false, error: null, lastCity: null, lastFetchedAt: 0, countRefreshedAt: 0 };
        const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ designs: rows }) }));
        const context = vm.createContext({
            document: {}, console: { log() {}, info() {}, warn() {}, error() {} }, URLSearchParams, Cid, AbortController,
            serverProposalCache: cache, SERVER_PROPOSAL_SUMMARY_LIMIT: 250, PlanningScene: scene, __proposalCounts: counts,
            normalizeCityCodeForApi: city => city, resolveBackendBaseUrl: () => 'http://backend',
            getProposalCountAreaContext: () => area(), renderProposalListModal() {}, updateShowProposalsButton() {}, fetch
        });
        context.window = context;
        vm.runInContext(read('../../frontend/js/proposals/design-sync.js'), context);
        return { context, cache, fetch };
    }
    const explore = bbox => ({ explore: true, city: null, bbox, key: `explore:${bbox.join(',')}` });

    it('filters a stored area answer to each view instead of asking again', async () => {
        // Snaps to [15.976, 45.803, 15.983, 45.805]; the next view lies inside that.
        let area = explore([15.976, 45.8031, 15.9829, 45.8049]);
        const { context, cache, fetch } = designs({ area: () => area, rows: [row(1, 15.9765, 45.8035), row(2, 15.9815, 45.8045)] });
        await context.refreshServerProposalCount();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(cache.count).toBe(2);
        area = explore([15.980, 45.8031, 15.9829, 45.8049]);
        await context.refreshServerProposalCount();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(cache.proposals.map(entry => entry.title)).toEqual(['Design 2']);
        area = explore([15.976, 45.8031, 15.979, 45.8049]);
        await context.refreshServerProposalCount();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(cache.proposals.map(entry => entry.title)).toEqual(['Design 1']);
    });

    it('asks for the exact view when the area answer was cut short by the list size', async () => {
        const area = explore([15.976, 45.803, 15.979, 45.805]);
        const full = Array.from({ length: 250 }, (_, n) => row(n, 15.9765, 45.8035));
        const { context, fetch } = designs({ area: () => area, rows: full });
        await context.refreshServerProposalCount();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][0]).toBe('http://backend/designs?limit=250&bbox=15.976%2C45.803%2C15.979%2C45.805');
    });
});

describe('curated road ids by grid cell', () => {
    // A 0.01-degree grid in plain lon/lat, standing in for the city's dataset grid.
    const size = 0.01;
    const boundsKeysOf = bounds => {
        const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
        const keys = [];
        for (let e = Math.floor(sw.lng / size + 1e-9); e <= Math.floor(ne.lng / size - 1e-9); e += 1) {
            for (let n = Math.floor(sw.lat / size + 1e-9); n <= Math.floor(ne.lat / size - 1e-9); n += 1) keys.push(`${e},${n}`);
        }
        return keys;
    };
    const cellBoundsOf = key => { const [e, n] = key.split(',').map(Number); return [e * size, n * size, (e + 1) * size, (n + 1) * size]; };
    function repository(fetchRoadIds) {
        return createCadastralParcelRepository({
            root: { CityConfigManager: { getCurrentCityId: () => 'zagreb' } },
            transport: { supportsRoadIds: () => true, fetchRoadIds },
            convertFeatures: collection => collection, onFeatures: async () => {}, boundsKeysOf, cellBoundsOf
        });
    }

    it('asks only for cells not yet classified, as one request', async () => {
        const fetchRoadIds = vi.fn(async box => ({ status: 'ready', ids: [`road@${box.map(v => v.toFixed(2)).join(',')}`] }));
        const ground = repository(fetchRoadIds);
        const first = await ground.ensureRoadIds([15.975, 45.805, 15.985, 45.808]);
        expect(fetchRoadIds).toHaveBeenCalledTimes(1);
        expect(fetchRoadIds.mock.calls[0][0].map(v => Number(v.toFixed(4)))).toEqual([15.97, 45.8, 15.99, 45.81]);
        expect(first).toMatchObject({ requestCount: 1, cached: false });

        const inside = await ground.ensureRoadIds([15.976, 45.806, 15.984, 45.807]);
        expect(inside).toMatchObject({ requestCount: 0, cached: true, ids: first.ids });

        await ground.ensureRoadIds([15.985, 45.805, 15.995, 45.808]);
        expect(fetchRoadIds).toHaveBeenCalledTimes(2);
        expect(fetchRoadIds.mock.calls[1][0].map(v => Number(v.toFixed(4)))).toEqual([15.99, 45.8, 16, 45.81]);
        const both = await ground.ensureRoadIds([15.975, 45.805, 15.995, 45.808]);
        expect(both.requestCount).toBe(0);
        expect(both.ids).toHaveLength(2);
    });

    it('joins a request in flight for the same cells', async () => {
        const reply = deferred();
        const fetchRoadIds = vi.fn(() => reply.promise);
        const ground = repository(fetchRoadIds);
        const first = ground.ensureRoadIds([15.975, 45.805, 15.979, 45.808]);
        const second = ground.ensureRoadIds([15.976, 45.806, 15.978, 45.807]);
        reply.resolve({ status: 'ready', ids: ['HR-1'] });
        expect((await first).ids).toEqual(['HR-1']);
        expect(await second).toMatchObject({ ids: ['HR-1'], requestCount: 0 });
        expect(fetchRoadIds).toHaveBeenCalledTimes(1);
    });

    it('does not record cells whose request failed', async () => {
        const fetchRoadIds = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ status: 'ready', ids: ['HR-2'] });
        const ground = repository(fetchRoadIds);
        await expect(ground.ensureRoadIds([15.975, 45.805, 15.979, 45.808])).rejects.toThrow('down');
        expect((await ground.ensureRoadIds([15.975, 45.805, 15.979, 45.808])).ids).toEqual(['HR-2']);
    });
});

describe('road registry writes', () => {
    function registry() {
        const writes = [], removes = [];
        const context = { console, PersistentStorage: { getItem: () => null, setItem: (key, value) => writes.push(JSON.parse(value)), removeItem: key => removes.push(key) },
            addEventListener() {} };
        context.window = context;
        vm.createContext(context);
        vm.runInContext(read('../../frontend/js/road-parcels.js'), context);
        return { context, writes, removes };
    }

    it('writes once per settled batch of marks, with every mark in it', async () => {
        const { context, writes } = registry();
        ['a', 'b', 'c'].forEach(id => context.addRoadParcel(id));
        expect(context.isRoadParcel('b')).toBe(true);
        expect(writes).toEqual([]);
        await Promise.resolve();
        expect(writes).toEqual([['a', 'b', 'c']]);
        context.removeRoadParcel('a');
        context.addRoadParcel('d');
        await Promise.resolve();
        expect(writes).toEqual([['a', 'b', 'c'], ['b', 'c', 'd']]);
    });

    it('a clear is not undone by a write still queued', async () => {
        const { context, writes, removes } = registry();
        context.addRoadParcel('a');
        context.clearAllRoadParcels();
        await Promise.resolve();
        expect(writes).toEqual([]);
        expect(removes).toEqual(['roadParcels']);
        expect(context.getRoadParcelCount()).toBe(0);
    });
});

describe('building fetch on pan', () => {
    const mapCoreSource = read('../../frontend/js/map-core.js');
    const declaration = name => {
        const node = parse(mapCoreSource, { sourceType: 'script' }).program.body.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === name);
        return mapCoreSource.slice(node.start, node.end);
    };
    function harness() {
        const handlers = new Map(), timers = new Map();
        let timerId = 0;
        const fetchBuildings = vi.fn();
        const context = vm.createContext({
            window: { __mapModeState: { desired: '2d', pending: false }, addEventListener() {}, isThreeModeActive: () => false },
            map: { on: (name, listener) => handlers.set(name, listener), getBounds: () => ({ view: true }) },
            isMapMoving: false, buildingFollowTimer: null, parcelFetchConfig: { getDebounce: () => 10 },
            document: { getElementById: id => (id === 'showBuildings' ? { checked: true } : null) },
            fetchBuildings, fetchOutlineBuildings: () => {},
            setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
            clearTimeout: id => timers.delete(id)
        });
        vm.runInContext(`${declaration('isTwoDimensionalViewportActive')}\n${declaration('setupMapEventHandlers')}\nsetupMapEventHandlers();`, context);
        handlers.get('movestart')();
        handlers.get('moveend')();
        [...timers.values()].forEach(callback => callback());
        return fetchBuildings;
    }

    // A covered view needs no test of its own: its cells answer from the cell loader's cache.
    it('asks for the view once per pan', () => {
        expect(harness()).toHaveBeenCalledTimes(1);
    });

    it('leaves buildings to map-core: the parcel controller schedules no building fetch', () => {
        const timers = [];
        const global = {
            __mapModeState: { desired: '2d', pending: false }, isThreeModeActive: () => false,
            fetchBuildings: vi.fn(), fetchParcelData: vi.fn(async () => {}), updateVisibleParcelsCount() {},
            CityConfigManager: { hasParcelData: () => true },
            document: { getElementById: () => ({ checked: true }) },
            setTimeout: callback => timers.push(callback), clearTimeout() {}
        };
        const context = vm.createContext({ window: global, document: global.document, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout });
        vm.runInContext(read('../../frontend/js/parcels/controller.js'), context);
        global.ParcelFetchController.handleMoveEnd({ _loaded: true, getBounds: () => ({}) }, { isZoomWithinParcelRange: () => true });
        timers.forEach(callback => callback());
        expect(global.fetchParcelData).toHaveBeenCalledTimes(1);
        expect(global.fetchBuildings).not.toHaveBeenCalled();
    });
});
