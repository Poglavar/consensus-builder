// Real MCP clients exercise hosted isolation, protocol negotiation and public request limits.
import { request } from 'node:http';
import express from 'express';
import { setupSharedPlanSessionsRoute } from '../routes/shared-plan-sessions.js';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';
import { createSharedPlanClient } from '../agents/shared-plan-client.js';
import { canonicalArtifact } from '../agents/shared-plan-artifact.js';
import { createMemorySharedPlanRepository } from './helpers/shared-plan-repository.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpHttpService, MCP_MAX_REQUEST_BYTES } from '../agents/mcp-http.mjs';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { hostedEnvironment } from '../agents/mcp-launch.mjs';
import { MCP_HOSTED_SHARED_TOOLS } from '../agents/mcp-catalog.js';
import { cidOfObject } from '../cid.js';
import { previewArtifact } from '../agents/mcp-preview.js';
import { checkContracts } from '../scripts/mcp-check-contracts.mjs';

const services = [], clients = [], directories = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); await Promise.all(services.splice(0).map(service => service.close())); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
async function host(options = {}) {
    const storeDirectory = mkdtempSync(join(tmpdir(), 'mcp-http-')); directories.push(storeDirectory);
    const app = express(); app.use(express.json({ limit: '15mb' }));
    const api = setupSharedPlanSessionsRoute(app, null, { sessions: createSharedPlanSessions({ repository: createMemorySharedPlanRepository(), validateArtifact: canonicalArtifact }) });
    const server = app.listen(0); await once(server, 'listening');
    services.push({ async close() { await api.close(); await new Promise(resolve => server.close(resolve)); } });
    const sharedPlans = createSharedPlanClient({ env: { UGT_API_BASE: `http://127.0.0.1:${server.address().port}` } });
    const service = createMcpHttpService({ storeDirectory, sharedPlans, env: {}, fetchImpl: async () => new Response(JSON.stringify({ sources: [] })), ...options });
    services.push(service); service.http.listen(0); await once(service.http, 'listening');
    return `http://127.0.0.1:${service.http.address().port}`;
}
describe('hosted MCP HTTP', () => {
    it('isolates session capability budgets from unauthenticated callers and the invited agent', async () => {
        const sharedPlans = createSharedPlanSessions({ repository: createMemorySharedPlanRepository(), validateArtifact: () => {} });
        const created = await sharedPlans.create({ cid: 'baf-private', plan: { schema: 'plan/v1' }, designs: [] });
        const base = await host({ sharedPlans, maxPerMinute: 2 });
        const url = `${base}/mcp/plan-sessions/${created.id}`;
        for (let i = 0; i < 3; i++) expect((await fetch(url)).status).toBe(401);
        const read = token => fetch(url, { headers: { authorization: `Bearer ${token}` } });
        for (const [token, status] of [['x'.repeat(32), 403], [created.inviteToken, 200]]) {
            expect((await read(token)).status).toBe(status);
            expect((await read(token)).status).toBe(status);
            expect((await read(token)).status).toBe(429);
        }
        expect((await read(created.ownerToken)).status).toBe(200);
        expect((await fetch(`${url}/control`, { method: 'POST', headers: { authorization: `Bearer ${created.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: -1, controller: 'owner', revoke: true }) })).status).toBe(200);
    });
    it('returns geometry-free links to exact JSON objects with no redirect and expires them', async () => {
        let now = 0;
        const design = { schema: 'design/v1', title: 'Private draft', geometry: { coordinates: [1, 2, 3] } };
        const cid = cidOfObject(design);
        const base = await host({ now: () => now, previewTtlMs: 100, previewOrigin: 'https://preview.example', factory: options => createUrbanGameTheoryMcpServer({ ...options, mode: 'hosted', env: {}, tools: {
            draftSpace: async () => ({ ...await previewArtifact({ design }), design, cid, plan: null, placement: { status: 'placed' }, consequences: { removed: [], junctions: [], cuts: [] } })
        } }) });
        const client = new Client({ name: 'private-link', version: '1' }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const result = (await client.callTool({ name: 'ugt_draft_space', arguments: { city: 'london', spaceKind: 'park' } })).structuredContent;
        expect(result).toMatchObject({ cid, previewStatus: 'private-link' });
        expect(new URL(result.previewUrl).hash).toBe('');
        expect(new URL(result.previewUrl).searchParams.get('draft')).toBe(result.draftRef);
        expect(new URL(result.draftRef).origin).toBe('https://preview.example');
        const path = new URL(result.draftRef).pathname;
        const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { host: 'preview.example' } });
        expect(response.status).toBe(200); expect(response.headers.get('location')).toBeNull();
        expect(await response.json()).toEqual({ cid, record: design, parcelSourceId: null });
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        now = 100; expect((await fetch(`${base}${path}`, { redirect: 'manual' })).status).toBe(410);
    });
    for (const mode of ['modern', 'legacy']) it(`supports a stock ${mode} client without exposing signing`, async () => {
        const base = await host();
        const client = new Client({ name: 'protocol-test', version: '1' }, { versionNegotiation: { mode } }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(MCP_HOSTED_SHARED_TOOLS);
        for (const tool of tools) {
            expect(tool.title).toEqual(expect.any(String));
            expect(tool.annotations.title).toBe(tool.title);
            expect(tool.title).not.toMatch(/^ugt_/);
        }
        expect(tools.map(t => t.name)).toContain('ugt_publish_design');
        expect(tools.map(t => t.name)).toContain('ugt_find_place');
        expect(tools.filter(t => t.annotations?.destructiveHint)).toEqual([]);
        expect(tools.some(t => /mint|fund|buy_|bet_on|pledge|donate|request_ownership/.test(t.name))).toBe(false);
        const result = await client.callTool({ name: 'ugt_explain', arguments: { term: 'Parcel binding' } });
        expect(result.structuredContent.entries.join('')).toContain('### Parcel binding');
        const resources = await client.listResources();
        expect(resources.resources.map(r => r.uri)).toContain('ugt://vocabulary');
        expect((await client.readResource({ uri: 'ugt://schemas/design' })).contents[0].text).toContain('design/v1');
        expect((await client.listPrompts()).prompts).toHaveLength(5);
        expect((await client.readResource({ uri: 'ugt://editing' })).contents[0].text).toContain('JSON Pointer');
    });
    it('rejects credential-bearing environments before starting', () => {
        for (const key of ['UGT_AGENT_KEYPAIR', 'DATABASE_URL', 'PINATA_JWT_TOKEN']) expect(() => createMcpHttpService({ env: { [key]: 'configured' } })).toThrow(/no credentials/);
        expect(hostedEnvironment({ PATH: '/bin', UGT_API_BASE: 'https://api.example', UGT_AGENT_KEYPAIR: 'configured', DATABASE_URL: 'configured', ANTHROPIC_API_KEY: 'configured' }))
            .toEqual({ PATH: '/bin', UGT_API_BASE: 'https://api.example' });
    });
    it('enforces hosts, origins, body size and no-store', async () => {
        const base = await host();
        const wrongHost = await new Promise(resolve => { request(`${base}/mcp`, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).end(); });
        expect(wrongHost).toBe(403);
        expect((await fetch(`${base}/mcp`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
        const large = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'a'.repeat(MCP_MAX_REQUEST_BYTES + 1) }) });
        expect(large.status).toBe(413);
        expect(await large.json()).toMatchObject({ code: 'mcp-request-too-large', maxRequestBytes: MCP_MAX_REQUEST_BYTES, next: expect.any(Object) });
        const health = await fetch(`${base}/healthz`);
        expect(health.headers.get('cache-control')).toBe('no-store');
        expect(await health.json()).toMatchObject({ upstreamChecked: false });
    });
    it('shares a real private park revision through REST and MCP without publication', async () => {
        const fetchImpl = vi.fn(async (url, options = {}) => {
            const path = new URL(url).pathname;
            if (path === '/designs/binding') return Response.json({ parcelSourceId: 'fixture', binding: { coverage: 'complete', unknownM2: 0, parcels: [] } });
            if (path === '/source-system') return Response.json({ abstractions: [], sources: [] });
            throw new Error(`unexpected ${path}`);
        });
        let releaseWrite, writeEntered;
        const writeReady = new Promise(resolve => { writeEntered = resolve; });
        const pendingWrite = new Promise(resolve => { releaseWrite = resolve; });
        const env = { UGT_API_BASE: 'https://api.example', UGT_APP_ORIGIN: 'https://app.example' };
        const base = await host({ env, maxConcurrent: 1, publicOrigin: 'https://app.example', fetchImpl,
            factory: settings => {
                const actions = createUrbanGameTheoryTools({ mode: 'hosted', env, fetchImpl, resolveDraftReference: settings.resolveDraftReference });
                actions.publishDesign = async () => { writeEntered(); await pendingWrite; return { cid: 'example' }; };
                return createUrbanGameTheoryMcpServer({ ...settings, mode: 'hosted', env, fetchImpl, tools: actions });
            } });
        const client = new Client({ name: 'shared-park', version: '1' }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const draft = (await client.callTool({ name: 'ugt_draft_space', arguments: { city: 'london', parcelSourceId: 'fixture', spaceKind: 'park', outline: { type: 'Polygon', coordinates: [[[-.1,51.5],[-.099,51.5],[-.099,51.501],[-.1,51.501],[-.1,51.5]]] } } })).structuredContent;
        expect(draft.draftRef).toBeTruthy();
        const preflight = await fetch(`${base}/mcp/plan-sessions`, { method: 'OPTIONS', headers: { origin: 'https://app.example' } });
        expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
        const created = await (await fetch(`${base}/mcp/plan-sessions`, { method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json' }, body: JSON.stringify({ plan: draft.plan?.draftRef || draft.draftRef }) })).json();
        expect(created).toMatchObject({ controller: 'owner', version: 0 });
        const eventUrl = `${base}/mcp/plan-sessions/${created.id}/events`;
        expect((await fetch(`${eventUrl}?capability=${created.ownerToken}`)).status).toBe(401);
        const response = await fetch(eventUrl, { headers: { authorization: `Bearer ${created.ownerToken}` } });
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffered = '';
        async function nextEvent() {
            while (!buffered.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('stream closed early'); buffered += decoder.decode(chunk.value); }
            const end = buffered.indexOf('\n\n'), event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
            expect(event).not.toContain(created.ownerToken); expect(event).not.toContain(created.inviteToken);
            return JSON.parse(event.split('data: ')[1]);
        }
        expect(await nextEvent()).toMatchObject({ id: created.id, version: 0, activity: { agentEditing: false } });
        const inviteResponse = await fetch(eventUrl, { headers: { authorization: `Bearer ${created.inviteToken}` } });
        const inviteReader = inviteResponse.body.getReader(); await inviteReader.read();
        const extraReaders = [];
        for (let i = 0; i < 2; i++) {
            const extra = await fetch(eventUrl, { headers: { authorization: `Bearer ${created.ownerToken}` } });
            extraReaders.push(extra.body.getReader()); await extraReaders.at(-1).read();
        }
        expect((await fetch(eventUrl, { headers: { authorization: `Bearer ${created.ownerToken}` } })).status).toBe(429);
        expect((await fetch(`${base}/mcp/plan-sessions/${created.id}`, { headers: { authorization: `Bearer ${created.ownerToken}` } })).status).toBe(200);
        await Promise.all(extraReaders.map(reader => reader.cancel()));
        const handover = await (await fetch(`${base}/mcp/plan-sessions/${created.id}/control`, { method: 'POST', headers: { authorization: `Bearer ${created.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 0, controller: 'agent' }) })).json();
        const edited = await client.callTool({ name: 'ugt_edit_shared_plan', arguments: { sessionId: created.id, capability: created.inviteToken, expectedVersion: handover.version, expectedCid: created.cid, title: 'Shared park', operations: [] } });
        expect(edited.isError).not.toBe(true);
        const read = await (await fetch(`${base}/mcp/plan-sessions/${created.id}`, { headers: { authorization: `Bearer ${created.ownerToken}` } })).json();
        expect(read.version).toBe(2); expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).not.toContain('/pins');
        let event; do { event = await nextEvent(); } while (event.version !== 2);
        expect(event).toMatchObject({ cid: read.cid, activity: { agentEditing: false } });
        const revoked = await (await fetch(`${base}/mcp/plan-sessions/${created.id}/control`, { method: 'POST', headers: { authorization: `Bearer ${created.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 2, controller: 'owner', revoke: true }) })).json();
        let chunk; do { chunk = await inviteReader.read(); } while (!chunk.done);
        expect(revoked.canUndo).toBe(true);
        const undone = await (await fetch(`${base}/mcp/plan-sessions/${created.id}/undo`, { method: 'POST', headers: { authorization: `Bearer ${created.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 3 }) })).json();
        expect(undone).toMatchObject({ cid: created.cid, canUndo: false, version: 4 });
        const write = client.callTool({ name: 'ugt_publish_design', arguments: { design: { schema: 'design/v1' }, confirm: true } });
        await writeReady;
        let shutdownFinished = false;
        const closing = services.at(-1).close().then(() => { shutdownFinished = true; });
        do { chunk = await reader.read(); } while (!chunk.done);
        expect(shutdownFinished).toBe(false);
        releaseWrite(); await write; await closing;
        expect(shutdownFinished).toBe(true);
    });
    it('accepts an ordinary full-plan request above the former 32 KiB ceiling', async () => {
        const proposeAgreement = vi.fn(async () => ({ cid: 'tested-without-publication' }));
        const base = await host({ factory: () => createUrbanGameTheoryMcpServer({ mode: 'hosted', env: {}, tools: { proposeAgreement } }) });
        const client = new Client({ name: 'large-plan', version: '1' }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const args = { agreement: { schema: 'agreement/v1', outputs: Array.from({ length: 30 }, (_, i) => ({ hash: String(i), geometry: 'coordinates'.repeat(200) })) }, confirm: true };
        expect(Buffer.byteLength(JSON.stringify(args))).toBeGreaterThan(32_768);
        expect((await client.callTool({ name: 'ugt_propose_agreement', arguments: args })).isError).not.toBe(true);
        expect(proposeAgreement).toHaveBeenCalledWith({ ...args, designs: [] });
    });
    it('bounds global traffic and resets the window', async () => {
        let now = 0; const base = await host({ maxPerMinute: 1, now: () => now });
        await fetch(`${base}/mcp`);
        const limited = await fetch(`${base}/mcp`); expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
        now = 60_001; expect((await fetch(`${base}/mcp`)).status).not.toBe(429);
    });
    it('bounds publishing at the tool boundary, including requests without modern routing headers', async () => {
        const publishDesign = vi.fn(async () => ({ cid: 'example' }));
        const base = await host({ maxPublishPerMinute: 1, factory: () => createUrbanGameTheoryMcpServer({ mode: 'hosted', env: {}, tools: { publishDesign } }) });
        const client = new Client({ name: 'publish-budget', version: '1' }, { versionNegotiation: { mode: 'legacy' } }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const call = () => client.callTool({ name: 'ugt_publish_design', arguments: { design: { schema: 'design/v1' }, confirm: true } });
        expect((await call()).isError).not.toBe(true);
        expect((await call()).structuredContent).toMatchObject({ code: 'publish-rate-limited', next: expect.any(Object) });
        expect(publishDesign).toHaveBeenCalledTimes(1);
    });
    it('bounds concurrent upstream work', async () => {
        let release, entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        const base = await host({ maxConcurrent: 1, factory: () => createUrbanGameTheoryMcpServer({ mode: 'hosted', env: {}, tools: {
            getActivity: async () => { entered(); return pending; }
        } }) });
        const client = new Client({ name: 'concurrent-budget', version: '1' }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const call = client.callTool({ name: 'ugt_activity', arguments: {} });
        await ready;
        try { expect((await fetch(`${base}/mcp`)).status).toBe(429); }
        finally { release({ ok: true }); await call; }
    });
    it('finishes an accepted draft before releasing its writer lock on shutdown', async () => {
        let release, entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        const design = { schema: 'design/v1', title: 'Shutdown draft', geometry: {} };
        const storeDirectory = mkdtempSync(join(tmpdir(), 'mcp-drain-')); directories.push(storeDirectory);
        const options = { storeDirectory, env: {}, previewOrigin: 'https://preview.example' };
        const base = await host({ ...options, factory: settings => createUrbanGameTheoryMcpServer({ ...settings, mode: 'hosted', env: {}, tools: {
            draftSpace: async () => { entered(); await pending; return { design, cid: cidOfObject(design), plan: null, placement: { status: 'placed' }, consequences: { removed: [], junctions: [], cuts: [] }, ...await previewArtifact({ design }) }; }
        } }) });
        const service = services.at(-1);
        const client = new Client({ name: 'shutdown-draft', version: '1' }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const call = client.callTool({ name: 'ugt_draft_space', arguments: { city: 'london', spaceKind: 'park' } });
        await ready;
        const closing = service.close();
        try { expect(() => createMcpHttpService(options)).toThrow(/already|writer|locked/i); }
        finally { release(); }
        const result = (await call).structuredContent;
        expect(result).toMatchObject({ cid: cidOfObject(design), previewStatus: 'private-link' });
        await closing;
        const restarted = await host(options);
        const response = await fetch(`${restarted}${new URL(result.draftRef).pathname}`);
        expect(response.status).toBe(200);
        expect((await response.json()).record).toEqual(design);
    });
    it('fails a contract check with missing source fixtures and never publishes', async () => {
        const paths = [];
        const base = await host({ fetchImpl: async url => { paths.push(new URL(url).pathname); return new Response(JSON.stringify({ sources: [], design: { schema: 'design/v1', description: 'A schema descriptor, not a draft' } })); } });
        const report = await checkContracts({ origin: base });
        expect(report.ok).toBe(false);
        expect(report.checks.find(c => c.tool === 'ugt_capabilities').status).toBe('passed');
        expect(report.checks.some(c => c.status === 'missing-fixture')).toBe(true);
        expect(report.checks.filter(c => c.status === 'write-refused-without-confirmation')).toHaveLength(0);
        expect(report.checks.filter(c => c.status === 'shared-refused-without-capability').map(c => c.tool))
            .toEqual(['ugt_inspect_shared_plan', 'ugt_edit_shared_plan']);
        expect(paths).not.toContain('/pins');
        expect(paths).not.toContain('/agreements');
    });
});
