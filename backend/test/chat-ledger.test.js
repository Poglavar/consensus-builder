// Ledger tests model Postgres advisory transaction locks and conversation deletion semantics.
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reserveTurn, releaseTurn, settleTurn } from '../chat/ledger.js';

function createPool() {
    const rows = [], conversations = new Map([['c1', true], ['c2', true]]);
    let nextId = 1, held = null;
    const sum = () => rows.reduce((total, row) => total + (row.costUsd ?? row.estUsd), 0);
    async function sql(text, values = []) {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (/^SELECT count\(\*\)::int AS count, COALESCE\(SUM\(COALESCE\(cost_usd,est_usd\)\),0\)::float8 AS spent FROM consensus\.chat_turn WHERE client_ip=\$1/.test(normalized)) {
            const mine = rows.filter(row => row.clientIp === values[0]);
            return { rows: [{ count: mine.length, spent: mine.reduce((total, row) => total + (row.costUsd ?? row.estUsd), 0) }] };
        }
        if (/^UPDATE consensus\.chat_conversation SET turn_in_progress_since=now\(\), updated_at=now\(\)/.test(normalized)) {
            if (!conversations.has(values[0])) return { rows: [] };
            return { rows: [{ id: values[0] }] };
        }
        if (/^INSERT INTO consensus\.chat_turn/.test(normalized)) {
            const [, , turnKey, clientIp, model, estUsd, dailyCapUsd] = values;
            if (sum() + Number(estUsd) > Number(dailyCapUsd)) return { rows: [] };
            const row = { id: nextId++, conversationId: values[0], turnKey, clientIp, model, estUsd: Number(estUsd), costUsd: null, status: 'running' };
            rows.push(row); return { rows: [{ id: row.id }] };
        }
        if (/^UPDATE consensus\.chat_turn SET input_tokens=/.test(normalized)) {
            const row = rows.find(candidate => candidate.id === values[0]);
            if (row) Object.assign(row, { inputTokens: values[1], costUsd: values[5], status: values[6], result: values[8] });
            return { rows: [] };
        }
        if (/^DELETE FROM consensus\.chat_turn/.test(normalized)) { const index = rows.findIndex(row => row.id === values[0]); if (index >= 0) rows.splice(index, 1); return { rows: [] }; }
        throw new Error(`Unexpected fake ledger SQL: ${normalized}`);
    }
    return { rows, conversations,
        async query(text, values) { return sql(text, values); },
        async connect() {
            let unlock = null;
            return { async query(text, values) {
                const trimmed = text.trim();
                if (trimmed === 'BEGIN') return { rows: [] };
                if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') { if (unlock) { const release = unlock; unlock = null; release(); } return { rows: [] }; }
                if (/pg_advisory_xact_lock/.test(trimmed)) {
                    while (held) await held;
                    held = new Promise(resolve => { unlock = () => { held = null; resolve(); }; });
                    return { rows: [{}] };
                }
                return sql(text, values);
            }, release() {} };
        }
    };
}

// The per-IP allowance is set above the shared cap here so these tests exercise the shared cap.
const reservation = (conversationId, turnKey, estUsd) => ({ conversationId, n: 1, turnKey, model: 'test', estUsd, clientIp: '198.51.100.1', dailyCapUsd: 0.10, ipDailyCapUsd: 1 });

describe('chat per-IP quota', () => {
    const turnKey = i => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
    it('counts aborted turns, which still charge the daily cap', async () => {
        const pool = createPool();
        for (let i = 0; i < 4; i++) pool.conversations.set(`a${i}`, true);
        const reserve = i => reserveTurn(pool, { ...reservation(`a${i}`, turnKey(i), 0.01), dailyCapUsd: 5, ipDailyTurns: 3 });
        for (let i = 0; i < 3; i++) {
            const row = await reserve(i);
            await settleTurn(pool, row.id, { costUsd: null, status: 'aborted' });
        }
        await expect(reserve(3)).rejects.toMatchObject({ code: 'rate_limited_quota' });
    });
    it("caps one IP's spend below the shared daily cap", async () => {
        const pool = createPool();
        const base = { ...reservation('c1', turnKey(10), 0.13), dailyCapUsd: 5, ipDailyCapUsd: 0.2 };
        expect(await reserveTurn(pool, base)).toBeTruthy();
        await expect(reserveTurn(pool, { ...base, conversationId: 'c2', turnKey: turnKey(11) }))
            .rejects.toMatchObject({ code: 'rate_limited_quota' });
        const other = await reserveTurn(pool, { ...base, conversationId: 'c2', turnKey: turnKey(12), clientIp: '203.0.113.9' });
        expect(other).toBeTruthy();
    });
});

describe('chat spend ledger', () => {
    it('serializes concurrent reservations at the daily cap', async () => {
        const pool = createPool();
        const results = await Promise.all([
            reserveTurn(pool, reservation('c1', '00000000-0000-4000-8000-000000000001', 0.06)),
            reserveTurn(pool, reservation('c2', '00000000-0000-4000-8000-000000000002', 0.06))
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(pool.rows).toHaveLength(1);
        expect(pool.rows[0].status).toBe('running');
    });
    it('settles actual cost and releases an uncalled reservation', async () => {
        const pool = createPool();
        const first = await reserveTurn(pool, reservation('c1', '00000000-0000-4000-8000-000000000003', 0.06));
        await settleTurn(pool, first.id, { usage: { input_tokens: 2 }, costUsd: 0.02, status: 'reply', result: { events: [] } });
        expect(pool.rows[0]).toMatchObject({ costUsd: 0.02, status: 'reply', inputTokens: 2 });
        const second = await reserveTurn(pool, reservation('c2', '00000000-0000-4000-8000-000000000004', 0.06));
        await releaseTurn(pool, second.id);
        expect(pool.rows).toHaveLength(1);
    });
    it('keeps spend rows independent of deleted conversation content', async () => {
        const ddl = await readFile(new URL('../db/chat-ddl.sql', import.meta.url), 'utf8');
        expect(ddl).toMatch(/conversation_id text REFERENCES consensus\.chat_conversation\(id\) ON DELETE SET NULL/);
        expect(ddl).not.toMatch(/chat_turn[\s\S]{0,100}ON DELETE CASCADE/);
        const pool = createPool();
        const row = await reserveTurn(pool, reservation('c1', '00000000-0000-4000-8000-000000000005', 0.06));
        await settleTurn(pool, row.id, { costUsd: 0.04, status: 'reply' });
        pool.conversations.delete('c1');
        expect(pool.rows).toHaveLength(1);
        expect(pool.rows.reduce((sum, turn) => sum + turn.costUsd, 0)).toBe(0.04);
    });
});
