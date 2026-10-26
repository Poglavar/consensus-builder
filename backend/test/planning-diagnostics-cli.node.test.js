import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const databaseUrl of [undefined, '   ']) {
    test(`private report refuses ${databaseUrl === undefined ? 'missing' : 'empty'} DATABASE_URL before using ambient PG settings`, { timeout: 10000 }, async t => {
        let connections = 0;
        const server = createServer(socket => { connections++; socket.destroy(); });
        server.listen(0, 'localhost'); await once(server, 'listening');
        t.after(() => new Promise(resolve => server.close(resolve)));
        const address = server.address();
        const env = { PATH: process.env.PATH, PGHOST: address.address, PGPORT: String(address.port), PGUSER: 'fixture', PGDATABASE: 'fixture' };
        if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
        const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/planning-usage.mjs', import.meta.url)), '--prune-diagnostics'], {
            cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 7000
        });
        child.stderr.resume(); child.stdout.resume();
        const [code, signal] = await once(child, 'close');
        assert.equal(signal, null); assert.equal(code, 1);
        assert.equal(connections, 0, 'CLI attempted a connection using PGHOST without DATABASE_URL');
    });
}
