// Proposals on a set of parcels (a parcel, a multi-parcel selection, a drawn site's bound parcels):
// those this browser holds and those published in the designs index, one entry per proposal with the
// parcels of the set it covers, and the list the panels' Proposals tab shows. The published ones come
// from the index the proposal list's Server tab reads (GET /designs, here by the parcels' bounding box,
// kept when their binding takes one of the parcels), are matched to local copies by CID the same way,
// and are imported when opened. collect, withPublished and listHtml take no DOM and are exported via
// CommonJS for headless tests; the rest is the thin DOM layer.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelSetProposals = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    function plainT(key, fallback, params = {}) {
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
    }

    function escapeText(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // proposalsForParcel(id) → the proposals declaring that parcel; keyOf(proposal) → its identity.
    // A proposal covering several parcels of the set is listed once, with every parcel it covers;
    // the widest come first, ties in the order they were met.
    function collect(parcelIds, proposalsForParcel, keyOf) {
        const entries = new Map();
        const ids = Array.from(new Set((parcelIds || []).map(String).filter(Boolean)));
        ids.forEach(parcelId => {
            (proposalsForParcel(parcelId) || []).forEach(proposal => {
                const key = String(keyOf(proposal) ?? '');
                if (!key) return;
                const entry = entries.get(key) || { key, proposal, parcelIds: [] };
                if (!entry.parcelIds.includes(parcelId)) entry.parcelIds.push(parcelId);
                entries.set(key, entry);
            });
        });
        return Array.from(entries.values()).sort((a, b) => b.parcelIds.length - a.parcelIds.length);
    }

    // Adds the published proposals this browser holds no copy of (isHeld) to each parcel's local
    // ones, by the cadastral parcels they declare (cadastreIdsOf maps a set member, live or
    // cadastral, to its cadastral ids). Returns the combined lookup and the published-only records.
    function withPublished(proposalsForParcel, published, cadastreIdsOf, isHeld) {
        const publishedOnly = (published || []).filter(summary => !isHeld(summary));
        const lookup = parcelId => {
            const cadastral = new Set(cadastreIdsOf(parcelId).map(String));
            return (proposalsForParcel(parcelId) || []).concat(publishedOnly.filter(summary =>
                (summary.cadastreParcelIds || []).some(id => cadastral.has(String(id)))));
        };
        return { proposalsForParcel: lookup, publishedOnly: new Set(publishedOnly) };
    }

    // describe(proposal) → { title, typeLabel, statusText, statusClass, modifierText?, modifierClass?,
    // thumbHtml }: statusClass is the lifecycle rung (draft · published · minted · executed) and the
    // modifier an expired or concluded record, both drawn as cb-badges (thumbHtml is trusted markup
    // from the app's thumbnail builder; everything else is escaped here). An entry with a serverId is
    // published only: its row carries the id to import it from.
    // published: { loading, error } — the state of the server lookup, shown as a line under the list.
    function listHtml(entries, { parcelCount = 0, describe, t = plainT, emptyText, summary = true, published = {} } = {}) {
        const status = published.loading
            ? `<p class="parcel-set-proposals-status">${escapeText(t('panel.parcel.setProposals.loading', 'Checking published proposals…'))}</p>`
            : (published.error
                ? `<p class="parcel-set-proposals-status">${escapeText(t('panel.parcel.setProposals.unavailable', 'Published proposals could not be loaded: {{reason}}', { reason: published.error }))}</p>`
                : '');
        if (!entries.length) {
            if (emptyText === false) return status;
            return `<p class="parcel-set-proposals-empty">${escapeText(emptyText
                || t('panel.parcel.setProposals.empty', 'No proposals on these parcels yet.'))}</p>${status}`;
        }
        const total = summary
            ? `<p class="parcel-set-proposals-summary">${escapeText(t('panel.parcel.setProposals.summary', '{{count}} proposals on these parcels', { count: entries.length }))}</p>`
            : '';
        const rows = entries.map(entry => {
            const info = describe(entry.proposal);
            // "On 2 of 5 parcels" says which part of the set a proposal stands on; with one parcel it says nothing.
            const coverage = parcelCount > 1
                ? t('panel.parcel.setProposals.covers', 'On {{covered}} of {{count}} parcels', { covered: entry.parcelIds.length, count: parcelCount })
                : '';
            const body = `
                <div class="proposal-item-body">
                    <div class="proposal-item-header">
                        <span class="proposal-item-title">${escapeText(info.title)}</span>
                        <div class="proposal-item-badges">
                            <span class="cb-badge cb-badge--${escapeText(info.statusClass)}">${escapeText(info.statusText)}</span>
                            ${info.modifierText ? `<span class="cb-badge ${escapeText(info.modifierClass)}">${escapeText(info.modifierText)}</span>` : ''}
                        </div>
                    </div>
                    <div class="proposal-item-details">${escapeText([info.typeLabel, coverage].filter(Boolean).join(' · '))}</div>
                </div>`;
            const serverAttr = entry.serverId ? ` data-server-id="${escapeText(entry.serverId)}"` : '';
            return `
                <div class="proposal-item parcel-set-proposal" data-parcel-set-proposal="${escapeText(entry.key)}" data-parcel-id="${escapeText(entry.parcelIds[0])}"${serverAttr}>
                    ${info.thumbHtml ? `<div class="proposal-item-row">${info.thumbHtml}${body}</div>` : body}
                </div>`;
        }).join('');
        return `${total}<div class="parcel-proposals-list">${rows}</div>${status}`;
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

    function storage() {
        return (root.Proposals && root.Proposals.storage) || root.proposalStorage || null;
    }

    // The ladder the proposals list shows (getProposalLadder, js/proposals/list-ui.js).
    function describe(proposal) {
        const ladder = root.getProposalLadder(proposal);
        const typeLabel = root.getProposalDisplayTypeLabel(proposal) || '';
        const name = proposal.title || proposal.name || typeLabel || t('modal.roadWidth.proposalList.untitled', 'Untitled proposal');
        return {
            title: root.ProposalDisplayText.text(name, proposal),
            typeLabel,
            statusText: ladder.label,
            statusClass: ladder.rung,
            modifierText: ladder.modifier ? ladder.modifier.label : '',
            modifierClass: ladder.modifier ? ladder.modifier.className : '',
            thumbHtml: typeof root.buildProposalThumbHtml === 'function' ? root.buildProposalThumbHtml(proposal) : ''
        };
    }

    // A set member's cadastral parcels, as proposalStorage.getProposalsForParcel projects them: a live
    // parcel through its explicit fabric provenance, a cadastral parcel as itself, open ground as none.
    function cadastreIdsOf(parcelId) {
        const id = String(parcelId);
        const fabric = root.LiveParcelFabric;
        const live = fabric && typeof fabric.get === 'function' ? fabric.get(id) : null;
        if (live) return typeof fabric.explicitCadastreIds === 'function' ? fabric.explicitCadastreIds(live).map(String) : [];
        const repository = root.CadastralParcelRepository;
        return repository && typeof repository.get === 'function' && repository.get(id) ? [id] : [];
    }

    // Published proposals per cadastral parcel set and city, fetched once and kept for a minute so
    // re-rendering a panel does not ask again; a failure is kept as long, so it is not retried in a loop.
    const PUBLISHED_TTL_MS = 60 * 1000;
    const publishedCache = new Map();

    function publishedKeyFor(cadastreIds) {
        const city = root.normalizeCityCodeForApi(root.resolveCurrentCityCode());
        return { city, key: `${city}|${cadastreIds.slice().sort().join(',')}` };
    }

    function loadPublished(cadastreIds) {
        const { city, key } = publishedKeyFor(cadastreIds);
        const cached = publishedCache.get(key);
        if (cached && (cached.promise || Date.now() - cached.at < PUBLISHED_TTL_MS)) return cached;
        const entry = { at: Date.now(), summaries: cached ? cached.summaries : null, error: null, promise: null, listeners: new Set() };
        // The index answers by area, not by parcel: ask for the designs whose site meets the box of
        // the parcels this browser holds, and keep those whose binding takes one of them.
        const features = root.CadastralParcelRepository.peekMany(cadastreIds);
        const wanted = new Set(cadastreIds.map(String));
        const box = features.length ? root.turf.bbox({ type: 'FeatureCollection', features }) : null;
        const url = box
            ? `${root.resolveBackendBaseUrl()}/designs?bbox=${box.map(value => value.toFixed(7)).join(',')}`
                + (city ? `&city=${encodeURIComponent(city)}` : '') + '&limit=200'
            : null;
        const answer = url
            ? fetch(url).then(response => (response.ok ? response.json() : response.text().then(text => { throw new Error(text || `HTTP ${response.status}`); })))
            : Promise.resolve({ designs: [] });
        entry.promise = answer
            .then(payload => {
                entry.summaries = (Array.isArray(payload && payload.designs) ? payload.designs : [])
                    .map(row => root.DesignSync.designSummary(row)).filter(Boolean)
                    .filter(summary => summary.cadastreParcelIds.some(id => wanted.has(String(id))));
            })
            .catch(error => {
                console.warn(`[${new Date().toISOString()}] [ParcelSetProposals] published proposals for ${cadastreIds.length} parcel(s) unavailable`, error);
                entry.error = error && error.message ? error.message : String(error);
            })
            .finally(() => {
                entry.at = Date.now();
                entry.promise = null;
                const listeners = Array.from(entry.listeners);
                entry.listeners.clear();
                listeners.forEach(listener => listener());
            });
        publishedCache.set(key, entry);
        return entry;
    }

    // The proposals on these parcels, the way the parcel panel lists one parcel's, plus the published
    // ones this browser does not hold.
    // onPublished runs once when a server answer that was not yet known arrives (the same function
    // passed by several renders while it is on its way runs once).
    function lookup(parcelIds, { onPublished } = {}) {
        const ids = Array.from(new Set((parcelIds || []).map(String).filter(Boolean)));
        const store = storage();
        const local = id => (store && typeof store.getProposalsForParcel === 'function' ? store.getProposalsForParcel(id) : []);
        const cadastreIds = Array.from(new Set(ids.flatMap(cadastreIdsOf)));
        const state = cadastreIds.length ? loadPublished(cadastreIds) : { summaries: [], error: null, promise: null };
        if (state.promise && typeof onPublished === 'function') state.listeners.add(onPublished);
        const merged = withPublished(local, state.summaries, cadastreIdsOf, summary => !!root.findLocalCopyOfServerProposal(summary));
        const entries = collect(ids, merged.proposalsForParcel, proposal => proposal.proposalId);
        entries.forEach(entry => {
            if (merged.publishedOnly.has(entry.proposal)) entry.serverId = String(entry.proposal.cid);
        });
        return { ids, entries, published: { loading: !!state.promise, error: state.error } };
    }

    // The entries and the list's markup, for a caller that owns its container's updates.
    function view(parcelIds, options = {}) {
        const { ids, entries, published } = lookup(parcelIds, options);
        return { entries, published, html: listHtml(entries, { parcelCount: ids.length, describe, t, emptyText: options.emptyText, published }) };
    }

    // A row opens its proposal the way a parcel's list does (selectAndHighlight via
    // showProposalDetails, with the first parcel of the set it covers); a published-only row (its
    // data-server-id is the design's CID) is imported first. Bound once per container.
    function bindRows(container) {
        if (!container || container.dataset.parcelSetProposalsBound) return;
        container.dataset.parcelSetProposalsBound = 'true';
        container.addEventListener('click', async event => {
            const row = event.target.closest('[data-parcel-set-proposal]');
            if (!row) return;
            let key = row.getAttribute('data-parcel-set-proposal');
            const serverId = row.getAttribute('data-server-id');
            if (serverId) {
                try {
                    const proposal = root.DesignSync.importDesign(await root.DesignSync.fetchDesign(serverId));
                    key = root.getProposalKey(proposal) || key;
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] [ParcelSetProposals] could not load published proposal ${serverId}`, error);
                    root.updateStatus(t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal'));
                    return;
                }
            }
            root.showProposalDetails(key, row.getAttribute('data-parcel-id'));
        });
    }

    // Fills `container` and fills it again when the published proposals arrive; onCount(total)
    // reports the number listed each time. Returns the entries known now.
    function render(container, parcelIds, options = {}) {
        if (!container) return [];
        const token = String((Number(container.dataset.parcelSetRender) || 0) + 1);
        container.dataset.parcelSetRender = token;
        const paint = () => {
            if (!container.isConnected || container.dataset.parcelSetRender !== token) return null;
            const result = view(parcelIds, { emptyText: options.emptyText, onPublished: once });
            container.innerHTML = result.html;
            if (typeof options.onCount === 'function') options.onCount(result.entries.length);
            return result;
        };
        let repainted = false;
        function once() { if (!repainted) { repainted = true; paint(); } }
        bindRows(container);
        const first = paint();
        return first ? first.entries : [];
    }

    // The published proposals a parcel's own list (parcel-panel.js) does not show, as rows under it:
    // that list renders this browser's proposals in full, so only the published-only ones are added
    // here. onCount(n) reports how many were added; emptyNote is hidden once there are some.
    function renderPublishedOnly(container, parcelId, { onCount, emptyNote } = {}) {
        if (!container) return;
        const token = String((Number(container.dataset.parcelSetRender) || 0) + 1);
        container.dataset.parcelSetRender = token;
        let repainted = false;
        const paint = () => {
            if (!container.isConnected || container.dataset.parcelSetRender !== token) return;
            const { entries, published } = lookup([parcelId], { onPublished: () => { if (!repainted) { repainted = true; paint(); } } });
            const publishedOnly = entries.filter(entry => entry.serverId);
            // "Also" only follows a list: with no proposal held here, the published ones are the list.
            const heading = publishedOnly.length && entries.length > publishedOnly.length
                ? `<p class="parcel-set-proposals-summary">${escapeText(t('panel.parcel.setProposals.publishedHeading', 'Also published here'))}</p>`
                : '';
            container.innerHTML = heading + listHtml(publishedOnly, { parcelCount: 1, describe, t, emptyText: false, summary: false, published });
            if (emptyNote) emptyNote.hidden = publishedOnly.length > 0;
            if (typeof onCount === 'function') onCount(publishedOnly.length);
        };
        bindRows(container);
        paint();
    }

    // How many proposals these parcels' Proposals tab lists — this browser's plus the published ones
    // it holds no copy of — as { count, loading, error }. While the server is still being asked,
    // onUpdate later gets the settled answer (an error leaves the count at what is held here).
    function count(parcelIds, onUpdate) {
        const settle = () => {
            const { entries, published } = lookup(parcelIds);
            onUpdate({ count: entries.length, loading: false, error: published.error });
        };
        const { entries, published } = lookup(parcelIds, { onPublished: typeof onUpdate === 'function' ? settle : undefined });
        return { count: entries.length, loading: published.loading, error: published.error };
    }

    return { collect, withPublished, listHtml, view, bindRows, render, renderPublishedOnly, count };
});
