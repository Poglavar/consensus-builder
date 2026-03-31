import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupParcelBgRoute } from '../routes/parcel-bg.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupParcelBgRoute, pool);
});

describe('GET /parcel-bg', () => {
    it('rejects bad parcel ids', async () => {
        const res = await request(app).get('/parcel-bg?parcel_id=bad');
        expect(res.status).toBe(400);
    });

    it('rejects invalid bbox filters', async () => {
        const res = await request(app).get('/parcel-bg?bbox=20.4,44.8,20.41');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in WGS84.' });
    });

    it('returns 404 when no parcels match the filters', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-bg?parcel_id=SR-0001-123');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'No parcels found for the provided filters.' });
    });

    it('returns 500 when belgrade parcel lookup fails', async () => {
        pool.query = async () => {
            throw new Error('belgrade offline');
        };

        const res = await request(app).get('/parcel-bg?parcel_id=SR-0001-123');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch Belgrade parcels.' });
    });

    it('returns a feature collection for parcel id queries', async () => {
        pool.setResult({
            rows: [{
                cadmun_code: '0001',
                cadmun_name_cyr: 'Општина',
                cadmun_name_lat: 'Opstina',
                city_name_cyr: 'Београд',
                city_name_lat: 'Beograd',
                parcel_num: '123',
                parcel_status_code: 'A',
                parcel_status_name_cyr: 'Активна',
                parcel_status_name_lat: 'Aktivna',
                area: 50,
                calculated_area: 50,
                source_parcel_id: 'src',
                raw_feature: {},
                geometry: { type: 'Polygon', coordinates: [[[20.4, 44.8], [20.41, 44.8], [20.41, 44.79], [20.4, 44.8]]] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-bg?parcel_id=SR-0001-123');
        expect(res.status).toBe(200);
        expect(res.body.features[0].properties.parcelId).toBe('SR-0001-123');
    });

    it('supports smp aliases and omits limit for parcel queries', async () => {
        pool.setResult({
            rows: [{
                cadmun_code: '0001',
                cadmun_name_cyr: 'Општина',
                cadmun_name_lat: 'Opstina',
                city_name_cyr: 'Београд',
                city_name_lat: 'Beograd',
                parcel_num: '123',
                parcel_status_code: 'A',
                parcel_status_name_cyr: 'Активна',
                parcel_status_name_lat: 'Aktivna',
                area: 'bad',
                calculated_area: null,
                source_parcel_id: 'src',
                raw_feature: {},
                geometry: { type: 'Polygon', coordinates: [] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-bg?smp=0001-123&limit=9000');

        expect(res.status).toBe(200);
        expect(res.body.query.type).toBe('parcel');
        expect(res.body.query.parcel_id).toBe('0001-123');
        expect(res.body.query.smp).toBeUndefined();
        expect(res.body.query.limit).toBe(5000);
        expect(pool.getCalls()[0].params).toEqual(['0001', '123']);
        expect(res.body.features[0].properties.estimatedMarketPrice).toBeUndefined();
    });

    it('rejects requests without bbox, parcel_id, or cadmun filters', async () => {
        const res = await request(app).get('/parcel-bg?limit=10');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Provide bbox or parcel_id (SR-<cadmun>-<parcel_num>) to query Belgrade parcels.'
        });
    });

    it('supports cadmun and parcel_num filters without parcel ids', async () => {
        pool.setResult({
            rows: [{
                cadmun_code: '0001',
                cadmun_name_cyr: 'Општина',
                cadmun_name_lat: 'Opstina',
                city_name_cyr: 'Београд',
                city_name_lat: 'Beograd',
                parcel_num: '123',
                parcel_status_code: 'A',
                parcel_status_name_cyr: 'Активна',
                parcel_status_name_lat: 'Aktivna',
                area: 50,
                calculated_area: 50,
                source_parcel_id: 'src',
                raw_feature: {},
                geometry: { type: 'Polygon', coordinates: [] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-bg?cadmun=0001&parcel_num=123');

        expect(res.status).toBe(200);
        expect(res.body.query.type).toBe('parcel');
        expect(res.body.query.cadmun).toBe('0001');
        expect(res.body.query.parcel_num).toBe('123');
    });

    it('supports bbox queries with limit', async () => {
        pool.setResult({
            rows: [{
                cadmun_code: '0001',
                cadmun_name_cyr: 'Општина',
                cadmun_name_lat: 'Opstina',
                city_name_cyr: 'Београд',
                city_name_lat: 'Beograd',
                parcel_num: '123',
                parcel_status_code: 'A',
                parcel_status_name_cyr: 'Активна',
                parcel_status_name_lat: 'Aktivna',
                area: 50,
                calculated_area: 50,
                source_parcel_id: 'src',
                raw_feature: {},
                geometry: { type: 'Polygon', coordinates: [[[20.4, 44.8], [20.41, 44.8], [20.41, 44.79], [20.4, 44.8]]] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-bg?bbox=20.4,44.79,20.41,44.8&limit=2');

        expect(res.status).toBe(200);
        expect(res.body.query.type).toBe('bbox');
        expect(res.body.query.limit).toBe(2);
        expect(pool.getCalls()[0].params).toEqual([20.4, 44.79, 20.41, 44.8, 2]);
    });
});

describe('GET /parcel-bg/:parcelId/ownership', () => {
    it('returns 400 for invalid parcel ids', async () => {
        const res = await request(app).get('/parcel-bg/bad/ownership');
        expect(res.status).toBe(400);
    });

    it('returns 404 when ownership data is missing', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcel-bg/SR-0001-123/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested parcelId.' });
    });

    it('returns 500 when ownership lookup fails', async () => {
        pool.query = async () => {
            throw new Error('ownership offline');
        };

        const res = await request(app).get('/parcel-bg/SR-0001-123/ownership');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch Belgrade ownership data.' });
    });

    it('returns ownership data for a valid parcel id', async () => {
        pool.setResult({
            rows: [{
                cadmun_code: '0001',
                parcel_num: '123',
                information_basic: { seccion: '1', manzana: '2', parcela: '3' },
                information_technical: {},
                property_horizontal: { phs: [{ dpto: 'A', porcentual: 100, pdahorizontal: '1' }] },
                doors: null,
                date_added: null,
                date_updated: null
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-bg/SR-0001-123/ownership');
        expect(res.status).toBe(200);
        expect(res.body.smp).toBe('0001-123');
        expect(res.body.possessionSheets).toHaveLength(1);
    });

    it('falls back to an unknown owner when no unit data exists', async () => {
        pool.setResult({
            rows: [{
                cadmun_code: '0001',
                parcel_num: '123',
                information_basic: { seccion: '1', manzana: '2', parcela: '3' },
                information_technical: {},
                property_horizontal: null,
                doors: null,
                date_added: null,
                date_updated: null
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-bg/SR-0001-123/ownership');

        expect(res.status).toBe(200);
        expect(res.body.possessionSheets[0].possessors[0].name).toBe('Unknown owner');
    });

    it('accepts parcel ids without the SR prefix on ownership routes', async () => {
        pool.setResult({
            rows: [{
                cadmun_code: '0001',
                parcel_num: '123',
                information_basic: { seccion: '1', manzana: '2', parcela: '3' },
                information_technical: {},
                property_horizontal: { phs: [{ dpto: 'A', piso: '2', porcentual: 12.5, pdahorizontal: '1' }] },
                doors: null,
                date_added: null,
                date_updated: null
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcel-bg/0001-123/ownership');

        expect(res.status).toBe(200);
        expect(res.body.possessionSheets[0].possessors[0]).toMatchObject({
            name: 'dpto A',
            ownership: '1/8',
            condominiumShareOwnership: '12.5%',
            address: 'Piso 2'
        });
    });
});