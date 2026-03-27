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
            env: { ENABLE_DEV_CORS: 'false' },
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
                ENABLE_DEV_CORS: 'true',
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

    it('can disable dev CORS explicitly', async () => {
        const { app } = createApp({
            env: {
                NODE_ENV: 'development',
                ENABLE_DEV_CORS: 'false'
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
                ENABLE_DEV_CORS: 'false',
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
                ENABLE_DEV_CORS: 'false'
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
                ENABLE_DEV_CORS: 'false'
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
            env: { ENABLE_DEV_CORS: 'false' },
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
                ENABLE_DEV_CORS: 'false'
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
                ENABLE_DEV_CORS: 'false'
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
                ENABLE_DEV_CORS: 'false'
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
                ENABLE_DEV_CORS: 'false'
            },
            pool: createMockPool()
        });

        expect(listenSpy).toHaveBeenCalled();
        expect(listenMock.mock.calls[0][0]).toBe('4567');
        expect(consoleSpy).toHaveBeenCalledWith('Backend listening on port 4567');
        expect(server).toEqual({ close: expect.any(Function) });
    });
});