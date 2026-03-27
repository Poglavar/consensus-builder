import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupParcelsRoute } from '../routes/parcels.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupParcelsRoute, pool);
});

describe('GET /parcels/parcelIds', () => {
    it('rejects missing ids', async () => {
        const res = await request(app).get('/parcels/parcelIds');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Missing required parameter ids (comma-separated parcelIds).' });
    });

    it('returns parcel features for valid parcel ids', async () => {
        pool.setResult({
            rows: [{
                cestica_id: 123,
                broj_cestice: '7396',
                maticni_broj_ko: 339318,
                parcelid: 'HR-339318-7396',
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                calculated_area: 42,
                ownership_details: {
                    upisaneOsobe: [{ naziv: 'GRAD ZAGREB', udio: '1/1' }]
                }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcels/parcelIds?ids=HR-339318-7396');

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('FeatureCollection');
        expect(res.body.features).toHaveLength(1);
        expect(res.body.features[0].properties.parcelId).toBe('HR-339318-7396');
        expect(res.body.features[0].properties.ownershipType).toBe('government');
    });

    it('rejects invalid parcelId formats', async () => {
        const res = await request(app).get('/parcels/parcelIds?ids=bad-id');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'No valid parcelIds provided. Expected HR-<maticni_broj_ko>-<broj_cestice> format.' });
    });

    it('rejects mixed valid and invalid parcelIds', async () => {
        const res = await request(app).get('/parcels/parcelIds?ids=HR-339318-7396,bad-id');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'No valid parcelIds provided. Expected HR-<maticni_broj_ko>-<broj_cestice> format.' });
    });

    it('returns 500 when batch parcel lookup fails', async () => {
        pool.query = async () => {
            throw new Error('parcel batch offline');
        };

        const res = await request(app).get('/parcels/parcelIds?ids=HR-339318-7396');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});

describe('GET /parcels', () => {
    it('rejects requests without a selector parameter', async () => {
        const res = await request(app).get('/parcels');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Missing required parameter. Provide either bbox, coordinates, parcel_number, parcel_identifier, or parcel_id.' });
    });

    it('rejects requests with multiple selector parameters', async () => {
        const res = await request(app).get('/parcels?bbox=1,2,3,4&coordinates=1,2');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Provide only one parameter: bbox, coordinates, parcel_number, parcel_identifier, or parcel_id.' });
    });

    it('returns a feature collection for WGS84 coordinates', async () => {
        pool.setResult({
            rows: [{
                cestica_id: 123,
                broj_cestice: '7396',
                maticni_broj_ko: 339318,
                parcelid: 'HR-339318-7396',
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                calculated_area: 42,
                ownership_details: {
                    upisaneOsobe: [{ naziv: 'Private Owner', udio: '1/1' }]
                }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcels?coordinates=15.9,45.79');

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('FeatureCollection');
        expect(res.body.features[0].properties.estimatedMarketPrice).toBe(4200);
        expect(pool.getCalls()[0].sql).toContain('ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765)');
    });

    it('rejects invalid bbox values', async () => {
        const res = await request(app).get('/parcels?bbox=1,2,3');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
    }, 10000);

    it('rejects invalid coordinate ranges', async () => {
        const res = await request(app).get('/parcels?coordinates=9999,9999');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid coordinate range. Expected WGS84 (lon,lat) or HTRS96/TM (x,y) coordinates.'
        });
    });

    it('rejects invalid parcel_identifier values', async () => {
        const res = await request(app).get('/parcels?parcel_identifier=badformat');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid parcel_identifier. Expected format parcel_number-maticni_broj_ko.' });
    });

    it('rejects non-numeric cadastral municipality ids in parcel_identifier', async () => {
        const res = await request(app).get('/parcels?parcel_identifier=7396-bad');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid parcel_identifier. Cadastral municipality id must be numeric.' });
    });

    it('uses HTRS96 coordinates without WGS84 transformation', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels?coordinates=500000,5030000');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls()[0].sql).toContain('ST_SetSRID(ST_MakePoint($1, $2), 3765)');
        expect(pool.getCalls()[0].sql).not.toContain('ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765)');
    });

    it('queries parcel_number within Zagreb cadastral municipalities', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels?parcel_number=7396');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls()[0].sql).toContain("cm.grad_opcina = 'ZAGREB'");
        expect(pool.getCalls()[0].params).toEqual(['7396']);
    });

    it('queries parcel_identifier by parcel number and cadastral municipality id', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels?parcel_identifier=7396-339318');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls()[0].params).toEqual(['7396', '339318']);
    });

    it('rejects parcel_identifier values with missing parts', async () => {
        const res = await request(app).get('/parcels?parcel_identifier=-339318');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcel_identifier. Both parcel number and cadastral municipality id are required.'
        });
    });

    it('resolves multiple parcel_ids into cestica ids before querying parcels', async () => {
        pool.setResults([
            { rows: [{ cestica_id: 123 }], rowCount: 1 },
            { rows: [], rowCount: 0 }
        ]);

        const res = await request(app).get('/parcels?parcel_id=HR-339318-7396,456');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            type: 'FeatureCollection',
            features: []
        });
        expect(pool.getCalls()[0].params).toEqual(['7396', 339318]);
        expect(pool.getCalls()[1].params).toEqual([123, 456]);
        expect(pool.getCalls()[1].sql).toContain('p.CESTICA_ID IN ($1,$2)');
    });

    it('rejects malformed parcel_id tokens instead of skipping them', async () => {
        const res = await request(app).get('/parcels?parcel_id=HR-339318-7396,bad-id');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcel_id. Expected positive numeric cestica_id values or HR-<maticni_broj_ko>-<broj_cestice>.'
        });
    });

    it('returns 400 when parcel key lookups fail and no ids can be resolved', async () => {
        pool.query = async () => {
            throw new Error('lookup failed');
        };

        const res = await request(app).get('/parcels?parcel_id=HR-339318-7396');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcel_id. Could not resolve any valid CESTICA_ID from the provided parcel_ids.'
        });
    });

    it('continues past failed parcel key lookups when another id resolves', async () => {
        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT cestica_id') && Array.isArray(params) && params[0] === '7396') {
                throw new Error('lookup failed');
            }
            return { rows: [], rowCount: 0 };
        };

        const res = await request(app).get('/parcels?parcel_id=HR-339318-7396,456');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls().at(-1).params).toEqual([456]);
    });

    it('returns features with fallback property names when row aliases differ', async () => {
        pool.setResult({
            rows: [{
                cesticaid: 321,
                brojcestice: '55/1',
                maticni_broj_ko: 999999,
                parcelid: null,
                geometry: { type: 'Point', coordinates: [15.9, 45.8] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/parcels?parcel_number=55/1');

        expect(res.status).toBe(200);
        expect(res.body.features[0].properties).toMatchObject({
            CESTICA_ID: '321',
            BROJ_CESTICE: '55/1',
            MATICNI_BROJ_KO: '999999',
            parcelId: '321',
            estimatedMarketPriceCurrency: 'EUR'
        });
        expect(res.body.features[0].properties.calculatedArea).toBeUndefined();
        expect(res.body.features[0].properties.estimatedMarketPrice).toBeUndefined();
    });

    it('returns 500 when the parcel query fails after selector validation', async () => {
        pool.query = async () => {
            throw new Error('parcel query failed');
        };

        const res = await request(app).get('/parcels?parcel_number=7396');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});

describe('GET /parcels/:parcelId/neighbours', () => {
    it('rejects malformed parcel ids before lookup', async () => {
        const res = await request(app).get('/parcels/bad-id/neighbours');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcelId path parameter. Expected a numeric cestica_id or HR-<maticni_broj_ko>-<broj_cestice>.'
        });
    });

    it('returns neighbouring parcel features when a parcel is found', async () => {
        pool.setResults([
            { rows: [{ cestica_id: 123 }], rowCount: 1 },
            { rows: [{ '?column?': 1 }], rowCount: 1 },
            {
                rows: [{
                    cestica_id: 456,
                    broj_cestice: '7397',
                    maticni_broj_ko: 339318,
                    parcelid: 'HR-339318-7397',
                    geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.905, 45.79], [15.905, 45.785], [15.9, 45.79]]] }
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/parcels/HR-339318-7396/neighbours');

        expect(res.status).toBe(200);
        expect(res.body.features).toEqual([
            {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.905, 45.79], [15.905, 45.785], [15.9, 45.79]]] },
                properties: {
                    CESTICA_ID: '456',
                    BROJ_CESTICE: '7397',
                    MATICNI_BROJ_KO: '339318',
                    parcelId: 'HR-339318-7397'
                }
            }
        ]);
    });

    it('returns 404 when the target parcel cannot be resolved', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels/HR-339318-7396/neighbours');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Parcel not found.' });
    });

    it('returns 500 when the neighbour lookup query fails', async () => {
        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT 1 FROM parcel')) {
                return { rows: [{ '?column?': 1 }], rowCount: 1 };
            }
            if (sql.includes('SELECT cestica_id')) {
                return { rows: [{ cestica_id: 123 }], rowCount: 1 };
            }
            throw new Error('neighbour lookup failed');
        };

        const res = await request(app).get('/parcels/HR-339318-7396/neighbours');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});

describe('GET /parcels/:parcelId/ownership', () => {
    it('rejects malformed parcel ids before ownership lookup', async () => {
        const res = await request(app).get('/parcels/bad-id/ownership');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid parcelId path parameter. Expected a numeric cestica_id or HR-<maticni_broj_ko>-<broj_cestice>.'
        });
    });

    it('returns ownership data when cached details exist', async () => {
        pool.setResults([
            {
                rows: [{ cestica_id: 123 }],
                rowCount: 1
            },
            {
                rows: [{ maticni_broj_ko: 339318, broj_cestice: '7396' }],
                rowCount: 1
            },
            {
                rows: [{
                    details: {
                        parcelId: 123,
                        upisaneOsobe: [{ naziv: 'GRAD ZAGREB', udio: '1/1' }]
                    }
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/parcels/HR-339318-7396/ownership');

        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe(123);
        expect(res.body.ownershipType).toBe('government');
        expect(res.body.ownershipList).toEqual([
            { ownerLabel: 'GRAD ZAGREB', percentageShare: 100 }
        ]);
    });

    it('returns 404 when ownership lookup cannot resolve a parcel id', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels/HR-339318-7396/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested parcel.' });
    });

    it('maps missing ownership tables to a 502 response', async () => {
        const missingRelation = new Error('relation missing');
        missingRelation.code = '42P01';

        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('FROM parcel\n        WHERE cestica_id')) {
                return { rows: [{ maticni_broj_ko: 339318, broj_cestice: '7396' }], rowCount: 1 };
            }
            throw missingRelation;
        };

        const res = await request(app).get('/parcels/123/ownership');

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'Failed to retrieve parcel ownership information.' });
    });

    it('maps numeric overflow lookup failures to 404', async () => {
        const overflow = new Error('numeric overflow');
        overflow.code = '22003';

        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT maticni_broj_ko, broj_cestice')) {
                const wrapped = new Error('lookup failed');
                wrapped.cause = overflow;
                wrapped.statusCode = 503;
                throw wrapped;
            }
            return { rows: [{ cestica_id: 123 }], rowCount: 1 };
        };

        const res = await request(app).get('/parcels/123/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested parcel.' });
    });

    it('maps upstream 400 ownership failures to client errors', async () => {
        const upstreamError = new Error('bad request');
        upstreamError.statusCode = 400;

        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT cestica_id')) {
                return { rows: [{ cestica_id: 123 }], rowCount: 1 };
            }
            throw upstreamError;
        };

        const res = await request(app).get('/parcels/HR-HR-339318-7396/2/ownership');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Upstream data source rejected the request.' });
    });

    it('maps timeout-like ownership failures to 504 responses', async () => {
        const timeoutError = new Error('timed out');
        timeoutError.name = 'AbortError';

        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT cestica_id')) {
                return { rows: [{ cestica_id: 123 }], rowCount: 1 };
            }
            throw timeoutError;
        };

        const res = await request(app).get('/parcels/HR-339318-7396/ownership');

        expect(res.status).toBe(504);
        expect(res.body).toEqual({ error: 'Ownership data request timed out.' });
    });
});