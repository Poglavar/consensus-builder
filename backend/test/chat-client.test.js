// Pure client contract tests: storage scoping, SSE framing, and stream failures.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('../../frontend/js/chat/chat-client.js');

class MemoryStorage {
    data = new Map();
    getItem(key) { return this.data.get(key) ?? null; }
    setItem(key, value) { this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}

describe('chat client', () => {
    it('parses SSE records across chunks and emits event fields', () => {
        const events = [], parser = api.parseSse(value => events.push(value));
        parser.feed('event: step\ndata: {"n":1}\n\nevent: reply\ndata: {"text":"ok"}');
        parser.feed('\n\n'); parser.end();
        expect(events).toEqual([{ name: 'step', n: 1 }, { name: 'reply', text: 'ok' }]);
    });
    it('keeps CRLF delimiters intact when each pair is split across chunks', () => {
        const events = [], parser = api.parseSse(value => events.push(value));
        parser.feed('event: reply\r');
        parser.feed('\ndata: {"text":"ok"}\r');
        parser.feed('\n\r\n');
        parser.end();
        expect(events).toEqual([{ name: 'reply', text: 'ok' }]);
    });
    it('uses a different random bearer token per backend base and streams turn events', async () => {
        const storage = new MemoryStorage(), requests = [];
        let randomSeed = 0;
        const win = { getBackendBase: () => 'https://api.override.test/', crypto: { getRandomValues(bytes) { bytes.fill(++randomSeed); }, randomUUID: () => 'turn-uuid-1' } };
        const fetch = async (url, options) => {
            requests.push({ url, options });
            return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: reply\ndata: {"text":"done"}\n\nevent: done\ndata: {}\n\n')); controller.close(); } }), { status: 200 });
        };
        const first = api.create({ window: win, storage, fetch });
        const second = api.create({ window: win, base: 'https://two.test', storage, fetch });
        expect(first.token()).toMatch(/^[0-9a-f]{64}$/);
        expect(second.token()).not.toBe(first.token());
        const events = [];
        await first.turn('conv', { text: 'hi', language: 'en', context: {} }, { onEvent: event => events.push(event) });
        expect(events.map(event => event.name)).toEqual(['reply', 'done']);
        expect(requests[0].options.headers.Authorization).toBe(`Bearer ${first.token()}`);
        expect(requests[0].options.headers.Accept).toBe('text/event-stream');
        expect(requests[0].options.cache).toBe('no-store');
        expect(requests[0].url).toBe('https://api.override.test/chat/conversations/conv/turns');
        expect(JSON.parse(requests[0].options.body).turnKey).toBe('turn-uuid-1');
    });
    it('reads ISO or numeric expiry and rejects an ended stream without done/error', async () => {
        const storage = new MemoryStorage();
        storage.setItem('chat-conversation-v1:https://one.test', JSON.stringify({ id: 'iso', expiresAt: '2030-01-01T00:00:00.000Z' }));
        const client = api.create({ window: { crypto: { getRandomValues: bytes => bytes.fill(2), randomUUID: () => 'turn-uuid' } }, base: 'https://one.test', storage,
            now: () => Date.parse('2029-01-01T00:00:00Z'), fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: reply\ndata: {"text":"partial"}\n\n')); controller.close(); } }), { status: 200 }) });
        expect(client.conversation()).toMatchObject({ id: 'iso' });
        await expect(client.turn('conv', { text: 'hi' })).rejects.toMatchObject({ code: 'stream_truncated' });
        storage.setItem('chat-conversation-v1:https://one.test', JSON.stringify({ id: 'expired', expiresAt: Date.parse('2028-01-01T00:00:00Z') }));
        expect(client.conversation()).toBeNull();
    });
    it('gets and synchronizes the server conversation state and stored expiry', async () => {
        const storage = new MemoryStorage(), requests = [];
        const expiresAt = Date.now() + 60_000;
        const client = api.create({ window: { getBackendBase: () => 'https://api.test', crypto: { getRandomValues: bytes => bytes.fill(3) } }, storage,
            fetch: async (url, options) => { requests.push([url, options]); return Response.json({ id: 'conv-1', expiresAt, turns: 3, spentUsd: 0.04, plan: { cid: 'p1' } }); } });
        expect(await client.get('conv-1')).toMatchObject({ turns: 3 });
        expect(await client.sync('conv-1')).toMatchObject({ spentUsd: 0.04 });
        expect(client.conversation()).toMatchObject({ id: 'conv-1', turns: 3, plan: { cid: 'p1' } });
        expect(requests.map(([url]) => url)).toEqual(['https://api.test/chat/conversations/conv-1', 'https://api.test/chat/conversations/conv-1']);
    });
    it('throws the server error code and status for non-ok responses', async () => {
        const client = api.create({ window: { crypto: { getRandomValues: bytes => bytes.fill(1) } }, base: 'https://one.test', storage: new MemoryStorage(), fetch: async () => new Response(JSON.stringify({ code: 'budget_exhausted' }), { status: 402 }) });
        await expect(client.turn('conv', { text: 'hi' })).rejects.toMatchObject({ code: 'budget_exhausted', status: 402 });
    });
    it('does not issue a fetch when the supplied signal is already aborted', async () => {
        const fetch = vi.fn();
        const client = api.create({ window: { crypto: { getRandomValues: bytes => bytes.fill(4) } }, base: 'https://one.test', storage: new MemoryStorage(), fetch });
        const controller = new AbortController(); controller.abort();
        await expect(client.turn('conv', { text: 'hi' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'stream_aborted', status: 0 });
        expect(fetch).not.toHaveBeenCalled();
    });
});
