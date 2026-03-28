import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupParcelCoRoute } from '../routes/parcel-co.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupParcelCoRoute, pool);
});

describe('GET /parcel-co', () => {
    it('rejects missing filters', async () => {
        const res = await request(app).get('/parcel-co');
        expect(res.status).toBe(400);
    });

    it('rejects invalid parcel ids on list queries', async () => {
        const res = await request(app).get('/parcel-co?parcel_id=bad%20id');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcel_id format. Expected US-CO-<parcel_id> or <parcel_id>.'
        });
    });

    it('rejects invalid bbox filters', async () => {
        const res = await request(app).get('/parcel-co?bbox=-105,39,-104.99');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in WGS84.' });
    });

    it('returns 404 when no colorado parcels match', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-co?parcel_id=US-CO-001');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'No parcels found for the provided filters.' });
    });

    it('returns 500 when colorado parcel lookup fails', async () => {
        pool.query = async () => {
            throw new Error('co lookup failed');
        };

        const res = await request(app).get('/parcel-co?parcel_id=US-CO-001');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch Colorado parcels.' });
    });

    it('returns colorado parcel features', async () => {
        pool.setResult({
            rows: [{
                parcel_id: '001',
                parcel_ids: ['001'],
                owner_primary: ['Alice'],
                owner_secondary: [],
                geometry: { type: 'Polygon', coordinates: [[[-105, 39], [-104.99, 39], [-104.99, 38.99], [-105, 39]]] },
                calculated_area: 25
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-co?parcel_id=US-CO-001');
        expect(res.status).toBe(200);
        expect(res.body.features[0].properties.parcelId).toBe('US-CO-001');
    });

    it('supports bbox queries with limit and offset', async () => {
        pool.setResult({
            rows: [{
                parcel_id: '001',
                parcel_ids: ['001'],
                owner_primary: ['Alice'],
                owner_secondary: ['ALICE', 'Bob'],
                geometry: { type: 'Polygon', coordinates: [[[-105, 39], [-104.99, 39], [-104.99, 38.99], [-105, 39]]] },
                calculated_area: 25
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-co?bbox=-105,38.99,-104.99,39&limit=2&offset=3');

        expect(res.status).toBe(200);
        expect(res.body.query).toEqual({
            type: 'bbox',
            parcel_id: undefined,
            parcel: undefined,
            bbox: '-105,38.99,-104.99,39',
            limit: 2,
            offset: 3
        });
        expect(res.body.features[0].properties.ownershipList).toHaveLength(2);
        expect(pool.getCalls()[0].params).toEqual([-105, 38.99, -104.99, 39, 2, 3]);
    });
});

describe('GET /parcel-co/:parcelId/ownership', () => {
    it('rejects invalid parcel id formats', async () => {
        const res = await request(app).get('/parcel-co/bad id/ownership');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcelId format. Expected US-CO-<parcel_id> or <parcel_id>.'
        });
    });

    it('returns 404 when colorado ownership is missing', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-co/US-CO-001/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested parcelId.' });
    });

    it('returns 500 when colorado ownership lookup fails', async () => {
        pool.query = async () => {
            throw new Error('co ownership failed');
        };

        const res = await request(app).get('/parcel-co/US-CO-001/ownership');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch Colorado ownership data.' });
    });

    it('returns ownership data for a valid parcel id', async () => {
        pool.setResult({
            rows: [{
                parcel_id: '001',
                parcel_ids: ['001'],
                owner_primary: ['Alice'],
                owner_secondary: []
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-co/US-CO-001/ownership');
        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe('US-CO-001');
        expect(res.body.ownershipList).toHaveLength(1);
    });

    it('accepts ownership lookups without the US-CO prefix and deduplicates owners', async () => {
        pool.setResult({
            rows: [{
                parcel_id: '001',
                parcel_ids: ['001'],
                owner_primary: ['Alice'],
                owner_secondary: ['ALICE', 'Bob']
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-co/001/ownership');

        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe('US-CO-001');
        expect(res.body.ownershipList).toEqual([
            { ownerLabel: 'Alice', percentageShare: 50 },
            { ownerLabel: 'Bob', percentageShare: 50 }
        ]);
    });

    it('returns an unknown-owner placeholder when ownership names are absent', async () => {
        pool.setResult({
            rows: [{
                parcel_id: '001',
                parcel_ids: ['001'],
                owner_primary: [],
                owner_secondary: []
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-co/US-CO-001/ownership');

        expect(res.status).toBe(200);
        expect(res.body.possessionSheets[0].possessors[0].name).toBe('Unknown owner');
    });
});