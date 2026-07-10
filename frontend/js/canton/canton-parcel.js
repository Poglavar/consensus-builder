// Canton proposals section inside the parcel panel (P3). The per-parcel COUNT is
// public (CantonCounts); the DETAILS are gated to the current Canton identity —
// you only see a proposal's terms if you're a stakeholder (buyer/owner/lens), and
// can Accept only as the owner. Mirrors the canton.html view/accept, self-contained
// (canton-read.js is the standalone page; not loaded here). See feature-daml.md §13.
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

    const short = (s) => (typeof s === 'string' && s.indexOf('::') !== -1) ? s.slice(0, s.indexOf('::')) : (s || '');
    const price = (p) => (p == null ? '' : String(p).replace(/0+$/, '').replace(/\.$/, ''));

    async function fetchForParty(party) {
        const res = await fetch(`${apiBase()}/canton/proposals?party=${encodeURIComponent(party)}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        return j.proposals || [];
    }
    async function fetchSalesForParty(party) {
        const res = await fetch(`${apiBase()}/canton/sales?party=${encodeURIComponent(party)}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        return j.sales || [];
    }

    // kind: 'proposal' (active → "Open", owner can Accept) or 'sale' ("Accepted").
    // Buyer + owner stay stakeholders of a Sale, so they keep seeing it post-accept;
    // the lens (not a Sale signatory) correctly no longer does.
    function cardHtml(it, party, kind) {
        const isSale = kind === 'sale';
        const roles = ['buyer', 'owner', 'lens'].filter((r) => it[r] && it[r] === party);
        const youTag = roles.length ? `<span class="canton-you">you: ${roles.join(', ')}</span>` : '';
        const canAccept = !isSale && it.owner && it.owner === party;
        return `
            <div class="canton-card">
                <div class="canton-card-top">
                    <span class="canton-parcel">${it.parcelId || '—'}</span>
                    <span class="canton-status ${isSale ? 'canton-status-accepted' : 'canton-status-open'}">${isSale ? 'Accepted' : 'Open'}</span>
                    ${youTag}
                    <span class="canton-price">${price(it.price)}</span>
                </div>
                <dl class="canton-meta">
                    <dt>buyer</dt><dd title="${it.buyer || ''}">${short(it.buyer)}</dd>
                    <dt>owner</dt><dd title="${it.owner || ''}">${short(it.owner)}</dd>
                    ${it.lens ? `<dt>lens</dt><dd title="${it.lens}">${short(it.lens)}</dd>` : ''}
                </dl>
                ${canAccept ? `<button class="btn btn-sm btn-success canton-panel-accept" data-canton-accept data-cid="${it.contractId}">Accept</button>` : ''}
            </div>`;
    }

    const section = (inner, total) =>
        `<div class="canton-panel-section"><h4 class="canton-panel-title">Canton proposals${total ? ` <span class="canton-badge">${total}</span>` : ''}</h4>${inner}</div>`;

    let currentParcelId = null;

    async function render(parcelId) {
        const el = global.document.getElementById('canton-proposals-content');
        if (!el) return;
        currentParcelId = parcelId != null ? String(parcelId) : null;
        const CM = global.CantonMode, CC = global.CantonCounts;
        if (CC && CC.ensureFresh) CC.ensureFresh();
        const total = (CC && CC.getCount) ? CC.getCount(parcelId) : 0;
        const active = !!(CM && CM.isActive && CM.isActive());
        const party = (CM && CM.getParty) ? CM.getParty() : '';

        // A backend with no Canton configured returns 502 and leaves the counts empty. Saying "no
        // proposals" there would be a lie: we do not know, because we could not ask.
        const countsUnavailable = !!(CC && CC.getStatus && CC.getStatus() === 'unavailable');
        if (countsUnavailable && active) {
            el.innerHTML = section('<p class="canton-empty">Canton is unavailable on this backend — proposal counts could not be loaded.</p>', 0);
            return;
        }

        if (!total && !active) { el.innerHTML = ''; return; } // nothing relevant here

        if (!active || !party) {
            el.innerHTML = section(total
                ? `<p class="canton-empty">${total} Canton proposal(s) — terms private. Switch to <b>Canton</b> (network pill) and pick your identity to view details.</p>`
                : `<p class="canton-empty">No Canton proposals.</p>`, total);
            return;
        }

        el.innerHTML = section('<p class="canton-empty">Loading…</p>', total);
        let mine = [], sales = [];
        try {
            const [props, allSales] = await Promise.all([fetchForParty(party), fetchSalesForParty(party)]);
            mine = props.filter((p) => String(p.parcelId) === currentParcelId);
            sales = allSales.filter((s) => String(s.parcelId) === currentParcelId);
        } catch (e) {
            if (currentParcelId === (parcelId != null ? String(parcelId) : null)) {
                el.innerHTML = section(`<p class="canton-empty">Error: ${e.message}</p>`, total);
            }
            return;
        }
        if (currentParcelId !== (parcelId != null ? String(parcelId) : null)) return; // parcel changed mid-fetch

        // `total` (markers) counts only OPEN proposals; sales are separate.
        const privateCount = Math.max(0, total - mine.length);
        let body = mine.map((p) => cardHtml(p, party, 'proposal')).join('')
            + sales.map((s) => cardHtml(s, party, 'sale')).join('');
        if (privateCount) body += `<p class="canton-empty">${privateCount} more on this parcel — terms private to their stakeholders.</p>`;
        if (!mine.length && !sales.length && !privateCount) body = `<p class="canton-empty">No Canton proposals.</p>`;
        el.innerHTML = section(body, total);
    }

    // Delegated Accept — only within our panel container.
    global.document.addEventListener('click', (e) => {
        const b = e.target.closest('[data-canton-accept]');
        if (!b || !b.closest('#canton-proposals-content')) return;
        const cid = b.getAttribute('data-cid');
        const CM = global.CantonMode, bridge = global.CantonProposalChainBridge;
        const party = CM && CM.getParty && CM.getParty();
        if (!cid || !party || !bridge || !bridge.acceptProposal) return;
        b.disabled = true;
        b.textContent = 'Accepting…';
        bridge.acceptProposal({ contractId: cid, owner: party })
            .then(async () => {
                // Refresh the public count BEFORE re-rendering so the badge is accurate.
                if (global.CantonCounts && global.CantonCounts.refresh) await global.CantonCounts.refresh();
                return render(currentParcelId);
            })
            .catch((x) => {
                b.disabled = false;
                b.textContent = 'Accept';
                const el = global.document.getElementById('canton-proposals-content');
                if (el) { const p = global.document.createElement('p'); p.className = 'canton-empty'; p.textContent = `Error: ${x.message}`; el.appendChild(p); }
            });
    });

    global.CantonParcel = { render };
})(typeof window !== 'undefined' ? window : globalThis);
