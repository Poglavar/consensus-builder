// Canton parcel→proposal counts for the map. Fetches the public existence signal
// (GET /canton/parcel-counts — on-ledger markers, no terms) and exposes a sync
// getCount() for the proposal-count labels. Existence is public by design; terms
// stay private to stakeholders. See feature-daml.md §13.
(function (global) {
    'use strict';

    // The backend base. data-source.js already resolves this for every environment — including the
    // `?backend=` override that dev.sh passes so a worktree talks to its own backend — so defer to it.
    // Rolling our own here is how Canton ended up unreachable in dev: same-origin meant the static
    // frontend port, which serves no /canton routes.
    function apiBase() {
        try {
            const override = new URLSearchParams(global.location.search).get('api');
            if (override) return override.replace(/\/$/, '');
        } catch (_) { }
        try {
            if (typeof global.getBackendBase === 'function') {
                const base = global.getBackendBase();
                if (base) return String(base).replace(/\/+$/, '');
            }
        } catch (_) { }
        // Standalone pages (canton.html) may not load data-source.js.
        try {
            if (global.location.protocol === 'file:') return 'http://localhost:3000';
            const h = (global.location.hostname || '').toLowerCase();
            if (h.endsWith('urbangametheory.xyz') && !h.startsWith('api.')) return 'https://api.urbangametheory.xyz';
        } catch (_) { }
        return ''; // same-origin
    }

    let counts = {};       // parcelId (raw + normalized) -> count
    let lastFetch = 0;
    let inflight = null;
    const TTL_MS = 30000;

    // 'unknown' until the first fetch settles, then 'ok' or 'unavailable'. Without it, a backend with no
    // CANTON_* config (which 502s) and a ledger with no proposals both render as zero everywhere, so the
    // feature looks empty rather than broken — which is exactly how a misconfigured backend hid.
    let status = 'unknown';
    let lastError = null;

    const norm = (id) => (typeof global.normalizeParcelId === 'function' ? global.normalizeParcelId(id) : String(id));

    function indexCounts(raw) {
        const m = {};
        for (const [k, v] of Object.entries(raw || {})) {
            m[k] = v;
            try { const n = norm(k); if (n && !(n in m)) m[n] = v; } catch (_) { }
        }
        return m;
    }

    function refresh() {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const res = await fetch(`${apiBase()}/canton/parcel-counts`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                counts = indexCounts(data.counts || {});
                lastFetch = Date.now();
                status = 'ok';
                lastError = null;
                global.dispatchEvent(new Event('canton-counts-updated'));
            } catch (error) {
                // A backend without Canton configured is a legitimate deployment, so this is not fatal —
                // but it is not "no proposals" either. Say so once, and let callers ask.
                if (status !== 'unavailable') {
                    console.warn('[CantonCounts] /canton/parcel-counts unavailable — proposal badges will not render.', error.message);
                }
                status = 'unavailable';
                lastError = error.message || String(error);
                lastFetch = Date.now(); // don't hammer a backend that has no Canton
                global.dispatchEvent(new Event('canton-counts-updated'));
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    function ensureFresh() { if (Date.now() - lastFetch > TTL_MS) refresh(); }

    function getCount(parcelId) {
        if (!parcelId) return 0;
        if (parcelId in counts) return counts[parcelId];
        return counts[norm(parcelId)] || 0;
    }

    // 'unknown' | 'ok' | 'unavailable'. Callers that render a count should ask before showing a zero.
    function getStatus() { return status; }
    function isAvailable() { return status === 'ok'; }
    function getError() { return lastError; }

    global.CantonCounts = { refresh, ensureFresh, getCount, getStatus, isAvailable, getError, raw: () => counts };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refresh, { once: true });
    } else {
        refresh();
    }
})(typeof window !== 'undefined' ? window : globalThis);
