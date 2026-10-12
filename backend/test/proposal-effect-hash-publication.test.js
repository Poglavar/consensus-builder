// Publication stamps the effect hash owner consent binds to (proposals/effect-hash.js): computed on
// the server from the stored fields, never echoed from the uploader, and absent when the record has
// no footprint to hash (the browser then derives what it needs, as before).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { insertResult, updateResult, validProposalBody } from './helpers/fixtures.js';
import { effectHashOf } from '../proposals/effect-hash.js';

const square = { type: 'Polygon', coordinates: [[[16, 45.8], [16.001, 45.8], [16.001, 45.801], [16, 45.801], [16, 45.8]]] };

describe('proposal publication effect hash', () => {
    it('stamps the server-computed hash over the uploader\'s', async () => {
        const pool = createMockPool();
        pool.setResults([insertResult(), updateResult()]);
        const app = createTestApp(pool);
        const posted = await request(app).post('/proposals').send(validProposalBody({ geometry: square, effectHash: 'e-uploader' }));
        expect(posted.status).toBe(201);
        const stored = JSON.parse(pool.getCalls()[0].params[32]);
        expect(stored.effectHash).toMatch(/^e-/);
        expect(stored.effectHash).not.toBe('e-uploader');
        expect(stored.effectHash).toBe(effectHashOf(stored));
    });

    it('drops an uploader stamp when there is no footprint to hash', async () => {
        const pool = createMockPool();
        pool.setResults([insertResult(), updateResult()]);
        const app = createTestApp(pool);
        const posted = await request(app).post('/proposals').send(validProposalBody({ effectHash: 'e-uploader' }));
        expect(posted.status).toBe(201);
        const stored = JSON.parse(pool.getCalls()[0].params[32]);
        expect(stored).not.toHaveProperty('effectHash');
    });
});
