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
    it('enforces the bearer token shape and creates private conversations without returning capabilities', async () => {
        const { app } = makeHarness();
        const bad = await request(app).get('/chat/conversations/conv-1').set('Authorization', 'Bearer short');
        expect(bad.status).toBe(401); expect(JSON.stringify(bad.body)).not.toContain(token);
        const created = await auth(request(app).post('/chat/conversations')).send({ city: 'london', language: 'hr' });
        expect(created.status).toBe(201); expect(created.body).toMatchObject({ id: 'conv-1', expiresAt: expect.any(Number) });
        expect(JSON.stringify(created.body)).not.toContain(token);
    });

    it('streams step, plan, reply and done in order, then replays the stored result without another model call', async () => {
        let cooldownCalls = 0;
        const { app, callModel, budget } = makeHarness({ limiters: { cooldown: (_req, res, next) => {
            cooldownCalls++;
            if (cooldownCalls > 1) return res.status(429).json({ code: 'rate_limited_cooldown' });
            next();
        } } });
        const first = await turn(app);
        expect(first.status).toBe(200); expect(first.headers['content-type']).toContain('text/event-stream');
        expect(first.headers['cache-control']).toBe('no-store');
        const events = parseSse(first.text);
        expect(events.map(event => event.name)).toEqual(['step', 'plan', 'reply', 'done']);
        expect(events[2].data).toEqual({ text: 'The park is ready.' });
        const calls = callModel.mock.calls.length;
        const replay = await turn(app);
        expect(parseSse(replay.text)).toEqual(events);
        expect(callModel).toHaveBeenCalledTimes(calls);
        expect(cooldownCalls).toBe(1);
        expect([...budget.rows.values()][0].result.events).toHaveLength(4);
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
