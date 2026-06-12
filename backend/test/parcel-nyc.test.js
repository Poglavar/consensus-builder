import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupParcelNycRoute } from '../routes/parcel-nyc.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupParcelNycRoute, pool);
});

describe('GET /parcel-nyc', () => {
    it('rejects missing filters', async () => {
        const res = await request(app).get('/parcel-nyc');
        expect(res.status).toBe(400);
    });

    it('rejects invalid parcel ids on list queries', async () => {
        const res = await request(app).get('/parcel-nyc?parcel_id=bad%20id');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcel_id format. Expected US-NY-<parcel_id> or <parcel_id>.'
        });
    });

    it('rejects invalid bbox filters', async () => {
        const res = await request(app).get('/parcel-nyc?bbox=-73.9,40.7,-73.89');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in WGS84.' });
    });

    it('returns an empty feature collection when no parcels match', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-nyc?parcel_id=US-NY-100001');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            type: 'FeatureCollection',
            query: {
                type: 'parcel',
                parcel_id: 'US-NY-100001',
                parcel: '100001',
                bbox: undefined,
                limit: undefined,
                offset: undefined
            },
            features: []
        });
    });

    it('returns 500 when new york parcel lookup fails', async () => {
        pool.query = async () => {
            throw new Error('nyc offline');
        };

        const res = await request(app).get('/parcel-nyc?parcel_id=US-NY-100001');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch New York parcels.' });
    });

    it('returns new york parcel features', async () => {
        pool.setResult({
            rows: [{
                swis_sbl_ids: ['100001'],
                primary_owner: ['City of New York'],
                shape_area: 120,
                geom: { type: 'Polygon', coordinates: [[[-73.9, 40.7], [-73.89, 40.7], [-73.89, 40.69], [-73.9, 40.7]]] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-nyc?parcel_id=US-NY-100001');
        expect(res.status).toBe(200);
        expect(res.body.features[0].properties.parcelId).toBe('US-NY-100001');
    });

    it('omits ownershipList for condo billing lots so the panel resolves real unit owners', async () => {
        pool.setResult({
            rows: [{
                swis_sbl_ids: ['6201001005257507'], // lot 7507 -> condo billing lot
                primary_owner: ['181 SULLIVAN STREET CONDOMINIUM'],
                shape_area: 120,
                geom: { type: 'Polygon', coordinates: [[[-74, 40.7], [-73.99, 40.7], [-73.99, 40.69], [-74, 40.7]]] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-nyc?parcel_id=US-NY-6201001005257507');

        expect(res.status).toBe(200);
        const props = res.body.features[0].properties;
        expect(props.ownershipList).toBeUndefined(); // single condo-entity stub withheld
        expect(props.ownershipType).toBeTruthy();     // colouring still works
    });

    it('keeps ownershipList for ordinary lots', async () => {
        pool.setResult({
            rows: [{
                swis_sbl_ids: ['6201001005250001'], // lot 0001 -> ordinary lot
                primary_owner: ['City of New York'],
                shape_area: 120,
                geom: { type: 'Polygon', coordinates: [[[-74, 40.7], [-73.99, 40.7], [-73.99, 40.69], [-74, 40.7]]] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-nyc?parcel_id=US-NY-6201001005250001');

        expect(res.status).toBe(200);
        expect(res.body.features[0].properties.ownershipList).toHaveLength(1);
    });

    it('supports bbox queries with limit and offset', async () => {
        pool.setResult({
            rows: [{
                swis_sbl_ids: ['100001'],
                primary_owner: ['City of New York', 'CITY OF NEW YORK'],
                shape_area: 120,
                geom: { type: 'Polygon', coordinates: [[[-73.9, 40.7], [-73.89, 40.7], [-73.89, 40.69], [-73.9, 40.7]]] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-nyc?bbox=-73.9,40.69,-73.89,40.7&limit=2&offset=3');

        expect(res.status).toBe(200);
        expect(res.body.query).toEqual({
            type: 'bbox',
            parcel_id: undefined,
            parcel: undefined,
            bbox: '-73.9,40.69,-73.89,40.7',
            limit: 2,
            offset: 3
        });
        expect(res.body.features[0].properties.ownershipList).toHaveLength(1);
        expect(pool.getCalls()[0].params).toEqual([-73.9, 40.69, -73.89, 40.7, 2, 3]);
    });
});

describe('GET /parcel-nyc/:parcelId/ownership', () => {
    it('rejects invalid parcel id formats', async () => {
        const res = await request(app).get('/parcel-nyc/bad id/ownership');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcelId format. Expected US-NY-<parcel_id> or <parcel_id>.'
        });
    });

    it('returns 404 when ownership is missing', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-nyc/US-NY-100001/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested parcelId.' });
    });

    it('returns 500 when ownership lookup fails', async () => {
        pool.query = async () => {
            throw new Error('ny ownership offline');
        };

        const res = await request(app).get('/parcel-nyc/US-NY-100001/ownership');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch New York ownership data.' });
    });

    it('returns ownership data for a valid parcel id', async () => {
        pool.setResult({
            rows: [{
                swis_sbl_id: '100001',
                primary_owner: ['City of New York']
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-nyc/US-NY-100001/ownership');
        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe('US-NY-100001');
        expect(res.body.ownershipList).toHaveLength(1);
    });

    it('accepts ownership lookups without the US-NY prefix and deduplicates owners', async () => {
        pool.setResult({
            rows: [{
                swis_sbl_id: '100001',
                primary_owner: ['City of New York', 'CITY OF NEW YORK', 'Parks Department']
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-nyc/100001/ownership');

        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe('US-NY-100001');
        expect(res.body.ownershipList).toEqual([
            { ownerLabel: 'City of New York', percentageShare: 50 },
            { ownerLabel: 'Parks Department', percentageShare: 50 }
        ]);
    });

    it('returns an unknown-owner placeholder when ownership names are absent', async () => {
        pool.setResult({
            rows: [{
                swis_sbl_id: '100001',
                primary_owner: []
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-nyc/US-NY-100001/ownership');

        expect(res.status).toBe(200);
        expect(res.body.possessionSheets[0].possessors[0].name).toBe('Unknown owner');
    });
});