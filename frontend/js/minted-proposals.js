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

        entries.forEach(entry => {
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

            const idLabel = document.createElement('span');
            idLabel.textContent = t('modal.mintedProposals.proposalIdLabel', 'Proposal #{{id}}', { id: entry.proposalId });

            const parcelsLabel = document.createElement('span');
            const parcelCount = Array.isArray(entry.parentParcelIds) ? entry.parentParcelIds.length : 0;
            parcelsLabel.textContent = t('modal.mintedProposals.parcelsLabel', 'Parcels: {{count}}', { count: parcelCount });

            const lensLabel = document.createElement('span');
            const lensCount = Array.isArray(entry.lens) ? entry.lens.length : 0;
            lensLabel.textContent = t('modal.mintedProposals.lensLabel', 'Lens: {{count}}', { count: lensCount });

            meta.appendChild(idLabel);
            meta.appendChild(parcelsLabel);
            if (lensCount) {
                meta.appendChild(lensLabel);
            }
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
            const resp = await fetch(resolvedUrl, { method: 'GET' });
            if (!resp.ok) return null;
            return await resp.json();
        } catch (err) {
            console.warn('Failed to fetch proposal metadata', resolvedUrl, err);
            return null;
        }
    };

    const enrichProposals = async (items, chainId, contractAddress) => {
        const results = [];
        for (const item of items || []) {
            const metadataUrl = resolveResourceUrl(item.imageURI || item.imageUrl || '');
            const metadata = await fetchMetadata(metadataUrl);

            const imageCandidates = [
                metadata && (metadata.image || metadata.image_url || metadata.imageURI),
                item.imageUrl,
                item.imageURI,
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
                || t('modal.mintedProposals.proposalIdLabel', 'Proposal #{{id}}', { id: item.proposalId });
            const description = metadata && metadata.description ? metadata.description : '';

            results.push({
                ...item,
                chainId: chainId ? chainId.toString() : null,
                contractAddress,
                metadataUrl,
                metadata,
                imageResolved,
                title,
                description
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
