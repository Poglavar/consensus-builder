// The inbox row is the durable delivery queue. The API owns this worker; no cron or extra bot.
import { sendTelegram } from '../agents/telegram.js';

const clip = (text, limit) => text.length <= limit ? text : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
export function feedbackMessage(report) {
    const lines = [`Urban Game Theory · ${report.kind === 'bug' ? 'Bug report' : 'Feedback'}`,
        `Receipt: ${report.id}`, `From: ${report.source}`, '', clip(report.message, 2800)];
    if (report.message.length > 2800) lines.push('', 'Full text is in the private inbox under this receipt.');
    if (report.page_url) lines.push('', report.page_url.length <= 800 ? `Page: ${report.page_url}` : 'Page link is in the private inbox.');
    return lines.join('\n');
}

export function createFeedbackNotifications({ pool, env = process.env, fetchImpl,
    send = text => sendTelegram(text, { env, fetchImpl, disablePreview: true }),
    intervalMs = 60_000, batchSize = 5, log = message => console.error(`[feedback-notifications] ${message}`) } = {}) {
    const enabled = env.NODE_ENV !== 'test' && Boolean(env.TELEGRAM_ACTIVITY_BOT_TOKEN && env.TELEGRAM_ACTIVITY_CHAT_ID && env.TELEGRAM_ACTIVITY_THREAD_ID);
    let active = null, timer = null, stopped = false;
    async function drain() {
        const client = await pool.connect();
        try {
            for (let n = 0; n < batchSize && !stopped; n++) {
                await client.query('BEGIN');
                try {
                    // Row locks coordinate multiple API workers. Submission retries cannot send
                    // another message once the successful delivery timestamp is committed.
                    const { rows } = await client.query(`SELECT id, kind, message, page_url, source FROM consensus.feedback
                        WHERE telegram_notified_at IS NULL
                          AND (telegram_attempted_at IS NULL OR telegram_attempted_at <= now() - interval '5 minutes')
                        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
                    if (!rows.length) { await client.query('COMMIT'); break; }
                    const report = rows[0];
                    await client.query(`UPDATE consensus.feedback SET telegram_attempted_at = now(),
                        telegram_attempts = telegram_attempts + 1, updated_at = now() WHERE id = $1`, [report.id]);
                    let delivered = false;
                    try { delivered = await send(feedbackMessage(report)) === true; }
                    catch { /* Keep the report pending; no report text or credentials in logs. */ }
                    if (delivered) await client.query('UPDATE consensus.feedback SET telegram_notified_at = now(), updated_at = now() WHERE id = $1', [report.id]);
                    else log('Telegram delivery not confirmed; report remains pending for retry.');
                    await client.query('COMMIT');
                } catch (error) { await client.query('ROLLBACK'); throw error; }
            }
        } finally { client.release(); }
    }
    function wake() {
        if (!enabled || stopped) return Promise.resolve();
        if (!active) active = drain().catch(() => log('Inbox delivery check failed; pending reports will retry.')).finally(() => { active = null; });
        return active;
    }
    return {
        enabled, wake,
        start() {
            if (!enabled) { if (env.NODE_ENV !== 'test') log('Telegram activity configuration is missing; reports remain pending.'); return; }
            if (timer || stopped) return;
            timer = setInterval(wake, intervalMs); timer.unref();
            void wake();
        },
        async close() { stopped = true; clearInterval(timer); timer = null; await active; }
    };
}
