// First-party diagnostics: memory only, closed vocabulary, no automatic transmission.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.AppDiagnostics = api.create({ uuid: () => root.crypto.randomUUID() });
        api.install(root, root.AppDiagnostics);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const CATALOG = Object.freeze({
        unexpected: ['An unexpected problem occurred. Retry the action or download diagnostics.', 'error', true],
        'workspace-unavailable': ['The saved workspace could not be opened. Close other editing tabs and retry.', 'error', true],
        'draft-storage-unavailable': ['The draft is still in memory, but could not be saved on this device. Download your work before closing this tab.', 'error', true],
        'plan-import-failed': ['The plan file could not be imported. Check its format and size, then try again.', 'warning', true],
        'plan-export-failed': ['The file could not be created. Your work is unchanged; retry the download.', 'error', true],
        'plan-save-failed': ['The plan link could not be saved. Your local work remains available; check the connection and retry.', 'error', true],
        'plan-open-failed': ['The named plan could not be opened. Check the link and connection, then retry.', 'error', true],
        'design-publish-failed': ['The design could not be published. Review its land and geometry, then retry.', 'error', true],
        'design-load-failed': ['Published designs could not be loaded. Check the connection and retry.', 'warning', true],
        'design-apply-failed': ['The design is saved, but could not be applied to the map. Retry applying it from the designs panel.', 'warning', true],
        'share-failed': ['The share link could not be prepared. Retry from the share panel.', 'error', true],
        'clipboard-unavailable': ['The link could not be copied. Select the link and copy it manually.', 'warning', true],
        'network-unavailable': ['The server could not be reached. Check the connection and retry.', 'warning', true],
        'publication-rate-limited': ['Too many publications for now. Wait a few minutes and retry.', 'warning', true],
        'publication-too-large': ['The design is too large to publish. Reduce its detail and retry.', 'warning', true],
        'publication-identity-mismatch': ['The published content did not match its expected identity. Retry or download diagnostics.', 'error', true],
        'publication-unavailable': ['Publication storage is unavailable. Keep your work locally and retry later.', 'warning', true],
        'planning-action-failed': ['The planning action could not finish. Your previous saved state remains available; retry the action.', 'error', true]
    });
    const ALIASES = Object.freeze({ 'network-failed': 'network-unavailable', 'cid-mismatch': 'publication-identity-mismatch',
        'too-large': 'publication-too-large', 'pinning-quota-exhausted': 'publication-unavailable', 'pinning-unconfigured': 'publication-unavailable' });
    const OPERATIONS = ['create', 'edit', 'save', 'share', 'publish', 'import', 'export', 'open'];
    const ENTITIES = ['plan', 'design', 'workspace', 'file', 'artifact'];
    const SURFACES = ['draft-editor', 'plan-file', 'named-plan', 'design-index', 'workspace', 'runtime', 'share-panel', 'api', 'mcp'];
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const MAX_ENTRIES = 100, MAX_AGE_MS = 24 * 60 * 60 * 1000;
    function get(object, field) { try { return object?.[field]; } catch { return undefined; } }
    function contextOf(input) {
        const out = {};
        if (SURFACES.includes(get(input, 'surface'))) out.surface = get(input, 'surface');
        if (['json', 'geojson'].includes(get(input, 'format'))) out.format = get(input, 'format');
        const status = get(input, 'httpStatus');
        if (Number.isInteger(status) && status >= 100 && status <= 599) out.httpStatus = status;
        return out;
    }
    function codeOf(error, fallback = 'unexpected') {
        const code = get(error, 'code');
        if (get(error, 'status') === 429) return 'publication-rate-limited';
        return Object.hasOwn(CATALOG, code) ? code : Object.hasOwn(ALIASES, code) ? ALIASES[code]
            : Object.hasOwn(CATALOG, fallback) ? fallback : 'unexpected';
    }
    function wire(entry) {
        // Deliberately reconstruct: never spread error objects, context or imported diagnostics.
        return { id: entry.id, correlationId: entry.correlationId, sessionId: entry.sessionId,
            planId: entry.planId, kind: entry.kind, operation: entry.operation, entity: entry.entity,
            outcome: entry.outcome, code: entry.code, context: contextOf(entry.context) };
    }
    function display(entry) {
        const item = wire(entry);
        const definition = CATALOG[item.code];
        return { ...item, ...(definition ? { message: definition[0], severity: definition[1], recoverable: definition[2] } : {}) };
    }
    function create({ uuid, now = Date.now } = {}) {
        const id = () => { const value = uuid(); if (!UUID.test(value)) throw new Error('A random UUID is required'); return value; };
        let sessionId = null, lastActivity = 0, entries = [], sending = null, lastSendAt = -Infinity;
        const handles = new Map();
        let seenErrors = new WeakMap();
        let dedupe = new Map();
        const prune = () => {
            const at = now(); entries = entries.filter(row => at - row.at < MAX_AGE_MS).slice(-MAX_ENTRIES);
            for (const [key, value] of dedupe) if (at - value.at >= 1000) dedupe.delete(key);
        };
        function push(row) {
            prune();
            if (!sessionId || now() - lastActivity >= 30 * 60 * 1000) { sessionId = id(); handles.clear(); }
            lastActivity = now();
            const entry = { ...wire({ ...row, id: id(), correlationId: row.correlationId || id(), sessionId }), at: now() };
            entries.push(entry); entries = entries.slice(-MAX_ENTRIES); return display(entry);
        }
        function planHandle(key) {
            if (key == null) return null;
            if (!handles.has(key)) {
                if (handles.size >= MAX_ENTRIES) handles.delete(handles.keys().next().value);
                handles.set(key, id());
            }
            return handles.get(key);
        }
        function event(operation, outcome, { entity = 'design', planKey = null, context = {}, correlationId = null } = {}) {
            try {
                if (!OPERATIONS.includes(operation) || !['success', 'failure', 'cancelled'].includes(outcome) || !ENTITIES.includes(entity)) return null;
                // Session expiry happens before handle allocation; a handle never crosses sessions.
                if (!sessionId || now() - lastActivity >= 30 * 60 * 1000) { sessionId = id(); handles.clear(); lastActivity = now(); }
                return push({ kind: 'operation', operation, entity, outcome, code: null,
                    planId: entity === 'plan' ? planHandle(planKey) : null, context: contextOf(context), correlationId });
            } catch { return null; } // Diagnostics must never interrupt planning.
        }
        function report(error, { code = 'unexpected', context = {}, correlationId = null } = {}) {
            try {
                prune();
                const canRemember = error !== null && (typeof error === 'object' || typeof error === 'function');
                const previous = canRemember && seenErrors.get(error);
                if (previous && now() - previous.at < MAX_AGE_MS) return display(previous);
                const safeCode = codeOf(error, code), safeContext = contextOf(context);
                const key = JSON.stringify([safeCode, safeContext]);
                const recent = dedupe.get(key);
                if (recent) return display(recent);
                const value = push({ kind: 'error', operation: null, entity: 'workspace', outcome: 'failure',
                    code: safeCode, planId: null, context: safeContext, correlationId });
                const remembered = { ...value, at: now() };
                dedupe.set(key, remembered);
                if (dedupe.size > MAX_ENTRIES) dedupe.delete(dedupe.keys().next().value);
                if (canRemember) seenErrors.set(error, remembered);
                return value;
            } catch { return { code: 'unexpected', message: CATALOG.unexpected[0], severity: 'error', recoverable: true, correlationId: null }; }
        }
        async function run(operation, options, action) {
            try {
                const result = await action(); event(operation, 'success', options); return result;
            } catch (error) {
                const cancelled = get(error, 'cancelled') === true;
                const diagnostic = cancelled ? null : report(error, options);
                event(operation, cancelled ? 'cancelled' : 'failure', { ...options, correlationId: diagnostic?.correlationId });
                throw error; // Preserve caller recovery, cancellation and control cleanup.
            }
        }
        function snapshot() { prune(); return { version: 1, entries: entries.map(display) }; }
        function exportText() { return JSON.stringify(snapshot(), null, 2) + '\n'; }
        function clear() { entries = []; dedupe = new Map(); seenErrors = new WeakMap(); handles.clear(); sessionId = null; }
        async function send({ enabled = false, confirm = false, fetch, endpoint, timeoutMs = 5000 } = {}) {
            if (!enabled || confirm !== true) return { ok: false, code: 'submission-disabled' };
            if (sending) return sending;
            if (now() - lastSendAt < 60000) return { ok: false, code: 'submission-rate-limited' };
            let target;
            try { target = new URL(endpoint); } catch { return { ok: false, code: 'submission-unavailable' }; }
            if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/diagnostics/reports') return { ok: false, code: 'submission-unavailable' };
            prune(); const batch = entries.slice(-20).map(wire);
            if (!batch.length) return { ok: true, accepted: 0 };
            lastSendAt = now();
            sending = (async () => {
                const controller = new AbortController(); let timer;
                try {
                    const response = await Promise.race([
                        fetch(target.href, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                            credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
                            body: JSON.stringify({ version: 1, entries: batch }) }),
                        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); })
                    ]);
                    // Bound response waiting as well as connection waiting.
                    const acknowledgement = await Promise.race([response.json(), new Promise((_, reject) => {
                        clearTimeout(timer); timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
                    })]);
                    if (!response.ok || acknowledgement.accepted !== batch.length) return { ok: false, code: 'submission-unavailable' };
                    return { ok: true, accepted: batch.length };
                } catch { return { ok: false, code: 'submission-unavailable' }; }
                finally { clearTimeout(timer); }
            })();
            try { return await sending; } finally { sending = null; }
        }
        return { event, report, run, snapshot, exportText, clear, send };
    }
    function install(win, client) {
        // Neither event text, filename, URL, stack nor rejection reason leaves this handler.
        let reporting = false;
        const unexpected = event => {
            if (reporting) return;
            reporting = true;
            try { client.report(get(event, 'error') || get(event, 'reason'), { context: { surface: 'runtime' } }); }
            finally { reporting = false; }
        };
        win.addEventListener('error', unexpected);
        win.addEventListener('unhandledrejection', unexpected);
        function controls() {
            const host = win.document.querySelector('#status-log-modal .cb-dialog__footer');
            if (!host || host.querySelector('[data-diagnostics-export]')) return;
            const note = win.document.createElement('p');
            note.textContent = 'Diagnostics stay in this tab for up to 24 hours. Downloads contain fixed error codes and action outcomes, without plan content. Nothing is sent automatically.';
            host.appendChild(note);
            const button = (label, attribute, action) => {
                const node = win.document.createElement('button'); node.type = 'button'; node.className = 'btn';
                node.textContent = label; node.setAttribute(attribute, ''); node.addEventListener('click', action); host.appendChild(node); return node;
            };
            button('Download diagnostics', 'data-diagnostics-export', () => {
                const url = win.URL.createObjectURL(new win.Blob([client.exportText()], { type: 'application/json' }));
                const link = win.document.createElement('a'); link.href = url; link.download = 'ugt-diagnostics.json';
                win.document.body.appendChild(link); link.click(); link.remove(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
            });
            button('Clear diagnostics', 'data-diagnostics-clear', () => client.clear());
            // The static build and server gate are independently off until rollout review.
            if (win.UGT_DIAGNOSTICS_SUBMISSION_ENABLED === true) {
                const status = win.document.createElement('span'); status.setAttribute('role', 'status'); host.appendChild(status);
                const send = button('Send diagnostic report', 'data-diagnostics-send', async () => {
                    if (!win.confirm('Send the latest 20 redacted diagnostic entries to Urban Game Theory? They include temporary session/plan handles and action outcomes. The server receives your network address as part of the connection.')) return;
                    try {
                        await win.BusyControl.track(send, async () => {
                            const result = await client.send({ enabled: true, confirm: true, fetch: win.fetch.bind(win), endpoint: win.getBackendBase().replace(/\/$/, '') + '/diagnostics/reports' });
                            status.textContent = result.ok ? 'Report received.' : 'Report was not sent. Download diagnostics or retry in one minute.';
                        });
                    } catch { status.textContent = 'Report was not sent. Download diagnostics instead.'; }
                });
            }
        }
        if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', controls, { once: true });
        else controls();
        return () => { win.removeEventListener('error', unexpected); win.removeEventListener('unhandledrejection', unexpected); };
    }
    return { CATALOG, OPERATIONS, ENTITIES, SURFACES, UUID, MAX_ENTRIES, MAX_AGE_MS, contextOf, codeOf, wire, create, install };
});
