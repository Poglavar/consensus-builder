// Check bounded map geometry, feature projection and cancellation without a browser or network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeArea, tilePlan, toPixel, prepareSample, geographic } from '../../frontend/js/parcels/estimate/area.mjs';
import { runWorker } from '../../frontend/js/parcels/estimate/runtime.mjs';
import { compute, DEFAULTS } from '../../frontend/js/parcels/estimate/core.mjs';
import { vectorize } from '../../frontend/js/parcels/estimate/geometry.mjs';

afterEach(() => vi.unstubAllGlobals());
describe('map parcel estimates', () => {
    it('keeps all allowed area sizes bounded and tile crops aligned in both hemispheres', () => {
        for (const lat of [-79, -26, 0, 27, 79]) for (const size of [128, 256, 512]) {
            const area = makeArea({ lat, lng: 32 }, size), tiles = tilePlan(area);
            expect(area.bbox[2] - area.bbox[0]).toBeCloseTo(size, 6);
            expect(area.bbox[3] - area.bbox[1]).toBeCloseTo(size, 6);
            expect(toPixel(area.center, area)[0]).toBeCloseTo(256, 6);
            expect(toPixel(area.center, area)[1]).toBeCloseTo(256, 6);
            expect(tiles.length).toBeLessThanOrEqual(9);
            expect(Math.min(...tiles.map(tile => tile.dx))).toBeLessThanOrEqual(0);
            expect(Math.max(...tiles.map(tile => tile.dx + tile.size))).toBeGreaterThanOrEqual(512);
        }
        expect(() => makeArea({ lat: 81, lng: 0 })).toThrow('area');
        expect(() => makeArea({ lat: 0, lng: 179.9999 }, 512)).toThrow('area');
        expect(() => makeArea({ lat: 0, lng: 0 }, 100000)).toThrow('area');
    });
    it('projects road, building and water evidence into the exact image grid', () => {
        const area = makeArea({ lat: 27, lng: 85 });
        const [w, s, e, n] = area.bounds;
        const ring = [[w,s],[e,s],[e,n],[w,n],[w,s]];
        const sample = prepareSample(area, { features: [
            { id: 'r1', properties: { kind: 'water' }, geometry: { type: 'Polygon', coordinates: [ring] } },
            { id: 'w2', properties: { kind: 'road', bridge: false, width_m: 5 }, geometry: { type: 'LineString', coordinates: [[w,s],[e,n]] } }
        ] }, 'abc123', 'def456');
        expect(sample.features.water[0].rings[0][0][0]).toBeCloseTo(0, 6);
        expect(sample.features.water[0].rings[0][0][1]).toBeCloseTo(512, 6);
        expect(sample.features.roads[0]).toMatchObject({ id: 'w2', width_m: 5, bridge: false });
        expect(() => prepareSample(area, { features: [], partial: true }, 'a', 'b')).toThrow('context');
    });
    it('exports the displayed rectangles in WGS84 with estimated identity and reproducible metric frame', () => {
        const area = makeArea({ lat: -26, lng: 32 }, 128);
        const sample = prepareSample(area, { features: [] }, 'abc123', 'def456');
        // A small test grid has the same square metric extent.
        const rgba = new Uint8ClampedArray(32 * 32 * 4).fill(128);
        const result = compute({ sample, rgba, width: 32, height: 32, settings: DEFAULTS });
        const collection = vectorize(result, sample, DEFAULTS, {}, {
            toWgs84: point => geographic(point.map(value => value / area.scale))
        });
        expect(collection.features.length).toBeGreaterThan(0);
        for (const feature of collection.features) {
            expect(feature.geometry.coordinates[0]).toHaveLength(5);
            expect(feature.properties).toMatchObject({ estimated: true, accuracy: 'unvalidated', shape: 'rectangle' });
            for (const [lon, lat] of feature.geometry.coordinates[0]) {
                expect(lon).toBeGreaterThanOrEqual(area.bounds[0] - 1e-10);
                expect(lon).toBeLessThanOrEqual(area.bounds[2] + 1e-10);
                expect(lat).toBeGreaterThanOrEqual(area.bounds[1] - 1e-10);
                expect(lat).toBeLessThanOrEqual(area.bounds[3] + 1e-10);
            }
        }
        expect(collection.demo.raster.mercator_scale).toBe(area.scale);
        expect(collection.demo.source_image.hash_format).toBe('RGBA8 512x512');
        expect(collection.demo.source_image.tiles.length).toBeLessThanOrEqual(9);
        const elsewhere = prepareSample(makeArea({ lat: -26, lng: 33 }, 128), { features: [] }, 'abc123', 'def456');
        expect(elsewhere.id).not.toBe(sample.id);
    });
    it('terminates processing immediately on cancel and cannot deliver a late success', async () => {
        let worker;
        vi.stubGlobal('Worker', class {
            constructor() { worker = this; }
            terminate = vi.fn();
            postMessage = vi.fn();
        });
        const controller = new AbortController();
        const job = runWorker({ rgba: new Uint8ClampedArray(4) }, controller.signal);
        controller.abort();
        await expect(job).rejects.toMatchObject({ name: 'AbortError' });
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.postMessage).toHaveBeenCalledOnce();
    });
});
