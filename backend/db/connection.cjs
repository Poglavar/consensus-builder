// Single source of the Postgres connection for the backend, its scripts and tests: everything reads
// one libpq URI from DATABASE_URL (never the PG* variables node-postgres would otherwise pick up).
const pg = require('pg');

// `db` is this repo's docker-compose service name, so it is as local as localhost is — the point of
// the local-only guards is to refuse a production host, not to insist on one spelling.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'db']);

function databaseUrl(env = process.env) {
    const url = env.DATABASE_URL;
    if (typeof url !== 'string' || url.trim() === '') throw new Error('DATABASE_URL is not set');
    return url;
}

function createPool(options = {}, env = process.env) {
    return new pg.Pool({ connectionString: databaseUrl(env), ...options });
}

function createClient(options = {}, env = process.env) {
    return new pg.Client({ connectionString: databaseUrl(env), ...options });
}

// Host/port/database/user for logs and guards. The password is deliberately never returned.
function describeDatabase(env = process.env) {
    const url = new URL(databaseUrl(env));
    return {
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port ? Number(url.port) : 5432,
        database: decodeURIComponent(url.pathname.replace(/^\//, '')),
        user: decodeURIComponent(url.username),
    };
}

function isLocalDatabase(env = process.env) {
    return LOCAL_HOSTS.has(describeDatabase(env).host.toLowerCase());
}

module.exports = { databaseUrl, createPool, createClient, describeDatabase, isLocalDatabase };
