import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createAreaMonitorTestApp } from './helpers/create-area-monitor-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

function buildPolygon() {
    return {
        type: 'Polygon',
        coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]]
    };
}

function buildMonitorRow(overrides = {}) {
    return {
        id: 1,
        name: 'Zapadni Jarunski Most',
        city_id: 'zagreb',
        polygon: buildPolygon(),
        parcel_ids: ['HR-339318-7396', 'HR-339318-7398'],
        parcel_count: 2,
        eojn_url: null,
        skyscrapercity_url: null,
        created_at: '2026-03-27T00:10:40.993Z',
        updated_at: '2026-03-27T00:10:40.993Z',
        ...overrides
    };
}

beforeEach(() => {
    pool = createMockPool();
    app = createAreaMonitorTestApp(pool);
});

describe('POST /area-monitors', () => {
    it('rejects invalid request bodies and malformed names', async () => {
        const invalidBody = await request(app)
            .post('/area-monitors')
            .set('Content-Type', 'application/json')
            .send('"invalid"');

        expect(invalidBody.status).toBe(400);
        expect(invalidBody.body).toEqual({});

        const invalidName = await request(app)
            .post('/area-monitors')
            .send({
                name: 123,
                polygon: buildPolygon(),
                parcelIds: ['HR-339318-1']
            });

        expect(invalidName.status).toBe(400);
        expect(invalidName.body).toEqual({ error: 'name must be a string.' });
    });

    it('accepts 400 parcels and rejects 401', async () => {
        const polygon = buildPolygon();
        const parcelIds400 = Array.from({ length: 400 }, (_, index) => `HR-339318-${index + 1}`);
        const parcelIds401 = [...parcelIds400, 'HR-339318-401'];

        pool.setResults([
            { rows: [{ cnt: 0 }], rowCount: 1 },
            {
                rows: [buildMonitorRow({ polygon, parcel_ids: parcelIds400, parcel_count: 400 })],
                rowCount: 1
            }
        ]);

        const accepted = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon,
                parcelIds: parcelIds400
            });

        expect(accepted.status).toBe(201);
        expect(accepted.body).toEqual({
            id: 1,
            name: 'Zapadni Jarunski Most',
            cityId: 'zagreb',
            createdAt: '2026-03-27T00:10:40.993Z'
        });

        const rejected = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon,
                parcelIds: parcelIds401
            });

        expect(rejected.status).toBe(400);
        expect(rejected.body).toEqual({ error: 'Maximum 400 parcels per area monitor.' });
    });

    it('creates a monitor, normalizes parcel ids, and persists optional metadata', async () => {
        const polygon = buildPolygon();
        pool.setResults([
            { rows: [{ cnt: 0 }], rowCount: 1 },
            {
                rows: [{
                    id: 7,
                    name: 'Jarun Corridor',
                    created_at: '2026-03-28T12:00:00.000Z'
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Jarun Corridor',
                polygon,
                parcelIds: ['339318-7396', 'HR-339318-7398'],
                eojnUrl: 'https://example.com/eojn/jarun',
                skyscraperCityUrl: 'https://example.com/forum/jarun',
                fingerprint: 'device_123'
            });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            id: 7,
            name: 'Jarun Corridor',
            cityId: 'zagreb',
            createdAt: '2026-03-28T12:00:00.000Z'
        });

        const calls = pool.getCalls();
        expect(calls).toHaveLength(2);
        expect(calls[0].sql).toContain('SELECT COUNT(*)::int AS cnt FROM area_monitor WHERE creator_ip = $1');
        expect(calls[1].sql).toContain('INSERT INTO area_monitor');
        expect(calls[1].params[0]).toBe('Jarun Corridor');
        expect(calls[1].params[1]).toBe(JSON.stringify(polygon));
        expect(calls[1].params[2]).toBe(JSON.stringify(['HR-339318-7396', 'HR-339318-7398']));
        expect(calls[1].params[3]).toBe(2);
        expect(calls[1].params[4]).toBe('https://example.com/eojn/jarun');
        expect(calls[1].params[5]).toBe('https://example.com/forum/jarun');
        expect(calls[1].params[6]).toBeTruthy();
        expect(calls[1].params[7]).toBe('device_123');
        expect(calls[1].params[8]).toBe('zagreb');
    });

    it('creates a monitor without a polygon (paint-mode creation)', async () => {
        pool.setResults([
            { rows: [{ cnt: 0 }], rowCount: 1 },
            {
                rows: [{ id: 9, name: 'Paint Road', created_at: '2026-04-03T10:00:00.000Z' }],
                rowCount: 1
            }
        ]);

        const res = await request(app)
            .post('/area-monitors')
            .send({ name: 'Paint Road', parcelIds: ['HR-339318-1'] });

        expect(res.status).toBe(201);
        expect(res.body.id).toBe(9);

        const calls = pool.getCalls();
        expect(calls[1].params[1]).toBeNull();
    });

    it('rejects malformed parcel ids, duplicate parcel ids, invalid urls, and unsupported fields', async () => {
        const polygon = buildPolygon();

        const invalidParcelId = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon,
                parcelIds: ['not-a-parcel-id']
            });

        expect(invalidParcelId.status).toBe(400);
        expect(invalidParcelId.body).toEqual({ error: 'All parcelIds must use HR-<maticni_broj_ko>-<broj_cestice> format.' });

        const duplicateParcelIds = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon,
                parcelIds: ['HR-339318-1', '339318-1']
            });

        expect(duplicateParcelIds.status).toBe(400);
        expect(duplicateParcelIds.body).toEqual({ error: 'parcelIds must not contain duplicates.' });

        const invalidUrl = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon,
                parcelIds: ['HR-339318-1'],
                eojnUrl: 'javascript:alert(1)'
            });

        expect(invalidUrl.status).toBe(400);
        expect(invalidUrl.body).toEqual({ error: 'eojnUrl must use http or https.' });

        const unsupportedField = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon,
                parcelIds: ['HR-339318-1'],
                injected: 'value'
            });

        expect(unsupportedField.status).toBe(400);
        expect(unsupportedField.body).toEqual({ error: 'Request body contains unsupported fields.' });
    });

    it('accepts a supported cityId and rejects an unsupported one', async () => {
        pool.setResults([
            { rows: [{ cnt: 0 }], rowCount: 1 },
            {
                rows: [{
                    id: 8,
                    name: 'Belgrade Test Monitor',
                    created_at: '2026-03-28T13:00:00.000Z'
                }],
                rowCount: 1
            }
        ]);

        const accepted = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Belgrade Test Monitor',
                cityId: 'belgrade',
                polygon: buildPolygon(),
                parcelIds: ['HR-339318-1']
            });

        expect(accepted.status).toBe(201);
        expect(accepted.body).toEqual({
            id: 8,
            name: 'Belgrade Test Monitor',
            cityId: 'belgrade',
            createdAt: '2026-03-28T13:00:00.000Z'
        });
        expect(pool.getCalls()[1].params[8]).toBe('belgrade');

        const rejected = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Belgrade Test Monitor',
                cityId: 'atlantis',
                polygon: buildPolygon(),
                parcelIds: ['HR-339318-1']
            });

        expect(rejected.status).toBe(400);
        expect(rejected.body).toEqual({ error: 'cityId must be one of: zagreb, belgrade, ljubljana, buenos_aires, colorado, new_york.' });
    });

    it('rejects invalid polygon coordinate payloads', async () => {
        const invalidPolygon = {
            type: 'Polygon',
            coordinates: [[[999, 45.79], [15.91, 45.79], [15.91, 45.78], [999, 45.79]]]
        };

        const res = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon: invalidPolygon,
                parcelIds: ['HR-339318-1']
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid polygon. Expected a valid GeoJSON Polygon with a closed ring.' });
    });

    it('rejects requests when the ip monitor cap is reached', async () => {
        pool.setResult({ rows: [{ cnt: 20 }], rowCount: 1 });

        const res = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon: buildPolygon(),
                parcelIds: ['HR-339318-1']
            });

        expect(res.status).toBe(429);
        expect(res.body).toEqual({ error: 'Maximum 20 area monitors per IP address.' });
    });

    it('rejects invalid fingerprints and control characters in names', async () => {
        const invalidFingerprint = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon: buildPolygon(),
                parcelIds: ['HR-339318-1'],
                fingerprint: 'bad value!'
            });

        expect(invalidFingerprint.status).toBe(400);
        expect(invalidFingerprint.body).toEqual({ error: 'fingerprint contains invalid characters.' });

        const invalidName = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni\u0000Jarunski Most',
                polygon: buildPolygon(),
                parcelIds: ['HR-339318-1']
            });

        expect(invalidName.status).toBe(400);
        expect(invalidName.body).toEqual({ error: 'Name contains invalid control characters.' });
    });

    it('returns 500 when monitor creation fails after validation', async () => {
        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT COUNT(*)::int AS cnt FROM area_monitor')) {
                return { rows: [{ cnt: 0 }], rowCount: 1 };
            }
            throw new Error('insert failed');
        };

        const res = await request(app)
            .post('/area-monitors')
            .send({
                name: 'Zapadni Jarunski Most',
                polygon: buildPolygon(),
                parcelIds: ['HR-339318-1']
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to create area monitor.' });
    });

    it('applies the create limiter after repeated successful requests from the same ip', async () => {
        app.set('trust proxy', true);
        // Limiter is `max: 10` per hour (routes/area-monitors.js); attempt 11 should trip it.
        const successResults = [];
        for (let i = 1; i <= 10; i += 1) {
            successResults.push({ rows: [{ cnt: 0 }], rowCount: 1 });
            successResults.push({ rows: [{ id: i, name: `Monitor ${i}`, created_at: `2026-03-28T12:00:${String(i - 1).padStart(2, '0')}.000Z` }], rowCount: 1 });
        }
        pool.setResults(successResults);

        for (let attempt = 0; attempt < 10; attempt += 1) {
            const res = await request(app)
                .post('/area-monitors')
                .set('X-Forwarded-For', '203.0.113.10')
                .send({
                    name: `Monitor ${attempt + 1}`,
                    polygon: buildPolygon(),
                    parcelIds: [`HR-339318-${attempt + 1}`]
                });

            expect(res.status).toBe(201);
        }

        const limited = await request(app)
            .post('/area-monitors')
            .set('X-Forwarded-For', '203.0.113.10')
            .send({
                name: 'Monitor 11',
                polygon: buildPolygon(),
                parcelIds: ['HR-339318-11']
            });

        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({ error: 'Too many area monitors created. Try again later.' });
    });
});

describe('GET /area-monitors/:id', () => {
    it('builds ownership summaries from parcel_info matched by logical parcel keys', async () => {
        pool.setResults([
            {
                rows: [buildMonitorRow()],
                rowCount: 1
            },
            {
                rows: [
                    { parcel_id: 'HR-339318-7396' },
                    { parcel_id: 'HR-339318-7398' }
                ],
                rowCount: 2
            },
            {
                rows: [{
                    maticni_broj_ko: 339318,
                    broj_cestice: '7396',
                    details: {
                        upisaneOsobe: [{
                            naziv: 'GRAD ZAGREB',
                            udio: '1/1'
                        }]
                    }
                }],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.summary).toEqual({
            total: 2,
            cityOwned: 1,
            governmentOwned: 1,
            remaining: 1
        });
        expect(res.body.monitor.cityId).toBe('zagreb');
        expect(res.body.parcels).toEqual([
            { parcelId: 'HR-339318-7396', ownershipType: 'government', cityOwned: true },
            { parcelId: 'HR-339318-7398', ownershipType: null, cityOwned: false }
        ]);

        const calls = pool.getCalls();
        expect(calls).toHaveLength(3);
        expect(calls[1].sql).toContain('FROM parcel p');
        expect(calls[2].sql).toContain('FROM parcel_info pi');
    });

    it('parses string ownership payloads and classifies non-government owners', async () => {
        pool.setResults([
            {
                rows: [buildMonitorRow({ parcel_ids: ['HR-339318-7396', 'HR-339318-7398'] })],
                rowCount: 1
            },
            {
                rows: [
                    { parcel_id: 'HR-339318-7396' },
                    { parcel_id: 'HR-339318-7398' }
                ],
                rowCount: 2
            },
            {
                rows: [
                    {
                        maticni_broj_ko: 339318,
                        broj_cestice: '7396',
                        details: JSON.stringify({
                            upisaneOsobe: [{ naziv: 'Crkva Sv. Marka', udio: '1/1' }]
                        })
                    },
                    {
                        maticni_broj_ko: 339318,
                        broj_cestice: '7398',
                        details: JSON.stringify({
                            upisaneOsobe: [{ naziv: 'ACME d.o.o.', udio: '1/1' }]
                        })
                    }
                ],
                rowCount: 2
            }
        ]);

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.parcels).toEqual([
            { parcelId: 'HR-339318-7396', ownershipType: 'institution', cityOwned: false },
            { parcelId: 'HR-339318-7398', ownershipType: 'company', cityOwned: false }
        ]);
        expect(res.body.summary).toEqual({
            total: 2,
            cityOwned: 0,
            governmentOwned: 0,
            remaining: 2
        });
    });

    it('treats Zagreb city ownership separately from generic government owners', async () => {
        pool.setResults([
            {
                rows: [buildMonitorRow({ parcel_ids: ['HR-339318-5943/6', 'HR-339318-7398'] })],
                rowCount: 1
            },
            {
                rows: [
                    { parcel_id: 'HR-339318-5943/6' },
                    { parcel_id: 'HR-339318-7398' }
                ],
                rowCount: 2
            },
            {
                rows: [
                    {
                        maticni_broj_ko: 339318,
                        broj_cestice: '5943/6',
                        details: JSON.stringify({
                            upisaneOsobe: [{
                                naziv: 'JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRADA ZAGREBA, OIB: 61817894937, TRG STJEPANA RADIĆA 1, ZAGREB',
                                udio: '1/1'
                            }]
                        })
                    },
                    {
                        maticni_broj_ko: 339318,
                        broj_cestice: '7398',
                        details: JSON.stringify({
                            upisaneOsobe: [{ naziv: 'REPUBLIKA HRVATSKA', udio: '1/1' }]
                        })
                    }
                ],
                rowCount: 2
            }
        ]);

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.parcels).toEqual([
            { parcelId: 'HR-339318-5943/6', ownershipType: 'government', cityOwned: true },
            { parcelId: 'HR-339318-7398', ownershipType: 'government', cityOwned: false }
        ]);
        expect(res.body.summary).toEqual({
            total: 2,
            cityOwned: 1,
            governmentOwned: 1,
            remaining: 1
        });
    });

    it('expands stored monitor parcel ids from polygon intersections before computing ownership', async () => {
        pool.setResults([
            {
                rows: [buildMonitorRow({ parcel_ids: ['HR-339318-7398'], parcel_count: 1 })],
                rowCount: 1
            },
            {
                rows: [
                    { parcel_id: 'HR-339318-5943/6' },
                    { parcel_id: 'HR-339318-7398' }
                ],
                rowCount: 2
            },
            {
                rows: [
                    {
                        maticni_broj_ko: 339318,
                        broj_cestice: '5943/6',
                        details: JSON.stringify({
                            upisaneOsobe: [{ naziv: 'GRAD ZAGREB', udio: '1/1' }]
                        })
                    },
                    {
                        maticni_broj_ko: 339318,
                        broj_cestice: '7398',
                        details: JSON.stringify({
                            upisaneOsobe: [{ naziv: 'ACME d.o.o.', udio: '1/1' }]
                        })
                    }
                ],
                rowCount: 2
            }
        ]);

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.monitor.parcelIds).toEqual(['HR-339318-5943/6', 'HR-339318-7398']);
        expect(res.body.monitor.parcelCount).toBe(2);
        expect(res.body.parcels).toEqual([
            { parcelId: 'HR-339318-5943/6', ownershipType: 'government', cityOwned: true },
            { parcelId: 'HR-339318-7398', ownershipType: 'company', cityOwned: false }
        ]);
        expect(res.body.summary).toEqual({
            total: 2,
            cityOwned: 1,
            governmentOwned: 1,
            remaining: 1
        });
    });

    it('returns 400 for an invalid monitor id', async () => {
        const res = await request(app).get('/area-monitors/not-a-number');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid area monitor ID.' });
    });

    it('returns 404 when the monitor is missing', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/area-monitors/999');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Area monitor not found.' });
    });

    it('falls back to null ownership types when ownership lookup fails', async () => {
        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT * FROM area_monitor')) {
                return { rows: [buildMonitorRow()], rowCount: 1 };
            }
            if (sql.includes('FROM parcel p')) {
                return {
                    rows: [
                        { parcel_id: 'HR-339318-7396' },
                        { parcel_id: 'HR-339318-7398' }
                    ],
                    rowCount: 2
                };
            }
            throw new Error('ownership lookup failed');
        };

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.parcels).toEqual([
            { parcelId: 'HR-339318-7396', ownershipType: null, cityOwned: false },
            { parcelId: 'HR-339318-7398', ownershipType: null, cityOwned: false }
        ]);
        expect(res.body.summary).toEqual({ total: 2, cityOwned: 0, governmentOwned: 0, remaining: 2 });
    });

    it('returns null ownership types when parcel_info table is missing', async () => {
        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT * FROM area_monitor')) {
                return { rows: [buildMonitorRow()], rowCount: 1 };
            }
            if (sql.includes('FROM parcel p')) {
                return {
                    rows: [
                        { parcel_id: 'HR-339318-7396' },
                        { parcel_id: 'HR-339318-7398' }
                    ],
                    rowCount: 2
                };
            }
            const error = new Error('missing table');
            error.code = '42P01';
            throw error;
        };

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.parcels).toEqual([
            { parcelId: 'HR-339318-7396', ownershipType: null, cityOwned: false },
            { parcelId: 'HR-339318-7398', ownershipType: null, cityOwned: false }
        ]);
        expect(res.body.summary).toEqual({ total: 2, cityOwned: 0, governmentOwned: 0, remaining: 2 });
    });

    it('returns empty parcel summaries when the stored monitor has no parcel ids', async () => {
        pool.setResult({
            rows: [buildMonitorRow({ parcel_ids: null, parcel_count: 0 })],
            rowCount: 1
        });

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.parcels).toEqual([]);
        expect(res.body.summary).toEqual({ total: 0, cityOwned: 0, governmentOwned: 0, remaining: 0 });
    });

    it('falls back to inferred zagreb cityId for legacy monitors without a stored city_id', async () => {
        pool.setResult({
            rows: [buildMonitorRow({ city_id: null })],
            rowCount: 1
        });

        const res = await request(app).get('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.body.monitor.cityId).toBe('zagreb');
    });
});

describe('GET /area-monitors', () => {
    it('lists monitors ordered by update time', async () => {
        pool.setResult({
            rows: [
                buildMonitorRow(),
                buildMonitorRow({ id: 2, name: 'Vukovarska Corridor', parcel_count: 5 })
            ],
            rowCount: 2
        });

        const res = await request(app).get('/area-monitors');

        expect(res.status).toBe(200);
        expect(res.body.monitors).toEqual([
            {
                id: 1,
                name: 'Zapadni Jarunski Most',
                parcelCount: 2,
                createdAt: '2026-03-27T00:10:40.993Z',
                updatedAt: '2026-03-27T00:10:40.993Z'
            },
            {
                id: 2,
                name: 'Vukovarska Corridor',
                parcelCount: 5,
                createdAt: '2026-03-27T00:10:40.993Z',
                updatedAt: '2026-03-27T00:10:40.993Z'
            }
        ]);

        expect(pool.getCalls()).toHaveLength(1);
        expect(pool.getCalls()[0].sql).toContain('FROM area_monitor');
        expect(pool.getCalls()[0].sql).toContain('ORDER BY updated_at DESC');
    });

    it('returns 500 when listing monitors fails', async () => {
        pool.query = async () => {
            throw new Error('listing failed');
        };

        const res = await request(app).get('/area-monitors');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to list area monitors.' });
    });
});

describe('HEAD /area-monitors/:id', () => {
    it('returns last-modified header when found', async () => {
        pool.setResult({
            rows: [{ id: 1, updated_at: '2026-03-27T00:10:40.993Z' }],
            rowCount: 1
        });

        const res = await request(app).head('/area-monitors/1');

        expect(res.status).toBe(200);
        expect(res.headers['last-modified']).toBe(new Date('2026-03-27T00:10:40.993Z').toUTCString());
    });

    it('returns 400 for an invalid monitor id', async () => {
        const res = await request(app).head('/area-monitors/nope');

        expect(res.status).toBe(400);
    });

    it('returns 404 when the monitor is missing', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).head('/area-monitors/999');

        expect(res.status).toBe(404);
    });

    it('returns 500 when the existence lookup fails', async () => {
        pool.query = async () => {
            throw new Error('head failed');
        };

        const res = await request(app).head('/area-monitors/1');

        expect(res.status).toBe(500);
    });
});

describe('GET /area-monitors/:id/overlay', () => {
    it('returns a feature collection for overlay geometry', async () => {
        pool.setResults([
            {
                rows: [{ id: 1, polygon: buildPolygon() }],
                rowCount: 1
            },
            {
                rows: [
                    {
                        parcel_id: 'HR-339318-7396',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[[15.9, 45.79], [15.905, 45.79], [15.905, 45.785], [15.9, 45.79]]]
                        }
                    }
                ],
                rowCount: 1
            }
        ]);

        const res = await request(app).get('/area-monitors/1/overlay');

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('FeatureCollection');
        expect(res.body.features).toEqual([
            {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [[[15.9, 45.79], [15.905, 45.79], [15.905, 45.785], [15.9, 45.79]]]
                },
                properties: {
                    parcelId: 'HR-339318-7396'
                }
            }
        ]);

        const calls = pool.getCalls();
        expect(calls).toHaveLength(2);
        expect(calls[1].sql).toContain('WITH monitor_geom AS');
    });

    it('returns 400 for an invalid monitor id', async () => {
        const res = await request(app).get('/area-monitors/nope/overlay');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid area monitor ID.' });
    });

    it('returns 404 when the monitor is missing', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/area-monitors/999/overlay');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Area monitor not found.' });
    });

    it('returns 500 when the stored polygon is invalid', async () => {
        pool.setResult({
            rows: [{ id: 1, polygon: { type: 'Polygon', coordinates: [] } }],
            rowCount: 1
        });

        const res = await request(app).get('/area-monitors/1/overlay');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Stored monitor polygon is invalid.' });
    });

    it('filters out overlay rows without geometry', async () => {
        pool.setResults([
            {
                rows: [{ id: 1, polygon: buildPolygon() }],
                rowCount: 1
            },
            {
                rows: [
                    { parcel_id: 'HR-339318-7396', geometry: null },
                    {
                        parcel_id: 'HR-339318-7398',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[[15.9, 45.79], [15.905, 45.79], [15.905, 45.785], [15.9, 45.79]]]
                        }
                    }
                ],
                rowCount: 2
            }
        ]);

        const res = await request(app).get('/area-monitors/1/overlay');

        expect(res.status).toBe(200);
        expect(res.body.features).toEqual([
            {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [[[15.9, 45.79], [15.905, 45.79], [15.905, 45.785], [15.9, 45.79]]]
                },
                properties: { parcelId: 'HR-339318-7398' }
            }
        ]);
    });

    it('returns 500 when overlay geometry generation fails', async () => {
        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            if (sql.includes('SELECT id, polygon FROM area_monitor')) {
                return { rows: [{ id: 1, polygon: buildPolygon() }], rowCount: 1 };
            }
            throw new Error('overlay failed');
        };

        const res = await request(app).get('/area-monitors/1/overlay');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to fetch area monitor overlay.' });
    });
});
