// Store private conversation revisions; deleting content preserves the separate daily spend ledger.
import { randomBytes } from 'node:crypto';
const millis = value => value == null ? null : new Date(value).getTime();
function fromRow(row) {
    if (!row) return null;
    return { id: row.id, tokenHash: row.token_hash, clientIp: row.client_ip, language: row.language, city: row.city,
        plan: row.plan_cid ? { draftRef: row.plan_ref, cid: row.plan_cid } : null,
        planHistory: row.plan_history, messages: row.messages, notes: row.notes, turns: row.turns, spentUsd: Number(row.spent_usd),
        turnInProgressSince: millis(row.turn_in_progress_since), createdAt: millis(row.created_at), updatedAt: millis(row.updated_at), expiresAt: millis(row.expires_at) };
}
export function createConversationStore(pool, { now = Date.now, ttlMs = 86_400_000 } = {}) {
    async function remove(id) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const row = (await client.query('SELECT turn_in_progress_since FROM consensus.chat_conversation WHERE id=$1 FOR UPDATE', [id])).rows[0];
            if (row?.turn_in_progress_since) throw Object.assign(new Error('A turn is running.'), { code: 'turn_in_progress', status: 409 });
            await client.query('UPDATE consensus.chat_turn SET steps=\'[]\',result=NULL,updated_at=now() WHERE conversation_id=$1', [id]);
            await client.query('DELETE FROM consensus.chat_conversation WHERE id=$1', [id]);
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    }
    async function prune() {
        // Crash reservations stay charged, but a worker restart must not lock a conversation forever.
        await pool.query(`UPDATE consensus.chat_turn SET status='interrupted',updated_at=now(),finished_at=now()
            WHERE status='running' AND created_at < now() - interval '30 minutes'`);
        await pool.query(`UPDATE consensus.chat_conversation SET turn_in_progress_since=NULL
            WHERE turn_in_progress_since < now() - interval '30 minutes'`);
        const expired = await pool.query('SELECT id FROM consensus.chat_conversation WHERE expires_at <= $1 AND turn_in_progress_since IS NULL', [new Date(now())]);
        for (const row of expired.rows) await remove(row.id);
    }
    const timer = setInterval(() => prune().catch(error => console.error(`[${new Date().toISOString()}] [chat] prune failed (${error.code || 'storage'})`)), 60_000); timer.unref();
    return {
        async create({ tokenHash, clientIp, language = 'en', city }) {
            await prune();
            const result = await pool.query(`INSERT INTO consensus.chat_conversation (id,token_hash,client_ip,language,city,expires_at)
                VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (token_hash) DO UPDATE SET token_hash=EXCLUDED.token_hash RETURNING *`,
            [randomBytes(18).toString('base64url'), tokenHash, clientIp, language, city, new Date(now() + ttlMs)]);
            return fromRow(result.rows[0]);
        },
        async load(id, tokenHash) {
            const result = await pool.query('SELECT * FROM consensus.chat_conversation WHERE id=$1 AND token_hash=$2 AND expires_at>$3', [id, tokenHash, new Date(now())]);
            return fromRow(result.rows[0]);
        },
        async saveTurn(id, patch, executor = pool) {
            await executor.query(`UPDATE consensus.chat_conversation SET plan_ref=$2,plan_cid=$3,plan_history=$4,messages=$5,
                notes=$6,turns=$7,spent_usd=$8,turn_in_progress_since=NULL,updated_at=$9 WHERE id=$1`,
            [id, patch.plan?.draftRef || null, patch.plan?.cid || null, JSON.stringify(patch.planHistory || []),
                JSON.stringify(patch.messages || []), JSON.stringify(patch.notes || []), patch.turns, patch.spentUsd, new Date(now())]);
        },
        async undo(id) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const row = (await client.query('SELECT * FROM consensus.chat_conversation WHERE id=$1 FOR UPDATE', [id])).rows[0];
                if (!row || row.turn_in_progress_since) throw Object.assign(new Error('A turn is running.'), { code: 'turn_in_progress', status: 409 });
                const history = row.plan_history || [];
                if (!history.length) throw Object.assign(new Error('There is no earlier plan.'), { code: 'nothing_to_undo', status: 409 });
                const plan = history.pop();
                await client.query(`UPDATE consensus.chat_conversation SET plan_ref=$2,plan_cid=$3,plan_history=$4,
                    notes=notes || $5::jsonb,updated_at=$6 WHERE id=$1`, [id, plan?.draftRef || null, plan?.cid || null,
                    JSON.stringify(history), JSON.stringify(['The person undid the last plan change.']), new Date(now())]);
                await client.query('COMMIT'); return plan;
            } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
        }, remove, prune, dispose() { clearInterval(timer); }
    };
}
