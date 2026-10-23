import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeedbackNotifications, feedbackMessage } from '../feedback/notifications.js';
const env = { TELEGRAM_ACTIVITY_BOT_TOKEN: 'test-token', TELEGRAM_ACTIVITY_CHAT_ID: 'test-chat', TELEGRAM_ACTIVITY_THREAD_ID: '42' };
const report = () => ({ id: '7489c4d1-0804-4f51-b34d-114907452e72', kind: 'bug', message: 'The road comparison is disabled.', page_url: 'https://urbangametheory.xyz/agreements/example', source: 'mcp', attempted: false, delivered: false, attempts: 0 });
function poolFor(row) {
    const query = vi.fn(async (sql) => {
        if (sql.startsWith('SELECT')) return { rows: !row.delivered && !row.attempted ? [row] : [] };
        if (sql.includes('telegram_attempts =')) { row.attempted = true; row.attempts++; }
        if (sql.includes('SET telegram_notified_at')) row.delivered = true;
        return { rows: [] };
    });
    return { connect: vi.fn(async () => ({ query, release: vi.fn() })), query };
}
const workers = [];
afterEach(async () => { for (const worker of workers.splice(0)) await worker.close(); });
function worker(options) { const value = createFeedbackNotifications({ env, log: vi.fn(), ...options }); workers.push(value); return value; }

describe('feedback Telegram delivery', () => {
    it('sends one plain-text excerpt with its receipt and keeps a long report within one Telegram message', () => {
        const value = feedbackMessage({ ...report(), message: '<b>untrusted</b> ' + '🌆'.repeat(4000), page_url: 'https://example.test/' + 'x'.repeat(2000) });
        expect(value).toContain('<b>untrusted</b>');
        expect(value).toContain(report().id); expect(value.length).toBeLessThanOrEqual(4000);
        expect(value).toContain('Full text is in the private inbox'); expect(value).toContain('Page link is in the private inbox');
    });
    it('persists success and does not notify again on a duplicate wake or after a worker restart', async () => {
        const row = report(), pool = poolFor(row), send = vi.fn(async () => true);
        const first = worker({ pool, send });
        await Promise.all([first.wake(), first.wake()]); await first.close();
        await worker({ pool, send }).wake();
        expect(send).toHaveBeenCalledTimes(1); expect(row.delivered).toBe(true); expect(row.attempts).toBe(1);
        expect(pool.query.mock.calls.some(([sql]) => sql.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
    });
    it('retains failed delivery, waits for cooldown and delivers when the source recovers', async () => {
        const row = report(), pool = poolFor(row), send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const value = worker({ pool, send });
        await value.wake(); await value.wake();
        expect(row.delivered).toBe(false); expect(send).toHaveBeenCalledTimes(1);
        row.attempted = false; // Database clock has passed the five-minute retry threshold.
        await value.wake();
        expect(row.delivered).toBe(true); expect(row.attempts).toBe(2);
    });
    it('does not consume pending reports without configuration or in a test API process', async () => {
        const pool = poolFor(report()), send = vi.fn();
        await worker({ pool, send, env: {} }).wake();
        await worker({ pool, send, env: { ...env, NODE_ENV: 'test' } }).wake();
        expect(pool.connect).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    });
    it('keeps database failures observable and retries on a later wake', async () => {
        const pool = poolFor(report()), log = vi.fn(), send = vi.fn(async () => true);
        pool.connect.mockRejectedValueOnce(new Error('database unavailable'));
        const value = worker({ pool, log, send });
        await value.wake(); expect(log).toHaveBeenCalledWith(expect.stringContaining('pending reports will retry'));
        await value.wake(); expect(send).toHaveBeenCalledTimes(1);
    });
    it('stops scheduling and drains the current delivery before shutdown', async () => {
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const row = report(), pool = poolFor(row), send = vi.fn(async () => { await pending; return true; });
        const value = worker({ pool, send, intervalMs: 10_000 }); value.start();
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        let closed = false;
        const closing = value.close().then(() => { closed = true; });
        await Promise.resolve(); expect(closed).toBe(false);
        release(); await closing; await value.wake();
        expect(row.delivered).toBe(true); expect(send).toHaveBeenCalledTimes(1);
    });
});
