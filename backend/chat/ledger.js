// Reserve spend under a database lock; retain uncertain charges so retries cannot evade the cap.
export const CHAT_LOCK_KEY = 0x43484154;
const fail = code => Object.assign(new Error(code), { code });
// The per-IP quota counts every turn that kept a charge (aborted, refused and failed ones too: they
// still charge the daily cap) and caps the IP's own spend, so one client cannot drain the shared cap.
export async function reserveTurn(pool, { conversationId, n, turnKey, model, estUsd, clientIp, dailyCapUsd, ipDailyTurns = 100, ipDailyCapUsd = dailyCapUsd }) {
    if (![estUsd, dailyCapUsd, ipDailyCapUsd].every(value => Number.isFinite(value) && value > 0)) throw fail('budget_check_failed');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [CHAT_LOCK_KEY]);
        const quota = await client.query(`SELECT count(*)::int AS count, COALESCE(SUM(COALESCE(cost_usd,est_usd)),0)::float8 AS spent
            FROM consensus.chat_turn WHERE client_ip=$1
            AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [clientIp]);
        if (quota.rows[0]?.count >= ipDailyTurns) throw fail('rate_limited_quota');
        if (Number(quota.rows[0]?.spent || 0) + estUsd > ipDailyCapUsd) throw fail('rate_limited_quota');
        const locked = await client.query(`UPDATE consensus.chat_conversation SET turn_in_progress_since=now(), updated_at=now()
            WHERE id=$1 AND turn_in_progress_since IS NULL RETURNING id`, [conversationId]);
        if (!locked.rows.length) throw fail('turn_in_progress');
        const result = await client.query(`INSERT INTO consensus.chat_turn (conversation_id,n,turn_key,client_ip,model,est_usd)
            SELECT $1,$2,$3,$4,$5,$6 WHERE (SELECT COALESCE(SUM(COALESCE(cost_usd,est_usd)),0)
            FROM consensus.chat_turn WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + $6 <= $7 RETURNING id`,
        [conversationId, n, turnKey, clientIp, model, estUsd, dailyCapUsd]);
        if (!result.rows.length) { await client.query('ROLLBACK'); return null; }
        await client.query('COMMIT'); return result.rows[0];
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
}
export async function settleTurn(pool, id, { usage = {}, costUsd, status, steps = [], result }) {
    await pool.query(`UPDATE consensus.chat_turn SET input_tokens=$2, cache_read_tokens=$3, cache_write_tokens=$4,
        output_tokens=$5, cost_usd=$6, status=$7, steps=$8, result=$9, finished_at=now(), updated_at=now() WHERE id=$1`,
    [id, usage.input_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0,
        usage.output_tokens || 0, costUsd ?? null, status, JSON.stringify(steps), JSON.stringify(result)]);
}
export async function releaseTurn(pool, id) {
    await pool.query('DELETE FROM consensus.chat_turn WHERE id=$1 AND status=\'running\'', [id]);
}
export async function findTurn(pool, conversationId, turnKey) {
    const result = await pool.query('SELECT id,status,result FROM consensus.chat_turn WHERE conversation_id=$1 AND turn_key=$2', [conversationId, turnKey]);
    return result.rows[0] || null;
}
