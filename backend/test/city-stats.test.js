import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupCityStatsRoute } from '../routes/city-stats.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupCityStatsRoute, pool);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('GET /city-stats/cities', () => {
    it('returns 500 when city metadata lookup fails', async () => {
        pool.query = async () => {
            throw new Error('cities unavailable');
        };

        const res = await request(app).get('/city-stats/cities');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Database error' });
    });

    it('returns city snapshot metadata', async () => {
        pool.setResult({
            rows: [{
                city: 'Zagreb',
                first_snapshot: '2025-01-01',
                last_snapshot: '2025-03-01',
                snapshot_count: 3
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/cities');

        expect(res.status).toBe(200);
        expect(res.body[0].city).toBe('Zagreb');
    });
});

describe('GET /city-stats/snapshots', () => {
    it('returns 500 when snapshot lookup fails', async () => {
        pool.query = async () => {
            throw new Error('snapshots unavailable');
        };

        const res = await request(app).get('/city-stats/snapshots?city=Zagreb');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Database error' });
    });

    it('returns filtered snapshots', async () => {
        pool.setResult({
            rows: [{ city: 'Zagreb', updated_at: '2025-01-01' }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/snapshots?city=Zagreb');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ city: 'Zagreb', updated_at: '2025-01-01' }]);
        expect(pool.getCalls()[0].params).toEqual(['Zagreb']);
    });

    it('lists all snapshots when no city filter is provided', async () => {
        pool.setResult({
            rows: [{ city: 'Belgrade', updated_at: '2025-01-01' }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/snapshots');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ city: 'Belgrade', updated_at: '2025-01-01' }]);
        expect(pool.getCalls()[0].params).toEqual([]);
        expect(pool.getCalls()[0].sql).toContain('ORDER BY city, updated_at');
        expect(pool.getCalls()[0].sql).not.toContain('WHERE city = $1');
    });
});

describe('GET /city-stats/data', () => {
    it('rejects unknown metrics', async () => {
        const res = await request(app).get('/city-stats/data?metric=unknown_metric');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Unknown metric: unknown_metric' });
    });

    it('returns null eur values when fx enrichment fails', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('fx down'));
        pool.setResult({
            rows: [{
                city: 'Belgrade',
                updated_at: '2025-01-01',
                item: 'Meal, Inexpensive Restaurant',
                price: '1200 RSD'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data?metric=meal_inexpensive');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{
            city: 'Belgrade',
            updated_at: '2025-01-01',
            item: 'Meal, Inexpensive Restaurant',
            currency: 'RSD',
            fx_to_eur: null,
            value: 1200,
            value_eur: null,
            eur_error: expect.any(String)
        }]);
    });

    it('returns 500 when stats lookup fails', async () => {
        pool.query = async () => {
            throw new Error('stats unavailable');
        };

        const res = await request(app).get('/city-stats/data?metric=salary_net');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Database error' });
    });

    it('returns metric-scoped EUR data without FX lookup', async () => {
        pool.setResult({
            rows: [{
                city: 'Zagreb',
                updated_at: '2025-01-01',
                item: 'Average Monthly Net Salary (After Tax)',
                price: '1500 €'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data?metric=salary_net');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{
            city: 'Zagreb',
            updated_at: '2025-01-01',
            item: 'Average Monthly Net Salary (After Tax)',
            currency: 'EUR',
            fx_to_eur: 1,
            value: 1500,
            value_eur: 1500
        }]);
    });

    it('returns null metric values when prices cannot be parsed', async () => {
        pool.setResult({
            rows: [{
                city: 'Zagreb',
                updated_at: '2025-01-01',
                item: 'Average Monthly Net Salary (After Tax)',
                price: 'not available'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data?metric=salary_net');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{
            city: 'Zagreb',
            updated_at: '2025-01-01',
            item: 'Average Monthly Net Salary (After Tax)',
            currency: null,
            fx_to_eur: null,
            value: null,
            value_eur: null
        }]);
    });

    it('builds metric queries with city and valid date filters while ignoring invalid dates', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/city-stats/data?metric=salary_net&cities=Zagreb,Ljubljana&from=2025-01-01&to=not-a-date');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);

        const call = pool.getCalls()[0];
        expect(call.sql).toContain('entry->>\'item\' = ANY($3)');
        expect(call.sql).toContain('WHERE city = ANY($1) AND updated_at >= $2');
        expect(call.sql).not.toContain('updated_at <=');
        expect(call.params).toEqual([
            ['Zagreb', 'Ljubljana'],
            '2025-01-01',
            ['Average Monthly Net Salary (After Tax)']
        ]);
    });

    it('uses Frankfurter time-series cache for non-EUR currency metrics', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                rates: {
                    '2025-01-01': { EUR: 0.0085 }
                }
            })
        });
        vi.stubGlobal('fetch', fetchMock);

        pool.setResult({
            rows: [{
                city: 'Belgrade',
                updated_at: '2025-01-01',
                item: 'Meal, Inexpensive Restaurant',
                price: '1200 RSD'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data?metric=meal_inexpensive');

        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({
            currency: 'RSD',
            fx_to_eur: 0.0085,
            value: 1200
        });
        expect(res.body[0].value_eur).toBeCloseTo(10.2, 10);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the currency-api lookup when Frankfurter misses a metric rate', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ rates: {} })
            })
            .mockResolvedValueOnce({
                ok: false,
                json: async () => ({})
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ rsd: { eur: 0.0084 } })
            });
        vi.stubGlobal('fetch', fetchMock);

        pool.setResult({
            rows: [{
                city: 'Belgrade',
                updated_at: '2025-01-02',
                item: 'Meal, Inexpensive Restaurant',
                price: '1000 RSD'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data?metric=meal_inexpensive');

        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({
            currency: 'RSD',
            fx_to_eur: 0.0084,
            value: 1000,
            value_eur: 8.4
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries fallback FX lookups across the lookback window', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ rates: {} })
            })
            .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
            .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ rsd: { eur: 0.0081 } })
            });
        vi.stubGlobal('fetch', fetchMock);

        pool.setResult({
            rows: [{
                city: 'Belgrade',
                updated_at: '2025-01-03',
                item: 'Meal, Inexpensive Restaurant',
                price: '1000 RSD'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data?metric=meal_inexpensive');

        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({
            currency: 'RSD',
            fx_to_eur: 0.0081,
            value: 1000,
            value_eur: 8.1
        });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('reuses cached fx rates across repeated metric requests', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                rates: {
                    '2025-01-07': { EUR: 0.0025 }
                }
            })
        });
        vi.stubGlobal('fetch', fetchMock);

        pool.query = async (sql, params) => {
            pool.getCalls().push({ sql, params });
            return {
                rows: [{
                    city: 'Budapest',
                    updated_at: '2025-01-07',
                    item: 'Meal, Inexpensive Restaurant',
                    price: '4000 Ft'
                }],
                rowCount: 1
            };
        };

        const first = await request(app).get('/city-stats/data?metric=meal_inexpensive');
        const second = await request(app).get('/city-stats/data?metric=meal_inexpensive');

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(first.body[0].value_eur).toBeCloseTo(10, 10);
        expect(second.body[0].value_eur).toBeCloseTo(10, 10);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns numeric metric rows without currency conversion for non-currency metrics', async () => {
        pool.setResult({
            rows: [{
                city: 'Zagreb',
                updated_at: '2025-01-01',
                item: 'Mortgage Interest Rate in Percentages (%), Yearly, for 20 Years Fixed-Rate',
                price: '4.25'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data?metric=mortgage_rate');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{
            city: 'Zagreb',
            updated_at: '2025-01-01',
            item: 'Mortgage Interest Rate in Percentages (%), Yearly, for 20 Years Fixed-Rate',
            currency: null,
            fx_to_eur: null,
            value: 4.25,
            value_eur: null
        }]);
    });

    it('returns raw city stats rows with EUR-enriched raw data', async () => {
        pool.setResult({
            rows: [{
                city: 'Zagreb',
                updated_at: '2025-01-01',
                raw_data: {
                    prices: [{ item: 'Meal, Inexpensive Restaurant', price: '10 €' }]
                }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data?cities=Zagreb');

        expect(res.status).toBe(200);
        expect(res.body[0].currency).toBe('EUR');
        expect(res.body[0].fx_to_eur).toBe(1);
        expect(res.body[0].raw_data.prices[0].price_eur).toBe(10);
    });

    it('enriches non-EUR raw rows and defaults empty raw_data currencies to EUR', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ rates: { EUR: 0.511 } })
        });
        vi.stubGlobal('fetch', fetchMock);

        pool.setResult({
            rows: [
                {
                    city: 'Belgrade',
                    updated_at: '2025-01-09',
                    raw_data: {
                        prices: [{ item: 'Meal, Inexpensive Restaurant', price: '19.5 лв' }]
                    }
                },
                {
                    city: 'Zagreb',
                    updated_at: '2025-01-03',
                    raw_data: {}
                }
            ],
            rowCount: 2
        });

        const res = await request(app).get('/city-stats/data');

        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({
            currency: 'BGN',
            fx_to_eur: 0.511
        });
        expect(res.body[0].raw_data.prices[0].price_eur).toBeCloseTo(9.9645, 10);
        expect(res.body[1]).toMatchObject({
            currency: 'EUR',
            fx_to_eur: 1
        });
    });

    it('returns raw rows with null EUR fields when raw-data FX enrichment fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fx down')));

        pool.setResult({
            rows: [{
                city: 'Belgrade',
                updated_at: '2025-01-05',
                raw_data: {
                    prices: [
                        { item: 'Meal, Inexpensive Restaurant', price: '1200 RSD' },
                        { item: 'Internet', price: 'not available' }
                    ]
                }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/city-stats/data');

        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({
            city: 'Belgrade',
            currency: 'RSD',
            fx_to_eur: null
        });
        expect(res.body[0].raw_data).toMatchObject({
            currency: 'RSD',
            fx_to_eur: null,
            eur_error: 'EUR normalization failed'
        });
        expect(res.body[0].raw_data.prices).toEqual([
            { item: 'Meal, Inexpensive Restaurant', price: '1200 RSD', price_eur: null },
            { item: 'Internet', price: 'not available', price_eur: null }
        ]);
    });

    it('builds raw-data queries with combined city and date filters', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/city-stats/data?cities=Zagreb,Belgrade&from=2025-01-01&to=2025-02-01');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);

        const call = pool.getCalls()[0];
        expect(call.sql).toContain('SELECT city, updated_at, raw_data FROM numbeo_city');
        expect(call.sql).toContain('WHERE city = ANY($1) AND updated_at >= $2 AND updated_at <= $3');
        expect(call.sql).toContain('ORDER BY city, updated_at');
        expect(call.params).toEqual([
            ['Zagreb', 'Belgrade'],
            '2025-01-01',
            '2025-02-01'
        ]);
    });

    it('ignores invalid date filters on raw-data queries', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app)
            .get('/city-stats/data?cities=Zagreb&from=not-a-date&to=also-bad');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);

        const call = pool.getCalls()[0];
        expect(call.sql).toContain('SELECT city, updated_at, raw_data FROM numbeo_city');
        expect(call.sql).toContain('WHERE city = ANY($1)');
        expect(call.sql).not.toContain('updated_at >=');
        expect(call.sql).not.toContain('updated_at <=');
        expect(call.params).toEqual([['Zagreb']]);
    });
});