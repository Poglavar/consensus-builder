// Real MCP clients exercise hosted isolation, protocol negotiation and public request limits.
import { request } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHttpService } from '../agents/mcp-http.mjs';

const services = [], clients = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); await Promise.all(services.splice(0).map(service => service.close())); });
async function host(options = {}) {
    const service = createMcpHttpService({ env: {}, fetchImpl: async () => new Response(JSON.stringify({ sources: [] })), ...options });
    services.push(service); service.http.listen(0, '127.0.0.1'); await once(service.http, 'listening');
    return `http://127.0.0.1:${service.http.address().port}`;
}
describe('hosted MCP HTTP', () => {
    for (const mode of ['modern', 'legacy']) it(`supports a stock ${mode} client without exposing signing`, async () => {
        const base = await host();
        const client = new Client({ name: 'protocol-test', version: '1' }, { versionNegotiation: { mode } }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toContain('ugt_publish_design');
        expect(tools.map(t => t.name)).toContain('ugt_find_place');
        expect(tools.filter(t => t.annotations?.destructiveHint)).toEqual([]);
        expect(tools.some(t => /mint|fund|buy_|bet_on|pledge|donate|request_ownership/.test(t.name))).toBe(false);
        const result = await client.callTool({ name: 'ugt_explain', arguments: { term: 'Parcel binding' } });
        expect(result.structuredContent.entries.join('')).toContain('ParcelBinding');
        const resources = await client.listResources();
        expect(resources.resources.map(r => r.uri)).toContain('ugt://vocabulary');
        expect((await client.readResource({ uri: 'ugt://schemas/design' })).contents[0].text).toContain('design/v1');
        expect((await client.listPrompts()).prompts).toHaveLength(4);
    });
    it('rejects credential-bearing environments before starting', () => {
        for (const key of ['UGT_AGENT_KEYPAIR', 'DATABASE_URL', 'PINATA_JWT_TOKEN']) expect(() => createMcpHttpService({ env: { [key]: 'configured' } })).toThrow(/no credentials/);
    });
    it('enforces hosts, origins, body size and no-store', async () => {
        const base = await host();
        const wrongHost = await new Promise(resolve => { request(`${base}/mcp`, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).end(); });
        expect(wrongHost).toBe(403);
        expect((await fetch(`${base}/mcp`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
        const large = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'a'.repeat(33_000) }) });
        expect(large.status).toBe(413);
        const health = await fetch(`${base}/healthz`);
        expect(health.headers.get('cache-control')).toBe('no-store');
        expect(await health.json()).toMatchObject({ upstreamChecked: false });
    });
    it('bounds global traffic and resets the window', async () => {
        let now = 0; const base = await host({ maxPerMinute: 1, now: () => now });
        await fetch(`${base}/mcp`);
        const limited = await fetch(`${base}/mcp`); expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
        now = 60_001; expect((await fetch(`${base}/mcp`)).status).not.toBe(429);
    });
});
