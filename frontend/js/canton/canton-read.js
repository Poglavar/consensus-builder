// Canton chain option — minimal read-only view. Fetches a party's proposals and
// sales from the backend (/canton/*) and renders them. Read-only for now; the
// write path and the party-perspective switcher come in later steps.
(function () {
    'use strict';

    // Backend base URL. Precedence: ?api= override → file:// dev (localhost:3000)
    // → production frontend host (api.urbangametheory.xyz) → same origin (dev
    // servers, incl. backend/canton/dev-serve.js, on any host/port).
    function apiBase() {
        try {
            const override = new URLSearchParams(window.location.search).get('api');
            if (override) return override.replace(/\/$/, '');
            if (window.location.protocol === 'file:') return 'http://localhost:3000';
            const h = (window.location.hostname || '').toLowerCase();
            if (h.endsWith('urbangametheory.xyz') && !h.startsWith('api.')) {
                return 'https://api.urbangametheory.xyz';
            }
        } catch (_) { }
        return ''; // same-origin
    }

    const short = (s) => (typeof s === 'string' && s.length > 24) ? `${s.slice(0, 10)}…${s.slice(-6)}` : (s || '');
    const price = (p) => (p == null ? '' : String(p).replace(/0+$/, '').replace(/\.$/, ''));

    async function fetchJson(path) {
        const res = await fetch(`${apiBase()}${path}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
    }

    async function fetchProposals(party) {
        return (await fetchJson(`/canton/proposals?party=${encodeURIComponent(party)}`)).proposals || [];
    }
    async function fetchSales(party) {
        return (await fetchJson(`/canton/sales?party=${encodeURIComponent(party)}`)).sales || [];
    }

    function rowsHtml(items, kind) {
        if (!items.length) return `<p class="canton-empty">No ${kind}.</p>`;
        return items.map((it) => `
            <div class="canton-card">
                <div class="canton-card-top">
                    <span class="canton-parcel">${it.parcelId || '—'}</span>
                    <span class="canton-price">${price(it.price)}</span>
                </div>
                <dl class="canton-meta">
                    <dt>buyer</dt><dd title="${it.buyer || ''}">${short(it.buyer)}</dd>
                    <dt>owner</dt><dd title="${it.owner || ''}">${short(it.owner)}</dd>
                    ${it.lens ? `<dt>lens</dt><dd title="${it.lens}">${short(it.lens)}</dd>` : ''}
                    <dt>cid</dt><dd title="${it.contractId || ''}">${short(it.contractId)}</dd>
                </dl>
            </div>`).join('');
    }

    async function load(party) {
        const propEl = document.getElementById('canton-proposals');
        const saleEl = document.getElementById('canton-sales');
        const statusEl = document.getElementById('canton-status');
        if (!party) { if (statusEl) statusEl.textContent = 'Enter a party ID.'; return; }
        if (statusEl) statusEl.textContent = 'Loading…';
        try {
            const [proposals, sales] = await Promise.all([fetchProposals(party), fetchSales(party)]);
            if (propEl) propEl.innerHTML = rowsHtml(proposals, 'proposals');
            if (saleEl) saleEl.innerHTML = rowsHtml(sales, 'sales');
            if (statusEl) statusEl.textContent = `${proposals.length} proposal(s), ${sales.length} sale(s)`;
        } catch (e) {
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
        }
    }

    function init() {
        const input = document.getElementById('canton-party');
        const btn = document.getElementById('canton-load');
        const fromQuery = new URLSearchParams(window.location.search).get('party');
        if (fromQuery && input) input.value = fromQuery;
        if (btn) btn.addEventListener('click', () => load(input ? input.value.trim() : ''));
        if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(input.value.trim()); });
        if (fromQuery) load(fromQuery);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    window.CantonRead = { fetchProposals, fetchSales, load };
})();
