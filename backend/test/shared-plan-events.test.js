import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const events = require('../../frontend/js/shared-plan-events.js');

const state = (overrides = {}) => ({ id: 'session-1', version: 2, cid: 'plan-cid', controller: 'agent', activity: { agentEditing: true }, ...overrides });
const wire = value => `event: state\ndata: ${JSON.stringify(value)}\n\n`;
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function clock() {
    let next = 0;
    const timers = new Map();
    return {
        later(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
        clear(id) { timers.delete(id); },
        fire(ms) { const entry = [...timers].find(([, timer]) => timer.ms === ms); expect(entry, `timer ${ms}`).toBeTruthy(); timers.delete(entry[0]); entry[1].fn(); },
        pending() { return [...timers.values()].map(timer => timer.ms); }
    };
}
function response(status, headers = {}, reader = null) {
    return { ok: status >= 200 && status < 300, status,
        headers: { get: name => headers[name.toLowerCase()] || null },
        body: reader ? { getReader: () => reader } : null };
}

describe('shared plan event parser', () => {
    it('parses split CRLF frames and multiline data, ignoring heartbeats and other event types', () => {
        const received = [], parse = events.parser(value => received.push(value), 'session-1');
        const payload = ': heartbeat\r\n\r\nevent: ignored\r\ndata: {}\r\n\r\nevent: state\r\ndata: {"id":"session-1",\r\ndata: "version":2,"cid":"plan-cid","controller":"agent","activity":{"agentEditing":true}}\r\n\r\n';
        for (let offset = 0; offset < payload.length; offset += 7) parse(payload.slice(offset, offset + 7));
        expect(received).toEqual([state()]);
    });
    it('rejects malformed JSON, wrong sessions, invalid state fields and oversized frames', () => {
        expect(() => events.parser(() => {}, 'session-1')('event: state\ndata: {\n\n')).toThrow();
        for (const invalid of [state({ id: 'other' }), state({ version: -1 }), state({ version: 1.2 }), state({ cid: '' }), state({ controller: 'guest' }), state({ activity: {} })]) {
            expect(() => events.parser(() => {}, 'session-1')(wire(invalid))).toThrow('invalid');
        }
        expect(() => events.parser(() => {}, 'session-1')('x'.repeat(65537))).toThrow('too large');
    });
});

describe('shared plan event transport', () => {
    it.each([403, 410])('sends the capability only in the Authorization header and stops on terminal status %s', async status => {
        const fetch = vi.fn(async () => response(status));
        const statuses = [], timer = clock();
        const connection = events.connect({ base: '/sharing/sessions', sessionId: 'id/one', token: 'example-capability', onState: vi.fn(),
            onStatus: (value, error) => statuses.push([value, error?.status]), fetch, setTimeout: timer.later, clearTimeout: timer.clear });
        await connection.done;
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, options] = fetch.mock.calls[0];
        expect(url).toBe('/sharing/sessions/id%2Fone/events');
        expect(url).not.toContain('example-capability');
        expect(options.headers).toEqual({ Accept: 'text/event-stream', Authorization: 'Bearer example-capability' });
        expect(options.cache).toBe('no-store');
        expect(options.redirect).toBe('error');
        expect(statuses).toEqual([['connecting', undefined], ['unavailable', status]]);
        expect(timer.pending()).toEqual([]);
    });
    it('retries transient failures with Retry-After then stops for a missing session', async () => {
        const timer = clock(), statuses = [];
        const fetch = vi.fn().mockResolvedValueOnce(response(503, { 'retry-after': '3' })).mockResolvedValueOnce(response(404));
        const connection = events.connect({ base: '/sessions', sessionId: 'session-1', token: 'example', onState: vi.fn(),
            onStatus: value => statuses.push(value), fetch, setTimeout: timer.later, clearTimeout: timer.clear, retryMs: 100 });
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(timer.pending()).toEqual([3000]);
        timer.fire(3000); await connection.done;
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(statuses).toEqual(['connecting', 'reconnecting', 'reconnecting', 'unavailable']);
        expect(timer.pending()).toEqual([]);
    });
    it('closes an active read without waiting for a stuck reader cancellation', async () => {
        const timer = clock(), received = [], statuses = [];
        let signal, reads = 0, rejectRead;
        const reader = { read: vi.fn(() => {
            if (!reads++) return Promise.resolve({ done: false, value: new TextEncoder().encode(wire(state())) });
            return new Promise((resolve, reject) => { rejectRead = reject; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
        }), cancel: vi.fn(() => new Promise(() => {})) };
        const fetch = vi.fn(async (url, options) => { signal = options.signal; return response(200, { 'content-type': 'text/event-stream; charset=utf-8' }, reader); });
        const connection = events.connect({ base: '/sessions', sessionId: 'session-1', token: 'example', onState: value => received.push(value),
            onStatus: value => statuses.push(value), fetch, setTimeout: timer.later, clearTimeout: timer.clear });
        await flush();
        expect(received).toEqual([state()]);
        expect(statuses).toEqual(['connecting', 'connected']);
        expect(rejectRead).toBeTypeOf('function');
        connection.close(); await connection.done;
        expect(signal.aborted).toBe(true);
        expect(reader.cancel).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(timer.pending()).toEqual([]);
    });
    it('cancels a scheduled retry without another request', async () => {
        const timer = clock(), fetch = vi.fn(async () => response(500));
        const connection = events.connect({ base: '/sessions', sessionId: 'session-1', token: 'example', onState: vi.fn(), fetch,
            setTimeout: timer.later, clearTimeout: timer.clear, retryMs: 100 });
        await flush();
        expect(timer.pending()).toEqual([100]);
        connection.close(); await connection.done;
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(timer.pending()).toEqual([]);
    });
});
