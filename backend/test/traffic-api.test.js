import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createRouteApp } from './helpers/create-route-app.js';
import { setupTrafficSimulatorRoute } from '../routes/traffic-simulator.js';
import { createTrafficSimulatorApp } from '../scripts/serve-traffic-simulator.mjs';

const ENV = {
    TRAFFIC_TOPOLOGY_ROOT: '/topology',
    TRAFFIC_ROADS_API: 'http://roads.test/api'
};
const pool = { query: vi.fn(() => { throw new Error('route must not query the database directly'); }) };

function network(version = 'snapshot-1') {
    return {
        schemaVersion: 2,
        city: 'zagreb',
        bbox: [15.9, 45.7, 16, 45.9],
        source: {
            osmSnapshotId: version,
            osmTimestamp: '2026-10-14T00:00:00.000Z',
            updatedAt: '2026-10-14T00:01:00.000Z',
            selectedSolutions: 2,
            liveDecisions: 1,
            counts: {
                surfaceLanes: 5, simulatedLanes: 3, connections: 2, tramWays: 0, tramTrackPaths: 0,
                signals: 1, controlledSignals: 1, savedJunctions: 1,
                partialJunctions: 0, unresolvedNodes: 2
            }
        },
        nodes: [{ id: 'n1', unresolved: true }],
        lanes: [{ id: 'car-1' }],
        surfaceLanes: [{ id: 'surface-1' }],
        connections: [{ id: 'connection-1' }],
        signals: [{ id: 'signal-1', controls: ['car-1'] }]
    };
}

function appFor(options = {}) {
    return createRouteApp(setupTrafficSimulatorRoute, pool, { env: ENV, ...options });
}

afterEach(() => vi.clearAllMocks());

describe('traffic simulator API', () => {
    it('serves the canonical page after one slash redirect and blocks offline test data', async () => {
        const app = createTrafficSimulatorApp({ pool, env: ENV });
        const redirect = await request(app).get('/promet/simulator');
        expect(redirect.status).toBe(302);
        expect(redirect.headers.location).toBe('/promet/simulator/');
        const page = await request(app).get('/promet/simulator/?reduceMotion=1');
        expect(page.status).toBe(200);
        expect(page.text).toContain('<html lang="hr">');
        expect(page.headers['cache-control']).toContain('no-store');
        await request(app).get('/promet/simulator/data/central.json.gz').expect(404);
        expect(pool.query).not.toHaveBeenCalled();
    });
    it('serves loader data and a compact status summary without querying the pool', async () => {
        const data = network();
        const loadNetwork = vi.fn(async () => data);
        const app = appFor({ loadNetwork });

        const response = await request(app).get('/promet/simulator/network');
        const status = await request(app).get('/promet/simulator/status');

        expect(response.status).toBe(200);
        expect(response.body).toEqual(data);
        expect(status.status).toBe(200);
        expect(status.body).toEqual({
            source: expect.objectContaining({ osmSnapshotId: 'snapshot-1', selectedSolutions: 2 }),
            bbox: data.bbox,
            counts: data.source.counts
        });
        expect(loadNetwork).toHaveBeenCalledTimes(1);
        expect(loadNetwork).toHaveBeenCalledWith({ pool, topologyRoot: '/topology', roadsApi: 'http://roads.test/api' });
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('rejects arbitrary bbox parameters and reports missing runtime configuration safely', async () => {
        const loadNetwork = vi.fn();
        const app = appFor({ loadNetwork });

        const customArea = await request(app).get('/promet/simulator/network?bbox=1,2,3,4');
        expect(customArea.status).toBe(400);
        expect(customArea.body.error).toMatch(/unaprijed/i);
        expect(loadNetwork).not.toHaveBeenCalled();

        const unconfigured = createRouteApp(setupTrafficSimulatorRoute, pool, { env: {}, loadNetwork });
        const unavailable = await request(unconfigured).get('/promet/simulator/network');
        expect(unavailable.status).toBe(503);
        expect(unavailable.body).toEqual({ error: 'Simulator prometa trenutačno nije dostupan.' });
        expect(unavailable.text).not.toContain('TRAFFIC_TOPOLOGY_ROOT');
        expect(loadNetwork).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent loads and caches successful data until expiry', async () => {
        let release;
        let time = 1000;
        const gate = new Promise(resolve => { release = resolve; });
        const loadNetwork = vi.fn(async () => { await gate; return network(); });
        const app = appFor({ loadNetwork, now: () => time, cacheMs: 120000 });

        const first = request(app).get('/promet/simulator/network').then(response => response);
        const second = request(app).get('/promet/simulator/status').then(response => response);
        await new Promise(resolve => setTimeout(resolve, 5));
        release();
        const [networkResponse, statusResponse] = await Promise.all([first, second]);
        expect(networkResponse.status).toBe(200);
        expect(statusResponse.status).toBe(200);
        expect(loadNetwork).toHaveBeenCalledTimes(1);

        time += 119999;
        await request(app).get('/promet/simulator/network').expect(200);
        expect(loadNetwork).toHaveBeenCalledTimes(1);
        time += 1;
        await request(app).get('/promet/simulator/network').expect(200);
        expect(loadNetwork).toHaveBeenCalledTimes(2);
    });

    it('does not serve expired data after a failed refresh and retries on the next request', async () => {
        let time = 0;
        const loadNetwork = vi.fn()
            .mockResolvedValueOnce(network('old-snapshot'))
            .mockRejectedValueOnce(new Error('database secret and stack'))
            .mockResolvedValueOnce(network('new-snapshot'));
        const app = appFor({ loadNetwork, now: () => time, cacheMs: 10 });

        await request(app).get('/promet/simulator/network').expect(200);
        time = 10;
        const failed = await request(app).get('/promet/simulator/network');
        expect(failed.status).toBe(503);
        expect(failed.text).not.toContain('database secret');
        expect(failed.body.error).toMatch(/Simulator prometa/);
        const recovered = await request(app).get('/promet/simulator/network');
        expect(recovered.status).toBe(200);
        expect(recovered.body.source.osmSnapshotId).toBe('new-snapshot');
        expect(loadNetwork).toHaveBeenCalledTimes(3);
    });

    it('sets validators and cache headers and compresses when requested', async () => {
        const app = appFor({ loadNetwork: vi.fn(async () => network()) });
        const response = await request(app).get('/promet/simulator/network').set('Accept-Encoding', 'gzip');

        expect(response.status).toBe(200);
        expect(response.headers['content-encoding']).toBe('gzip');
        expect(response.headers['cache-control']).toBe('no-cache');
        expect(response.headers.vary).toContain('Accept-Encoding');
        expect(response.headers.etag).toMatch(/^W\//);
        expect(response.body.source.osmSnapshotId).toBe('snapshot-1');

        const notModified = await request(app).get('/promet/simulator/network')
            .set('If-None-Match', response.headers.etag);
        expect(notModified.status).toBe(304);
        expect(notModified.text).toBeFalsy();
    });
});
