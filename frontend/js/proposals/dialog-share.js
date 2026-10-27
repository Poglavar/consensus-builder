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
        if (api && api.translationsReady && typeof api.translationsReady.then === 'function' && !api.__proposalListWaited) {
            api.__proposalListWaited = true;
            return api.translationsReady.then(() => renderProposalListModal()).catch(() => renderProposalListModal());
        }
    } catch (_) { }

    const host = document.getElementById('proposal-list-host');
    if (!host) return;
    const modal = ensureProposalListHostModal(host);

    const t = getProposalI18nHelper();

    const modalStrings = {
        title: t('modal.roadWidth.proposalList.title', 'Designs'),
        closeAria: t('modal.roadWidth.proposalList.closeAria', 'Close designs list'),
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
            <div class="proposal-list-toolbar">
                ${sourceToggleHtml}
                ${filtersToggleHtml}
            </div>
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
