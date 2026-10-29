import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupOsmRoadRoute } from '../routes/osm-road.js';
import { setupUrbanBlocksRoutes } from '../routes/urban-blocks.js';
import { setupDecorRoute } from '../routes/decor.js';
import { setupStreetsRoute } from '../routes/streets.js';
import { resetStreetsNearCache } from '../streets/near.js';
import { createBlockBarrierRegistry, createDecorSources, createRoadNetworkRegistry } from '../sources/network-environment.js';

const require = createRequire(import.meta.url);
const SourceRuntime = require('../../frontend/js/source-runtime.js');
const line = { type: 'LineString', coordinates: [[1, 2], [1.001, 2.001]] };
const feature = { type: 'Feature', geometry: line, properties: { osm_id: 'w7' } };
const fc = { type: 'FeatureCollection', features: [feature], truncated: false };
const bbox = [1, 2, 1.01, 2.01];

describe('network and environment adapter dispatch', () => {
    it('reads the network table with native topology properties and skips the live reader when populated', async () => {
        const pool = { query: vi.fn(async () => ({ rows: [{ geometry: line, properties: { osm_node_ids: [10, 11] } }] })) };
        const fetchOverpassRoads = vi.fn();
        const app = express();
        const sources = setupOsmRoadRoute(app, pool, { fetchOverpassRoads });
        expect(sources.source('osm-road')).toMatchObject({ abstraction: 'road-network', adapter: 'osm-road-network', kind: 'default' });
        const res = await request(app).get('/osm-road').query({ bbox: bbox.join(','), crs: 'EPSG:4326' });
        expect(res.status).toBe(200);
        expect(res.body.features[0]).toEqual({ type: 'Feature', geometry: line, properties: { osm_node_ids: [10, 11] } });
        expect(pool.query.mock.calls[0][0]).toContain('r.highway_type IS NOT NULL');
        expect(pool.query.mock.calls[0][1]).toEqual(bbox);
        expect(fetchOverpassRoads).not.toHaveBeenCalled();
    });

    it('keeps road and railway fallback dispatch distinct and preserves live flags', async () => {
        const pool = { query: vi.fn(async () => ({ rows: [] })) };
        const fetchOverpassRoads = vi.fn(async () => fc);
        const fetchOverpassRoadsAndRailways = vi.fn(async () => ({ ...fc, partial: true, truncated: true }));
        const app = express();
        setupOsmRoadRoute(app, pool, { fetchOverpassRoads, fetchOverpassRoadsAndRailways });
        const res = await request(app).get('/osm-road').query({ bbox: bbox.join(','), crs: 'EPSG:4326', railways: '1' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ features: [feature], source: 'overpass', partial: true, truncated: true });
        expect(fetchOverpassRoadsAndRailways).toHaveBeenCalledExactlyOnceWith(bbox);
        expect(fetchOverpassRoads).not.toHaveBeenCalled();
        expect(pool.query.mock.calls[0][0]).toContain('r.railway_type IS NOT NULL');
    });

    it('preserves frontage policy and supports its injected live transport through the route', async () => {
        resetStreetsNearCache();
        const pool = { query: vi.fn(async () => ({ rows: [] })) };
        const fetchOverpass = vi.fn(async () => fc);
        const app = express();
        const sources = setupStreetsRoute(app, pool, { fetchOverpass });
        const res = await request(app).get('/streets/near').query({ bbox: bbox.join(',') });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ...fc, source: 'overpass' });
        expect(fetchOverpass).toHaveBeenCalledExactlyOnceWith(bbox);
        expect(sources.frontage.source('osm-frontage').config.policy).toBe('frontage');
    });

    it('invokes the existing block reader and preserves its independent response', async () => {
        const fetchRoads = vi.fn(async () => ({ ...fc, source: 'overpass', bbox }));
        const app = express();
        setupUrbanBlocksRoutes(app, { fetchRoads });
        const res = await request(app).get('/blocks/roads').query({ bbox: bbox.join(',') });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ...fc, source: 'overpass', bbox });
        expect(fetchRoads).toHaveBeenCalledExactlyOnceWith(bbox);
    });

    it('preserves the water injection seam and calls the same reader through registered custom sources', async () => {
        const result = { areas: [{ geometry: { type: 'Polygon', coordinates: [] }, kind: 'water' }], count: 1, source: 'openfreemap' };
        const waterProvider = { near: vi.fn(async () => result) };
        const app = express();
        app.use(express.json());
        const sources = setupDecorRoute(app, { query: vi.fn() }, { waterProvider });
        const geometry = { type: 'Point', coordinates: [1, 2] };
        const res = await request(app).get('/decor/water').query({ bbox: '1,2,1,2', buffer_meters: '80' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual(result);
        expect(waterProvider.near).toHaveBeenCalledExactlyOnceWith(geometry, 80);
        const base = sources.water.source('openfreemap-water');
        sources.water.register(SourceRuntime.source('water', base.adapter, base.config, { id: 'custom-water', kind: 'custom' }));
        expect(sources.water.open('custom-water')).toBe(waterProvider);
        expect(await sources.water.open('custom-water').near(geometry, 80)).toEqual(result);
    });

    it('rejects custom private database sources, unknown adapters, and unsupported public endpoints', () => {
        const privateSources = createRoadNetworkRegistry({ query: vi.fn() });
        const configured = privateSources.source('osm-road');
        expect(() => privateSources.register({ ...configured, id: 'custom-db', kind: 'custom' })).toThrow(/configured/);
        expect(() => privateSources.open('missing')).toThrow();
        const sources = createDecorSources({ query: vi.fn() }, { waterProvider: { near: vi.fn() } });
        const base = sources.water.source('openfreemap-water');
        sources.water.register({ ...base, id: 'custom-endpoint', kind: 'custom', config: { tilejson: 'http://127.0.0.1/' } });
        expect(() => sources.water.open('custom-endpoint')).toThrow(/configuration/);
        const block = createBlockBarrierRegistry({ fetchRoads: vi.fn(async () => fc) });
        const blockBase = block.source('osm-block-roads');
        block.register({ ...blockBase, id: 'custom-blocks', kind: 'custom' });
        expect(typeof block.open('custom-blocks').readBarriers).toBe('function');
        expect(() => block.register({ ...blockBase, id: 'unknown', adapter: 'unknown' })).toThrow(/Unknown/);
    });
});
