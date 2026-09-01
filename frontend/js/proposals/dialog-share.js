// proposals/dialog-share.js — extracted from proposals.js (behavior-preserving relocation).

function showProposalWaitingPopup(message = 'Waiting for transaction...') {
    let popup = document.getElementById('proposal-waiting-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'proposal-waiting-popup';
        // Full-screen blocking overlay (styling in css/modals.css). It must NOT be
        // pointer-events:none — it's what stops clicks from reaching the map/parcels
        // behind the dimmed dialog while the transaction is pending.
        popup.className = 'proposal-waiting-overlay';

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
        popup.appendChild(card);
        document.body.appendChild(popup);
    } else {
        popup.style.display = 'flex';
    }

    const textEl = popup.querySelector('.proposal-waiting-text');
    if (textEl) {
        textEl.textContent = message;
    }
}

function hideProposalWaitingPopup() {
    const popup = document.getElementById('proposal-waiting-popup');
    if (popup && popup.parentNode) {
        popup.parentNode.removeChild(popup);
    }
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
    // A full render supersedes any pending debounced re-render from search/author typing.
    clearProposalListFilterInputDebounce();
    // If i18n is present but not yet ready, wait for it before rendering to avoid key flicker
    try {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        if (api && api.ready && typeof api.ready.then === 'function' && !api.__proposalListWaited) {
            api.__proposalListWaited = true;
            return api.ready.then(() => renderProposalListModal()).catch(() => renderProposalListModal());
        }
    } catch (_) { }

    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

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
            author: t('modal.roadWidth.proposalList.filters.author', 'Author'),
            search: t('modal.roadWidth.proposalList.filters.search', 'Search'),
            sort: t('modal.roadWidth.proposalList.filters.sort', 'Sort by'),
            authorPlaceholder: t('modal.roadWidth.proposalList.filters.authorPlaceholder', 'All authors'),
            searchPlaceholder: t('modal.roadWidth.proposalList.filters.searchPlaceholder', 'Search title or author'),
            reset: t('modal.roadWidth.proposalList.filters.reset', 'Reset'),
            resetTooltip: t('modal.roadWidth.proposalList.filters.resetTooltip', 'Reset filters')
        },
        sources: {
            local: t('modal.roadWidth.proposalList.sources.local', 'Local'),
            server: t('modal.roadWidth.proposalList.sources.server', 'Server'),
            blockchain: t('modal.roadWidth.proposalList.sources.blockchain', 'Blockchain')
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

    const source = proposalListState.source || 'local';
    const cityCode = resolveCurrentCityCode();
    const allProposals = proposalStorage.getAllProposals();

    // Check and update expiry status for all proposals
    allProposals.forEach(proposal => {
        checkAndUpdateProposalExpiry(proposal);
    });

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
    const normalizedCity = normalizeCityCodeForApi(cityCode);
    if (serverProposalCache.lastCity && serverProposalCache.lastCity !== normalizedCity) {
        resetServerProposalCache(normalizedCity);
    }
    // Always fetch count/summaries once per city so the server tab badge is populated immediately.
    // Keyed on "did we ask?" rather than "is count null?": a failed fetch leaves count null, and
    // this function is re-entered from that fetch's own finally block.
    const needsFetch = serverProposalCache.lastCity !== normalizedCity || !serverProposalCache.lastFetchedAt;
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

    // Blockchain source: the MINTED (on-chain) proposals. Same data the wallet's Minted modal shows,
    // just surfaced in the list. Read from local storage (own mints + anything chain-sync pulled in);
    // activating the tab with a wallet triggers a sync to refresh (handled in the source switch).
    // Canton proposals are EXCLUDED here — they're private to their ledger parties, live in their own
    // purple-badge/explorer lane, and are called out with a note below rather than silently dropped.
    const cantonModeApi = (typeof window !== 'undefined') ? window.CantonMode : null;
    const isCantonProposal = (cantonModeApi && typeof cantonModeApi.isCantonProposal === 'function')
        ? (p) => cantonModeApi.isCantonProposal(p)
        : () => false;
    const blockchainAugmented = allProposals
        .filter(proposal => {
            const minted = (typeof isProposalMinted === 'function') ? isProposalMinted(proposal) : !!(proposal && proposal.isMinted);
            return minted && !isCantonProposal(proposal);
        })
        .map(proposal => ({ proposal, metrics: computeProposalMetrics(proposal) }));
    const blockchainDatasets = buildDatasets(blockchainAugmented);
    const blockchainCount = blockchainAugmented.length;
    // When Canton mode is active, tell the user why their private proposals aren't in this list.
    const cantonActiveNow = cantonModeApi && typeof cantonModeApi.isActive === 'function' && cantonModeApi.isActive();
    const blockchainCantonNote = (source === 'blockchain' && cantonActiveNow)
        ? `<p class="proposal-list-note canton-empty">${escapeHtml('On Canton, proposals are private, so they are not listed here.')}</p>`
        : '';

    const chosen = source === 'server' ? serverDatasets
        : source === 'blockchain' ? blockchainDatasets
        : localDatasets;

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

    const runtimeGlobal = typeof globalThis !== 'undefined'
        ? globalThis
        : ((typeof window !== 'undefined') ? window : {});

    const hasEvmBlockchainSync = runtimeGlobal.BlockchainSync &&
        typeof runtimeGlobal.BlockchainSync.sync === 'function';
    const hasSolanaBlockchainSync = runtimeGlobal.SolanaBlockchainSync &&
        typeof runtimeGlobal.SolanaBlockchainSync.sync === 'function';
    const syncBlockchainAvailable = hasEvmBlockchainSync || hasSolanaBlockchainSync;

    // Check if wallet is connected (EVM or Solana)
    const isEvmWalletConnected = runtimeGlobal.walletManager &&
        typeof runtimeGlobal.walletManager.getProvider === 'function' &&
        runtimeGlobal.walletManager.getProvider() !== null;
    const isSolanaWalletConnected = hasSolanaBlockchainSync && runtimeGlobal.SolanaBlockchainSync.isWalletConnected();
    const isWalletConnected = isEvmWalletConnected || isSolanaWalletConnected;

    const syncStatus = syncBlockchainAvailable && typeof runtimeGlobal.BlockchainSync.getStatus === 'function'
        ? runtimeGlobal.BlockchainSync.getStatus()
        : { isSyncing: false };

    console.debug('[ProposalListModal] sync controls context', {
        source,
        cityCode: normalizedCity,
        localCount,
        serverCount,
        syncBlockchainAvailable,
        isWalletConnected,
        isSyncing: !!syncStatus.isSyncing
    });

    const syncDisabled = syncStatus.isSyncing || !isWalletConnected;
    const syncTitle = !isWalletConnected
        ? t('modal.roadWidth.proposalList.syncBlockchainNoWallet', 'Connect wallet to sync from blockchain')
        : t('modal.roadWidth.proposalList.syncBlockchain', 'Refresh from blockchain');

    // Only surface the blockchain-sync control when it can actually do something: a wallet is connected
    // (or a sync is already running). A permanently-greyed sync button on the Local tab just reads as
    // broken, so hide it rather than disable it when there's no wallet.
    const syncButtonHtml = source === 'local' && syncBlockchainAvailable && (isWalletConnected || syncStatus.isSyncing) ? `
        <button
            id="sync-blockchain-proposals-btn"
            class="btn btn-action"
            ${syncDisabled ? 'disabled' : ''}
            data-i18n-key="${!isWalletConnected ? 'modal.roadWidth.proposalList.syncBlockchainNoWallet' : 'modal.roadWidth.proposalList.syncBlockchain'}"
            data-i18n-attr="title"
            title="${escapeHtml(syncTitle)}"
            onclick="handleBlockchainSyncClick(event)">
            <i class="fas fa-sync${syncStatus.isSyncing ? ' fa-spin' : ''}"></i>
            <span data-i18n-key="modal.roadWidth.proposalList.syncBlockchainLabel">${t('modal.roadWidth.proposalList.syncBlockchainLabel', 'Sync')}</span>
        </button>
    ` : '';

    // Status (lifecycle) and Applied are two orthogonal dropdown filters that replaced the old
    // Active/Executed tabs. Every lifecycle status is selectable; labels reuse getProposalLifecycleLabel.
    const lifecycleFilterOptions = [
        { value: 'all', label: t('modal.roadWidth.proposalList.filters.statusAll', 'All statuses') },
        ...['active', 'executed', 'expired', 'inactive', 'vote-open', 'vote-concluded', 'accepted-not-funded']
            .map(key => ({ value: key, label: getProposalLifecycleLabel(key) }))
    ];
    const appliedFilterOptions = [
        { value: 'all', label: t('modal.roadWidth.proposalList.filters.appliedAll', 'Applied & not') },
        { value: 'applied', label: t('modal.roadWidth.proposalList.filters.appliedYes', 'Applied') },
        { value: 'not-applied', label: t('modal.roadWidth.proposalList.filters.appliedNo', 'Not applied') }
    ];
    const statusFilterLabel = t('modal.roadWidth.proposalList.filters.status', 'Status');
    const appliedFilterLabel = t('modal.roadWidth.proposalList.filters.applied', 'Applied');

    const controlsHtml = `
        <div class="proposal-list-controls">
            <div class="proposal-filter-group">
                <select id="proposal-filter-type" aria-label="${escapeHtml(modalStrings.filters.goal)}">
                    ${goalOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.filterType ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.filters.goals.${option.value}">${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <select id="proposal-filter-lifecycle" aria-label="${escapeHtml(statusFilterLabel)}">
                    ${lifecycleFilterOptions.map(o => `<option value="${o.value}" ${o.value === (proposalListState.lifecycleFilter || 'all') ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <select id="proposal-filter-applied" aria-label="${escapeHtml(appliedFilterLabel)}">
                    ${appliedFilterOptions.map(o => `<option value="${o.value}" ${o.value === (proposalListState.appliedFilter || 'all') ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <input type="text" id="proposal-filter-author" placeholder="${escapeHtml(modalStrings.filters.authorPlaceholder)}" data-i18n-key="modal.roadWidth.proposalList.filters.authorPlaceholder" data-i18n-attr="placeholder" value="${escapeHtml(proposalListState.authorFilter)}">
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
            ${syncButtonHtml ? `<div class="proposal-filter-group proposal-sync-group">${syncButtonHtml}</div>` : ''}
        </div>
    `;

    const sourceToggleHtml = `
        <div class="proposal-source-toggle">
            <button class="proposal-source-btn ${source === 'local' ? 'active' : ''}" data-source="local">
                ${escapeHtml(modalStrings.sources.local)} (${localCount})
            </button>
            <button class="proposal-source-btn ${source === 'server' ? 'active' : ''}" data-source="server">
                ${escapeHtml(modalStrings.sources.server)} (${serverCountLabel !== null ? serverCountLabel : '0'})
            </button>
            <button class="proposal-source-btn ${source === 'blockchain' ? 'active' : ''}" data-source="blockchain">
                ${escapeHtml(modalStrings.sources.blockchain)} (${blockchainCount})
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

    const resultCountText = `${chosen.sorted.length} ${t('modal.roadWidth.proposalList.resultCountWord', 'shown')}`;

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
            <div class="proposal-list-modal-header">
                <h2 data-i18n-key="modal.roadWidth.proposalList.title">${escapeHtml(modalStrings.title)}</h2>
                <button type="button" class="proposal-list-modal-close close-circle-btn close-circle-btn--lg" aria-label="${escapeHtml(modalStrings.closeAria)}" data-i18n-key="modal.roadWidth.proposalList.closeAria" data-i18n-attr="aria-label" onclick="closeProposalList({ selectPreviewed: true })">&times;</button>
            </div>
            ${sourceToggleHtml}
            ${blockchainCantonNote}
            ${controlsHtml}
            <div class="proposal-list-count">${escapeHtml(resultCountText)}</div>
            <div class="proposal-list-modal-body">
                <div id="proposals-list" class="proposal-tab-content active">
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
        fallbackMap.set('modal.roadWidth.proposalList.filters.author', modalStrings.filters.author);
        fallbackMap.set('modal.roadWidth.proposalList.filters.search', modalStrings.filters.search);
        fallbackMap.set('modal.roadWidth.proposalList.filters.sort', modalStrings.filters.sort);
        fallbackMap.set('modal.roadWidth.proposalList.filters.authorPlaceholder', modalStrings.filters.authorPlaceholder);
        fallbackMap.set('modal.roadWidth.proposalList.filters.searchPlaceholder', modalStrings.filters.searchPlaceholder);
        fallbackMap.set('modal.roadWidth.proposalList.sources.local', modalStrings.sources.local);
        fallbackMap.set('modal.roadWidth.proposalList.sources.server', modalStrings.sources.server);
        fallbackMap.set('modal.roadWidth.proposalList.sources.blockchain', modalStrings.sources.blockchain);
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
    const authorInput = modal.querySelector('#proposal-filter-author');
    if (authorInput) {
        authorInput.addEventListener('input', event => {
            proposalListState.authorFilter = event.target.value;
            scheduleDebouncedProposalListModalRender();
        });
    }

    const searchInput = modal.querySelector('#proposal-filter-search');
    if (searchInput) {
        searchInput.addEventListener('input', event => {
            proposalListState.searchText = event.target.value;
            scheduleDebouncedProposalListModalRender();
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
            if (nextSource === 'server') {
                ensureServerProposals(resolveCurrentCityCode());
            } else if (nextSource === 'blockchain') {
                // Refresh on-chain proposals from the wallet (best-effort, wallet-gated). No wallet →
                // the tab still shows locally-held minted proposals; the Sync button reflects state.
                try {
                    if (isWalletConnected && runtimeGlobal.BlockchainSync && typeof runtimeGlobal.BlockchainSync.sync === 'function') {
                        runtimeGlobal.BlockchainSync.sync().then(() => renderProposalListModal()).catch(() => { });
                    }
                } catch (_) { /* ignore */ }
            }
            renderProposalListModal();
        });
    });

    const retryButton = modal.querySelector('.proposal-server-retry');
    if (retryButton) {
        retryButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            ensureServerProposals(resolveCurrentCityCode());
        });
    }

    const lifecycleSelect = modal.querySelector('#proposal-filter-lifecycle');
    if (lifecycleSelect) {
        lifecycleSelect.addEventListener('change', event => {
            proposalListState.lifecycleFilter = event.target.value;
            renderProposalListModal();
        });
    }

    const appliedSelect = modal.querySelector('#proposal-filter-applied');
    if (appliedSelect) {
        appliedSelect.addEventListener('change', event => {
            proposalListState.appliedFilter = event.target.value;
            renderProposalListModal();
        });
    }

    modal.querySelectorAll('.proposal-list-item').forEach(item => {
        item.addEventListener('click', handleProposalListItemClick);
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
        const selectedEl = modal.querySelector(`.proposal-list-item[data-proposal-id="${proposalListState.selectedId}"]`);
        if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }
}

async function showAllProposalsModal() {
    resetParcelSelectionForProposalListInteraction();
    try { clearProposalInfoHoverOverlay(); } catch (_) { }

    let modal = document.querySelector('.proposal-list-modal');
    const wasHidden = !modal || modal.style.display !== 'block';
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

    modal.style.display = 'block';

    // On the open action only (not on every re-render): fold the sidebar away so the map keeps the
    // rest of the screen, and request search-box autofocus (honored inside the render, which may be
    // deferred until i18n is ready).
    if (wasHidden) {
        proposalListState.autofocusSearch = true;
        // Enter proposal browse mode: the map stays live (pan/zoom) but only proposals are clickable
        // (see onParcelClick + the tail of selectAndHighlightProposal).
        window.proposalListBrowseMode = true;
        try {
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') toggleSidebar();
        } catch (_) { }

        // Show the panel EMPTY and busy first, then hand the browser a frame to draw it in. Building
        // the list from several hundred proposals is not instant, and until it finishes the click has
        // no visible effect at all — the panel simply appears late, which reads as a dropped click.
        modal.setAttribute('aria-busy', 'true');
        modal.innerHTML = '<div class="proposal-list-loading"><i class="fas fa-spinner fa-spin"></i></div>';
        if (typeof window !== 'undefined' && typeof window.yieldToBrowser === 'function') {
            await window.yieldToBrowser();
        }
    }

    renderProposalListModal();
    modal.removeAttribute('aria-busy');

    // Frame all applied proposals to start browsing from an overview. Called AFTER the render (so the
    // panel exists and its footprint can be padded out) and directly rather than via
    // requestAnimationFrame, which is throttled — and can silently never fire — when the tab isn't
    // actively rendering.
    if (wasHidden) {
        try { if (typeof fitMapToAppliedProposals === 'function') fitMapToAppliedProposals(); } catch (_) { }
    }
}

function getSharedInspectorI18nHelper() {
    const t = getProposalI18nHelper();
    const namespace = 'modal.roadWidth.sharedInspector';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

// --- Share Plan panel ---------------------------------------------------------------------------
// The share-plan UI is a right-docked, full-height panel (like the proposals list), NOT a modal:
// the map stays visible so the plan can be read spatially while it is being composed. While the
// panel is open the app is in share-plan mode (window.sharePlanMode): the map is pan/zoom ONLY —
// parcels and proposals are click/hover-inert, the sidebar and mode switches are disabled (CSS
// lockdown via body.share-plan-mode). Every CHECKED proposal is painted on the map in its row's
// colour so the exact content of the shared plan is visible at a glance; hovering or clicking a
// row outlines that proposal (click also frames it). No interaction opens details.

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

let _sharePlanPanelState = null; // { root, overlayGroups, onKeyDown }

function sharePlanColorForIndex(index) {
    const n = SHARE_PLAN_COLORS.length;
    return SHARE_PLAN_COLORS[((index % n) + n) % n];
}

function closeSharePlanPanel() {
    const state = _sharePlanPanelState;
    _sharePlanPanelState = null;
    if (typeof window !== 'undefined') {
        window.sharePlanMode = false;
        // Released with the panel: a picker left behind would answer clicks by scrolling rows in a
        // list that is no longer on screen, and would hold the whole closed panel in memory.
        window.__sharePlanPickProposal = null;
    }
    try { document.body.classList.remove('share-plan-mode'); } catch (_) { }
    // Leaving the panel with a subset chosen must not leave the map dimmed behind it.
    try { document.body.classList.remove('share-plan-highlighting'); } catch (_) { }
    if (state) {
        try { document.removeEventListener('keydown', state.onKeyDown); } catch (_) { }
        try { if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root); } catch (_) { }
        try {
            if (state.overlayGroups && typeof map !== 'undefined' && map && typeof map.removeLayer === 'function') {
                Object.keys(state.overlayGroups).forEach(bucket => {
                    try { map.removeLayer(state.overlayGroups[bucket]); } catch (_) { }
                });
            }
        } catch (_) { }
    }
    try { if (typeof clearProposalHoverLayers === 'function') clearProposalHoverLayers(); } catch (_) { }
}

// Returns a promise that settles once the panel is worth LOOKING at — rows listed and the map
// fitted — so a caller can hold its own dialog up until then instead of dropping the user onto a
// half-built map. It deliberately does NOT wait for the upload checks: those are a per-proposal
// round trip each, they report their own progress inside the panel, and making the user watch a
// spinner through them would be worse than the flicker this replaces.
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
        const applied = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied);
        if (applied.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.no_applied_proposals_to_share_yet', 'No applied proposals to share yet.'));
            }
            return;
        }

        const proposalsByHash = new Map();
        applied.forEach(proposal => {
            const key = proposal.proposalId || getProposalKey(proposal);
            if (!key) return;
            proposalsByHash.set(String(key), proposal);
        });
        if (proposalsByHash.size === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.unable_to_prepare_proposals_for_sharing', 'Unable to prepare proposals for sharing.'), 5000, 'error');
            }
            return;
        }

        // Reopening replaces any previous instance (and resets a stale lockdown).
        closeSharePlanPanel();

        // The coloured plan overlay is a 2D map layer — leave model/photo view before the mode
        // switches lock, otherwise the plan would be invisible AND the way back unreachable.
        try {
            if (typeof window.isThreeModeActive === 'function' && window.isThreeModeActive()
                && typeof window.exitThreeMode === 'function') {
                window.exitThreeMode();
            }
        } catch (_) { }

        // Leave any proposal-list/browse/selection surface; the share panel owns the screen now.
        try { if (typeof closeProposalList === 'function') closeProposalList(); } catch (_) { }
        try { if (typeof resetParcelSelectionForProposalListInteraction === 'function') resetParcelSelectionForProposalListInteraction(); } catch (_) { }
        try { if (typeof clearProposalInfoHoverOverlay === 'function') clearProposalInfoHoverOverlay(); } catch (_) { }

        window.sharePlanMode = true;
        try { document.body.classList.add('share-plan-mode'); } catch (_) { }
        // Fold the sidebar away so the (locked) chrome doesn't cover the map — the same move the
        // proposals list makes when it opens.
        try {
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') toggleSidebar();
        } catch (_) { }

        const selected = new Set(proposalsByHash.keys());
        const uploadState = new Map(); // key -> { uploaded, uploading, serverId }
        const rowControls = new Map();

        const colorByKey = new Map();
        Array.from(proposalsByHash.keys()).forEach((key, index) => {
            colorByKey.set(key, sharePlanColorForIndex(index));
        });

        // Panel skeleton: header + body; the body holds count/status, the row list (stretches),
        // and the share-link area pinned at the bottom.
        const panelRoot = document.createElement('div');
        panelRoot.className = 'share-plan-panel';
        const panelContent = document.createElement('div');
        panelContent.className = 'share-plan-panel-content';
        panelRoot.appendChild(panelContent);

        const panelHeader = document.createElement('div');
        panelHeader.className = 'share-plan-panel-header';
        const panelTitle = document.createElement('h2');
        panelTitle.textContent = tShare('plan.title', 'Share Plan');
        const panelCloseBtn = document.createElement('button');
        panelCloseBtn.type = 'button';
        panelCloseBtn.className = 'close-circle-btn close-circle-btn--lg';
        panelCloseBtn.setAttribute('aria-label', t('modal.common.close', 'Close'));
        panelCloseBtn.innerHTML = '&times;';
        panelCloseBtn.addEventListener('click', () => closeSharePlanPanel());
        panelHeader.append(panelTitle, panelCloseBtn);
        panelContent.appendChild(panelHeader);

        // The subset filter. There used to be a legend of two swatches beside it, explaining that a
        // solid shape is uploaded and a dashed one is not — necessary while the map painted both at
        // once and you had to tell them apart. It no longer does: each mode shows one state and the
        // pressed button names it, so the legend explained a distinction that is never on screen.
        const filterRow = document.createElement('div');
        filterRow.className = 'share-plan-filter';

        // Which subset to highlight on the map.
        //
        // The map ALREADY draws every applied proposal, so "All" is the view you arrived with and
        // paints nothing extra. The other two answer the only question this panel actually raises —
        // "which of my three hundred are not on the server yet" — by highlighting that subset on top
        // of what is already there. Nothing is hidden: the highlight is strong enough to read
        // against the base drawing, and hiding the rest would cost a second pass over every layer.
        //
        // Switching is an add/remove of a Leaflet layer GROUP, not a rebuild. The overlays are built
        // once, on the first switch away from All, and then kept — which is the whole point. The
        // checkbox this replaces rebuilt three hundred footprints on every tick, each one a
        // geometry resolve, and was slow enough that the answer was not worth the wait.
        const HIGHLIGHT_MODES = [
            { value: 'all', key: 'plan.filterAll', fallback: 'All' },
            { value: 'uploaded', key: 'plan.filterUploaded', fallback: 'Uploaded' },
            { value: 'pending', key: 'plan.filterPending', fallback: 'Not uploaded yet' }
        ];
        let highlightMode = 'all';
        const modeButtons = new Map();
        const modeWrap = document.createElement('div');
        modeWrap.className = 'share-plan-mode-switch';
        modeWrap.setAttribute('role', 'group');
        modeWrap.setAttribute('aria-label', tShare('plan.filterLabel', 'Highlight on the map'));
        HIGHLIGHT_MODES.forEach(mode => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'share-plan-mode-btn';
            button.textContent = tShare(mode.key, mode.fallback);
            button.setAttribute('aria-pressed', String(mode.value === highlightMode));
            button.addEventListener('click', () => { setHighlightMode(mode.value); });
            modeButtons.set(mode.value, button);
            modeWrap.appendChild(button);
        });
        filterRow.appendChild(modeWrap);
        panelContent.appendChild(filterRow);

        const container = document.createElement('div');
        container.className = 'share-plan-panel-body';
        panelContent.appendChild(container);

        // One coloured, non-interactive map sublayer per CHECKED proposal, keyed by proposal, and
        // held in the group for its upload state. Splitting them by state at build time is what
        // makes switching subsets free: the filter adds one group and removes the other, instead of
        // walking three hundred layers to decide which still belong.
        //
        // Neither group is on the map until a subset is chosen — "All" is the base drawing alone.
        const hasLeafletMap = (typeof L !== 'undefined' && typeof map !== 'undefined' && map);
        const overlayGroups = hasLeafletMap
            ? { uploaded: L.layerGroup(), pending: L.layerGroup() }
            : null;
        const overlayByKey = new Map(); // key -> { layer, bucket }
        let overlaysBuilt = false;

        // Choosing a subset has to REMOVE the rest from view, not just draw on top of it. Painting
        // the subset over the base drawing answered nothing on a 298-member plan: the whole city is
        // already blue, so "Not uploaded yet" looked exactly like "All" with one more shape in it.
        //
        // The base drawing belongs to the app, not to this panel, so it cannot be filtered
        // layer-by-layer from here — and walking hundreds of layers to restyle them is the cost this
        // control exists to avoid. Instead the highlight gets its own pane above everything, and a
        // single body class drops the opacity of every other pane. One class toggle, no layer work,
        // and it reverts exactly.
        const HIGHLIGHT_PANE = 'shareplan-highlight';
        if (hasLeafletMap && typeof map.createPane === 'function' && !map.getPane(HIGHLIGHT_PANE)) {
            try {
                const pane = map.createPane(HIGHLIGHT_PANE);
                // Above every fabric pane, below popups (700) so nothing swallows a click target.
                pane.style.zIndex = '690';
                pane.style.pointerEvents = 'none';
            } catch (_) { /* no pane: the highlight still draws, just not above everything */ }
        }

        const proposalFeaturesFor = (proposal) => {
            // Live CHILDREN first — the applied footprint (a road's corridor pieces, a structure's
            // ground, a building's parcel). The shared collectProposalHighlightFeatures helper only
            // resolves road children and otherwise falls back to parentParcelIds, but parents are
            // hidden once a proposal is applied, so structures/buildings would paint nothing.
            const ids = new Set();
            const push = (arr) => {
                if (!Array.isArray(arr)) return;
                arr.forEach(id => { if (id != null && String(id)) ids.add(String(id)); });
            };
            if (proposal) {
                push(proposal.childParcelIds);
                push(proposal.roadProposal && proposal.roadProposal.childParcelIds);
                push(proposal.buildingProposal && proposal.buildingProposal.childParcelIds);
                push(proposal.structureProposal && proposal.structureProposal.childParcelIds);
                push(proposal.reparcellization && proposal.reparcellization.childParcelIds);
                push(proposal.decideLaterProposal && proposal.decideLaterProposal.childParcelIds);
            }
            const features = [];
            ids.forEach(id => {
                try {
                    const feature = (typeof getParcelFeatureForHighlight === 'function')
                        ? getParcelFeatureForHighlight(id, proposal)
                        : null;
                    if (feature && feature.geometry) features.push(feature);
                } catch (_) { }
            });
            if (features.length) return features;
            try {
                if (typeof collectProposalHighlightFeatures === 'function') {
                    return (collectProposalHighlightFeatures(proposal) || []).filter(f => f && f.geometry);
                }
            } catch (_) { }
            return [];
        };

        // The proposal's OWN geometry, independent of the parcels it sits on: a building's
        // footprints, a corridor surface, a park/square polygon, a readjustment's plots. This is
        // the shape that names the row — without it, hovering "zgrada M1-11" outlined a plot that
        // looked like every other plot on the block.
        const proposalBodyFeaturesFor = (proposal) => {
            if (typeof collectProposalFeatureSets !== 'function') return [];
            try {
                const sets = collectProposalFeatureSets(proposal, { includeBuildingGeometry: true }) || {};
                return (sets.primaryFeatures || []).filter(feature => feature && feature.geometry);
            } catch (error) {
                console.warn('share plan: could not resolve proposal body', error);
                return [];
            }
        };

        // The ground the proposal STANDS ON, out of every parcel it minted — a remainder handed
        // back to the host is not this proposal's ground, and it can be twenty times its size.
        const groundFeaturesFor = (parcelFeatures, bodyFeatures) => {
            const api = (typeof window !== 'undefined') ? window.__hoverGround : null;
            if (!api || typeof api.groundUnderBody !== 'function' || typeof turf === 'undefined') return parcelFeatures;
            return api.groundUnderBody(parcelFeatures, bodyFeatures, {
                intersectionArea: (a, b) => {
                    try { const hit = turf.intersect(a, b); return hit ? (turf.area(hit) || 0) : 0; } catch (_) { return 0; }
                }
            });
        };

        // Already on the server, or still only here? Shown as SOLID versus DASHED rather than as two
        // colours: every proposal already owns a colour to tell it from its neighbours, so a second
        // colour axis would collide with the first. A dashed, fainter shape reads as provisional,
        // which is exactly what "not uploaded yet" is.
        const overlayStyleFor = (uploaded, color) => ({
            color,
            weight: uploaded ? 2 : 3,
            dashArray: uploaded ? null : '7 6',
            fillColor: color,
            // 0.40 against 0.10, not 0.35 against 0.14: over aerial imagery a quarter of a step in
            // opacity is not a difference anyone can see, and the dash is the only other cue on a
            // shape too small to show one.
            fillOpacity: uploaded ? 0.40 : 0.10
        });

        // Resolving a proposal's ground is the expensive half — turf work per proposal — so it
        // happens once per key and never again while the panel is open.
        //
        // The ground is resolved through LOADED PARCEL LAYERS, and parcels switch off below a zoom
        // ("Parcels disabled at this zoom"). Whole-plan highlighting is exactly the case you look at
        // zoomed OUT, so at the zoom where this panel is most useful the ground resolves to nothing
        // for almost every member and the highlight painted a handful of scattered shapes — the ones
        // whose geometry happens to be self-contained, like the rail track.
        //
        // So paint the proposal's OWN body — its corridor, footprint or structure polygon, straight
        // off the stored record. It needs no parcels, no map state and no zoom, which is what a
        // plan-wide view requires.
        //
        // The body is preferred over the parcel ground, not the other way round. Ground is the right
        // treatment for HOVER, where you are asking "what does this stand on"; here the question is
        // "where is this proposal", and the two answers diverge badly. The rail track resolves to no
        // child parcels at all — it crosses mostly unparcelled land — so its ground fell through to
        // a fallback that produced twelve fragments measuring 0-4 px on screen, while its body is
        // the 472x155 px corridor you actually want to see. Ground remains the fallback for anything
        // with no body geometry of its own, such as a decide-later claim over existing parcels.
        const buildPlanOverlay = (key) => {
            if (!overlayGroups || overlayByKey.has(key) || !selected.has(key)) return;
            const proposal = proposalsByHash.get(key);
            const body = proposalBodyFeaturesFor(proposal);
            const features = (body && body.length)
                ? body
                : groundFeaturesFor(proposalFeaturesFor(proposal), body);
            if (!features.length) return;
            try {
                const color = colorByKey.get(key) || '#4363d8';
                const uploaded = !!(uploadState.get(key) || {}).uploaded;
                const bucket = uploaded ? 'uploaded' : 'pending';
                const layer = L.geoJSON({ type: 'FeatureCollection', features }, {
                    style: overlayStyleFor(uploaded, color),
                    interactive: false,
                    // Its own pane, so the subset stays at full strength while everything else dims.
                    pane: map.getPane(HIGHLIGHT_PANE) ? HIGHLIGHT_PANE : undefined
                });
                overlayGroups[bucket].addLayer(layer);
                overlayByKey.set(key, { layer, bucket });
            } catch (error) {
                console.warn('share plan: could not paint proposal', key, error);
            }
        };

        // Bring one proposal's overlay back in line with its current selection and upload state.
        // An upload only changes the STYLE and which group it belongs to, so it restyles and moves
        // the existing layer — the geometry it was built from has not changed.
        const syncPlanOverlay = (key) => {
            if (!overlayGroups) return;
            const existing = overlayByKey.get(key);

            if (!selected.has(key)) {
                if (existing) {
                    try { overlayGroups[existing.bucket].removeLayer(existing.layer); } catch (_) { }
                    overlayByKey.delete(key);
                }
                return;
            }
            if (!existing) {
                // Before the first switch away from All nothing is built, and building on selection
                // would pay the whole cost the filter exists to defer.
                if (overlaysBuilt) buildPlanOverlay(key);
                return;
            }
            const uploaded = !!(uploadState.get(key) || {}).uploaded;
            const bucket = uploaded ? 'uploaded' : 'pending';
            if (existing.bucket !== bucket) {
                try { overlayGroups[existing.bucket].removeLayer(existing.layer); } catch (_) { }
                try { overlayGroups[bucket].addLayer(existing.layer); } catch (_) { }
                existing.bucket = bucket;
            }
            try { existing.layer.setStyle(overlayStyleFor(uploaded, colorByKey.get(key) || '#4363d8')); } catch (_) { }
        };

        // Add one group, remove the other. Everything expensive already happened.
        const applyHighlightMode = async () => {
            if (!overlayGroups || typeof map === 'undefined' || !map) return;
            const detach = (bucket) => {
                try { if (map.hasLayer(overlayGroups[bucket])) map.removeLayer(overlayGroups[bucket]); } catch (_) { }
            };
            if (highlightMode === 'all') {
                detach('uploaded');
                detach('pending');
                try { document.body.classList.remove('share-plan-highlighting'); } catch (_) { }
                setStatus('');
                return;
            }
            if (!overlaysBuilt) {
                modeButtons.forEach(button => { button.disabled = true; });
                overlaysBuilt = true;
                // In frame-sized slices, like the row build: three hundred overlays in one task is
                // the freeze this panel was rebuilt to avoid.
                const finished = await inChunks([...proposalsByHash.keys()], key => buildPlanOverlay(key),
                    'drawingProposals', 'Drawing {done}/{total} proposals on the map...');
                modeButtons.forEach(button => { button.disabled = false; });
                if (finished === false) return; // the panel closed mid-build
            }
            const show = highlightMode === 'uploaded' ? 'uploaded' : 'pending';
            detach(show === 'uploaded' ? 'pending' : 'uploaded');
            try { if (!map.hasLayer(overlayGroups[show])) overlayGroups[show].addTo(map); } catch (_) { }
            try { document.body.classList.add('share-plan-highlighting'); } catch (_) { }
            setStatus('');
        };

        const setHighlightMode = (mode) => {
            if (highlightMode === mode) return;
            highlightMode = mode;
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
        const revealRow = (key, parcelId) => {
            const controls = rowControls.get(key);
            if (!controls || !controls.row) return;
            if (pickedRowKey && pickedRowKey !== key) {
                const previous = rowControls.get(pickedRowKey);
                if (previous && previous.row) previous.row.classList.remove('is-picked');
            }
            pickedRowKey = key;
            controls.row.classList.add('is-picked');
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
            const uploaded = !!(uploadState.get(key) || {}).uploaded;
            // Same live-children resolver as the paint, so hover outlines exactly what is painted.
            const bodyFeatures = proposalBodyFeaturesFor(proposal);
            const parcelFeatures = groundFeaturesFor(proposalFeaturesFor(proposal), bodyFeatures);
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
                    // Solid and filled when the server already has it, dashed and hollow when it is
                    // still only here — the same language the subset filter and the plan overlay use. This
                    // is the surface that actually gets looked at: the overlay repaints on a
                    // CHECKBOX toggle, and every row starts checked, so unless you untick and retick
                    // a row the overlay never runs and the upload state was invisible.
                    features: bodyFeatures,
                    color: SHARE_PLAN_HOVER_BODY_COLOR,
                    weight: uploaded ? 4 : 5,
                    dashArray: uploaded ? null : '8 6',
                    fillColor: SHARE_PLAN_HOVER_BODY_COLOR,
                    fillOpacity: uploaded ? 0.35 : 0.05,
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
                    const features = proposalFeaturesFor(proposal);
                    if (features.length) bounds = L.geoJSON({ type: 'FeatureCollection', features }).getBounds();
                } catch (_) { }
            }
            if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return;
            const padding = (typeof getProposalPanelFitPadding === 'function')
                ? getProposalPanelFitPadding(40)
                : { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] };
            // animate:false — deterministic, and immune to background-tab rAF throttling.
            try { map.fitBounds(bounds, { ...padding, maxZoom: 18, animate: false }); } catch (_) { }
        };

        const totalInPlan = proposalsByHash.size;
        const countLine = document.createElement('div');
        countLine.style.fontSize = '13px';
        countLine.style.color = '#475569';
        countLine.textContent = tShare('plan.countHeading', 'There are {{count}} proposals in the current plan (that is, applied on the map)', {
            count: totalInPlan
        });
        container.appendChild(countLine);

        const statusLine = document.createElement('div');
        statusLine.style.minHeight = '18px';
        statusLine.style.color = '#b3261e';
        statusLine.style.fontSize = '12px';
        container.appendChild(statusLine);

        // The panel opens before its rows know anything: each proposal is then asked, one at a time,
        // whether the server already has it. On a big plan that is a long quiet tail, so it counts
        // itself out loud instead of leaving rows to flicker.
        const progressRow = document.createElement('div');
        progressRow.className = 'share-plan-progress';
        progressRow.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span></span>';
        const progressText = progressRow.querySelector('span');
        container.appendChild(progressRow);

        const listWrap = document.createElement('div');
        listWrap.className = 'share-plan-list';
        container.appendChild(listWrap);

        const shareArea = document.createElement('div');
        shareArea.className = 'share-plan-share-area';

        const linkRow = document.createElement('div');
        linkRow.style.display = 'flex';
        linkRow.style.alignItems = 'center';
        linkRow.style.gap = '8px';

        const linkInput = document.createElement('input');
        linkInput.type = 'text';
        linkInput.readOnly = true;
        linkInput.className = 'share-modal-link';
        linkInput.style.flex = '1';
        linkInput.style.padding = '0.5rem 0.75rem';
        linkInput.style.border = '1px solid #d8ddf0';
        linkInput.style.borderRadius = '8px';
        linkInput.style.background = '#f7f8fb';
        linkInput.style.fontSize = '13px';
        linkInput.style.color = '#212744';
        linkInput.style.boxSizing = 'border-box';
        linkInput.style.height = 'auto';
        linkInput.style.minHeight = '38px';
        linkRow.appendChild(linkInput);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn share-modal-secondary';
        copyBtn.textContent = tShare('copyUrlButton', 'Copy URL');
        copyBtn.addEventListener('click', () => {
            if (!linkInput.value) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(linkInput.value).then(() => {
                    if (typeof showEphemeralMessage === 'function') {
                        showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                    }
                }).catch(() => {
                    linkInput.focus();
                    linkInput.select();
                });
            } else {
                linkInput.focus();
                linkInput.select();
            }
        });
        linkRow.appendChild(copyBtn);

        shareArea.appendChild(linkRow);

        // --- Named plan (ENS): give this plan a globally-unique, mutable name
        // resolvable as <name>.proposals.urbangametheory.eth ---
        const planNameWrap = document.createElement('div');
        planNameWrap.style.display = 'flex';
        planNameWrap.style.flexDirection = 'column';
        planNameWrap.style.gap = '6px';
        planNameWrap.style.marginTop = '6px';
        planNameWrap.style.paddingTop = '8px';
        planNameWrap.style.borderTop = '1px solid #e5e9f5';

        const planNameLabel = document.createElement('div');
        planNameLabel.style.fontSize = '13px';
        planNameLabel.style.color = '#475569';
        planNameLabel.textContent = tShare('plan.nameHeading', 'Or give this plan a memorable name (ENS):');
        planNameWrap.appendChild(planNameLabel);

        const planNameRow = document.createElement('div');
        planNameRow.style.display = 'flex';
        planNameRow.style.gap = '8px';
        planNameRow.style.alignItems = 'center';
        planNameRow.style.flexWrap = 'wrap';

        const planNameInput = document.createElement('input');
        planNameInput.type = 'text';
        planNameInput.placeholder = tShare('plan.namePlaceholder', 'e.g. harbor-redevelopment');
        planNameInput.style.flex = '1';
        planNameInput.style.minWidth = '140px';
        planNameInput.style.padding = '0.4rem 0.6rem';
        planNameInput.style.border = '1px solid #d8ddf0';
        planNameInput.style.borderRadius = '8px';
        planNameInput.style.fontSize = '13px';
        planNameInput.style.boxSizing = 'border-box';

        const planSuffix = document.createElement('span');
        planSuffix.textContent = '.proposals.urbangametheory.eth';
        planSuffix.style.fontSize = '12px';
        planSuffix.style.color = '#64748b';
        planSuffix.style.whiteSpace = 'nowrap';

        const planNameBtn = document.createElement('button');
        planNameBtn.type = 'button';
        planNameBtn.className = 'btn share-modal-secondary';
        planNameBtn.textContent = tShare('plan.nameButton', 'Save name');

        planNameRow.append(planNameInput, planSuffix, planNameBtn);
        planNameWrap.appendChild(planNameRow);

        const planNameStatus = document.createElement('div');
        planNameStatus.style.fontSize = '12px';
        planNameStatus.style.minHeight = '16px';
        planNameWrap.appendChild(planNameStatus);

        const planNameToken = (slug) => `cb_plan_token_${slug}`;
        const slugifyPlanName = (s) => (s || '').toString().trim().toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

        async function submitNamedPlan() {
            const idMatch = (linkInput.value || '').match(/\/proposals\/([0-9,]+)/);
            if (!idMatch) {
                planNameStatus.style.color = '#b3261e';
                planNameStatus.textContent = tShare('plan.namePrepFirst', 'Prepare the share link above first (upload all selected proposals).');
                return;
            }
            const slug = slugifyPlanName(planNameInput.value);
            if (slug.length < 3) {
                planNameStatus.style.color = '#b3261e';
                planNameStatus.textContent = tShare('plan.nameInvalid', 'Use at least 3 characters: a–z, 0–9, hyphens.');
                return;
            }
            const proposalIds = idMatch[1].split(',');
            const base = (typeof window.getBackendBase === 'function') ? window.getBackendBase().replace(/\/$/, '') : '';
            const city = (window.CityConfigManager && typeof window.CityConfigManager.getCurrentCityId === 'function')
                ? window.CityConfigManager.getCurrentCityId() : null;
            let existingToken = null;
            try { existingToken = localStorage.getItem(planNameToken(slug)); } catch (_) { /* ignore */ }

            planNameBtn.disabled = true;
            planNameStatus.style.color = '#475569';
            planNameStatus.textContent = tShare('plan.nameSaving', 'Saving…');
            try {
                let resp;
                if (existingToken) {
                    resp = await fetch(`${base}/plans/${slug}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ editToken: existingToken, proposalIds })
                    });
                } else {
                    resp = await fetch(`${base}/plans`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ slug, proposalIds, city })
                    });
                }
                const data = await resp.json().catch(() => ({}));
                if (resp.status === 409) {
                    planNameStatus.style.color = '#b3261e';
                    planNameStatus.textContent = tShare('plan.nameTaken', 'That name is taken — pick another.');
                    return;
                }
                if (!resp.ok) {
                    planNameStatus.style.color = '#b3261e';
                    planNameStatus.textContent = data.error || tShare('plan.nameError', 'Could not save the name.');
                    return;
                }
                if (data.editToken) {
                    try { localStorage.setItem(planNameToken(slug), data.editToken); } catch (_) { /* ignore */ }
                }
                planNameStatus.style.color = '#0a7d28';
                planNameStatus.textContent = (data.name || `${slug}.proposals.urbangametheory.eth`)
                    + ' — ' + tShare('plan.nameSaved', 'saved (resolves to this plan).');
            } catch (_) {
                planNameStatus.style.color = '#b3261e';
                planNameStatus.textContent = tShare('plan.nameError', 'Could not save the name.');
            } finally {
                planNameBtn.disabled = false;
            }
        }
        planNameBtn.addEventListener('click', submitNamedPlan);
        planNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNamedPlan(); });

        shareArea.appendChild(planNameWrap);
        container.appendChild(shareArea);

        const setStatus = (message) => {
            statusLine.textContent = message || '';
        };

        const updateShareUrl = () => {
            const hasSelection = selected.size > 0;
            if (!hasSelection) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                setStatus(tShare('plan.selectHint', 'Select at least one proposal to share.'));
                return;
            }

            const selectedKeys = Array.from(selected);
            const selectedProposals = selectedKeys.map(key => proposalsByHash.get(key)).filter(Boolean);

            const selectedStates = selectedKeys
                .map(key => uploadState.get(key))
                .filter(Boolean);

            const anyUploading = selectedStates.some(s => !!s.uploading);
            if (anyUploading) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                setStatus(tShare('plan.checkingHint', 'Checking upload status…'));
                return;
            }

            const uploadedIds = selectedKeys
                .map(key => uploadState.get(key))
                .filter(state => state && state.uploaded && state.serverId)
                .map(state => state.serverId)
                .filter(id => {
                    // Only include numeric serial IDs, never hashes
                    return id && /^\d+$/.test(String(id));
                });

            if (uploadedIds.length !== selectedKeys.length) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                const anyUploaded = uploadedIds.length > 0;
                setStatus(anyUploaded
                    ? tShare('plan.uploadHint', 'Upload all selected proposals to enable sharing, or deselect some.')
                    : tShare('plan.noUploadedHint', 'Upload at least one proposal to enable sharing.')
                );
                return;
            }

            const sortedIds = sortProposalIdsForShare(uploadedIds);
            const cityParam = buildCityQueryParam();
            const queryJoiner = cityParam ? '&' : '?';
            const shareUrl = `${resolveFrontendBaseUrl()}/proposals/${sortedIds.join(',')}${cityParam}${queryJoiner}3d${shareLangParam()}`;
            linkInput.value = shareUrl;
            linkRow.style.display = 'flex';
            setStatus('');
        };

        const updateRowState = (key) => {
            const controls = rowControls.get(key);
            const state = uploadState.get(key) || { uploaded: false, uploading: false };
            if (!controls) return;
            if (state.uploaded) {
                controls.uploadBtn.style.display = 'none';
                controls.uploadedLabel.style.display = 'inline-flex';
                controls.uploadedLabel.textContent = tShare('plan.uploaded', 'Uploaded');
            } else {
                controls.uploadedLabel.style.display = 'none';
                controls.uploadBtn.style.display = 'inline-flex';
                controls.uploadBtn.disabled = state.uploading;
                controls.uploadBtn.textContent = state.uploading
                    ? tShare('plan.uploading', 'Uploading…')
                    : tShare('plan.upload', 'Upload');
            }
            controls.checkbox.checked = selected.has(key);
            if (controls.row) controls.row.classList.toggle('is-excluded', !selected.has(key));
            controls.row.classList.toggle('is-uploaded', !!state.uploaded);
            // The map says the same thing the row says. An overlay painted before the server
            // answered would otherwise keep claiming "not uploaded" after the answer arrived.
            if (overlayByKey.has(key)) syncPlanOverlay(key);
        };

        const toggleCheckbox = (key, checked) => {
            const controls = rowControls.get(key);
            if (controls) {
                controls.checkbox.checked = checked;
                if (controls.row) controls.row.classList.toggle('is-excluded', !checked);
            }
        };

        const onCheckboxChange = (key, checked) => {
            if (checked) selected.add(key);
            else selected.delete(key);
            toggleCheckbox(key, checked);
            // Toggling a row paints or unpaints THAT row. The map is not painted when the panel
            // opens (see the fill below) — checked means "in the plan", not "drawn right now".
            syncPlanOverlay(key);
            setStatus('');
            updateShareUrl();
        };

        const attachRow = (proposal, key) => {
            const row = document.createElement('div');
            row.className = 'share-plan-row';

            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.alignItems = 'center';
            left.style.gap = '8px';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.addEventListener('change', () => onCheckboxChange(key, checkbox.checked));
            left.appendChild(checkbox);

            // The chip carries the exact colour this proposal is painted with on the map.
            const chip = document.createElement('span');
            chip.className = 'share-plan-color-chip';
            chip.style.background = colorByKey.get(key) || '#4363d8';
            left.appendChild(chip);

            const title = document.createElement('div');
            title.style.display = 'flex';
            title.style.flexDirection = 'column';
            title.style.gap = '2px';

            const name = document.createElement('span');
            name.textContent = proposal.title || proposal.name || tShare('untitled', '(Untitled)');
            name.style.fontWeight = '600';
            name.style.fontSize = '13px';
            title.appendChild(name);

            const meta = document.createElement('span');
            meta.style.fontSize = '12px';
            meta.style.color = '#475569';
            const displayId = proposal.proposalId || getProposalKey(proposal) || 'local';
            meta.textContent = `${displayId} · ${(resolveProposalGoalKey(proposal) || 'proposal')}`;
            title.appendChild(meta);

            left.appendChild(title);

            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.alignItems = 'center';
            right.style.gap = '8px';

            const uploadBtn = document.createElement('button');
            uploadBtn.type = 'button';
            uploadBtn.className = 'btn share-modal-secondary';
            uploadBtn.textContent = tShare('plan.upload', 'Upload');

            const uploadedLabel = document.createElement('span');
            uploadedLabel.style.fontSize = '12px';
            uploadedLabel.style.color = '#0f766e';
            uploadedLabel.style.display = 'none';

            uploadBtn.addEventListener('click', async () => {
                uploadState.set(key, { uploaded: false, uploading: true, serverId: getServerProposalId(proposal) });
                updateRowState(key);
                try {
                    const result = await uploadProposalToServer(proposal);
                    if (!result.ok) {
                        throw new Error(result.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
                    }
                    // Always use the serial ID (numeric) from the server response, never a hash
                    const serverId = result.id ? String(result.id) : (result.proposalId ? String(result.proposalId) : null);
                    if (!serverId || !/^\d+$/.test(serverId)) {
                        throw new Error(tShare('uploadError', 'Server did not return a valid serial ID. Please try again.'));
                    }

                    // syncProposalWithServerId updates the stored proposal with serverProposalId.
                    // Keep using the local proposal key for UI/state to avoid collisions with on-chain numeric ids.
                    const updatedProposal = proposalStorage.getProposal(key) || proposal;

                    // Update the proposal in our map with fresh data
                    proposalsByHash.set(key, updatedProposal);

                    // Update the meta display with new ID
                    const controls = rowControls.get(key);
                    if (controls && controls.meta) {
                        const displayId = updatedProposal.proposalId || getProposalKey(updatedProposal) || 'local';
                        controls.meta.textContent = `${displayId} · ${(resolveProposalGoalKey(updatedProposal) || 'proposal')}`;
                    }

                    uploadState.set(key, { uploaded: true, uploading: false, serverId });
                    updateRowState(key);
                    updateShareUrl();
                } catch (error) {
                    console.error('plan upload failed', error);
                    uploadState.set(key, { uploaded: false, uploading: false, serverId: getServerProposalId(proposal) });
                    updateRowState(key);
                    setStatus(error.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
                }
            });

            right.appendChild(uploadBtn);
            right.appendChild(uploadedLabel);

            row.appendChild(left);
            row.appendChild(right);

            // Rows are the ONLY proposal interaction in share-plan mode: hovering outlines the
            // proposal on the map, clicking also frames it. Nothing opens details.
            row.addEventListener('mouseenter', () => highlightRowProposal(key));
            row.addEventListener('mouseleave', () => {
                try { if (typeof clearProposalHoverLayers === 'function') clearProposalHoverLayers(); } catch (_) { }
            });
            row.addEventListener('click', (event) => {
                if (event.target && event.target.closest && event.target.closest('input, button')) return;
                highlightRowProposal(key);
                frameRowProposal(key);
            });

            listWrap.appendChild(row);
            rowControls.set(key, { row, checkbox, chip, uploadBtn, uploadedLabel, meta });
        };

        const refreshUploadState = async (key, proposal, known = null) => {
            const serverId = getServerProposalId(proposal);
            if (!serverId) {
                uploadState.set(key, { uploaded: false, uploading: false, serverId: null });
                updateRowState(key);
                return;
            }
            uploadState.set(key, { uploaded: false, uploading: true, serverId });
            updateRowState(key);
            // `known` is the whole server list when it could be fetched completely; consult it
            // rather than making a request per proposal. Null means we could not get an
            // authoritative list, so ask about this one — slow, never wrong.
            //
            // But it is authoritative only FOR ITS CITY: the list is fetched with ?city=, so a
            // proposal stored without one (or under another) is missing from it while sitting
            // happily on the server. A miss is therefore not proof of absence, and treating it as
            // proof is not merely cosmetic — the row invites an upload that creates a SECOND copy
            // of something already there. So a miss is confirmed one proposal at a time, which
            // costs a request only for the rows that were about to be reported as missing anyway.
            let exists = (known instanceof Set)
                ? known.has(String(serverId))
                : await headProposalExists(serverId, proposal.city, proposal);
            if (!exists && (known instanceof Set)) {
                exists = await headProposalExists(serverId, proposal.city, proposal);
            }

            // After headProposalExists, the proposal may have been synced with serverProposalId
            // Get the serial ID (numeric) if available
            // headProposalExists syncs the proposal when checking by hash, so refresh our reference
            const refreshedProposal = proposalStorage.getProposal(key) || proposal;
            let serialId = getSerialProposalId(refreshedProposal);

            // If proposal exists but we still don't have serial ID, try fetching it directly
            if (!serialId && exists) {
                const isNumericId = /^\d+$/.test(String(serverId));
                if (!isNumericId) {
                    // We checked by hash, need to fetch the full proposal to get serial ID
                    try {
                        const backendBase = resolveBackendBaseUrl();
                        const url = `${backendBase}/proposals/${encodeURIComponent(serverId)}`;
                        const response = await fetch(url);
                        if (response.ok) {
                            const payload = await response.json();
                            if (payload && payload.id) {
                                serialId = String(payload.id);
                                // Sync the proposal with the serial ID
                                syncProposalWithServerId(refreshedProposal, serialId);
                            }
                        }
                    } catch (error) {
                        console.warn('Failed to fetch serial ID for proposal', serverId, error);
                    }
                } else {
                    // serverId is already numeric, use it
                    serialId = String(serverId);
                }
            }

            // Only use serial ID for share links, never hashes
            const shareId = serialId && /^\d+$/.test(serialId) ? serialId : null;
            uploadState.set(key, { uploaded: !!exists, uploading: false, serverId: shareId });
            updateRowState(key);
            updateShareUrl();
        };

        const showProgress = (phraseKey, fallback, done, total) => {
            const text = tShare(phraseKey, fallback, { done, total });
            if (progressText) progressText.textContent = text;
            // Mirrored to the opener: its dialog is covering this panel until we are ready.
            if (onProgress) { try { onProgress(text); } catch (_) { } }
        };
        const clearProgress = () => {
            // Gone rather than hidden: finished work has nothing left to say, and a panel that
            // keeps a dead spinner reads as still working.
            if (progressRow && progressRow.parentNode) progressRow.parentNode.removeChild(progressRow);
        };

        // Which proposals the server already has — asked ONCE, not once per proposal.
        //
        // This used to be a sequential request per row: 300 proposals, 300 round trips, and in a
        // plan where none had been uploaded, 300 consecutive 404s in the console. The list endpoint
        // answers the same question in one call.
        //
        // Absence is only proof when the list is COMPLETE, so the count is checked against what came
        // back. Short list, or any failure, and this returns null — the caller then falls back to
        // asking per proposal, which is slow but never wrong. A truncated list treated as complete
        // would report uploaded proposals as missing and offer to upload them again.
        const serverProposalIndex = async () => {
            try {
                const base = (typeof resolveBackendBaseUrl === 'function') ? resolveBackendBaseUrl() : '';
                const city = (typeof CityConfigManager !== 'undefined' && CityConfigManager.getCurrentCityId)
                    ? CityConfigManager.getCurrentCityId() : '';
                const query = city ? `city=${encodeURIComponent(city)}` : '';
                const countResponse = await fetch(`${base}/proposals/count?${query}`);
                if (!countResponse.ok) return null;
                const expected = Number((await countResponse.json()).count);
                if (!Number.isFinite(expected)) return null;

                const listResponse = await fetch(`${base}/proposals/summary?${query}&limit=${expected + 50}`);
                if (!listResponse.ok) return null;
                const payload = await listResponse.json();
                const rows = Array.isArray(payload && payload.proposals) ? payload.proposals : null;
                if (!rows || rows.length < expected) return null;

                const known = new Set();
                rows.forEach(row => {
                    if (row && row.proposalId) known.add(String(row.proposalId));
                    if (row && row.id !== undefined && row.id !== null) known.add(String(row.id));
                });
                return known;
            } catch (_) { return null; }
        };

        const initializeUploadChecks = async () => {
            const total = proposalsByHash.size;
            let done = 0;
            showProgress('checkingProposals', 'Checking {done}/{total} proposals on the server...', done, total);
            const known = await serverProposalIndex();
            if (!panelStillOpen()) return;
            for (const [key, proposal] of proposalsByHash.entries()) {
                if (!panelStillOpen()) return;
                await refreshUploadState(key, proposal, known);
                done += 1;
                showProgress('checkingProposals', 'Checking {done}/{total} proposals on the server...', done, total);
            }
            updateShareUrl();
        };

        // The panel goes up EMPTY and fills itself in. Building it in one go meant a row and a map
        // overlay (turf intersections + a Leaflet layer) per applied proposal before a single pixel
        // appeared — seconds of frozen page on a real plan, with no way to show a spinner because
        // nothing could paint. Each pass now yields the moment it has held the thread long enough,
        // so the list grows in front of you and the map is never locked for more than a frame.
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

        document.body.appendChild(panelRoot);
        const onKeyDown = (event) => {
            if (event.key === 'Escape') closeSharePlanPanel();
        };
        document.addEventListener('keydown', onKeyDown);
        _sharePlanPanelState = { root: panelRoot, overlayGroups, onKeyDown, token: panelToken };

        // Clicking a proposal ON THE MAP finds it in the list. The map and the panel are two views
        // of one plan, so pointing at something in either should say where it is in the other —
        // otherwise finding one row among several hundred means scrolling and reading titles.
        //
        // The resolution from a clicked parcel to its applied proposal already exists in
        // onParcelClick (parcels/ui/parcel-selection.js), which is why this is a callback it can
        // reach rather than a second map handler racing it for the same click.
        window.__sharePlanPickProposal = (proposal, parcelId) => {
            if (!panelStillOpen() || !proposal) return;
            const key = keyOfProposal(proposal);
            if (!key || !rowControls.has(key)) {
                // Applied, but not in this plan: say so rather than silently doing nothing, which
                // is indistinguishable from a click that missed.
                setStatus(tShare('plan.pickedNotInPlan', 'That proposal is not in this plan.'));
                return;
            }
            revealRow(key, parcelId);
        };

        fillStarted = true;
        (async () => {
            try {
                const entries = [...proposalsByHash.entries()];
                // Rows first, and all of them before the checks start: a check that lands before
                // its row exists updates nothing (updateRowState bails on a missing control).
                if (!await inChunks(entries, ([key, proposal]) => attachRow(proposal, key),
                    'listingProposals', 'Listing {done}/{total} proposals...')) return;

                // The map is NOT painted on open. Opening a list is not a request to draw three
                // hundred overlays: it cost seconds of turf and Leaflet work before the panel was
                // usable, and it left the map unreadable under the whole plan at once. Overlays are
                // what HOVER and CLICK are for, and toggling a row still syncs its own overlay.
                try { if (typeof fitMapToAppliedProposals === 'function') fitMapToAppliedProposals(); } catch (_) { }

                // Rows are up and the map is framed: this is the moment the panel stops looking
                // half-built, so whoever is holding a dialog over it can let go. The upload
                // checks below fill in badges afterwards, in plain sight.
                readySignal.settle('ready');

                await initializeUploadChecks();
            } catch (error) {
                console.error('share plan: filling the panel failed', error);
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

function showShareLinkModal(shareUrl, payload, options = {}) {
    if (typeof document === 'undefined') return;

    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();
    const proposals = Array.isArray(payload?.proposals) ? payload.proposals : [];
    const proposalCount = proposals.length;
    const fragment = document.createDocumentFragment();

    if (options && options.nearLimit) {
        const warning = document.createElement('p');
        warning.style.color = '#b00020';
        warning.style.fontWeight = '600';
        warning.textContent = tShare('sizeWarning', 'Warning: This link is close to the maximum size the server accepts. Consider sharing fewer parcels if it fails.');
        fragment.appendChild(warning);
    }

    const intro = document.createElement('p');
    const introParams = (options && options.introParams) || { count: proposalCount };
    intro.innerHTML = (options && options.introHtml)
        ? options.introHtml
        : tShare('defaultIntro', 'Share this link to load {{count}} applied proposals.', introParams);
    fragment.appendChild(intro);

    const textarea = document.createElement('textarea');
    textarea.className = 'share-modal-link';
    textarea.value = shareUrl;
    textarea.setAttribute('readonly', 'readonly');
    fragment.appendChild(textarea);

    const info = document.createElement('p');
    const unknownText = t('common.unknown', 'Unknown');
    const zoomValue = payload?.camera && typeof payload.camera.zoom === 'number'
        ? payload.camera.zoom
        : unknownText;
    const encodedLength = (options && typeof options.encodedLength === 'number') ? options.encodedLength : null;
    const contentLabel = tShare('stats.contentLabel', 'Content:');
    const sizeLabel = tShare('stats.sizeLabel', 'Size:');
    const authorLabel = tShare('authorLabel', 'Author:');
    const cameraLabel = tShare('cameraLabel', 'Camera zoom:');
    const proposalsLabel = tShare('proposalsLabel', 'Proposals:');
    const sizeStats = (function () {
        try {
            const totalProposals = proposalCount;
            const roadCount = proposals.filter(p => p.roadProposal).length;
            const buildingCount = proposals.filter(p => p.buildingProposal).length;
            const parcelCount = proposals.reduce((sum, p) => sum + (Array.isArray(p.parentParcelIds) ? p.parentParcelIds.length : 0), 0);
            const estimatedBytes = encodedLength !== null
                ? encodedLength
                : (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(JSON.stringify(payload)).length : JSON.stringify(payload).length);
            const kb = (estimatedBytes / 1024).toFixed(1);
            const maxKb = (SHARE_URL_MAX_LENGTH / 1024).toFixed(1);
            const contentSummary = tShare('stats.contentSummary', '{{total}} proposals • {{roads}} roads • {{buildings}} buildings • {{parcels}} parcels', {
                total: totalProposals,
                roads: roadCount,
                buildings: buildingCount,
                parcels: parcelCount
            });
            const sizeSummary = tShare('stats.sizeSummary', '~{{kb}} KB of encoded link (server limit ~{{maxKb}} KB)', {
                kb,
                maxKb
            });
            return `<br><strong>${contentLabel}</strong> ${contentSummary}` +
                `<br><strong>${sizeLabel}</strong> ${sizeSummary}`;
        } catch (_) { return ''; }
    })();
    const authorText = payload?.author || unknownText;
    const safeAuthor = typeof escapeHtml === 'function' ? escapeHtml(authorText) : authorText;
    info.innerHTML = `<strong>${authorLabel}</strong> ${safeAuthor}<br><strong>${cameraLabel}</strong> ${zoomValue}<br><strong>${proposalsLabel}</strong> ${proposalCount}${sizeStats}`;
    fragment.appendChild(info);

    const note = document.createElement('p');
    note.style.color = '#555';
    note.innerHTML = tShare('note', 'Server-backed sharing is coming soon. JSON export is provided for archival/manual sharing; future compatibility is not guaranteed.');
    fragment.appendChild(note);

    const modal = showSimpleShareModal({
        title: tShare('title', 'Share Proposal'),
        body: fragment,
        actions: [
            {
                label: tShare('saveJson', 'Save as JSON'),
                onClick: () => {
                    try { savePlanPayloadAsJson(payload); } catch (e) { console.warn('Save JSON failed', e); }
                }
            },
            {
                label: tShare('copyLink', 'Copy Link'),
                primary: true,
                onClick: () => {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(shareUrl).then(() => {
                            if (typeof showEphemeralMessage === 'function') {
                                showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                            }
                        }).catch(() => {
                            textarea.focus();
                            textarea.select();
                        });
                    } else {
                        textarea.focus();
                        textarea.select();
                    }
                }
            }
        ]
    });

    if (modal && textarea) {
        setTimeout(() => {
            textarea.focus();
            textarea.select();
        }, 75);
    }
}

function showShareTooLargeModal() {
    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();
    showSimpleShareModal({
        title: tShare('tooLargeTitle', 'Proposal Set Too Large'),
        body: `<p>${tShare('tooLargeBody', 'Links are limited to roughly 7.5 KB on the server, so this proposal set cannot be embedded in the URL. Reduce the number of parcels/proposals or use the JSON export while we finish server-side sharing.')}</p>`,
        actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
    });
}

function showSimpleShareModal(options = {}) {
    if (typeof document === 'undefined') return null;

    const t = getProposalI18nHelper();
    const closeLabel = t('modal.common.close', 'Close');

    const overlay = document.createElement('div');
    overlay.className = 'share-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'share-modal';

    const closeOnOverlay = options.closeOnOverlay !== false;
    const closeOnEscape = options.closeOnEscape !== false;
    const autoCloseActions = options.autoCloseActions !== false;

    const header = document.createElement('div');
    header.className = 'share-modal-header';

    const titleEl = document.createElement('h2');
    titleEl.className = 'share-modal-title';
    titleEl.textContent = options.title || '';
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'share-modal-close close-circle-btn close-circle-btn--lg';
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);

    modal.appendChild(header);

    const bodyContainer = document.createElement('div');
    bodyContainer.className = 'share-modal-body';

    if (Array.isArray(options.body)) {
        options.body.forEach(node => appendModalBody(bodyContainer, node));
    } else if (options.body) {
        appendModalBody(bodyContainer, options.body);
    }

    modal.appendChild(bodyContainer);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'share-modal-actions';

    const actions = Array.isArray(options.actions) ? options.actions : [];

    let didClose = false;
    const modalApi = {
        close: closeModal,
        overlay,
        modal,
        body: bodyContainer,
        getActionButton: (id) => {
            try { return actionsContainer.querySelector(`button[data-action-id="${id}"]`); } catch (_) { return null; }
        }
    };

    actions.forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn ${action.primary ? 'share-modal-primary' : 'share-modal-secondary'}`;
        button.textContent = action.label || closeLabel;
        if (action && action.id) {
            button.setAttribute('data-action-id', String(action.id));
        }
        if (action && action.disabled) {
            button.disabled = true;
            button.classList.add('disabled');
        }
        button.addEventListener('click', (e) => {
            // If disabled, do nothing
            if (button.disabled || button.classList.contains('disabled')) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // keepOpen: an action that works ON the modal (copy its text, toggle a detail)
            // must not dismiss it.
            if (autoCloseActions && action.keepOpen !== true) {
                closeModal();
            }
            if (typeof action.onClick === 'function') {
                action.onClick(modalApi);
            }
        });
        actionsContainer.appendChild(button);
    });

    if (actions.length > 0) {
        modal.appendChild(actionsContainer);
    }
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function onOverlayClick(event) {
        if (!closeOnOverlay) return;
        if (event.target === overlay) {
            closeModal();
        }
    }

    function onKeyDown(event) {
        if (!closeOnEscape) return;
        if (event.key === 'Escape') {
            closeModal();
        }
    }

    function closeModal() {
        if (didClose) return;
        didClose = true;
        try { overlay.removeEventListener('click', onOverlayClick); } catch (_) { }
        try { document.removeEventListener('keydown', onKeyDown); } catch (_) { }
        try { overlay.remove(); } catch (_) { }

        try {
            if (typeof options.onClose === 'function') {
                options.onClose();
            }
        } catch (_) { }
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);

    return modalApi;
}

function showSharedPayloadInspector(payload) {
    return new Promise(resolve => {
        try {
            const t = getProposalI18nHelper();
            const tShare = getShareI18nHelper();
            const tShared = getSharedInspectorI18nHelper();
            const unknownText = t('common.unknown', 'Unknown');
            const container = document.createElement('div');
            container.className = 'shared-payload-inspector';

            // Summary
            const summary = document.createElement('div');
            summary.className = 'spi-summary';
            const total = Array.isArray(payload.proposals) ? payload.proposals.length : 0;
            const bytes = (() => { try { return new TextEncoder().encode(JSON.stringify(payload)).length; } catch (_) { return 0; } })();
            const kb = (bytes / 1024).toFixed(1);
            summary.innerHTML = `
                <p><strong>${tShared('author', 'Author:')}</strong> ${escapeHtml(payload.author || unknownText)}
                &nbsp;•&nbsp;<strong>${tShared('version', 'Version:')}</strong> ${String(payload.version ?? '')}
                &nbsp;•&nbsp;<strong>${tShared('generated', 'Generated:')}</strong> ${escapeHtml(payload.generatedAt || '')}
                &nbsp;•&nbsp;<strong>${tShared('count', 'Proposals:')}</strong> ${total}
                &nbsp;•&nbsp;<strong>${tShared('payload', 'Payload:')}</strong> ~${kb} KB</p>
            `;
            container.appendChild(summary);

            // Full JSON view (collapsible)
            const detailsWrap = document.createElement('details');
            const detailsSum = document.createElement('summary');
            detailsSum.textContent = tShared('viewJson', 'View full decoded payload JSON');
            detailsWrap.appendChild(detailsSum);
            const pre = document.createElement('pre');
            pre.style.maxHeight = '240px';
            pre.style.overflow = 'auto';
            pre.textContent = (() => { try { return JSON.stringify(payload, null, 2); } catch (_) { return '[unserializable]'; } })();
            detailsWrap.appendChild(pre);
            container.appendChild(detailsWrap);

            // Proposal selection list
            const list = document.createElement('div');
            list.className = 'spi-proposal-list';
            const selected = new Set();
            (payload.proposals || []).forEach((p, idx) => {
                const item = document.createElement('div');
                item.className = 'spi-proposal-item';
                item.style.border = '1px solid #ddd';
                item.style.borderRadius = '6px';
                item.style.padding = '8px';
                item.style.marginBottom = '8px';

                const id = `spi-prop-${idx}-${(p.proposalId || '').slice(0, 8)}`;
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = id;
                checkbox.checked = true;
                checkbox.dataset.hash = p.proposalId || '';
                checkbox.addEventListener('change', () => {
                    const h = checkbox.dataset.hash;
                    if (!h) return;
                    if (checkbox.checked) selected.add(h); else selected.delete(h);
                });

                // Default add to selection
                if (p.proposalId) selected.add(p.proposalId);

                const label = document.createElement('label');
                label.setAttribute('for', id);
                const displayId = p.proposalId ? String(p.proposalId) : '';
                const title = `${p.title || tShare('untitled', '(Untitled)')}${displayId ? ` (ID #${displayId})` : ''}`;
                label.innerHTML = `<strong>${escapeHtml(title)}</strong> • ${escapeHtml(p.type || 'parcel')} • ${escapeHtml(p.proposalId || '')}`;

                const meta = document.createElement('div');
                meta.className = 'spi-proposal-meta';
                const parentIdsDisplay = Array.isArray(p.parentParcelIds) ? p.parentParcelIds.join(', ') : '';
                const roadParents = (p.roadProposal && Array.isArray(p.roadProposal.parentParcelIds)) ? p.roadProposal.parentParcelIds.join(', ') : '';
                const buildingParents = (p.buildingProposal && Array.isArray(p.buildingProposal.parentParcelIds)) ? p.buildingProposal.parentParcelIds.join(', ') : '';
                meta.innerHTML = `
                    <small>
                        ${tShared('ancestorIds', 'Parent Parcel IDs:')} ${escapeHtml(parentIdsDisplay)}<br>
                        ${tShared('roadParents', 'Road parents:')} ${escapeHtml(roadParents)}<br>
                        ${tShared('buildingParents', 'Building parents:')} ${escapeHtml(buildingParents)}
                    </small>
                `;

                const propDetails = document.createElement('details');
                const propSummary = document.createElement('summary');
                propSummary.textContent = tShared('details', 'Details');
                propDetails.appendChild(propSummary);
                const propPre = document.createElement('pre');
                propPre.style.maxHeight = '180px';
                propPre.style.overflow = 'auto';
                try { propPre.textContent = JSON.stringify(p, null, 2); } catch (_) { propPre.textContent = '[unserializable]'; }
                propDetails.appendChild(propPre);

                item.appendChild(checkbox);
                item.appendChild(label);
                item.appendChild(meta);
                item.appendChild(propDetails);
                list.appendChild(item);
            });
            container.appendChild(list);

            // autoCloseActions is off so each action resolves before closing (closeModal fires
            // onClose, whose resolve(null) is then a no-op). Dismissing the modal any other way
            // (×, Escape, overlay click) resolves as a cancel instead of hanging the caller.
            const modal = showSimpleShareModal({
                title: tShared('title', 'Review Shared Proposals'),
                body: container,
                autoCloseActions: false,
                actions: [
                    {
                        label: t('modal.common.cancel', 'Cancel'),
                        onClick: (modalApi) => {
                            resolve(null);
                            if (modalApi && typeof modalApi.close === 'function') modalApi.close();
                        }
                    },
                    {
                        id: 'apply',
                        label: tShared('loading', 'Parcels still loading...'),
                        primary: true,
                        disabled: true,
                        onClick: (modalApi) => {
                            resolve(selected);
                            if (modalApi && typeof modalApi.close === 'function') modalApi.close();
                        }
                    }
                ],
                onClose: () => resolve(null)
            });

            // Extra safety: ensure button starts disabled right after modal mount
            try {
                const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                if (applyBtn) {
                    applyBtn.disabled = true;
                    applyBtn.classList.add('disabled');
                    applyBtn.textContent = tShared('loading', 'Parcels still loading...');
                }
            } catch (_) { }

            // Prepare the exact ground declared by the proposals. CadastralGroundService decides
            // whether that means a cache hit, joining an in-flight request, or server transport.
            (async () => {
                try {
                    try { window.suppressCameraMoves = true; } catch (_) { }
                    const ground = (typeof CadastralGroundService !== 'undefined' && CadastralGroundService)
                        ? CadastralGroundService
                        : ((typeof window !== 'undefined') ? window.CadastralGroundService : null);
                    if (!ground || typeof ground.ensureProposalGround !== 'function') {
                        throw new Error('Cadastral ground service is unavailable.');
                    }
                    await ground.ensureProposalGround(payload.proposals || [], { purpose: 'application' });
                } catch (e) {
                    console.warn('Preparing cadastral ground for shared payload failed (continuing):', e);
                } finally {
                    try {
                        const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                        if (applyBtn) {
                            applyBtn.disabled = false;
                            applyBtn.classList.remove('disabled');
                            applyBtn.textContent = tShared('applySelected', 'Apply Selected');
                        }
                    } catch (_) { }
                    try { window.suppressCameraMoves = false; } catch (_) { }
                }
            })();

            // As a fallback, also enable on parcelDataLoaded event (in case of cached data or fast path)
            const onParcelLoaded = () => {
                try {
                    const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                    if (applyBtn) {
                        applyBtn.disabled = false;
                        applyBtn.classList.remove('disabled');
                        applyBtn.textContent = tShared('applySelected', 'Apply Selected');
                    }
                } catch (_) { }
                try { window.removeEventListener('parcelDataLoaded', onParcelLoaded); } catch (_) { }
            };
            try { window.addEventListener('parcelDataLoaded', onParcelLoaded, { once: true }); } catch (_) { }
        } catch (e) {
            console.error('showSharedPayloadInspector failed', e);
            resolve(null);
        }
    });
}
