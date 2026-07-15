// Purpose: verify viewport inference validation, provider proxying, normalization, and caching.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { setupParcelInferenceRoute } from '../routes/parcel-inferred.js';

const polygon = {
    type: 'Polygon',
    coordinates: [[[15.97, 45.80], [15.98, 45.80], [15.98, 45.81], [15.97, 45.80]]]
};

function createApp({ env = {}, fetchImpl } = {}) {
    const app = express();
    setupParcelInferenceRoute(app, { env, fetchImpl });
    return app;
}

function response(payload, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

describe('GET /parcels/inferred', () => {
    let fetchImpl;

    beforeEach(() => {
        fetchImpl = vi.fn().mockResolvedValue(response({
            type: 'FeatureCollection',
            metadata: { model: 'parcel-net-v1', promptVersion: 'parcel-seeds-v1' },
            features: [{ type: 'Feature', properties: { confidence: 1.4 }, geometry: polygon }]
        }));
    });

    it('rejects invalid or oversized viewports', async () => {
        const app = createApp({ env: { PARCEL_INFERENCE_URL: 'https://inference.internal/infer' }, fetchImpl });
        const invalid = await request(app).get('/parcels/inferred?bbox=1,2,3&zoom=18');
        const oversized = await request(app).get('/parcels/inferred?bbox=15,45,15.2,45.2&zoom=18');
        expect(invalid.status).toBe(400);
        expect(oversized.status).toBe(413);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('requires a close-enough map zoom', async () => {
        const app = createApp({ env: { PARCEL_INFERENCE_URL: 'https://inference.internal/infer' }, fetchImpl });
        const res = await request(app).get('/parcels/inferred?bbox=15.97,45.8,15.98,45.81&zoom=14');
        expect(res.status).toBe(400);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports an unconfigured service without pretending no parcels exist', async () => {
        const res = await request(createApp()).get('/parcels/inferred?bbox=15.97,45.8,15.98,45.81&zoom=18');
        expect(res.status).toBe(503);
        expect(res.body.supported).toBe(false);
    });

    it('sends the model adapter contract and normalizes provisional features', async () => {
        const env = {
            PARCEL_INFERENCE_URL: 'https://inference.internal/infer',
            PARCEL_INFERENCE_TOKEN: 'secret',
            PARCEL_INFERENCE_MODEL: 'vision-model',
            PARCEL_INFERENCE_LLM_ADAPTER: 'claude-cli'
        };
        const res = await request(createApp({ env, fetchImpl }))
            .get('/parcels/inferred?bbox=15.97,45.8,15.98,45.81&zoom=18');

        expect(res.status).toBe(200);
        expect(res.headers['x-parcel-inference-cache']).toBe('MISS');
        const [, options] = fetchImpl.mock.calls[0];
        expect(options.headers.Authorization).toBe('Bearer secret');
        expect(JSON.parse(options.body)).toMatchObject({
            input: { type: 'viewport', bbox: [15.97, 45.8, 15.98, 45.81], crs: 'EPSG:4326', zoom: 18 },
            model: 'vision-model',
            llmAdapter: 'claude-cli'
        });
        expect(res.body.features[0].properties).toMatchObject({
            provenance: 'inferred',
            planningStatus: 'provisional',
            authoritative: false,
            confidence: 1,
            promptVersion: 'parcel-seeds-v1'
        });
        expect(res.body.features[0].properties.parcelId).toMatch(/^AI-[a-f0-9]{16}$/);
    });

    it('uses stable geometry ids and caches identical viewport requests', async () => {
        const app = createApp({ env: { PARCEL_INFERENCE_URL: 'https://inference.internal/infer' }, fetchImpl });
        const url = '/parcels/inferred?bbox=15.97,45.8,15.98,45.81&zoom=18';
        const first = await request(app).get(url);
        const second = await request(app).get(url);
        expect(first.body.features[0].properties.parcelId).toBe(second.body.features[0].properties.parcelId);
        expect(second.headers['x-parcel-inference-cache']).toBe('HIT');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('drops malformed geometry instead of exposing unusable parcels', async () => {
        fetchImpl.mockResolvedValue(response({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [15.9, 45.8] } }]
        }));
        const app = createApp({ env: { PARCEL_INFERENCE_URL: 'https://inference.internal/infer' }, fetchImpl });
        const res = await request(app).get('/parcels/inferred?bbox=15.97,45.8,15.98,45.81&zoom=18');
        expect(res.status).toBe(200);
        expect(res.body.features).toEqual([]);
    });

    it('returns a safe gateway error when the provider fails', async () => {
        fetchImpl.mockResolvedValue(response({}, 500));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = createApp({ env: { PARCEL_INFERENCE_URL: 'https://inference.internal/infer' }, fetchImpl });
        const res = await request(app).get('/parcels/inferred?bbox=15.97,45.8,15.98,45.81&zoom=18');
        expect(res.status).toBe(502);
        expect(res.body.features).toEqual([]);
        consoleSpy.mockRestore();
    });
});
