// Owner offers: an attested owner mints a proposal on its own land and invites bids, which arrive as
// proposal_pledge pledges and donations. The pure half (mode gate, bid ranking) has no DOM and is
// exported via CommonJS for node tests; the DOM half mounts the Details "Bids" card after the support
// card and points the owner at the lens card's Say yes rather than duplicating it.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OwnerOffer = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    const OWNER_OFFER_ROLE = 'owner-offer';
    // proposal_pledge PledgeCommitment.status: 0 active, 1 fulfilled, 2 revoked, 3 voided.
    const PLEDGE_STATUS_ACTIVE = 0;
    const PLEDGE_STATUS_FULFILLED = 1;

    function isOwnerOffer(proposal) {
        return !!(proposal && proposal.proposalRole === OWNER_OFFER_ROLE);
    }

    function toAtomic(value) {
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
        if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
        return null;
    }

    // The mode gate. results: [{ memberKey, parcelUid, attestations: [...] | null }] from asking each
    // lens member's service GET /lens/attestations?parcelUid=&owner=. A parcel counts as the wallet's
    // only on an unexpired ownership attestation naming this parcel and this owner, signed by the
    // member that was asked, and that member is in the chosen lens. A null list (service not asked or
    // down) proves nothing. Eligible = at least one selected parcel attested; submittable = all.
    function ownerOfferEligibility({ parcelIds = [], results = [], owner = null, lensKeys = [], nowSeconds } = {}) {
        const now = typeof nowSeconds === 'number' && Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
        const selected = Array.from(new Set((parcelIds || []).map(String)));
        const lens = new Set((lensKeys || []).map(String));
        const attestedBy = {};
        if (owner) {
            for (const result of results || []) {
                if (!result || !lens.has(String(result.memberKey)) || !Array.isArray(result.attestations)) continue;
                const parcelUid = String(result.parcelUid);
                if (!selected.includes(parcelUid)) continue;
                const match = result.attestations.some(att => att
                    && (att.kind === undefined || att.kind === null || att.kind === '' || att.kind === 'ownership')
                    && att.parcelUid === parcelUid
                    && att.owner === owner
                    && (!att.authority || att.authority === result.memberKey)
                    && !(typeof att.expiry === 'number' && att.expiry > 0 && att.expiry <= now));
                if (!match) continue;
                const members = attestedBy[parcelUid] || (attestedBy[parcelUid] = []);
                if (!members.includes(result.memberKey)) members.push(result.memberKey);
            }
        }
        const attestedParcelIds = selected.filter(id => attestedBy[id]);
        const unattestedParcelIds = selected.filter(id => !attestedBy[id]);
        return {
            eligible: attestedParcelIds.length > 0,
            submittable: selected.length > 0 && unattestedParcelIds.length === 0,
            attestedParcelIds,
            unattestedParcelIds,
            attestedBy
        };
    }

    // Bids = active or fulfilled pledges plus unrefunded donations, each one on-chain account.
    // Highest amount first; ties go to the earlier bid (a null time sorts after a known one), then
    // wallet and account for a stable order. Amounts stay atomic BigInts; total is their sum.
    function rankBids({ pledges = [], donations = [] } = {}) {
        const bids = [];
        for (const row of pledges || []) {
            const amount = row ? toAtomic(row.amount) : null;
            if (amount === null || amount <= 0n) continue;
            if (row.status !== PLEDGE_STATUS_ACTIVE && row.status !== PLEDGE_STATUS_FULFILLED) continue;
            bids.push({ kind: 'pledge', wallet: row.owner || null, amount, time: typeof row.time === 'number' ? row.time : null,
                address: row.address || null, signature: row.signature || null, fulfilled: row.status === PLEDGE_STATUS_FULFILLED });
        }
        for (const row of donations || []) {
            const amount = row ? toAtomic(row.amount) : null;
            if (amount === null || amount <= 0n || row.refunded) continue;
            bids.push({ kind: 'donation', wallet: row.owner || null, amount, time: typeof row.time === 'number' ? row.time : null,
                address: row.address || null, signature: row.signature || null, fulfilled: false });
        }
        bids.sort((a, b) => {
            if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
            if (a.time !== b.time) {
                if (a.time === null) return 1;
                if (b.time === null) return -1;
                return a.time - b.time;
            }
            return String(a.wallet || '').localeCompare(String(b.wallet || ''))
                || String(a.address || '').localeCompare(String(b.address || ''));
        });
        const total = bids.reduce((sum, bid) => sum + bid.amount, 0n);
        const bidders = new Set(bids.map(bid => bid.wallet).filter(Boolean));
        return { bids: bids.map((bid, index) => ({ ...bid, rank: index + 1 })), total, bidderCount: bidders.size };
    }

    function explorerLink({ signature = null, address = null, cluster = 'devnet' } = {}) {
        const suffix = `?cluster=${encodeURIComponent(cluster || 'devnet')}`;
        if (signature) return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${suffix}`;
        if (address) return `https://explorer.solana.com/address/${encodeURIComponent(address)}${suffix}`;
        return null;
    }

    // ---- DOM half: the Details bids card. Everything below needs a browser window. ----

    function t(key, fallback, params = {}) {
        const api = root && root.i18n;
        if (api && typeof api.t === 'function') {
            const value = api.t(key, params);
            if (value && value !== key) return value;
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
    }

    function escapeText(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function log(level, message, extra) {
        const line = `[${new Date().toISOString()}] [OwnerOfferBids] ${message}`;
        if (extra === undefined) console[level](line); else console[level](line, extra);
    }

    function shortKey(key) {
        const text = String(key || '');
        return text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
    }

    function currentWallet() {
        const state = root && root.solanaWalletManager && root.solanaWalletManager.getState ? root.solanaWalletManager.getState() : null;
        return state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length ? String(state.accounts[0]) : null;
    }

    function currentCluster() {
        return (root && root.solanaWalletManager && root.solanaWalletManager.getCluster && root.solanaWalletManager.getCluster()) || 'devnet';
    }

    // The newest signature touching an account: when its current amount was set. blockTime is the
    // chain's own time for that transaction; null when the RPC does not report one.
    async function lastActivity(connection, pubkey) {
        try {
            const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 1 });
            const latest = signatures && signatures[0];
            return latest ? { signature: latest.signature || null, time: typeof latest.blockTime === 'number' ? latest.blockTime : null } : { signature: null, time: null };
        } catch (error) {
            log('warn', `signatures for ${pubkey.toBase58()} unavailable`, error);
            return { signature: null, time: null };
        }
    }

    async function readBidAccounts(proposalAccount) {
        if (!root.solanaWeb3 || !root.solanaWeb3.PublicKey) {
            if (typeof root.ensureWalletVendors === 'function') await root.ensureWalletVendors();
        }
        const web3 = root.solanaWeb3;
        const client = root.SolanaPledgeClient;
        if (!web3 || !web3.PublicKey) throw new Error('Solana web3.js is unavailable');
        if (!client) throw new Error('Proposal support client is unavailable');
        if (!root.SolanaChainDataLoader || !root.SolanaChainDataLoader.getConnection) throw new Error('Solana connection is unavailable');
        const connection = root.SolanaChainDataLoader.getConnection(currentCluster());
        const programId = new web3.PublicKey(client.constants.PROGRAM_ID);
        const [book] = client.getPledgeBookPda(proposalAccount);
        const [escrow] = client.getDonationEscrowPda(proposalAccount);
        const [pledgeRows, donationRows, proposalInfo] = await Promise.all([
            connection.getProgramAccounts(programId, { filters: [
                { dataSize: client.PLEDGE_COMMITMENT_SIZE }, { memcmp: { offset: 8, bytes: book.toBase58() } }] }),
            connection.getProgramAccounts(programId, { filters: [
                { dataSize: client.DONATION_POSITION_SIZE }, { memcmp: { offset: 8, bytes: escrow.toBase58() } }] }),
            connection.getAccountInfo(new web3.PublicKey(proposalAccount))
        ]);
        const decode = (rows, decoder) => rows.map(row => ({ pubkey: row.pubkey, ...decoder(row.account.data) }));
        const pledges = decode(pledgeRows, client.decodePledgeCommitment);
        const donations = decode(donationRows, client.decodeDonationPosition);
        const withTime = async rows => Promise.all(rows.map(async row => {
            const activity = await lastActivity(connection, row.pubkey);
            return { ...row, address: row.pubkey.toBase58(), ...activity };
        }));
        const parsed = proposalInfo && proposalInfo.data && root.SolanaChainDataLoader.parseProposalAccount
            ? root.SolanaChainDataLoader.parseProposalAccount(proposalInfo.data, String(proposalAccount)) : null;
        return {
            pledges: await withTime(pledges),
            donations: await withTime(donations),
            ownerWallet: parsed && parsed.owner ? String(parsed.owner) : null
        };
    }

    function formatUsdc(amount) {
        try {
            return CbFormat.formatMoney(Number(root.SolanaPledgeClient.formatUsdc(amount)), 'USDC');
        } catch (_) {
            return `${String(amount)} µUSDC`;
        }
    }

    function formatTime(seconds) {
        const unknown = t('panel.proposal.ownerOffer.unknownTime', 'time unknown');
        if (typeof seconds !== 'number') return unknown;
        return CbFormat.formatDateTime(seconds * 1000, { missing: unknown });
    }

    function scrollToLensCard(proposalAccount) {
        const card = document.querySelector(`.proposal-lens-card[data-proposal-lens-card="${CSS.escape(String(proposalAccount))}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const firstYes = card.querySelector('[data-lens-say-yes]');
        if (firstYes && typeof firstYes.focus === 'function') firstYes.focus({ preventScroll: true });
    }

    function renderShell() {
        return `
            <div class="proposal-funding-head">
                <div>
                    <div class="proposal-funding-eyebrow">${escapeText(t('panel.proposal.ownerOffer.eyebrow', 'Owner offer'))}</div>
                    <h3>${escapeText(t('panel.proposal.ownerOffer.title', 'Bids'))}</h3>
                </div>
                <span class="proposal-funding-state" data-bids="total">${escapeText(t('panel.proposal.ownerOffer.loading', 'Loading bids…'))}</span>
            </div>
            <p class="proposal-bids-explainer">${escapeText(t('panel.proposal.ownerOffer.explainer', 'The owner of this land invites bids. Bids are the pledges and donations above; the owner executes the offer by saying yes.'))}</p>
            <div data-bids="owner"></div>
            <ol class="proposal-bids-list" data-bids="list" aria-live="polite"></ol>`;
    }

    function renderBids(section, { ranked, ownerWallet, proposalAccount, cluster }) {
        const totalNode = section.querySelector('[data-bids="total"]');
        if (totalNode) {
            totalNode.textContent = t('panel.proposal.ownerOffer.total', 'Total bid {{amount}} · {{count}} bidder(s)',
                { amount: formatUsdc(ranked.total), count: ranked.bidderCount });
        }
        const ownerNode = section.querySelector('[data-bids="owner"]');
        const wallet = currentWallet();
        if (ownerNode) {
            if (ownerWallet && wallet && wallet === ownerWallet) {
                ownerNode.innerHTML = `
                    <div class="proposal-bids-owner">
                        <a href="#" class="btn btn-action proposal-bids-say-yes" data-bids-say-yes>${escapeText(t('panel.proposal.ownerOffer.sayYes', 'Say yes to execute'))}</a>
                        <small>${escapeText(t('panel.proposal.ownerOffer.ownerHint', 'You own this offer. Saying yes on each of your parcels in the lens card executes it and releases the donations to you.'))}</small>
                    </div>`;
                const link = ownerNode.querySelector('[data-bids-say-yes]');
                link.addEventListener('click', event => {
                    event.preventDefault();
                    scrollToLensCard(proposalAccount);
                });
            } else {
                ownerNode.innerHTML = '';
            }
        }
        const list = section.querySelector('[data-bids="list"]');
        if (!list) return;
        if (!ranked.bids.length) {
            list.innerHTML = `<li class="proposal-bids-empty">${escapeText(t('panel.proposal.ownerOffer.empty', 'No bids yet. Pledge or donate above to bid.'))}</li>`;
            return;
        }
        list.innerHTML = ranked.bids.map(bid => {
            const kindLabel = bid.kind === 'pledge'
                ? (bid.fulfilled ? t('panel.proposal.ownerOffer.pledgeFulfilled', 'Pledge · fulfilled') : t('panel.proposal.ownerOffer.pledge', 'Pledge'))
                : t('panel.proposal.ownerOffer.donation', 'Donation');
            const walletUrl = explorerLink({ address: bid.wallet, cluster });
            const txUrl = explorerLink({ signature: bid.signature, address: bid.address, cluster });
            return `
                <li class="proposal-bids-row${wallet && bid.wallet === wallet ? ' is-mine' : ''}">
                    <span class="proposal-bids-rank">#${bid.rank}</span>
                    <span class="proposal-bids-main">
                        <strong>${escapeText(formatUsdc(bid.amount))}</strong>
                        <span class="proposal-bids-kind">${escapeText(kindLabel)}</span>
                    </span>
                    <span class="proposal-bids-meta">
                        ${walletUrl ? `<a href="${escapeText(walletUrl)}" target="_blank" rel="noopener" title="${escapeText(bid.wallet)}">${escapeText(shortKey(bid.wallet))}</a>` : ''}
                        <span>${escapeText(formatTime(bid.time))}</span>
                        ${txUrl ? `<a href="${escapeText(txUrl)}" target="_blank" rel="noopener">${escapeText(t('panel.proposal.ownerOffer.explorer', 'Explorer'))} ↗</a>` : ''}
                    </span>
                </li>`;
        }).join('');
    }

    // anchor: the support (pledge summary) card. The bids card is inserted right after it, only for
    // owner offers. The section may be detached while RPC reads run (another proposal opened), so
    // every write checks it is still in the document.
    async function mount(anchor, { proposal = null, proposalAccount = null } = {}) {
        if (!anchor || !isOwnerOffer(proposal) || !proposalAccount) return null;
        const existing = anchor.parentNode && anchor.parentNode.querySelector(`.proposal-bids-card[data-proposal-bids="${CSS.escape(String(proposalAccount))}"]`);
        if (existing) existing.remove();
        const section = document.createElement('section');
        section.className = 'proposal-funding-card proposal-bids-card';
        section.setAttribute('data-proposal-bids', String(proposalAccount));
        section.setAttribute('aria-label', t('panel.proposal.ownerOffer.title', 'Bids'));
        section.innerHTML = renderShell();
        anchor.insertAdjacentElement('afterend', section);
        const cluster = currentCluster();
        try {
            const accounts = await readBidAccounts(String(proposalAccount));
            if (!section.isConnected) return section;
            renderBids(section, { ranked: rankBids(accounts), ownerWallet: accounts.ownerWallet, proposalAccount, cluster });
        } catch (error) {
            log('warn', `bids for ${proposalAccount} unavailable`, error);
            if (!section.isConnected) return section;
            const totalNode = section.querySelector('[data-bids="total"]');
            if (totalNode) totalNode.textContent = t('panel.proposal.ownerOffer.unavailable', 'Bids unavailable');
        }
        return section;
    }

    return {
        OWNER_OFFER_ROLE,
        isOwnerOffer,
        ownerOfferEligibility,
        rankBids,
        explorerLink,
        mount
    };
});
