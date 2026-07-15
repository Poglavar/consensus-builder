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

    const scrollPositions = {
        active: 0,
        executed: 0
    };

    const existingActiveTab = modal.querySelector('#active-proposals-tab');
    if (existingActiveTab) {
        scrollPositions.active = existingActiveTab.scrollTop;
    }

    const existingExecutedTab = modal.querySelector('#executed-proposals-tab');
    if (existingExecutedTab) {
        scrollPositions.executed = existingExecutedTab.scrollTop;
    }

    const source = proposalListState.source || 'local';
    const cityCode = resolveCurrentCityCode();
    const allProposals = proposalStorage.getAllProposals();

    // Check and update expiry status for all proposals
    allProposals.forEach(proposal => {
        checkAndUpdateProposalExpiry(proposal);
    });

    const buildDatasets = (augmentedList) => {
        const active = augmentedList.filter(entry => (entry.proposal.status || '').toLowerCase() !== 'executed');
        const executed = augmentedList.filter(entry => (entry.proposal.status || '').toLowerCase() === 'executed');
        const filteredActive = applyProposalListFilters(active);
        const filteredExecuted = applyProposalListFilters(executed);
        const sortedActive = sortProposalDataset(filteredActive);
        const sortedExecuted = sortProposalDataset(filteredExecuted);
        return {
            augmented: augmentedList,
            active,
            executed,
            filteredActive,
            filteredExecuted,
            sortedActive,
            sortedExecuted
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
        const isSelectedVisible = chosen.sortedActive.some(entry => getProposalKey(entry.proposal) === selectedId)
            || chosen.sortedExecuted.some(entry => getProposalKey(entry.proposal) === selectedId);
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

    const syncButtonHtml = source === 'local' && syncBlockchainAvailable ? `
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

    const controlsHtml = `
        <div class="proposal-list-controls">
            <div class="proposal-filter-group">
                <label for="proposal-filter-type" data-i18n-key="modal.roadWidth.proposalList.filters.goal">${escapeHtml(modalStrings.filters.goal)}</label>
                <select id="proposal-filter-type">
                    ${goalOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.filterType ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.filters.goals.${option.value}">${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-filter-author" data-i18n-key="modal.roadWidth.proposalList.filters.author">${escapeHtml(modalStrings.filters.author)}</label>
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

    const showServerLoading = source === 'server' && serverProposalCache.loading && chosen.sortedActive.length === 0 && chosen.sortedExecuted.length === 0;
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

    const activeCountDisplay = `${chosen.sortedActive.length}`;

    const executedCountDisplay = `${chosen.sortedExecuted.length}`;

    modal.innerHTML = `
        <div class="proposal-list-modal-content">
            <div class="proposal-list-modal-header">
                <h2 data-i18n-key="modal.roadWidth.proposalList.title">${escapeHtml(modalStrings.title)}</h2>
                <button type="button" class="proposal-list-modal-close close-circle-btn close-circle-btn--lg" aria-label="${escapeHtml(modalStrings.closeAria)}" data-i18n-key="modal.roadWidth.proposalList.closeAria" data-i18n-attr="aria-label" onclick="closeProposalList()">&times;</button>
            </div>
            ${sourceToggleHtml}
            ${blockchainCantonNote}
            ${controlsHtml}
            <div class="proposal-list-tabs">
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'active' ? 'active' : ''}" data-tab="active" data-i18n-key="modal.roadWidth.proposalList.tabs.active">
                    ${escapeHtml(modalStrings.tabs.active)} (${activeCountDisplay})
                </button>
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'executed' ? 'active' : ''}" data-tab="executed" data-i18n-key="modal.roadWidth.proposalList.tabs.executed">
                    ${escapeHtml(modalStrings.tabs.executed)} (${executedCountDisplay})
                </button>
            </div>
            <div class="proposal-list-modal-body">
                <div id="active-proposals-tab" class="proposal-tab-content ${proposalListState.activeTab === 'active' ? 'active' : ''}">
                    ${buildTabContent(chosen.sortedActive)}
                </div>
                <div id="executed-proposals-tab" class="proposal-tab-content ${proposalListState.activeTab === 'executed' ? 'active' : ''}">
                    ${buildTabContent(chosen.sortedExecuted)}
                </div>
            </div>
        </div>
    `;

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

    modal.querySelectorAll('.proposal-tab-btn').forEach(button => {
        button.addEventListener('click', event => {
            const tab = event.currentTarget.getAttribute('data-tab');
            if (tab && proposalListState.activeTab !== tab) {
                proposalListState.activeTab = tab;
                renderProposalListModal();
            }
        });
    });

    modal.querySelectorAll('.proposal-list-item').forEach(item => {
        item.addEventListener('click', handleProposalListItemClick);
    });

    modal.querySelectorAll('.proposal-download-btn').forEach(button => {
        button.addEventListener('click', handleProposalDownloadClick);
    });

    const activeTabEl = modal.querySelector('#active-proposals-tab');
    if (activeTabEl) {
        activeTabEl.scrollTop = scrollPositions.active;
    }

    const executedTabEl = modal.querySelector('#executed-proposals-tab');
    if (executedTabEl) {
        executedTabEl.scrollTop = scrollPositions.executed;
    }

    if (proposalListState.selectedId) {
        const selectedEl = modal.querySelector(`.proposal-list-item[data-proposal-id="${proposalListState.selectedId}"]`);
        if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }
}

function showAllProposalsModal() {
    resetParcelSelectionForProposalListInteraction();
    try { clearProposalInfoHoverOverlay(); } catch (_) { }

    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

    modal.style.display = 'block';
    renderProposalListModal();
}

function getSharedInspectorI18nHelper() {
    const t = getProposalI18nHelper();
    const namespace = 'modal.roadWidth.sharedInspector';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

function showNonOriginalParcelShareBlockedModal(proposal, parcelList) {
    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();

    const pairs = collectParcelProposalPairs(parcelList);

    const container = document.createElement('div');
    const message = document.createElement('p');
    message.setAttribute('data-i18n-key', 'modal.roadWidth.share.ancestorNote');
    message.textContent = tShare('ancestorNote', 'Note: this proposal includes parcels created by other proposals. For it to be applied on a target map the ancestor proposals will have to be applied first. Instead of sharing this one proposal you might want to share the entire plan using "Share entire plan" button in the Proposals section of the sidebar. The parcel list:');
    container.appendChild(message);

    const listWrapper = document.createElement('div');
    listWrapper.style.maxHeight = '240px';
    listWrapper.style.overflowY = 'auto';
    listWrapper.style.border = '1px solid #d8ddf0';
    listWrapper.style.borderRadius = '8px';
    listWrapper.style.padding = '8px';
    listWrapper.style.background = '#f9fafb';

    // Create table with two columns
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.margin = '0';

    // Table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.style.borderBottom = '1px solid #d8ddf0';

    const headerParcel = document.createElement('th');
    headerParcel.setAttribute('data-i18n-key', 'modal.roadWidth.share.parcelIdHeader');
    headerParcel.textContent = tShare('parcelIdHeader', 'Parcel ID');
    headerParcel.style.padding = '6px 8px';
    headerParcel.style.textAlign = 'left';
    headerParcel.style.fontWeight = '600';
    headerRow.appendChild(headerParcel);

    const headerProposal = document.createElement('th');
    headerProposal.setAttribute('data-i18n-key', 'modal.roadWidth.share.proposalIdHeader');
    headerProposal.textContent = tShare('proposalIdHeader', 'Proposal ID');
    headerProposal.style.padding = '6px 8px';
    headerProposal.style.textAlign = 'left';
    headerProposal.style.fontWeight = '600';
    headerRow.appendChild(headerProposal);

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');
    pairs.forEach(pair => {
        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid #f0f0f0';

        const cellParcel = document.createElement('td');
        cellParcel.textContent = pair.parcelId;
        cellParcel.style.padding = '6px 8px';
        row.appendChild(cellParcel);

        const cellProposal = document.createElement('td');
        cellProposal.textContent = pair.proposalId || '?';
        cellProposal.style.padding = '6px 8px';
        row.appendChild(cellProposal);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    listWrapper.appendChild(table);
    container.appendChild(listWrapper);

    // Apply translations
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
        window.i18n.applyTranslations(container);
    }

    const modal = showSimpleShareModal({
        title: tShare('title', 'Share Proposal'),
        body: container,
        actions: [
            {
                label: tShare('ancestorUploadButton', 'Upload'),
                primary: true,
                onClick: () => {
                    if (proposal) {
                        showUploadProposalModal(proposal);
                    }
                }
            }
        ]
    });
}

function showSharePlanModal() {
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

        const selected = new Set(proposalsByHash.keys());
        const uploadState = new Map(); // key -> { uploaded, uploading, serverId }
        const rowControls = new Map();

        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '12px';

        const totalInPlan = proposalsByHash.size;
        const countLine = document.createElement('div');
        countLine.style.fontSize = '13px';
        countLine.style.color = '#475569';
        countLine.textContent = tShare('plan.countHeading', 'There are {{count}} proposals in the current plan', {
            count: totalInPlan
        });
        container.appendChild(countLine);

        const statusLine = document.createElement('div');
        statusLine.style.minHeight = '18px';
        statusLine.style.color = '#b3261e';
        statusLine.style.fontSize = '12px';
        container.appendChild(statusLine);

        const listWrap = document.createElement('div');
        listWrap.style.maxHeight = '320px';
        listWrap.style.overflowY = 'auto';
        listWrap.style.border = '1px solid #d8ddf0';
        listWrap.style.borderRadius = '8px';
        listWrap.style.padding = '8px';
        listWrap.style.background = '#f9fafb';
        container.appendChild(listWrap);

        const shareArea = document.createElement('div');
        shareArea.style.display = 'flex';
        shareArea.style.flexDirection = 'column';
        shareArea.style.gap = '8px';
        shareArea.style.marginTop = '4px';

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

        const getDescendantsInPlan = (hash) => {
            if (typeof ProposalManager === 'undefined' || typeof ProposalManager.findDescendantTree !== 'function') return [];
            const nodes = ProposalManager.findDescendantTree(hash, { depthLimit: 64 }) || [];
            return nodes.map(n => n.proposalId).filter(h => proposalsByHash.has(h));
        };

        const getAncestorsInPlan = (hash) => {
            if (typeof ProposalManager === 'undefined' || typeof ProposalManager.findAncestorTree !== 'function') return [];
            const nodes = ProposalManager.findAncestorTree(hash, { depthLimit: 64 }) || [];
            return nodes.map(n => n.proposalId).filter(h => proposalsByHash.has(h));
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
        };

        const toggleCheckbox = (key, checked) => {
            const controls = rowControls.get(key);
            if (controls) {
                controls.checkbox.checked = checked;
            }
        };

        const onCheckboxChange = (key, checked) => {
            if (checked) {
                const ancestors = getAncestorsInPlan(key);
                const added = [];
                selected.add(key);
                ancestors.forEach(hash => {
                    if (!selected.has(hash)) added.push(hash);
                    selected.add(hash);
                });
                selected.forEach(hash => toggleCheckbox(hash, true));
                if (added.length > 0) {
                    const summary = added.slice(0, 5).join(', ');
                    setStatus(tShare('plan.addedAncestors', 'Also added {{count}} ancestor proposals: {{list}}', {
                        count: added.length,
                        list: summary
                    }));
                } else {
                    setStatus('');
                }
            } else {
                const descendants = getDescendantsInPlan(key);
                const removed = [];
                selected.delete(key);
                descendants.forEach(hash => {
                    if (selected.delete(hash)) removed.push(hash);
                });
                selected.forEach(hash => toggleCheckbox(hash, selected.has(hash)));
                toggleCheckbox(key, false);
                descendants.forEach(hash => toggleCheckbox(hash, false));
                if (removed.length > 0) {
                    const summary = removed.slice(0, 5).join(', ');
                    setStatus(tShare('plan.removedDescendants', 'Also removed {{count}} descendant proposals: {{list}}', {
                        count: removed.length,
                        list: summary
                    }));
                } else {
                    setStatus('');
                }
            }
            updateShareUrl();
        };

        const attachRow = (proposal, key) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '8px';
            row.style.padding = '6px 4px';

            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.alignItems = 'center';
            left.style.gap = '8px';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.addEventListener('change', () => onCheckboxChange(key, checkbox.checked));
            left.appendChild(checkbox);

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
                const gate = await ensureAncestorProposalsUploaded(proposal);
                if (!gate.ok) {
                    const missingList = gate.missing.map(entry => entry.id || (entry.hash ? entry.hash.slice(0, 8) : '?')).filter(Boolean);
                    setStatus(tShare('plan.uploadAncestorsMissing', 'Upload ancestor proposals first: {{list}}', {
                        list: missingList.join(', ')
                    }));
                    return;
                }

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

            listWrap.appendChild(row);
            rowControls.set(key, { checkbox, uploadBtn, uploadedLabel, meta });
        };

        proposalsByHash.forEach(attachRow);

        const refreshUploadState = async (key, proposal) => {
            const serverId = getServerProposalId(proposal);
            if (!serverId) {
                uploadState.set(key, { uploaded: false, uploading: false, serverId: null });
                updateRowState(key);
                return;
            }
            uploadState.set(key, { uploaded: false, uploading: true, serverId });
            updateRowState(key);
            const exists = await headProposalExists(serverId, proposal.city, proposal);

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

        const initializeUploadChecks = async () => {
            for (const [key, proposal] of proposalsByHash.entries()) {
                await refreshUploadState(key, proposal);
            }
            updateShareUrl();
        };

        showSimpleShareModal({
            title: tShare('plan.title', 'Share Plan'),
            body: container
        });

        initializeUploadChecks();
    } catch (error) {
        console.error('showSharePlanModal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.failed_to_generate_share_link', 'Failed to generate share link.'), 5000, 'error');
        }
    }
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
            if (autoCloseActions) {
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

            // Kick off parcel fetching for bbox only (no camera move); enable Apply once done
            (async () => {
                try {
                    try { window.suppressCameraMoves = true; } catch (_) { }
                    if (typeof fetchParcelData === 'function') {
                        const bounds = (function () {
                            try {
                                if (payload && payload.bbox && isFinite(payload.bbox.south) && isFinite(payload.bbox.north) && isFinite(payload.bbox.west) && isFinite(payload.bbox.east) && typeof L !== 'undefined') {
                                    return L.latLngBounds([
                                        [payload.bbox.south, payload.bbox.west],
                                        [payload.bbox.north, payload.bbox.east]
                                    ]);
                                }
                            } catch (_) { }
                            return null;
                        })();
                        await fetchParcelData(bounds || undefined);
                    }
                } catch (e) {
                    console.warn('Prefetch parcels for shared payload failed (continuing):', e);
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
