// Browser client for chat conversations and their streamed turn events.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__chatClient = api;
    if (root?.fetch && root?.localStorage) root.ChatClient = api.create({ window: root });
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    function parseSse(onEvent) {
        let buffer = '', eventName = 'message', data = [];
        const dispatch = () => {
            if (data.length) { let value = data.join('\n'); try { value = JSON.parse(value); } catch (_) { /* plain SSE data */ }
                onEvent({ name: eventName, ...(value && typeof value === 'object' ? value : { data: value }) }); }
            eventName = 'message'; data = [];
        };
        return { feed(text) {
            buffer += String(text || '');
            const lines = [];
            let start = 0;
            for (let index = 0; index < buffer.length; index++) {
                const char = buffer[index];
                if (char === '\r') {
                    if (index + 1 === buffer.length) break;
                    lines.push(buffer.slice(start, index));
                    if (buffer[index + 1] === '\n') index++;
                    start = index + 1;
                } else if (char === '\n') {
                    lines.push(buffer.slice(start, index));
                    start = index + 1;
                }
            }
            buffer = buffer.slice(start);
            for (const line of lines) {
                if (!line) { dispatch(); continue; }
                if (line.startsWith(':')) continue;
                const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon);
                const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                if (field === 'event') eventName = value;
                else if (field === 'data') data.push(value);
            }
        }, end() { if (buffer) { this.feed('\n'); } dispatch(); } };
    }
    function create({ window: win = root, base = null, fetch: fetchFn = null, storage = null, now = () => Date.now(), idleMs = 120_000 } = {}) {
        const getBase = () => String(base || win?.getBackendBase?.() || win?.location?.origin || '').replace(/\/+$/, '');
        const fetcher = fetchFn || win?.fetch?.bind(win);
        const store = storage || win?.localStorage;
        const tokenKey = () => `chat-token-v1:${getBase()}`;
        const conversationKey = () => `chat-conversation-v1:${getBase()}`;
        function token() {
            let value = store?.getItem(tokenKey());
            if (!/^[0-9a-f]{64}$/i.test(value || '')) {
                const bytes = new Uint8Array(32);
                (win?.crypto || globalThis.crypto).getRandomValues(bytes);
                value = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
                store?.setItem(tokenKey(), value);
            }
            return value;
        }
        function conversation() {
            try {
                const value = JSON.parse(store?.getItem(conversationKey()) || 'null');
                const expires = typeof value?.expiresAt === 'number' ? value.expiresAt
                    : typeof value?.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
                return value?.id && Number.isFinite(expires) && expires > now() ? value : null;
            } catch (_) { return null; }
        }
        const saveConversation = value => { if (value) store?.setItem(conversationKey(), JSON.stringify(value)); else store?.removeItem(conversationKey()); };
        const agreementState = value => {
            if (value && ['draftRef', 'cid', 'planCid', 'previewUrl'].every(key => value[key] === null)) return null;
            if (value && typeof value.draftRef === 'string' && typeof value.cid === 'string'
                && typeof value.planCid === 'string' && typeof value.previewUrl === 'string') {
                return { draftRef: value.draftRef, cid: value.cid, planCid: value.planCid, previewUrl: value.previewUrl };
            }
            return undefined;
        };
        async function request(path, { method = 'GET', body, accept = 'application/json', signal } = {}) {
            const response = await fetcher(`${getBase()}/chat${path}`, { method, cache: 'no-store', redirect: 'error',
                headers: { Accept: accept, Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
            return response;
        }
        async function json(path, options) {
            const response = await request(path, options); let data = null; try { data = await response.json(); } catch (_) {}
            if (!response.ok) throw Object.assign(new Error(data?.message || data?.error || `Chat request failed (${response.status}).`), { code: data?.code || `http-${response.status}`, status: response.status });
            return data;
        }
        async function start(language, city) { const value = await json('/conversations', { method: 'POST', body: { language, city } }); saveConversation(value); return value; }
        async function end(id) { const response = await request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (!response.ok && response.status !== 404) throw Object.assign(new Error('Could not end this conversation.'), { code: `http-${response.status}`, status: response.status }); saveConversation(null); }
        async function get(id) { return json(`/conversations/${encodeURIComponent(id)}`); }
        async function sync(id) {
            const value = await get(id);
            const agreement = agreementState(value.agreement);
            saveConversation({ id: value.id, expiresAt: value.expiresAt, turns: value.turns, spentUsd: value.spentUsd, plan: value.plan,
                ...(agreement ? { agreement } : {}) });
            return value;
        }
        async function undo(id) { return json(`/conversations/${encodeURIComponent(id)}/undo`, { method: 'POST', body: {} }); }
        async function turn(id, payload, { onEvent = () => {}, signal: externalSignal } = {}) {
            const controller = new AbortController(); let timer;
            let terminal = false;
            const resetIdle = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(Object.assign(new Error('Chat stream timed out.'), { code: 'stream_timeout' })), idleMs); };
            const abort = () => controller.abort(externalSignal?.reason);
            externalSignal?.addEventListener('abort', abort, { once: true }); resetIdle();
            try {
                if (externalSignal?.aborted) {
                    controller.abort(externalSignal.reason);
                    throw Object.assign(new Error('The chat turn was cancelled.'), { code: 'stream_aborted', status: 0 });
                }
                const turnPayload = { ...payload, turnKey: payload?.turnKey || (win?.crypto?.randomUUID?.() || globalThis.crypto.randomUUID()) };
                const response = await request(`/conversations/${encodeURIComponent(id)}/turns`, { method: 'POST', accept: 'text/event-stream', body: turnPayload, signal: controller.signal });
                if (!response.ok) { let data = null; try { data = await response.json(); } catch (_) {}
                    throw Object.assign(new Error(data?.message || data?.error || `Chat request failed (${response.status}).`), { code: data?.code || `http-${response.status}`, status: response.status }); }
                if (!response.body?.getReader) throw Object.assign(new Error('The chat stream is unavailable.'), { code: 'stream_unavailable', status: response.status });
                const reader = response.body.getReader(), decoder = new TextDecoder(); const parser = parseSse(event => {
                    if (event.name === 'done' || event.name === 'error') terminal = true;
                    if (event.name === 'agreement') {
                        const agreement = agreementState(event), saved = conversation();
                        if (agreement !== undefined && saved?.id === id) {
                            const updated = { ...saved };
                            if (agreement) updated.agreement = agreement; else delete updated.agreement;
                            saveConversation(updated);
                        }
                    }
                    onEvent(event);
                });
                while (true) { const { done, value } = await reader.read(); resetIdle(); if (done) break; parser.feed(decoder.decode(value, { stream: true })); }
                parser.feed(decoder.decode()); parser.end();
                if (!terminal) throw Object.assign(new Error('The chat stream ended before its terminal event.'), { code: 'stream_truncated' });
            } catch (error) {
                if (controller.signal.aborted && !error.code) throw Object.assign(new Error('The chat stream ended.'), { code: 'stream_aborted', status: 0 });
                throw error;
            } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); }
        }
        return { token, conversation, start, get, sync, end, undo, turn };
    }
    return { create, parseSse };
});
