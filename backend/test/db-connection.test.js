// Unit tests for db/connection.cjs, the single DATABASE_URL reader: parsing, the local-host guard
// and that pools/clients are built from the URI alone. No database is touched.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// The helper is CommonJS and loads `pg` with a native require, which vi.mock cannot intercept, so the
// test spies on the very `pg` module object the helper shares through the require cache.
const require = createRequire(import.meta.url);
const pg = require('pg');
const { databaseUrl, createPool, createClient, describeDatabase, isLocalDatabase } = require('../db/connection.cjs');

const SAMPLE = 'postgres://app_user:s3cret-pw@db.example.org:6543/geodata';

afterEach(() => vi.restoreAllMocks());

describe('databaseUrl', () => {
    it('returns DATABASE_URL when set', () => {
        expect(databaseUrl({ DATABASE_URL: SAMPLE })).toBe(SAMPLE);
    });

    it('throws when DATABASE_URL is missing or empty, ignoring PG* parts', () => {
        expect(() => databaseUrl({})).toThrow('DATABASE_URL is not set');
        expect(() => databaseUrl({ DATABASE_URL: '' })).toThrow('DATABASE_URL is not set');
        expect(() => databaseUrl({ PGHOST: 'localhost', PGDATABASE: 'geodata' })).toThrow('DATABASE_URL is not set');
    });
});

describe('describeDatabase', () => {
    it('parses host, port, database and user', () => {
        expect(describeDatabase({ DATABASE_URL: SAMPLE })).toEqual({
            host: 'db.example.org', port: 6543, database: 'geodata', user: 'app_user'
        });
    });

    it('defaults the port to 5432', () => {
        expect(describeDatabase({ DATABASE_URL: 'postgres://u:p@localhost/geodata' }).port).toBe(5432);
    });

    it('never exposes the password', () => {
        const described = describeDatabase({ DATABASE_URL: SAMPLE });
        expect(described).not.toHaveProperty('password');
        expect(JSON.stringify(described)).not.toContain('s3cret-pw');
    });
});

describe('isLocalDatabase', () => {
    const at = (host) => ({ DATABASE_URL: `postgres://u:p@${host}:5432/geodata` });

    it('accepts loopback hosts and the compose service name', () => {
        expect(isLocalDatabase(at('localhost'))).toBe(true);
        expect(isLocalDatabase(at('127.0.0.1'))).toBe(true);
        expect(isLocalDatabase(at('[::1]'))).toBe(true);
        expect(isLocalDatabase(at('db'))).toBe(true);
    });

    it('rejects a remote host', () => {
        expect(isLocalDatabase(at('db.example.org'))).toBe(false);
        expect(isLocalDatabase(at('10.0.0.5'))).toBe(false);
    });
});

describe('createPool / createClient', () => {
    it('createPool builds a pg.Pool from the connection string plus the given options', () => {
        const Pool = vi.spyOn(pg, 'Pool').mockImplementation(function (config) { this.config = config; });
        const pool = createPool({ max: 1 }, { DATABASE_URL: SAMPLE, PGHOST: 'elsewhere' });
        expect(Pool).toHaveBeenCalledTimes(1);
        expect(pool.config).toEqual({ connectionString: SAMPLE, max: 1 });
    });

    it('createClient builds a pg.Client from the connection string', () => {
        const Client = vi.spyOn(pg, 'Client').mockImplementation(function (config) { this.config = config; });
        const client = createClient({}, { DATABASE_URL: SAMPLE });
        expect(Client).toHaveBeenCalledTimes(1);
        expect(client.config).toEqual({ connectionString: SAMPLE });
    });

    it('refuses to build a pool without DATABASE_URL instead of falling back to PG* defaults', () => {
        const Pool = vi.spyOn(pg, 'Pool').mockImplementation(function () {});
        expect(() => createPool({}, {})).toThrow('DATABASE_URL is not set');
        expect(Pool).not.toHaveBeenCalled();
    });
});
