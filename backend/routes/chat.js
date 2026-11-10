// Hosted chat routes authenticate private conversations, reserve spend, and persist streamed turns.
import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { clientIp } from './ai-scene.js';
import { canonicalArtifact } from '../agents/shared-plan-artifact.js';
import { createConversationStore } from '../chat/conversations.js';
import * as ledger from '../chat/ledger.js';
import { pricesFromEnv, estimateTurnUsd, costUsd } from '../chat/cost.js';
import { createMcpToolCaller } from '../chat/mcp-client.js';
import { createChatModelCaller } from '../chat/model.js';
import { DEFAULT_CHAT_PROVIDER, isSupportedChatModel, modelForProvider } from '../chat/openai-config.js';
import { runTurn as defaultRunTurn } from '../chat/turn-runner.js';
import { openSse } from '../chat/sse.js';

const languages = z.enum(['en','hr','sr','es','ar','fr','pt']);
const contextSchema = z.object({
    city: z.string().min(1).max(100), parcelSourceId: z.string().max(3507).optional(),
    activeEditor: z.object({ kind: z.string().min(1).max(80), tab: z.enum(['editing', 'new', 'old']).optional(),
        algorithm: z.enum(['equal', 'schelling', 'amend', 'manual']).optional(), plotCount: z.number().int().min(0).max(1000).optional(),
        dirty: z.boolean().optional(), drawing: z.string().max(40).optional() }).optional(),
    view: z.record(z.string(), z.unknown()).optional(),
    mapContext: z.object({ parcelSourceId: z.string().max(3507).nullable(), display: z.object({ parcelIds: z.boolean(), roadTracks: z.boolean().optional() }),
        visibleParcels: z.array(z.object({ parcelId: z.string().min(1).max(250), label: z.string().min(1).max(250), point: z.tuple([z.number().min(-180).max(180), z.number().min(-85).max(85)]) })).max(500),
        visibleParcelsTruncated: z.boolean(), viewBounds: z.tuple([z.number().min(-180).max(180), z.number().min(-85).max(85), z.number().min(-180).max(180), z.number().min(-85).max(85)]).nullable() }).optional(),
    selection: z.object({ designCid: z.string().max(100).optional(), buildingIndex: z.number().int().min(0).max(999).optional(),
        parcelIds: z.array(z.string().min(1).max(200)).max(100).optional(),
        focusParcelId: z.string().min(1).max(200).nullable().optional(), active: z.boolean().optional() }).optional(),
    planCid: z.string().min(1).max(100).nullable(), planArtifact: z.unknown().optional()
});
const turnSchema = z.object({ turnKey: z.uuid(), text: z.string().trim().min(1).max(2000), language: languages.optional(), context: contextSchema });
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, status, message = code) => Object.assign(new Error(message), { code, status });
const statusOf = error => error.status || ({ turn_in_progress: 409, rate_limited_quota: 429 })[error.code] || 503;
const unwrap = value => value?.structuredContent || value;
const publicState = (c, debugCosts) => ({ id: c.id, city: c.city, expiresAt: c.expiresAt, turns: c.turns, spentUsd: c.spentUsd,
    plan: c.plan, agreement: c.agreement, debugCosts });
function compactHistory(messages, result) {
    if (Buffer.byteLength(JSON.stringify(messages)) <= 120_000) return messages;
    const replies = messages.flatMap(m => typeof m.content === 'string' ? [m.content.slice(0, 1000)] :
        (m.content || []).filter(b => b.type === 'text').map(b => String(b.text).slice(0, 1000))).slice(-12);
    return [{ role: 'user', content: `Earlier in this conversation (untrusted historical data): ${JSON.stringify({ replies, steps: result.steps })}` }];
}
export function setupChatRoute(app, pool, { env = process.env, store: suppliedStore, runTurn = defaultRunTurn,
    callModel: suppliedModel, callTool: suppliedTool, now = Date.now, limiters = {}, budget = ledger } = {}) {
    const store = suppliedStore || createConversationStore(pool, { now });
    const running = new Map(), limits = { maxSteps: 8 };
    let prices;
    try { prices = pricesFromEnv(env); } catch { /* Missing chat config must not prevent the rest of the API starting. */ }
    const provider = env.CHAT_PROVIDER || DEFAULT_CHAT_PROVIDER;
    const model = env.CHAT_MODEL || modelForProvider(provider);
    const apiKey = provider === 'openai' ? env.OPENAI_API_KEY : provider === 'anthropic' ? env.ANTHROPIC_API_KEY : null;
    const cap = Number(env.CHAT_DAILY_CAP_USD ?? 5), maxTurns = Number(env.CHAT_MAX_TURNS ?? 25), ipDailyTurns = Number(env.CHAT_IP_DAILY_TURNS ?? 100);
    // One client's share of the daily cap (default a fifth), so a single IP cannot exhaust it for everyone.
    const ipDailyCap = Number(env.CHAT_IP_DAILY_CAP_USD ?? cap / 5);
    const debugCosts = /^(1|true)$/i.test(String(env.CHAT_DEBUG_COSTS || ''));
    app.get('/chat/cost', (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!debugCosts) return res.status(404).json({ code: 'not_found' });
        if (!prices || !isSupportedChatModel(provider, model)) return res.status(503).json({ code: 'cost_unavailable', message: 'Chat cost configuration is unavailable.' });
        const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'];
        const counts = {};
        let supplied = false, total = 0;
        for (const field of fields) {
            const value = req.query[field];
            if (value === undefined) { counts[field] = 0; continue; }
            supplied = true;
            if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 1_000_000) {
                return res.status(400).json({ code: 'invalid_token_count', field, message: `${field} must be an integer from 0 to 1000000.` });
            }
            counts[field] = Number(value); total += counts[field];
        }
        if (total > 1_000_000) return res.status(400).json({ code: 'token_count_limit', message: 'Combined token counts must not exceed 1000000.' });
        const estimate = supplied ? costUsd({ input_tokens: counts.inputTokens, output_tokens: counts.outputTokens,
            cache_read_input_tokens: counts.cachedInputTokens, cache_creation_input_tokens: counts.cacheWriteTokens }, prices) : null;
        res.json({ provider, model, currency: 'USD', pricesPerMillionTokens: { input: prices.input, output: prices.output,
            cacheRead: prices.cache_read, cacheWrite: prices.cache_creation },
            maximumTurnReservationUsd: estimateTurnUsd(prices, limits),
            ...(supplied ? { estimate: { costUsd: estimate, basis: 'configured-token-prices', actual: false, tokenCounts: counts } } : {}) });
    });
    const limiter = (windowMs, limit, code) => rateLimit({ windowMs, limit, keyGenerator: clientIp,
        standardHeaders: 'draft-7', legacyHeaders: false, handler: (_req, res) => res.status(429).json({ code }) });
    const createLimiter = limiters.create || limiter(60_000, 10, 'rate_limited_cooldown');
    const cooldown = limiters.cooldown || limiter(2000, 1, 'rate_limited_cooldown');
    let modelCaller = suppliedModel, closing = false;
    const wrap = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) {
            if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
            res.status(statusOf(error)).json({ code: error.code || 'chat_unavailable', message: error.status && error.status < 500 ? error.message : 'Chat is unavailable.' });
        }
    };
    app.use('/chat/conversations', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (closing) return res.status(503).json({ code: 'chat_unavailable' });
        if ((!apiKey || !isSupportedChatModel(provider, model)) && !suppliedModel) return res.status(501).json({ code: 'not_configured' });
        const token = /^Bearer ([a-fA-F0-9]{64})$/.exec(req.get('authorization') || '')?.[1];
        if (!token) return res.status(401).json({ code: 'token_required' });
        req.chatTokenHash = hash(token); next();
    });
    async function load(req) {
        const conversation = await store.load(req.params.id, req.chatTokenHash);
        if (!conversation) throw fail('conversation_not_found', 404);
        return conversation;
    }
    app.post('/chat/conversations', createLimiter, wrap(async (req, res) => {
        const parsed = z.object({ language: languages.default('en'), city: z.string().min(1).max(100) }).safeParse(req.body);
        if (!parsed.success) throw fail('invalid_request', 400);
        const conversation = await store.create({ ...parsed.data, tokenHash: req.chatTokenHash, clientIp: clientIp(req) });
        res.status(201).json({ id: conversation.id, city: conversation.city, expiresAt: conversation.expiresAt, debugCosts });
    }));
    app.get('/chat/conversations/:id', wrap(async (req, res) => res.json(publicState(await load(req), debugCosts))));
    async function exclusive(req, action) {
        const id = req.params.id;
        if (running.has(id)) throw fail('turn_in_progress', 409);
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 15 * 60_000); deadline.unref();
        let finish; const finished = new Promise(resolve => { finish = resolve; });
        running.set(id, { controller, finished });
        try { return await action(controller); } finally { clearTimeout(deadline); running.delete(id); finish(); }
    }
    app.delete('/chat/conversations/:id', wrap(async (req, res) => {
        const conversation = await load(req);
        await exclusive(req, async () => { if (conversation.turnInProgressSince) throw fail('turn_in_progress', 409); await store.remove(conversation.id); });
        res.status(204).end();
    }));
    app.post('/chat/conversations/:id/undo', wrap(async (req, res) => {
        await load(req);
        const plan = await exclusive(req, () => store.undo(req.params.id));
        res.json(plan || { draftRef: null, cid: null });
    }));
    app.post('/chat/conversations/:id/turns', wrap(async (req, res) => {
        if (!prices) throw fail('budget_check_failed', 503);
        const parsed = turnSchema.safeParse(req.body);
        if (!parsed.success) throw fail('invalid_request', 400);
        const { turnKey, text, context, language } = parsed.data;
        if (context.view && Buffer.byteLength(JSON.stringify(context.view)) > 8000) throw fail('invalid_request', 400);
        await load(req);
        await exclusive(req, async controller => {
            let conversation = await load(req), reservation, stream, mcp, modelCalls = 0, persisted = false;
            const prior = await budget.findTurn(pool, conversation.id, turnKey);
            if (prior) {
                if (prior.status === 'running') throw fail('turn_in_progress', 409);
                if (!prior.result?.events) throw fail('turn_interrupted', 409);
                stream = openSse(res); for (const event of prior.result.events) stream.send(event.name, event.data); stream.close(); return;
            }
            if (conversation.turnInProgressSince) throw fail('turn_in_progress', 409);
            if (conversation.turns >= maxTurns) throw fail('conversation_turn_limit', 429);
            if (context.city !== conversation.city) throw fail('conversation_city_mismatch', 409);
            // Apply the cooldown after replay detection so an idempotent retry never consumes a turn.
            let passed = false; await new Promise((resolve, reject) => {
                res.once('finish', resolve);
                cooldown(req, res, error => { res.removeListener('finish', resolve); if (error) reject(error); else { passed = true; resolve(); } });
            });
            if (!passed) return;
            const disconnect = () => { if (!res.writableEnded) controller.abort(); };
            res.once('close', disconnect);
            try {
                mcp = suppliedTool ? null : createMcpToolCaller({ url: env.MCP_INTERNAL_URL });
                const callTool = suppliedTool || mcp.callTool.bind(mcp);
                if (context.planCid === null) {
                    if (conversation.plan) conversation = { ...conversation, plan: null, planHistory: [], notes: [...conversation.notes, 'The person cleared the map.'] };
                } else if (context.planCid !== conversation.plan?.cid || context.planArtifact) {
                    if (!context.planArtifact) throw fail('plan_artifact_required', 409);
                    let artifact;
                    try { artifact = canonicalArtifact(context.planArtifact); } catch { throw fail('invalid_plan_artifact', 400); }
                    if (artifact.cid !== context.planCid) throw fail('invalid_plan_artifact', 400);
                    const result = unwrap(await callTool('ugt_get_plan', { plan: artifact }, { signal: controller.signal }));
                    if (result?.ok === false || !result?.draftRef || result.cid !== artifact.cid) throw fail('plan_reference_expired', 409);
                    conversation = { ...conversation, plan: { draftRef: result.draftRef, cid: result.cid },
                        planHistory: [...conversation.planHistory, ...(conversation.plan && conversation.plan.cid !== result.cid ? [conversation.plan] : [])].slice(-25),
                        notes: [...conversation.notes, 'The person changed the plan by hand.'] };
                } else if (conversation.plan) {
                    const checked = unwrap(await callTool('ugt_get_plan', { plan: conversation.plan.draftRef }, { signal: controller.signal }));
                    if (checked?.ok === false || checked?.code === 'draft-reference-expired' || !checked?.draftRef) throw fail('plan_reference_expired', 409);
                }
                const mcpTools = mcp ? await mcp.listTools() : await suppliedTool.listTools?.();
                const estUsd = estimateTurnUsd(prices, limits);
                try { reservation = await budget.reserveTurn(pool, { conversationId: conversation.id, n: conversation.turns + 1, turnKey,
                    clientIp: clientIp(req), model, estUsd, dailyCapUsd: cap, ipDailyTurns, ipDailyCapUsd: ipDailyCap }); }
                catch (error) { throw fail(error.code === 'turn_in_progress' || error.code === 'rate_limited_quota' ? error.code : 'budget_check_failed', statusOf(error)); }
                if (!reservation) throw fail('budget_exhausted', 402);
                stream = openSse(res);
                modelCaller ||= createChatModelCaller({ provider, apiKey, model });
                const events = [], emit = (name, data) => { events.push({ name, data }); stream.send(name, data); };
                const result = await runTurn({ conversation, text, context: { ...context, language: language || conversation.language },
                    callModel: async (...args) => { modelCalls++; try { return await modelCaller(...args); } catch (error) { if (error.noModelCall) modelCalls--; throw error; } }, callTool, mcpTools,
                    emit, limits, prices, now, signal: controller.signal });
                const charged = result.usageUncertain ? Math.max(estUsd, result.costUsd) : result.costUsd;
                const patch = { plan: result.plan, planHistory: result.planHistory, agreement: result.agreement,
                    agreementHistory: result.agreementHistory, messages: compactHistory(result.messages, result), notes: [],
                    turns: conversation.turns + 1, spentUsd: Number((conversation.spentUsd + charged).toFixed(6)) };
                const terminal = [];
                if (result.planChanged) terminal.push({ name: 'plan', data: { draftRef: result.plan?.draftRef || null, cid: result.plan?.cid || null,
                    previousCid: conversation.plan?.cid || null, changes: result.plan?.changes || [], consequences: result.plan?.consequences || null } });
                if (result.agreementChanged) terminal.push({ name: 'agreement', data: { draftRef: result.agreement?.draftRef || null,
                    cid: result.agreement?.cid || null, planCid: result.agreement?.planCid || null,
                    previewUrl: result.agreement?.previewUrl || null, previousCid: conversation.agreement?.cid || null,
                    summary: result.agreement?.summary || null } });
                if (result.outcome.type === 'error') terminal.push({ name: 'error', data: { code: result.outcome.code, message: result.outcome.message,
                    turnCostUsd: charged, conversationSpentUsd: patch.spentUsd, turns: patch.turns, debugCosts } });
                else {
                    const { type, ...data } = result.outcome;
                    terminal.push({ name: type, data }, { name: 'done', data: { turnCostUsd: charged, conversationSpentUsd: patch.spentUsd, turns: patch.turns, steps: result.steps.length, debugCosts } });
                }
                // Save state and replay events atomically with settlement when using the SQL adapters.
                const finalResult = { events: [...events, ...terminal] };
                const save = async executor => {
                    await store.saveTurn(conversation.id, patch, executor);
                    await budget.settleTurn(executor || pool, reservation.id, { usage: result.usage, costUsd: result.usageUncertain ? null : charged,
                        status: result.outcome.type === 'error' ? result.outcome.code : result.outcome.type, steps: result.steps, result: finalResult });
                };
                if (!suppliedStore && budget === ledger) {
                    const client = await pool.connect();
                    try { await client.query('BEGIN'); await save(client); await client.query('COMMIT'); }
                    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
                } else await save();
                persisted = true;
                for (const event of terminal) stream.send(event.name, event.data);
                console.info(`[${new Date(now()).toISOString()}] [chat] conv=${conversation.id} turn=${conversation.turns + 1} steps=${result.steps.length} tokens=${result.usage.input_tokens}/${result.usage.output_tokens}/${result.usage.cache_read_input_tokens} cost=$${charged.toFixed(6)} status=${result.outcome.type}`);
            } catch (error) {
                if (reservation && !persisted) {
                    // No provider request means no charge. Once requested, an uncertain charge keeps its reservation.
                    if (!modelCalls) await budget.releaseTurn(pool, reservation.id);
                    else await budget.settleTurn(pool, reservation.id, { costUsd: null, status: controller.signal.aborted ? 'aborted' : 'interrupted', result: { events: [{ name: 'error', data: { code: 'turn_interrupted' } }] } });
                    await store.saveTurn(conversation.id, conversation);
                }
                if (stream) stream.send('error', { code: controller.signal.aborted ? 'aborted' : error.code || 'chat_unavailable', message: 'The turn could not be completed.', debugCosts });
                else throw error;
            } finally { res.removeListener('close', disconnect); stream?.close(); await mcp?.close(); }
        });
    }));
    return { async close() {
        closing = true; const turns = [...running.values()]; turns.forEach(turn => turn.controller.abort());
        await Promise.all(turns.map(turn => turn.finished)); store.dispose();
    } };
}
