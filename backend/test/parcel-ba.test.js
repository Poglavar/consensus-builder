import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupParcelBaRoute } from '../routes/parcel-ba.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupParcelBaRoute, pool);
});

describe('GET /parcel-ba', () => {
    it('rejects requests without filters', async () => {
        const res = await request(app).get('/parcel-ba');
        expect(res.status).toBe(400);
    });

    it('rejects invalid bbox values', async () => {
        const res = await request(app).get('/parcel-ba?bbox=-58.4,-34.61,-58.39');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in WGS84.'
        });
    });

    it('rejects block filters without section when bbox is otherwise valid', async () => {
        const res = await request(app).get('/parcel-ba?bbox=-58.4,-34.61,-58.39,-34.6&block=062');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'block filter requires section to be provided.' });
    });

    it('returns 404 when no parcels match the filters', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-ba?smp=002-062-000');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'No parcels found for the provided filters.' });
    });

    it('returns 500 when the parcel lookup fails', async () => {
        pool.query = async () => {
            throw new Error('ba unavailable');
        };

        const res = await request(app).get('/parcel-ba?smp=002-062-000');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch Buenos Aires parcels.' });
    });

    it('returns a feature collection for smp queries', async () => {
        pool.setResults([
            {
                rows: [{
                    smp: '002-062-000',
                    section: '002',
                    block: '062',
                    parcel: '000',
                    area: 100,
                    geometry: { type: 'Polygon', coordinates: [[[-58.4, -34.6], [-58.39, -34.6], [-58.39, -34.61], [-58.4, -34.6]]] },
                    information_basic: {},
                    information_technical: {},
                    property_horizontal: null,
                    doors: null,
                    date_added: null,
                    date_updated: null,
                    ownership_list_json: [{ ownerLabel: 'Unit 1', percentageShare: 100 }],
                    ownership_type: 'private individual'
                }],
                rowCount: 1
            },
            {
                rows: [],
                rowCount: 0
            }
        ]);

        const res = await request(app).get('/parcel-ba?smp=AR-002-062-000');
        expect(res.status).toBe(200);
        expect(res.body.query.type).toBe('parcel');
        expect(res.body.features[0].properties.parcelId).toBe('AR-002-062-000');
    });

    it('requires both section and block when filtering by parcel', async () => {
        const res = await request(app).get('/parcel-ba?section=002&parcel=000');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'parcel filter requires both section and block to be provided.' });
    });

    it('supports bbox queries with limit and falls back to batch ownership summaries', async () => {
        pool.setResults([
            {
                rows: [{
                    smp: '002-062-000',
                    section: '002',
                    block: '062',
                    parcel: '000',
                    area: 100,
                    geometry: { type: 'Polygon', coordinates: [[[-58.4, -34.6], [-58.39, -34.6], [-58.39, -34.61], [-58.4, -34.6]]] },
                    information_basic: { parcela: '000' },
                    information_technical: {},
                    property_horizontal: null,
                    doors: null,
                    date_added: null,
                    date_updated: null,
                    ownership_list_json: '{bad json',
                    ownership_type: null
                }],
                rowCount: 1
            },
            {
                rows: [{
                    smp: '002-062-000',
                    information_basic: { parcela: '000' },
                    information_technical: {},
                    property_horizontal: { phs: [{ dpto: 'A', porcentual: 100, pdahorizontal: '1' }] },
                    doors: null,
                    date_added: null,
                    date_updated: null
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/parcel-ba?bbox=-58.4,-34.61,-58.39,-34.6&limit=2');

        expect(res.status).toBe(200);
        expect(res.body.query.type).toBe('bbox');
        expect(res.body.query.limit).toBe(2);
        expect(res.body.features[0].properties.ownershipList).toHaveLength(1);
        expect(pool.getCalls()[0].params).toEqual([-58.4, -34.61, -58.39, -34.6, 2]);
    });

    it('still returns parcels when batch ownership enrichment fails', async () => {
        pool.query = async (sql) => {
            if (sql.includes('FROM parcel_ba\n            WHERE smp = ANY')) {
                throw new Error('ownership batch failed');
            }
            return {
                rows: [{
                    smp: '002-062-000',
                    section: '002',
                    block: '062',
                    parcel: '000',
                    area: 100,
                    geometry: { type: 'Polygon', coordinates: [[[-58.4, -34.6], [-58.39, -34.6], [-58.39, -34.61], [-58.4, -34.6]]] },
                    information_basic: {},
                    information_technical: {},
                    property_horizontal: null,
                    doors: null,
                    date_added: null,
                    date_updated: null,
                    ownership_list_json: null,
                    ownership_type: null
                }],
                rowCount: 1
            };
        };

        const res = await request(app).get('/parcel-ba?smp=002-062-000');

        expect(res.status).toBe(200);
        expect(res.body.features[0].properties).not.toHaveProperty('ownershipList');
    });
});

describe('GET /parcel-ba/:smp/ownership', () => {
    it('rejects invalid smp formats', async () => {
        const res = await request(app).get('/parcel-ba/bad-format/ownership');
        expect(res.status).toBe(400);
    });

    it('returns 404 when ownership is missing', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-ba/002-062-000/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested SMP.' });
    });

    it('returns 500 when ownership lookup fails', async () => {
        pool.query = async () => {
            throw new Error('ownership unavailable');
        };

        const res = await request(app).get('/parcel-ba/002-062-000/ownership');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch Buenos Aires ownership data.' });
    });

    it('returns ownership data for a valid smp', async () => {
        pool.setResult({
            rows: [{
                information_basic: { parcela: '000' },
                information_technical: {},
                property_horizontal: { phs: [{ dpto: 'A', porcentual: 100, pdahorizontal: '1' }] },
                doors: null,
                date_added: null,
                date_updated: null
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-ba/002-062-000/ownership');
        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe('AR-002-062-000');
        expect(res.body.ownershipType).toBe('private individual');
    });

    it('falls back to an unknown owner when no horizontal property data exists', async () => {
        pool.setResult({
            rows: [{
                information_basic: { parcela: '000' },
                information_technical: {},
                property_horizontal: null,
                doors: null,
                date_added: null,
                date_updated: null
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-ba/002-062-000/ownership');

        expect(res.status).toBe(200);
        expect(res.body.possessionSheets[0].possessors[0].name).toBe('Unknown owner');
    });
});