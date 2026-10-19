// The AI scene lifetime budget must hold under concurrency: the check and the spend record used to
// be two separate steps, so N simultaneous renders all read the same pre-render total, all passed,
// and together overshot AI_SCENE_BUDGET_USD. These drive concurrent renders through the real route
// against a fake ledger that behaves like Postgres where it matters (an advisory lock that is held
// until COMMIT/ROLLBACK, and statements that read the ledger at the moment they run).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const PNG = 'data:image/png;base64,' + Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 1)
]).toString('base64');

function createLedgerPool() {
    const rows = [];
    const stats = { gateEvents: 0 }; // budget checks that have run (passed or refused)
    let nextId = 1;
    let lockHeld = null; // promise that resolves when the current holder releases
    const sum = () => rows.reduce((s, r) => s + r.cost_usd, 0);

    async function runStatement(sql, params) {
        const text = sql.replace(/\s+/g, ' ').trim();
        if (/^SELECT COALESCE\(SUM\(cost_usd\), 0\) AS total FROM ai_scene_spend$/.test(text)) {
            stats.gateEvents++;
            return { rows: [{ total: sum() }] };
        }
        if (/^INSERT INTO ai_scene_spend \(model, cost_usd\) VALUES/.test(text)) {
            rows.push({ id: nextId++, model: params[0], cost_usd: Number(params[1]) });
            return { rows: [] };
        }
        if (/^INSERT INTO ai_scene_spend \(model, cost_usd\) SELECT \$1, \$2 WHERE/.test(text)) {
            const [model, est, budget] = params;
            stats.gateEvents++;
            if (sum() + Number(est) > Number(budget)) return { rows: [] };
            const row = { id: nextId++, model, cost_usd: Number(est) };
            rows.push(row);
            return { rows: [{ id: row.id }] };
        }
        if (/^UPDATE ai_scene_spend SET cost_usd = \$2 WHERE id = \$1$/.test(text)) {
            const row = rows.find(r => r.id === params[0]);
            if (row) row.cost_usd = Number(params[1]);
            return { rows: [] };
        }
        if (/^DELETE FROM ai_scene_spend WHERE id = \$1$/.test(text)) {
            const i = rows.findIndex(r => r.id === params[0]);
            if (i >= 0) rows.splice(i, 1);
            return { rows: [] };
        }
        throw new Error(`fake ledger: unexpected SQL: ${text}`);
    }

    return {
        rows,
        stats,
        async query(sql, params) {
            await Promise.resolve();
            return runStatement(sql, params);
        },
        async connect() {
            let release = null;
            return {
                async query(sql, params) {
                    await Promise.resolve();
                    const text = sql.trim();
                    if (text === 'BEGIN') return { rows: [] };
                    if (text === 'COMMIT' || text === 'ROLLBACK') {
                        if (release) { const r = release; release = null; r(); }
                        return { rows: [] };
                    }
                    if (/pg_advisory_xact_lock/.test(text)) {
                        while (lockHeld) await lockHeld;
                        lockHeld = new Promise(resolve => {
                            release = () => { lockHeld = null; resolve(); };
                        });
                        return { rows: [{}] };
                    }
                    return runStatement(sql, params);
                },
                release() {}
            };
        }
    };
}

let setupAiSceneRoute;
const savedEnv = {};
const ENV = { AI_SCENE_BUDGET_USD: '0.1', GEMINI_API_KEY: 'test-key', AI_SCENE_FORCED_MODEL: '', AI_SCENE_FORCE_PROMPT: '' };

beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
    vi.resetModules();
    ({ setupAiSceneRoute } = await import('../routes/ai-scene.js'));
}, 60_000); // a fresh module graph; slow only on a loaded host

afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    vi.unstubAllGlobals();
});

function geminiOk() {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] } }],
            usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 1290, totalTokenCount: 6290 }
        })
    };
}

function makeApp(pool) {
    const app = express();
    // Prod trusts one proxy hop (index.js) so req.ip is the visitor; here X-Forwarded-For stands in.
    app.set('trust proxy', true);
    app.use(express.json({ limit: '15mb' }));
    setupAiSceneRoute(app, pool);
    return app;
}

const render = (app, i) => request(app)
    .post('/ai-scene/render')
    .set('X-Forwarded-For', `203.0.113.${i + 1}`) // distinct IPs: the per-IP cooldown is not what is under test
    .send({ image: PNG, prompt: 'photorealistic', model: 'gemini-2.5-flash-image' });

describe('AI scene lifetime budget', () => {
    let pool;
    beforeEach(() => { pool = createLedgerPool(); });

    it('concurrent renders cannot overshoot the budget', async () => {
        // Hold every provider call open until all requests have passed the budget gate.
        let open;
        const gate = new Promise(resolve => { open = resolve; });
        const fetchMock = vi.fn(async () => { await gate; return geminiOk(); });
        vi.stubGlobal('fetch', fetchMock);

        const app = makeApp(pool);
        // .then() dispatches now — a supertest request is lazy until it is awaited.
        const pending = Array.from({ length: 6 }, (_, i) => render(app, i).then(r => r));
        // Every request has been through the budget gate; draining the microtask queue then lets
        // the ones that passed reach the (held) provider call.
        await vi.waitFor(() => expect(pool.stats.gateEvents).toBe(6), { timeout: 30_000 });
        await new Promise(resolve => setImmediate(resolve));
        open();
        const results = await Promise.all(pending);

        const ok = results.filter(r => r.status === 200);
        const refused = results.filter(r => r.status === 402);
        // est $0.039 per render, budget $0.10 → exactly two fit.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(ok).toHaveLength(2);
        expect(refused).toHaveLength(4);
        const spent = pool.rows.reduce((s, r) => s + r.cost_usd, 0);
        expect(spent).toBeLessThanOrEqual(0.1);
    });

    it('settles the reservation to the real cost, one ledger row per call', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => geminiOk()));
        const res = await render(makeApp(pool), 0);
        expect(res.status).toBe(200);
        expect(pool.rows).toHaveLength(1);
        expect(pool.rows[0].cost_usd).toBeCloseTo(res.body.cost_usd, 9);
        expect(pool.rows[0].cost_usd).not.toBe(0.039);
    });

    it('releases the reservation when the provider refuses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false, status: 500, json: async () => ({ error: { message: 'internal' } })
        })));
        const res = await render(makeApp(pool), 0);
        expect(res.status).toBe(502);
        expect(pool.rows).toHaveLength(0);
    });

    it('does not reserve for a request that fails validation', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => geminiOk()));
        const res = await request(makeApp(pool)).post('/ai-scene/render')
            .set('X-Forwarded-For', '198.51.100.1')
            .send({ image: PNG, prompt: 'x', heightMap: 'data:image/png;base64,bm90IGFuIGltYWdlIGF0IGFsbA==' });
        expect(res.status).toBe(400);
        expect(pool.rows).toHaveLength(0);
    });
});
