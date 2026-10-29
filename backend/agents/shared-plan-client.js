// The hosted MCP worker retains no database credentials; the API owns durable session state.
import { createRequire } from 'node:module';
import { withSharedPlanActivity } from './shared-plan-activity.js';
const { parser } = createRequire(import.meta.url)('../../frontend/js/shared-plan-events.js');

export function createSharedPlanClient({ env = {}, fetchImpl = fetch } = {}) {
    const base = `${String(env.UGT_API_BASE || 'https://api.urbangametheory.xyz').replace(/\/+$/, '')}/shared-plan-sessions`;
    const origin = env.UGT_APP_ORIGIN || 'https://urbangametheory.xyz';
    const streams = new Set();
    const path = id => { if (!/^[\w-]{24}$/.test(id)) throw new Error('Invalid shared plan session id'); return `/${id}`; };
    function headers(capability) {
        if (capability && !/^[\w-]{32}$/.test(capability)) throw new Error('Invalid shared plan capability');
        return { origin, 'content-type': 'application/json', ...(capability ? { authorization: `Bearer ${capability}` } : {}) };
    }
    async function checked(response) {
        if (response.ok) return response;
        const body = await response.json().catch(() => ({}));
        throw Object.assign(new Error(body.message || 'Shared plan storage unavailable.'), {
            code: body.code || 'shared-plan-unavailable', status: response.status,
            ...(body.currentVersion != null ? { currentVersion: body.currentVersion, currentCid: body.currentCid } : {})
        });
    }
    async function request(suffix, capability, method = 'GET', body) {
        return (await checked(await fetchImpl(base + suffix, { method, headers: headers(capability),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), redirect: 'error' }))).json();
    }
    const store = {
        create: artifact => request('', null, 'POST', { artifact }),
        inspect: (id, capability) => request(path(id), capability),
        eventState: (id, capability) => request(`${path(id)}/state`, capability),
        control: (id, capability, body) => request(`${path(id)}/control`, capability, 'POST', body),
        replace: (id, capability, body) => request(path(id), capability, 'PUT', body),
        undo: (id, capability, body) => request(`${path(id)}/undo`, capability, 'POST', body),
        assertEditable: (id, capability, expectedVersion) => request(`${path(id)}/check`, capability, 'POST', { expectedVersion }),
        async subscribe(id, capability, listener, onError = () => {}) {
            const controller = new AbortController();
            let closed = false, reader, idle;
            const close = () => { if (closed) return; closed = true; clearTimeout(idle); controller.abort(); void reader?.cancel().catch(() => {}); streams.delete(close); };
            streams.add(close);
            const timer = setTimeout(() => controller.abort(), 10_000); timer.unref();
            try {
                const response = await checked(await fetchImpl(`${base}${path(id)}/events`, { headers: headers(capability), signal: controller.signal, redirect: 'error' }));
                if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Shared plan events unavailable');
                reader = response.body.getReader();
            } catch (error) { close(); throw error; }
            finally { clearTimeout(timer); }
            const parse = parser(() => listener(), id), decoder = new TextDecoder();
            void (async () => {
                try {
                    while (!closed) {
                        clearTimeout(idle); idle = setTimeout(() => controller.abort(), 45_000); idle.unref();
                        const chunk = await reader.read();
                        if (chunk.done) throw new Error('Shared plan event connection closed');
                        parse(decoder.decode(chunk.value, { stream: true }));
                    }
                } catch (error) { if (!closed) { close(); onError(error); } }
            })();
            return close;
        },
        dispose() { for (const close of [...streams]) close(); }
    };
    return withSharedPlanActivity(store);
}
