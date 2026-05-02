import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp, startServer } from '../index.js';
import { createMockPool } from './helpers/mock-pool.js';

describe('createApp', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('wires the health route through the full app factory', async () => {
        const { app } = createApp({
            env: { USE_CORS_ALLOWLIST: 'false' },
            pool: createMockPool()
        });

        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });
    });

    it('enables localhost CORS in development by default', async () => {
        const { app } = createApp({
            env: { NODE_ENV: 'development' },
            pool: createMockPool()
        });

        const res = await request(app)
            .get('/health')
            .set('Origin', 'http://localhost:5173');

        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
        expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('uses the explicit CORS allowlist when configured', async () => {
        const { app } = createApp({
            env: {
                USE_CORS_ALLOWLIST: 'true',
                CORS_ALLOWLIST: 'https://allowed.example'
            },
            pool: createMockPool()
        });

        const allowed = await request(app)
            .get('/health')
            .set('Origin', 'https://allowed.example');
        const denied = await request(app)
            .get('/health')
            .set('Origin', 'https://denied.example');

        expect(allowed.headers['access-control-allow-origin']).toBe('https://allowed.example');
        expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not enable CORS automatically in production', async () => {
        const { app } = createApp({
            env: { NODE_ENV: 'production' },
            pool: createMockPool()
        });

        const res = await request(app)
            .get('/health')
            .set('Origin', 'http://localhost:5173');

        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows requests without an origin header when dev cors is enabled', async () => {
        const { app } = createApp({
            env: { NODE_ENV: 'development' },
            pool: createMockPool()
        });

        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('can disable dev CORS explicitly', async () => {
        const { app } = createApp({
            env: {
                NODE_ENV: 'development',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool: createMockPool()
        });

        const res = await request(app)
            .get('/health')
            .set('Origin', 'http://localhost:5173');

        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('configures trust proxy when requested', () => {
        const { app } = createApp({
            env: {
                USE_CORS_ALLOWLIST: 'false',
                TRUST_PROXY: 'true'
            },
            pool: createMockPool()
        });

        expect(app.get('trust proxy')).toBe(1);
    });

    it('leaves trust proxy disabled when explicitly false in production', () => {
        const { app } = createApp({
            env: {
                NODE_ENV: 'production',
                TRUST_PROXY: 'false',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool: createMockPool()
        });

        expect(app.get('trust proxy')).toBe(false);
    });

    it('logs SQL for GET requests in dev mode', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [], rowCount: 0 });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const { app } = createApp({
            env: {
                ENVIRONMENT: 'dev',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool
        });

        const res = await request(app).get('/streets?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('[SQL][GET /streets?bbox=1,2,3,4]')
        );
    });

    it('does not log SQL for GET requests outside dev mode', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [], rowCount: 0 });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const { app } = createApp({
            env: { USE_CORS_ALLOWLIST: 'false' },
            pool
        });

        const res = await request(app).get('/streets?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(consoleSpy).not.toHaveBeenCalledWith(
            expect.stringContaining('[SQL][GET /streets?bbox=1,2,3,4]')
        );
    });

    it('logs failed SQL queries in dev mode', async () => {
        const pool = createMockPool();
        pool.query = vi.fn().mockRejectedValue(new Error('db down'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

        const { app } = createApp({
            env: {
                ENVIRONMENT: 'dev',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool
        });

        const res = await request(app).get('/streets?bbox=1,2,3,4');

        expect(res.status).toBe(500);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[SQL][GET /streets?bbox=1,2,3,4]'),
        );
    });

    it('patches pool.connect promise clients for SQL logging', async () => {
        const connectedClient = {
            query: vi.fn().mockResolvedValue({ rows: [{ value: 1 }], rowCount: 1 })
        };
        const pool = {
            query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            connect: vi.fn().mockResolvedValue(connectedClient)
        };
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const { app } = createApp({
            env: {
                ENVIRONMENT: 'dev',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool
        });

        app.get('/_test/connect-promise', async (_req, res) => {
            const client = await app.locals.pool.connect();
            const result = await client.query({ text: 'SELECT $1::int AS value', values: [1] });
            res.json(result.rows[0]);
        });

        const res = await request(app).get('/_test/connect-promise');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ value: 1 });
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("SELECT 1::int AS value")
        );
    });

    it('patches pool.connect callback clients for SQL logging', async () => {
        const connectedClient = {
            query: vi.fn().mockResolvedValue({ rows: [{ value: 2 }], rowCount: 1 })
        };
        const pool = {
            query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            connect: vi.fn((callback) => callback(null, connectedClient, vi.fn()))
        };
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const { app } = createApp({
            env: {
                ENVIRONMENT: 'dev',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool
        });

        app.get('/_test/connect-callback', async (_req, res) => {
            await new Promise((resolve, reject) => {
                app.locals.pool.connect(async (err, client) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    try {
                        const result = await client.query('SELECT $1::int AS value', [2]);
                        res.json(result.rows[0]);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        });

        const res = await request(app).get('/_test/connect-callback');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ value: 2 });
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('SELECT 2::int AS value')
        );
    });

    it('formats diverse SQL values in dev logging output', async () => {
        const pool = createMockPool();
        pool.query = vi.fn().mockResolvedValue({ rows: [{ ok: true }], rowCount: 1 });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const { app } = createApp({
            env: {
                ENVIRONMENT: 'dev',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool
        });

        app.get('/_test/sql-formatting', async (_req, res) => {
            const result = await app.locals.pool.query(
                'SELECT $1 AS a, $2 AS b, $3 AS c, $4 AS d, $5 AS e, $6 AS f, $7 AS g',
                [
                    null,
                    3,
                    true,
                    new Date('2025-01-02T03:04:05.000Z'),
                    Buffer.from('ab', 'hex'),
                    ['x', 1],
                    { nested: 'value' }
                ]
            );
            res.json(result.rows[0]);
        });

        const res = await request(app).get('/_test/sql-formatting');

        expect(res.status).toBe(200);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NULL'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('TRUE'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2025-01-02T03:04:05.000Z'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("'\\xab'"));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ARRAY['));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('{"nested":"value"}'));
    });

    it('reuses already patched pools and clients without wrapping them again', async () => {
        const connectedClient = {
            __sqlLoggingPatched: true,
            query: vi.fn().mockResolvedValue({ rows: [{ value: 7 }], rowCount: 1 })
        };
        const originalQuery = connectedClient.query;
        const pool = {
            __sqlLoggingPatched: true,
            query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            connect: vi.fn().mockResolvedValue(connectedClient)
        };

        const { app } = createApp({
            env: {
                ENVIRONMENT: 'dev',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool
        });

        app.get('/_test/patched-client', async (_req, res) => {
            const client = await app.locals.pool.connect();
            const result = await client.query('SELECT 7::int AS value');
            res.json(result.rows[0]);
        });

        const res = await request(app).get('/_test/patched-client');

        expect(res.status).toBe(200);
        expect(app.locals.pool).toBe(pool);
        expect(connectedClient.query).toBe(originalQuery);
        expect(connectedClient.query).toHaveBeenCalledWith('SELECT 7::int AS value');
    });

    it('rejects write requests without origin or referer', async () => {
        const { app } = createApp({
            env: {
                USE_CORS_ALLOWLIST: 'false'
            },
            pool: createMockPool()
        });

        app.post('/_test/write-no-origin', (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app)
            .post('/_test/write-no-origin')
            .send({ name: 'blocked' });

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
    });

    it('allows write requests from configured origins', async () => {
        const { app } = createApp({
            env: {
                USE_CORS_ALLOWLIST: 'false',
                ALLOWED_ORIGINS: 'https://editor.example,https://admin.example'
            },
            pool: createMockPool()
        });

        app.post('/_test/write-allowed', (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app)
            .post('/_test/write-allowed')
            .set('Origin', 'https://admin.example')
            .send({ name: 'allowed' });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ ok: true });
    });

    it('allows delete requests from a valid referer origin', async () => {
        const { app } = createApp({
            env: {
                USE_CORS_ALLOWLIST: 'false',
                ALLOWED_ORIGINS: 'https://editor.example'
            },
            pool: createMockPool()
        });

        app.delete('/_test/delete-from-referer', (_req, res) => {
            res.status(204).end();
        });

        const res = await request(app)
            .delete('/_test/delete-from-referer')
            .set('Referer', 'https://editor.example/proposals/123');

        expect(res.status).toBe(204);
    });

    it('rejects write requests with malformed referer values', async () => {
        const { app } = createApp({
            env: {
                USE_CORS_ALLOWLIST: 'false',
                ALLOWED_ORIGINS: 'https://editor.example'
            },
            pool: createMockPool()
        });

        app.post('/_test/write-malformed-referer', (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app)
            .post('/_test/write-malformed-referer')
            .set('Referer', 'not a valid url')
            .send({});

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
    });

    it('allows localhost write requests outside production', async () => {
        const { app } = createApp({
            env: {
                NODE_ENV: 'development',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool: createMockPool()
        });

        app.post('/_test/write-local-dev', (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app)
            .post('/_test/write-local-dev')
            .set('Origin', 'http://localhost:5173')
            .send({});

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ ok: true });
    });

    it('rejects localhost write requests in production', async () => {
        const { app } = createApp({
            env: {
                NODE_ENV: 'production',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool: createMockPool()
        });

        app.post('/_test/write-local-prod', (_req, res) => {
            res.status(201).json({ ok: true });
        });

        const res = await request(app)
            .post('/_test/write-local-prod')
            .set('Origin', 'http://localhost:5173')
            .send({});

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
    });

    it('applies the write rate limiter to patch requests', async () => {
        const { app } = createApp({
            env: {
                USE_CORS_ALLOWLIST: 'false',
                ALLOWED_ORIGINS: 'https://editor.example'
            },
            pool: createMockPool()
        });

        app.patch('/_test/rate-limited', (_req, res) => {
            res.status(200).json({ ok: true });
        });

        for (let attempt = 0; attempt < 50; attempt += 1) {
            const allowed = await request(app)
                .patch('/_test/rate-limited')
                .set('Origin', 'https://editor.example')
                .send({});

            expect(allowed.status).toBe(200);
        }

        const limited = await request(app)
            .patch('/_test/rate-limited')
            .set('Origin', 'https://editor.example')
            .send({});

        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({ error: 'Too many requests, please try again later.' });
    });

    it('uses the production trust proxy default unless explicitly disabled', () => {
        const { app } = createApp({
            env: {
                NODE_ENV: 'production',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool: createMockPool()
        });

        expect(app.get('trust proxy')).toBe(1);
    });

    it('returns a generic response from the global error handler', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const { app } = createApp({
            env: { USE_CORS_ALLOWLIST: 'false' },
            pool: createMockPool()
        });

        const stack = app._router?.stack || [];
        const errorLayer = [...stack].reverse().find((layer) => typeof layer.handle === 'function' && layer.handle.length === 4);
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis()
        };

        expect(errorLayer).toBeTruthy();

        errorLayer.handle(new Error('boom'), {}, res, vi.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
        expect(consoleSpy).toHaveBeenCalledWith('Unhandled error:', expect.any(Error));
    });

});

describe('startServer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('starts the app on the configured port and logs startup', () => {
        const listenMock = vi.fn((port, callback) => {
            callback();
            return { close: vi.fn() };
        });
        const listenSpy = vi.spyOn(express.application, 'listen').mockImplementation(listenMock);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const server = startServer({
            env: {
                API_PORT: '4567',
                USE_CORS_ALLOWLIST: 'false'
            },
            pool: createMockPool()
        });

        expect(listenSpy).toHaveBeenCalled();
        expect(listenMock.mock.calls[0][0]).toBe('4567');
        expect(consoleSpy).toHaveBeenCalledWith('Backend listening on port 4567');
        expect(server).toEqual({ close: expect.any(Function) });
    });

    it('defaults the server port to 3000', () => {
        const listenMock = vi.fn((port, callback) => {
            callback();
            return { close: vi.fn() };
        });
        const listenSpy = vi.spyOn(express.application, 'listen').mockImplementation(listenMock);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        startServer({
            env: { USE_CORS_ALLOWLIST: 'false' },
            pool: createMockPool()
        });

        expect(listenSpy).toHaveBeenCalled();
        expect(listenMock.mock.calls[0][0]).toBe(3000);
        expect(consoleSpy).toHaveBeenCalledWith('Backend listening on port 3000');
    });
});