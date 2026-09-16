// Unit tests for agents/ledger.js — the runner's checkpoint and cost tables. The pool is the shared
// mock, so what is asserted is the SQL that would reach Postgres: the right tables, the jsonb merge
// that makes a resume additive rather than destructive, UNNEST arrays that stay aligned across ten
// columns, and UTC-pinned day bounds. The cap arithmetic is pure and is tested on its edges.
import { describe, it, expect } from 'vitest';
import { createMockPool } from './helpers/mock-pool.js';
import {
    getRun, startRun, updateRun, recordCosts, dailySpendUsd, listRuns,
    assertUnderCap, dailyCapUsd
} from '../agents/ledger.js';

const RUN_ID = '2026-09-17-densifier-01';
const RUN_ROW = { run_id: RUN_ID, persona: 'densifier-01', day: '2026-09-17', mode: 'live', status: 'running', stage: 'planned', summary: {} };

function lastCall(pool) {
    const calls = pool.getCalls();
    return calls[calls.length - 1];
}

function normalize(sql) {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('getRun', () => {
    it('reads one run by id and returns null when it has not started', async () => {
        const pool = createMockPool();
        expect(await getRun(pool, RUN_ID)).toBeNull();
        const { sql, params } = lastCall(pool);
        expect(normalize(sql)).toContain('FROM consensus.agent_run WHERE run_id = $1');
        expect(params).toEqual([RUN_ID]);

        pool.setResult({ rows: [RUN_ROW], rowCount: 1 });
        expect(await getRun(pool, RUN_ID)).toEqual(RUN_ROW);
    });

    it('refuses a missing pool or run id', async () => {
        await expect(getRun(null, RUN_ID)).rejects.toThrow(/pg pool/);
        await expect(getRun(createMockPool(), '')).rejects.toThrow(/runId is required/);
    });
});

describe('startRun', () => {
    it('upserts on run_id so a rerun resumes the same row', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [RUN_ROW], rowCount: 1 });

        const row = await startRun(pool, { runId: RUN_ID, persona: 'densifier-01', day: '2026-09-17', mode: 'live' });

        expect(row).toEqual(RUN_ROW);
        const { sql, params } = lastCall(pool);
        expect(normalize(sql)).toContain('INSERT INTO consensus.agent_run');
        expect(normalize(sql)).toContain("ON CONFLICT (run_id) DO UPDATE SET status = 'running', updated_at = now()");
        expect(normalize(sql)).toContain('$3::date');
        expect(params).toEqual([RUN_ID, 'densifier-01', '2026-09-17', 'live']);
    });

    it('requires every identifying field', async () => {
        const pool = createMockPool();
        await expect(startRun(pool, { persona: 'p', day: 'd', mode: 'live' })).rejects.toThrow(/runId/);
        await expect(startRun(pool, { runId: RUN_ID, day: 'd', mode: 'live' })).rejects.toThrow(/persona/);
        await expect(startRun(pool, { runId: RUN_ID, persona: 'p', mode: 'live' })).rejects.toThrow(/day/);
        await expect(startRun(pool, { runId: RUN_ID, persona: 'p', day: 'd' })).rejects.toThrow(/mode/);
    });
});

describe('updateRun', () => {
    it('merges the summary patch with jsonb || and keeps the stage when none is given', async () => {
        const pool = createMockPool();
        const merged = { ...RUN_ROW, stage: 'chosen', summary: { candidates: [1], picks: [2] } };
        pool.setResult({ rows: [merged], rowCount: 1 });

        const row = await updateRun(pool, RUN_ID, { stage: 'chosen', status: 'running', summaryPatch: { picks: [2] } });

        expect(row).toEqual(merged);
        const { sql, params } = lastCall(pool);
        expect(normalize(sql)).toContain('UPDATE consensus.agent_run');
        expect(normalize(sql)).toContain('summary = summary || $4::jsonb');
        expect(normalize(sql)).toContain('stage = COALESCE($2, stage)');
        expect(normalize(sql)).toContain('status = COALESCE($3, status)');
        expect(params).toEqual([RUN_ID, 'chosen', 'running', JSON.stringify({ picks: [2] })]);
    });

    it('stamps finished_at only for a terminal status, and patches nothing by default', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [RUN_ROW], rowCount: 1 });
        await updateRun(pool, RUN_ID, { status: 'done' });
        const { sql, params } = lastCall(pool);
        expect(normalize(sql)).toContain("finished_at = CASE WHEN $3 IN ('done', 'failed') THEN now() ELSE finished_at END");
        expect(params).toEqual([RUN_ID, null, 'done', '{}']);
    });

    it('fails loudly when the run row does not exist', async () => {
        const pool = createMockPool();
        await expect(updateRun(pool, RUN_ID, { status: 'done' })).rejects.toThrow(/no consensus.agent_run row for/);
    });

    it('refuses a non-object summary patch', async () => {
        const pool = createMockPool();
        await expect(updateRun(pool, RUN_ID, { summaryPatch: [1, 2] })).rejects.toThrow(/plain object/);
    });
});

describe('recordCosts', () => {
    const items = [
        {
            item: '2026-09-17:densifier-01', provider: 'anthropic', model: 'claude-sonnet-4-5', batchId: 'msgbatch_1',
            usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
            usd: 0.004215
        },
        {
            item: '2026-09-17:preserver-02', provider: 'anthropic', model: 'claude-sonnet-4-5', batchId: 'msgbatch_1',
            usage: { input_tokens: 1100, output_tokens: 300 },
            usd: 0.0039
        }
    ];

    it('writes every item in one UNNEST insert with aligned arrays', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [], rowCount: 2 });

        expect(await recordCosts(pool, RUN_ID, items)).toBe(2);

        const { sql, params } = lastCall(pool);
        expect(normalize(sql)).toContain('INSERT INTO consensus.agent_cost');
        expect(normalize(sql)).toContain('FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::int[], $10::numeric[])');
        expect(params[0]).toBe(RUN_ID);
        expect(params.slice(1).every(column => Array.isArray(column) && column.length === items.length)).toBe(true);
        expect(params[1]).toEqual(['2026-09-17:densifier-01', '2026-09-17:preserver-02']);
        expect(params[2]).toEqual(['anthropic', 'anthropic']);
        expect(params[4]).toEqual(['msgbatch_1', 'msgbatch_1']);
        expect(params[5]).toEqual([1200, 1100]);
        expect(params[6]).toEqual([340, 300]);
        expect(params[7]).toEqual([800, 0]);   // cache reads, absent → 0
        expect(params[8]).toEqual([0, 0]);     // cache creation
        expect(params[9]).toEqual(['0.004215', '0.0039']); // exact strings, never a float round-trip
    });

    it('writes nothing for an empty list', async () => {
        const pool = createMockPool();
        expect(await recordCosts(pool, RUN_ID, [])).toBe(0);
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('refuses a metered call with no price or with broken usage', async () => {
        const pool = createMockPool();
        await expect(recordCosts(pool, RUN_ID, [{ item: 'a', provider: 'anthropic', model: 'm' }])).rejects.toThrow(/usd must be a finite number/);
        await expect(recordCosts(pool, RUN_ID, [{ item: 'a', provider: 'anthropic', model: 'm', usd: null }])).rejects.toThrow(/usd must be a finite number/);
        await expect(recordCosts(pool, RUN_ID, [{ item: 'a', provider: 'anthropic', model: 'm', usd: NaN }])).rejects.toThrow(/usd must be a finite number/);
        await expect(recordCosts(pool, RUN_ID, [{ item: 'a', provider: 'anthropic', model: 'm', usd: 1, usage: { input_tokens: 1.5 } }])).rejects.toThrow(/input_tokens/);
        expect(pool.getCalls()).toHaveLength(0);
    });
});

describe('dailySpendUsd', () => {
    it('sums the day in UTC and returns a number', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [{ usd: '12.345600' }], rowCount: 1 });

        expect(await dailySpendUsd(pool, '2026-09-17')).toBe(12.3456);

        const { sql, params } = lastCall(pool);
        expect(normalize(sql)).toContain('FROM consensus.agent_cost');
        expect(normalize(sql)).toContain("created_at >= (($1::date)::timestamp AT TIME ZONE 'UTC')");
        expect(normalize(sql)).toContain("created_at < ((($1::date) + 1)::timestamp AT TIME ZONE 'UTC')");
        expect(params).toEqual(['2026-09-17']);
    });

    it('is zero on an empty day and throws on a non-numeric sum', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [{ usd: null }], rowCount: 1 });
        expect(await dailySpendUsd(pool, '2026-09-17')).toBe(0);

        pool.setResult({ rows: [{ usd: 'not-a-number' }], rowCount: 1 });
        await expect(dailySpendUsd(pool, '2026-09-17')).rejects.toThrow(/non-numeric sum/);
    });
});

describe('listRuns', () => {
    it('filters by day when given one and lists everything when not', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [RUN_ROW], rowCount: 1 });
        expect(await listRuns(pool, { day: '2026-09-17' })).toEqual([RUN_ROW]);
        expect(normalize(lastCall(pool).sql)).toContain('WHERE ($1::date IS NULL OR day = $1::date) ORDER BY started_at DESC');
        expect(lastCall(pool).params).toEqual(['2026-09-17']);

        await listRuns(pool);
        expect(lastCall(pool).params).toEqual([null]);
    });
});

describe('assertUnderCap', () => {
    it('allows a run that lands exactly on the cap', () => {
        expect(assertUnderCap({ spentUsd: 999.5, estimateUsd: 0.5, capUsd: 1000 })).toBe(1000);
        expect(assertUnderCap({ spentUsd: 0, estimateUsd: 0, capUsd: 0 })).toBe(0);
    });

    it('names spend, estimate and cap when it refuses', () => {
        expect(() => assertUnderCap({ spentUsd: 999.9, estimateUsd: 0.2, capUsd: 1000 }))
            .toThrow(/spent \$999\.9000 \+ estimate \$0\.2000 = \$1000\.1000 > cap \$1000\.0000/);
    });

    it('rejects NaN and anything that is not a finite number', () => {
        expect(() => assertUnderCap({ spentUsd: NaN, estimateUsd: 1, capUsd: 1000 })).toThrow(/spentUsd must be a finite number/);
        expect(() => assertUnderCap({ spentUsd: 1, estimateUsd: Infinity, capUsd: 1000 })).toThrow(/estimateUsd must be a finite number/);
        expect(() => assertUnderCap({ spentUsd: 1, estimateUsd: 1, capUsd: null })).toThrow(/capUsd must be a finite number/);
        expect(() => assertUnderCap({ spentUsd: 1, estimateUsd: 1, capUsd: '1000' })).toThrow(/capUsd must be a finite number/);
    });
});

describe('dailyCapUsd', () => {
    it('defaults to $1000 and reads the override', () => {
        expect(dailyCapUsd({})).toBe(1000);
        expect(dailyCapUsd({ AGENT_LLM_DAILY_CAP_USD: '25.5' })).toBe(25.5);
        expect(dailyCapUsd({ AGENT_LLM_DAILY_CAP_USD: '' })).toBe(1000);
        expect(dailyCapUsd()).toBe(1000);
    });

    it('refuses a cap that is not a non-negative number', () => {
        expect(() => dailyCapUsd({ AGENT_LLM_DAILY_CAP_USD: 'lots' })).toThrow(/AGENT_LLM_DAILY_CAP_USD/);
        expect(() => dailyCapUsd({ AGENT_LLM_DAILY_CAP_USD: '-5' })).toThrow(/AGENT_LLM_DAILY_CAP_USD/);
    });
});

describe('summary serialisation', () => {
    it('stores BigInt values from chain results as strings instead of throwing', async () => {
        const pool = createMockPool();
        pool.setResults([{ rows: [{ run_id: 'r', summary: {} }], rowCount: 1 }]);
        await updateRun(pool, 'r', { stage: 'chosen', status: 'running', summaryPatch: { mints: { a: { count: 42n, lamports: 0n } } } });
        const call = pool.getCalls()[0];
        const patch = call.params.find((p) => typeof p === 'string' && p.includes('mints'));
        expect(JSON.parse(patch)).toEqual({ mints: { a: { count: '42', lamports: '0' } } });
    });
});

