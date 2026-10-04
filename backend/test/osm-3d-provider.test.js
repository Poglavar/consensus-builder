// The default 3D building provider (buildings/osm-3d.js) and its place in the registry: any city
// without its own source, explore included, gets OSM footprints extruded with their height source
// recorded, the staged copy wins over live Overpass, and an Overpass outage yields an empty scene
// marked partial rather than an error.

import { describe, it, expect } from 'vitest';
import { createOsmProvider, expandBbox } from '../buildings/osm-3d.js';
import { createBuildingProviders } from '../buildings/index.js';

const box = (x, y, d = 0.0001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const building = (id, x, y, props = {}) => ({ type: 'Feature', id, geometry: box(x, y), properties: { osm_id: id, ...props } });
const live = features => async () => ({ type: 'FeatureCollection', features, truncated: false, partial: false });
const noStaged = async () => null;

describe('OSM 3D provider', () => {
    it('extrudes every footprint and records where each height came from', async () => {
        const provider = createOsmProvider(null, 'lima', { fetchStaged: noStaged, fetchLive: live([
            building('w1', 10, 10, { measured_height_m: 30 }),
            building('w2', 10.0002, 10, { levels: 4 }),
            building('w3', 10.0004, 10, { building: 'house' })
        ]) });
        const result = await provider.near(box(10, 10), 300);
        expect(result.source).toBe('osm-3d');
        expect(result.count).toBe(3);
        expect(result.heights).toEqual({ measured: 1, levels: 1, estimated: 1 });
        const byId = Object.fromEntries(result.buildings.map(b => [b.object_id, b]));
        expect(byId.w1.z_max).toBe(30);
        expect(byId.w2.z_max).toBe(12);
        expect(byId.w3.height_source).toBe('estimated');
        expect(byId.w3.z_max).toBeGreaterThan(0);
    });

    it('prefers the staged copy over live Overpass', async () => {
        let liveCalls = 0;
        const provider = createOsmProvider({}, 'split', {
            fetchStaged: async () => ({ type: 'FeatureCollection', features: [building('w7', 16.44, 43.5)], truncated: false }),
            fetchLive: async () => { liveCalls++; return { features: [] }; }
        });
        const result = await provider.near(box(16.44, 43.5), 100);
        expect(result.count).toBe(1);
        expect(liveCalls).toBe(0);
    });

    it('answers an empty, partial scene when Overpass is throttling', async () => {
        const provider = createOsmProvider(null, 'explore', { fetchStaged: noStaged, fetchLive: async () => {
            const error = new Error('Overpass is rate-limiting us'); error.status = 503; throw error;
        } });
        expect(await provider.near(box(0, 0), 300)).toMatchObject({ buildings: [], count: 0, partial: true });
        expect(await provider.footprints(box(0, 0, 0.01))).toMatchObject({ footprints: [], truncated: true });
    });

    it('says the upstream is unavailable, and for how long, instead of answering an empty city', async () => {
        const provider = createOsmProvider(null, 'explore', { fetchStaged: noStaged, fetchLive: async () => {
            const error = new Error('Overpass is rate-limiting us'); error.status = 503; error.retryAfter = 42.2; throw error;
        } });
        expect(await provider.near(box(0, 0), 300)).toMatchObject({ unavailable: true, retryAfter: 43 });
        expect(await provider.footprints(box(0, 0, 0.01))).toMatchObject({ unavailable: true, retryAfter: 43 });
        expect(await provider.footprintsUnder([{ key: 'a', geometry: box(0, 0, 0.001) }])).toMatchObject({ unavailable: true, retryAfter: 43 });
        // A partial answer (some cells served) is not "unavailable".
        const served = createOsmProvider(null, 'explore', { fetchStaged: noStaged,
            fetchLive: async () => ({ type: 'FeatureCollection', features: [building('w1', 0, 0)], partial: true }) });
        const result = await served.near(box(0, 0), 300);
        expect(result.unavailable).toBeUndefined();
        expect(result.partial).toBe(true);
    });

    it('serves footprints with measured heights only, and buildings touching each region', async () => {
        const provider = createOsmProvider(null, 'lima', { fetchStaged: noStaged, fetchLive: live([
            building('w1', 10.001, 10.001, { levels: 3 }),
            building('w2', 10.02, 10.02, { measured_height_m: 9 })
        ]) });
        const inside = await provider.footprints(box(10, 10, 0.005));
        expect(inside.footprints).toEqual([{ id: 'w1', geometry: box(10.001, 10.001), height_m: null, floors: 3 }]);
        const under = await provider.footprintsUnder([{ key: 'a', geometry: box(10, 10, 0.005) }, { key: 'b', geometry: box(10.02, 10.02, 0.001) }]);
        expect(under.regions.get('a').map(f => f.id)).toEqual(['w1']);
        expect(under.regions.get('b').map(f => f.id)).toEqual(['w2']);
    });

    it('clamps a query box to the Overpass span limit around its centre', () => {
        const [w, s, e, n] = expandBbox([0, 0, 0.2, 0.2], 1000);
        expect(e - w).toBeLessThanOrEqual(0.06);
        expect(n - s).toBeLessThanOrEqual(0.06);
        expect((w + e) / 2).toBeCloseTo(0.1, 6);
    });
});

describe('building provider registry', () => {
    const registry = createBuildingProviders({ query: async () => ({ rows: [] }) }, {});

    it('gives any named city without its own source the OSM provider, explore included', () => {
        for (const city of ['explore', 'lima', 'ljubljana']) {
            const provider = registry.resolve(city);
            expect(provider).toBeTruthy();
            expect(typeof provider.footprintsUnder).toBe('function');
            expect(registry.resolveExact(city)).toBe(provider);
        }
        expect(registry.resolve('lima')).not.toBe(registry.resolve('zagreb'));
    });

    it('keeps the Zagreb default for a missing city and refuses a malformed id', () => {
        expect(registry.resolve(undefined)).toBe(registry.resolve('zagreb'));
        expect(registry.resolve('../etc')).toBeNull();
    });
});
