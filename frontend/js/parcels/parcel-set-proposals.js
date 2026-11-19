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

    // A page of published designs, and the size from which a list offers its search, type and order.
    const PAGE_SIZE = 50;
    const TOOLBAR_FROM = 6;
    // The index takes at most this many parcels in one ask (routes/designs.js MAX_PARCEL_FILTER).
    const MAX_PARCELS_ASKED = 500;
    const DEFAULT_QUERY = Object.freeze({ q: '', type: 'all', order: 'newest' });

    function normalizeQuery(query = {}) {
        return {
            q: typeof query.q === 'string' ? query.q : '',
            type: typeof query.type === 'string' && query.type ? query.type : 'all',
            order: query.order === 'oldest' ? 'oldest' : 'newest'
        };
    }

    function isDefaultQuery(query) {
        const value = normalizeQuery(query);
        return !value.q.trim() && value.type === 'all' && value.order === 'newest';
    }

    // When a design reached this list: a published one when it was published (an index summary's
    // createdAt is when the index received it), a draft when it was made. 0 when unknown.
    function receivedAt(proposal) {
        const at = Date.parse((proposal && proposal.published && proposal.published.publishedAt)
            || (proposal && (proposal.createdAt || proposal.updatedAt)) || '');
        return Number.isFinite(at) ? at : 0;
    }

    // proposalsForParcel(id) → the proposals declaring that parcel; keyOf(proposal) → its identity.
    // A proposal covering several parcels of the set is listed once, with every parcel it covers;
    // the newest come first (the oldest with order 'oldest'), ties in the order they were met.
    function collect(parcelIds, proposalsForParcel, keyOf, { order = 'newest' } = {}) {
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
        const sign = order === 'oldest' ? 1 : -1;
        return Array.from(entries.values()).sort((a, b) => sign * (receivedAt(a.proposal) - receivedAt(b.proposal)));
    }

    // Whether a proposal passes a list's search (its title or author, any case) and type (typeOf
    // maps a proposal to its display type, as the proposal list names types).
    function matchesQuery(proposal, query, typeOf) {
        const { q, type } = normalizeQuery(query);
        const needle = q.trim().toLocaleLowerCase();
        if (needle) {
            const haystack = [proposal && proposal.title, proposal && proposal.name, proposal && proposal.author]
                .filter(value => typeof value === 'string').join(' ').toLocaleLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        return type === 'all' || typeOf(proposal) === type;
    }

    // The type filter's choices from the index's counts per design goal ({ goal: n }, GET /designs
    // facets=goal): one choice per display type, with the goals it stands for, most designs first.
    function typeChoices(goalCounts, typeOf) {
        const byType = new Map();
        Object.entries(goalCounts || {}).forEach(([goal, count]) => {
            const type = typeOf({ goal });
            const choice = byType.get(type) || { type, goals: [], count: 0 };
            choice.goals.push(goal);
            choice.count += Number(count) || 0;
            byType.set(type, choice);
        });
        return Array.from(byType.values()).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    }

    // The index's answer for these cadastral parcels: their designs whose binding takes one of them,
    // a page at a time, with the search, the goals of the chosen type and the order.
    function publishedPath({ parcelIds, city = '', query = DEFAULT_QUERY, goals = null, offset = 0, limit = PAGE_SIZE, facets = false }) {
        const { q, order } = normalizeQuery(query);
        const params = new URLSearchParams({ parcel: parcelIds.slice(0, MAX_PARCELS_ASKED).join(',') });
        if (city) params.set('city', city);
        if (q.trim()) params.set('q', q.trim());
        if (goals && goals.length) params.set('goal', goals.join(','));
        if (order !== 'newest') params.set('order', order);
        params.set('limit', String(limit));
        if (offset) params.set('offset', String(offset));
        if (facets) params.set('facets', 'goal');
        return `/designs?${params.toString()}`;
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

    // A proposal row is an object-list item (docs/design-language.md, "Object lists"): its name is
    // the button that outlines the design on the map (pressed while kept outlined), and this arrow,
    // "Open <title>", is the only control that opens it. The name comes as markup, the arrow's
    // title as plain text.
    function pickButtonHtml(titleHtml, label = '') {
        const accessibleName = label ? ` aria-label="${escapeText(label)}"` : '';
        return `<button type="button" class="btn btn-quiet proposal-item-pick" data-proposal-pick aria-pressed="false"${accessibleName}>${titleHtml}</button>`;
    }

    function openButtonHtml(title, tr = t) {
        const label = escapeText(tr('lists.openNamed', 'Open {{title}}', { title }));
        return `<button type="button" class="btn btn-icon btn-sm object-list__open proposal-item-open" data-proposal-open title="${label}" aria-label="${label}"><i class="fas fa-arrow-right" aria-hidden="true"></i></button>`;
    }

    function recordLabelApi() {
        if (root?.RecordLabel) return root.RecordLabel;
        if (typeof require === 'function') return require('../ui/record-label.js');
        throw new Error('RecordLabel must be loaded before ParcelSetProposals');
    }

    function recordIdOf(proposal) {
        return root?.DesignSync?.publishedCid?.(proposal) || proposal?.cid || proposal?.published?.cid || proposal?.proposalId || '';
    }

    function recordBadgeHtml(id, peers = []) {
        const value = String(id || '');
        if (!value) return '';
        return `<code class="record-id" title="${escapeText(value)}">${escapeText(recordLabelApi().shortId(value, peers))}</code>`;
    }

    // describe(proposal) → { title, typeLabel, statusText, statusClass, modifierText?, modifierClass?,
    // thumbHtml }: statusClass is the lifecycle rung (draft · published · minted · executed) and the
    // modifier an expired or concluded record, both drawn as cb-badges (thumbHtml is trusted markup
    // from the app's thumbnail builder; everything else is escaped here). An entry with a serverId is
    // published only: its row carries the id to import it from.
    // published: { loading, error, total, more } — the state of the server lookup, shown as a line
    // under the list: `total` is every design on the parcels (entries are the ones loaded) and `more`
    // how many published ones are not loaded yet, offered as a "Show more" button when `pageable`.
    // filtered: the list is narrowed by a search or type, so an empty one says nothing matches.
    function listHtml(entries, { parcelCount = 0, describe, t = plainT, emptyText, summary = true, published = {}, pageable = false, filtered = false } = {}) {
        const more = Number(published.more) || 0;
        const status = published.loading
            ? `<p class="parcel-set-proposals-status">${escapeText(t('panel.parcel.setProposals.loading', 'Checking published proposals…'))}</p>`
            : (published.error
                ? `<p class="parcel-set-proposals-status">${escapeText(t('panel.parcel.setProposals.unavailable', 'Published proposals could not be loaded: {{reason}}', { reason: published.error }))}</p>`
                : (more > 0 && pageable
                    ? `<div class="cb-actions parcel-set-proposals-more"><button type="button" class="btn btn-sm" data-parcel-set-more>${escapeText(t('panel.parcel.setProposals.more', 'Show more ({{count}} left)', { count: more }))}</button></div>`
                    : (more > 0
                        ? `<p class="parcel-set-proposals-status">${escapeText(t('panel.parcel.setProposals.partial', 'Showing the newest {{shown}} of {{total}}', { shown: entries.length, total: entries.length + more }))}</p>`
                        : '')));
        if (!entries.length) {
            if (emptyText === false) return status;
            const empty = filtered
                ? t('panel.parcel.setProposals.noMatch', 'No designs match this search.')
                : (emptyText || t('panel.parcel.setProposals.empty', 'No designs on these parcels yet.'));
            return `<p class="parcel-set-proposals-empty">${escapeText(empty)}</p>${status}`;
        }
        const count = Math.max(entries.length, Number(published.total) || 0);
        const total = summary
            ? `<p class="parcel-set-proposals-summary">${escapeText(t('panel.parcel.setProposals.summary', '{{count}} designs on these parcels', { count }))}</p>`
            : '';
        const recordIds = entries.map(entry => recordIdOf(entry.proposal)).filter(Boolean);
        const rows = entries.map(entry => {
            const info = describe(entry.proposal);
            const recordId = recordIdOf(entry.proposal);
            const recordLabel = recordLabelApi().label(info.title, recordId, recordIds);
            // "On 2 of 5 parcels" says which part of the set a proposal stands on; with one parcel it says nothing.
            const coverage = parcelCount > 1
                ? t('panel.parcel.setProposals.covers', 'On {{covered}} of {{count}} parcels', { covered: entry.parcelIds.length, count: parcelCount })
                : '';
            const body = `
                <div class="proposal-item-body">
                    <div class="proposal-item-header">
                        <span class="proposal-item-title">${pickButtonHtml(escapeText(info.title), recordLabel)}${recordBadgeHtml(recordId, recordIds)}</span>
                        <div class="proposal-item-badges">
                            <span class="cb-badge cb-badge--${escapeText(info.statusClass)}">${escapeText(info.statusText)}</span>
                            ${info.modifierText ? `<span class="cb-badge ${escapeText(info.modifierClass)}">${escapeText(info.modifierText)}</span>` : ''}
                        </div>
                        ${openButtonHtml(recordLabel, t)}
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

    // The list's search, type filter and order (a field group, docs/design-language.md "Form
    // controls"). choices: typeChoices of the designs on the parcels; typeLabel(type) names one.
    function toolbarHtml(query, { choices = [], typeLabel = type => type, t = plainT } = {}) {
        const { q, type, order } = normalizeQuery(query);
        const searchLabel = t('panel.parcel.setProposals.search', 'Search by title or author');
        return `
            <input type="search" class="parcel-set-proposals-search" data-parcel-set-search value="${escapeText(q)}" placeholder="${escapeText(searchLabel)}" aria-label="${escapeText(searchLabel)}">
            <label class="parcel-set-proposals-field">${escapeText(t('panel.parcel.setProposals.type', 'Type'))}
                <select data-parcel-set-type>${typeOptionsHtml(type, { choices, typeLabel, t })}</select></label>
            <label class="parcel-set-proposals-field">${escapeText(t('panel.parcel.setProposals.order', 'Order'))}
                <select data-parcel-set-order>${optionHtml('newest', t('panel.parcel.setProposals.newest', 'Newest first'), order === 'newest')}${optionHtml('oldest', t('panel.parcel.setProposals.oldest', 'Oldest first'), order === 'oldest')}</select></label>`;
    }

    function optionHtml(value, label, selected) {
        return `<option value="${escapeText(value)}"${selected ? ' selected' : ''}>${escapeText(label)}</option>`;
    }

    // The type filter's options: every type, then each type the parcels hold with its count. A chosen
    // type the counts no longer list stays chosen, so the filter never changes by itself.
    function typeOptionsHtml(type, { choices = [], typeLabel = value => value, t = plainT } = {}) {
        const listed = type === 'all' || choices.some(choice => choice.type === type) ? choices : choices.concat([{ type, count: 0 }]);
        return [optionHtml('all', t('panel.parcel.setProposals.typeAll', 'All types'), type === 'all')]
            .concat(listed.map(choice => optionHtml(choice.type, `${typeLabel(choice.type)} (${choice.count})`, choice.type === type)))
            .join('');
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

    // A proposal's display type, as the proposal list names types (list-ui.js getProposalDisplayType).
    function typeOf(proposal) {
        return typeof root.getProposalDisplayType === 'function' ? root.getProposalDisplayType(proposal) : 'other';
    }

    function typeLabel(type) {
        return t(`modal.roadWidth.proposalList.typeLabels.${type}`, type);
    }

    // Published designs per cadastral parcel set, city and query (search, type goals, order): the
    // index's pages loaded so far, its total and its counts per goal. Kept for a minute so re-rendering
    // a panel does not ask again; a failure is kept as long, so it is not retried in a loop.
    const PUBLISHED_TTL_MS = 60 * 1000;
    const publishedCache = new Map();
    // The index record of each published-only row listed, by its CID: what a hovered row outlines.
    const publishedRecords = new Map();

    function settle(entry) {
        entry.at = Date.now();
        entry.promise = null;
        const listeners = Array.from(entry.listeners);
        entry.listeners.clear();
        listeners.forEach(listener => listener());
    }

    // Asks the index for the entry's next page (its first when nothing is loaded) and appends it.
    function fetchPage(entry) {
        const url = root.resolveBackendBaseUrl() + publishedPath({
            parcelIds: entry.parcelIds, city: entry.city, query: entry.query, goals: entry.goals,
            offset: entry.summaries.length ? entry.nextOffset : 0, facets: !entry.goalCounts
        });
        entry.error = null;
        entry.promise = fetch(url)
            .then(response => (response.ok ? response.json() : response.text().then(text => { throw new Error(text || `HTTP ${response.status}`); })))
            .then(payload => {
                const rows = Array.isArray(payload && payload.designs) ? payload.designs : [];
                entry.summaries = entry.summaries.concat(rows.map(row => root.DesignSync.designSummary(row)).filter(Boolean));
                entry.total = Number.isFinite(payload.total) ? payload.total : entry.summaries.length;
                entry.nextOffset = payload.hasMore ? payload.nextOffset : null;
                if (payload.goals) entry.goalCounts = payload.goals;
            })
            .catch(error => {
                console.warn(`[${new Date().toISOString()}] [ParcelSetProposals] published designs for ${entry.parcelIds.length} parcel(s) unavailable`, error);
                entry.error = error && error.message ? error.message : String(error);
            })
            .finally(() => settle(entry));
        return entry;
    }

    // goals: the design goals of the chosen type (null for every type).
    function loadPublished(cadastreIds, query = DEFAULT_QUERY, goals = null) {
        const city = root.normalizeCityCodeForApi(root.resolveCurrentCityCode());
        const parcelIds = cadastreIds.map(String).sort();
        if (parcelIds.length > MAX_PARCELS_ASKED) {
            console.warn(`[${new Date().toISOString()}] [ParcelSetProposals] ${parcelIds.length} parcels selected; the index is asked for the first ${MAX_PARCELS_ASKED}`);
        }
        const value = normalizeQuery(query);
        const key = JSON.stringify([city, parcelIds, value.q.trim(), goals, value.order]);
        const cached = publishedCache.get(key);
        if (cached && (cached.promise || Date.now() - cached.at < PUBLISHED_TTL_MS)) return cached;
        const entry = { at: Date.now(), city, parcelIds, query: value, goals, summaries: [], total: null, nextOffset: null,
            goalCounts: null, error: null, promise: null, listeners: new Set() };
        publishedCache.set(key, entry);
        return fetchPage(entry);
    }

    // The next page of a loaded query; onLoaded runs when it has arrived.
    function loadMore(entry, onLoaded) {
        if (!entry || entry.promise || entry.nextOffset === null) return;
        if (typeof onLoaded === 'function') entry.listeners.add(onLoaded);
        fetchPage(entry);
    }

    // The proposals on these parcels, the way the parcel panel lists one parcel's, plus the published
    // ones this browser does not hold, narrowed and ordered by `query` (DEFAULT_QUERY: all, newest
    // first). published.total counts every design on the parcels the query keeps, published.more the
    // published ones not loaded yet; published.choices are the type filter's choices.
    // onPublished runs once when a server answer that was not yet known arrives (the same function
    // passed by several renders while it is on its way runs once).
    function lookup(parcelIds, { onPublished, query = DEFAULT_QUERY } = {}) {
        const ids = Array.from(new Set((parcelIds || []).map(String).filter(Boolean)));
        const value = normalizeQuery(query);
        const store = storage();
        const local = id => (store && typeof store.getProposalsForParcel === 'function' ? store.getProposalsForParcel(id) : [])
            .filter(proposal => matchesQuery(proposal, value, typeOf));
        const cadastreIds = Array.from(new Set(ids.flatMap(cadastreIdsOf)));
        // The type's goals come from the counts of the unfiltered type: they name what the index holds.
        const countsEntry = cadastreIds.length && value.type !== 'all' ? loadPublished(cadastreIds, { ...value, type: 'all' }) : null;
        const counts = countsEntry ? countsEntry.goalCounts : null;
        const goals = value.type === 'all' ? null
            : typeChoices(counts, typeOf).filter(choice => choice.type === value.type).flatMap(choice => choice.goals);
        const none = { summaries: [], error: null, promise: null, total: 0, goalCounts: {} };
        const state = !cadastreIds.length ? none
            // Until the counts are known the type's goals are not: wait on them (or show their error).
            : (countsEntry && !counts ? { ...none, promise: countsEntry.promise, listeners: countsEntry.listeners, error: countsEntry.error, goalCounts: null }
                // A type the parcels hold no published design of asks nothing: none can match.
                : (goals && !goals.length ? { ...none, goalCounts: counts }
                    : loadPublished(cadastreIds, value, goals)));
        if (state.promise && typeof onPublished === 'function') state.listeners.add(onPublished);
        const isHeld = summary => !!root.findLocalCopyOfServerProposal(summary);
        const merged = withPublished(local, state.summaries, cadastreIdsOf, isHeld);
        const entries = collect(ids, merged.proposalsForParcel, proposal => proposal.proposalId, { order: value.order });
        // Drafts: what this browser holds that the index does not (a held copy of a published design
        // is in the index's total already).
        let drafts = 0;
        entries.forEach(entry => {
            if (!merged.publishedOnly.has(entry.proposal)) {
                if (!(root.DesignSync && root.DesignSync.publishedCid && root.DesignSync.publishedCid(entry.proposal))) drafts += 1;
                return;
            }
            entry.serverId = String(entry.proposal.cid);
            publishedRecords.set(entry.serverId, entry.proposal);
        });
        const serverTotal = Number.isFinite(state.total) ? state.total : state.summaries.length;
        const total = Math.max(entries.length, drafts + serverTotal);
        const more = Math.max(0, serverTotal - state.summaries.length);
        const choices = typeChoices(value.type === 'all' ? state.goalCounts : counts, typeOf);
        // `state` is the loaded query a "Show more" asks the next page of (null when there is none).
        return { ids, entries, query: value, state: state.parcelIds ? state : null,
            published: { loading: !!state.promise, error: state.error, total, more, choices } };
    }

    // The entries and the list's markup, for a caller that owns its container's updates.
    function view(parcelIds, options = {}) {
        const { ids, entries, published } = lookup(parcelIds, options);
        return { entries, published, html: listHtml(entries, { parcelCount: ids.length, describe, t, emptyText: options.emptyText, published }) };
    }

    // ---- Object lists beside the map ----------------------------------------------------------
    // Brings the outlined shapes into the part of the map the panel holding `container` leaves
    // visible, only when they are out of it or too small to make out (as the click stack frames).
    function frameIfHidden(win, container, features) {
        const map = win.map;
        if (!features.length || !map || !win.L) return;
        const bounds = win.L.geoJSON({ type: 'FeatureCollection', features }).getBounds();
        if (!bounds.isValid()) return;
        const panel = container.closest('.right-dock-panel, .right-screen-panel, .map-sheet--dock');
        const rect = panel ? panel.getBoundingClientRect() : null;
        const viewport = { width: win.innerWidth, height: win.innerHeight };
        const pad = win.proposalPanelFitPadding(rect, viewport, 16);
        const size = map.getSize();
        const northWest = map.latLngToContainerPoint(bounds.getNorthWest());
        const southEast = map.latLngToContainerPoint(bounds.getSouthEast());
        const box = { left: northWest.x, top: northWest.y, right: southEast.x, bottom: southEast.y };
        const view = { left: pad.paddingTopLeft[0], top: pad.paddingTopLeft[1],
            right: size.x - pad.paddingBottomRight[0], bottom: size.y - pad.paddingBottomRight[1] };
        if (!win.__clickStackModel.framingNeeded(box, view)) return;
        const { paddingTopLeft, paddingBottomRight } = win.proposalPanelFitPadding(rect, viewport, 48);
        map.fitBounds(bounds, { paddingTopLeft, paddingBottomRight, maxZoom: 19 });
    }

    // ObjectList.bind over a list of map objects, drawn on the map: hovering or focusing an item
    // outlines featuresOf(item) on the hover layer; a pressed item's outline takes the inspection
    // layer (framed when out of view) until it is let go, when the panel's own highlight (the click
    // stack's) comes back. In the model view both go through its inspection outline.
    // Shared by the proposal rows here and the claims breadcrumb (js/proposals/claims-ui.js).
    function bindOutlines(container, { item, keyOf, pressed, featuresOf, win = root }) {
        const objectList = win.ObjectList || require('../ui/object-list.js');
        let held = false; // a pressed item's outline replaced the panel's own
        let handle = null;
        const three = () => !!win.isThreeModeActive?.();
        handle = objectList.bind(container, {
            item, keyOf, pressed,
            show(key, { pinned, item: element }) {
                const features = featuresOf(element) || [];
                if (pinned) held = true;
                if (three()) { win.inspectThreeModeFeatures(features); return; }
                if (pinned) {
                    win.clearProposalHoverLayers();
                    win.highlightFeaturesForInspection(features, { weight: 5, className: 'object-list-map-focus' });
                    frameIfHidden(win, container, features);
                } else if (handle && handle.pinnedKey() === key) win.clearProposalHoverLayers();
                else win.highlightFeaturesForHover(features);
            },
            restore() {
                if (three()) {
                    win.inspectThreeModeFeatures([]);
                    win.ThreeClickStack?.restoreFocus?.();
                    held = false;
                    return;
                }
                win.clearProposalHoverLayers();
                if (!held) return;
                held = false;
                if (win.ClickStack?.holdsHighlight?.()) win.ClickStack.restoreFocus();
                else win.highlightFeaturesForInspection([]);
            }
        });
        return {
            reset() { handle.reset(); held = false; },
            pinnedKey: () => handle.pinnedKey(),
            unbind: () => handle.unbind()
        };
    }

    // A proposal row: one this module rendered or one of a parcel's own (parcel-panel.js).
    const ROW = '.proposal-item[data-parcel-set-proposal], .proposal-item[data-proposal-id]';
    const rowKey = row => row.getAttribute('data-server-id')
        || row.getAttribute('data-parcel-set-proposal') || row.getAttribute('data-proposal-id') || null;

    // The design's own shapes (ClickStackHits.featuresFor) for a held proposal, by its key. A
    // published-only one is known by its index record alone, which carries no geometry: it is
    // outlined by the cadastral parcels the index bound it to.
    function rowFeatures(row, win) {
        const key = rowKey(row);
        if (!key) return [];
        const serverId = row.getAttribute('data-server-id');
        const proposal = serverId ? publishedRecords.get(serverId) : win.proposalStorage?.getProposal?.(key);
        const own = win.ClickStackHits.featuresFor('designs', { id: key, proposal: proposal || null });
        if (own.length || !proposal) return own;
        return (proposal.cadastreParcelIds || []).map(id => win.CadastralParcelRepository?.get?.(String(id)))
            .filter(feature => feature?.geometry);
    }

    // Opens a row's proposal the way the parcel's list always did (selectAndHighlight via
    // showProposalDetails, with the first parcel of the set it covers); a published-only row (its
    // data-server-id is the design's CID) is imported first.
    async function openRow(row, win) {
        let key = row.getAttribute('data-parcel-set-proposal') || row.getAttribute('data-proposal-id');
        const serverId = row.getAttribute('data-server-id');
        if (serverId) {
            try {
                const proposal = await win.DesignSync.importDesign(await win.DesignSync.fetchDesign(serverId));
                key = win.getProposalKey(proposal) || key;
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [ParcelSetProposals] could not load published proposal ${serverId}`, error);
                win.updateStatus(t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal'));
                return;
            }
        }
        win.showProposalDetails(key, row.getAttribute('data-parcel-id'));
    }

    // The proposal rows in `container` (the rows may be rendered anew inside it) are an object
    // list: a row outlines its design (bindOutlines) and only its arrow opens it. Bound once per
    // container; binding it again (its owner rendered a new list) lets go of a pressed row.
    const boundRows = new WeakMap();
    function bindRows(container, win = root) {
        if (!container) return null;
        const bound = boundRows.get(container);
        if (bound) { bound.reset(); return bound; }
        const handle = bindOutlines(container, {
            item: ROW,
            keyOf: rowKey,
            pressed: row => row.querySelector('[data-proposal-pick]') || row,
            featuresOf: row => rowFeatures(row, win),
            win
        });
        container.addEventListener('click', event => {
            const button = event.target.closest('[data-proposal-open]');
            const row = button && button.closest(ROW);
            if (!row || !container.contains(row)) return;
            win.BusyControl.track(button, () => openRow(row, win));
        });
        boundRows.set(container, handle);
        return handle;
    }

    // The search, type and order controls in `toolbar` (filled on first use): onQuery(change) gets
    // { q } after typing pauses, { type } or { order } when chosen. Shown once a list holds
    // TOOLBAR_FROM designs, and kept while a filter is set so it can be cleared.
    const SEARCH_PAUSE_MS = 300;
    function syncToolbar(toolbar, result, query, onQuery) {
        if (!toolbar) return;
        const show = result.published.total >= TOOLBAR_FROM || !isDefaultQuery(query);
        toolbar.hidden = !show;
        if (!show) return;
        if (!toolbar.querySelector('[data-parcel-set-search]')) {
            toolbar.innerHTML = toolbarHtml(query, { choices: result.published.choices, typeLabel, t });
            let pause = null;
            toolbar.querySelector('[data-parcel-set-search]').addEventListener('input', event => {
                if (pause) clearTimeout(pause);
                // Typing asks the index again: wait for a pause rather than ask on every key.
                pause = setTimeout(() => { pause = null; onQuery({ q: event.target.value }); }, SEARCH_PAUSE_MS);
            });
            toolbar.querySelector('[data-parcel-set-type]').addEventListener('change', event => onQuery({ type: event.target.value }));
            toolbar.querySelector('[data-parcel-set-order]').addEventListener('change', event => onQuery({ order: event.target.value }));
            return;
        }
        toolbar.querySelector('[data-parcel-set-type]').innerHTML = typeOptionsHtml(normalizeQuery(query).type, { choices: result.published.choices, typeLabel, t });
    }

    // A list of a parcel set's designs in `results`, with its controls in `toolbar`: paint(query)
    // draws what lookup knows now and draws again when the index answers; "Show more" loads the next
    // page. draw(result, query) puts the rows in; it returns nothing.
    function pagedList({ owner, results, toolbar, parcelIds, draw }) {
        const token = String((Number(owner.dataset.parcelSetRender) || 0) + 1);
        owner.dataset.parcelSetRender = token;
        let query = DEFAULT_QUERY;
        let current = null;
        const live = () => owner.isConnected && owner.dataset.parcelSetRender === token;
        function paint() {
            if (!live()) return null;
            current = lookup(parcelIds, { query, onPublished: paint });
            draw(current, query);
            syncToolbar(toolbar, current, query, change => { query = normalizeQuery({ ...query, ...change }); paint(); });
            return current;
        }
        results.addEventListener('click', event => {
            const button = event.target.closest('[data-parcel-set-more]');
            if (!button || !current || !current.state || !live()) return;
            root.BusyControl.track(button, () => new Promise(resolve => loadMore(current.state, resolve)).then(() => {
                const before = results.querySelectorAll(ROW).length;
                paint();
                // Keep the keyboard where the reader was: on the first row the page added.
                const added = results.querySelectorAll(ROW)[before];
                const target = added && added.querySelector('[data-proposal-pick]');
                if (target) target.focus();
            }));
        });
        return paint();
    }

    // Fills `container` with a parcel set's designs (a multi-parcel selection) and fills it again when
    // the published ones arrive; onCount(total) reports every design on the parcels, the unfiltered
    // list's. Returns the entries known now.
    function render(container, parcelIds, options = {}) {
        if (!container) return [];
        container.innerHTML = '<div class="parcel-set-proposals-toolbar" role="search" hidden></div><div class="parcel-set-proposals-results"></div>';
        bindRows(container);
        const results = container.querySelector('.parcel-set-proposals-results');
        const first = pagedList({
            owner: container,
            results,
            toolbar: container.querySelector('.parcel-set-proposals-toolbar'),
            parcelIds,
            draw(result, query) {
                results.innerHTML = listHtml(result.entries, { parcelCount: result.ids.length, describe, t,
                    emptyText: options.emptyText, published: result.published, pageable: true, filtered: !isDefaultQuery(query) });
                if (typeof options.onCount === 'function' && isDefaultQuery(query)) options.onCount(result.published.total);
            }
        });
        return first ? first.entries : [];
    }

    // The published designs a parcel's own list (parcel-panel.js) does not show, as rows under it in
    // `container`: that list (`heldList`) renders this browser's designs in full, so only the
    // published-only ones are added here, a page at a time. The search, type and order in `toolbar`
    // narrow and order both lists. onCount(total) reports every design on the parcel (the unfiltered
    // list's); emptyNote is hidden once any are listed.
    function renderPublishedOnly(container, parcelId, { onCount, emptyNote, toolbar = null, heldList = null } = {}) {
        if (!container) return;
        pagedList({
            owner: container,
            results: container,
            toolbar,
            parcelIds: [parcelId],
            draw(result, query) {
                const publishedOnly = result.entries.filter(entry => entry.serverId);
                const heldShown = arrangeHeldRows(heldList, result.query);
                // "Also" only follows a list: with no proposal held here, the published ones are the list.
                const heading = publishedOnly.length && heldShown
                    ? `<p class="parcel-set-proposals-summary">${escapeText(t('panel.parcel.setProposals.publishedHeading', 'Also published here'))}</p>`
                    : '';
                const filtered = !isDefaultQuery(query);
                container.innerHTML = heading + listHtml(publishedOnly, { parcelCount: 1, describe, t,
                    emptyText: filtered && !heldShown ? undefined : false, summary: false, published: result.published, pageable: true, filtered });
                if (emptyNote) emptyNote.hidden = publishedOnly.length > 0 || filtered;
                if (typeof onCount === 'function' && !filtered) onCount(result.published.total);
            }
        });
        // Its rows are bound with the parcel's own rows, by the list that holds both (parcel-panel.js).
    }

    // The parcel's own rows (this browser's designs) narrowed by the search and type and put in the
    // list's order. Returns how many are shown.
    function arrangeHeldRows(heldList, query) {
        const list = heldList && heldList.querySelector('.parcel-proposals-list');
        if (!list) return 0;
        const store = storage();
        const sign = query.order === 'oldest' ? 1 : -1;
        const rows = Array.from(list.querySelectorAll('.proposal-item[data-proposal-id]')).map(row => ({
            row, proposal: store && typeof store.getProposal === 'function' ? store.getProposal(row.getAttribute('data-proposal-id')) : null
        }));
        let shown = 0;
        rows.sort((a, b) => sign * (receivedAt(a.proposal) - receivedAt(b.proposal))).forEach(({ row, proposal }) => {
            row.hidden = !(proposal && matchesQuery(proposal, query, typeOf));
            if (!row.hidden) shown += 1;
            list.appendChild(row);
        });
        return shown;
    }

    // How many designs these parcels' Proposals tab lists — this browser's plus every published one
    // on them — as { count, loading, error }. While the server is still being asked, onUpdate later
    // gets the settled answer (an error leaves the count at what is held here).
    function count(parcelIds, onUpdate) {
        const settled = () => {
            const { published } = lookup(parcelIds);
            onUpdate({ count: published.total, loading: false, error: published.error });
        };
        const { published } = lookup(parcelIds, { onPublished: typeof onUpdate === 'function' ? settled : undefined });
        return { count: published.total, loading: published.loading, error: published.error };
    }

    return { collect, withPublished, matchesQuery, typeChoices, publishedPath, receivedAt, listHtml, toolbarHtml, pickButtonHtml, openButtonHtml,
        lookup, view, bindOutlines, bindRows, render, renderPublishedOnly, count, PAGE_SIZE };
});
