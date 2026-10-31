#!/usr/bin/env node
// Stateless public MCP on loopback. This entry deliberately never loads the backend's secret .env.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { MemoryStore } from 'express-rate-limit';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import { createUrbanGameTheoryMcpServer } from './mcp-server.mjs';
import { createPreviewLinks } from './mcp-preview-links.js';
import { createSharedPlanClient } from './shared-plan-client.js';
import { canonicalArtifact } from './shared-plan-artifact.js';
import { createUrbanGameTheoryTools } from './ugt-agent-tools.js';
// Match the API's JSON request budget. The former 32 KiB ceiling rejected ordinary agreements
// carrying an unpublished layout, long before the application's per-object publication limit.
export const MCP_MAX_REQUEST_BYTES = 15 * 1024 * 1024;


async function readJson(req, limit = MCP_MAX_REQUEST_BYTES) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw Object.assign(new Error('Request body is too large.'), { code: 'mcp-request-too-large', status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('Request body must be JSON.'), { code: 'invalid-json', status: 400 }); }
}
const bearer = req => /^Bearer ([\w-]{32})$/.exec(String(req.headers.authorization || ''))?.[1] || null;

export function assertHostedEnvironment(env) {
    const names = Object.keys(env).filter(name => env[name] && /(?:KEYPAIR|SECRET|TOKEN|PASSWORD|API_KEY|DATABASE_URL)/i.test(name));
    if (names.length) throw new Error(`Hosted MCP environment must contain no credentials: ${names.join(', ')}`);
}

export function createMcpHttpService({ env = process.env, fetchImpl, factory,
    publicOrigin = 'https://urbangametheory.xyz', maxConcurrent = 8, maxPerMinute = 600,
    maxPublishPerMinute = 10, now = Date.now, previewOrigin = env.MCP_PREVIEW_ORIGIN || publicOrigin, previewTtlMs,
    storeDirectory = env.MCP_DRAFT_DIRECTORY || fileURLToPath(new URL('../uploads/mcp-drafts/', import.meta.url)), sharedPlans: providedSharedPlans } = {}) {
    assertHostedEnvironment(env);
    const origin = new URL(publicOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('MCP_PUBLIC_ORIGIN must be an HTTPS origin');
    const appOrigin = new URL(env.UGT_APP_ORIGIN || 'https://urbangametheory.xyz').origin;
    const allowed = ['localhost', '127.0.0.1', '[::1]', origin.hostname, new URL(previewOrigin).hostname, new URL(appOrigin).hostname];
    const hostGuard = hostHeaderValidation(allowed), originGuard = originValidation(allowed);
    let active = 0, count = 0, publishes = 0, start = now();
    const streams = new Set();
    const sessionBudgets = new MemoryStore(); sessionBudgets.init({ windowMs: 60_000 });
    const previews = createPreviewLinks({ origin: previewOrigin, appOrigin, storeDirectory, now, ...(previewTtlMs == null ? {} : { ttlMs: previewTtlMs }) });
    const sharedPlans = providedSharedPlans || createSharedPlanClient({ env, fetchImpl });
    // REST needs the same reference resolver as MCP. It only constructs private immutable artifacts;
    // it neither publishes nor signs, and lets a browser begin from a published plan as well as a draftRef.
    const sharedPlanTools = createUrbanGameTheoryTools({ mode: 'hosted', env, fetchImpl, resolveDraftReference: previews.resolve });
    const resolveSharedPlan = async input => {
        const resolved = await sharedPlanTools.getPlan({ plan: input });
        return canonicalArtifact({ cid: resolved.cid, plan: resolved.plan, designs: resolved.designs });
    };
    const makeServer = factory || (options => createUrbanGameTheoryMcpServer({ mode: 'hosted', env, fetchImpl, ...options }));
    // Count writes at the tool boundary too: this covers legacy clients without MCP routing headers.
    const guardedFactory = () => {
        const server = makeServer({ decorateResult: previews.decorate, resolveDraftReference: previews.resolve, sharedPlans });
        // The shared server applies its write budget through an injected gate, not request headers.
        server.ugtPublishGate = () => {
            resetWindow();
            if (publishes >= maxPublishPerMinute) throw Object.assign(new Error('Publish budget exhausted; retry in one minute.'), { code: 'publish-rate-limited', next: { action: 'Wait one minute and retry.' } });
            publishes++;
        };
        return server;
    };
    function resetWindow() { if (now() - start >= 60_000) { start = now(); count = 0; publishes = 0; } }
    const handler = createMcpHandler(guardedFactory, { legacy: 'stateless', maxRequestBodySize: MCP_MAX_REQUEST_BYTES, maxSubscriptions: 0 });
    const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MCP_MAX_REQUEST_BYTES });
    const http = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (!hostGuard(req, res) || !originGuard(req, res)) return;
        const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
        const rawSessionPath = req.url?.split('?')[0] || '';
        const sessionRoot = rawSessionPath === '/mcp/plan-sessions' || rawSessionPath === '/mcp/plan-sessions/';
        const sessionPath = /^\/mcp\/plan-sessions\/([\w-]{24})(?:\/(control|events|undo))?\/?$/.exec(rawSessionPath);
        if (sessionRoot || sessionPath) {
            if (req.headers.origin === appOrigin) { res.setHeader('Access-Control-Allow-Origin', appOrigin); res.setHeader('Vary', 'Origin'); }
            if (req.method === 'OPTIONS') return json(204, {}, { Allow: 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
            if (closing) return json(503, { code: 'shared-plan-unavailable' });
            const capability = bearer(req);
            if (!sessionRoot && !capability) return json(401, { code: 'shared-plan-capability-required', message: 'Use a shared plan capability.' });
            // These requests must not consume the public MCP or another capability's budget.
            const key = sessionRoot ? `create:${req.socket.remoteAddress}`
                : `cap:${createHash('sha256').update(capability).digest('hex')}`;
            const { totalHits } = await sessionBudgets.increment(key);
            if (active >= maxConcurrent || totalHits > (sessionRoot ? 10 : maxPerMinute)) return json(429, { code: 'rate-limited', message: 'Shared plan request budget exhausted.' }, { 'Retry-After': '60' });
            if (sessionPath?.[2] === 'events' && req.method === 'GET') {
                if (!capability) return json(401, { code: 'shared-plan-capability-required', message: 'Use a shared plan capability.' });
                const id = sessionPath[1];
                try {
                    await sharedPlans.eventState(id, capability);
                    if (closing) return json(503, { code: 'shared-plan-unavailable' });
                    if (streams.size >= 128 || [...streams].filter(stream => stream.id === id).length >= 4) return json(429, { code: 'shared-plan-stream-capacity' });
                    const stream = { id, close }; streams.add(stream);
                    let unsubscribe = () => {}, timer, closed = false;
                    function close() { if (closed) return; closed = true; clearInterval(timer); unsubscribe(); streams.delete(stream); if (!res.destroyed) res.end(); }
                    let sending = Promise.resolve(), ready = false;
                    function send() {
                        sending = sending.then(async () => {
                            if (closed || !ready) return;
                            const state = await sharedPlans.eventState(id, capability);
                            if (!closed && !res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`)) { close(); res.destroy(); }
                        }).catch(close);
                    }
                    res.on('close', close);
                    try { unsubscribe = await sharedPlans.subscribe(id, capability, send, close); }
                    catch (error) { streams.delete(stream); res.removeListener('close', close); throw error; }
                    if (closed || closing || res.destroyed) { close(); unsubscribe(); return; }
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Referrer-Policy': 'no-referrer', 'X-Accel-Buffering': 'no' });
                    timer = setInterval(send, 15_000); timer.unref();
                    ready = true; send();
                } catch (error) { if (!res.headersSent) json(error.status || 400, { code: error.code || 'shared-plan-invalid', message: error.message }); else res.destroy(); }
                return;
            }
            active++;
            try {
                if (sessionRoot && req.method === 'POST') {
                    if (req.headers.origin && req.headers.origin !== appOrigin) return json(403, { code: 'origin-forbidden' });
                    const body = await readJson(req); const result = await sharedPlans.create(await resolveSharedPlan(body.plan));
                    return json(201, result, { 'Referrer-Policy': 'no-referrer' });
                }
                if (!sessionPath || !capability) return json(401, { code: 'shared-plan-capability-required', message: 'Use a shared plan capability.' });
                const id = sessionPath[1], action = sessionPath[2], control = action === 'control';
                if (req.method === 'GET' && !action) return json(200, await sharedPlans.inspect(id, capability), { 'Referrer-Policy': 'no-referrer' });
                const body = await readJson(req);
                if (req.method === 'POST' && control) return json(200, await sharedPlans.control(id, capability, body), { 'Referrer-Policy': 'no-referrer' });
                if (req.method === 'POST' && action === 'undo') return json(200, await sharedPlans.undo(id, capability, body), { 'Referrer-Policy': 'no-referrer' });
                if (req.method === 'PUT' && !action) {
                    await sharedPlans.assertEditable(id, capability, body.expectedVersion);
                    return json(200, await sharedPlans.replace(id, capability, { expectedVersion: body.expectedVersion, artifact: await resolveSharedPlan(body.plan) }), { 'Referrer-Policy': 'no-referrer' });
                }
                return json(405, { code: 'method-not-allowed' }, { Allow: control ? 'POST, OPTIONS' : 'GET, PUT, OPTIONS' });
            } catch (error) { return json(error.status || 400, { code: error.code || 'shared-plan-invalid', message: error.message, ...(error.currentVersion != null ? { currentVersion: error.currentVersion, currentCid: error.currentCid } : {}) }); }
            finally { active--; }
        }
        if (/^\/mcp\/previews\/[\w-]{32}$/.test(req.url)) {
            if (req.method !== 'GET') return json(405, { code: 'method-not-allowed' }, { Allow: 'GET' });
            resetWindow();
            if (count >= maxPerMinute) return json(429, { code: 'rate-limited' }, { 'Retry-After': '60' });
            count++;
            if (req.headers.origin === appOrigin) res.setHeader('Access-Control-Allow-Origin', appOrigin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Referrer-Policy', 'no-referrer');
            const record = previews.get(req.url.split('/').at(-1));
            if (!record) return json(410, { code: 'preview-expired', message: 'This temporary preview is unavailable. Ask your agent to generate it again.' });
            return json(200, record);
        }
        if (req.url === '/healthz' && req.method === 'GET') return json(200, { service: 'ugt-mcp', status: 'ok', upstreamChecked: false });
        if (req.url === '/mcp/server-card' && req.method === 'GET') return json(200, {
            $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
            name: 'xyz.urbangametheory/urban-game-theory', version: '0.4.0', description: 'Create, edit and publish named urban plans and designs; private drafts and wallet approval links.',
            remotes: [{ type: 'streamable-http', url: `${origin.origin}/mcp`, supportedProtocolVersions: ['2026-07-28', '2025-11-25'] }],
            _meta: { 'xyz.urbangametheory/discovery-status': 'experimental-server-card-extension' }
        });
        if (!['/mcp', '/mcp/'].includes(req.url)) return json(404, { code: 'not-found' });
        if (!['POST', 'GET', 'DELETE'].includes(req.method)) return json(405, { code: 'method-not-allowed' }, { Allow: 'POST, GET, DELETE' });
        resetWindow();
        if (active >= maxConcurrent || count >= maxPerMinute) return json(429, { code: 'rate-limited', message: 'MCP request budget exhausted.', next: { action: 'Retry after 60 seconds.' } }, { 'Retry-After': '60' });
        if (req.headers['content-length'] && Number(req.headers['content-length']) > MCP_MAX_REQUEST_BYTES) return json(413, {
            code: 'mcp-request-too-large', maxRequestBytes: MCP_MAX_REQUEST_BYTES,
            message: 'This MCP request exceeds the API JSON request limit.',
            next: { action: 'Pass the returned draftRef and expectedCid to publication tools instead of retransmitting geometry.' }
        });
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
    let closing;
    return { http, close() {
        return closing ||= (async () => {
            // Streams are long-lived; close them before waiting for accepted requests.
            for (const stream of [...streams]) stream.close();
            if (http.listening) {
                const closed = new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
                http.closeIdleConnections();
                await closed;
            }
            try { await handler.close(); }
            finally { sessionBudgets.shutdown(); previews.dispose(); await sharedPlans.dispose(); }
        })();
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const service = createMcpHttpService({ publicOrigin: process.env.MCP_PUBLIC_ORIGIN });
    const port = Number(process.env.MCP_PORT || 3097);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP_PORT');
    service.http.listen(port, '127.0.0.1', () => console.error(`[${new Date().toISOString()}] [ugt-mcp] listening on loopback:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.close().then(() => process.exit(0)));
}
