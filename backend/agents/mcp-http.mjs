#!/usr/bin/env node
// Stateless public MCP on loopback. This entry deliberately never loads the backend's secret .env.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import { createUrbanGameTheoryMcpServer } from './mcp-server.mjs';

export function assertHostedEnvironment(env) {
    const names = Object.keys(env).filter(name => env[name] && /(?:KEYPAIR|SECRET|TOKEN|PASSWORD|API_KEY|DATABASE_URL)/i.test(name));
    if (names.length) throw new Error(`Hosted MCP environment must contain no credentials: ${names.join(', ')}`);
}

export function createMcpHttpService({ env = process.env, fetchImpl, factory,
    publicOrigin = 'https://urbangametheory.xyz', maxConcurrent = 8, maxPerMinute = 600,
    maxPublishPerMinute = 10, now = Date.now } = {}) {
    assertHostedEnvironment(env);
    const origin = new URL(publicOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('MCP_PUBLIC_ORIGIN must be an HTTPS origin');
    const allowed = ['localhost', '127.0.0.1', '[::1]', origin.hostname];
    const hostGuard = hostHeaderValidation(allowed), originGuard = originValidation(allowed);
    let active = 0, count = 0, publishes = 0, start = now();
    const makeServer = factory || (() => createUrbanGameTheoryMcpServer({ mode: 'hosted', env, fetchImpl }));
    // Count writes at the tool boundary too: this covers legacy clients without MCP routing headers.
    const guardedFactory = () => {
        const server = makeServer();
        // The shared server applies its write budget through an injected gate, not request headers.
        server.ugtPublishGate = () => {
            resetWindow();
            if (publishes >= maxPublishPerMinute) throw Object.assign(new Error('Publish budget exhausted; retry in one minute.'), { code: 'publish-rate-limited', next: { action: 'Wait one minute and retry.' } });
            publishes++;
        };
        return server;
    };
    function resetWindow() { if (now() - start >= 60_000) { start = now(); count = 0; publishes = 0; } }
    const handler = createMcpHandler(guardedFactory, { legacy: 'stateless', maxRequestBodySize: 32_768, maxSubscriptions: 0 });
    const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: 32_768 });
    const http = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (!hostGuard(req, res) || !originGuard(req, res)) return;
        const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
        if (req.url === '/healthz' && req.method === 'GET') return json(200, { service: 'ugt-mcp', status: 'ok', upstreamChecked: false });
        if (req.url === '/mcp/server-card' && req.method === 'GET') return json(200, {
            $schema: 'https://static.modelcontextprotocol.io/schemas/server-card.json',
            name: 'urban-game-theory', version: '0.3.0', description: 'Public urban designs, agreements and markets; unsigned publication and wallet approval links.',
            transport: { type: 'streamable-http', url: `${origin.origin}/mcp` }, authentication: { required: false }
        });
        if (!['/mcp', '/mcp/'].includes(req.url)) return json(404, { code: 'not-found' });
        if (!['POST', 'GET', 'DELETE'].includes(req.method)) return json(405, { code: 'method-not-allowed' }, { Allow: 'POST, GET, DELETE' });
        resetWindow();
        if (active >= maxConcurrent || count >= maxPerMinute) return json(429, { code: 'rate-limited', message: 'MCP request budget exhausted.', next: { action: 'Retry after 60 seconds.' } }, { 'Retry-After': '60' });
        count++; active++;
        try { await nodeHandler(req, res); }
        catch (error) {
            console.error(`[${new Date().toISOString()}] [ugt-mcp] transport failed (${error.code || 'internal'})`);
            if (!res.headersSent) json(500, { code: 'mcp-unavailable', message: 'MCP transport unavailable.', next: { action: 'Retry later.' } });
            else res.destroy();
        } finally { active--; }
    });
    http.requestTimeout = 30_000;
    http.headersTimeout = 10_000;
    return { http, async close() {
        await handler.close();
        if (!http.listening) return;
        const closed = new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        http.closeIdleConnections();
        await closed;
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const service = createMcpHttpService({ publicOrigin: process.env.MCP_PUBLIC_ORIGIN });
    const port = Number(process.env.MCP_PORT || 3096);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP_PORT');
    service.http.listen(port, '127.0.0.1', () => console.error(`[${new Date().toISOString()}] [ugt-mcp] listening on loopback:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.close().then(() => process.exit(0)));
}
