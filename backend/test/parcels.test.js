import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
    buildCityOwnershipFlag,
    buildOwnershipSummary,
    buildOwnershipType,
    pickOwnershipFields,
    setupParcelsRoute
} from '../routes/parcels.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupParcelsRoute, pool);
});

describe('ownership helpers', () => {
    it('normalizes fractional and percentage shares into a consistent 100 percent distribution', () => {
        const summary = buildOwnershipSummary({
            upisaneOsobe: [
                { naziv: 'Owner A', udio: '1/3' },
                { naziv: 'Owner B', udio: '2/3' }
            ]
        });

        expect(summary).toEqual({
            ownershipList: [
                { ownerLabel: 'Owner A', percentageShare: 33.3333 },
                { ownerLabel: 'Owner B', percentageShare: 66.6667 }
            ],
            ownershipType: 'private individual'
        });

        const percentageSummary = buildOwnershipSummary({
            upisaneOsobe: [
                { naziv: 'Owner A', udio: '25%' },
                { naziv: 'Owner B', udio: '75%' }
            ]
        });

        expect(percentageSummary.ownershipList).toEqual([
            { ownerLabel: 'Owner A', percentageShare: 25 },
            { ownerLabel: 'Owner B', percentageShare: 75 }
        ]);
    });

    it('falls back to equal shares when raw ownership values are missing or malformed', () => {
        const summary = buildOwnershipSummary({
            upisaneOsobe: [
                { naziv: 'Owner A', udio: 'abc' },
                { naziv: 'Owner B', udio: '1/0' }
            ]
        });

        expect(summary).toEqual({
            ownershipList: [
                { ownerLabel: 'Owner A', percentageShare: 50 },
                { ownerLabel: 'Owner B', percentageShare: 50 }
            ],
            ownershipType: 'private individual'
        });
    });

    it('classifies uniform and mixed ownership types with accent-insensitive matching', () => {
        expect(buildOwnershipType({
            upisaneOsobe: [
                { naziv: 'Grad Zagreb', udio: '1/1' },
                { naziv: 'Republika Hrvatska', udio: '1/1' }
            ]
        })).toBe('government');

        expect(buildOwnershipType({
            upisaneOsobe: [
                { naziv: 'Župa Svetog Marka', udio: '1/2' },
                { naziv: 'Grad Zagreb', udio: '1/2' }
            ]
        })).toBe('mixed');

        expect(buildOwnershipType({ upisaneOsobe: [] })).toBeNull();
    });

    it('marks Zagreb city ownership broadly across uppercase, declension, and long public-good labels', () => {
        expect(buildCityOwnershipFlag({
            upisaneOsobe: [
                { naziv: 'GRAD ZAGREB', udio: '1/1' }
            ]
        }, { city: 'zagreb' })).toBe(true);

        expect(buildCityOwnershipFlag({
            upisaneOsobe: [
                {
                    naziv: 'JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRADA ZAGREBA, OIB: 61817894937, TRG STJEPANA RADIĆA 1, ZAGREB',
                    udio: '1/1'
                }
            ]
        }, { city: 'zagreb' })).toBe(true);

        expect(buildOwnershipType({
            upisaneOsobe: [
                {
                    naziv: 'JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRADA ZAGREBA, OIB: 61817894937, TRG STJEPANA RADIĆA 1, ZAGREB',
                    udio: '1/1'
                }
            ]
        })).toBe('government');
    });

    it('normalizes possession sheets and numeric share strings from alternate ownership payloads', () => {
        const summary = buildOwnershipSummary({
            possessionSheets: [{
                possession_sheet_id: 'ps-1',
                cad_municipality_name: 'Center',
                possessors: [
                    {
                        possessorName: 'Župa Sv. Marka',
                        condominiumShareNumber: '0.25',
                        place: 'Ilica 1'
                    },
                    {
                        name: 'ACME d.o.o.',
                        actualShareText: '75',
                        address: 'Savska 2'
                    }
                ]
            }]
        });

        expect(summary).toEqual({
            ownershipList: [
                { ownerLabel: 'Župa Sv. Marka', percentageShare: 25 },
                { ownerLabel: 'ACME d.o.o.', percentageShare: 75 }
            ],
            ownershipType: 'mixed'
        });
    });

    it('falls back to the owners array when structured ownership records are absent', () => {
        const summary = buildOwnershipSummary({
            owners: [
                { name: 'Owner A', actualShareText: '0.4' },
                { name: 'Owner B', ownership: '60%' },
                { name: '   ' }
            ]
        });

        expect(summary).toEqual({
            ownershipList: [
                { ownerLabel: 'Owner A', percentageShare: 40 },
                { ownerLabel: 'Owner B', percentageShare: 60 }
            ],
            ownershipType: 'private individual'
        });
    });

    it('returns null for invalid ownership payload shapes', () => {
        expect(buildOwnershipSummary(null)).toBeNull();
        expect(buildOwnershipSummary({ owners: [{ name: '   ' }] })).toBeNull();
        expect(buildOwnershipType(null)).toBeNull();
        expect(buildOwnershipType({ possessionSheets: [{ possessors: [{ name: '   ' }] }] })).toBeNull();
    });

    it('maps ownership payloads onto the public parcel ownership shape', () => {
        const ownership = pickOwnershipFields({
            parcelId: '123',
            parcelNumber: '7396',
            cadMunicipalityName: 'Zagreb',
            parcelLinks: ['a'],
            possessionSheets: [{
                possession_sheet_id: 'ps-1',
                cad_municipality_name: 'Center',
                possessors: [
                    {
                        possessorName: 'Owner A',
                        condominiumShareOwnership: '1/2',
                        place: 'Ilica 1'
                    },
                    null,
                    {
                        name: 'Owner B',
                        ownership: '1/2'
                    }
                ]
            }]
        }, '999');

        expect(ownership).toEqual({
            parcelId: 123,
            parcelNumber: '7396',
            cadMunicipalityName: 'Zagreb',
            parcelLinks: ['a'],
            possessionSheets: [{
                possessionSheetId: 'ps-1',
                possessionSheetNumber: null,
                cadMunicipalityId: null,
                cadMunicipalityName: 'Center',
                possessors: [
                    {
                        name: 'Owner A',
                        address: 'Ilica 1',
                        ownership: '1/2'
                    },
                    {
                        name: 'Owner B',
                        ownership: '1/2'
                    }
                ]
            }]
        });
    });
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

    it('looks up parcel_info by logical parcel keys for parcelIds batches', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels/parcelIds?ids=HR-339318-7396');

        expect(res.status).toBe(200);
        expect(pool.getCalls()[0].sql).toContain('pi.maticni_broj_ko = p.maticni_broj_ko');
        expect(pool.getCalls()[0].sql).toContain('pi.broj_cestice = p.broj_cestice');
        expect(pool.getCalls()[0].sql).not.toContain('pi.cestica_id = p.cestica_id');
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

    it('uses a per-parcel lateral ownership lookup for bbox queries', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels?bbox=458500,5073000,459000,5073500');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls()[0].sql).toContain('LEFT JOIN LATERAL');
        expect(pool.getCalls()[0].sql).toContain('pi.maticni_broj_ko = p.maticni_broj_ko');
        expect(pool.getCalls()[0].sql).not.toContain('WITH parcel_detail_with_keys');
    });

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

    it('queries numeric parcel_id selectors directly without logical-id resolution', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels?parcel_id=123');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls()).toHaveLength(1);
        expect(pool.getCalls()[0].params).toEqual([123]);
        expect(pool.getCalls()[0].sql).toContain('p.CESTICA_ID IN ($1)');
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

    it('accepts numeric parcel ids on neighbours routes without parcel-id resolution lookups', async () => {
        pool.setResults([
            { rows: [{ '?column?': 1 }], rowCount: 1 },
            { rows: [], rowCount: 0 }
        ]);

        const res = await request(app).get('/parcels/123/neighbours');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls()).toHaveLength(2);
        expect(pool.getCalls()[0].sql).toContain('SELECT 1 FROM parcel');
        expect(pool.getCalls()[0].params).toEqual([123]);
        expect(pool.getCalls()[1].sql).toContain('WITH target AS');
        expect(pool.getCalls()[1].params).toEqual([123]);
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
        expect(pool.getCalls()[2].sql).toContain('ORDER BY version DESC');
        expect(pool.getCalls()[2].sql).not.toContain('DISTINCT ON (cestica_id)');
    });

    it('accepts numeric ownership paths without a logical parcel-id lookup', async () => {
        pool.setResults([
            {
                rows: [{ maticni_broj_ko: 339318, broj_cestice: '7396' }],
                rowCount: 1
            },
            {
                rows: [{
                    details: {
                        parcelId: 123,
                        upisaneOsobe: [{ naziv: 'Private Owner', udio: '1/1' }]
                    }
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/parcels/123/ownership');

        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe(123);
        expect(pool.getCalls()).toHaveLength(2);
        expect(pool.getCalls()[0].params).toEqual([123]);
        expect(pool.getCalls()[1].params).toEqual([339318, '7396']);
    });

    it('strips parcel-part suffixes from logical parcel ids before ownership lookups', async () => {
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
                        upisaneOsobe: [{ naziv: 'Private Owner', udio: '1/1' }]
                    }
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/parcels/HR-339318-7396/2/ownership');

        expect(res.status).toBe(200);
        expect(res.body.parcelId).toBe(123);
        expect(pool.getCalls()[0].params).toEqual(['7396', 339318]);
        expect(pool.getCalls()[1].params).toEqual([123]);
        expect(pool.getCalls()[2].params).toEqual([339318, '7396']);
    });

    it('returns 404 when ownership lookup cannot resolve a parcel id', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/parcels/HR-339318-7396/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested parcel.' });
    });

    it('returns 404 when cached ownership rows exist but the details payload is empty', async () => {
        pool.setResults([
            {
                rows: [{ maticni_broj_ko: 339318, broj_cestice: '7396' }],
                rowCount: 1
            },
            {
                rows: [{ details: null }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/parcels/123/ownership');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ownership data not found for the requested parcel.' });
    });

    it('maps malformed cached ownership payload JSON to a 502 response', async () => {
        pool.setResults([
            {
                rows: [{ maticni_broj_ko: 339318, broj_cestice: '7396' }],
                rowCount: 1
            },
            {
                rows: [{ details: '{bad json' }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/parcels/123/ownership');

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'Failed to retrieve parcel ownership information.' });
    });

    it('maps non-object cached ownership payloads to a 502 response', async () => {
        pool.setResults([
            {
                rows: [{ maticni_broj_ko: 339318, broj_cestice: '7396' }],
                rowCount: 1
            },
            {
                rows: [{ details: 123 }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/parcels/123/ownership');

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'Failed to retrieve parcel ownership information.' });
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
