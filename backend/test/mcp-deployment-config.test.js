// Keep the public MCP listener separate from existing API and lens services and route to it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const apps = require('../ecosystem.config.cjs').apps;
const mcp = apps.find(app => app.name === 'ugt-mcp');
const port = Number(mcp.env.MCP_PORT);

describe('MCP production routing', () => {
    it('launches the guarded CLI as a real credential-isolated listener', async () => {
        expect(mcp.interpreter).toBe('none');
        const reserved = createServer();
        reserved.listen(0, '127.0.0.1');
        await once(reserved, 'listening');
        const listenPort = reserved.address().port;
        await new Promise(resolve => reserved.close(resolve));
        const child = spawn(mcp.script, mcp.args, {
            cwd: fileURLToPath(new URL('../', import.meta.url)),
            env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_PORT: String(listenPort), NODE_ENV: 'test' },
            stdio: ['ignore', 'ignore', 'pipe']
        });
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('MCP CLI did not listen')), 5000);
                child.once('exit', code => { clearTimeout(timer); reject(new Error(`Launcher exited before listening (${code})`)); });
                child.once('error', error => { clearTimeout(timer); reject(error); });
                child.stderr.on('data', chunk => {
                    if (String(chunk).includes(`listening on loopback:${listenPort}`)) { clearTimeout(timer); resolve(); }
                });
            });
            const response = await fetch(`http://127.0.0.1:${listenPort}/healthz`);
            expect(await response.json()).toMatchObject({ service: 'ugt-mcp', status: 'ok' });
        } finally {
            if (child.exitCode === null) { child.kill('SIGINT'); await once(child, 'exit'); }
        }
    });

    it('does not occupy an API or registered lens service port', () => {
        const personas = JSON.parse(readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8')).personas;
        const occupied = [Number(apps.find(app => app.name === 'consensus-builder-api').env.API_PORT),
            ...personas.filter(persona => persona.service?.port).map(persona => Number(persona.service.port))];
        expect(occupied).not.toContain(port);
    });

    it('routes all public MCP paths to the configured listener', () => {
        const nginx = readFileSync(new URL('../nginx/urbangametheory.xyz.nginx.conf', import.meta.url), 'utf8');
        const routes = [...nginx.matchAll(/location = \/mcp(?:\/server-card|\/)? \{([^}]+)\}/g)];
        expect(routes).toHaveLength(3);
        for (const route of routes) expect(route[1]).toContain(`proxy_pass http://127.0.0.1:${port};`);
    });
});
