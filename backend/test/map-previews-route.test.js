import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMapPreviewsRoute } from '../routes/map-previews.js';
import { createMapPreviewService } from '../thumbnails/map-preview.js';

const A = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const B = 'bafkreid2zzzld3ix5ws24s3qn3ghwqsot7byya2sgrh4txbyjtwy2oabtq';
const ASSET = '/uploads/images/map-preview.png';

function app(service) {
    const server = express();
    server.use(express.json());
    setupMapPreviewsRoute(server, { mapPreviewService: service });
    return server;
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('map preview routes', () => {
    it('prepares an ordered CID set and returns a pinned public image URL and dimensions', async () => {
        vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.example/');
        const prepare = vi.fn(async cids => ({ imagePath: ASSET, width: 1200, height: 630, cids }));
        const response = await request(app({ prepare })).post('/map-previews').send({ cids: [A, B] });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ imageUrl: `https://api.example${ASSET}`, width: 1200, height: 630 });
        expect(prepare).toHaveBeenCalledWith([A, B]);
    });

    it('returns a relative asset path when the public API base is not pinned', async () => {
        vi.stubEnv('PUBLIC_API_BASE_URL', '');
        const prepare = vi.fn(async () => ({ imagePath: ASSET, width: 1200, height: 630 }));
        const response = await request(app({ prepare })).post('/map-previews').send({ cids: [A] });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ imageUrl: ASSET, width: 1200, height: 630 });
    });

    it('redirects image GETs to the prepared asset with a public cache policy', async () => {
        vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.example');
        const prepare = vi.fn(async () => ({ imagePath: ASSET, width: 1200, height: 630 }));
        const response = await request(app({ prepare })).get(`/map-previews/${A},${B}/image.png`);

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(`https://api.example${ASSET}`);
        expect(response.headers['cache-control']).toBe('public, max-age=3600');
        expect(prepare).toHaveBeenCalledWith([A, B]);
    });

    it('returns retryable rendering failures without caching them', async () => {
        const prepare = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
        const response = await request(app({ prepare })).get(`/map-previews/${A}/image.png`);

        expect(response.status).toBe(503);
        expect(response.headers['retry-after']).toBe('15');
        expect(response.headers['cache-control']).toBe('no-store');
    });

    it('preserves missing-design 404 errors and disables caching', async () => {
        const prepare = vi.fn().mockRejectedValue(Object.assign(new Error('A shared design was not found.'), { status: 404 }));
        const response = await request(app({ prepare })).post('/map-previews').send({ cids: [A] });

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('A shared design was not found.');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['retry-after']).toBeUndefined();
    });

    it('rejects malformed CIDs before loading or rendering any design', async () => {
        const load = vi.fn();
        const render = vi.fn();
        const service = createMapPreviewService({
            pool: {}, cacheDir: '/tmp/map-preview-invalid-cid-test', load, render
        });
        const response = await request(app(service)).post('/map-previews').send({ cids: [A, 'bad'] });

        expect(response.status).toBe(400);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(load).not.toHaveBeenCalled();
        expect(render).not.toHaveBeenCalled();
    });
});
