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
            truncated: false,
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
        expect(pool.getCalls()[0].params).toEqual([-73.9, 40.69, -73.89, 40.7, 3, 3]);
    });
});
