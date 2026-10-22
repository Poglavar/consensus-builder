// The parcel panel's "History" section: per cadastral parcel a collapsible History showing the
// permanent per-parcel log from GET /parcels/:parcelUid/history (agreements proposed over it, lens
// ownership attestations, executed agreements) as a timeline with explorer links. The pure
// builders (URL, link resolution, event text, timeline HTML) take no DOM and are exported via
// CommonJS for headless tests; renderSection (the Info tab's collapsed History section) is the thin
// DOM layer, fetching a parcel only when opened.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalParcelHistoryCard = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    // The event types the history lists (backend/oracle/parcel-history.js).
    const EVENT_LABELS = {
        agreement_published: ['panel.proposal.parcelHistory.event.agreementPublished', 'Agreement proposed'],
        parcel_ownership: ['panel.proposal.parcelHistory.event.ownership', 'Ownership attested'],
        agreement_executed: ['panel.proposal.parcelHistory.event.agreementExecuted', 'Agreement executed']
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
        if (event.title) details.push(event.title);
        if (event.agreementCid) details.push(t('panel.proposal.parcelHistory.agreement', 'Agreement {{cid}}', { cid: shortKey(event.agreementCid) }));
        if (event.member) details.push(t('panel.proposal.parcelHistory.member', 'Member {{key}}', { key: shortKey(event.member) }));
        if (event.owner) details.push(t('panel.proposal.parcelHistory.owner', 'Owner {{key}}', { key: shortKey(event.owner) }));
        if (typeof event.ownerCount === 'number') details.push(t('panel.proposal.parcelHistory.ownerCount', '{{count}} attested owner(s)', { count: event.ownerCount }));
        // An executed agreement names the one lens key that attested its decision; ownership events none.
        const lens = Array.isArray(event.lens) ? event.lens : typeof event.lens === 'string' && event.lens ? [event.lens] : [];
        if (lens.length) details.push(t('panel.proposal.parcelHistory.lens', 'Lens: {{keys}}', { keys: lens.map(shortKey).join(', ') }));
        return { title, details };
    }

    function normalizeHistory(body) {
        const events = body && Array.isArray(body.events) ? body.events.filter(event => event && typeof event.type === 'string') : [];
        const anchor = body && body.anchor && typeof body.anchor === 'object' ? body.anchor : { account: null, exists: null };
        return { parcelUid: body && body.parcelUid, anchor, events };
    }

    function buildAnchorHtml(anchor, t = plainT) {
        const unknown = () => t('panel.proposal.parcelHistory.anchorUnknown', 'Parcel anchor status unavailable');
        if (!anchor || !anchor.account) return `<p class="parcel-history-anchor">${escapeText(anchor?.source === 'unseedable'
            ? t('panel.proposal.parcelHistory.noAnchor', 'This parcel ID is too long for this Solana anchor.') : unknown())}</p>`;
        const link = `<a class="cb-link cb-link--external" href="https://explorer.solana.com/address/${encodeURIComponent(anchor.account)}?cluster=devnet" target="_blank" rel="noopener noreferrer">${escapeText(shortKey(anchor.account))}</a>`;
        const state = anchor.source !== 'chain' ? unknown() : anchor.exists === true
            ? t('panel.proposal.parcelHistory.anchorExists', 'Parcel anchor observed on Solana devnet')
            : anchor.exists === false ? t('panel.proposal.parcelHistory.anchorMissing', 'No parcel anchor found on Solana devnet') : unknown();
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
            const link = href ? `<a class="cb-link cb-link--external" href="${escapeText(href)}" target="_blank" rel="noopener noreferrer">${escapeText(t('panel.proposal.parcelHistory.view', 'View'))}</a>` : '';
            const hash = event.hash ? `<code class="parcel-history-hash" title="${escapeText(event.hash)}">${escapeText(shortKey(event.hash.replace(/^sha256:/, '')))}</code>` : '';
            return `
                <li class="parcel-history-event" data-history-type="${escapeText(event.type)}">
                    <time class="parcel-history-time"${event.at ? ` datetime="${escapeText(event.at)}"` : ''}>${escapeText(when)}</time>
                    <div class="parcel-history-body">
                        <strong>${escapeText(title)}</strong>
                        ${details.length ? `<span class="parcel-history-details">${details.map(escapeText).join(' · ')}</span>` : ''}
                        <span class="cb-link-row parcel-history-links">${link}${hash}</span>
                    </div>
                </li>`;
        }).join('');
        return `${anchorHtml}<ol class="parcel-history-timeline">${items}</ol>`;
    }

    // The parcel panel's always-present section: one collapsed History row per cadastral parcel
    // (usually one), without the card's heading; the hint becomes the summary's tooltip.
    function buildSectionHtml(parcelIds, t = plainT) {
        const hint = t('panel.proposal.parcelHistory.agreementHint', 'Every agreement proposed over the parcel, ownership attestation and executed agreement, oldest first, at the time its source states.');
        return parcelIds.map(parcelUid => {
            const label = parcelIds.length === 1
                ? t('panel.parcel.historySection', 'History')
                : t('panel.proposal.parcelHistory.summary', 'History: {{parcel}}', { parcel: parcelUid });
            return `
            <details class="parcel-history-parcel parcel-history-section" data-parcel-history="${escapeText(parcelUid)}">
                <summary title="${escapeText(hint)}"><i class="fas fa-clock-rotate-left" aria-hidden="true"></i> <span class="parcel-id-text">${escapeText(label)}</span></summary>
                <div class="parcel-history-content" aria-live="polite"></div>
            </details>`;
        }).join('');
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

    function bindLoaders(scope) {
        scope.querySelectorAll('[data-parcel-history]').forEach(details => {
            details.addEventListener('toggle', () => {
                if (details.open && !details.dataset.loaded) load(details);
            });
        });
    }

    // Fills the parcel panel's history host for these parcels; an empty list empties it (open
    // ground has no parcel history). The same parcels again keep the rows as they are, open and
    // loaded, since the panel re-renders one parcel several times.
    function renderSection(host, { parcelIds = [] } = {}) {
        if (!host) return null;
        const ids = Array.from(new Set((parcelIds || []).map(String).filter(Boolean)));
        const key = ids.join('\n');
        if (host.dataset.parcelHistoryIds === key && (host.childElementCount > 0 || !ids.length)) return host;
        host.dataset.parcelHistoryIds = key;
        host.innerHTML = ids.length ? buildSectionHtml(ids, t) : '';
        bindLoaders(host);
        return host;
    }

    return { historyUrl, resolveLink, formatAt, describeEvent, normalizeHistory, buildAnchorHtml, buildTimelineHtml, buildSectionHtml, renderSection };
});
