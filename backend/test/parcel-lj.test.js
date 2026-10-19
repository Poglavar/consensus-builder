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

    it('supports eid aliases for parcel lookups and omits list limits', async () => {
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

        const res = await request(app).get('/parcel-lj?eid=123&limit=9');

        expect(res.status).toBe(200);
        expect(res.body.query).toEqual({
            type: 'parcel',
            parcel_id: undefined,
            eid: '123',
            ko_id: undefined,
            st_parcele: undefined,
            bbox: undefined,
            limit: 9
        });
        expect(pool.getCalls()[0].params).toEqual(['123']);
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
        expect(pool.getCalls()[0].params).toEqual(['1', 3]);
    });

    it('supports ko_id and st_parcele parcel lookups', async () => {
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

        const res = await request(app).get('/parcel-lj?ko_id=1&st_parcele=15&limit=2');

        expect(res.status).toBe(200);
        expect(res.body.query).toEqual({
            type: 'parcel',
            parcel_id: undefined,
            eid: undefined,
            ko_id: '1',
            st_parcele: '15',
            bbox: undefined,
            limit: 2
        });
        expect(pool.getCalls()[0].params).toEqual(['1', '15']);
    });

    it('enriches parcel features with batch ownership data', async () => {
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
            {
                rows: [
                    { parcel_eid: '123', share_num: 1, share_den: 2, oseba_id: '42', meta: { naziv: 'City of Ljubljana' } },
                    { parcel_eid: '123', share_num: 1, share_den: 2, oseba_id: '43', meta: { ime: 'Janez Novak' } }
                ],
                rowCount: 2
            }
        ]);

        const res = await request(app).get('/parcel-lj?parcel_id=SI-123');

        expect(res.status).toBe(200);
        expect(res.body.features[0].properties.ownershipType).toBe('mixed');
        expect(res.body.features[0].properties.ownershipList).toEqual([
            { ownerLabel: 'City of Ljubljana', percentageShare: 50 },
            { ownerLabel: 'Janez Novak', percentageShare: 50 }
        ]);
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
