import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupAdsRoute } from '../routes/ads.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupAdsRoute, pool);
});

describe('GET /ads', () => {
    it('rejects requests without filters', async () => {
        const res = await request(app).get('/ads');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Provide at least one filter: bbox, parcel_id, or min_publication_date.' });
    });

    it('rejects invalid bbox values', async () => {
        const res = await request(app).get('/ads?bbox=1,2,3');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
    });

    it('rejects invalid min_publication_date values', async () => {
        const res = await request(app).get('/ads?min_publication_date=not-a-date');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid min_publication_date. Use an ISO-8601 date.' });
    });

    it('returns 404 when parcel_id cannot be resolved', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/ads?parcel_id=HR-339318-7396');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Parcel not found for the provided parcel_id.' });
    });

    it('resolves parcel ids before filtering ads', async () => {
        pool.setResults([
            { rows: [{ cestica_id: 123 }], rowCount: 1 },
            {
                rows: [{
                    ad_platform: 'njuskalo',
                    ad_id: 'ad-1',
                    ad_version: 1,
                    ad_current: true,
                    publication_date: '2026-01-01T00:00:00.000Z',
                    ad_url: 'https://example.test/ad-1',
                    details: { price: 123 },
                    text: 'Listing',
                    images: ['img'],
                    category: 'land',
                    active: true,
                    ad_updated_at: '2026-01-02T00:00:00.000Z',
                    ad_updated_by: 'system',
                    ad_parcel_url: 'https://example.test/parcel',
                    ai_model: 'gpt',
                    ai_prompt: 'prompt',
                    ai_response: 'response',
                    parcel_score: 0.9,
                    ad_parcel_updated_at: '2026-01-02T00:00:00.000Z',
                    ad_parcel_updated_by: 'system',
                    geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                    parcel_properties: { parcelId: 'HR-339318-7396' }
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/ads?parcel_id=HR-339318-7396');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(pool.getCalls()[1].params).toContain(123);
    });

    it('strips parcel suffixes before parcel_id lookup', async () => {
        pool.setResults([
            { rows: [{ cestica_id: 123 }], rowCount: 1 },
            { rows: [], rowCount: 0 }
        ]);

        const res = await request(app).get('/ads?parcel_id=HR-339318-7396/2');

        expect(res.status).toBe(200);
        expect(pool.getCalls()[0].params).toEqual(['7396', 339318]);
    });

    it('combines bbox and date filters in the final ads query', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/ads?bbox=15.9,45.78,15.91,45.79&min_publication_date=2026-01-01');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            count: 0,
            limit: 500,
            filters: {
                bbox: '15.9,45.78,15.91,45.79',
                parcel_id: null,
                min_publication_date: '2026-01-01T00:00:00.000Z'
            },
            items: []
        });
        const call = pool.getCalls()[0];
        expect(call.sql).toContain('ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 3765)');
        expect(call.sql).toContain('a.publication_date >= $5');
        expect(call.params).toEqual([15.9, 45.78, 15.91, 45.79, '2026-01-01T00:00:00.000Z']);
    });

    it('returns ads with parcel data for date filtering', async () => {
        pool.setResult({
            rows: [{
                ad_platform: 'njuskalo',
                ad_id: 'ad-1',
                ad_version: 1,
                ad_current: true,
                publication_date: '2026-01-01T00:00:00.000Z',
                ad_url: 'https://example.test/ad-1',
                details: { price: 123 },
                text: 'Listing',
                images: ['img'],
                category: 'land',
                active: true,
                ad_updated_at: '2026-01-02T00:00:00.000Z',
                ad_updated_by: 'system',
                ad_parcel_url: 'https://example.test/parcel',
                ai_model: 'gpt',
                ai_prompt: 'prompt',
                ai_response: 'response',
                parcel_score: 0.9,
                ad_parcel_updated_at: '2026-01-02T00:00:00.000Z',
                ad_parcel_updated_by: 'system',
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                parcel_properties: { parcelId: 'HR-339318-7396' }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/ads?min_publication_date=2026-01-01');
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.items[0].parcel.parcelId).toBe('HR-339318-7396');
        expect(res.body.items[0].ad.id).toBe('ad-1');
    });

    it('returns 500 when the ad query fails', async () => {
        pool.query = async () => {
            throw new Error('db offline');
        };

        const res = await request(app).get('/ads?min_publication_date=2026-01-01');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch ads with parcels.' });
    });
});