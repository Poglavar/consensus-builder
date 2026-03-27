import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupParcelLjRoute } from '../routes/parcel-lj.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupParcelLjRoute, pool);
});

describe('GET /parcel-lj', () => {
    it('rejects missing filters', async () => {
        const res = await request(app).get('/parcel-lj');
        expect(res.status).toBe(400);
    });

    it('rejects invalid bbox filters', async () => {
        const res = await request(app).get('/parcel-lj?bbox=14.5,46.05,14.51');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in WGS84.' });
    });

    it('returns 404 when no ljubljana parcels match', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-lj?parcel_id=SI-123');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'No parcels found for the provided filters.' });
    });

    it('returns 500 when ljubljana parcel lookup fails', async () => {
        pool.query = async () => {
            throw new Error('lj lookup failed');
        };

        const res = await request(app).get('/parcel-lj?parcel_id=SI-123');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch Ljubljana parcels.' });
    });

    it('returns ljubljana parcel features', async () => {
        pool.setResults([
            {
                rows: [{
                    eid_parcela: '123',
                    parcela_id: 'p1',
                    ko_id: 1,
                    naziv: 'KO Center',
                    st_parcele: '15',
                    povrsina: 80,
                    upravni_status_id: 1,
                    grad_parc: null,
                    omejitev: null,
                    skupni_del_etazna: null,
                    date_added: null,
                    calculated_area: 80,
                    geometry: { type: 'Polygon', coordinates: [[[14.5, 46.05], [14.51, 46.05], [14.51, 46.04], [14.5, 46.05]]] }
                }],
                rowCount: 1
            },
            { rows: [], rowCount: 0 }
        ]);

        const res = await request(app).get('/parcel-lj?parcel_id=SI-123');
        expect(res.status).toBe(200);
        expect(res.body.features[0].properties.parcelId).toBe('SI-123');
    });

    it('supports ko-only queries with limit', async () => {
        pool.setResults([
            {
                rows: [{
                    eid_parcela: '123',
                    parcela_id: 'p1',
                    ko_id: 1,
                    naziv: 'KO Center',
                    st_parcele: '15',
                    povrsina: 80,
                    upravni_status_id: 1,
                    grad_parc: null,
                    omejitev: null,
                    skupni_del_etazna: null,
                    date_added: null,
                    calculated_area: 80,
                    geometry: { type: 'Polygon', coordinates: [[[14.5, 46.05], [14.51, 46.05], [14.51, 46.04], [14.5, 46.05]]] }
                }],
                rowCount: 1
            },
            { rows: [], rowCount: 0 }
        ]);

        const res = await request(app).get('/parcel-lj?ko_id=1&limit=2');

        expect(res.status).toBe(200);
        expect(res.body.query.type).toBe('all');
        expect(res.body.query.ko_id).toBe('1');
        expect(res.body.query.limit).toBe(2);
        expect(pool.getCalls()[0].params).toEqual(['1', 2]);
    });

    it('returns parcels even when batch ownership enrichment fails', async () => {
        let callCount = 0;
        pool.query = async () => {
            callCount += 1;
            if (callCount === 1) {
                return {
                    rows: [{
                        eid_parcela: '123',
                        parcela_id: 'p1',
                        ko_id: 1,
                        naziv: 'KO Center',
                        st_parcele: '15',
                        povrsina: 80,
                        upravni_status_id: 1,
                        grad_parc: null,
                        omejitev: null,
                        skupni_del_etazna: null,
                        date_added: null,
                        calculated_area: 80,
                        geometry: { type: 'Polygon', coordinates: [[[14.5, 46.05], [14.51, 46.05], [14.51, 46.04], [14.5, 46.05]]] }
                    }],
                    rowCount: 1
                };
            }
            throw new Error('ownership batch failed');
        };

        const res = await request(app).get('/parcel-lj?parcel_id=SI-123');

        expect(res.status).toBe(200);
        expect(res.body.features[0].properties).not.toHaveProperty('ownershipList');
    });
});

describe('GET /parcel-lj/:parcelId/ownership', () => {
    it('returns 404 when ljubljana ownership is missing', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-lj/SI-123/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested parcelId.' });
    });

    it('returns 500 when ljubljana ownership lookup fails', async () => {
        pool.query = async () => {
            throw new Error('lj ownership failed');
        };

        const res = await request(app).get('/parcel-lj/SI-123/ownership');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch Ljubljana ownership data.' });
    });

    it('returns ownership data for a valid parcel id', async () => {
        pool.setResult({
            rows: [{
                eid_parcela: '123',
                ko_id: 1,
                naziv: 'KO Center',
                st_parcele: '15',
                povrsina: 80,
                oseba_id: '42',
                share_num: 1,
                share_den: 1,
                meta: { ime: 'Janez Novak' }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-lj/SI-123/ownership');
        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe('SI-123');
        expect(res.body.ownershipList).toHaveLength(1);
    });

    it('returns an unknown-owner placeholder when no ownership rows are present', async () => {
        pool.setResult({
            rows: [{
                eid_parcela: '123',
                ko_id: 1,
                naziv: 'KO Center',
                st_parcele: '15',
                povrsina: 80,
                oseba_id: null,
                share_num: null,
                share_den: null,
                meta: null
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-lj/SI-123/ownership');

        expect(res.status).toBe(200);
        expect(res.body.possessionSheets[0].possessors[0].name).toBe('Unknown owner');
    });
});