// Canton chain option — read + write view. Lists a party's proposals/sales,
// creates proposals, lets the owner Accept, and offers a party-perspective
// switcher (Buyer / Owner / Lens / Stranger) to show Canton's per-party
// visibility. The OIDC secret stays server-side; this only calls /canton/*.
(function () {
    'use strict';

    // Backend base URL. Precedence: ?api= override → file:// dev (localhost:3000)
    // → production frontend host (api.urbangametheory.xyz) → same origin.
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

    // view state
    let currentParty = '';
    let scenario = null;       // { lens, owner, buyer } from the last create
    let strangerParty = null;  // lazily-allocated non-stakeholder party

    async function reqJson(path, opts) {
        const res = await fetch(`${apiBase()}${path}`, opts);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
    }
    const post = (path, payload) => reqJson(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });

    async function fetchProposals(party) { return (await reqJson(`/canton/proposals?party=${encodeURIComponent(party)}`)).proposals || []; }
    async function fetchSales(party) { return (await reqJson(`/canton/sales?party=${encodeURIComponent(party)}`)).sales || []; }
    const createProposal = (payload) => post('/canton/proposals', payload);
    const acceptProposal = (cid, owner) => post(`/canton/proposals/${encodeURIComponent(cid)}/accept`, { owner });

    function cardHtml(it, kind) {
        const canAccept = kind === 'proposals' && it.owner && it.owner === currentParty;
        return `
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
                ${canAccept ? `<button class="canton-accept" data-cid="${it.contractId}">Accept</button>` : ''}
            </div>`;
    }
    const listHtml = (items, kind) => items.length ? items.map((it) => cardHtml(it, kind)).join('') : `<p class="canton-empty">No ${kind}.</p>`;

    function renderPerspective() {
        const el = document.getElementById('canton-perspective');
        if (!el) return;
        if (!scenario) { el.innerHTML = ''; return; }
        const btn = (label, party, extra = '') =>
            `<button class="canton-persp${party && party === currentParty ? ' active' : ''}" ${extra} ${party ? `data-party="${party}"` : ''}>${label}</button>`;
        el.innerHTML = `<span class="canton-persp-label">View as:</span>`
            + btn('Buyer', scenario.buyer) + btn('Owner', scenario.owner) + btn('Lens', scenario.lens)
            + `<button class="canton-persp${strangerParty && strangerParty === currentParty ? ' active' : ''}" data-stranger="1">Stranger</button>`;
    }

    async function load(party) {
        const propEl = document.getElementById('canton-proposals');
        const saleEl = document.getElementById('canton-sales');
        const statusEl = document.getElementById('canton-status');
        currentParty = party || '';
        if (!party) { if (statusEl) statusEl.textContent = 'Enter a party ID.'; return; }
        if (statusEl) statusEl.textContent = 'Loading…';
        try {
            const [proposals, sales] = await Promise.all([fetchProposals(party), fetchSales(party)]);
            if (propEl) propEl.innerHTML = listHtml(proposals, 'proposals');
            if (saleEl) saleEl.innerHTML = listHtml(sales, 'sales');
            if (statusEl) statusEl.textContent = `${proposals.length} proposal(s), ${sales.length} sale(s)`;
        } catch (e) {
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
        }
        renderPerspective();
    }

    async function submitCreate() {
        const get = (id) => (document.getElementById(id)?.value || '').trim();
        const resultEl = document.getElementById('create-result');
        const partyInput = document.getElementById('canton-party');
        if (resultEl) resultEl.textContent = 'Creating…';
        try {
            const r = await createProposal({
                parcelId: get('create-parcel'), price: get('create-price'),
                buyer: get('create-buyer') || undefined, owner: get('create-owner') || undefined, lens: get('create-lens') || undefined,
            });
            scenario = { lens: r.lens, owner: r.owner, buyer: r.buyer };
            strangerParty = null;
            if (resultEl) resultEl.textContent = `Created ${short(r.proposalContractId)} for ${r.parcelId}. Try the perspective switcher.`;
            if (partyInput) partyInput.value = r.owner;
            await load(r.owner);
        } catch (e) {
            if (resultEl) resultEl.textContent = `Error: ${e.message}`;
        }
    }

    async function doAccept(cid) {
        const statusEl = document.getElementById('canton-status');
        if (statusEl) statusEl.textContent = 'Accepting…';
        try {
            await acceptProposal(cid, currentParty);
            await load(currentParty); // proposal now archived; sale appears
        } catch (e) {
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
        }
    }

    async function viewStranger() {
        const statusEl = document.getElementById('canton-status');
        try {
            if (!strangerParty) strangerParty = (await post('/canton/parties', { hint: `Stranger-${Date.now()}` })).party;
            const partyInput = document.getElementById('canton-party');
            if (partyInput) partyInput.value = strangerParty;
            await load(strangerParty);
        } catch (e) {
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
        }
    }

    function init() {
        const input = document.getElementById('canton-party');
        const fromQuery = new URLSearchParams(window.location.search).get('party');
        if (fromQuery && input) input.value = fromQuery;

        document.getElementById('canton-load')?.addEventListener('click', () => load(input ? input.value.trim() : ''));
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(input.value.trim()); });
        document.getElementById('create-btn')?.addEventListener('click', submitCreate);

        // delegated: Accept buttons inside the proposals list
        document.getElementById('canton-proposals')?.addEventListener('click', (e) => {
            const b = e.target.closest('.canton-accept');
            if (b) doAccept(b.getAttribute('data-cid'));
        });
        // delegated: perspective switcher
        document.getElementById('canton-perspective')?.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            if (b.hasAttribute('data-stranger')) return viewStranger();
            const p = b.getAttribute('data-party');
            if (p) { if (input) input.value = p; load(p); }
        });

        if (fromQuery) load(fromQuery);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    window.CantonRead = { fetchProposals, fetchSales, createProposal, acceptProposal, load };
})();
