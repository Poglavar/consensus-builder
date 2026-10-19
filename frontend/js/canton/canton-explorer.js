// Canton state explorer — an in-app dialog (the shared CbDialog, js/ui/dialogs.js) for
// inspecting any Canton party's proposals + sales on the shared ledger, with quick party
// switching and owner Accept. Replaces opening canton.html in a tab. See feature-daml.md §13.
(function (global) {
    'use strict';
    // Canton is switched off (environment.js CANTON_ENABLED): define nothing, request nothing.
    if (global.CANTON_ENABLED !== true) return;

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

    // A proposal or sale: its status and "you" role are cb-badges (an open proposal reads as
    // published, an accepted sale as executed).
    function cardHtml(it, party, kind) {
        const isSale = kind === 'sale';
        const roles = ['buyer', 'owner', 'lens'].filter((r) => it[r] && it[r] === party);
        const youTag = roles.length ? `<span class="cb-badge">you: ${roles.join(', ')}</span>` : '';
        const canAccept = !isSale && it.owner && it.owner === party;
        return `
            <div class="canton-card">
                <div class="canton-card-top">
                    <span class="canton-parcel">${it.parcelId || '—'}</span>
                    <span class="cb-badge ${isSale ? 'cb-badge--executed' : 'cb-badge--published'}">${isSale ? 'Accepted' : 'Open'}</span>
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

    // The remembered parties as one cb-segmented row: the party on view is aria-pressed.
    function renderChips(root) {
        const wrap = root.querySelector('[data-chips]');
        if (!wrap) return;
        const seen = new Set();
        const list = rememberedParties().filter((p) => p.party && !seen.has(p.party) && seen.add(p.party));
        wrap.innerHTML = list.length
            ? `<p class="cb-kicker" id="canton-explorer-parties-label">Parties</p><div class="cb-segmented" role="group" aria-labelledby="canton-explorer-parties-label">` + list.map((p) =>
                `<button type="button" class="cb-segmented__option" aria-pressed="${p.party === viewParty ? 'true' : 'false'}" data-party="${p.party}" title="${p.party}">${hint(p.party)}<span class="canton-chip-role">${p.role || ''}</span></button>`).join('') + '</div>'
            : '';
    }

    async function loadInto(root, party) {
        viewParty = party || '';
        const statusEl = root.querySelector('[data-status]');
        const bodyEl = root.querySelector('[data-body]');
        const input = root.querySelector('#canton-explorer-party');
        if (input && party) input.value = party;
        renderChips(root);
        if (!party) { if (statusEl) statusEl.textContent = 'Enter or pick a party.'; if (bodyEl) bodyEl.innerHTML = ''; return; }
        if (statusEl) statusEl.textContent = 'Loading…';
        try {
            const [proposals, sales] = await Promise.all([fetchProposals(party), fetchSales(party)]);
            if (viewParty !== party) return; // switched mid-fetch
            const body = [
                `<h4 class="cb-kicker canton-explorer-h">Proposals</h4>`,
                proposals.length ? proposals.map((p) => cardHtml(p, party, 'proposal')).join('') : `<p class="canton-empty">No active proposals.</p>`,
                `<h4 class="cb-kicker canton-explorer-h">Sales</h4>`,
                sales.length ? sales.map((s) => cardHtml(s, party, 'sale')).join('') : `<p class="canton-empty">No sales.</p>`,
            ].join('');
            if (bodyEl) bodyEl.innerHTML = body;
            if (statusEl) statusEl.textContent = `${proposals.length} proposal(s), ${sales.length} sale(s) — as ${hint(party)}`;
        } catch (e) {
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
        }
    }

    // The open explorer (a CbDialog handle), so a second open replaces it.
    let explorer = null;
    const close = () => { if (explorer) explorer.close(); };

    // The shared dialog on the upper rung (it opens from the Canton identity picker).
    // wallet-modal / wallet-modal-overlay / canton-explorer-* and the data-* attributes are hooks
    // for scripts and the e2e specs, not looks.
    function open() {
        close();
        const cur = (global.CantonMode && global.CantonMode.getParty && global.CantonMode.getParty()) || '';
        viewParty = cur;
        const content = document.createElement('div');
        content.innerHTML = `
            <p class="wallet-modal-description">Inspect any Canton party's proposals and sales on the shared ledger (read-only; you can Accept as the owner).</p>
            <div class="canton-explorer-controls">
                <input id="canton-explorer-party" type="text" placeholder="party id (hint::fingerprint)" aria-label="Party id" autocomplete="off" value="${cur}" />
                <button type="button" class="btn" data-load>Load</button>
            </div>
            <div class="canton-explorer-chips" data-chips></div>
            <div class="canton-explorer-status canton-status-line" data-status role="status" aria-live="polite"></div>
            <div class="canton-explorer-body canton-card-host" data-body></div>`;
        const dialog = global.CbDialog.open({
            title: 'Canton state explorer',
            size: 'md',
            top: true,
            className: 'wallet-modal canton-explorer-modal',
            overlayClassName: 'wallet-modal-overlay canton-explorer-overlay',
            body: Array.from(content.childNodes),
            onClose: () => { if (explorer === dialog) explorer = null; }
        });
        const closeButton = dialog.header.querySelector('.close-circle-btn');
        closeButton.classList.add('wallet-modal-close');
        closeButton.setAttribute('data-close', '');
        explorer = dialog;
        const root = dialog.body;
        renderChips(root);

        root.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-party]');
            if (chip) return loadInto(root, chip.getAttribute('data-party'));
            if (e.target.closest('[data-load]')) {
                return loadInto(root, (root.querySelector('#canton-explorer-party').value || '').trim());
            }
            const acc = e.target.closest('.canton-explorer-accept');
            if (acc) {
                const cid = acc.getAttribute('data-cid');
                const bridge = global.CantonProposalChainBridge;
                if (!cid || !bridge || !bridge.acceptProposal || !viewParty) return;
                acc.disabled = true; acc.textContent = 'Accepting…';
                bridge.acceptProposal({ contractId: cid, owner: viewParty })
                    .then(() => { if (global.CantonCounts) global.CantonCounts.refresh(); return loadInto(root, viewParty); })
                    .catch((x) => { acc.disabled = false; acc.textContent = 'Accept'; const s = root.querySelector('[data-status]'); if (s) s.textContent = `Error: ${x.message}`; });
            }
        });
        root.querySelector('#canton-explorer-party')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') loadInto(root, (e.target.value || '').trim());
        });

        if (cur) loadInto(root, cur);
    }

    global.CantonExplorer = { open };
})(typeof window !== 'undefined' ? window : globalThis);
