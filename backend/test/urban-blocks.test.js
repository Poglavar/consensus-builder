// Headless contract tests for parcel-independent OSM block detection, its viewport controller, and
// the read-only road source/route. Geometry stays outside the map UI so topology and metrics are
// fast to verify without starting a browser or database.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as turfModule from '@turf/turf';
import { setupUrbanBlocksRoutes } from '../routes/urban-blocks.js';
import { blockRoadsToGeoJSON, buildBlockRoadQuery, fetchBlockRoads } from '../streets/block-roads.js';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const model = require('../../frontend/js/urban-blocks-model.js');
const controller = require('../../frontend/js/urban-blocks-controller.js');
const bbox = [-0.01, -0.01, 0.02, 0.02];
const way = (id, coords, tags = {}) => ({ type: 'Feature', id, properties: { highway: 'residential', ...tags }, geometry: { type: 'LineString', coordinates: coords } });
const fc = (...features) => turf.featureCollection(features);
const squareRoads = () => fc(
    way('a', [[0, 0], [0.01, 0]]), way('b', [[0.01, 0], [0.01, 0.01]]),
    way('c', [[0.01, 0.01], [0, 0.01]]), way('d', [[0, 0.01], [0, 0]])
);

afterEach(() => vi.useRealTimers());

describe('OSM block geometry model', () => {
    it('measures a square face and estimates a perimeter walk at 5 km/h', () => {
        const blocks = model.detectBlocks(squareRoads(), bbox, turf);
        expect(blocks.features).toHaveLength(1);
        const block = blocks.features[0];
        expect(block.properties.areaM2).toBeGreaterThan(1_200_000);
        expect(block.properties.areaM2).toBeLessThan(1_300_000);
        expect(block.properties.perimeterM).toBeGreaterThan(4_400);
        expect(block.properties.walkMinutes).toBeCloseTo(block.properties.perimeterM / (5000 / 60), 8);
    });

    it('nodes crossings and T junctions into the correct bounded faces', () => {
        const roads = fc(
            way('bottom', [[0, 0], [0.01, 0]]), way('right', [[0.01, 0], [0.01, 0.01]]),
            way('top', [[0.01, 0.01], [0, 0.01]]), way('left', [[0, 0.01], [0, 0]]),
            way('cross', [[0, 0.005], [0.01, 0.005]]),
            way('t', [[0.005, 0.005], [0.005, 0.01]])
        );
        const blocks = model.detectBlocks(roads, bbox, turf);
        // The T stem splits the upper half in two; the lower half remains one face.
        expect(blocks.features).toHaveLength(3);
        const lowerArea = blocks.features.filter(f => turf.centerOfMass(f).geometry.coordinates[1] < 0.005)
            .reduce((sum, f) => sum + f.properties.areaM2, 0);
        const upperArea = blocks.features.filter(f => turf.centerOfMass(f).geometry.coordinates[1] > 0.005)
            .reduce((sum, f) => sum + f.properties.areaM2, 0);
        expect(lowerArea).toBeCloseTo(upperArea, -2);
        expect(blocks.features.every(f => f.properties.areaM2 > 20)).toBe(true);
    });

    it('splits a fully crossed square into four faces', () => {
        const roads = fc(
            way('bottom', [[0, 0], [0.01, 0]]), way('right', [[0.01, 0], [0.01, 0.01]]),
            way('top', [[0.01, 0.01], [0, 0.01]]), way('left', [[0, 0.01], [0, 0]]),
            way('horizontal', [[0, 0.005], [0.01, 0.005]]),
            way('vertical', [[0.005, 0], [0.005, 0.01]])
        );
        expect(model.detectBlocks(roads, bbox, turf).features).toHaveLength(4);
    });

    it('deduplicates duplicate and overlapping roads without changing IDs or face count', () => {
        const original = squareRoads();
        const duplicate = fc(...original.features, way('duplicate', [[0, 0], [0.01, 0]]), way('overlap', [[0.002, 0], [0.008, 0]]));
        const a = model.detectBlocks(original, bbox, turf).features;
        const b = model.detectBlocks(duplicate, bbox, turf).features;
        expect(b).toHaveLength(a.length);
        expect(b.map(x => x.id)).toEqual(a.map(x => x.id));
    });

    it('does not close dangling roads or paint faces touching the request edge', () => {
        const dangling = fc(way('dangle', [[0.001, 0.001], [0.009, 0.001]]));
        expect(model.detectBlocks(dangling, bbox, turf).features).toHaveLength(0);
        const edgeSquare = fc(way('a', [[bbox[0], 0], [0.01, 0]]), way('b', [[0.01, 0], [0.01, 0.01]]),
            way('c', [[0.01, 0.01], [bbox[0], 0.01]]), way('d', [[bbox[0], 0.01], [bbox[0], 0]]));
        expect(model.detectBlocks(edgeSquare, bbox, turf).features).toHaveLength(0);
    });

    it('represents nested loops as disjoint shell-and-hole polygons', () => {
        const outer = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]];
        const inner = [[0.003, 0.003], [0.007, 0.003], [0.007, 0.007], [0.003, 0.007], [0.003, 0.003]];
        const blocks = model.detectBlocks(fc(way('outer', outer), way('inner', inner)), bbox, turf);
        expect(blocks.features).toHaveLength(2);
        expect(blocks.features.reduce((sum, f) => sum + turf.area(f), 0)).toBeCloseTo(turf.area(turf.polygon([outer])), -1);
        expect(blocks.features.some(f => f.geometry.coordinates.length === 2)).toBe(true);
    });

    it('does not node grade-separated bridge and tunnel roads into ground crossings', () => {
        const roads = fc(
            way('a', [[0, 0], [0.01, 0]]), way('b', [[0.01, 0], [0.01, 0.01]]),
            way('c', [[0.01, 0.01], [0, 0.01]]), way('d', [[0, 0.01], [0, 0]]),
            way('bridge', [[0.005, -0.001], [0.005, 0.011]], { bridge: 'yes', layer: 1 }),
            way('tunnel', [[-0.001, 0.005], [0.011, 0.005]], { tunnel: 'yes', layer: -1 })
        );
        const blocks = model.detectBlocks(roads, bbox, turf);
        expect(blocks.features).toHaveLength(1);
        expect(blocks.features[0].properties.areaM2).toBeGreaterThan(1_200_000);
    });

    it('uses order-independent IDs and counts loaded parcels only when supplied', () => {
        const roads = squareRoads();
        const a = model.detectBlocks(roads, bbox, turf).features[0];
        const b = model.detectBlocks(fc(...roads.features.slice().reverse()), bbox, turf).features[0];
        expect(b.id).toBe(a.id);
        const parcel = { type: 'Feature', id: 'p1', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0.002, 0.002], [0.004, 0.002], [0.004, 0.004], [0.002, 0.004], [0.002, 0.002]]] } };
        expect(model.loadedParcelCount(a, null, turf)).toBeNull();
        expect(model.loadedParcelCount(a, [parcel, { ...parcel }], turf)).toBe(1);
    });

    it('assigns different fill colors to adjacent blocks', () => {
        const roads = fc(
            way('bottom', [[0, 0], [0.02, 0]]), way('right', [[0.02, 0], [0.02, 0.02]]),
            way('top', [[0.02, 0.02], [0, 0.02]]), way('left', [[0, 0.02], [0, 0]]),
            way('divider', [[0.01, 0], [0.01, 0.02]]),
            way('lower-left', [[-0.02, -0.02], [0.03, -0.02]]),
            way('lower-right', [[0.03, -0.02], [0.03, 0.03]]),
            way('upper-right', [[0.03, 0.03], [-0.02, 0.03]]),
            way('upper-left', [[-0.02, 0.03], [-0.02, -0.02]])
        );
        const blocks = model.detectBlocks(roads, [-0.03, -0.03, 0.04, 0.04], turf).features;
        expect(blocks).toHaveLength(4);
        const adjacentLeft = blocks.find(block => turf.centerOfMass(block).geometry.coordinates[0] < 0.01);
        const adjacentRight = blocks.find(block => turf.centerOfMass(block).geometry.coordinates[0] > 0.01);
        expect(adjacentLeft.properties.color).not.toBe(adjacentRight.properties.color);
    });

    it('refuses incomplete road inputs', () => {
        expect(() => model.detectBlocks({ ...squareRoads(), truncated: true }, bbox, turf)).toThrow(/incomplete/i);
        expect(() => model.detectBlocks({ ...squareRoads(), partial: true }, bbox, turf)).toThrow(/incomplete/i);
    });
});

describe('urban block view controller', () => {
    const viewport = { bbox: [0, 0, 0.01, 0.01], zoom: 16 };

    it('stays off, reports zoom state, then caches ready coverage', async () => {
        const fetchRoads = vi.fn(async () => ({ features: [] }));
        const detect = vi.fn(async () => ({ type: 'FeatureCollection', features: [] }));
        const view = controller.create({ fetchRoads, detect, onChange: vi.fn() });
        await view.refresh(viewport);
        expect(fetchRoads).not.toHaveBeenCalled();
        view.setEnabled(true);
        await view.refresh({ ...viewport, zoom: 14 });
        expect(view.snapshot().phase).toBe('zoom');
        await view.refresh(viewport);
        expect(view.snapshot().phase).toBe('ready');
        await view.refresh(viewport);
        expect(fetchRoads).toHaveBeenCalledTimes(1);
        await view.refresh(viewport, true);
        expect(fetchRoads).toHaveBeenCalledTimes(2);
    });

    it('retains ready roads and clears them on reload, disable, and city reset', async () => {
        const retainedRoads = fc(way('ready-road', [[0, 0], [0.01, 0]]));
        let resolveReload;
        const fetchRoads = vi.fn()
            .mockResolvedValueOnce(retainedRoads)
            .mockImplementationOnce(() => new Promise(resolve => { resolveReload = resolve; }))
            .mockResolvedValueOnce(fc());
        const detect = vi.fn(async () => ({ type: 'FeatureCollection', features: [] }));
        const view = controller.create({ fetchRoads, detect, onChange: vi.fn() });
        view.setEnabled(true);

        await view.refresh(viewport);
        expect(view.snapshot()).toMatchObject({ phase: 'ready', roads: retainedRoads });
        await view.refresh(viewport);
        expect(fetchRoads).toHaveBeenCalledTimes(1);

        const reload = view.refresh(viewport, true);
        const reloadSignal = fetchRoads.mock.calls[1][1];
        expect(view.snapshot()).toMatchObject({ phase: 'roads', roads: null, blocks: null });

        // The view's cityChanged handler resets through setEnabled while the checkbox stays on.
        view.setEnabled(true);
        expect(reloadSignal.aborted).toBe(true);
        expect(view.snapshot()).toMatchObject({ phase: 'idle', roads: null });
        resolveReload(fc(way('stale-road', [[0, 0], [0.01, 0]])));
        await reload;
        expect(view.snapshot()).toMatchObject({ phase: 'idle', roads: null });
        expect(detect).toHaveBeenCalledTimes(1);

        await view.refresh(viewport);
        expect(view.snapshot()).toMatchObject({ phase: 'ready', roads: { features: [] } });
        view.setEnabled(false);
        expect(view.snapshot()).toMatchObject({ phase: 'off', roads: null });
        expect(fetchRoads).toHaveBeenCalledTimes(3);
        expect(detect).toHaveBeenCalledTimes(2);
    });

    it('surfaces load and detection errors and allows retry', async () => {
        const fetchRoads = vi.fn().mockRejectedValueOnce(new Error('Overpass timeout')).mockResolvedValue({ features: [] });
        const view = controller.create({ fetchRoads, detect: async () => 'blocks', onChange: vi.fn() });
        view.setEnabled(true);
        await view.refresh(viewport);
        expect(view.snapshot()).toMatchObject({ phase: 'error', error: 'Overpass timeout' });
        await view.refresh(viewport);
        expect(view.snapshot()).toMatchObject({ phase: 'ready', blocks: 'blocks' });
    });

    it('aborts on a newer viewport and ignores stale road and worker results', async () => {
        const roadResolvers = [];
        const workerResolvers = [];
        const fetchRoads = vi.fn(() => new Promise(resolve => roadResolvers.push(resolve)));
        const detect = vi.fn(() => new Promise(resolve => workerResolvers.push(resolve)));
        const view = controller.create({ fetchRoads, detect, onChange: vi.fn() });
        view.setEnabled(true);
        const firstViewport = viewport;
        const secondViewport = { bbox: [0.002, 0.002, 0.012, 0.012], zoom: 16 };
        const first = view.refresh(firstViewport);
        const firstSignal = fetchRoads.mock.calls[0][1];
        const second = view.refresh(secondViewport);
        expect(firstSignal.aborted).toBe(true);
        roadResolvers[0]({ features: [] });
        roadResolvers[1]({ features: [] });
        await Promise.resolve();
        expect(detect).toHaveBeenCalledTimes(1);
        const secondSignal = detect.mock.calls[0][2];
        const thirdViewport = { bbox: [0.003, 0.003, 0.013, 0.013], zoom: 16 };
        const third = view.refresh(thirdViewport);
        expect(secondSignal.aborted).toBe(true);
        workerResolvers[0]('stale worker output');
        roadResolvers[2]({ features: [] });
        await Promise.resolve();
        workerResolvers[1]('current blocks');
        await Promise.all([first, second, third]);
        expect(view.snapshot()).toMatchObject({ enabled: true, phase: 'ready', blocks: 'current blocks', coverage: expect.any(Array) });
    });

    it('rejects partial and truncated road responses and computes padded bounds only at supported zoom', async () => {
        expect(controller.requestBounds({ ...viewport, zoom: 14 })).toBeNull();
        const bounds = controller.requestBounds(viewport);
        expect(bounds[0]).toBeLessThan(viewport.bbox[0]);
        expect(bounds[2]).toBeGreaterThan(viewport.bbox[2]);
        for (const roads of [{ features: [], partial: true }, { features: [], truncated: true }]) {
            const view = controller.create({ fetchRoads: async () => roads, detect: vi.fn(), onChange: vi.fn() });
            view.setEnabled(true);
            await view.refresh(viewport);
            expect(view.snapshot().phase).toBe('error');
            expect(view.snapshot().error).toMatch(/incomplete/i);
        }
    });
});

describe('block road source and HTTP route', () => {
    it('builds a broad highway Overpass query and filters malformed ways', () => {
        const query = buildBlockRoadQuery([1, 2, 3, 4]);
        expect(query).toContain('way["highway"');
        expect(query).toContain('(2,1,4,3)');
        const roads = blockRoadsToGeoJSON([
            { type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [{ lon: 1, lat: 2 }, { lon: 2, lat: 3 }] },
            { type: 'way', id: 2, tags: { highway: 'footway' }, geometry: [{ lon: 1, lat: 2 }, { lon: 2, lat: 3 }] },
            { type: 'way', id: 3, tags: { highway: 'service' }, geometry: [{ lon: 1, lat: 2 }, { lon: NaN, lat: 3 }] }
        ]);
        expect(roads.features).toHaveLength(1);
        expect(roads.features[0].id).toBe('w1');
    });

    it('marks caps as truncated and treats Overpass timeout remarks as incomplete', () => {
        const ways = [1, 2].map(id => ({ type: 'way', id, tags: { highway: 'residential' }, geometry: [{ lon: 1, lat: 2 }, { lon: 2, lat: 3 }] }));
        expect(blockRoadsToGeoJSON(ways, 1).truncated).toBe(true);
        expect(() => blockRoadsToGeoJSON(ways, 10, { remark: 'runtime error: Query timed out' })).toThrow(/incomplete/i);
    });

    it('validates the request bbox and passes through upstream timeout errors', async () => {
        await expect(fetchBlockRoads([0, 0, 1, 1])).rejects.toMatchObject({ status: 400 });
        await expect(fetchBlockRoads([0, 0, 0.01, 0.01], { source: async () => { throw Object.assign(new Error('timeout'), { status: 503, retryAfter: 7 }); } }))
            .rejects.toMatchObject({ status: 503, retryAfter: 7 });
    });

    it('returns validation errors and preserves partial/truncated and retry metadata at the route', async () => {
        const routes = {};
        const app = { get: (path, handler) => { routes[path] = handler; } };
        setupUrbanBlocksRoutes(app, { fetchRoads: vi.fn(async bboxValue => {
            if (bboxValue[0] < 0) throw Object.assign(new Error('bad bbox'), { status: 400 });
            if (bboxValue[0] > 1) throw Object.assign(new Error('busy'), { status: 503, retryAfter: 9 });
            return { type: 'FeatureCollection', features: [], partial: true, truncated: false, source: 'overpass' };
        }) });
        const invoke = async (bboxValue) => {
            const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, set(k, v) { this.headers[k] = v; return this; }, json(body) { this.body = body; return this; } };
            await routes['/blocks/roads']({ query: { bbox: bboxValue } }, res);
            return res;
        };
        expect((await invoke('0,0,0.01,0.01')).body).toMatchObject({ partial: true, truncated: false });
        expect((await invoke('-1,0,0.01,0.01')).statusCode).toBe(400);
        const busy = await invoke('2,0,2.01,0.01');
        expect(busy).toMatchObject({ statusCode: 503, headers: { 'Retry-After': '9' }, body: { retryAfter: 9 } });
    });
});

describe('worldwide layer entry and click ownership', () => {
    it('keeps the Layers control visible in the explore city', () => {
        const css = readFileSync(new URL('../../frontend/css/world.css', import.meta.url), 'utf8');
        const exploreRules = [...css.matchAll(/body\.explore-city[^\{]*\{[^}]*\}/g)].map(match => match[0]);
        expect(exploreRules.join('\n')).not.toMatch(/#layers-button\s*\{[^}]*display\s*:\s*none/s);
        expect(css).toMatch(/Layers stays available for worldwide OSM urban blocks/);
    });

    it('suppresses automatic parcel fallback while block view is active, but preserves explicit recovery', () => {
        const source = readFileSync(new URL('../../frontend/js/parcels/ground-fallback.js', import.meta.url), 'utf8');
        const run = ({ enabled, explicit }) => {
            let dialogCalls = 0;
            const sentinel = new Error('dialog DOM must not be constructed');
            const window = {
                UrbanBlocksView: { isEnabled: () => enabled },
                CityConfigManager: { getCurrentCityId: () => 'test-city', getCityLabel: id => id, getAvailableCities: () => [] },
                sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
                document: { getElementById: () => null, createElement: () => { dialogCalls++; throw sentinel; } },
                setTimeout
            };
            window.document.defaultView = window;
            const document = window.document;
            const context = vm.createContext({ window, document, module: { exports: {} }, console, CustomEvent: function () {}, setTimeout });
            vm.runInContext(source, context, { filename: 'ground-fallback.js' });
            try {
                const fallback = context.module.exports;
                if (explicit) fallback.openOptions({ city: 'test-city' });
                else fallback.onGroundUnavailable({ city: 'test-city', error: new Error('network') });
            } catch (error) {
                if (error !== sentinel) throw error;
            }
            return dialogCalls;
        };
        expect(run({ enabled: true, explicit: false })).toBe(0);
        expect(run({ enabled: true, explicit: true })).toBe(1);
        expect(run({ enabled: false, explicit: false })).toBe(1);
    });

    it('blocks parcel selection exactly while the urban block view owns clicks', () => {
        const lockSource = readFileSync(new URL('../../frontend/js/map-edit-lock.js', import.meta.url), 'utf8');
        const evaluate = ownsClicks => {
            const window = { UrbanBlocksView: { ownsClicks: () => ownsClicks } };
            const context = vm.createContext({ window, module: { exports: {} }, console });
            vm.runInContext(lockSource, context, { filename: 'map-edit-lock.js' });
            return context.module.exports.blocksSelection();
        };
        expect(evaluate(true)).toBe(true);
        expect(evaluate(false)).toBe(false);
    });
});
