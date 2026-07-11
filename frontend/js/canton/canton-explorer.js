// Canton state explorer — an in-app dialog (reuses the app's .wallet-modal chrome,
// so it inherits the site's fonts/styles) for inspecting any Canton party's
// proposals + sales on the shared ledger, with quick party switching and owner
// Accept. Replaces opening canton.html in a tab. See feature-daml.md §13.
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

    const short = (s) => (typeof s === 'string' && s.length > 24) ? `${s.slice(0, 10)}…${s.slice(-6)}` : (s || '');
    const hint = (p) => (typeof p === 'string' && p.indexOf('::') !== -1) ? p.slice(0, p.indexOf('::')) : (p || '');
    const price = (p) => (p == null ? '' : String(p).replace(/0+$/, '').replace(/\.$/, ''));

    async function fetchJson(path) {
        const r = await fetch(`${apiBase()}${path}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
    }
    const fetchProposals = (party) => fetchJson(`/canton/proposals?party=${encodeURIComponent(party)}`).then((j) => j.proposals || []);
    const fetchSales = (party) => fetchJson(`/canton/sales?party=${encodeURIComponent(party)}`).then((j) => j.sales || []);
    const rememberedParties = () => { try { return JSON.parse(localStorage.getItem('canton.parties') || '[]'); } catch (_) { return []; } };

    let viewParty = '';

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
                    <dt>cid</dt><dd title="${it.contractId || ''}">${short(it.contractId)}</dd>
                </dl>
                ${canAccept ? `<button class="btn btn-sm btn-success canton-explorer-accept" data-cid="${it.contractId}">Accept</button>` : ''}
            </div>`;
    }

    function renderChips(overlay) {
        const wrap = overlay.querySelector('[data-chips]');
        if (!wrap) return;
        const seen = new Set();
        const list = rememberedParties().filter((p) => p.party && !seen.has(p.party) && seen.add(p.party));
        wrap.innerHTML = list.length
            ? `<span class="canton-explorer-chips-label">Parties:</span>` + list.map((p) =>
                `<button type="button" class="canton-chip${p.party === viewParty ? ' active' : ''}" data-party="${p.party}" title="${p.party}">${hint(p.party)}<span class="canton-chip-role">${p.role || ''}</span></button>`).join('')
            : '';
    }

    async function loadInto(overlay, party) {
        viewParty = party || '';
        const statusEl = overlay.querySelector('[data-status]');
        const bodyEl = overlay.querySelector('[data-body]');
        const input = overlay.querySelector('#canton-explorer-party');
        if (input && party) input.value = party;
        renderChips(overlay);
        if (!party) { if (statusEl) statusEl.textContent = 'Enter or pick a party.'; if (bodyEl) bodyEl.innerHTML = ''; return; }
        if (statusEl) statusEl.textContent = 'Loading…';
        try {
            const [proposals, sales] = await Promise.all([fetchProposals(party), fetchSales(party)]);
            if (viewParty !== party) return; // switched mid-fetch
            const body = [
                `<h4 class="canton-explorer-h">Proposals</h4>`,
                proposals.length ? proposals.map((p) => cardHtml(p, party, 'proposal')).join('') : `<p class="canton-empty">No active proposals.</p>`,
                `<h4 class="canton-explorer-h">Sales</h4>`,
                sales.length ? sales.map((s) => cardHtml(s, party, 'sale')).join('') : `<p class="canton-empty">No sales.</p>`,
            ].join('');
            if (bodyEl) bodyEl.innerHTML = body;
            if (statusEl) statusEl.textContent = `${proposals.length} proposal(s), ${sales.length} sale(s) — as ${hint(party)}`;
        } catch (e) {
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
        }
    }

    const close = () => { document.querySelector('.canton-explorer-overlay')?.remove(); };

    function open() {
        close();
        const cur = (global.CantonMode && global.CantonMode.getParty && global.CantonMode.getParty()) || '';
        viewParty = cur;
        const overlay = document.createElement('div');
        overlay.className = 'wallet-modal-overlay canton-explorer-overlay';
        overlay.setAttribute('tabindex', '-1');
        overlay.innerHTML = `
            <div class="wallet-modal canton-explorer-modal" role="dialog" aria-modal="true">
                <div class="wallet-modal-header">
                    <h2>Canton state explorer</h2>
                    <button type="button" class="wallet-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close" data-close>&times;</button>
                </div>
                <div class="wallet-modal-body">
                    <div class="wallet-modal-description">Inspect any Canton party's proposals and sales on the shared ledger (read-only; you can Accept as the owner).</div>
                    <div class="canton-explorer-controls">
                        <input id="canton-explorer-party" type="text" placeholder="party id (hint::fingerprint)" autocomplete="off" value="${cur}" />
                        <button type="button" class="btn" data-load>Load</button>
                    </div>
                    <div class="canton-explorer-chips" data-chips></div>
                    <div class="canton-explorer-status canton-status-line" data-status></div>
                    <div class="canton-explorer-body canton-card-host" data-body></div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.focus({ preventScroll: true });
        renderChips(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('[data-close]')) return close();
            const chip = e.target.closest('[data-party]');
            if (chip) return loadInto(overlay, chip.getAttribute('data-party'));
            if (e.target.closest('[data-load]')) {
                return loadInto(overlay, (overlay.querySelector('#canton-explorer-party').value || '').trim());
            }
            const acc = e.target.closest('.canton-explorer-accept');
            if (acc) {
                const cid = acc.getAttribute('data-cid');
                const bridge = global.CantonProposalChainBridge;
                if (!cid || !bridge || !bridge.acceptProposal || !viewParty) return;
                acc.disabled = true; acc.textContent = 'Accepting…';
                bridge.acceptProposal({ contractId: cid, owner: viewParty })
                    .then(() => { if (global.CantonCounts) global.CantonCounts.refresh(); return loadInto(overlay, viewParty); })
                    .catch((x) => { acc.disabled = false; acc.textContent = 'Accept'; const s = overlay.querySelector('[data-status]'); if (s) s.textContent = `Error: ${x.message}`; });
            }
        });
        overlay.querySelector('#canton-explorer-party')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') loadInto(overlay, (e.target.value || '').trim());
        });

        if (cur) loadInto(overlay, cur);
    }

    global.CantonExplorer = { open };
})(typeof window !== 'undefined' ? window : globalThis);
