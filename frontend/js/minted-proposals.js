(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    const state = {
        overlay: null,
        listNode: null,
        statusNode: null,
        refreshNode: null,
        walletListeners: []
    };

    const template = (str, params = {}) => {
        if (!str) return '';
        return String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
            Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match
        );
    };

    const t = (key, fallback, params = {}) => {
        try {
            if (globalScope.i18n && typeof globalScope.i18n.t === 'function') {
                const value = globalScope.i18n.t(key, params);
                if (value !== undefined && value !== null && value !== '') {
                    return template(value, params);
                }
            }
        } catch (_) { /* ignore translation errors */ }
        if (fallback === undefined || fallback === null) return template(key, params);
        return template(fallback, params);
    };

    const toHttp = (url) => {
        if (!url) return '';
        const str = String(url).trim();
        if (!str) return '';
        if (str.startsWith('ipfs://')) {
            const hash = str.replace(/^ipfs:\/\//, '');
            return `https://ipfs.io/ipfs/${hash}`;
        }
        return str;
    };

    const isDevLikeOrigin = () => {
        try {
            if (!globalScope.location) return false;
            const { protocol, hostname } = globalScope.location;
            const host = (hostname || '').toLowerCase();
            return protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
        } catch (_) {
            return false;
        }
    };

    const getLocalBackendBase = () => {
        try {
            if (typeof globalScope.getBackendBase === 'function') {
                const base = globalScope.getBackendBase();
                if (base) return base;
            }
        } catch (_) { /* ignore */ }

        try {
            const { protocol, hostname } = globalScope.location || {};
            const proto = protocol === 'https:' ? 'https:' : 'http:';
            const host = hostname ? hostname : 'localhost';
            return `${proto}//${host}:3000`;
        } catch (_) {
            return 'http://localhost:3000';
        }
    };

    const resolveResourceUrl = (url) => {
        const httpUrl = toHttp(url);
        if (!httpUrl) return '';

        try {
            const parsed = new URL(httpUrl);
            const host = (parsed.hostname || '').toLowerCase();
            if (isDevLikeOrigin() && host === 'api.urbangametheory.xyz') {
                const backendBase = getLocalBackendBase();
                try {
                    const backend = new URL(backendBase);
                    return `${backend.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
                } catch (_) {
                    return `${backendBase.replace(/\/$/, '')}${parsed.pathname}${parsed.search}${parsed.hash}`;
                }
            }
            return httpUrl;
        } catch (_) {
            return httpUrl;
        }
    };

    const getWalletState = () => {
        const wm = globalScope.walletManager;
        return wm && typeof wm.getState === 'function' ? wm.getState() : null;
    };

    const isWalletConnected = (walletState) => {
        return Boolean(
            walletState &&
            walletState.status === 'connected' &&
            Array.isArray(walletState.accounts) &&
            walletState.accounts.length > 0
        );
    };

    const refreshButtonVisibility = () => {
        const button = document.getElementById('mintedProposalsButton');
        if (!button) return;
        const connected = isWalletConnected(getWalletState());
        button.style.display = connected ? '' : 'none';
    };

    const attachWalletObservers = () => {
        const wm = globalScope.walletManager;
        if (!wm || typeof wm.on !== 'function') return;
        ['stateChanged', 'connect', 'disconnect', 'accountsChanged'].forEach(eventName => {
            const disposer = wm.on(eventName, refreshButtonVisibility);
            if (typeof disposer === 'function') {
                state.walletListeners.push(disposer);
            }
        });
    };

    const getExplorerBaseUrlForChain = (chainId) => {
        const id = chainId ? chainId.toString() : '';
        switch (id) {
            case '1':
                return 'https://etherscan.io';
            case '11155111':
                return 'https://sepolia.etherscan.io';
            case '8453':
                return 'https://basescan.org';
            case '84532':
            case '0x14a34':
                return 'https://sepolia.basescan.org';
            case '31337':
                return null; // local dev
            default:
                return null;
        }
    };

    const buildExplorerLink = (chainId, contractAddress, tokenId) => {
        const base = getExplorerBaseUrlForChain(chainId);
        if (!base || !contractAddress || tokenId === undefined || tokenId === null) return null;
        return `${base}/token/${contractAddress}?a=${tokenId}`;
    };

    const setStatus = (message, isError = false) => {
        if (!state.statusNode) return;
        state.statusNode.textContent = message || '';
        state.statusNode.classList.toggle('is-error', Boolean(isError));
    };

    const buildLensPatternButton = (entries) => {
        const normalized = Array.isArray(entries)
            ? entries
                .map(item => {
                    if (!item) return null;
                    if (typeof item === 'string') {
                        const addr = item.trim();
                        return addr ? { address: addr, name: '' } : null;
                    }
                    if (typeof item === 'object') {
                        const addr = item.address || item.addr || item.value || item.wallet;
                        const name = item.name || item.label || item.title || '';
                        const trimmed = addr ? String(addr).trim() : '';
                        return trimmed ? { address: trimmed, name } : null;
                    }
                    return null;
                })
                .filter(Boolean)
            : [];

        if (!normalized.length) return null;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'minted-proposal-lens-btn';
        button.title = t('modal.mintedProposals.lensLabel', 'Lens: {{count}}', { count: normalized.length });

        if (typeof globalScope.getLensPatternDataUrl === 'function') {
            try {
                const url = globalScope.getLensPatternDataUrl(normalized);
                if (url) {
                    button.style.backgroundImage = `url("${url}")`;
                    button.style.backgroundSize = 'cover';
                    button.style.backgroundRepeat = 'no-repeat';
                    button.style.backgroundPosition = 'center';
                }
            } catch (err) {
                console.warn('Failed to apply lens pattern', err);
            }
        }

        return button;
    };

    const normalizeIdList = (list) => {
        if (!Array.isArray(list)) return [];
        return list
            .map(value => {
                if (value === undefined || value === null) return null;
                try {
                    return value.toString();
                } catch (_) {
                    return String(value);
                }
            })
            .filter(Boolean);
    };

    const openMintedProposalDetails = (entry) => {
        if (!entry || entry.proposalId === undefined || entry.proposalId === null) return;

        closeMintedProposalsModal();

        const parentParcelIds = normalizeIdList(entry.parentParcelIds);

        try {
            if (globalScope.proposalStorage && typeof globalScope.proposalStorage.importOnChainProposal === 'function') {
                globalScope.proposalStorage.importOnChainProposal({
                    proposalId: entry.proposalId,
                    parentParcelIds,
                    isConditional: entry.isConditional,
                    imageURI: entry.imageURI || entry.imageUrl || (entry.metadata && (entry.metadata.image || entry.metadata.image_url || entry.metadata.imageURI)) || '',
                    acceptancePossible: entry.acceptancePossible,
                    status: entry.status,
                    ethBalance: entry.ethBalance,
                    tokenBalance: entry.tokenBalance,
                    acceptanceCount: entry.acceptanceCount,
                    expiryTimestamp: entry.expiryTimestamp,
                    expiringPercentage: entry.expiringPercentage,
                    author: entry.owner,
                    chainId: entry.chainId,
                    metadata: entry.metadata,
                    lens: entry.lens,
                    onchain: {
                        chainId: entry.chainId,
                        contractAddress: entry.contractAddress,
                        proposalId: entry.proposalId,
                        metadata: entry.metadata,
                        imageURI: entry.imageURI || entry.imageUrl || ''
                    }
                });
            }
        } catch (err) {
            console.warn('Failed to import minted proposal into storage', entry, err);
        }

        const fallbackParcelId = parentParcelIds.length ? parentParcelIds[0] : null;
        let opened = false;

        if (typeof globalScope.openProposalFromList === 'function') {
            try {
                opened = Boolean(globalScope.openProposalFromList(entry.proposalId, {
                    parcelId: fallbackParcelId,
                    centerOnProposal: true,
                    showDetails: true,
                    closeProposalList: true,
                    closeParcelInfo: true,
                    closeAgentDialog: true,
                    collapseSidebar: true
                }));
            } catch (err) {
                console.warn('openProposalFromList failed for minted proposal', err);
            }
        }

        if (!opened && typeof globalScope.focusProposalDetails === 'function') {
            try {
                globalScope.focusProposalDetails(entry.proposalId, {
                    parcelId: fallbackParcelId,
                    centerOnProposal: true,
                    showDetails: true
                });
                opened = true;
            } catch (err) {
                console.warn('focusProposalDetails failed for minted proposal', err);
            }
        }

        if (!opened && typeof globalScope.updateStatus === 'function') {
            globalScope.updateStatus(t('modal.mintedProposals.openFailed', 'Unable to open proposal details.'));
        }
    };

    const closeMintedProposalsModal = () => {
        if (state.overlay && state.overlay.parentNode) {
            state.overlay.parentNode.removeChild(state.overlay);
        }
    };

    const ensureModal = () => {
        if (state.overlay) return state.overlay;

        const overlay = document.createElement('div');
        overlay.className = 'minted-proposals-overlay';

        const modal = document.createElement('div');
        modal.className = 'minted-proposals-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const header = document.createElement('div');
        header.className = 'minted-proposals-header';

        const title = document.createElement('div');
        title.className = 'minted-proposals-title';
        title.setAttribute('data-i18n-key', 'modal.mintedProposals.title');
        title.textContent = t('modal.mintedProposals.title', 'Minted Proposals');

        const actions = document.createElement('div');
        actions.className = 'minted-proposals-actions';

        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'btn btn-secondary minted-proposals-refresh';
        refreshBtn.setAttribute('data-i18n-key', 'modal.mintedProposals.refresh');
        refreshBtn.textContent = t('modal.mintedProposals.refresh', 'Refresh');
        refreshBtn.addEventListener('click', () => {
            openMintedProposalsModal();
        });

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close-circle-btn close-circle-btn--lg minted-proposals-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', closeMintedProposalsModal);

        actions.appendChild(refreshBtn);
        actions.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(actions);

        const body = document.createElement('div');
        body.className = 'minted-proposals-body';

        const status = document.createElement('div');
        status.className = 'minted-proposals-status';
        status.textContent = '';

        const list = document.createElement('div');
        list.className = 'minted-proposals-list';

        body.appendChild(status);
        body.appendChild(list);
        modal.appendChild(header);
        modal.appendChild(body);
        overlay.appendChild(modal);

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                closeMintedProposalsModal();
            }
        });

        state.overlay = overlay;
        state.listNode = list;
        state.statusNode = status;
        state.refreshNode = refreshBtn;

        try {
            if (globalScope.i18n && typeof globalScope.i18n.applyTranslations === 'function') {
                globalScope.i18n.applyTranslations(overlay);
            }
        } catch (_) { /* ignore */ }

        return overlay;
    };

    const showMetadataDialog = (entry) => {
        const overlay = document.createElement('div');
        overlay.className = 'minted-metadata-overlay';

        const modal = document.createElement('div');
        modal.className = 'minted-metadata-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const header = document.createElement('div');
        header.className = 'minted-metadata-header';

        const title = document.createElement('h3');
        title.textContent = t('modal.mintedProposals.metadataTitle', 'Proposal metadata');

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close-circle-btn close-circle-btn--lg';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', () => overlay.remove());

        header.appendChild(title);
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'minted-metadata-body';

        const source = document.createElement('div');
        source.className = 'minted-metadata-source';
        if (entry.metadataUrl) {
            const resolvedSource = resolveResourceUrl(entry.metadataUrl);
            const link = document.createElement('a');
            link.href = resolvedSource;
            link.target = '_blank';
            link.rel = 'noreferrer noopener';
            link.textContent = resolvedSource;
            source.appendChild(link);
        }

        const pre = document.createElement('pre');
        if (entry.metadata) {
            try {
                pre.textContent = JSON.stringify(entry.metadata, null, 2);
            } catch (_) {
                pre.textContent = String(entry.metadata);
            }
        } else {
            pre.textContent = t('modal.mintedProposals.metadataUnavailable', 'Metadata is not available for this proposal.');
        }

        const footer = document.createElement('div');
        footer.className = 'minted-metadata-footer';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn btn-action';
        okBtn.textContent = t('modal.mintedProposals.ok', 'OK');
        okBtn.addEventListener('click', () => overlay.remove());
        footer.appendChild(okBtn);

        body.appendChild(source);
        body.appendChild(pre);
        body.appendChild(footer);

        modal.appendChild(header);
        modal.appendChild(body);
        overlay.appendChild(modal);

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                overlay.remove();
            }
        });

        try {
            if (globalScope.i18n && typeof globalScope.i18n.applyTranslations === 'function') {
                globalScope.i18n.applyTranslations(overlay);
            }
        } catch (_) { /* ignore */ }

        document.body.appendChild(overlay);
    };

    const renderList = (entries, chainId, contractAddress) => {
        if (!state.listNode || !state.statusNode) return;
        state.listNode.innerHTML = '';

        if (!entries || entries.length === 0) {
            setStatus(t('modal.mintedProposals.empty', 'No proposals minted with this wallet yet.'));
            return;
        }

        setStatus('');

        // Newest first by creation date; fallback to proposalId desc
        const sorted = (entries || []).slice().sort((a, b) => {
            const parseTime = (val) => {
                if (!val) return null;
                const t = Date.parse(val);
                return Number.isFinite(t) ? t : null;
            };

            const aTime = parseTime(a.createdAt || a.metadata?.createdAt || a.metadata?.properties?.createdAt);
            const bTime = parseTime(b.createdAt || b.metadata?.createdAt || b.metadata?.properties?.createdAt);

            if (aTime !== null && bTime !== null && aTime !== bTime) {
                return bTime - aTime;
            }

            try {
                const aId = BigInt(a.proposalId || 0);
                const bId = BigInt(b.proposalId || 0);
                return bId === aId ? 0 : (bId > aId ? 1 : -1);
            } catch (_) {
                return 0;
            }
        });

        sorted.forEach(entry => {
            const card = document.createElement('div');
            card.className = 'minted-proposal-card';

            const thumb = document.createElement('div');
            thumb.className = 'minted-proposal-thumb';
            if (entry.imageResolved) {
                const img = document.createElement('img');
                img.src = entry.imageResolved;
                img.alt = entry.title || t('modal.mintedProposals.proposalIdLabel', 'Proposal #{{id}}', { id: entry.proposalId });
                thumb.appendChild(img);
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'minted-proposal-thumb__placeholder';
                placeholder.textContent = '#';
                thumb.appendChild(placeholder);
            }

            const main = document.createElement('div');
            main.className = 'minted-proposal-main';

            const titleRow = document.createElement('div');
            titleRow.className = 'minted-proposal-title-row';

            const title = document.createElement('div');
            title.className = 'minted-proposal-title';
            title.textContent = entry.title || t('modal.mintedProposals.proposalIdLabel', 'Proposal #{{id}}', { id: entry.proposalId });

            const status = document.createElement('div');
            status.className = 'minted-proposal-status';
            status.textContent = t('modal.mintedProposals.statusLabel', 'Status: {{status}}', { status: entry.status || 'Active' });

            titleRow.appendChild(title);
            titleRow.appendChild(status);

            const meta = document.createElement('div');
            meta.className = 'minted-proposal-meta';

            const parcelsLabel = document.createElement('span');
            const parcelCount = Array.isArray(entry.parentParcelIds) ? entry.parentParcelIds.length : 0;
            parcelsLabel.textContent = t('modal.mintedProposals.parcelsLabel', 'Parcels: {{count}}', { count: parcelCount });

            const lensCount = Array.isArray(entry.lens) ? entry.lens.length : 0;
            const lensButton = buildLensPatternButton(entry.lens);
            const lensLabel = (!lensButton && lensCount)
                ? (() => {
                    const span = document.createElement('span');
                    span.textContent = t('modal.mintedProposals.lensLabel', 'Lens: {{count}}', { count: lensCount });
                    return span;
                })()
                : null;

            const createdLabel = document.createElement('span');
            const createdRaw = (entry.metadata && entry.metadata.properties && entry.metadata.properties.createdAt)
                || (entry.metadata && entry.metadata.createdAt)
                || entry.createdAt;
            if (createdRaw) {
                const createdDate = new Date(createdRaw);
                if (!isNaN(createdDate.getTime())) {
                    createdLabel.textContent = t('modal.mintedProposals.createdLabel', 'Created: {{date}}', {
                        date: createdDate.toLocaleString()
                    });
                }
            }

            meta.appendChild(parcelsLabel);
            if (createdLabel.textContent) meta.appendChild(createdLabel);

            const authorRaw = (entry.metadata && entry.metadata.properties && entry.metadata.properties.author)
                || (entry.metadata && entry.metadata.author)
                || entry.author
                || entry.owner;
            if (authorRaw) {
                const authorLabel = document.createElement('span');
                const authorText = t('modal.mintedProposals.authorLabel', 'Author: {{author}}', { author: authorRaw });
                // Fallback if i18n returned the key
                authorLabel.textContent = authorText.includes('modal.mintedProposals') ? `Author: ${authorRaw}` : authorText;
                meta.appendChild(authorLabel);
            }

            if (lensLabel) meta.appendChild(lensLabel);
            if (entry.isConditional) {
                const conditional = document.createElement('span');
                conditional.textContent = t('modal.mintedProposals.conditional', 'Conditional');
                meta.appendChild(conditional);
            }
            if (entry.acceptancePossible) {
                const acceptance = document.createElement('span');
                acceptance.textContent = t('modal.mintedProposals.acceptancePossible', 'Acceptance possible');
                meta.appendChild(acceptance);
            }

            const description = document.createElement('div');
            description.className = 'minted-proposal-description';
            description.textContent = entry.description || '';

            const actions = document.createElement('div');
            actions.className = 'minted-proposal-actions';

            if (lensButton) {
                lensButton.classList.add('minted-proposal-lens-action');
                actions.appendChild(lensButton);
            }

            const detailsBtn = document.createElement('button');
            detailsBtn.type = 'button';
            detailsBtn.className = 'btn btn-action minted-proposal-details-btn';
            detailsBtn.textContent = t('modal.mintedProposals.detailsButton', 'Details');
            detailsBtn.addEventListener('click', () => openMintedProposalDetails(entry));
            actions.appendChild(detailsBtn);

            const metadataBtn = document.createElement('button');
            metadataBtn.type = 'button';
            metadataBtn.className = 'btn btn-outline minted-proposal-metadata-btn';
            metadataBtn.textContent = t('modal.mintedProposals.metadataButton', 'Metadata');
            metadataBtn.addEventListener('click', () => showMetadataDialog(entry));

            actions.appendChild(metadataBtn);

            const explorerUrl = buildExplorerLink(chainId, contractAddress, entry.proposalId);
            if (explorerUrl) {
                const explorerLink = document.createElement('a');
                explorerLink.href = explorerUrl;
                explorerLink.className = 'btn btn-secondary';
                explorerLink.target = '_blank';
                explorerLink.rel = 'noreferrer noopener';
                explorerLink.textContent = t('modal.mintedProposals.explorer', 'View on Explorer');
                actions.appendChild(explorerLink);
            }

            main.appendChild(titleRow);
            main.appendChild(meta);
            if (entry.description) {
                main.appendChild(description);
            }
            main.appendChild(actions);

            card.appendChild(thumb);
            card.appendChild(main);
            state.listNode.appendChild(card);
        });
    };

    const fetchMetadata = async (metadataUrl) => {
        const resolvedUrl = resolveResourceUrl(metadataUrl);
        if (!resolvedUrl) return null;
        try {
            console.debug('[minted-proposals] Fetching metadata:', resolvedUrl);
            const resp = await fetch(resolvedUrl, { method: 'GET' });
            if (!resp.ok) {
                console.debug('[minted-proposals] Metadata fetch failed:', resp.status, resolvedUrl);
                return null;
            }
            const data = await resp.json();
            console.debug('[minted-proposals] Metadata fetched, image:', data?.image);
            return data;
        } catch (err) {
            console.warn('Failed to fetch proposal metadata', resolvedUrl, err);
            return null;
        }
    };

    const enrichProposals = async (items, chainId, contractAddress) => {
        const results = [];
        for (const item of items || []) {
            // On-chain imageURI is actually the metadata URI
            const metadataUrl = resolveResourceUrl(
                item.imageURI
                || item.metadataUrl
                || item.metadataURI
                || item.metadataUri
                || (item.metadata && (item.metadata.url || item.metadata.uri))
                || ''
            );
            const metadata = await fetchMetadata(metadataUrl);

            // Try to derive image URL from metadata URL for legacy proposals
            // e.g., /uploads/metadata/proposal-123.json → /uploads/images/proposal-123.png
            let derivedImageUrl = '';
            if (!metadata && metadataUrl) {
                const metadataMatch = metadataUrl.match(/\/uploads\/metadata\/([^/]+)\.json$/);
                if (metadataMatch && metadataMatch[1]) {
                    const baseName = metadataMatch[1];
                    // Also handle legacy format with .png in the name
                    const cleanBaseName = baseName.replace(/\.png$/, '');
                    derivedImageUrl = metadataUrl.replace(/\/metadata\/[^/]+$/, `/images/${cleanBaseName}.png`);
                }
            }

            const imageCandidates = [
                metadata && (metadata.image || metadata.image_url || metadata.imageURI),
                derivedImageUrl,
                item.imageUrl,
                // Only use imageURI if it looks like an image URL, not a JSON URL
                item.imageURI && !item.imageURI.endsWith('.json') ? item.imageURI : null,
                item.onchain && (item.onchain.imageUrl || item.onchain.imageUri)
            ];
            let imageResolved = '';
            for (const candidate of imageCandidates) {
                const resolved = resolveResourceUrl(candidate);
                if (resolved) {
                    imageResolved = resolved;
                    break;
                }
            }

            const title = (metadata && (metadata.name || metadata.title))
                || item.title
                || t('modal.mintedProposals.proposalIdLabel', 'Proposal #{{id}}', { id: item.proposalId });
            const description = metadata && metadata.description ? metadata.description : '';

            const createdAt = (metadata && (metadata.createdAt || metadata.date || metadata.properties?.createdAt))
                || item.createdAt
                || null;

            results.push({
                ...item,
                chainId: chainId ? chainId.toString() : null,
                contractAddress,
                metadataUrl,
                metadata,
                imageResolved,
                title,
                description,
                createdAt
            });
        }
        return results;
    };

    const fetchMintedProposals = async () => {
        const walletState = getWalletState();
        if (!isWalletConnected(walletState)) {
            throw new Error(t('modal.mintedProposals.walletRequired', 'Connect a wallet to view minted proposals.'));
        }

        const chainId = walletState.chainId;
        const account = walletState.accounts && walletState.accounts[0];
        if (!account) {
            throw new Error(t('modal.mintedProposals.walletRequired', 'Connect a wallet to view minted proposals.'));
        }

        const loader = globalScope.ChainDataLoader;
        if (!loader || typeof loader.resolveContractAddress !== 'function' || typeof loader.getProposalsFromChain !== 'function') {
            throw new Error('Chain data loader is unavailable.');
        }

        const contractAddress = await loader.resolveContractAddress(chainId, 'ProposalNFT');
        if (!contractAddress) {
            throw new Error('ProposalNFT address is not configured for this network.');
        }

        const proposals = await loader.getProposalsFromChain(account, chainId, contractAddress);
        return { proposals, chainId, contractAddress };
    };

    const openMintedProposalsModal = async () => {
        const run = async () => {
            const overlay = ensureModal();
            if (!overlay.parentNode) {
                document.body.appendChild(overlay);
            }
            if (state.listNode) {
                state.listNode.innerHTML = '';
            }
            setStatus(t('modal.mintedProposals.loading', 'Loading your minted proposals...'));

            try {
                const { proposals, chainId, contractAddress } = await fetchMintedProposals();
                const enriched = await enrichProposals(proposals, chainId, contractAddress);
                renderList(enriched, chainId, contractAddress);
            } catch (err) {
                console.warn('Minted proposals load failed', err);
                setStatus(`${t('modal.mintedProposals.error', 'Could not load minted proposals.')} ${err && err.message ? err.message : ''}`, true);
            }
        };

        const button = document.getElementById('mintedProposalsButton');
        if (typeof globalScope.runWithButtonBusyState === 'function' && button) {
            return globalScope.runWithButtonBusyState(
                button,
                t('modal.mintedProposals.loadingShort', 'Loading...'),
                run,
                { preserveText: false }
            );
        }
        return run();
    };

    document.addEventListener('DOMContentLoaded', () => {
        refreshButtonVisibility();
        attachWalletObservers();
    });

    globalScope.openMintedProposalsModal = openMintedProposalsModal;
    globalScope.refreshMintedProposalsButtonVisibility = refreshButtonVisibility;
})();
