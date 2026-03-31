import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupHealthRoute } from '../routes/health.js';
import { createRouteApp } from './helpers/create-route-app.js';

describe('GET /health', () => {
    it('returns ok status', async () => {
        const app = createRouteApp(setupHealthRoute);

        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });
        expect(res.headers['content-type']).toContain('application/json');
    });
});