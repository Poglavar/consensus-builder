// Betting journey events, separate from chain activity. Anonymous browser/session IDs correlate
// visits; explicit test runs and local/automated previews remain distinguishable from visitors.
(function attachBetsTelemetry(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root?.document) return;
    const query = new URLSearchParams(root.location.search);
    const explicitRun = query.get('betTest')?.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40).replace(/^[-_]+|[-_]+$/g, '');
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(root.location.hostname);
    const simulationRun = explicitRun || (local ? 'local-preview' : root.navigator.webdriver ? 'browser-automation' : null);
    const client = api.create({
        storage: root.localStorage, sessionStorage: root.sessionStorage,
        uuid: () => root.crypto.randomUUID(), fetch: (...args) => root.fetch(...args),
        baseUrl: () => typeof root.getBackendBase === 'function' ? root.getBackendBase() : 'https://api.urbangametheory.xyz',
        simulationRun,
        context: () => ({ city: root.resolveCurrentCityCode?.() || null }),
        warn: message => console.warn(`[${new Date().toISOString()}] [bets-telemetry] ${message}`)
    });
    root.BetsTelemetry = client;
    root.document.addEventListener('visibilitychange', () => {
        if (root.document.visibilityState === 'hidden') void client.flush();
    });
})(typeof window !== 'undefined' ? window : null, function betsTelemetryFactory() {
    'use strict';
    const NAMES = new Set(['entry', 'discovery', 'market_open', 'comparison_view', 'agreement_open', 'quote',
        'action_start', 'action_status', 'action_end', 'position_view', 'share', 'return', 'close',
        'asset_select', 'standings_view', 'public_positions_view']);
    const FIELDS = ['city', 'agreementAccount', 'agreementCid', 'action', 'side', 'result', 'asset', 'entryPoint', 'errorCode'];
    const MAX_PENDING = 200;
    const SESSION_IDLE_MS = 30 * 60 * 1000;

    function errorResult(error) {
        if (error?.code === 'CONFIRMATION_UNKNOWN') return 'unknown';
        if (error?.code === 4001 || ['ACTION_CANCELLED', 'TRANSACTION_REJECTED', 'USER_REJECTED'].includes(error?.code)) return 'cancelled';
        return 'failed';
    }

    function create({ storage, sessionStorage, uuid, fetch, baseUrl, simulationRun = null, context = () => ({}), now = () => new Date(), warn = () => {} }) {
        if (simulationRun !== null && !/^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/.test(simulationRun)) throw new Error('Invalid betting simulation run');
        const actorMode = simulationRun ? 'simulated' : 'visitor';
        const key = `bets-telemetry-v1:${simulationRun || 'visitor'}`;
        const get = (store, name) => { try { return store?.getItem(name); } catch { return null; } };
        const put = (store, name, value) => { try { store?.setItem(name, value); } catch { warn('Browser event storage is unavailable'); } };
        const identity = (store, name) => {
            const existing = get(store, name);
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing || '')) return existing;
            const id = uuid(); put(store, name, id); return id;
        };
        const visitorId = identity(storage, `${key}:visitor`);
        let sessionId = identity(sessionStorage, `${key}:session`);
        let lastActivity = Number(get(sessionStorage, `${key}:last-activity`)) || 0;
        let pending = [];
        try { pending = JSON.parse(get(sessionStorage, `${key}:pending`) || '[]'); } catch { warn('Stored betting events could not be read'); }
        if (!Array.isArray(pending)) pending = [];
        pending = pending.filter(event => event.visitorId === visitorId && event.actorMode === actorMode).slice(-MAX_PENDING);
        let request = null;
        let entered = false;
        let failed = false;
        const persist = () => put(sessionStorage, `${key}:pending`, JSON.stringify(pending));

        function event(name, properties) {
            const values = { ...context(), ...properties };
            const item = { id: uuid(), visitorId, sessionId, actorMode, simulationRun, occurredAt: now().toISOString(), name };
            for (const field of FIELDS) if (values[field] !== undefined && values[field] !== null) item[field] = values[field];
            if (pending.length >= MAX_PENDING) { warn('Betting event queue is full; an event was not recorded'); return null; }
            pending.push(item); persist(); return item.id;
        }

        async function send() {
            while (pending.length) {
                const batch = pending.slice(0, 20);
                try {
                    const response = await fetch(`${String(baseUrl()).replace(/\/$/, '')}/bets/events`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ events: batch }), keepalive: true
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    // The endpoint acknowledges the durable insert before the queue is discarded.
                    const acknowledgement = await response.json();
                    if (acknowledgement.accepted !== batch.length) throw new Error('Incomplete event acknowledgement');
                    const sent = new Set(batch.map(item => item.id));
                    pending = pending.filter(item => !sent.has(item.id)); persist(); failed = false;
                } catch {
                    if (!failed) warn('Betting events could not be saved; queued for the next attempt');
                    failed = true;
                    return false;
                }
            }
            return true;
        }

        function flush() {
            if (!request) request = send().finally(() => { request = null; });
            return request;
        }

        function track(name, properties = {}) {
            if (!NAMES.has(name)) throw new Error(`Unknown betting event: ${name}`);
            const at = now().getTime();
            if (lastActivity && at - lastActivity >= SESSION_IDLE_MS) {
                sessionId = uuid(); put(sessionStorage, `${key}:session`, sessionId); entered = false;
            }
            lastActivity = at; put(sessionStorage, `${key}:last-activity`, String(at));
            if (name === 'entry' && entered) return null;
            if (!entered) { entered = true; if (name !== 'entry') event('entry', { entryPoint: properties.entryPoint || 'bets' }); }
            const id = event(name, properties);
            void flush();
            return id;
        }

        return { track, flush, actorMode, simulationRun, errorResult, pendingCount: () => pending.length };
    }
    return { create, errorResult };
});
