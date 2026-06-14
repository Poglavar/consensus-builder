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

    // Where the project's real parcels live. In the full app they're same-origin
    // (apiBase() resolves them). Under dev-serve (:4000) the parcels API is the
    // separate Docker backend on :3000. Override with ?parcels=<url>.
    function parcelsBase() {
        try {
            const override = new URLSearchParams(window.location.search).get('parcels');
            if (override) return override.replace(/\/$/, '');
            const base = apiBase();
            if (base) return base; // file:// or prod host already points at the API
            const { protocol, hostname, port } = window.location;
            if (port && port !== '3000') return `${protocol}//${hostname}:3000`; // dev-serve -> Docker backend
        } catch (_) { }
        return ''; // same-origin
    }

    const short = (s) => (typeof s === 'string' && s.length > 24) ? `${s.slice(0, 10)}…${s.slice(-6)}` : (s || '');
    // A Canton party is `<hint>::<participant-namespace-fingerprint>`. The hint is
    // the unique name; the fingerprint is shared by every party on the participant.
    // So show the hint (identity) and only a short, muted slice of the fingerprint.
    function splitParty(party) {
        const i = String(party).indexOf('::');
        return i === -1 ? { hint: String(party), fp: '' } : { hint: String(party).slice(0, i), fp: String(party).slice(i + 2) };
    }
    const price = (p) => (p == null ? '' : String(p).replace(/0+$/, '').replace(/\.$/, ''));

    // view state
    let currentParty = '';
    let scenario = null;       // { lens, owner, buyer } from the last create
    let strangerParty = null;  // lazily-allocated non-stakeholder party

    // Persisted set of parties we've generated/used for testing. Survives reloads
    // so they can be reused as combobox suggestions and via the Test parties panel.
    const PARTY_KEY = 'canton.parties';
    const loadStoredParties = () => { try { return JSON.parse(localStorage.getItem(PARTY_KEY) || '[]'); } catch (_) { return []; } };
    const saveStoredParties = (list) => { try { localStorage.setItem(PARTY_KEY, JSON.stringify(list)); } catch (_) { } };
    function rememberParty(party, role, parcelId) {
        if (!party) return;
        const list = loadStoredParties();
        if (list.some((p) => p.party === party)) return; // first label wins
        list.unshift({ party, role: role || 'party', parcelId: parcelId || '', ts: Date.now() });
        saveStoredParties(list.slice(0, 50));
        renderParties();
    }
    const forgetParty = (party) => { saveStoredParties(loadStoredParties().filter((p) => p.party !== party)); renderParties(); };
    const clearParties = () => { saveStoredParties([]); renderParties(); };

    // Rebuild the shared combobox datalist + the Test parties panel from storage.
    function renderParties() {
        const list = loadStoredParties();
        const dl = document.getElementById('party-options');
        if (dl) dl.innerHTML = list.map((p) => `<option value="${p.party}">${p.role}${p.parcelId ? ` · ${p.parcelId}` : ''}</option>`).join('');
        const panel = document.getElementById('canton-parties-list');
        if (!panel) return;
        panel.innerHTML = list.length ? list.map((p) => {
            const { hint, fp } = splitParty(p.party);
            return `
            <div class="canton-party-row">
                <span class="canton-party-role">${p.role}</span>
                <span class="canton-party-id" title="${p.party}">${hint}</span>
                ${fp ? `<span class="canton-party-fp" title="participant namespace — shared by all parties">::${fp.slice(0, 6)}</span>` : ''}
                ${p.parcelId ? `<span class="canton-party-parcel">${p.parcelId}</span>` : ''}
                <span class="canton-party-actions">
                    <button class="canton-party-copy" data-copy="${p.party}" type="button" title="Copy full party id">Copy</button>
                    <button class="canton-party-ccview" data-ccview="${p.party}" type="button" title="Look up this party on the CCView explorer">CCView</button>
                    <button class="canton-party-view" data-view="${p.party}" type="button">View</button>
                    <button class="canton-party-del" data-del="${p.party}" type="button" title="Forget">×</button>
                </span>
                <div class="canton-ccview-out"></div>
            </div>`;
        }).join('')
            : `<p class="canton-empty">No test parties yet. Create a proposal or click "New test party".</p>`;
    }

    // Fetch a party's CCView explorer summary (via our server-side proxy, which
    // holds the API key) and render it inline under the row, with an explorer link.
    async function showCcview(party, btn) {
        const out = btn.closest('.canton-party-row')?.querySelector('.canton-ccview-out');
        if (!out) return;
        out.innerHTML = 'Looking up on CCView…';
        try {
            const d = await reqJson(`/canton/ccview/${encodeURIComponent(party)}`);
            const link = `<a href="${d.explorerUrl}" target="_blank" rel="noopener">open on CCView ↗</a>`;
            out.innerHTML = d.indexed
                ? `<span class="canton-ccview-data">CC balance: <b>${d.coinBalance ?? '—'}</b> · transfers: <b>${d.transfers ?? 0}</b></span> ${link}`
                : `<span class="canton-ccview-empty">Not yet indexed on CCView (no Canton Coin activity).</span> ${link}`;
        } catch (e) {
            out.innerHTML = `<span class="canton-ccview-empty">CCView error: ${e.message}</span>`;
        }
    }

    // Allocate a standalone test party (no proposal) and remember it.
    async function genTestParty() {
        const statusEl = document.getElementById('canton-status');
        try {
            const r = await post('/canton/parties', { hint: `Test-${Date.now().toString(36).slice(-5)}` });
            rememberParty(r.party, 'test', '');
            const input = document.getElementById('canton-party');
            if (input) input.value = r.party;
        } catch (e) {
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
        }
    }

    async function reqJson(path, opts) {
        const res = await fetch(`${apiBase()}${path}`, opts);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
    }
    const post = (path, payload) => reqJson(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });

    // Disable a button and show animated trailing dots (CSS, .is-busy) while its
    // async work runs, so it's obvious it's working and can't be double-clicked.
    async function runBusy(btn, fn) {
        if (btn && btn.disabled) return; // already in flight
        if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
        try { return await fn(); }
        finally { if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); } }
    }

    async function fetchProposals(party) { return (await reqJson(`/canton/proposals?party=${encodeURIComponent(party)}`)).proposals || []; }
    async function fetchSales(party) { return (await reqJson(`/canton/sales?party=${encodeURIComponent(party)}`)).sales || []; }
    const createProposal = (payload) => post('/canton/proposals', payload);
    const acceptProposal = (cid, owner) => post(`/canton/proposals/${encodeURIComponent(cid)}/accept`, { owner });

    function cardHtml(it, kind) {
        const canAccept = kind === 'proposals' && it.owner && it.owner === currentParty;
        // Which role the loaded party plays in this contract (it can be more than one).
        const roles = ['buyer', 'owner', 'lens'].filter((r) => it[r] && it[r] === currentParty);
        const youTag = roles.length ? `<span class="canton-you">you: ${roles.join(', ')}</span>` : '';
        return `
            <div class="canton-card">
                <div class="canton-card-top">
                    <span class="canton-parcel">${it.parcelId || '—'}</span>
                    ${youTag}
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
            rememberParty(party, 'seen', '');
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
            rememberParty(r.owner, 'owner', r.parcelId);
            rememberParty(r.buyer, 'buyer', r.parcelId);
            rememberParty(r.lens, 'lens', r.parcelId);
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
            if (!strangerParty) { strangerParty = (await post('/canton/parties', { hint: `Stranger-${Date.now()}` })).party; rememberParty(strangerParty, 'stranger', ''); }
            const partyInput = document.getElementById('canton-party');
            if (partyInput) partyInput.value = strangerParty;
            await load(strangerParty);
        } catch (e) {
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
        }
    }

    // Pull a small sample of real NYC parcels into the create-proposal dropdown.
    // A tiny bbox + limit keeps it light (the dataset has thousands of parcels).
    async function populateParcels() {
        const sel = document.getElementById('create-parcel');
        if (!sel) return;
        const bbox = '-74.012,40.706,-74.006,40.712'; // Lower Manhattan (NYSE area) sample
        try {
            const res = await fetch(`${parcelsBase()}/parcel-nyc?bbox=${encodeURIComponent(bbox)}&limit=12`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const fc = await res.json();
            const parcels = (fc.features || []).map((f) => f.properties || {}).filter((p) => p.parcelId);
            if (!parcels.length) throw new Error('no parcels returned');
            sel.innerHTML = parcels.map((p) => {
                const mp = p.estimatedMarketPrice != null ? Number(p.estimatedMarketPrice).toFixed(2) : '';
                const owner = (p.ownershipList && p.ownershipList[0] && p.ownershipList[0].ownerLabel) || '';
                const tag = [owner.slice(0, 22), mp && `$${Math.round(mp).toLocaleString()}`].filter(Boolean).join(' · ');
                return `<option value="${p.parcelId}" data-price="${mp}">${p.parcelId}${tag ? ` — ${tag}` : ''}</option>`;
            }).join('');
            syncPriceFromParcel();
            sel.addEventListener('change', syncPriceFromParcel);
        } catch (e) {
            // Parcels API unreachable (e.g. Docker backend down) — keep the form usable.
            sel.innerHTML = `<option value="PARCEL-1">PARCEL-1 (parcels API unavailable: ${e.message})</option>`;
        }
    }

    // Mirror the selected parcel's market value into the Price field (still editable).
    function syncPriceFromParcel() {
        const sel = document.getElementById('create-parcel');
        const priceEl = document.getElementById('create-price');
        if (!sel || !priceEl) return;
        const opt = sel.options[sel.selectedIndex];
        const p = opt && opt.getAttribute('data-price');
        if (p) priceEl.value = p;
    }

    function init() {
        const input = document.getElementById('canton-party');
        populateParcels();
        renderParties();
        const fromQuery = new URLSearchParams(window.location.search).get('party');
        if (fromQuery && input) input.value = fromQuery;

        const loadBtn = document.getElementById('canton-load');
        loadBtn?.addEventListener('click', () => runBusy(loadBtn, () => load(input ? input.value.trim() : '')));
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runBusy(loadBtn, () => load(input.value.trim())); });
        const createBtn = document.getElementById('create-btn');
        createBtn?.addEventListener('click', () => runBusy(createBtn, submitCreate));
        const genBtn = document.getElementById('gen-party-btn');
        genBtn?.addEventListener('click', () => runBusy(genBtn, genTestParty));
        document.getElementById('clear-parties-btn')?.addEventListener('click', clearParties);

        // delegated: Test parties panel (Copy id, View loads the party, × forgets it)
        document.getElementById('canton-parties-list')?.addEventListener('click', (e) => {
            const copy = e.target.closest('[data-copy]');
            if (copy) {
                const id = copy.getAttribute('data-copy');
                navigator.clipboard?.writeText(id);
                const statusEl = document.getElementById('canton-status');
                if (statusEl) statusEl.textContent = `Copied party id: ${splitParty(id).hint}`;
                return;
            }
            const cc = e.target.closest('[data-ccview]');
            if (cc) return runBusy(cc, () => showCcview(cc.getAttribute('data-ccview'), cc));
            const view = e.target.closest('[data-view]');
            if (view) { const p = view.getAttribute('data-view'); if (input) input.value = p; return runBusy(view, () => load(p)); }
            const del = e.target.closest('[data-del]');
            if (del) return forgetParty(del.getAttribute('data-del'));
        });

        // delegated: Accept buttons inside the proposals list
        document.getElementById('canton-proposals')?.addEventListener('click', (e) => {
            const b = e.target.closest('.canton-accept');
            if (b) runBusy(b, () => doAccept(b.getAttribute('data-cid')));
        });
        // delegated: perspective switcher
        document.getElementById('canton-perspective')?.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            if (b.hasAttribute('data-stranger')) return runBusy(b, viewStranger);
            const p = b.getAttribute('data-party');
            if (p) { if (input) input.value = p; runBusy(b, () => load(p)); }
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
