// Proposal Details "Parcel history" card: per listed parcel a collapsible History showing the
// permanent per-parcel log from GET /parcels/:parcelUid/history (proposals, lens ownership
// attestations, acceptances, verdicts, lifecycle) as a timeline with explorer links. The pure
// builders (URL, link resolution, event text, timeline HTML) take no DOM and are exported via
// CommonJS for headless tests; mountAfter is the thin DOM layer, fetching a parcel only when opened.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalParcelHistoryCard = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    const EVENT_LABELS = {
        proposal_created: ['panel.proposal.parcelHistory.event.created', 'Proposal created'],
        proposal_published: ['panel.proposal.parcelHistory.event.published', 'Proposal minted on chain'],
        parcel_ownership: ['panel.proposal.parcelHistory.event.ownership', 'Ownership attested'],
        proposal_acceptance: ['panel.proposal.parcelHistory.event.acceptance', 'Owner said yes'],
        proposal_verdict: ['panel.proposal.parcelHistory.event.verdict', 'Verdict settled'],
        proposal_lifecycle: ['panel.proposal.parcelHistory.event.lifecycle', 'Proposal reached a final state']
    };
    const OUTCOME_LABELS = {
        executed: ['panel.proposal.parcelHistory.outcome.executed', 'executed'],
        cancelled: ['panel.proposal.parcelHistory.outcome.cancelled', 'cancelled'],
        expired: ['panel.proposal.parcelHistory.outcome.expired', 'expired']
    };

    function plainT(key, fallback, params = {}) {
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
    }

    function escapeText(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function shortKey(value) {
        const text = String(value || '');
        return text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
    }

    function historyUrl(base, parcelUid) {
        return `${String(base || '').replace(/\/+$/, '')}/parcels/${encodeURIComponent(String(parcelUid))}/history`;
    }

    // http(s) links pass; an API-relative path ("/proposals/x") is resolved against the backend base;
    // anything else (javascript:, data:) is dropped.
    function resolveLink(link, base) {
        if (typeof link !== 'string' || !link) return null;
        if (/^https?:\/\//i.test(link)) return link;
        if (link.startsWith('/') && !link.startsWith('//')) return `${String(base || '').replace(/\/+$/, '')}${link}`;
        return null;
    }

    // "2026-09-21 09:00 UTC", or null for an untimed event: the time is never guessed. In the UI
    // language through the shared formatter where the page loads it (the unit tests do not).
    function formatAt(at) {
        if (typeof at !== 'string') return null;
        const date = new Date(at);
        if (Number.isNaN(date.getTime())) return null;
        if (typeof CbFormat !== 'undefined') return `${CbFormat.formatDateTime(date, { timeZone: 'UTC' })} UTC`;
        return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    }

    function describeEvent(event, t = plainT) {
        const [key, fallback] = EVENT_LABELS[event.type] || ['panel.proposal.parcelHistory.event.other', event.type || 'Event'];
        const title = t(key, fallback);
        const details = [];
        if (event.outcome && event.type !== 'proposal_acceptance') {
            const label = OUTCOME_LABELS[event.outcome];
            details.push(label ? t(label[0], label[1]) : event.outcome);
        }
        if (event.title) details.push(event.title);
        if (event.proposalId && event.type !== 'proposal_created') details.push(t('panel.proposal.parcelHistory.proposal', 'Proposal {{id}}', { id: event.proposalId }));
        if (event.member) details.push(t('panel.proposal.parcelHistory.member', 'Member {{key}}', { key: shortKey(event.member) }));
        if (event.owner) details.push(t('panel.proposal.parcelHistory.owner', 'Owner {{key}}', { key: shortKey(event.owner) }));
        if (typeof event.ownerCount === 'number') details.push(t('panel.proposal.parcelHistory.ownerCount', '{{count}} attested owner(s)', { count: event.ownerCount }));
        if (Array.isArray(event.lens) && event.lens.length) details.push(t('panel.proposal.parcelHistory.lens', 'Lens: {{keys}}', { keys: event.lens.map(shortKey).join(', ') }));
        return { title, details };
    }

    function normalizeHistory(body) {
        const events = body && Array.isArray(body.events) ? body.events.filter(event => event && typeof event.type === 'string') : [];
        const anchor = body && body.anchor && typeof body.anchor === 'object' ? body.anchor : { account: null, exists: false };
        return { parcelUid: body && body.parcelUid, anchor, events };
    }

    function buildAnchorHtml(anchor, t = plainT) {
        if (!anchor || !anchor.account) return `<p class="parcel-history-anchor">${escapeText(t('panel.proposal.parcelHistory.noAnchor', 'This parcel id cannot have an on-chain anchor.'))}</p>`;
        const link = `<a href="https://explorer.solana.com/address/${encodeURIComponent(anchor.account)}?cluster=devnet" target="_blank" rel="noopener">${escapeText(shortKey(anchor.account))} ↗</a>`;
        const state = anchor.exists
            ? (formatAt(anchor.mintedAt)
                ? t('panel.proposal.parcelHistory.anchorMinted', 'Anchored on chain since {{at}}', { at: formatAt(anchor.mintedAt) })
                : t('panel.proposal.parcelHistory.anchorExists', 'Anchored on chain'))
            : t('panel.proposal.parcelHistory.anchorMissing', 'Not anchored on chain yet');
        return `<p class="parcel-history-anchor">${escapeText(state)}: ${link}</p>`;
    }

    function buildTimelineHtml(history, { t = plainT, base = '' } = {}) {
        const { anchor, events } = normalizeHistory(history);
        const anchorHtml = buildAnchorHtml(anchor, t);
        if (!events.length) return `${anchorHtml}<p class="parcel-history-empty">${escapeText(t('panel.proposal.parcelHistory.empty', 'Nothing recorded for this parcel yet.'))}</p>`;
        const items = events.map(event => {
            const { title, details } = describeEvent(event, t);
            const when = formatAt(event.at) || t('panel.proposal.parcelHistory.untimed', 'time unknown');
            const href = resolveLink(event.link, base);
            const link = href ? `<a href="${escapeText(href)}" target="_blank" rel="noopener">${escapeText(t('panel.proposal.parcelHistory.view', 'View'))} ↗</a>` : '';
            const hash = event.hash ? `<code class="parcel-history-hash" title="${escapeText(event.hash)}">${escapeText(shortKey(event.hash.replace(/^sha256:/, '')))}</code>` : '';
            return `
                <li class="parcel-history-event" data-history-type="${escapeText(event.type)}">
                    <time class="parcel-history-time"${event.at ? ` datetime="${escapeText(event.at)}"` : ''}>${escapeText(when)}</time>
                    <div class="parcel-history-body">
                        <strong>${escapeText(title)}</strong>
                        ${details.length ? `<span class="parcel-history-details">${details.map(escapeText).join(' · ')}</span>` : ''}
                        <span class="parcel-history-links">${link}${hash}</span>
                    </div>
                </li>`;
        }).join('');
        return `${anchorHtml}<ol class="parcel-history-timeline">${items}</ol>`;
    }

    function buildCardHtml(parcelIds, t = plainT) {
        const rows = parcelIds.map(parcelUid => `
            <details class="parcel-history-parcel" data-parcel-history="${escapeText(parcelUid)}">
                <summary>${escapeText(t('panel.proposal.parcelHistory.summary', 'History: {{parcel}}', { parcel: parcelUid }))}</summary>
                <div class="parcel-history-content" aria-live="polite"></div>
            </details>`).join('');
        return `
            <div class="proposal-funding-head">
                <div>
                    <div class="proposal-funding-eyebrow">${escapeText(t('panel.proposal.parcelHistory.eyebrow', 'Permanent per-parcel log'))}</div>
                    <h3>${escapeText(t('panel.proposal.parcelHistory.title', 'Parcel history'))}</h3>
                </div>
            </div>
            <p class="lens-picker-note">${escapeText(t('panel.proposal.parcelHistory.hint', 'Every proposal, ownership attestation and consent recorded for each parcel, oldest first, at the time its source states.'))}</p>
            ${rows}`;
    }

    // ---- DOM layer -------------------------------------------------------------------------
    function t(key, fallback, params = {}) {
        const api = root && root.i18n;
        if (api && typeof api.t === 'function') {
            const value = api.t(key, params);
            if (value && value !== key) return value;
        }
        return plainT(key, fallback, params);
    }

    function backendBase() {
        return root && typeof root.getBackendBase === 'function' ? String(root.getBackendBase()).replace(/\/+$/, '') : '';
    }

    async function load(details) {
        const content = details.querySelector('.parcel-history-content');
        const parcelUid = details.getAttribute('data-parcel-history');
        const base = backendBase();
        content.textContent = t('panel.proposal.parcelHistory.loading', 'Loading history…');
        try {
            const response = await fetch(historyUrl(base, parcelUid), { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            if (!details.isConnected) return;
            content.innerHTML = buildTimelineHtml(body, { t, base });
            details.dataset.loaded = '1';
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [ParcelHistoryCard] history for ${parcelUid} unavailable`, error);
            if (!details.isConnected) return;
            content.textContent = t('panel.proposal.parcelHistory.unavailable', 'History unavailable: {{message}}', { message: error && error.message ? error.message : String(error) });
        }
    }

    // Inserts the card right after `anchorElement` (the lens card) and fetches each parcel's history
    // the first time its row is opened.
    function mountAfter(anchorElement, { parcelIds = [] } = {}) {
        if (!anchorElement || !anchorElement.parentNode) return null;
        const ids = Array.from(new Set((parcelIds || []).map(String).filter(Boolean)));
        if (!ids.length) return null;
        const next = anchorElement.nextElementSibling;
        if (next && next.classList.contains('proposal-parcel-history-card')) next.remove();
        const section = anchorElement.ownerDocument.createElement('section');
        section.className = 'proposal-funding-card proposal-parcel-history-card';
        section.innerHTML = buildCardHtml(ids, t);
        section.querySelectorAll('[data-parcel-history]').forEach(details => {
            details.addEventListener('toggle', () => {
                if (details.open && !details.dataset.loaded) load(details);
            });
        });
        anchorElement.parentNode.insertBefore(section, anchorElement.nextSibling);
        return section;
    }

    return { historyUrl, resolveLink, formatAt, describeEvent, normalizeHistory, buildAnchorHtml, buildTimelineHtml, buildCardHtml, mountAfter };
});
