// Unit tests for agents/telegram.js — the one summary line a run is allowed to send. fetch and env
// are both injected, so nothing here reaches Telegram. What matters is that it never throws (a
// messaging failure must not fail a run), that it no-ops loudly when unconfigured, and that a long
// summary is split instead of being rejected by the API.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendTelegram } from '../agents/telegram.js';

const ENV = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '-100123' };

let warn;
let error;

beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
});

function okFetch(calls) {
    return async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
}

describe('sendTelegram', () => {
    it('posts the message to the configured chat', async () => {
        const calls = [];
        expect(await sendTelegram('Agents 2026-09-17: 3 posted', { fetchImpl: okFetch(calls), env: ENV })).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.telegram.org/botbot-token/sendMessage');
        expect(calls[0].body).toEqual({ chat_id: '-100123', text: 'Agents 2026-09-17: 3 posted' });
    });

    it('no-ops with a warning when the bot is not configured', async () => {
        const calls = [];
        expect(await sendTelegram('anything', { fetchImpl: okFetch(calls), env: {} })).toBe(false);
        expect(await sendTelegram('anything', { fetchImpl: okFetch(calls), env: { TELEGRAM_BOT_TOKEN: 'x' } })).toBe(false);
        expect(calls).toHaveLength(0);
        expect(warn).toHaveBeenCalled();
    });

    it('splits a long summary into 4000-char messages that reassemble exactly', async () => {
        const calls = [];
        const long = 'x'.repeat(9001);
        expect(await sendTelegram(long, { fetchImpl: okFetch(calls), env: ENV })).toBe(true);
        expect(calls).toHaveLength(3);
        expect(calls.every(call => call.body.text.length <= 4000)).toBe(true);
        expect(calls.map(call => call.body.text).join('')).toBe(long);
    });

    it('reports a failure without throwing when Telegram refuses', async () => {
        const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'Too Many Requests' });
        expect(await sendTelegram('hi', { fetchImpl, env: ENV })).toBe(false);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('429'));
    });

    it('survives a fetch that throws', async () => {
        const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND api.telegram.org'); };
        expect(await sendTelegram('hi', { fetchImpl, env: ENV })).toBe(false);
        expect(error).toHaveBeenCalled();
    });

    it('skips an empty message', async () => {
        const calls = [];
        expect(await sendTelegram('   ', { fetchImpl: okFetch(calls), env: ENV })).toBe(false);
        expect(calls).toHaveLength(0);
    });
});
