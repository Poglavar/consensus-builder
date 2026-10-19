// Canton "mode" — the wallet stand-in for the custodial Canton chain option.
// Canton has no browser wallet, so identity is a chosen *party*. This module owns
// the active flag + current acting party (persisted) and an identity picker.
// Routing in blockchain-proposals.js checks isActive() first; the network pill in
// user-management.js reflects/opens this. See feature-daml.md §13.
(function () {
    'use strict';
    // Canton is switched off (environment.js CANTON_ENABLED): define nothing, request nothing.
    if (window.CANTON_ENABLED !== true) return;

    const ACTIVE_KEY = 'canton.active';
    const PARTY_KEY = 'canton.party';
    const PARTIES_KEY = 'canton.parties'; // shared with canton-read.js (test parties)

    // Backend base URL — same precedence as canton-read.js.
    // The backend base. data-source.js already resolves this for every environment — including the
    // `?backend=` override that dev.sh passes so a worktree talks to its own backend — so defer to it.
    // Rolling our own here is how Canton ended up unreachable in dev: same-origin meant the static
    // frontend port, which serves no /canton routes.
    function apiBase() {
        try {
            const override = new URLSearchParams(window.location.search).get('api');
            if (override) return override.replace(/\/$/, '');
        } catch (_) { }
        try {
            if (typeof window.getBackendBase === 'function') {
                const base = window.getBackendBase();
                if (base) return String(base).replace(/\/+$/, '');
            }
        } catch (_) { }
        // Standalone pages (canton.html) may not load data-source.js.
        try {
            if (window.location.protocol === 'file:') return 'http://localhost:3000';
            const h = (window.location.hostname || '').toLowerCase();
            if (h.endsWith('urbangametheory.xyz') && !h.startsWith('api.')) return 'https://api.urbangametheory.xyz';
        } catch (_) { }
        return ''; // same-origin
    }

    const get = (k) => { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } };
    const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { } };
    const del = (k) => { try { localStorage.removeItem(k); } catch (_) { } };
    const partiesList = () => { try { return JSON.parse(localStorage.getItem(PARTIES_KEY) || '[]'); } catch (_) { return []; } };
    function rememberParty(party, role) {
        if (!party) return;
        const list = partiesList();
        if (list.some((p) => p.party === party)) return;
        list.unshift({ party, role: role || 'identity', parcelId: '', ts: Date.now() });
        set(PARTIES_KEY, JSON.stringify(list.slice(0, 50)));
    }
    function forgetParty(party) { set(PARTIES_KEY, JSON.stringify(partiesList().filter((p) => p.party !== party))); }
    function clearParties() { del(PARTIES_KEY); }

    // CCView explorer summary for a party (server-proxied; key stays server-side).
    async function ccviewParty(party) {
        const res = await fetch(`${apiBase()}/canton/ccview/${encodeURIComponent(party)}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        return j;
    }

    const hint = (p) => (typeof p === 'string' && p.indexOf('::') !== -1) ? p.slice(0, p.indexOf('::')) : (p || '');

    const isActive = () => get(ACTIVE_KEY) === '1';
    const getParty = () => get(PARTY_KEY);
    function setParty(p) { if (p) { set(PARTY_KEY, p); rememberParty(p, 'identity'); } else del(PARTY_KEY); refreshUi(); }
    function activate() { set(ACTIVE_KEY, '1'); refreshUi(); }
    function deactivate() { del(ACTIVE_KEY); refreshUi(); }
    function refreshUi() { try { window.updateWalletButtonDisplay && window.updateWalletButtonDisplay(); } catch (_) { } }

    async function generateParty() {
        const res = await fetch(`${apiBase()}/canton/parties`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hint: `Id-${Date.now().toString(36).slice(-5)}` }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        rememberParty(j.party, 'identity');
        return j.party;
    }

    // The open identity picker (a CbDialog handle), so a pick or a second open can close it.
    let picker = null;
    const closePicker = () => { if (picker) picker.close(); };

    // The "connect wallet" equivalent: choose which party you act as. Also folds in
    // the canton.html tooling — per-party Copy / CCView / Forget, and Clear all.
    // A party is a cb-option row (aria-current marks the acting one) with its small buttons beside it.
    function partyRowsHtml(cur) {
        const list = partiesList();
        if (!list.length) return '<p class="canton-empty">No parties yet — paste one or generate a test party.</p>';
        return list.map((p) => `
            <div class="canton-id-row2">
                <button type="button" class="cb-option canton-id-pick" data-party-select="${p.party}" title="Use this identity"${p.party === cur ? ' aria-current="true"' : ''}>
                    <span class="cb-option__text">
                        <span class="cb-option__title canton-id-name">${hint(p.party)}</span>
                        <span class="cb-option__desc">${p.role || 'party'}${p.parcelId ? ` · ${p.parcelId}` : ''}</span>
                    </span>
                </button>
                <span class="canton-id-acts">
                    <button type="button" class="btn btn-sm" data-copy="${p.party}" title="Copy full party id">Copy</button>
                    <button type="button" class="btn btn-sm" data-ccview="${p.party}" title="Canton Coin balance / explorer">CCView</button>
                    <button type="button" class="btn btn-sm btn-quiet btn-icon" data-forget="${p.party}" title="Forget" aria-label="Forget"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                </span>
                <div class="canton-ccview-out"></div>
            </div>`).join('');
    }

    // The shared dialog (CbDialog) on the upper rung: it opens from the agent dialog's network chip
    // or from the network choice. wallet-modal / wallet-modal-overlay / canton-id-* and the data-*
    // attributes are hooks for scripts and the e2e specs, not looks.
    function openIdentityPicker() {
        closePicker();
        const cur = getParty();
        const content = document.createElement('div');
        content.innerHTML = `
            <p class="wallet-modal-description">Canton has no browser wallet — choose the party you act as.${cur ? ` Current: <b>${hint(cur)}</b>` : ''}</p>
            <div class="canton-id-list" data-list>${partyRowsHtml(cur)}</div>
            <div class="canton-id-row">
                <input type="text" id="canton-id-paste" placeholder="paste party id (hint::fingerprint)" aria-label="Party id" autocomplete="off" />
                <button type="button" class="btn btn-sm" data-use-paste>Use</button>
                <button type="button" class="btn btn-sm" data-gen>New test party</button>
                <button type="button" class="btn btn-sm btn-quiet" data-clear>Clear</button>
            </div>
            <div class="cb-actions canton-id-foot">
                <button type="button" class="btn btn-sm" data-explorer>Canton state explorer</button>
                <button type="button" class="btn btn-sm" data-switch>Use a different network</button>
                <button type="button" class="btn btn-sm" data-leave>Leave Canton</button>
            </div>
            <div class="canton-id-err" data-err role="status" aria-live="polite"></div>`;
        const dialog = window.CbDialog.open({
            title: 'Canton identity',
            size: 'md',
            top: true,
            className: 'wallet-modal canton-id-modal',
            overlayClassName: 'wallet-modal-overlay canton-id-overlay',
            body: Array.from(content.childNodes),
            onClose: () => { if (picker === dialog) picker = null; }
        });
        const closeButton = dialog.header.querySelector('.close-circle-btn');
        closeButton.classList.add('wallet-modal-close');
        closeButton.setAttribute('data-close', '');
        picker = dialog;
        const root = dialog.body;
        const err = (m) => { const e = root.querySelector('[data-err]'); if (e) e.textContent = m; };
        const redrawList = () => { const l = root.querySelector('[data-list]'); if (l) l.innerHTML = partyRowsHtml(getParty()); };

        root.addEventListener('click', (e) => {
            const copy = e.target.closest('[data-copy]');
            if (copy) { try { navigator.clipboard.writeText(copy.getAttribute('data-copy')); err('Copied party id.'); } catch (_) { } return; }

            const cc = e.target.closest('[data-ccview]');
            if (cc) {
                const out = cc.closest('.canton-id-row2')?.querySelector('.canton-ccview-out');
                if (out) out.textContent = 'Looking up on CCView…';
                ccviewParty(cc.getAttribute('data-ccview')).then((d) => {
                    if (!out) return;
                    const link = `<a class="cb-link cb-link--external" href="${d.explorerUrl}" target="_blank" rel="noopener noreferrer">open on CCView</a>`;
                    out.innerHTML = d.indexed
                        ? `CC balance: <b>${d.coinBalance ?? '—'}</b> · transfers: <b>${d.transfers ?? 0}</b> ${link}`
                        : `Not yet indexed (no Canton Coin activity). ${link}`;
                }).catch((x) => { if (out) out.textContent = `CCView error: ${x.message}`; });
                return;
            }

            const forget = e.target.closest('[data-forget]');
            if (forget) { forgetParty(forget.getAttribute('data-forget')); redrawList(); return; }

            const pick = e.target.closest('[data-party-select]');
            if (pick) { setParty(pick.getAttribute('data-party-select')); return closePicker(); }

            if (e.target.closest('[data-use-paste]')) {
                const v = (root.querySelector('#canton-id-paste').value || '').trim();
                if (v) { setParty(v); closePicker(); } else err('Enter a party id.');
                return;
            }
            const gen = e.target.closest('[data-gen]');
            if (gen) {
                gen.disabled = true; err('Allocating a test party…');
                generateParty().then((p) => { setParty(p); closePicker(); }).catch((x) => { err(x.message); gen.disabled = false; });
                return;
            }
            if (e.target.closest('[data-clear]')) { clearParties(); redrawList(); return; }
            if (e.target.closest('[data-explorer]')) {
                // Open the in-app Canton state explorer dialog (native styling).
                // Falls back to the standalone canton.html page if not loaded.
                closePicker();
                if (window.CantonExplorer && window.CantonExplorer.open) { window.CantonExplorer.open(); return; }
                const p = getParty();
                window.open('canton.html' + (p ? `?party=${encodeURIComponent(p)}` : ''), '_blank', 'noopener');
                return;
            }
            if (e.target.closest('[data-switch]')) { closePicker(); window.openChainSelectionModal && window.openChainSelectionModal(); return; }
            if (e.target.closest('[data-leave]')) { deactivate(); closePicker(); return; }
        });
    }

    // True if a stored/local proposal object is actually a Canton proposal (it gets
    // a local copy from the create flow). Used to keep Canton proposals out of the
    // EVM count/list so they aren't double-counted alongside the purple Canton badge.
    function isCantonProposal(p) {
        const c = (p && ((p.onchain && p.onchain.chainId) || (p.nft && p.nft.chain))) || '';
        return String(c).toLowerCase().startsWith('canton');
    }

    window.CantonMode = { isActive, getParty, setParty, activate, deactivate, openIdentityPicker, hint, isCantonProposal };

    // Routing bridge. mintProposal creates a Canton proposal via the backend
    // (P2). Accept is wired in P3. Shapes mirror the EVM/Solana bridges so the
    // existing create flow consumes the result unchanged.
    window.CantonProposalChainBridge = {
        isSupported: () => true,
        // options: { parcelIds: [string], price: number, imageURI?: string }
        mintProposal: async (options = {}) => {
            const buyer = getParty();
            if (!buyer) throw new Error('Pick a Canton identity first (network pill → Canton).');
            const ids = options.parcelIds || [];
            const parcelId = Array.isArray(ids) ? ids[0] : ids;
            if (!parcelId) throw new Error('Canton proposal needs a parcel.');
            const price = String(options.price != null ? options.price : '');
            if (!(parseFloat(price) > 0)) throw new Error('Canton purchase proposals need a positive offer amount.');

            // The IPFS metadata the create flow uploads for every chain. It used to be accepted here
            // and dropped at the fetch, so Canton paid for an upload nothing ever read.
            const imageUri = options.imageURI || null;

            const res = await fetch(`${apiBase()}/canton/proposals`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parcelId, price, buyer, imageUri }),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
            // Remember the auto-allocated owner/lens so they can be picked as
            // identities (e.g. to Accept as the owner in P3), and refresh map counts.
            rememberParty(j.owner, 'owner'); rememberParty(j.lens, 'lens');
            try { window.CantonCounts && window.CantonCounts.refresh(); } catch (_) { }

            return {
                transactionHash: j.proposalContractId || 'canton',
                proposalId: j.proposalContractId || null,
                chainId: 'canton-devnet',
                contractAddress: 'canton',
                explorerUrl: '',
            };
        },
        // options: { contractId, owner? } — owner defaults to the current identity.
        acceptProposal: async (options = {}) => {
            const cid = options.contractId || options.cid || options.proposalContractId;
            const owner = options.owner || getParty();
            if (!cid) throw new Error('Canton accept: missing proposal contractId.');
            if (!owner) throw new Error('Pick the owner identity before accepting.');
            const res = await fetch(`${apiBase()}/canton/proposals/${encodeURIComponent(cid)}/accept`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ owner }),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
            try { window.CantonCounts && window.CantonCounts.refresh(); } catch (_) { }
            return j;
        },
        contributeToProposal: async () => { throw new Error('Canton contributions are not supported.'); },
        withdrawAcceptance: async () => { throw new Error('Canton withdrawal is coming later — not wired yet.'); },
    };
})();
