// Postgres connection for the corridor generator. Reads credentials from
// ../backend/.env but always targets the `geodata` database. Refuses to run
// against a non-local server (an SSH tunnel can silently forward
// localhost:5432 to prod) unless --allow-remote is passed.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { DIR } from './config.js';
import { log, fail } from './log.js';

function readBackendEnv() {
    const envPath = path.join(DIR, '..', 'backend', '.env');
    const env = {};
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
            if (m) env[m[1]] = m[2];
        }
    }
    return env;
}

export async function connect({ allowRemote = false } = {}) {
    const env = readBackendEnv();
    const client = new pg.Client({
        host: 'localhost',
        port: Number(env.PGPORT || 5432),
        user: env.PGUSER || 'zagreb_user',
        password: env.PGPASSWORD,
        database: 'geodata',
    });
    await client.connect();
    const { rows: [addr] } = await client.query('SELECT inet_server_addr() a, current_database() d');
    const isDockerLocal = addr.a && (addr.a.startsWith('172.') || addr.a.startsWith('192.168.') || addr.a.startsWith('10.'));
    if (!isDockerLocal && !allowRemote) {
        await client.end();
        fail(`server address ${addr.a} does not look like the local docker container — ` +
            `an SSH tunnel may be forwarding :5432 to prod. Pass --allow-remote to override.`);
    }
    log(`connected to ${addr.d} at ${addr.a}`);
    return client;
}
