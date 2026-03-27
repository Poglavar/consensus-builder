import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupDocsRoute } from '../routes/docs.js';
import { createRouteApp } from './helpers/create-route-app.js';

afterEach(() => {
    vi.restoreAllMocks();
});

function createDocsPool() {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('FROM information_schema.tables')) {
                return {
                    rows: [{ table_name: 'parcel', table_comment: 'Parcel table' }],
                    rowCount: 1
                };
            }
            if (sql.includes('FROM information_schema.columns')) {
                return {
                    rows: [{
                        column_name: 'id',
                        data_type: 'integer',
                        is_nullable: 'NO',
                        column_default: null,
                        character_maximum_length: null,
                        numeric_precision: 32,
                        numeric_scale: 0,
                        column_comment: null
                    }],
                    rowCount: 1
                };
            }
            if (sql.includes('FROM information_schema.table_constraints')) {
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes('FROM pg_indexes')) {
                return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        },
        release() { }
    };

    return {
        calls,
        async connect() {
            return client;
        }
    };
}

describe('GET /docs', () => {
    it('renders the markdown documentation as html', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool());

        const res = await request(app).get('/docs');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.text).toContain('<title>Consensus Builder API Documentation</title>');
        expect(res.text).toContain('GET /docs/database');
    });

    it('returns 500 when markdown documentation cannot be read', async () => {
        vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
            if (String(filePath).endsWith('docs.md')) {
                throw new Error('docs missing');
            }
            return fs.readFileSync.wrappedMethod.call(fs, filePath, encoding);
        });

        const app = createRouteApp(setupDocsRoute, createDocsPool());
        const res = await request(app).get('/docs');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to load documentation'
        });
    });
});

describe('GET /docs/api', () => {
    it('returns the api schema json', async () => {
        const app = createRouteApp(setupDocsRoute, createDocsPool());

        const res = await request(app).get('/docs/api');

        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Consensus Builder API Schema');
        expect(res.body.definitions).toHaveProperty('PostGISGeometry');
    });

    it('returns 500 when the api schema cannot be loaded', async () => {
        vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
            if (String(filePath).endsWith('api-schema.json')) {
                throw new Error('schema missing');
            }
            return fs.readFileSync.wrappedMethod.call(fs, filePath, encoding);
        });

        const app = createRouteApp(setupDocsRoute, createDocsPool());
        const res = await request(app).get('/docs/api');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to load API schema'
        });
    });

    it('returns 500 when the api schema contains invalid json', async () => {
        vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
            if (String(filePath).endsWith('api-schema.json')) {
                return '{bad json';
            }
            return fs.readFileSync.wrappedMethod.call(fs, filePath, encoding);
        });

        const app = createRouteApp(setupDocsRoute, createDocsPool());
        const res = await request(app).get('/docs/api');

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to load API schema');
    });
});

describe('GET /docs/database', () => {
    it('returns generated database schema json', async () => {
        const pool = createDocsPool();
        const app = createRouteApp(setupDocsRoute, pool);

        const res = await request(app).get('/docs/database');

        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Consensus Builder Database Schema');
        expect(res.body.tables).toHaveProperty('parcel');
        expect(res.body.tables.parcel.columns).toHaveProperty('id');
    });

    it('serves cached database schema when refresh fails after a successful load', async () => {
        const warmPool = createDocsPool();
        const warmApp = createRouteApp(setupDocsRoute, warmPool);
        const warmRes = await request(warmApp).get('/docs/database');

        expect(warmRes.status).toBe(200);

        const failingPool = {
            async connect() {
                throw new Error('db offline');
            }
        };
        const app = createRouteApp(setupDocsRoute, failingPool);

        const res = await request(app).get('/docs/database');

        expect(res.status).toBe(200);
        expect(res.body).toEqual(warmRes.body);
    });

    it('reuses the warm cache without reconnecting while the cache is fresh', async () => {
        const pool = createDocsPool();
        const connectSpy = vi.spyOn(pool, 'connect');
        const app = createRouteApp(setupDocsRoute, pool);

        const first = await request(app).get('/docs/database');
        const second = await request(app).get('/docs/database');

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when schema generation fails and no cache exists', async () => {
        const failingPool = {
            async connect() {
                throw new Error('db unavailable');
            }
        };
        const app = createRouteApp(setupDocsRoute, failingPool);

        const res = await request(app).get('/docs/database');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to load database schema',
            details: 'db unavailable'
        });
    });
});