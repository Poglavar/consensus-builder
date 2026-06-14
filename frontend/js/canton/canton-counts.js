// Canton parcel→proposal counts for the map. Fetches the public existence signal
// (GET /canton/parcel-counts — on-ledger markers, no terms) and exposes a sync
// getCount() for the proposal-count labels. Existence is public by design; terms
// stay private to stakeholders. See feature-daml.md §13.
(function (global) {
    'use strict';

    function apiBase() {
        try {
            const override = new URLSearchParams(global.location.search).get('api');
            if (override) return override.replace(/\/$/, '');
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
                global.dispatchEvent(new Event('canton-counts-updated'));
            } catch (_) {
                // Backend may not expose /canton (e.g. Canton not deployed here) — stay silent.
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

    global.CantonCounts = { refresh, ensureFresh, getCount, raw: () => counts };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refresh, { once: true });
    } else {
        refresh();
    }
})(typeof window !== 'undefined' ? window : globalThis);
