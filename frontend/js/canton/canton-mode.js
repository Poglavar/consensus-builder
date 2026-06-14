// Canton "mode" — the wallet stand-in for the custodial Canton chain option.
// Canton has no browser wallet, so identity is a chosen *party*. This module owns
// the active flag + current acting party (persisted) and an identity picker.
// Routing in blockchain-proposals.js checks isActive() first; the network pill in
// user-management.js reflects/opens this. See feature-daml.md §13.
(function () {
    'use strict';

    const ACTIVE_KEY = 'canton.active';
    const PARTY_KEY = 'canton.party';
    const PARTIES_KEY = 'canton.parties'; // shared with canton-read.js (test parties)

    // Backend base URL — same precedence as canton-read.js.
    function apiBase() {
        try {
            const override = new URLSearchParams(window.location.search).get('api');
            if (override) return override.replace(/\/$/, '');
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

    const closePicker = () => { document.querySelector('.canton-id-overlay')?.remove(); };

    // The "connect wallet" equivalent: choose which party you act as.
    function openIdentityPicker() {
        closePicker();
        const cur = getParty();
        const list = partiesList();
        const overlay = document.createElement('div');
        overlay.className = 'wallet-modal-overlay canton-id-overlay';
        overlay.setAttribute('tabindex', '-1');
        overlay.innerHTML = `
            <div class="wallet-modal canton-id-modal" role="dialog" aria-modal="true">
                <div class="wallet-modal-header">
                    <h2>Canton identity</h2>
                    <button type="button" class="wallet-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close" data-close>&times;</button>
                </div>
                <div class="wallet-modal-body">
                    <div class="wallet-modal-description">Canton has no browser wallet — choose the party you act as.${cur ? ` Current: <b>${hint(cur)}</b>` : ''}</div>
                    <div class="wallet-options canton-id-list">
                        ${list.length ? list.map((p) => `
                            <button type="button" class="wallet-option canton-id-opt${p.party === cur ? ' chain-option--current' : ''}" data-party="${p.party}">
                                <div class="wallet-option-meta">
                                    <div class="wallet-option-name">${hint(p.party)}</div>
                                    <div class="wallet-option-origin">${p.role || 'party'}${p.parcelId ? ` · ${p.parcelId}` : ''}</div>
                                </div>
                            </button>`).join('') : '<p class="canton-empty">No parties yet — paste one or generate a test party.</p>'}
                    </div>
                    <div class="canton-id-row">
                        <input type="text" id="canton-id-paste" placeholder="paste party id (hint::fingerprint)" autocomplete="off" />
                        <button type="button" class="btn" data-use-paste>Use</button>
                        <button type="button" class="btn" data-gen>New test party</button>
                    </div>
                    <div class="canton-id-foot">
                        <button type="button" class="btn canton-ghost" data-switch>Use a different network</button>
                        <button type="button" class="btn canton-ghost" data-leave>Leave Canton</button>
                    </div>
                    <div class="canton-id-err" data-err></div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.focus({ preventScroll: true });
        const err = (m) => { const e = overlay.querySelector('[data-err]'); if (e) e.textContent = m; };

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('[data-close]')) return closePicker();
            const opt = e.target.closest('[data-party]');
            if (opt) { setParty(opt.getAttribute('data-party')); return closePicker(); }
            if (e.target.closest('[data-use-paste]')) {
                const v = (overlay.querySelector('#canton-id-paste').value || '').trim();
                if (v) { setParty(v); closePicker(); } else err('Enter a party id.');
                return;
            }
            const gen = e.target.closest('[data-gen]');
            if (gen) {
                gen.disabled = true; err('Allocating a test party…');
                generateParty().then((p) => { setParty(p); closePicker(); }).catch((x) => { err(x.message); gen.disabled = false; });
                return;
            }
            if (e.target.closest('[data-switch]')) { closePicker(); window.openChainSelectionModal && window.openChainSelectionModal(); return; }
            if (e.target.closest('[data-leave]')) { deactivate(); closePicker(); return; }
        });
    }

    window.CantonMode = { isActive, getParty, setParty, activate, deactivate, openIdentityPicker, hint };

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

            const res = await fetch(`${apiBase()}/canton/proposals`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parcelId, price, buyer }),
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
