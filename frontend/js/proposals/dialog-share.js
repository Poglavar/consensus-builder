// proposals/dialog-share.js — extracted from proposals.js (behavior-preserving relocation).

// The "waiting for transaction" box: a message dialog on the shared chrome (js/ui/dialogs.js) with
// no answers, over any dialog it was opened from; it blocks the map until hideProposalWaitingPopup.
let proposalWaitingDialog = null;

function showProposalWaitingPopup(message = 'Waiting for transaction...') {
    if (proposalWaitingDialog && proposalWaitingDialog.overlay.isConnected) {
        const textEl = proposalWaitingDialog.body.querySelector('.proposal-waiting-text');
        if (textEl) textEl.textContent = message;
        return;
    }
    if (!window.CbDialog) return;
    const card = document.createElement('div');
    card.className = 'proposal-waiting-card';
    const indicator = document.createElement('span');
    indicator.className = 'proposal-waiting-spinner';
    indicator.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'proposal-waiting-text';
    text.textContent = message;
    card.appendChild(indicator);
    card.appendChild(text);
    proposalWaitingDialog = window.CbDialog.open({
        message: true, size: 'sm', top: true, role: 'alertdialog',
        className: 'proposal-waiting-dialog', overlayClassName: 'proposal-waiting-overlay',
        body: card, closeOnBackdrop: false, closeOnEscape: false, autofocus: false,
        onClose: () => { proposalWaitingDialog = null; }
    });
    if (proposalWaitingDialog) proposalWaitingDialog.overlay.id = 'proposal-waiting-popup';
}

function hideProposalWaitingPopup() {
    if (proposalWaitingDialog) proposalWaitingDialog.close(null);
    proposalWaitingDialog = null;
}

function showProposalWaitingPopupTemporary(message = 'Transaction rejected', duration = 2000) {
    showProposalWaitingPopup(message);
    setTimeout(() => {
        hideProposalWaitingPopup();
    }, Math.max(500, duration));
}

function scheduleDebouncedProposalListModalRender() {
    clearProposalListFilterInputDebounce();
    _proposalListFilterInputDebounceTimer = setTimeout(() => {
        _proposalListFilterInputDebounceTimer = null;
        renderProposalListModal();
    }, PROPOSAL_LIST_FILTER_INPUT_DEBOUNCE_MS);
}

function renderProposalListModal() {
    // A full render supersedes any pending debounced re-render from search typing.
    clearProposalListFilterInputDebounce();
    // If i18n is present but not yet ready, wait for it before rendering to avoid key flicker
    try {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        if (api && api.ready && typeof api.ready.then === 'function' && !api.__proposalListWaited) {
            api.__proposalListWaited = true;
            return api.ready.then(() => renderProposalListModal()).catch(() => renderProposalListModal());
        }
    } catch (_) { }

    const host = document.getElementById('proposal-list-host');
    if (!host) return;
    const modal = ensureProposalListHostModal(host);

    // Ensure proposal list translations are loaded from JSON; if newly hydrated, re-render once.
    try {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        const currentLang = api && typeof api.getLanguage === 'function' ? api.getLanguage() : null;
        ensureProposalListTranslations(currentLang).then(hydrated => {
            if (hydrated) {
                // Avoid infinite loop: only re-render on the first hydration per language
                renderProposalListModal();
            }
        });
    } catch (_) { }

    const t = getProposalI18nHelper();

    const modalStrings = {
        title: t('modal.roadWidth.proposalList.title', 'Proposals'),
        closeAria: t('modal.roadWidth.proposalList.closeAria', 'Close proposals list'),
        tabs: {
            active: t('modal.roadWidth.proposalList.tabs.active', 'Active'),
            executed: t('modal.roadWidth.proposalList.tabs.executed', 'Executed')
        },
        filters: {
            goal: t('modal.roadWidth.proposalList.filters.goal', 'Goal'),
            search: t('modal.roadWidth.proposalList.filters.search', 'Search'),
            sort: t('modal.roadWidth.proposalList.filters.sort', 'Sort by'),
            searchPlaceholder: t('modal.roadWidth.proposalList.filters.searchPlaceholder', 'Search title or author'),
            reset: t('modal.roadWidth.proposalList.filters.reset', 'Reset'),
            resetTooltip: t('modal.roadWidth.proposalList.filters.resetTooltip', 'Reset filters')
        },
        sources: {
            local: t('modal.roadWidth.proposalList.sources.local', 'Local'),
            server: t('modal.roadWidth.proposalList.sources.server', 'Server')
        },
        loadingServer: t('modal.roadWidth.proposalList.loadingServer', 'Loading server proposals...'),
        serverError: t('modal.roadWidth.proposalList.serverError', 'Failed to load server proposals.'),
        retry: t('modal.roadWidth.proposalList.retry', 'Retry'),
        downloadError: t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal')
    };

    const goalOptions = getLocalizedProposalGoalFilters();
    const sortOptions = getLocalizedProposalSortOptions();

    const scrollPositions = { body: 0 };
    const existingBody = modal.querySelector('.proposal-list-modal-body');
    if (existingBody) {
        scrollPositions.body = existingBody.scrollTop;
    }

    let source = proposalListState.source || 'local';
    const cityCode = resolveCurrentCityCode();
    const area = typeof getProposalCountAreaContext === 'function' ? getProposalCountAreaContext() : null;
    const allStoredProposals = proposalStorage.getAllProposals();
    const allProposals = area?.explore && window.__proposalCounts?.proposalIntersectsBounds
        ? allStoredProposals.filter(proposal => window.__proposalCounts.proposalIntersectsBounds(proposal, area.bounds))
        : allStoredProposals;
    if (!proposalListState.sourceChosen) {
        source = proposalListState.source = allProposals.length ? 'local' : 'server';
    }

    const buildDatasets = (augmentedList) => {
        // Single list — lifecycle status and applied state are dropdown filters inside
        // applyProposalListFilters now, not Active/Executed tabs. `sorted` is what the list renders.
        const filtered = applyProposalListFilters(augmentedList);
        const sorted = sortProposalDataset(filtered);
        return {
            augmented: augmentedList,
            filtered,
            sorted
        };
    };

    const localAugmented = allProposals.map(proposal => ({
        proposal,
        metrics: computeProposalMetrics(proposal)
    }));
    const localDatasets = buildDatasets(localAugmented);

    // Server dataset handling
    const normalizedCity = area?.explore ? '' : normalizeCityCodeForApi(area?.city || cityCode);
    const cacheKey = area?.key || normalizedCity;
    if (serverProposalCache.lastCity && serverProposalCache.lastCity !== cacheKey) {
        resetServerProposalCache(cacheKey);
    }
    // Always fetch count/summaries once per city so the server tab badge is populated immediately.
    // Keyed on "did we ask?" rather than "is count null?": a failed fetch leaves count null, and
    // this function is re-entered from that fetch's own finally block.
    const needsFetch = serverProposalCache.lastCity !== cacheKey || !serverProposalCache.lastFetchedAt;
    if (!serverProposalCache.loading && needsFetch) {
        fetchServerProposalSummaries(normalizedCity);
    } else if (source === 'server') {
        ensureServerProposals(normalizedCity);
    }

    const serverAugmented = (serverProposalCache.proposals || []).map(proposal => ({
        proposal,
        metrics: computeProposalMetrics(proposal)
    }));
    const serverDatasets = buildDatasets(serverAugmented);

    // Designs are local or published; none is minted (an agreement is, M3), so there is no chain source.
    const chosen = source === 'server' ? serverDatasets : localDatasets;

    const selectedId = proposalListState.selectedId;
    if (selectedId) {
        const isSelectedVisible = chosen.sorted.some(entry => getProposalKey(entry.proposal) === selectedId);
        if (!isSelectedVisible) {
            proposalListState.selectedId = null;
        }
    }

    const localCount = allProposals.length;
    const serverCount = serverProposalCache.count !== null && serverProposalCache.count !== undefined
        ? serverProposalCache.count
        : (serverDatasets.augmented.length || null);
    const serverCountLabel = serverProposalCache.loading && !serverCount
        ? '…'
        : (serverCount !== null ? serverCount : 0);


    // Publication belongs to a design; decisions and execution belong to agreements.
    const publicationFilterOptions = [
        { value: 'all', label: t('modal.roadWidth.proposalList.filters.publicationAll', 'Draft & published') },
        { value: 'draft', label: t('common.lifecycle.draft', 'Draft') },
        { value: 'published', label: t('common.lifecycle.published', 'Published') }
    ];
    const statusFilterLabel = t('modal.roadWidth.proposalList.filters.publication', 'Publication');

    // Fold filters on phones and short desktop windows to leave space for the list. The toggle's
    // badge counts active filters; tall desktops show the fields directly.
    const activeFilterCount = countActiveProposalListFilters(proposalListState);
    const filtersOpen = proposalListState.filtersOpen === true;
    const filtersToggleLabel = t('modal.roadWidth.proposalList.filters.toggle', 'Filters');
    const filtersToggleHtml = `
        <div class="proposal-filters-toggle-row">
            <button type="button" class="btn btn-sm btn-quiet proposal-filters-toggle" aria-expanded="${filtersOpen ? 'true' : 'false'}" aria-controls="proposal-list-controls">
                <i class="fas fa-sliders-h" aria-hidden="true"></i>
                <span data-i18n-key="modal.roadWidth.proposalList.filters.toggle">${escapeHtml(filtersToggleLabel)}</span>
                ${activeFilterCount ? `<span class="cb-badge cb-badge--count proposal-filters-badge">${activeFilterCount}</span>` : ''}
                <i class="fas fa-chevron-down proposal-filters-chevron" aria-hidden="true"></i>
            </button>
        </div>
    `;

    const controlsHtml = `
        <div class="proposal-list-controls${filtersOpen ? '' : ' is-collapsed'}" id="proposal-list-controls">
            <div class="proposal-filter-group">
                <select id="proposal-filter-type" aria-label="${escapeHtml(modalStrings.filters.goal)}">
                    ${goalOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.filterType ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.filters.goals.${option.value}">${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <select id="proposal-filter-publication" aria-label="${escapeHtml(statusFilterLabel)}">
                    ${publicationFilterOptions.map(o => `<option value="${o.value}" ${o.value === (proposalListState.publicationFilter || 'all') ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-filter-search" data-i18n-key="modal.roadWidth.proposalList.filters.search">${escapeHtml(modalStrings.filters.search)}</label>
                <input type="text" id="proposal-filter-search" placeholder="${escapeHtml(modalStrings.filters.searchPlaceholder)}" data-i18n-key="modal.roadWidth.proposalList.filters.searchPlaceholder" data-i18n-attr="placeholder" value="${escapeHtml(proposalListState.searchText)}">
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-sort" data-i18n-key="modal.roadWidth.proposalList.filters.sort">${escapeHtml(modalStrings.filters.sort)}</label>
                <select id="proposal-sort">
                    ${sortOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.sortKey ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.sort.${PROPOSAL_SORT_I18N_KEYS[option.value] || option.value}">${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </div>
        </div>
    `;

    const sourceToggleHtml = `
        <div class="cb-segmented cb-segmented--fill proposal-source-toggle" role="group">
            <button type="button" class="cb-segmented__option proposal-source-btn" aria-pressed="${source === 'local' ? 'true' : 'false'}" data-source="local">
                ${escapeHtml(modalStrings.sources.local)} (${localCount})
            </button>
            <button type="button" class="cb-segmented__option proposal-source-btn" aria-pressed="${source === 'server' ? 'true' : 'false'}" data-source="server">
                ${escapeHtml(modalStrings.sources.server)} (${serverCountLabel !== null ? serverCountLabel : '0'})
            </button>
        </div>
    `;

    const showServerLoading = source === 'server' && serverProposalCache.loading && chosen.sorted.length === 0;
    const showServerError = source === 'server' && !serverProposalCache.loading && serverProposalCache.error;

    const loadingHtml = `<div class="proposal-list-loading">${escapeHtml(modalStrings.loadingServer)}</div>`;
    const errorHtml = `<div class="proposal-list-error">${escapeHtml(modalStrings.serverError)} <button class="proposal-server-retry">${escapeHtml(modalStrings.retry)}</button></div>`;

    const buildTabContent = (sortedList) => {
        if (showServerError) return errorHtml;
        if (showServerLoading) return loadingHtml;
        return buildProposalListItemsHtml(sortedList, {
            source,
            downloadedLookup: isServerProposalDownloaded
        });
    };

    // A live-search re-render replaces innerHTML, destroying the focused filter field. Remember which
    // field held focus and its caret so we can restore both afterwards, so typing never loses the
    // field. On the open action, showAllProposalsModal sets a one-shot autofocus flag (honored here
    // rather than there because the render can be deferred until i18n is ready).
    const autofocusSearch = proposalListState.autofocusSearch === true;
    const prevActive = document.activeElement;
    const focusFieldId = (prevActive && modal.contains(prevActive) && prevActive.id)
        ? prevActive.id
        : (autofocusSearch ? 'proposal-filter-search' : null);
    const focusSelStart = (focusFieldId && !autofocusSearch && prevActive) ? prevActive.selectionStart : null;
    const focusSelEnd = (focusFieldId && !autofocusSearch && prevActive) ? prevActive.selectionEnd : null;

    modal.innerHTML = `
        <div class="proposal-list-modal-content">
            ${sourceToggleHtml}
            ${filtersToggleHtml}
            ${controlsHtml}
            <div class="proposal-list-modal-body">
                <div id="proposals-list" class="proposal-tab-content">
                    ${buildTabContent(chosen.sorted)}
                </div>
            </div>
        </div>
    `;

    // Restore focus (+ caret) to the filter field that had it before this rebuild — see capture above.
    if (focusFieldId) {
        const field = modal.querySelector('#' + focusFieldId);
        if (field) {
            field.focus();
            try {
                if (autofocusSearch) {
                    const end = field.value.length;
                    field.setSelectionRange(end, end);
                } else if (focusSelStart != null) {
                    field.setSelectionRange(focusSelStart, focusSelEnd);
                }
            } catch (_) { }
        }
    }
    // One-shot: the autofocus request is consumed by the first render after opening.
    if (autofocusSearch) proposalListState.autofocusSearch = false;

    // Run DOM-based translations to mirror agent modal behavior
    try {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
            window.i18n.applyTranslations(modal);
        }
    } catch (_) { }

    // Fix any nodes that still show raw keys by falling back to the strings we already resolved
    try {
        const fallbackMap = new Map();
        fallbackMap.set('modal.roadWidth.proposalList.title', modalStrings.title);
        fallbackMap.set('modal.roadWidth.proposalList.closeAria', modalStrings.closeAria);
        fallbackMap.set('modal.roadWidth.proposalList.tabs.active', modalStrings.tabs.active);
        fallbackMap.set('modal.roadWidth.proposalList.tabs.executed', modalStrings.tabs.executed);
        fallbackMap.set('modal.roadWidth.proposalList.filters.goal', modalStrings.filters.goal);
        fallbackMap.set('modal.roadWidth.proposalList.filters.search', modalStrings.filters.search);
        fallbackMap.set('modal.roadWidth.proposalList.filters.sort', modalStrings.filters.sort);
        fallbackMap.set('modal.roadWidth.proposalList.filters.searchPlaceholder', modalStrings.filters.searchPlaceholder);
        fallbackMap.set('modal.roadWidth.proposalList.sources.local', modalStrings.sources.local);
        fallbackMap.set('modal.roadWidth.proposalList.sources.server', modalStrings.sources.server);
        fallbackMap.set('modal.roadWidth.proposalList.loadingServer', modalStrings.loadingServer);
        fallbackMap.set('modal.roadWidth.proposalList.serverError', modalStrings.serverError);
        fallbackMap.set('modal.roadWidth.proposalList.retry', modalStrings.retry);
        fallbackMap.set('modal.roadWidth.proposalList.downloadError', modalStrings.downloadError);
        // Goal options
        goalOptions.forEach(option => {
            const key = `modal.roadWidth.proposalList.filters.goals.${option.value}`;
            fallbackMap.set(key, option.label);
        });
        // Sort options
        sortOptions.forEach(option => {
            const mapKey = PROPOSAL_SORT_I18N_KEYS[option.value] || option.value;
            const key = `modal.roadWidth.proposalList.sort.${mapKey}`;
            fallbackMap.set(key, option.label);
        });

        const nodes = modal.querySelectorAll('[data-i18n-key]');
        nodes.forEach(node => {
            const key = node.getAttribute('data-i18n-key') || '';
            if (!key) return;
            const currentText = node.textContent ? node.textContent.trim() : '';
            if (currentText === key && fallbackMap.has(key)) {
                node.textContent = fallbackMap.get(key);
            }
            const attrList = (node.getAttribute('data-i18n-attr') || '').split(',').map(s => s.trim()).filter(Boolean);
            attrList.forEach(attr => {
                if (node.getAttribute && node.getAttribute(attr) === key && fallbackMap.has(key)) {
                    node.setAttribute(attr, fallbackMap.get(key));
                }
            });
        });
    } catch (_) { }

    // Keep the sidebar button count in sync when server data arrives
    try { updateShowProposalsButton(); } catch (_) { }

    const typeSelect = modal.querySelector('#proposal-filter-type');
    if (typeSelect) {
        typeSelect.addEventListener('change', event => {
            proposalListState.filterType = event.target.value;
            renderProposalListModal();
        });
    }

    // Debounce filter typing: full re-render replaces innerHTML and would drop input focus
    // mid-keystroke. 280ms is below "feels laggy" but coalesces typing bursts comfortably.
    const searchInput = modal.querySelector('#proposal-filter-search');
    if (searchInput) {
        searchInput.addEventListener('input', event => {
            proposalListState.searchText = event.target.value;
            scheduleDebouncedProposalListModalRender();
        });
    }

    const filtersToggle = modal.querySelector('.proposal-filters-toggle');
    if (filtersToggle) {
        // Toggled in place (not re-rendered) so the open state costs no rebuild; the state flag
        // carries it across the next render.
        filtersToggle.addEventListener('click', () => {
            proposalListState.filtersOpen = !(proposalListState.filtersOpen === true);
            filtersToggle.setAttribute('aria-expanded', proposalListState.filtersOpen ? 'true' : 'false');
            const controls = modal.querySelector('.proposal-list-controls');
            if (controls) controls.classList.toggle('is-collapsed', !proposalListState.filtersOpen);
        });
    }

    const sortSelect = modal.querySelector('#proposal-sort');
    if (sortSelect) {
        sortSelect.addEventListener('change', event => {
            proposalListState.sortKey = event.target.value;
            renderProposalListModal();
        });
    }

    modal.querySelectorAll('.proposal-source-btn').forEach(button => {
        button.addEventListener('click', event => {
            const nextSource = event.currentTarget.getAttribute('data-source');
            if (!nextSource || proposalListState.source === nextSource) return;
            proposalListState.source = nextSource;
            proposalListState.sourceChosen = true;
            if (nextSource === 'server') {
                ensureServerProposals(resolveCurrentCityCode());
            }
            renderProposalListModal();
        });
    });

    const retryButton = modal.querySelector('.proposal-server-retry');
    if (retryButton) {
        retryButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            ensureServerProposals(resolveCurrentCityCode(), { force: true });
        });
    }

    const lifecycleSelect = modal.querySelector('#proposal-filter-publication');
    if (lifecycleSelect) {
        lifecycleSelect.addEventListener('change', event => {
            proposalListState.publicationFilter = event.target.value;
            renderProposalListModal();
        });
    }

    modal.querySelectorAll('.proposal-list-item').forEach(item => {
        item.addEventListener('click', handleProposalListItemClick);
    });

    modal.querySelectorAll('.proposal-list-details-btn').forEach(button => {
        // A server proposal downloads before its panel opens: the button spins meanwhile.
        button.addEventListener('click', event => BusyControl.track(button, () => handleProposalListDetailsClick(event)));
    });

    modal.querySelectorAll('.proposal-download-btn').forEach(button => {
        button.addEventListener('click', handleProposalDownloadClick);
    });

    const bodyEl = modal.querySelector('.proposal-list-modal-body');
    if (bodyEl) {
        bodyEl.scrollTop = scrollPositions.body;
    }

    // Vremenska crta plana (epoch buckets) — crta se samo kad neka epoha postoji.
    // Epoha pojedinog prijedloga se postavlja izbornikom na njegovoj kartici.
    try {
        if (window.__proposalEpoch) window.__proposalEpoch.injectTimeline(modal);
    } catch (_) { }

    if (proposalListState.selectedId) {
        const selectedEl = Array.from(modal.querySelectorAll('.proposal-list-item'))
            .find(el => el.getAttribute('data-proposal-id') === String(proposalListState.selectedId));
        if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }
}

async function showAllProposalsModal() {
    return openDesignsTab('browse');
}

// --- Applied-composition sharing panel ----------------------------------------------------------
// Sharing lives in the Designs panel alongside the design list. The map stays visible so the
// applied composition can be read spatially while selecting designs.
// While the panel is open it picks on the map (js/map-pick.js, MapPick 'share'): the map is pan/zoom
// ONLY — parcels and proposals are click/hover-inert, the sidebar and mode switches are disabled (CSS
// lockdown via body.map-pick-mode), and a click on an applied design finds its row. The subset
// switch paints the CHECKED designs that are published, or not yet, in their rows' colours in
// MapPick's highlight pane; hovering or clicking a row outlines that proposal (click also frames
// it). No interaction opens details.

const SHARE_PLAN_COLORS = [
    '#e6194B', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
    '#f032e6', '#bfef45', '#469990', '#9A6324', '#800000', '#000075'
];

// Hovering a row answers two questions, and they have two different answers: WHERE the proposal
// stands (the parcels it occupies) and WHAT it is (its own body — the building footprint, the
// corridor surface, the park). One colour for both made a hovered building indistinguishable from
// its neighbours' boundaries, so the body gets its own colour and is drawn last, filled, on top.
const SHARE_PLAN_HOVER_PARCEL_COLOR = '#FFEB3B'; // parcels involved — dashed, hollow
const SHARE_PLAN_HOVER_BODY_COLOR = '#00E5FF';   // the proposal itself — solid, lightly filled

let _sharePlanPanelState = null; // { root, token }

function sharePlanColorForIndex(index) {
    const n = SHARE_PLAN_COLORS.length;
    return SHARE_PLAN_COLORS[((index % n) + n) % n];
}

function closeSharePlanPanel(options = {}) {
    const state = _sharePlanPanelState;
    _sharePlanPanelState = null;
    // The pick mode ends with the panel (js/map-pick.js): the lockdown lifts, a subset's highlight
    // and the dimming go, and a map click no longer answers into a list that is not on screen.
    try { window.MapPick.end('share'); } catch (error) { console.error('share plan: ending the map pick failed', error); }
    if (state) {
        try { if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root); } catch (_) { }
        if (!options.fromPanel && window.MapShell?.isOpen('proposals-sheet')) window.MapShell.closeSheet({ restoreFocus: true });
    }
    try { if (typeof clearProposalHoverLayers === 'function') clearProposalHoverLayers(); } catch (_) { }
}

// Returns a promise that settles once the panel is worth LOOKING at — rows listed and the map
// fitted — so a caller can hold its own dialog up until then instead of dropping the user onto a
// half-built map. Whether each design is published is known here (its record hashes to the CID it
// was published as, DesignSync.publishedCid), so no row waits on the server.
//
// options.onProgress(text) receives the same progress line the panel shows, because while the
// caller's dialog is up the panel is behind it and cannot be read.
function showSharePlanPanel(options) {
    const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
    const readySignal = (typeof __readySignal === 'object' && __readySignal)
        ? __readySignal.createReadySignal()
        : require('./ready-signal.js').createReadySignal();
    // Set the moment the async fill takes over. Everything else — an early return, a throw — has
    // already finished by the time the `finally` below runs, and settles there. One place rather
    // than one per `return` is the point: a return added later cannot leave a caller spinning.
    let fillStarted = false;
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (typeof proposalStorage === 'undefined') return;
        const shareView = window.MapShare.capture(window);
        const applied = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied);
        const proposalsByHash = new Map();
        applied.forEach(proposal => {
            const key = proposal.proposalId || getProposalKey(proposal);
            if (!key) return;
            proposalsByHash.set(String(key), proposal);
        });
        if (applied.length > 0 && proposalsByHash.size === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.unable_to_prepare_proposals_for_sharing', 'Unable to prepare proposals for sharing.'), 5000, 'error');
            }
            return;
        }

        closeSharePlanPanel({ fromPanel: true });
        if (!window.MapShell.isOpen('proposals-sheet')) window.MapShell.openSheet('proposals-sheet');
        closeProposalList({ fromSheet: true });
        setDesignsPanelTab('share');
        resetParcelSelectionForProposalListInteraction();
        clearProposalInfoHoverOverlay();

        // An unpublished parcel layout needs an agreement; an existing publication can be linked.
        const publishRefusals = new Map();
        // Every applied design starts selected. Excluding a blocked design is an explicit choice.
        const selected = new Set(proposalsByHash.keys());
        // key -> { cid: the CID the design is published as here, or null; publishing }
        const publishState = new Map();
        const isPublished = key => !!(publishState.get(key) || {}).cid;
        const rowControls = new Map();

        const colorByKey = new Map();
        Array.from(proposalsByHash.keys()).forEach((key, index) => {
            colorByKey.set(key, sharePlanColorForIndex(index));
        });

        // Sharing controls stay in the header; only the design list scrolls.
        const panelRoot = document.createElement('div');
        panelRoot.className = 'share-plan-panel share-plan-panel--embedded';
        const panelContent = document.createElement('div');
        panelContent.className = 'share-plan-panel-content';
        panelRoot.appendChild(panelContent);
        const toolbar = document.createElement('div');
        toolbar.className = 'share-plan-toolbar';
        panelContent.appendChild(toolbar);

        // Which subset to highlight on the map. The map ALREADY draws every applied design, so "All"
        // is the view you arrived with and paints nothing extra; the other two highlight the
        // published or the not-yet-published designs on top of it. Switching adds and removes a
        // Leaflet layer GROUP: the overlays are built once, on the first switch away from All.
        const filterRow = document.createElement('div');
        filterRow.className = 'share-plan-filter';
        const HIGHLIGHT_MODES = [
            { value: 'all', key: 'modal.roadWidth.share.plan.filterAll', fallback: 'All' },
            { value: 'published', key: 'proposals.share.panel.filterPublished', fallback: 'Published' },
            { value: 'pending', key: 'proposals.share.panel.filterPending', fallback: 'Not published yet' }
        ];
        let highlightMode = 'all';
        const modeButtons = new Map();
        // A cb-segmented control (css/primitives.css); share-plan-mode-btn stays as the hook.
        const modeWrap = document.createElement('div');
        modeWrap.className = 'cb-segmented share-plan-mode-switch';
        modeWrap.setAttribute('role', 'group');
        modeWrap.setAttribute('aria-label', tShare('plan.filterLabel', 'Highlight on the map'));
        HIGHLIGHT_MODES.forEach(mode => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'cb-segmented__option share-plan-mode-btn';
            button.textContent = t(mode.key, mode.fallback);
            button.setAttribute('aria-pressed', String(mode.value === highlightMode));
            button.addEventListener('click', () => { setHighlightMode(mode.value); });
            modeButtons.set(mode.value, button);
            modeWrap.appendChild(button);
        });
        filterRow.appendChild(modeWrap);
        filterRow.hidden = shareView.mode !== '2d' || !applied.length;
        toolbar.appendChild(filterRow);

        const container = document.createElement('div');
        container.className = 'share-plan-panel-body';
        panelContent.appendChild(container);

        // A subset is painted by the pick mode's highlight (js/map-pick.js): the CHECKED designs of
        // the chosen subset, each in its row's colour, in a pane above the fabric while every other
        // pane dims — painting a subset over the base drawing answered nothing on a 298-member plan,
        // where the whole city is already blue. "All" is the view you arrived with and paints nothing
        // extra. A design's outline is built the first time a subset needs it and kept while the
        // panel is open; publishing only restyles it.
        //
        // Already published, or still only here? Shown as SOLID versus DASHED rather than as two
        // colours: every design already owns a colour to tell it from its neighbours, so a second
        // colour axis would collide with the first. A dashed, fainter shape reads as provisional,
        // which is exactly what "not published yet" is.
        const overlayStyleFor = (published, color) => ({
            color,
            weight: published ? 2 : 3,
            dashArray: published ? null : '7 6',
            fillColor: color,
            // 0.40 against 0.10, not 0.35 against 0.14: over aerial imagery a quarter of a step in
            // opacity is not a difference anyone can see, and the dash is the only other cue on a
            // shape too small to show one.
            fillOpacity: published ? 0.40 : 0.10
        });

        // What the highlight shows: nothing extra for All, else the checked designs of the subset.
        const highlightedKeys = () => (!highlightMode || highlightMode === 'all'
            ? null
            : [...selected].filter(key => (highlightMode === 'published') === isPublished(key)));

        // Switching subsets repaints the highlight. The first switch builds the outlines in
        // frame-sized slices (MapPick.refresh): three hundred overlays in one task is the freeze this
        // panel was rebuilt to avoid.
        const applyHighlightMode = async () => {
            modeButtons.forEach(button => { button.disabled = true; });
            const finished = await window.MapPick.refresh();
            modeButtons.forEach(button => { button.disabled = false; });
            if (finished === false) return; // the panel closed, or a newer repaint took over
            if (highlightMode) setStatus('');
        };

        const setHighlightMode = (mode) => {
            if (highlightMode === mode) return;
            highlightMode = mode;
            if (mode) {
                clearPickedRow();
                clearProposalHoverLayers();
            }
            modeButtons.forEach((button, value) => button.setAttribute('aria-pressed', String(value === mode)));
            applyHighlightMode();
        };

        // The panel's own key for a proposal, formed exactly as proposalsByHash was built. A proposal
        // arriving from a map click is the same object the panel already holds, but it must be
        // looked up the same way or it will not be found.
        const keyOfProposal = (proposal) => {
            if (!proposal) return null;
            const key = proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null);
            return key ? String(key) : null;
        };

        // Bring a row into view and say, unmistakably, which one it is: scrolled to, marked, and
        // outlined on the map. The mark is removed from whatever held it last so two rows are never
        // both claiming to be the picked one.
        let pickedRowKey = null;
        const clearPickedRow = () => {
            const controls = rowControls.get(pickedRowKey);
            if (controls) {
                controls.row.classList.remove('is-picked');
                controls.focusButton.setAttribute('aria-pressed', 'false');
            }
            pickedRowKey = null;
        };
        const revealRow = (key, parcelId) => {
            const controls = rowControls.get(key);
            if (!controls || !controls.row) return;
            // A single focus replaces the group overlay without changing share inclusion.
            setHighlightMode(null);
            if (pickedRowKey && pickedRowKey !== key) {
                const previous = rowControls.get(pickedRowKey);
                if (previous && previous.row) {
                    previous.row.classList.remove('is-picked');
                    previous.focusButton.setAttribute('aria-pressed', 'false');
                }
            }
            pickedRowKey = key;
            controls.row.classList.add('is-picked');
            controls.focusButton.setAttribute('aria-pressed', 'true');
            try { controls.row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {
                try { controls.row.scrollIntoView(); } catch (_) { }
            }
            highlightRowProposal(key);
            const title = (proposalsByHash.get(key) || {}).title || key;
            setStatus(parcelId
                ? tShare('plan.pickedOnMap', 'Selected {{title}} — {{parcel}}', { title, parcel: String(parcelId) })
                : tShare('plan.picked', 'Selected {{title}}', { title }));
        };

        const highlightRowProposal = (key) => {
            const proposal = proposalsByHash.get(key);
            if (!proposal) return;
            if (typeof highlightFeatureGroupsForHover !== 'function') return;
            const published = isPublished(key);
            // The shapes the highlight paints (js/map-pick.js), so hover outlines exactly that.
            const bodyFeatures = window.MapPick.bodyOf(proposal);
            const parcelFeatures = window.MapPick.groundOf(window.MapPick.parcelsOf(proposal), bodyFeatures);
            highlightFeatureGroupsForHover([
                {
                    features: parcelFeatures,
                    color: SHARE_PLAN_HOVER_PARCEL_COLOR,
                    weight: 6,
                    dashArray: '10 8',
                    showLabels: false
                },
                {
                    // Last, so the body sits above the parcels rather than under them.
                    //
                    // Solid and filled when it is published, dashed and hollow when it is still only
                    // here — the same language the subset filter and the plan overlay use. This is
                    // the surface that actually gets looked at: the overlay repaints on a CHECKBOX
                    // toggle, and every row starts checked, so unless you untick and retick a row the
                    // overlay never runs and the publication state was invisible.
                    features: bodyFeatures,
                    color: SHARE_PLAN_HOVER_BODY_COLOR,
                    weight: published ? 4 : 5,
                    dashArray: published ? null : '8 6',
                    fillColor: SHARE_PLAN_HOVER_BODY_COLOR,
                    fillOpacity: published ? 0.35 : 0.05,
                    showLabels: false
                }
            ]);
        };

        const frameRowProposal = (key) => {
            const proposal = proposalsByHash.get(key);
            if (!proposal || typeof map === 'undefined' || !map) return;
            let bounds = null;
            try {
                if (typeof resolveStandaloneProposalFocusBounds === 'function') {
                    bounds = resolveStandaloneProposalFocusBounds(proposal);
                }
            } catch (_) { }
            if (!bounds) {
                try {
                    const features = window.MapPick.parcelsOf(proposal);
                    if (features.length) bounds = L.geoJSON({ type: 'FeatureCollection', features }).getBounds();
                } catch (_) { }
            }
            if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return;
            const padding = (typeof getProposalPanelFitPadding === 'function')
                ? getProposalPanelFitPadding(40)
                : { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] };
            if (window.matchMedia?.('(max-width: 767.98px)').matches) {
                if (document.getElementById('proposals-sheet').getBoundingClientRect().top < 24) document.getElementById('proposals-sheet').querySelector(':scope > .mobile-dock-sheet-handle')?.click();
                const mapBox = map.getContainer().getBoundingClientRect();
                padding.paddingTopLeft = [40, Math.max(padding.paddingTopLeft?.[1] || 0, 72)];
                padding.paddingBottomRight = [40, Math.max(padding.paddingBottomRight?.[1] || 0, mapBox.bottom - document.getElementById('proposals-sheet').getBoundingClientRect().top + 24)];
            }
            // animate:false — deterministic, and immune to background-tab rAF throttling.
            try { map.fitBounds(bounds, { ...padding, maxZoom: 18, animate: false }); } catch (_) { }
        };


        const countLine = document.createElement('p');
        countLine.className = 'share-plan-count';
        countLine.textContent = t('proposals.share.panel.count', '{{count}} designs applied on this map', { count: proposalsByHash.size });
        toolbar.appendChild(countLine);

        const statusLine = document.createElement('p');
        statusLine.className = 'share-plan-status';
        statusLine.setAttribute('role', 'status');
        statusLine.setAttribute('aria-live', 'polite');
        toolbar.appendChild(statusLine);

        // The panel opens before its rows know anything; listing and checking a large plan counts
        // itself out loud instead of leaving rows to flicker.
        const progressRow = document.createElement('div');
        progressRow.className = 'share-plan-progress';
        progressRow.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span></span>';
        const progressText = progressRow.querySelector('span');
        toolbar.appendChild(progressRow);

        const listWrap = document.createElement('div');
        listWrap.className = 'share-plan-list';
        listWrap.hidden = !applied.length;
        container.appendChild(listWrap);

        // The link to the selection, shown once every selected design is published.
        const shareArea = document.createElement('div');
        shareArea.className = 'share-plan-share-area';
        const linkRow = document.createElement('div');
        linkRow.className = 'share-plan-link';
        linkRow.hidden = true;
        const linkInput = document.createElement('input');
        linkInput.type = 'text';
        linkInput.readOnly = true;
        linkInput.className = 'share-plan-link__input';
        linkInput.setAttribute('aria-label', applied.length ? t('proposals.share.panel.linkLabel', 'Link to the selected designs') : t('mapShell.shareMap', 'Share this map'));
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn';
        copyBtn.textContent = tShare('copyUrlButton', 'Copy URL');
        copyBtn.addEventListener('click', async () => {
            if (!linkInput.value) return;
            if (await window.DesignSync.copyLink(linkInput.value)) {
                showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
            } else {
                linkInput.focus();
                linkInput.select();
            }
        });
        linkRow.append(linkInput, copyBtn);
        shareArea.appendChild(linkRow);
        const publishSelected = document.createElement('button');
        publishSelected.type = 'button';
        publishSelected.className = 'btn btn-primary share-plan-publish-selected';
        publishSelected.textContent = t('proposals.share.panel.publishSelected', 'Publish selected designs');
        publishSelected.hidden = true;
        shareArea.appendChild(publishSelected);
        const agreementAction = document.createElement('button');
        agreementAction.type = 'button';
        agreementAction.className = 'btn share-plan-create-agreement';
        agreementAction.textContent = t('agreement.list.create', 'Create agreement');
        agreementAction.hidden = true;
        agreementAction.addEventListener('click', () => {
            const designIds = [...selected];
            closeSharePlanPanel();
            Promise.resolve(window.AgreementDialog.open({ designIds })).catch(error => {
                console.error(`[${new Date().toISOString()}] [share-plan] opening agreement failed`, error);
                showEphemeralMessage(error.message, 5000, 'error');
            });
        });
        shareArea.appendChild(agreementAction);
        toolbar.prepend(shareArea);

        const setStatus = (message) => {
            statusLine.textContent = message || '';
        };

        // The link names the selected designs by CID: /designs/<cid>,<cid>, sorted.
        const updateShareUrl = () => {
            const selectedKeys = Array.from(selected);
            countLine.textContent = !proposalsByHash.size ? t('proposals.share.panel.count', '{{count}} designs applied on this map', { count: 0 }) : t('proposals.share.panel.selectionCount', '{{selected}} of {{total}} designs included · {{excluded}} excluded', {
                selected: selectedKeys.length, total: proposalsByHash.size, excluded: proposalsByHash.size - selectedKeys.length
            });
            const pendingKeys = selectedKeys.filter(key => !isPublished(key));
            const blockedKeys = pendingKeys.filter(key => publishRefusals.has(key));
            publishSelected.hidden = !pendingKeys.some(key => !publishRefusals.has(key));
            publishSelected.disabled = selectedKeys.some(key => publishState.get(key)?.publishing);
            agreementAction.hidden = !blockedKeys.some(key => publishRefusals.get(key)?.code === 'layout-needs-agreement');
            const showLink = url => {
                linkInput.value = url || '';
                linkRow.hidden = !url;
            };
            if (!selectedKeys.length) {
                showLink(proposalsByHash.size ? null : window.MapShare.link(window.resolveFrontendBaseUrl(), shareView));
                setStatus(proposalsByHash.size ? t('proposals.share.panel.selectHint', 'Select at least one design to share.') : '');
                return;
            }
            if (selectedKeys.some(key => (publishState.get(key) || {}).publishing)) {
                showLink(null);
                setStatus(t('proposals.share.panel.publishing', 'Publishing…'));
                return;
            }
            const cids = selectedKeys.map(key => (publishState.get(key) || {}).cid).filter(Boolean);
            if (cids.length !== selectedKeys.length) {
                showLink(null);
                const blockedKey = blockedKeys[0];
                const blockedMessage = blockedKey && publishRefusals.get(blockedKey)?.code === 'layout-needs-agreement'
                    ? t('proposals.share.panel.layoutNeedsAgreement', '{{title}} is published with its agreement. Create an agreement that includes it, or deselect it to share the other designs.', {
                        title: proposalsByHash.get(blockedKey)?.title || t('proposals.share.untitled', 'Untitled design')
                    })
                    : publishRefusals.get(blockedKey)?.message;
                setStatus(blockedKeys.length ? blockedMessage : cids.length
                    ? t('proposals.share.panel.publishHint', 'Publish every selected design to get the link, or deselect some.')
                    : t('proposals.share.panel.noPublishedHint', 'Publish at least one design to get a link.'));
                return;
            }
            showLink(window.MapShare.link(window.DesignSync.designLink(cids), shareView));
            setStatus('');
        };

        const updateRowState = (key) => {
            const controls = rowControls.get(key);
            if (!controls) return;
            const state = publishState.get(key) || { cid: null, publishing: false };
            controls.publishBtn.hidden = !!state.cid;
            controls.publishedLabel.hidden = !state.cid;
            controls.publishBtn.disabled = !!state.publishing || publishRefusals.has(key);
            controls.publishBtn.textContent = state.publishing
                ? t('proposals.share.panel.publishing', 'Publishing…')
                : t('proposals.share.panel.publish', 'Publish');
            controls.checkbox.checked = selected.has(key);
            controls.row.classList.toggle('is-excluded', !selected.has(key));
            controls.row.classList.toggle('is-published', !!state.cid);
            // The map says the same thing the row says.
            window.MapPick.refresh([key]);
        };

        const onCheckboxChange = (key, checked) => {
            if (checked) selected.add(key);
            else selected.delete(key);
            // Toggling a row paints or unpaints THAT row (updateRowState repaints its highlight). The
            // map is not painted when the panel opens (see the fill below) — checked means "in the
            // plan", not "drawn right now".
            updateRowState(key);
            setStatus('');
            updateShareUrl();
        };

        const publishRow = async (key) => {
            const proposal = proposalsByHash.get(key);
            if (!proposal || publishRefusals.has(key)) return;
            publishState.set(key, { cid: (publishState.get(key) || {}).cid || null, publishing: true });
            updateRowState(key);
            updateShareUrl();
            try {
                const { cid } = await window.DesignSync.publishDesign(proposal);
                proposalsByHash.set(key, proposalStorage.getProposal(key) || proposal);
                publishState.set(key, { cid, publishing: false });
            } catch (error) {
                publishState.set(key, { cid: null, publishing: false });
                if (!(error && error.cancelled)) {
                    console.error(`[${new Date().toISOString()}] [share-plan] publishing ${key} failed`, error);
                    setStatus((error && error.message) || t('proposals.share.errors.failed', 'The design could not be published.'));
                }
            }
            updateRowState(key);
            if (!(publishState.get(key) || {}).cid) return false;
            updateShareUrl();
            return true;
        };

        // Publish sequentially, stop on the first failure and retain completed rows for retry.
        publishSelected.addEventListener('click', async () => {
            publishSelected.disabled = true;
            for (const key of [...selected]) {
                if (!_sharePlanPanelState || _sharePlanPanelState.root !== panelRoot) break;
                if (isPublished(key) || publishRefusals.has(key)) continue;
                if (!await publishRow(key)) break;
            }
            publishSelected.disabled = false;
        });

        const attachRow = (proposal, key) => {
            const row = document.createElement('div');
            row.className = 'share-plan-row';

            const main = document.createElement('button');
            main.type = 'button';
            main.className = 'btn btn-quiet share-plan-row__main';
            main.setAttribute('aria-pressed', 'false');

            const refusal = publishRefusals.get(key) || null;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(key);
            checkbox.setAttribute('aria-label', proposal.title || proposal.name || tShare('untitled', '(Untitled)'));
            checkbox.addEventListener('change', () => onCheckboxChange(key, checkbox.checked));
            const selection = document.createElement('label');
            selection.className = 'share-plan-row__selection';
            selection.appendChild(checkbox);

            // The chip (a cb-badge) carries the exact colour this design is painted with on the map:
            // data, so it is a custom property the stylesheet reads.
            const chip = document.createElement('span');
            chip.className = 'cb-badge share-plan-color-chip';
            chip.setAttribute('aria-hidden', 'true');
            chip.style.setProperty('--share-plan-color', colorByKey.get(key) || '#4363d8');

            const text = document.createElement('span');
            text.className = 'share-plan-row__text';
            const name = document.createElement('span');
            name.className = 'share-plan-row__title';
            name.textContent = proposal.title || proposal.name || tShare('untitled', '(Untitled)');
            const meta = document.createElement('span');
            meta.className = 'share-plan-row__meta';
            meta.textContent = formatProposalTypeLabel(resolveProposalGoalKey(proposal) || 'other');
            text.append(name, meta);
            if (refusal) {
                const note = document.createElement('span');
                note.className = 'share-plan-row__refusal';
                note.textContent = refusal.message;
                text.appendChild(note);
            }
            main.append(chip, text);

            const actions = document.createElement('div');
            actions.className = 'share-plan-row__actions';
            const publishBtn = document.createElement('button');
            publishBtn.type = 'button';
            publishBtn.className = 'btn btn-sm';
            publishBtn.textContent = t('proposals.share.panel.publish', 'Publish');
            if (refusal) {
                publishBtn.disabled = true;
                publishBtn.title = refusal.message;
            }
            publishBtn.addEventListener('click', () => publishRow(key));
            const publishedLabel = document.createElement('span');
            publishedLabel.className = 'cb-badge cb-badge--published share-plan-row__published';
            publishedLabel.textContent = t('proposals.share.panel.published', 'Published');
            publishedLabel.hidden = true;
            actions.append(publishBtn, publishedLabel);

            row.append(selection, main, actions);

            // Focus belongs to the design button; inclusion belongs only to its checkbox.
            main.addEventListener('click', () => {
                revealRow(key);
                frameRowProposal(key);
            });

            listWrap.appendChild(row);
            rowControls.set(key, { row, checkbox, chip, publishBtn, publishedLabel, meta, focusButton: main });
        };

        const showProgress = (phraseKey, fallback, done, total) => {
            const text = t(phraseKey, fallback, { done, total });
            if (progressText) progressText.textContent = text;
            // Mirrored to the opener: its dialog is covering this panel until we are ready.
            if (onProgress) { try { onProgress(text); } catch (_) { } }
        };
        const clearProgress = () => {
            // Gone rather than hidden: finished work has nothing left to say, and a panel that
            // keeps a dead spinner reads as still working.
            if (progressRow && progressRow.parentNode) progressRow.parentNode.removeChild(progressRow);
        };

        // The panel goes up EMPTY and fills itself in, yielding a frame whenever it has held the
        // thread long enough, so the list grows in front of you and the map is never locked for
        // more than a frame.
        const FRAME_BUDGET_MS = 12;
        const nextFrame = () => new Promise(resolve => {
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
            else resolve();
        });
        // Closing the panel (or opening another) must stop the fill; otherwise a cancelled build
        // keeps drawing overlays onto a map that has moved on.
        const panelToken = {};
        const panelStillOpen = () => !!_sharePlanPanelState && _sharePlanPanelState.token === panelToken;

        const inChunks = async (items, step, phraseKey, fallback) => {
            const total = items.length;
            const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            let sliceStarted = now();
            for (let i = 0; i < total; i++) {
                if (!panelStillOpen()) return false;
                step(items[i], i);
                showProgress(phraseKey, fallback, i + 1, total);
                // The clock every step, not every Nth: one proposal's overlay can cost more than
                // the whole budget, and a budget consulted every 32nd item bounds nothing.
                if (now() - sliceStarted >= FRAME_BUDGET_MS) {
                    await nextFrame();
                    sliceStarted = now();
                }
            }
            return panelStillOpen();
        };


        document.getElementById('designs-share').replaceChildren(panelRoot);
        _sharePlanPanelState = { root: panelRoot, token: panelToken };

        // The panel picks on the map (js/map-pick.js): the lockdown starts, and clicking a design ON
        // THE MAP finds it in the list. The resolution from a click to its applied design is the
        // map's own (onParcelClick in parcels/ui/parcel-selection.js, the drill for corridors and
        // structures), which is why this is a callback rather than a second map handler racing it.
        if (shareView.mode === '2d' && applied.length) window.MapPick.begin({
            name: 'share',
            pick: (id, proposal, { parcelId }) => {
                if (!panelStillOpen()) return;
                const key = keyOfProposal(proposal) || id;
                if (!rowControls.has(key)) {
                    // Applied, but not in this plan: say so rather than silently doing nothing, which
                    // is indistinguishable from a click that missed.
                    setStatus(tShare('plan.pickedNotInPlan', 'That proposal is not in this plan.'));
                    return;
                }
                revealRow(key, parcelId);
            },
            highlight: highlightedKeys,
            style: key => overlayStyleFor(isPublished(key), colorByKey.get(key) || '#4363d8'),
            close: closeSharePlanPanel,
            onProgress: (done, total) => showProgress('proposals.share.panel.drawing', 'Drawing {{done}}/{{total}} designs on the map…', done, total)
        }).catch(error => console.error('share plan: highlighting on the map failed', error));

        fillStarted = true;
        (async () => {
            try {
                const entries = [...proposalsByHash.entries()];
                if (!await inChunks(entries, ([key, proposal]) => {
                    const cid = window.DesignSync.publishedCid(proposal);
                    publishState.set(key, { cid, publishing: false });
                    const refusal = cid ? null : window.ProposalPublishTerms.publishRefusal(proposal);
                    if (refusal) publishRefusals.set(key, refusal);
                    attachRow(proposal, key);
                },
                    'proposals.share.panel.listing', 'Listing {{done}}/{{total}} designs…')) return;

                // The map is NOT painted on open: overlays are what HOVER and CLICK are for, and
                // toggling a row still syncs its own overlay.
                // Keep the map/camera the user asked to share.

                // Rows have their publication/refusal state. The opener can release its busy indicator.
                readySignal.settle('ready');

                if (!await inChunks(entries, ([key, proposal]) => {
                    updateRowState(key);
                }, 'proposals.share.panel.checking', 'Checking {{done}}/{{total}} designs…')) return;
                updateShareUrl();
            } catch (error) {
                console.error('share plan: filling the panel failed', error);
                setStatus(error.message || t('ephemeral.messages.failed_to_generate_share_link', 'Failed to generate share link.'));
            } finally {
                // Backstop: a cancelled build (panel closed mid-fill) or a throw before the line
                // above must not leave the opener's dialog spinning with no way out.
                readySignal.settle('incomplete');
                if (panelStillOpen()) clearProgress();
            }
        })();
    } catch (error) {
        console.error('showSharePlanPanel failed', error);
        // Undo any partially-entered lockdown so a failure never leaves the map inert.
        try { closeSharePlanPanel(); } catch (_) { }
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.failed_to_generate_share_link', 'Failed to generate share link.'), 5000, 'error');
        }
    } finally {
        // Nothing async took over, so there is nothing left to wait for: no applied proposals,
        // no storage, or a throw. Settling here covers every such exit at once.
        if (!fillStarted) readySignal.settle('not-shown');
    }
    return readySignal.promise;
}

function showSimpleShareModal(options = {}) {
    if (typeof document === 'undefined' || !window.CbDialog) return null;

    const t = getProposalI18nHelper();
    const closeLabel = t('modal.common.close', 'Close');
    const actions = (Array.isArray(options.actions) ? options.actions : []).map(action => ({
        id: action && action.id != null ? action.id : undefined,
        label: (action && action.label) || closeLabel,
        role: action && action.primary ? 'primary' : 'secondary',
        disabled: !!(action && action.disabled),
        keepOpen: !!(action && action.keepOpen),
        onClick: () => { if (action && typeof action.onClick === 'function') action.onClick(modalApi); }
    }));

    // The share dialog on the shared chrome (js/ui/dialogs.js); `share-modal` stays as the identity
    // class its inner rules in css/modals.css are keyed on.
    const api = window.CbDialog.open({
        title: options.title || '',
        size: options.size || 'md',
        className: 'share-modal' + (options.className ? ' ' + options.className : ''),
        // `share-modal-overlay` is a hook for the e2e specs and paints nothing.
        overlayClassName: 'share-modal-overlay',
        bodyClassName: 'share-modal-body',
        body: options.body,
        actions,
        closeLabel,
        closeOnBackdrop: options.closeOnOverlay !== false,
        closeOnEscape: options.closeOnEscape !== false,
        autoCloseActions: options.autoCloseActions !== false,
        // The element the dialog focuses once it has laid out (CbDialog focuses on the next frame,
        // after a caller's own synchronous focus), e.g. a link input to copy by hand.
        initialFocus: options.initialFocus || null,
        onClose: () => { if (typeof options.onClose === 'function') options.onClose(); }
    });
    if (!api) return null;

    const modalApi = {
        close: () => api.close(null),
        overlay: api.overlay,
        modal: api.dialog,
        body: api.body,
        getActionButton: (id) => api.getActionButton(id)
    };
    return modalApi;
}

// Number of list filters that currently narrow the result (sort order is not a filter). Shown on
// the phone Filters toggle so a collapsed filter panel never silently hides proposals.
function countActiveProposalListFilters(listState) {
    const st = listState || {};
    let count = 0;
    if (st.filterType && st.filterType !== 'all') count++;
    if (st.publicationFilter && st.publicationFilter !== 'all') count++;
    if (String(st.searchText || '').trim()) count++;
    return count;
}

// Autofocus the search box only with a real keyboard on a wide screen: on touch or narrow
// viewports focusing it opens the on-screen keyboard, which covers the bottom-sheet list.
function shouldAutofocusProposalListSearch(win) {
    try {
        if (!win || typeof win.matchMedia !== 'function') return false;
        return !win.matchMedia('(max-width: 767.98px), (pointer: coarse)').matches;
    } catch (_) {
        return false;
    }
}

// Node-only: lets backend tests exercise the pure helpers above. Inert in the browser.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { countActiveProposalListFilters, shouldAutofocusProposalListSearch };
}
