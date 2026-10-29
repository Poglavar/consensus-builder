// Keep the public MCP listener separate from existing API and lens services and route to it.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        reserved.listen(0);
        await once(reserved, 'listening');
        const listenPort = reserved.address().port;
        await new Promise(resolve => reserved.close(resolve));
        const directory = mkdtempSync(join(tmpdir(), 'mcp-launch-test-'));
        const child = spawn(mcp.script, mcp.args, {
            cwd: fileURLToPath(new URL('../', import.meta.url)),
            env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_PORT: String(listenPort), MCP_DRAFT_DIRECTORY: directory, NODE_ENV: 'test' },
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
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('deploys private database storage before reload and keeps API notifications unbuffered', () => {
        const deploy = readFileSync(new URL('../deploy-backend.sh', import.meta.url), 'utf8');
        expect(deploy).toContain('db/shared-plan-session-ddl.sql');
        expect(deploy.indexOf('db/shared-plan-session-ddl.sql')).toBeLessThan(deploy.indexOf('pm2 startOrReload'));
        const nginx = readFileSync(new URL('../nginx/api.urbangametheory.xyz.nginx.conf', import.meta.url), 'utf8');
        const route = nginx.match(/location \^~ \/shared-plan-sessions \{([^}]+)\}/)?.[1];
        expect(route).toContain('proxy_buffering off;');
        expect(route).toContain('proxy_read_timeout 90s;');
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
        const sessions = nginx.match(/location \^~ \/mcp\/plan-sessions \{([^}]+)\}/)?.[1];
        expect(sessions).toContain(`proxy_pass http://127.0.0.1:${port};`);
        expect(sessions).toContain('proxy_buffering off;');
        expect(sessions).toContain('proxy_read_timeout 90s;');
        expect(sessions).toContain('client_max_body_size 15m;');
        for (const route of routes) expect(route[1]).toContain(`proxy_pass http://127.0.0.1:${port};`);
        for (const route of routes.filter(route => !route[0].includes('server-card'))) expect(route[1]).toContain('client_max_body_size 15m;');
    });
});
