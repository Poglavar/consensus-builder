import { describe, expect, it, vi } from 'vitest';
import { runCliStage } from '../floor-plans/cli-worker.js';

const makeTask = (overrides = {}) => ({
    id: 'task-1', processor: 'reader-v1', status: 'queued', source_sha256: 'a'.repeat(64),
    result: {}, ...overrides,
});

function fakeDb(tasks = [], shared = null) {
    const session = Symbol('connection');
    const locks = shared || { tasks: structuredClone(tasks), readers: new Set(), tasksHeld: new Map(), exclusive: false };
    const state = { tasks: locks.tasks, lock: false, calls: [], locks };
    const db = { state, async query(sql, params = []) {
        state.calls.push([sql, params]);
        if (sql.includes('pg_try_advisory_lock_shared')) {
            if (locks.exclusive) return { rows: [{ locked: false }] };
            locks.readers.add(session); state.lock = true;
            return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock_shared')) {
            locks.readers.delete(session); state.lock = false; return { rows: [] };
        }
        if (sql.includes("hashtext('floor-plan-cli-task')")) {
            if (sql.includes('pg_try_advisory_lock')) {
                const owner = locks.tasksHeld.get(params[0]);
                if (owner && owner !== session) return { rows: [{ locked: false }] };
                locks.tasksHeld.set(params[0], session); return { rows: [{ locked: true }] };
            }
            if (locks.tasksHeld.get(params[0]) === session) locks.tasksHeld.delete(params[0]);
            return { rows: [] };
        }
        if (sql.includes('pg_try_advisory_lock')) {
            if (locks.exclusive || locks.readers.size) return { rows: [{ locked: false }] };
            locks.exclusive = true; return { rows: [{ locked: true }] };
        }
        if (sql.startsWith('WITH pending_cli_tasks AS MATERIALIZED')) return { rows: state.tasks.filter(task => task.status === 'queued'
            && (!params[2] || params[2].includes(task.id))).slice(0, params[1]).map(task => structuredClone(task)) };
        const match = sql.match(/UPDATE floor_plan\.(building_task|image_task|plan_task)/);
        if (match) {
            const task = state.tasks.find(item => item.id === params[0]);
            if (!task) return { rows: [], rowCount: 0 };
            if (sql.includes("SET status='error'")) { task.status = 'error'; task.error = params[1]; }
            else if (sql.includes('result=result||$2::jsonb')) Object.assign(task.result, JSON.parse(params[1]));
            if (sql.includes('usage=$3')) { task.usage = JSON.parse(params[2]); task.cost_usd = 0; }
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
    return db;
}

const adapter = (overrides = {}) => ({
    stage: 'plans', processor: 'reader-v1',
    prepare: vi.fn(async (_db, task, llm) => ({ request: llm.batchRequest(task.id, { prompt: task.id }), evidence: { prepared: true } })),
    apply: vi.fn(async () => ({ read: 1 })),
    ...overrides,
});

const run = (db, stage, llm, options = {}) => runCliStage(db, stage, { llm, log: () => {}, ...options });

describe('subscription CLI floor-plan worker', () => {
    it('saves the response checkpoint before applying the domain result', async () => {
        const db = fakeDb([makeTask()]);
        const reader = { complete: vi.fn(async () => ({ data: { ok: true }, model: 'local-model', usage: { input_tokens: 3 }, costUsd: 0 })) };
        const stage = adapter({ apply: vi.fn(async (_db, task) => {
            expect(task.result.cliResponse).toMatchObject({ data: { ok: true }, costUsd: 0 });
            expect(task.result.cliAttempt).toBeDefined();
            return { read: 1 };
        }) });

        await expect(run(db, stage, reader)).resolves.toMatchObject({ completed: 1, costUsd: 0 });
        const selection = db.state.calls.find(([sql]) => sql.startsWith('WITH pending_cli_tasks AS MATERIALIZED'));
        expect(selection[0]).toContain("processor=$1 AND status='queued'");
        expect(selection[0]).toContain('LIMIT $2');
        expect(selection[1]).toEqual(['reader-v1', 1]);
        const responseSave = db.state.calls.findIndex(([sql, params]) => sql.includes('usage=$3')
            && JSON.parse(params[1]).cliResponse);
        expect(responseSave).toBeGreaterThan(-1);
        expect(stage.apply).toHaveBeenCalledTimes(1);
        expect(db.state.tasks[0].result.cliResponse).toMatchObject({ data: { ok: true }, costUsd: 0 });
        expect(db.state.calls[responseSave][1][0]).toBe('task-1');
    });

    it('replays a saved CLI response after restart without another model call', async () => {
        const saved = { data: { ok: true }, text: null, model: 'local-model', usage: {}, equivalentUsd: 0.2, costUsd: 0 };
        const db = fakeDb([makeTask({ result: { cliResponse: saved } })]);
        const reader = { complete: vi.fn() };
        const stage = adapter();

        await expect(run(db, stage, reader)).resolves.toMatchObject({ replayed: 1, completed: 1 });
        expect(reader.complete).not.toHaveBeenCalled();
        expect(stage.prepare).not.toHaveBeenCalled();
        expect(stage.apply).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'task-1' }), saved, expect.any(Object));
    });

    it('defers an unfinished CLI attempt instead of repeating a possibly consumed call', async () => {
        const db = fakeDb([makeTask({ result: { cliAttempt: { startedAt: 'earlier' } } })]);
        const reader = { complete: vi.fn() };
        const stage = adapter();

        await expect(run(db, stage, reader)).resolves.toMatchObject({ deferred: 1, completed: 0, status: 'needs-attention' });
        expect(reader.complete).not.toHaveBeenCalled();
        expect(stage.prepare).not.toHaveBeenCalled();
        expect(db.state.tasks[0].status).toBe('error');
        await expect(run(db, stage, reader)).resolves.toMatchObject({ selected: 0 });
    });

    it('skips a task held by another reader, and releases locks after failure', async () => {
        const db = fakeDb([makeTask()]);
        const otherDb = fakeDb([], db.state.locks);
        let finish, started;
        const ready = new Promise(resolve => { started = resolve; });
        const blocked = new Promise(resolve => { finish = resolve; });
        const reader = { complete: vi.fn(async () => { started(); await blocked; return { data: {}, usage: {}, costUsd: 0 }; }) };
        const stage = adapter();
        const first = run(db, stage, reader);
        await ready;
        const otherReader = { complete: vi.fn() };
        await expect(run(otherDb, adapter(), otherReader)).resolves.toMatchObject({ selected: 0, busy: 1 });
        expect(otherReader.complete).not.toHaveBeenCalled();
        finish();
        await first;
        expect(db.state.lock).toBe(false);

        const failingDb = fakeDb([makeTask()]);
        const broken = adapter({ apply: vi.fn(async () => { throw new Error('apply failed'); }) });
        await expect(run(failingDb, broken, { complete: vi.fn(async () => ({ data: {}, costUsd: 0 })) }))
            .resolves.toMatchObject({ failed: 1, status: 'needs-attention' });
        expect(failingDb.state.lock).toBe(false);
        expect(failingDb.state.locks.tasksHeld.size).toBe(0);
        expect(failingDb.state.tasks[0].status).toBe('error');
    });

    it('runs four distinct tasks concurrently and excludes the API batch writer', async () => {
        const ids = ['a', 'b', 'c', 'd'].map(c => c.repeat(64));
        const db = fakeDb(ids.map(id => makeTask({ id })));
        const clients = [db, ...ids.slice(1).map(() => fakeDb([], db.state.locks))];
        let finish, allStarted, active = 0, peak = 0;
        const ready = new Promise(resolve => { allStarted = resolve; });
        const blocked = new Promise(resolve => { finish = resolve; });
        const reader = { complete: vi.fn(async () => {
            active++; peak = Math.max(peak, active); if (active === 4) allStarted();
            await blocked; active--; return { data: {}, usage: {}, costUsd: 0 };
        }) };
        const runs = clients.map((client, i) => run(client, adapter(), reader, { taskIds: [ids[i]] }));
        await ready;
        expect(peak).toBe(4);
        expect(db.state.locks.tasksHeld.size).toBe(4);
        const api = fakeDb([], db.state.locks);
        const sql = "SELECT pg_try_advisory_lock(hashtext('floor-plan-ai')) AS locked";
        expect((await api.query(sql)).rows[0].locked).toBe(false);
        finish();
        expect((await Promise.all(runs)).every(r => r.completed === 1)).toBe(true);
        expect(reader.complete).toHaveBeenCalledTimes(4);
        expect(db.state.locks.tasksHeld.size).toBe(0);
        expect(db.state.locks.readers.size).toBe(0);
        expect((await api.query(sql)).rows[0].locked).toBe(true);
    });

    it('rejects CLI work while an exclusive batch owns the pipeline', async () => {
        const db = fakeDb([makeTask()]); db.state.locks.exclusive = true;
        await expect(run(db, adapter(), { complete: vi.fn() })).rejects.toThrow(/Another floor-plan recognition worker/);
    });

    it('rechecks status after claiming so a finished task is not processed again', async () => {
        const db = fakeDb([makeTask()]); const query = db.query.bind(db);
        db.query = async (sql, params) => {
            const result = await query(sql, params);
            if (sql.includes("pg_try_advisory_lock(hashtext('floor-plan-cli-task')")) db.state.tasks[0].status = 'complete';
            return result;
        };
        const reader = { complete: vi.fn() };
        await expect(run(db, adapter(), reader)).resolves.toMatchObject({ selected: 0, completed: 0 });
        expect(reader.complete).not.toHaveBeenCalled();
        expect(db.state.locks.tasksHeld.size).toBe(0);
    });

    it('validates limits before database access and rejects a metered response', async () => {
        const db = fakeDb([makeTask()]);
        await expect(run(db, adapter(), { complete: vi.fn() }, { limit: 0 })).rejects.toThrow(/CLI limit/);
        expect(db.state.calls).toHaveLength(0);

        const reader = { complete: vi.fn(async () => ({ data: {}, costUsd: 0.01 })) };
        await expect(run(db, adapter(), reader)).resolves.toMatchObject({ failed: 1, status: 'needs-attention' });
        expect(db.state.tasks[0].status).toBe('error');
        expect(db.state.tasks[0].error).toMatch(/metered spend/);
        expect(db.state.tasks[0].result.cliResponse).toBeUndefined();
    });

    it('stops the chunk when a weekly subscription limit is reported', async () => {
        const db = fakeDb([makeTask(), makeTask({ id: 'task-2' })]);
        const reader = { complete: vi.fn(async () => { throw new Error("You've hit your weekly limit"); }) };
        await expect(run(db, adapter(), reader, { limit: 2 })).resolves.toMatchObject({ failed: 1, status: 'needs-attention' });
        expect(reader.complete).toHaveBeenCalledTimes(1);
        expect(db.state.tasks[1].status).toBe('queued');
        expect(db.state.lock).toBe(false);
    });

    it('pins the requested model and effort over a stage cheap tier and restricts retries to named tasks', async () => {
        const id = 'a'.repeat(64), other = 'b'.repeat(64);
        const db = fakeDb([makeTask({ id: other }), makeTask({ id })]);
        const stage = adapter({ prepare: vi.fn(async (_db, task, llm) => ({
            request: llm.batchRequest(task.id, { content: ['Read this drawing'], tier: 'cheap' }), evidence: {},
        })) });
        const reader = { complete: vi.fn(async () => ({ data: {}, usage: {}, costUsd: 0 })) };
        await expect(run(db, stage, reader, { limit: 2, model: 'gpt-6.1-sol', effort: 'high', taskIds: [id] }))
            .resolves.toMatchObject({ selected: 1, completed: 1, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
        expect(reader.complete).toHaveBeenCalledWith(expect.objectContaining({ tier: 'cheap', model: 'gpt-6.1-sol', effort: 'high' }));
        expect(db.state.tasks[1].result.cliAttempt).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
        expect(db.state.tasks[0].result.cliAttempt).toBeUndefined();
    });
});
