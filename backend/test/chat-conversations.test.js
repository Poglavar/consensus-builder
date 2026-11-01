// Conversation-store tests cover capability-scoped expiry and crash-pruned spend retention.
import { describe, expect, it } from 'vitest';
import { createConversationStore } from '../chat/conversations.js';

function createPool(now) {
    const conversations = new Map(), turns = [];
    return { conversations, turns,
        async query(sql, values = []) {
            const text = sql.replace(/\s+/g, ' ').trim();
            if (/^UPDATE consensus\.chat_turn SET status='interrupted'/.test(text)) {
                const cutoff = now() - 30 * 60_000;
                turns.filter(turn => turn.status === 'running' && turn.created_at < cutoff).forEach(turn => {
                    turn.status = 'interrupted'; turn.finished_at = now();
                });
                return { rows: [] };
            }
            if (/^UPDATE consensus\.chat_conversation SET turn_in_progress_since=NULL/.test(text)) {
                const cutoff = now() - 30 * 60_000;
                conversations.forEach(row => { if (row.turn_in_progress_since && row.turn_in_progress_since < cutoff) row.turn_in_progress_since = null; });
                return { rows: [] };
            }
            if (text === 'SELECT id FROM consensus.chat_conversation WHERE expires_at <= $1 AND turn_in_progress_since IS NULL') {
                return { rows: [...conversations.values()].filter(row => row.expires_at <= values[0] && !row.turn_in_progress_since).map(row => ({ id: row.id })) };
            }
            if (text === 'SELECT turn_in_progress_since FROM consensus.chat_conversation WHERE id=$1 FOR UPDATE') {
                const row = conversations.get(values[0]);
                return { rows: row ? [{ turn_in_progress_since: row.turn_in_progress_since }] : [] };
            }
            if (/^UPDATE consensus\.chat_turn SET steps='\[\]',result=NULL/.test(text)) {
                turns.filter(turn => turn.conversation_id === values[0]).forEach(turn => { turn.steps = []; turn.result = null; });
                return { rows: [] };
            }
            if (text === 'DELETE FROM consensus.chat_conversation WHERE id=$1') {
                conversations.delete(values[0]);
                // Mirror the declared ON DELETE SET NULL foreign key while retaining the spend row.
                turns.filter(turn => turn.conversation_id === values[0]).forEach(turn => { turn.conversation_id = null; });
                return { rows: [] };
            }
            if (/^INSERT INTO consensus\.chat_conversation/.test(text)) {
                const [id, token_hash, client_ip, language, city, expires_at] = values;
                const old = [...conversations.values()].find(row => row.token_hash === token_hash);
                if (old) return { rows: [{ ...old }] };
                const row = { id, token_hash, client_ip, language, city, plan_ref: null, plan_cid: null, plan_history: [], messages: [], notes: [],
                    turns: 0, spent_usd: 0, turn_in_progress_since: null, created_at: new Date(now()), updated_at: new Date(now()), expires_at };
                conversations.set(id, row); return { rows: [{ ...row }] };
            }
            if (text.startsWith('SELECT * FROM consensus.chat_conversation WHERE id=$1 AND token_hash=$2 AND expires_at>$3')) {
                const row = conversations.get(values[0]);
                return { rows: row && row.token_hash === values[1] && row.expires_at > values[2] ? [{ ...row }] : [] };
            }
            throw new Error(`Unexpected fake conversation SQL: ${text}`);
        },
        async connect() { return { query: async (sql, values = []) => {
            const text = sql.trim();
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
            return this.query(sql, values);
        }, release() {} }; }
    };
}

describe('chat conversation store', () => {
    it('creates an opaque expiring conversation and loads it only with the owner token hash', async () => {
        const now = () => 1_800_000_000_000, pool = createPool(now), store = createConversationStore(pool, { now, ttlMs: 60_000 });
        try {
            const created = await store.create({ tokenHash: 'a'.repeat(64), clientIp: '198.51.100.4', language: 'en', city: 'london' });
            expect(created).toMatchObject({ city: 'london', expiresAt: now() + 60_000 });
            expect(created.id).toMatch(/^[A-Za-z0-9_-]{24}$/);
            expect(await store.load(created.id, 'a'.repeat(64))).toMatchObject({ id: created.id });
            expect(await store.load(created.id, 'b'.repeat(64))).toBeNull();
        } finally { store.dispose(); }
    });

    it('prunes an abandoned turn, clears its replay payload and keeps its estimated spend after conversation expiry', async () => {
        const now = () => 1_800_000_000_000, pool = createPool(now), store = createConversationStore(pool, { now });
        const id = 'conversation_1234567890123';
        pool.conversations.set(id, { id, token_hash: 'a'.repeat(64), client_ip: '198.51.100.4', language: 'en', city: 'london',
            plan_ref: null, plan_cid: null, plan_history: [], messages: [], notes: [], turns: 1, spent_usd: 0.02,
            turn_in_progress_since: now() - 31 * 60_000, created_at: new Date(now() - 86_500_000), updated_at: new Date(now() - 31 * 60_000), expires_at: new Date(now() - 1) });
        pool.turns.push({ id: 1, conversation_id: id, status: 'running', created_at: now() - 31 * 60_000,
            est_usd: 0.04, cost_usd: null, steps: [{ n: 1 }], result: { events: [{ name: 'reply' }] } });
        try {
            await store.prune();
            expect(pool.conversations.has(id)).toBe(false);
            expect(pool.turns).toEqual([{ id: 1, conversation_id: null, status: 'interrupted', created_at: now() - 31 * 60_000,
                est_usd: 0.04, cost_usd: null, steps: [], result: null, finished_at: now() }]);
        } finally { store.dispose(); }
    });

    it('refuses to remove a conversation with an active turn before scrubbing its content', async () => {
        const now = () => 1_800_000_000_000, pool = createPool(now), store = createConversationStore(pool, { now });
        const id = 'conversation_1234567890123';
        pool.conversations.set(id, { id, token_hash: 'a'.repeat(64), client_ip: '198.51.100.4', language: 'en', city: 'london',
            plan_ref: null, plan_cid: null, plan_history: [], messages: [{ role: 'assistant', content: 'Keep me.' }], notes: [], turns: 1, spent_usd: 0.02,
            turn_in_progress_since: new Date(now() - 1000), created_at: new Date(now() - 86_500_000), updated_at: new Date(now() - 1000), expires_at: new Date(now() + 60_000) });
        pool.turns.push({ id: 2, conversation_id: id, status: 'running', created_at: now(), est_usd: 0.04, cost_usd: null,
            steps: [{ n: 1 }], result: { events: [{ name: 'reply' }] } });
        try {
            await expect(store.remove(id)).rejects.toMatchObject({ code: 'turn_in_progress', status: 409 });
            expect(pool.conversations.get(id).messages).toEqual([{ role: 'assistant', content: 'Keep me.' }]);
            expect(pool.turns[0]).toMatchObject({ conversation_id: id, steps: [{ n: 1 }], result: { events: [{ name: 'reply' }] } });
        } finally { store.dispose(); }
    });
});
