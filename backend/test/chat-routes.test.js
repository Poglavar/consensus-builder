// Hosted chat route tests cover capability auth, idempotent SSE, spend settlement and aborts.
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouteApp } from './helpers/create-route-app.js';
import { parseSse } from './helpers/sse.js';
import { setupChatRoute } from '../routes/chat.js';

const token = 'a'.repeat(64), turnKey = '00000000-0000-4000-8000-000000000001';
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const prices = { CHAT_PRICE_USD_PER_MTOK_INPUT: '0.1', CHAT_PRICE_USD_PER_MTOK_OUTPUT: '0.5',
    CHAT_PRICE_USD_PER_MTOK_CACHE_READ: '0.01', CHAT_PRICE_USD_PER_MTOK_CACHE_WRITE: '0.125' };
const context = { city: 'london', planCid: null };
const body = (overrides = {}) => ({ turnKey, text: 'Make a park', context, ...overrides });

function createStore({ plan = null, planHistory = [] } = {}) {
    const rows = new Map(); let nextId = 1;
    const seed = (id = 'conv-1', secret = token) => {
        const conversation = { id, tokenHash: tokenHash(secret), city: 'london', language: 'en', plan,
            planHistory: structuredClone(planHistory), messages: [], notes: [], turns: 0, spentUsd: 0, expiresAt: Date.now() + 86_400_000 };
        rows.set(id, conversation); return conversation;
    };
    seed();
    return { rows, seed,
        async create(data) {
            const conversation = { id: `conv-${nextId++}`, tokenHash: data.tokenHash, city: data.city, language: data.language,
                plan: null, planHistory: [], messages: [], notes: [], turns: 0, spentUsd: 0, expiresAt: Date.now() + 86_400_000 };
            rows.set(conversation.id, conversation); return conversation;
        },
        async load(id, hash) { const row = rows.get(id); return row?.tokenHash === hash ? structuredClone(row) : null; },
        async saveTurn(id, patch) { const row = rows.get(id); if (row) Object.assign(row, patch, { turnInProgressSince: null }); },
        async undo(id) { const row = rows.get(id); if (!row?.planHistory.length) throw Object.assign(new Error('Nothing to undo.'), { code: 'nothing_to_undo', status: 409 }); const old = row.planHistory.pop(); row.plan = old; return old; },
        async remove(id) { rows.delete(id); }, dispose() {}
    };
}

function createBudget({ refuse = false } = {}) {
    const rows = new Map(); let next = 1;
    return { rows,
        async findTurn(_pool, conversationId, key) { return [...rows.values()].find(row => row.conversationId === conversationId && row.turnKey === key) || null; },
        async reserveTurn(_pool, value) {
            if (refuse) return null;
            const row = { id: next++, conversationId: value.conversationId, turnKey: value.turnKey, estUsd: value.estUsd, status: 'running' };
            rows.set(row.id, row); return { id: row.id };
        },
        async settleTurn(_pool, id, value) { const row = rows.get(id); if (row) Object.assign(row, value, { result: value.result || null }); },
        async releaseTurn(_pool, id) { rows.delete(id); }
    };
}

function makeHarness({ store = createStore(), budget = createBudget(), runTurn, defaultRunner = false, callModel = vi.fn(async () => ({})), callTool = vi.fn(async () => ({})), env = {}, limiters = {} } = {}) {
    const noLimit = (_req, _res, next) => next();
    const app = createRouteApp(setupChatRoute, null, { env: { ...prices, CHAT_DAILY_CAP_USD: '5', CHAT_MAX_TURNS: '25', ...env }, store,
        runTurn: defaultRunner ? undefined : runTurn || (async ({ callModel: model, emit }) => {
            await model({ messages: [] }); emit('step', { n: 1, tool: 'ugt_draft_space', summary: 'Created a park.', ok: true });
            return { plan: { draftRef: 'https://mcp.example/draft', cid: 'plan-cid' }, planHistory: [], messages: [], turns: 1, spentUsd: 0.01,
                planChanged: true, steps: [{ n: 1, tool: 'ugt_draft_space', ok: true }], usage: { input_tokens: 10, output_tokens: 5 },
                costUsd: 0.01, usageUncertain: false, outcome: { type: 'reply', text: 'The park is ready.' } };
        }), callModel, callTool, budget, limiters: { create: noLimit, cooldown: noLimit.cooldown || noLimit, ...limiters } });
    return { app, store, budget, callModel, callTool };
}
const auth = req => req.set('Authorization', `Bearer ${token}`);
const turn = (app, id = 'conv-1', data = body()) => auth(request(app).post(`/chat/conversations/${id}/turns`)).send(data);

describe('chat conversation routes', () => {
    it('accepts bounded live parcel labels in turn context without sending an extra model payload', async () => {
        const runTurn = vi.fn(async ({ context: received }) => ({ messages: [], usage: {}, costUsd: 0, outcome: { type: 'reply', text: received.mapContext.display.parcelIds ? 'IDs shown.' : 'IDs hidden.' } }));
        const { app } = makeHarness({ runTurn });
        const mapContext = { parcelSourceId: 'source', display: { parcelIds: true }, visibleParcels: [{ parcelId: 'live-p', label: '17/2', point: [-0.1,51.5] }], visibleParcelsTruncated: false, viewBounds: [-0.11,51.49,-0.09,51.51] };
        const res = await turn(app, 'conv-1', body({ context: { ...context, parcelSourceId: 'source', mapContext } }));
        expect(res.status).toBe(200);
        expect(runTurn.mock.calls[0][0].context.mapContext).toEqual(mapContext);
        const bad = await turn(app, 'conv-1', body({ context: { ...context, mapContext: { ...mapContext, visibleParcels: Array(501).fill(mapContext.visibleParcels[0]) } } }));
        expect(bad.status).toBe(400);
    });

    it('reports configured prices and server-computed estimates without provider calls', async () => {
        const { app, callModel } = makeHarness({ env: { CHAT_DEBUG_COSTS: 'true', CHAT_PROVIDER: 'openai', CHAT_MODEL: 'gpt-6-luna' } });
        const configured = await request(app).get('/chat/cost');
        expect(configured.status).toBe(200);
        expect(configured.headers['cache-control']).toBe('no-store');
        expect(configured.body).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', currency: 'USD',
            pricesPerMillionTokens: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
            maximumTurnReservationUsd: 0.130716 });
        expect(configured.body).not.toHaveProperty('estimate');
        const estimate = await request(app).get('/chat/cost?inputTokens=100&outputTokens=50&cachedInputTokens=20&cacheWriteTokens=10');
        expect(estimate.status).toBe(200);
        expect(estimate.body.estimate).toEqual({ costUsd: 0.000036, basis: 'configured-token-prices', actual: false,
            tokenCounts: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, cacheWriteTokens: 10 } });
        const current = await auth(request(app).get('/chat/conversations/conv-1'));
        expect(current.body.debugCosts).toBe(true);
        expect(callModel).not.toHaveBeenCalled();
    });

    it('bounds cost query token counts and fails closed when prices are not configured', async () => {
        const { app } = makeHarness({ env: { CHAT_DEBUG_COSTS: '1' } });
        expect((await request(app).get('/chat/cost?inputTokens=-1')).status).toBe(400);
        expect((await request(app).get('/chat/cost?inputTokens=1000001')).status).toBe(400);
        expect((await request(app).get('/chat/cost?inputTokens=700000&outputTokens=300001')).status).toBe(400);
        const missing = makeHarness({ env: { CHAT_DEBUG_COSTS: 'true', CHAT_PRICE_USD_PER_MTOK_CACHE_READ: undefined } });
        expect((await request(missing.app).get('/chat/cost')).status).toBe(503);
        const unsupported = makeHarness({ env: { CHAT_DEBUG_COSTS: 'true', CHAT_PROVIDER: 'unknown', CHAT_MODEL: 'unknown' } });
        expect((await request(unsupported.app).get('/chat/cost')).status).toBe(503);
        const disabled = makeHarness();
        expect((await request(disabled.app).get('/chat/cost')).status).toBe(404);
    });

    it('enforces the bearer token shape and creates private conversations without returning capabilities', async () => {
        const { app } = makeHarness();
        const bad = await request(app).get('/chat/conversations/conv-1').set('Authorization', 'Bearer short');
        expect(bad.status).toBe(401); expect(JSON.stringify(bad.body)).not.toContain(token);
        const created = await auth(request(app).post('/chat/conversations')).send({ city: 'london', language: 'hr' });
        expect(created.status).toBe(201); expect(created.body).toMatchObject({ id: 'conv-1', city: 'london', expiresAt: expect.any(Number), debugCosts: false });
        const current = await auth(request(app).get('/chat/conversations/conv-1'));
        expect(current.body).toMatchObject({ city: 'london', debugCosts: false });
        expect(JSON.stringify(created.body)).not.toContain(token);
    });

    it('rejects a different city before calling the model, changing the plan or reserving spend', async () => {
        const plan = { draftRef: 'https://mcp.example/old-city', cid: 'old-plan' };
        const store = createStore({ plan }), runTurn = vi.fn();
        const { app, budget, callModel, callTool } = makeHarness({ store, runTurn });
        const result = await turn(app, 'conv-1', body({ context: { city: 'birmingham', planCid: null } }));
        expect(result.status).toBe(409);
        expect(result.body.code).toBe('conversation_city_mismatch');
        expect(runTurn).not.toHaveBeenCalled();
        expect(callModel).not.toHaveBeenCalled();
        expect(callTool).not.toHaveBeenCalled();
        expect(budget.rows.size).toBe(0);
        expect(store.rows.get('conv-1').plan).toEqual(plan);
    });
    it('streams and persists private agreement review state separately from the working plan', async () => {
        const agreement = { draftRef: 'https://mcp.example/agreement', cid: 'agreement-cid', planCid: 'plan-cid',
            previewUrl: 'https://app.example/designs?draft=secret', summary: { title: 'Land exchange' } };
        const runTurn = vi.fn(async () => ({ agreement, agreementHistory: [null], agreementChanged: true,
            plan: null, planHistory: [], messages: [], turns: 1, spentUsd: 0.01, steps: [], usage: {}, costUsd: 0.01,
            modelCalls: 1, usageUncertain: false, outcome: { type: 'reply', text: 'The agreement is ready to review.' } }));
        const { app, store } = makeHarness({ runTurn });
        const response = await turn(app, 'conv-1', body({ turnKey: '00000000-0000-4000-8000-000000000002' }));
        const events = parseSse(response.text);
        expect(events.map(event => event.name)).toEqual(['agreement', 'reply', 'done']);
        expect(events[0].data).toMatchObject({ draftRef: agreement.draftRef, cid: agreement.cid, planCid: agreement.planCid,
            previewUrl: agreement.previewUrl, previousCid: null, summary: agreement.summary });
        expect(store.rows.get('conv-1')).toMatchObject({ plan: null, agreement, agreementHistory: [null] });
        const state = await auth(request(app).get('/chat/conversations/conv-1'));
        expect(state.body).toMatchObject({ plan: null, agreement });
    });

    it('streams step, plan, reply and done in order, then replays the stored result without another model call', async () => {
        let cooldownCalls = 0;
        const { app, callModel, budget } = makeHarness({ env: { CHAT_DEBUG_COSTS: 'true' }, limiters: { cooldown: (_req, res, next) => {
            cooldownCalls++;
            if (cooldownCalls > 1) return res.status(429).json({ code: 'rate_limited_cooldown' });
            next();
        } } });
        const first = await turn(app);
        expect(first.status).toBe(200); expect(first.headers['content-type']).toContain('text/event-stream');
        expect(first.headers['cache-control']).toBe('no-store');
        const events = parseSse(first.text);
        expect(events.map(event => event.name)).toEqual(['step', 'plan', 'reply', 'done']);
        expect(events.at(-1).data.debugCosts).toBe(true);
        expect(events[2].data).toEqual({ text: 'The park is ready.' });
        const calls = callModel.mock.calls.length;
        const replay = await turn(app);
        expect(parseSse(replay.text)).toEqual(events);
        expect(callModel).toHaveBeenCalledTimes(calls);
        expect(cooldownCalls).toBe(1);
        expect([...budget.rows.values()][0].result.events).toHaveLength(4);
    });

    it('accepts current locale and cursor and replays absolute navigation without another runner call', async () => {
        const runTurn = vi.fn(async ({ context: received, emit }) => {
            expect(received.language).toBe('fr');
            expect(received.selection).toMatchObject({ focusParcelId: 'p2', parcelIds: ['p1'], active: true });
            emit('view', { view: { at: '51.5,-0.1,18' } });
            emit('selection', { selection: { parcelSourceId: 'source', focusParcelId: 'p2', parcelIds: ['p1', 'p2'], active: false } });
            return { plan: null, planHistory: [], messages: [], planChanged: false, steps: [], usage: {}, costUsd: 0,
                modelCalls: 0, usageUncertain: false, outcome: { type: 'reply', text: 'Terminé.' } };
        });
        const { app } = makeHarness({ runTurn });
        const data = body({ language: 'fr', context: { ...context, selection: { focusParcelId: 'p2', parcelIds: ['p1'], active: true } } });
        const first = await turn(app, 'conv-1', data), replay = await turn(app, 'conv-1', data);
        expect(first.status).toBe(200);
        expect(parseSse(first.text).map(event => event.name)).toEqual(['view', 'selection', 'reply', 'done']);
        expect(parseSse(replay.text)).toEqual(parseSse(first.text));
        expect(runTurn).toHaveBeenCalledTimes(1);
    });

    it('returns 402 on an exhausted budget and 409 when a changed plan lacks its artifact', async () => {
        const exhausted = makeHarness({ budget: createBudget({ refuse: true }) });
        const payment = await turn(exhausted.app);
        expect(payment.status).toBe(402); expect(payment.body.code).toBe('budget_exhausted');
        expect(exhausted.callModel).not.toHaveBeenCalled();
        const { app, callModel } = makeHarness();
        const missing = await turn(app, 'conv-1', body({ turnKey: '00000000-0000-4000-8000-000000000002', context: { ...context, planCid: 'plan-cid' } }));
        expect(missing.status).toBe(409); expect(missing.body.code).toBe('plan_artifact_required');
        expect(callModel).not.toHaveBeenCalled();
    });

    it('rejects a concurrent turn while the first turn is running', async () => {
        let release, entered;
        const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
        const runTurn = async ({ callModel: model }) => { await model({}); entered(); await gate;
            return { plan: null, planHistory: [], messages: [], planChanged: false, steps: [], usage: {}, costUsd: 0, outcome: { type: 'reply', text: 'done' } }; };
        const { app } = makeHarness({ runTurn });
        const pending = turn(app, 'conv-1', body({ turnKey: '00000000-0000-4000-8000-000000000010' })).then(response => response);
        await ready;
        const conflict = await turn(app, 'conv-1', body({ turnKey: '00000000-0000-4000-8000-000000000011' }));
        expect(conflict.status).toBe(409); expect(conflict.body.code).toBe('turn_in_progress');
        release(); expect((await pending).status).toBe(200);
    });

    it('supports undo and deletion, and enforces the trimmed text cap', async () => {
        const previous = { draftRef: 'https://mcp.example/old', cid: 'old-cid' }, { app, store } = makeHarness({ store: createStore({ plan: { draftRef: 'https://mcp.example/new', cid: 'new-cid' }, planHistory: [previous] }) });
        const undone = await auth(request(app).post('/chat/conversations/conv-1/undo')).send({});
        expect(undone.status).toBe(200); expect(undone.body).toEqual(previous);
        const tooLong = await turn(app, 'conv-1', body({ turnKey: '00000000-0000-4000-8000-000000000020', text: 'x'.repeat(2001) }));
        expect(tooLong.status).toBe(400); expect(tooLong.body.code).toBe('invalid_request');
        const deleted = await auth(request(app).delete('/chat/conversations/conv-1'));
        expect(deleted.status).toBe(204); expect(store.rows.has('conv-1')).toBe(false);
        const gone = await auth(request(app).get('/chat/conversations/conv-1'));
        expect(gone.status).toBe(404); expect(gone.body.code).toBe('conversation_not_found');
    });

    it('records an uncertain aborted model call without exposing provider error text', async () => {
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const runTurn = async ({ callModel: model, signal }) => {
            await model({}); entered();
            await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('secret-provider-detail')), { once: true }));
        };
        const { app, budget } = makeHarness({ runTurn });
        const req = auth(request(app).post('/chat/conversations/conv-1/turns')).send(body({ turnKey: '00000000-0000-4000-8000-000000000030' }));
        req.end(() => {});
        await ready; req.abort();
        await vi.waitFor(() => expect([...budget.rows.values()].some(row => row.status === 'aborted')).toBe(true));
        const settled = [...budget.rows.values()].find(row => row.status === 'aborted');
        expect(settled.costUsd).toBeNull();
        expect(settled.estUsd).toBeGreaterThan(0);
        expect(JSON.stringify(settled.result)).not.toContain('secret-provider-detail');
    });

    it('persists a successful tool mutation and its plan even when the client disconnects before the next model call', async () => {
        let enteredTool;
        const toolReady = new Promise(resolve => { enteredTool = resolve; });
        const callModel = vi.fn(async () => ({ stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 }, content: [
            { type: 'tool_use', id: 'tool-1', name: 'ugt_draft_space', input: { city: 'london', spaceKind: 'park' } }
        ] }));
        const callTool = vi.fn(async (_name, _args, { signal }) => {
            // Model the successful external write, then let the disconnected client abort the stream.
            enteredTool();
            if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            return { structuredContent: { plan: { draftRef: 'https://mcp.example/plan-draft', cid: 'new-plan-cid' }, placement: { status: 'placed' } } };
        });
        callTool.listTools = async () => [{ name: 'ugt_draft_space', description: 'Draft a park.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }];
        const { app, store, budget } = makeHarness({ defaultRunner: true, callModel, callTool });
        const req = auth(request(app).post('/chat/conversations/conv-1/turns')).send(body({ turnKey: '00000000-0000-4000-8000-000000000040' }));
        req.end(() => {});
        await toolReady;
        req.abort();
        await vi.waitFor(() => expect([...budget.rows.values()].some(row => row.status === 'aborted')).toBe(true));
        expect(callModel).toHaveBeenCalledTimes(1);
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(store.rows.get('conv-1').plan).toMatchObject({ draftRef: 'https://mcp.example/plan-draft', cid: 'new-plan-cid' });
        expect(store.rows.get('conv-1').turns).toBe(1);
        const settled = [...budget.rows.values()].find(row => row.status === 'aborted');
        expect(settled.costUsd).toBeGreaterThan(0);
        expect(settled.result.events.map(event => event.name)).toEqual(['step', 'plan', 'error']);
        expect(settled.result.events[1].data).toMatchObject({ cid: 'new-plan-cid', draftRef: 'https://mcp.example/plan-draft' });
    });
});
