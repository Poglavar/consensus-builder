// Authenticated server-sent notifications. Capabilities stay in the Authorization header.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document) root.SharedPlanEvents = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    function parser(onState, sessionId) {
        let buffer = '';
        return text => {
            buffer += text;
            if (buffer.length > 65536) throw new Error('The shared-plan notification is too large.');
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
                const lines = block.split(/\r?\n/);
                if (!lines.some(line => line === 'event: state')) continue;
                const json = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
                const state = JSON.parse(json);
                if (state.id !== sessionId || !Number.isSafeInteger(state.version) || state.version < 0
                    || typeof state.cid !== 'string' || !state.cid || !['owner', 'agent'].includes(state.controller)
                    || typeof state.activity?.agentEditing !== 'boolean') throw new Error('The shared-plan notification is invalid.');
                onState(state);
            }
        };
    }
    function connect({ base, sessionId, token, onState, onStatus = () => {}, fetch: fetchImpl = globalThis.fetch,
        setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout,
        retryMs = 1000, idleMs = 45000 }) {
        let stopped = false, controller, timer, wake, retryTimer;
        const status = (value, error) => { if (!stopped) onStatus(value, error); };
        const delay = ms => new Promise(resolve => { wake = resolve; retryTimer = later(resolve, ms); });
        const done = (async () => {
            let failures = 0;
            while (!stopped) {
                let reader, retryAfter = 0;
                controller = new AbortController();
                try {
                    status(failures ? 'reconnecting' : 'connecting');
                    timer = later(() => controller.abort(), idleMs);
                    const response = await fetchImpl(`${base}/${encodeURIComponent(sessionId)}/events`, {
                        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal
                    });
                    if (!response.ok) {
                        const error = Object.assign(new Error(`Shared-plan connection failed (${response.status}).`), { status: response.status });
                        if ([401, 403, 404].includes(response.status)) { status('unavailable', error); return; }
                        const seconds = response.headers?.get?.('retry-after');
                        if (seconds && /^\d+$/.test(seconds)) retryAfter = Math.min(60000, Number(seconds) * 1000);
                        throw error;
                    }
                    if (!response.body?.getReader || !response.headers?.get?.('content-type')?.includes('text/event-stream')) throw new Error('Shared-plan events are unavailable.');
                    reader = response.body.getReader();
                    const decode = new TextDecoder();
                    const feed = parser(state => { failures = 0; status('connected'); onState(state); }, sessionId);
                    while (!stopped) {
                        clear(timer); timer = later(() => controller.abort(), idleMs);
                        const { done, value } = await reader.read();
                        if (done) break;
                        feed(decode.decode(value, { stream: true }));
                    }
                    if (!stopped) throw new Error('The shared-plan connection ended.');
                } catch (error) {
                    if (!stopped) status('reconnecting', error);
                } finally {
                    clear(timer); timer = null;
                    try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch (_) { /* the connection already ended */ }
                }
                if (!stopped) {
                    const ms = Math.max(retryAfter, Math.min(15000, retryMs * 2 ** Math.min(failures++, 4)));
                    await delay(ms); clear(retryTimer); retryTimer = null; wake = null;
                }
            }
        })();
        return { done, close() { stopped = true; controller?.abort(); clear(timer); clear(retryTimer); wake?.(); } };
    }
    return { parser, connect };
});
