// Keep the public MCP listener separate from existing API and lens services and route to it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const apps = require('../ecosystem.config.cjs').apps;
const mcp = apps.find(app => app.name === 'ugt-mcp');
const port = Number(mcp.env.MCP_PORT);

describe('MCP production routing', () => {
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
