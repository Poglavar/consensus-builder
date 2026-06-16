(function (global) {
    'use strict';

    const tParcel = (key, params = {}, fallback = '') => {
        if (typeof global.tParcel === 'function') {
            return global.tParcel(key, params, fallback);
        }
        try {
            const api = global.i18n;
            if (api && typeof api.t === 'function') {
                const translated = api.t(key, params || {});
                if (translated !== undefined && translated !== null) {
                    return translated;
                }
            }
        } catch (_) { }
        return fallback || key || '';
    };

    const PARCEL_CLAIM_PORTAL_URLS = Object.freeze({
        development: 'http://localhost:3001/',
        production: 'https://attestify.network/'
    });

    const PARCEL_CLAIM_RPC_FALLBACKS = Object.freeze({
        '31337': 'http://127.0.0.1:8545',
        '11155111': 'https://rpc.sepolia.org',
        '84532': 'https://sepolia.base.org'
    });

    const PARCEL_NFT_ABI_FRAGMENT = [
        'function tokenIdForParcelId(string parcelId) view returns (uint256)'
    ];

    const MINT_DECLARE_DEFAULT_RIGHTS_TYPE = 'Ownership';
    const MINT_DECLARE_DEFAULT_ASSET_TYPE = 'Real Estate';

    const resolveParcelId = (featureOrProps) => {
        if (!featureOrProps) return null;
        const feature = featureOrProps.properties ? featureOrProps : { properties: featureOrProps };
        const props = feature.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    let currentParcelMintStatusCache = null;
    let currentParcelMintStatusParcelId = null;
    let currentParcelMintStatusPromise = null;

    function getParcelMintStatusElement() {
        return global.document ? global.document.getElementById('parcelMintStatus') : null;
    }

    function normalizeMintStatusState(state) {
        if (!state) return 'neutral';
        if (state.startsWith('is-')) {
            return state.slice(3) || 'neutral';
        }
        return state;
    }

    function formatChainLabel(chainSlug) {
        if (chainSlug === undefined || chainSlug === null) return null;
        const text = chainSlug.toString().trim();
        if (!text) return null;
        return text.toLowerCase() === 'hardhat' ? 'localhost' : text;
    }

    function getParcelExplorerBaseUrl(chainId, chainSlug) {
        const normalizedId = chainId !== undefined && chainId !== null ? chainId.toString() : '';
        const slug = chainSlug ? chainSlug.toString().toLowerCase() : '';
        if (normalizedId === 'solana' || normalizedId.startsWith('solana-') || slug.startsWith('solana-')) {
            return 'https://explorer.solana.com';
        }
        switch (normalizedId) {
            case '1':
                return 'https://etherscan.io';
            case '11155111':
                return 'https://sepolia.etherscan.io';
            case '8453':
                return 'https://basescan.org';
            case '84532':
            case '0x14a34':
                return 'https://sepolia.basescan.org';
            default:
                break;
        }
        if (slug) {
            switch (slug) {
                case 'ethereum':
                    return 'https://etherscan.io';
                case 'sepolia':
                    return 'https://sepolia.etherscan.io';
                case 'base':
                    return 'https://basescan.org';
                case 'base-sepolia':
                    return 'https://sepolia.basescan.org';
                default:
                    break;
            }
        }
        return null;
    }

    function buildParcelNftExplorerUrl({ chainId, chainSlug, contractAddress, tokenId } = {}) {
        if (!contractAddress || tokenId === undefined || tokenId === null) return null;
        const base = getParcelExplorerBaseUrl(chainId, chainSlug);
        if (!base) return null;
        const address = contractAddress.toString().trim();
        if (!address) return null;
        const tokenValue = toStringSafe(tokenId);
        if (!tokenValue) return null;
        const slug = (chainSlug || chainId || '').toString();
        if (slug.startsWith('solana-') || chainId === 'solana') {
            const cluster = slug.replace(/^solana-?/, '') || 'devnet';
            const suffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
            return `${base}/address/${encodeURIComponent(tokenValue)}${suffix}`;
        }
        const encodedAddress = encodeURIComponent(address);
        const encodedToken = encodeURIComponent(tokenValue);
        return `${base}/nft/${encodedAddress}/${encodedToken}`;
    }

    function setButtonEnabledState(button, enabled) {
        if (!button) return;
        button.disabled = !enabled;
        button.classList.toggle('disabled', !enabled);
    }

    function updateToolsButtonsVisibilityForMulti(isMultiActive) {
        const container = global.document ? global.document.querySelector('.parcel-info-buttons') : null;
        if (!container) return;
        const rows = container.querySelectorAll('.button-row');
        rows.forEach((row) => {
            const keep = row.classList.contains('button-row-claim') || row.classList.contains('button-row-5');
            row.style.display = isMultiActive ? (keep ? '' : 'none') : '';
        });
        const claimButton = global.document ? global.document.getElementById('claimButton') : null;
        if (claimButton) {
            claimButton.style.display = isMultiActive ? 'none' : '';
        }
    }

    function isWalletConnected() {
        const walletManager = global.walletManager;
        const walletState = walletManager && typeof walletManager.getState === 'function' ? walletManager.getState() : null;
        const accounts = walletState && Array.isArray(walletState.accounts) ? walletState.accounts : [];
        return Boolean(walletState && walletState.status === 'connected' && accounts.length > 0);
    }

    function extractFeatureFromLayer(layer) {
        if (!layer) return null;
        // Individual GeoJSON layer — has .feature directly
        if (layer.feature && layer.feature.geometry) return layer.feature;
        // Layer group (e.g. from L.geoJSON()) — dig into sub-layers
        if (typeof layer.getLayers === 'function') {
            const subLayers = layer.getLayers();
            for (let i = 0; i < subLayers.length; i++) {
                if (subLayers[i].feature && subLayers[i].feature.geometry) {
                    return subLayers[i].feature;
                }
            }
        }
        // Try toGeoJSON as last resort
        if (typeof layer.toGeoJSON === 'function') {
            try {
                const geojson = layer.toGeoJSON();
                if (geojson && geojson.type === 'Feature' && geojson.geometry) return geojson;
                if (geojson && geojson.type === 'FeatureCollection' && Array.isArray(geojson.features) && geojson.features.length > 0) {
                    return geojson.features[0];
                }
            } catch (_) { /* ignore */ }
        }
        return null;
    }

    function collectMultiSelectedParcelsForMint() {
        const multi = global.multiParcelSelection;
        if (!multi || !multi.selectedParcels || multi.selectedParcels.size === 0) {
            return [];
        }

        const parcels = [];
        multi.selectedParcels.forEach((id) => {
            const parcelLayer = typeof multi.findParcelById === 'function' ? multi.findParcelById(id) : null;
            const feature = extractFeatureFromLayer(parcelLayer);
            const parcelId = feature ? deriveParcelIdentifier(feature) : (id ? id.toString() : null);
            if (!parcelId) return;
            const props = feature && feature.properties ? feature.properties : {};
            const parcelName = props.name || props.parcel_name || props.parcel || props.BROJ_CESTICE || `Parcel ${parcelId}`;
            parcels.push({ parcelId, parcelName, feature: feature || parcelLayer });
        });
        return parcels;
    }

    function setParcelClaimButtonsState(state = 'neutral') {
        const normalized = normalizeMintStatusState(state);
        const mintAndClaimButton = global.document ? global.document.getElementById('mintAndClaimButton') : null;
        const claimButton = global.document ? global.document.getElementById('claimButton') : null;

        const multi = global.multiParcelSelection;
        const hasMultiMode = Boolean(multi && multi.isActive);
        const multiCount = hasMultiMode && multi && multi.selectedParcels ? multi.selectedParcels.size : 0;
        const walletConnected = isWalletConnected();

        if (hasMultiMode) {
            updateToolsButtonsVisibilityForMulti(true);
            const enableMintMulti = walletConnected && multiCount > 0;
            setButtonEnabledState(mintAndClaimButton, enableMintMulti);
            setButtonEnabledState(claimButton, false);
            return;
        }

        updateToolsButtonsVisibilityForMulti(false);

        const enableMintAndClaim = normalized === 'not-minted';
        const enableClaim = normalized === 'minted';

        if (!['not-minted', 'minted'].includes(normalized)) {
            setButtonEnabledState(mintAndClaimButton, false);
            setButtonEnabledState(claimButton, false);
            return;
        }

        setButtonEnabledState(mintAndClaimButton, enableMintAndClaim);
        setButtonEnabledState(claimButton, enableClaim);
    }

    function computeFeatureCenter(feature) {
        const geometry = feature?.geometry;
        const coords = geometry?.coordinates;
        if (!geometry || !coords) return null;

        let sumLng = 0;
        let sumLat = 0;
        let count = 0;

        const addPoint = (point) => {
            const [lng, lat] = point || [];
            if (Number.isFinite(lng) && Number.isFinite(lat)) {
                sumLng += lng;
                sumLat += lat;
                count += 1;
            }
        };

        const walk = (node) => {
            if (!node) return;
            if (typeof node[0] === 'number') {
                addPoint(node);
                return;
            }
            node.forEach(child => walk(child));
        };

        walk(coords);
        if (!count) return null;
        return { lng: sumLng / count, lat: sumLat / count };
    }

    function setParcelMintStatusIndicator(message, state = 'neutral', chainSlug = null) {
        const indicator = getParcelMintStatusElement();
        if (!indicator) return;

        indicator.removeAttribute('data-i18n-key');
        indicator.removeAttribute('data-i18n-attr');
        indicator.removeAttribute('data-i18n-params');

        const cachedChain = formatChainLabel(chainSlug || currentParcelMintStatusCache?.result?.chainSlug || null);
        if (!cachedChain && (state === 'not-minted' || state === 'error')) {
            // Chain should always be available when checking NFT status
            // If we don't have it, this is an unexpected state - we attempted to check on a chain
            console.error('Chain information not available for NFT status indicator - this should not happen as we attempted to check on a specific chain');
        }
        // Always use the chain if we have it - we attempted to check on this chain
        const chainParam = cachedChain ? { chain: cachedChain } : {};
        const retryMessage = cachedChain
            ? tParcel('panel.parcel.nft.notFoundRetry', chainParam, 'NFT not found. Click to check again.')
            : tParcel('panel.parcel.nft.statusUnknown', {}, 'NFT status: Not checked yet.');
        const retryTooltip = tParcel('panel.parcel.nft.retryTooltip', {}, 'Click to check NFT status again');
        const resolvedMessage = message || tParcel('panel.parcel.nft.statusUnknown', {}, 'NFT status: Not checked yet.');

        const setIndicatorContent = (content) => {
            indicator.innerHTML = '';
            const canUseNode = typeof global.Node !== 'undefined' && content instanceof global.Node;
            if (canUseNode) {
                indicator.appendChild(content);
            } else {
                indicator.textContent = content || '';
            }
        };

        if (state === 'not-minted' || state === 'error') {
            const displayMessage = (!message || message === null) ? retryMessage : (typeof resolvedMessage === 'string' ? resolvedMessage : retryMessage);
            setIndicatorContent(displayMessage);
            indicator.style.cursor = 'pointer';
            indicator.onclick = recheckParcelMintStatus;
            indicator.title = retryTooltip;
        } else {
            setIndicatorContent(resolvedMessage || retryMessage);
            indicator.style.cursor = '';
            indicator.onclick = null;
            indicator.title = '';
        }

        const stateClasses = ['is-neutral', 'is-loading', 'is-minted', 'is-not-minted', 'is-error'];
        indicator.classList.remove(...stateClasses);

        if (state) {
            const normalizedClass = state.startsWith('is-') ? state : `is-${state}`;
            if (stateClasses.includes(normalizedClass)) {
                indicator.classList.add(normalizedClass);
            } else if (stateClasses.includes(`is-${state}`)) {
                indicator.classList.add(`is-${state}`);
            } else {
                indicator.classList.add('is-neutral');
            }
        } else {
            indicator.classList.add('is-neutral');
        }

        setParcelClaimButtonsState(state);
    }

    function resetParcelMintStatusState() {
        currentParcelMintStatusCache = null;
        currentParcelMintStatusParcelId = null;
        currentParcelMintStatusPromise = null;
        setParcelMintStatusIndicator(
            tParcel('panel.parcel.nft.statusUnknown', {}, 'NFT status: Not checked yet.'),
            'neutral'
        );
    }

    function applyParcelMintStatusResult(result) {
        if (!result) {
            setParcelMintStatusIndicator(
                tParcel('panel.parcel.nft.statusUnknown', {}, 'NFT status: Not checked yet.'),
                'neutral'
            );
            return;
        }

        const mintedLayerApi = global.ParcelsMintedLayer || null;
        const activeLayer = global.currentParcel && global.currentParcel.layer ? global.currentParcel.layer : null;
        const activeFeature = activeLayer && activeLayer.feature ? activeLayer.feature : null;
        const parcelIdForLayer = currentParcelMintStatusCache?.parcelId
            || currentParcelMintStatusParcelId
            || resolveParcelId(activeFeature);

        const displayChain = formatChainLabel(result.chainSlug);

        if (result.minted) {
            const chainText = displayChain
                ? tParcel('panel.parcel.nft.chainSuffix', { chain: displayChain }, ` (${displayChain})`)
                : '';
            const messageText = tParcel(
                'panel.parcel.nft.statusMinted',
                { chain: chainText },
                `NFT status: Minted${chainText}`
            );
            const explorerUrl = buildParcelNftExplorerUrl({
                chainId: result.chainId,
                chainSlug: result.chainSlug,
                contractAddress: result.contractAddress,
                tokenId: result.tokenId
            });
            let messageContent = messageText;
            if (explorerUrl) {
                const link = global.document ? global.document.createElement('a') : null;
                if (link) {
                    link.href = explorerUrl;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.textContent = messageText;
                    link.title = 'View on explorer';
                    messageContent = link;
                }
            }
            setParcelMintStatusIndicator(messageContent, 'minted');
            if (mintedLayerApi && parcelIdForLayer) {
                mintedLayerApi.addMintedParcels([parcelIdForLayer], { feature: activeFeature, layer: activeLayer });
            }
        } else {
            setParcelMintStatusIndicator(
                null,
                'not-minted',
                displayChain
            );
            if (mintedLayerApi && parcelIdForLayer) {
                mintedLayerApi.removeMintedParcel(parcelIdForLayer);
            }
        }
    }

    async function fetchParcelMintStatus(parcelId) {
        const claimContext = await resolveParcelClaimContext();

        if (claimContext.chainType === 'solana') {
            const loader = global.SolanaChainDataLoader;
            if (!loader) throw new Error('Solana chain data loader not available.');
            const cluster = (claimContext.chainSlug || '').replace(/^solana-/, '') || 'devnet';
            const result = await loader.getParcelMintStatus(parcelId, claimContext.contractAddress, cluster, { forceRefresh: true });
            if (result.minted) {
                return {
                    minted: true,
                    tokenId: result.tokenId,
                    chainId: claimContext.chainId,
                    chainSlug: claimContext.chainSlug,
                    contractAddress: claimContext.contractAddress
                };
            }
            return {
                minted: false,
                chainId: claimContext.chainId,
                chainSlug: claimContext.chainSlug,
                contractAddress: claimContext.contractAddress
            };
        }

        const ethersLib = global.ethers;
        if (!ethersLib) {
            throw new Error('Blockchain library is not available.');
        }
        const contract = new ethersLib.Contract(
            claimContext.contractAddress,
            PARCEL_NFT_ABI_FRAGMENT,
            claimContext.provider
        );
        try {
            const tokenIdRaw = await fetchParcelTokenId(contract, parcelId);
            return {
                minted: true,
                tokenId: toStringSafe(tokenIdRaw),
                chainId: claimContext.chainId,
                chainSlug: claimContext.chainSlug,
                contractAddress: claimContext.contractAddress
            };
        } catch (error) {
            if (error && error.message === 'TOKEN_NOT_MINTED') {
                return {
                    minted: false,
                    chainId: claimContext.chainId,
                    chainSlug: claimContext.chainSlug,
                    contractAddress: claimContext.contractAddress
                };
            }
            throw error;
        }
    }

    async function triggerParcelToolsTabActivated(forceRecheck = false) {
        const indicator = getParcelMintStatusElement();
        if (!indicator) return null;

        const isMultiActive = global.multiParcelSelection && global.multiParcelSelection.isActive;
        if (isMultiActive) {
            setParcelMintStatusIndicator('Ready to mint selected parcels. Mint will check on press.', 'neutral');
            return null;
        }

        const parcelFeature = global.currentParcel && global.currentParcel.layer && global.currentParcel.layer.feature
            ? global.currentParcel.layer.feature
            : null;
        if (!parcelFeature) {
            setParcelMintStatusIndicator(
                tParcel('panel.parcel.nft.statusPrompt', {}, 'Select a parcel to check NFT status.'),
                'neutral'
            );
            currentParcelMintStatusCache = null;
            currentParcelMintStatusParcelId = null;
            currentParcelMintStatusPromise = null;
            return null;
        }

        const parcelId = deriveParcelIdentifier(parcelFeature);
        if (!parcelId) {
            setParcelMintStatusIndicator(
                tParcel('panel.parcel.nft.missingIdentifier', {}, 'Parcel identifier unavailable.'),
                'error'
            );
            currentParcelMintStatusCache = null;
            currentParcelMintStatusParcelId = null;
            currentParcelMintStatusPromise = null;
            return null;
        }

        if (forceRecheck) {
            currentParcelMintStatusCache = null;
            currentParcelMintStatusPromise = null;
        }

        if (currentParcelMintStatusCache && currentParcelMintStatusCache.parcelId === parcelId && !forceRecheck) {
            applyParcelMintStatusResult(currentParcelMintStatusCache.result);
            return currentParcelMintStatusPromise;
        }

        if (currentParcelMintStatusPromise && currentParcelMintStatusParcelId === parcelId && !forceRecheck) {
            setParcelMintStatusIndicator(
                tParcel('panel.parcel.nft.checking', {}, 'Checking NFT status...'),
                'loading'
            );
            return currentParcelMintStatusPromise;
        }

        currentParcelMintStatusParcelId = parcelId;
        setParcelMintStatusIndicator(
            tParcel('panel.parcel.nft.checking', {}, 'Checking NFT status...'),
            'loading'
        );

        const requestPromise = (async () => {
            let claimContextChainSlug = null;
            let attemptedChainId = null;
            try {
                // Capture chain from claim context before attempting fetch
                try {
                    const claimContext = await resolveParcelClaimContext();
                    claimContextChainSlug = claimContext?.chainSlug || null;
                    attemptedChainId = claimContext?.chainId || null;
                } catch (contextError) {
                    // If we can't resolve context, determine which chain was attempted
                    // This uses the same logic as resolveParcelClaimContext to find the attempted chain
                    const globalScope = typeof global !== 'undefined' ? global : (typeof self !== 'undefined' ? self : null);
                    if (globalScope) {
                        const walletManager = globalScope.walletManager;
                        const walletState = walletManager && typeof walletManager.getState === 'function' ? walletManager.getState() : null;

                        // Try to get chain ID from wallet first
                        if (walletState && walletState.chainId !== undefined && walletState.chainId !== null) {
                            attemptedChainId = normalizeChainIdValue ? normalizeChainIdValue(walletState.chainId) : null;
                        }

                        // Try priority chains
                        if (!attemptedChainId && Array.isArray(globalScope.CLAIM_CHAIN_ID_PRIORITY) && globalScope.CLAIM_CHAIN_ID_PRIORITY.length > 0) {
                            attemptedChainId = normalizeChainIdValue ? normalizeChainIdValue(globalScope.CLAIM_CHAIN_ID_PRIORITY[0]) : null;
                        }

                        // Try default chain
                        if (!attemptedChainId) {
                            const defaultChainIdRaw = globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null
                                ? globalScope.DEFAULT_CHAIN_ID
                                : (globalScope.current_environment === 'development' ? '31337' : '84532');
                            attemptedChainId = normalizeChainIdValue ? normalizeChainIdValue(defaultChainIdRaw) : null;
                        }

                        if (attemptedChainId && resolveChainSlug) {
                            claimContextChainSlug = resolveChainSlug(attemptedChainId);
                        }
                    }
                }
                const result = await fetchParcelMintStatus(parcelId);
                if (currentParcelMintStatusParcelId === parcelId) {
                    currentParcelMintStatusCache = { parcelId, result };
                    applyParcelMintStatusResult(result);
                }
                return result;
            } catch (error) {
                if (currentParcelMintStatusParcelId === parcelId) {
                    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
                        console.warn('Parcel NFT status check failed:', error);
                    }
                    // Use chain from cache, or from claim context we captured, or from attempted chain ID
                    let chainSlug = currentParcelMintStatusCache?.result?.chainSlug || claimContextChainSlug || null;
                    if (!chainSlug) {
                        // Try to resolve from attempted chain ID
                        if (attemptedChainId && resolveChainSlug) {
                            chainSlug = resolveChainSlug(attemptedChainId);
                        }
                        // Last resort: try to resolve context again
                        if (!chainSlug) {
                            try {
                                const claimContext = await resolveParcelClaimContext();
                                chainSlug = claimContext?.chainSlug || null;
                            } catch (_) {
                                // If we still can't resolve, determine chain from same logic
                                const globalScope = typeof global !== 'undefined' ? global : (typeof self !== 'undefined' ? self : null);
                                if (globalScope && resolveChainSlug && normalizeChainIdValue) {
                                    const walletManager = globalScope.walletManager;
                                    const walletState = walletManager && typeof walletManager.getState === 'function' ? walletManager.getState() : null;
                                    let fallbackChainId = null;
                                    if (walletState && walletState.chainId !== undefined && walletState.chainId !== null) {
                                        fallbackChainId = normalizeChainIdValue(walletState.chainId);
                                    } else if (Array.isArray(globalScope.CLAIM_CHAIN_ID_PRIORITY) && globalScope.CLAIM_CHAIN_ID_PRIORITY.length > 0) {
                                        fallbackChainId = normalizeChainIdValue(globalScope.CLAIM_CHAIN_ID_PRIORITY[0]);
                                    } else {
                                        const defaultChainIdRaw = globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null
                                            ? globalScope.DEFAULT_CHAIN_ID
                                            : (globalScope.current_environment === 'development' ? '31337' : '84532');
                                        fallbackChainId = normalizeChainIdValue(defaultChainIdRaw);
                                    }
                                    if (fallbackChainId) {
                                        chainSlug = resolveChainSlug(fallbackChainId);
                                    }
                                }
                            }
                        }
                    }
                    setParcelMintStatusIndicator(
                        null,
                        'error',
                        chainSlug
                    );
                    currentParcelMintStatusCache = null;
                }
            } finally {
                if (currentParcelMintStatusParcelId === parcelId) {
                    currentParcelMintStatusPromise = null;
                }
            }
        })();

        currentParcelMintStatusPromise = requestPromise;
        return requestPromise;
    }

    function recheckParcelMintStatus(event) {
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }
        triggerParcelToolsTabActivated(true);
    }

    function resolveClaimPortalBaseUrl() {
        const globalScope = typeof global !== 'undefined' ? global : (typeof self !== 'undefined' ? self : null);
        if (!globalScope) {
            return PARCEL_CLAIM_PORTAL_URLS.production;
        }
        if (typeof globalScope.CLAIM_PORTAL_BASE_URL === 'string' && globalScope.CLAIM_PORTAL_BASE_URL.trim()) {
            return globalScope.CLAIM_PORTAL_BASE_URL.trim();
        }
        const hostname = (globalScope.location && typeof globalScope.location.hostname === 'string')
            ? globalScope.location.hostname.toLowerCase()
            : '';
        const isLocalHost = hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '0.0.0.0'
            || hostname.endsWith('.local');
        const env = globalScope.current_environment || (isLocalHost ? 'development' : 'production');
        if (env === 'development') {
            if (typeof globalScope.CLAIM_PORTAL_DEV_BASE_URL === 'string' && globalScope.CLAIM_PORTAL_DEV_BASE_URL.trim()) {
                return globalScope.CLAIM_PORTAL_DEV_BASE_URL.trim();
            }
            return PARCEL_CLAIM_PORTAL_URLS.development;
        }
        if (typeof globalScope.CLAIM_PORTAL_PROD_BASE_URL === 'string' && globalScope.CLAIM_PORTAL_PROD_BASE_URL.trim()) {
            return globalScope.CLAIM_PORTAL_PROD_BASE_URL.trim();
        }
        return PARCEL_CLAIM_PORTAL_URLS.production;
    }

    function resolveMintDeclareConfig() {
        const globalScope = typeof global !== 'undefined' ? global : (typeof self !== 'undefined' ? self : null);
        const candidateBaseUrls = [
            globalScope && typeof globalScope.MINT_DECLARE_BASE_URL === 'string' ? globalScope.MINT_DECLARE_BASE_URL : null,
            globalScope && typeof globalScope.MINT_DECLARE_URL === 'string' ? globalScope.MINT_DECLARE_URL : null,
            globalScope && typeof globalScope.MINT_AND_DECLARE_BASE_URL === 'string' ? globalScope.MINT_AND_DECLARE_BASE_URL : null
        ]
            .filter(value => typeof value === 'string')
            .map(value => value.trim())
            .filter(Boolean);
        const baseUrl = candidateBaseUrls.length > 0 ? candidateBaseUrls[0] : resolveClaimPortalBaseUrl();
        const rightsTypeRaw = globalScope && globalScope.MINT_DECLARE_RIGHTS_TYPE ? globalScope.MINT_DECLARE_RIGHTS_TYPE : null;
        const assetTypeRaw = globalScope && globalScope.MINT_DECLARE_ASSET_TYPE ? globalScope.MINT_DECLARE_ASSET_TYPE : null;
        const rightsType = rightsTypeRaw && String(rightsTypeRaw).trim() ? String(rightsTypeRaw).trim() : MINT_DECLARE_DEFAULT_RIGHTS_TYPE;
        const assetType = assetTypeRaw && String(assetTypeRaw).trim() ? String(assetTypeRaw).trim() : MINT_DECLARE_DEFAULT_ASSET_TYPE;
        return { baseUrl, rightsType, assetType };
    }

    function ensureArray(value) {
        if (value === undefined || value === null) return [];
        return Array.isArray(value) ? value : [value];
    }

    function escapeXml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function parseGeoJsonGeometry(input) {
        if (!input) return null;
        let source = input;
        if (typeof source === 'string') {
            try {
                source = JSON.parse(source);
            } catch (error) {
                return null;
            }
        }
        if (!source) return null;
        if (source.type === 'Feature') {
            return parseGeoJsonGeometry(source.geometry);
        }
        if (source.type && source.coordinates) {
            return source;
        }
        if (source.geometry) {
            return parseGeoJsonGeometry(source.geometry);
        }
        return null;
    }

    function extractPolygonCoordinateSets(geometryLike) {
        const geometry = parseGeoJsonGeometry(geometryLike);
        if (!geometry) return [];
        switch (geometry.type) {
            case 'Polygon':
                return geometry.coordinates ? [geometry.coordinates] : [];
            case 'MultiPolygon':
                return geometry.coordinates ? geometry.coordinates.map(coords => coords || []) : [];
            case 'GeometryCollection': {
                const polygons = [];
                ensureArray(geometry.geometries).forEach(inner => {
                    extractPolygonCoordinateSets(inner).forEach(coords => polygons.push(coords));
                });
                return polygons;
            }
            default:
                return [];
        }
    }

    function extractPrimaryPolygonRing(geometryLike) {
        const rings = extractOuterPolygonRings(geometryLike);
        return rings.length > 0 ? rings[0] : [];
    }

    function extractOuterPolygonRings(geometryLike) {
        const polygons = extractPolygonCoordinateSets(geometryLike);
        if (!Array.isArray(polygons) || polygons.length === 0) {
            return [];
        }
        return polygons
            .map((polygon) => {
                if (!Array.isArray(polygon) || polygon.length === 0) return [];
                const outerRing = Array.isArray(polygon[0]) ? polygon[0] : polygon;
                return Array.isArray(outerRing) ? outerRing : [];
            })
            .filter(ring => Array.isArray(ring) && ring.length >= 3);
    }

    function sanitizeRing(ring) {
        if (!Array.isArray(ring)) return [];
        if (ring.length <= 2) return ring.slice();
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (Array.isArray(first) && Array.isArray(last) && first.length >= 2 && last.length >= 2 && first[0] === last[0] && first[1] === last[1]) {
            return ring.slice(0, ring.length - 1);
        }
        return ring.slice();
    }

    function computeBoundingBox(polygons) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        polygons.forEach(polygon => {
            ensureArray(polygon).forEach(ring => {
                sanitizeRing(ring).forEach(coord => {
                    if (!Array.isArray(coord) || coord.length < 2) return;
                    const [lon, lat] = coord;
                    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
                    if (lon < minX) minX = lon;
                    if (lat < minY) minY = lat;
                    if (lon > maxX) maxX = lon;
                    if (lat > maxY) maxY = lat;
                });
            });
        });

        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return null;
        }
        if (minX === maxX) {
            minX -= 0.0001;
            maxX += 0.0001;
        }
        if (minY === maxY) {
            minY -= 0.0001;
            maxY += 0.0001;
        }
        return { minX, minY, maxX, maxY };
    }

    function projectCoordinate(coord, bounds, width, height, padding) {
        const [lon, lat] = coord;
        const spanX = bounds.maxX - bounds.minX;
        const spanY = bounds.maxY - bounds.minY;
        const maxDrawableWidth = Math.max(width - padding * 2, 1);
        const maxDrawableHeight = Math.max(height - padding * 2, 1);
        const scaleX = spanX > 0 ? maxDrawableWidth / spanX : 1;
        const scaleY = spanY > 0 ? maxDrawableHeight / spanY : 1;
        const scale = Math.min(scaleX, scaleY);
        const usedWidth = spanX * scale;
        const usedHeight = spanY * scale;
        const offsetX = padding + (maxDrawableWidth - usedWidth) / 2;
        const offsetY = padding + (maxDrawableHeight - usedHeight) / 2;
        const x = offsetX + (lon - bounds.minX) * scale;
        const y = height - (offsetY + (lat - bounds.minY) * scale);
        return [
            Number.isFinite(x) ? x : width / 2,
            Number.isFinite(y) ? y : height / 2
        ];
    }

    function buildParcelSvg(feature, { parcelId, parcelName, width = 512, height = 512, paddingRatio = 0.08 } = {}) {
        if (!feature) return null;
        const geometrySource = feature.geometry || feature;
        const polygons = extractPolygonCoordinateSets(geometrySource);
        if (polygons.length === 0) {
            return null;
        }
        const bounds = computeBoundingBox(polygons);
        if (!bounds) {
            return null;
        }
        const padding = Math.min(width, height) * paddingRatio;
        const pathElements = [];

        polygons.forEach(polygon => {
            const commands = [];
            ensureArray(polygon).forEach(ring => {
                const sanitized = sanitizeRing(ring);
                sanitized.forEach((coord, index) => {
                    const projected = projectCoordinate(coord, bounds, width, height, padding);
                    commands.push(`${index === 0 ? 'M' : 'L'}${projected[0].toFixed(2)} ${projected[1].toFixed(2)}`);
                });
                if (sanitized.length > 0) {
                    commands.push('Z');
                }
            });
            if (commands.length > 0) {
                pathElements.push(
                    `<path d="${commands.join(' ')}" fill="#facd55" fill-opacity="0.85" stroke="#f97316" stroke-width="12" stroke-linejoin="round" stroke-linecap="round" fill-rule="evenodd" />`
                );
            }
        });

        if (pathElements.length === 0) {
            return null;
        }

        const primaryLabel = parcelId ? escapeXml(parcelId) : (parcelName ? escapeXml(parcelName) : null);
        let cityName = null;
        if (global.ParcelCityConfigManager && typeof global.ParcelCityConfigManager.getCurrentCityConfig === 'function') {
            const cityConfig = global.ParcelCityConfigManager.getCurrentCityConfig();
            if (cityConfig && cityConfig.label) {
                const labelParts = cityConfig.label.split(',');
                cityName = labelParts[0]?.trim() || null;
            }
        }
        const secondaryLabel = cityName ? escapeXml(cityName) : null;
        const labelElements = [];
        if (primaryLabel) {
            labelElements.push(
                `<text x="50%" y="88%" text-anchor="middle" fill="#e5e7eb" font-size="40" font-family="'Inter','Helvetica Neue',Arial,sans-serif">${primaryLabel}</text>`
            );
        }
        if (secondaryLabel) {
            labelElements.push(
                `<text x="50%" y="95%" text-anchor="middle" fill="#94a3b8" font-size="28" font-family="'Inter','Helvetica Neue',Arial,sans-serif">${secondaryLabel}</text>`
            );
        }

        const svgParts = [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
            `  <rect width="${width}" height="${height}" fill="#0b1120" rx="24" />`,
            `  <g>${pathElements.join('\n    ')}</g>`,
            labelElements.length > 0 ? `  <g>${labelElements.join('\n    ')}</g>` : '',
            `</svg>`
        ].filter(Boolean);

        return svgParts.join('\n');
    }

    function encodeSvgToBase64(svgContent) {
        if (typeof svgContent !== 'string' || !svgContent) {
            return null;
        }
        try {
            if (typeof global.btoa === 'function') {
                return global.btoa(unescape(encodeURIComponent(svgContent)));
            }
        } catch (error) {
            console.warn('Failed to encode SVG using btoa, falling back to Buffer if available.', error);
        }
        try {
            if (typeof global.Buffer !== 'undefined') {
                return global.Buffer.from(svgContent, 'utf8').toString('base64');
            }
        } catch (error) {
            console.warn('Failed to encode SVG using Buffer', error);
        }
        return null;
    }

    function extractMunicipalityName(feature) {
        if (!feature) return null;
        const props = feature.properties || {};
        const candidates = [
            props.cadastralName,
            props.CADASTRAL_NAME,
            props.cadastralMunicipality && props.cadastralMunicipality.name,
            props.cadastralMunicipality && props.cadastralMunicipality.naziv,
            props.municipality,
            props.MUNICIPALITY
        ];
        for (const candidate of candidates) {
            if (candidate === undefined || candidate === null) continue;
            const value = String(candidate).trim();
            if (value) {
                return value;
            }
        }
        return null;
    }

    function buildMintDeclareDescription({ parcelId, parcelName, municipality }) {
        if (parcelName && municipality) {
            return `${parcelName} (${parcelId}) in ${municipality}.`;
        }
        if (parcelName) {
            return `${parcelName} (${parcelId}).`;
        }
        if (parcelId && municipality) {
            return `Digitized cadastral parcel ${parcelId} in ${municipality}.`;
        }
        if (parcelId) {
            return `Digitized cadastral parcel ${parcelId}.`;
        }
        return 'Digitized cadastral parcel.';
    }

    function buildMintDeclareUrl({ feature, parcelId, parcelName, claimContext }) {
        const config = resolveMintDeclareConfig();
        if (!config.baseUrl) {
            return null;
        }
        const svg = buildParcelSvg(feature, { parcelId, parcelName });
        if (!svg) {
            return null;
        }
        const svgBase64 = encodeSvgToBase64(svg);
        if (!svgBase64) {
            return null;
        }

        let urlObject;
        const attemptAbsolute = (raw, fallback) => {
            try {
                return new URL(raw);
            } catch (_) {
                if (!fallback) {
                    throw _;
                }
                return new URL(fallback);
            }
        };
        try {
            urlObject = attemptAbsolute(config.baseUrl);
        } catch (_) {
            const normalized = config.baseUrl.startsWith('http://') || config.baseUrl.startsWith('https://')
                ? config.baseUrl
                : `http://${config.baseUrl}`;
            try {
                urlObject = attemptAbsolute(normalized);
            } catch (error) {
                if (global.location) {
                    urlObject = new URL(config.baseUrl, global.location.origin);
                } else {
                    console.warn('Unable to resolve Mint & Attest base URL:', config.baseUrl, error);
                    return null;
                }
            }
        }

        urlObject.searchParams.set('attest', 'relationship');
        urlObject.searchParams.set('parcelSvgB64', svgBase64);

        const resolvedParcelName = parcelName || (parcelId ? `Parcel ${parcelId}` : 'Selected Parcel');
        const municipality = extractMunicipalityName(feature);
        const description = buildMintDeclareDescription({ parcelId, parcelName: resolvedParcelName, municipality });

        urlObject.searchParams.set('assetName', resolvedParcelName);
        urlObject.searchParams.set('assetDescription', description);
        urlObject.searchParams.set('rightsType', config.rightsType);
        urlObject.searchParams.set('assetType', config.assetType);

        if (parcelId) {
            urlObject.searchParams.set('parcelId', parcelId);
        }
        if (municipality) {
            urlObject.searchParams.set('municipality', municipality);
        }
        if (claimContext && claimContext.contractAddress) {
            urlObject.searchParams.set('contractAddress', claimContext.contractAddress);
        }
        if (claimContext && claimContext.chainId !== undefined && claimContext.chainId !== null) {
            urlObject.searchParams.set('chainId', String(claimContext.chainId));
        }

        return urlObject.toString();
    }

    function openMintAttestFlow({ feature, parcelId, parcelName, claimContext }) {
        const mintDeclareUrl = buildMintDeclareUrl({
            feature,
            parcelId,
            parcelName,
            claimContext
        });
        if (mintDeclareUrl) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Parcel not minted yet. Opening Mint & Attest flow...');
            }
            openExternalUrl(mintDeclareUrl);
        } else if (typeof global.updateStatus === 'function') {
            global.updateStatus("Parcel not minted yet and the Mint & Attest flow couldn't be prepared.");
        }
    }

    function toStringSafe(value) {
        if (value === undefined || value === null) return '';
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'object' && typeof value.toString === 'function') return value.toString();
        return String(value);
    }

    async function fetchParcelTokenId(contract, parcelId) {
        try {
            return await contract.tokenIdForParcelId(parcelId);
        } catch (error) {
            const isExpectedMissing = isParcelTokenMissingError(error)
                || (error && typeof error.message === 'string' && /ParcelNFT:\s*Parcel does not exist/i.test(error.message));
            if (!isExpectedMissing) {
                console.info('Parcel token lookup reverted; treating as not minted.', {
                    parcelId,
                    error
                });
            }
            const sentinel = new Error('TOKEN_NOT_MINTED');
            sentinel.cause = error;
            throw sentinel;
        }
    }

    function buildParcelBuilderUrl() {
        let baseUrl = null;
        if (global.CityConfigManager && typeof global.CityConfigManager.getParcelBuilderConfig === 'function') {
            const parcelBuilderConfig = global.CityConfigManager.getParcelBuilderConfig();
            if (parcelBuilderConfig && parcelBuilderConfig.url) {
                baseUrl = parcelBuilderConfig.url;
            }
        }

        if (!baseUrl) {
            const defaultExternalUrl = 'https://urbangametheory.xyz/codechecker';
            const env = global.current_environment ? global.current_environment : 'production';
            const origin = (global.location && global.location.origin && global.location.origin !== 'null')
                ? global.location.origin.replace(/\/$/, '')
                : null;

            baseUrl = defaultExternalUrl;

            if (origin) {
                if (env === 'development' || env === 'production') {
                    baseUrl = `${origin}/codechecker`;
                }
            }
        }

        const feature = global.currentParcel && global.currentParcel.layer && global.currentParcel.layer.feature
            ? global.currentParcel.layer.feature
            : null;
        const props = feature ? (feature.properties || {}) : {};

        const parcelNumber = props.parcel || props.BROJ_CESTICE || props.parcel_number || null;
        const parcelId = resolveParcelId(props);
        const cadastralId = props.MATICNI_BROJ_KO || props.maticni_broj_ko || null;

        let targetUrl = baseUrl;
        const params = new URLSearchParams();

        if (baseUrl.includes('codechecker') || baseUrl.includes('urbangametheory')) {
            if (parcelNumber && cadastralId) {
                params.set('parcel_identifier', `${parcelNumber}-${cadastralId}`);
            }
            if (params.toString()) {
                targetUrl = `${baseUrl}?${params.toString()}`;
            }
        } else if (baseUrl.includes('ciudad3d.buenosaires.gob.ar')) {
            const smp = props.smp || (parcelId ? parcelId.replace(/^AR-/, '') : null);

            if (smp) {
                params.set('smp', smp);
                params.set('parcel', smp);
            } else if (parcelId) {
                params.set('parcel', parcelId);
            } else if (parcelNumber) {
                params.set('parcel', parcelNumber);
            }

            const center = computeFeatureCenter(feature);
            if (center) {
                params.set('lat', center.lat.toFixed(6));
                params.set('lng', center.lng.toFixed(6));
                params.set('zoom', '19');
            }
            if (params.toString()) {
                targetUrl = `${baseUrl}?${params.toString()}`;
            }
        }

        return targetUrl;
    }

    function openParcelBuilder() {
        try {
            const targetUrl = buildParcelBuilderUrl();
            if (typeof global.open === 'function') {
                global.open(targetUrl, '_blank', 'noopener,noreferrer');
            }
        } catch (error) {
            console.error('Failed to open Parcel Builder', error);
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Unable to open Parcel Builder. Please try again.');
            }
        }
    }

    async function openClaimOnly() {
        const parcelFeature = global.currentParcel && global.currentParcel.layer && global.currentParcel.layer.feature
            ? global.currentParcel.layer.feature
            : null;
        if (!parcelFeature) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Select a parcel before attempting to claim it.');
            }
            return;
        }

        const parcelId = deriveParcelIdentifier(parcelFeature);
        if (!parcelId) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Unable to determine parcel identifier for claims.');
            }
            return;
        }
        const parcelName = `Parcel ${parcelId}`;
        const baseUrl = resolveClaimPortalBaseUrl();
        const ethersLib = global.ethers;
        let claimContext = null;

        try {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Resolving parcel claim details...');
            }
            currentParcelMintStatusParcelId = parcelId;
            currentParcelMintStatusPromise = null;
            setParcelMintStatusIndicator('Checking NFT status...', 'loading');

            try {
                claimContext = await resolveParcelClaimContext();
            } catch (contextError) {
                console.warn('Parcel claim context unavailable for claim-only flow.', contextError);
                throw contextError;
            }

            if (!ethersLib) {
                throw new Error('Blockchain library is not available.');
            }
            if (!claimContext || !claimContext.contractAddress || !claimContext.provider) {
                throw new Error('Claim context is incomplete.');
            }

            const contract = new ethersLib.Contract(
                claimContext.contractAddress,
                PARCEL_NFT_ABI_FRAGMENT,
                claimContext.provider
            );

            const cachedResult = currentParcelMintStatusCache && currentParcelMintStatusCache.parcelId === parcelId
                ? currentParcelMintStatusCache.result
                : null;

            let mintedResult = null;
            if (cachedResult && cachedResult.minted && cachedResult.tokenId) {
                mintedResult = cachedResult;
            } else {
                const tokenIdRaw = await fetchParcelTokenId(contract, parcelId);
                mintedResult = {
                    minted: true,
                    tokenId: toStringSafe(tokenIdRaw),
                    chainId: claimContext.chainId,
                    chainSlug: claimContext.chainSlug,
                    contractAddress: claimContext.contractAddress
                };
                currentParcelMintStatusCache = { parcelId, result: mintedResult };
            }

            currentParcelMintStatusParcelId = parcelId;
            applyParcelMintStatusResult(mintedResult);

            const claimUrl = buildClaimUrl({
                baseUrl,
                chainSlug: mintedResult.chainSlug || claimContext.chainSlug,
                contractAddress: mintedResult.contractAddress || claimContext.contractAddress,
                tokenId: mintedResult.tokenId,
                parcelName
            });

            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Opening claim portal...');
            }
            openExternalUrl(claimUrl);
        } catch (error) {
            if (error && error.message === 'TOKEN_NOT_MINTED') {
                const notMintedResult = {
                    minted: false,
                    chainId: claimContext?.chainId,
                    chainSlug: claimContext?.chainSlug,
                    contractAddress: claimContext?.contractAddress
                };
                currentParcelMintStatusCache = { parcelId, result: notMintedResult };
                currentParcelMintStatusParcelId = parcelId;
                applyParcelMintStatusResult(notMintedResult);
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus("Can't claim, the parcel token has not been minted yet.");
                }
                return;
            }

            console.error('Failed to open claim-only portal', error);
            const chainSlug = currentParcelMintStatusCache?.result?.chainSlug || claimContext?.chainSlug || null;
            setParcelMintStatusIndicator(
                null,
                'error',
                chainSlug
            );
            currentParcelMintStatusCache = null;
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Unable to open claim portal. Please try again.');
            }
        }
    }

    async function openClaimPortal() {
        const parcelFeature = global.currentParcel && global.currentParcel.layer && global.currentParcel.layer.feature
            ? global.currentParcel.layer.feature
            : null;
        if (!parcelFeature) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Select a parcel before attempting to claim it.');
            }
            return;
        }
        const parcelId = deriveParcelIdentifier(parcelFeature);
        if (!parcelId) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Unable to determine parcel identifier for claims.');
            }
            return;
        }
        const parcelName = `Parcel ${parcelId}`;

        try {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Resolving parcel claim details...');
            }
            currentParcelMintStatusCache = null;
            currentParcelMintStatusParcelId = parcelId;
            currentParcelMintStatusPromise = null;
            setParcelMintStatusIndicator('Checking NFT status...', 'loading');
            let claimContext = null;
            try {
                claimContext = await resolveParcelClaimContext();
            } catch (contextError) {
                console.warn('Parcel claim context unavailable, defaulting to Mint & Attest flow.', contextError);
            }
            const baseUrl = resolveClaimPortalBaseUrl();
            const ethersLib = global.ethers;
            if (!ethersLib) {
                throw new Error('Blockchain library is not available.');
            }
            if (!claimContext || !claimContext.contractAddress || !claimContext.provider) {
                const fallbackResult = {
                    minted: false,
                    chainId: claimContext?.chainId,
                    chainSlug: claimContext?.chainSlug,
                    contractAddress: claimContext?.contractAddress
                };
                currentParcelMintStatusCache = { parcelId, result: fallbackResult };
                currentParcelMintStatusParcelId = parcelId;
                applyParcelMintStatusResult(fallbackResult);
                openMintAttestFlow({ feature: parcelFeature, parcelId, parcelName, claimContext });
                return;
            }

            const contract = new ethersLib.Contract(
                claimContext.contractAddress,
                PARCEL_NFT_ABI_FRAGMENT,
                claimContext.provider
            );

            let tokenId;
            try {
                console.info('ParcelNFT lookup', {
                    chainId: claimContext.chainId,
                    chainSlug: claimContext.chainSlug,
                    contractAddress: claimContext.contractAddress,
                    parcelId
                });
                const tokenIdRaw = await fetchParcelTokenId(contract, parcelId);
                tokenId = toStringSafe(tokenIdRaw);
                const mintedResult = {
                    minted: true,
                    tokenId,
                    chainId: claimContext.chainId,
                    chainSlug: claimContext.chainSlug,
                    contractAddress: claimContext.contractAddress
                };
                currentParcelMintStatusCache = { parcelId, result: mintedResult };
                currentParcelMintStatusParcelId = parcelId;
                applyParcelMintStatusResult(mintedResult);
            } catch (error) {
                if (error && error.message === 'TOKEN_NOT_MINTED') {
                    const notMintedResult = {
                        minted: false,
                        chainId: claimContext.chainId,
                        chainSlug: claimContext.chainSlug,
                        contractAddress: claimContext.contractAddress
                    };
                    currentParcelMintStatusCache = { parcelId, result: notMintedResult };
                    currentParcelMintStatusParcelId = parcelId;
                    applyParcelMintStatusResult(notMintedResult);
                    openMintAttestFlow({ feature: parcelFeature, parcelId, parcelName, claimContext });
                    return;
                }
                throw error;
            }

            const claimUrl = buildClaimUrl({
                baseUrl,
                chainSlug: claimContext.chainSlug,
                contractAddress: claimContext.contractAddress,
                tokenId,
                parcelName
            });
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Opening claim portal...');
            }
            openExternalUrl(claimUrl);
        } catch (error) {
            console.error('Failed to open claim portal', error);
            const chainSlug = currentParcelMintStatusCache?.result?.chainSlug || claimContext?.chainSlug || null;
            setParcelMintStatusIndicator(
                null,
                'error',
                chainSlug
            );
            currentParcelMintStatusCache = null;
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Unable to open claim portal. Please try again.');
            }
        }
    }

    /* Parcel mint modal */
    const PARCEL_MINT_MODAL_ID = 'parcel-mint-modal-overlay';
    let parcelMintModalOnExit = null;

    function showParcelMintSuccessPopup({ parcelCount, transactions, chainId, onClose }) {
        try {
            const existingPopup = global.document ? global.document.getElementById('parcel-mint-success-modal') : null;
            if (existingPopup && existingPopup.parentNode) {
                existingPopup.parentNode.removeChild(existingPopup);
            }

            const overlay = global.document.createElement('div');
            overlay.id = 'parcel-mint-success-modal';
            overlay.style.position = 'fixed';
            overlay.style.inset = '0';
            overlay.style.background = 'rgba(0,0,0,0.45)';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.zIndex = '12000';

            const card = global.document.createElement('div');
            card.style.background = '#fff';
            card.style.borderRadius = '12px';
            card.style.padding = '20px 24px';
            card.style.maxWidth = '340px';
            card.style.width = '90%';
            card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
            card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

            const title = global.document.createElement('h3');
            title.textContent = 'Success!';
            title.style.margin = '0 0 8px 0';
            title.style.fontSize = '20px';
            title.style.fontWeight = '700';
            card.appendChild(title);

            const body = global.document.createElement('p');
            body.textContent = parcelCount === 1
                ? 'Parcel has been minted!'
                : `${parcelCount} parcels have been minted!`;
            body.style.margin = '0 0 12px 0';
            body.style.fontSize = '14px';
            card.appendChild(body);

            const isSolana = typeof chainId === 'string' && chainId.startsWith('solana');
            const txList = Array.isArray(transactions) ? transactions.filter(t => t && t.txHash) : [];

            // Build explorer links section
            if (txList.length > 0) {
                const linksContainer = global.document.createElement('div');
                linksContainer.style.margin = '0 0 12px 0';

                if (txList.length === 1) {
                    // Single transaction — show as a single link
                    const url = buildExplorerTxUrl({ chainId, chainSlug: chainId, txHash: txList[0].txHash });
                    if (url) {
                        const link = global.document.createElement('a');
                        link.href = url;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.textContent = isSolana ? 'View on Solana Explorer' : 'View on Explorer';
                        link.style.color = '#0d3b66';
                        link.style.fontWeight = '600';
                        link.style.fontSize = '14px';
                        linksContainer.appendChild(link);
                    }
                } else {
                    // Multiple transactions — show as a numbered list
                    const list = global.document.createElement('div');
                    list.style.display = 'flex';
                    list.style.flexDirection = 'column';
                    list.style.gap = '6px';

                    txList.forEach((tx, idx) => {
                        const url = buildExplorerTxUrl({ chainId, chainSlug: chainId, txHash: tx.txHash });
                        if (!url) return;
                        const row = global.document.createElement('div');
                        row.style.fontSize = '13px';
                        const label = tx.parcelId ? tx.parcelId : `Transaction ${idx + 1}`;
                        const link = global.document.createElement('a');
                        link.href = url;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.textContent = label;
                        link.style.color = '#0d3b66';
                        link.style.fontWeight = '600';
                        link.title = isSolana ? 'View on Solana Explorer' : 'View on Explorer';

                        const icon = global.document.createElement('span');
                        icon.textContent = ' \u2197';
                        icon.style.fontSize = '11px';
                        link.appendChild(icon);
                        row.appendChild(link);
                        list.appendChild(row);
                    });

                    linksContainer.appendChild(list);
                }
                card.appendChild(linksContainer);
            }

            const okBtn = global.document.createElement('button');
            okBtn.textContent = 'OK';
            okBtn.style.padding = '10px 12px';
            okBtn.style.border = 'none';
            okBtn.style.borderRadius = '8px';
            okBtn.style.background = '#0d3b66';
            okBtn.style.color = '#fff';
            okBtn.style.cursor = 'pointer';
            okBtn.style.width = '100%';
            okBtn.style.marginTop = '4px';
            okBtn.addEventListener('click', () => {
                if (overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                if (typeof onClose === 'function') {
                    try { onClose(); } catch (_) { }
                }
            });

            card.appendChild(okBtn);
            overlay.appendChild(card);
            global.document.body.appendChild(overlay);
        } catch (err) {
            console.warn('Failed to show parcel mint success popup:', err);
        }
    }

    function removeParcelMintModal(reason = 'dismiss') {
        const existing = global.document ? global.document.getElementById(PARCEL_MINT_MODAL_ID) : null;
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
        const onExit = parcelMintModalOnExit;
        parcelMintModalOnExit = null;
        if (typeof onExit === 'function') {
            try {
                onExit(reason);
            } catch (err) {
                console.warn('Failed to run parcel mint close handler', err);
            }
        }
    }

    function renderParcelThumbnailFallback(polygons, neighbours, entry, imgEl) {
        if (!imgEl) return;
        const allShapes = Array.isArray(neighbours) && neighbours.length
            ? polygons.concat(neighbours)
            : polygons;
        const bounds = computeBoundingBox(allShapes);
        if (!bounds) {
            imgEl.alt = 'Preview unavailable';
            return;
        }
        const width = 240;
        const height = 180;
        const padding = 20;
        const canvas = global.document && global.document.createElement('canvas');
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(255, 102, 0, 0.18)';
        ensureArray(polygons).forEach(polygon => {
            ensureArray(polygon).forEach(ring => {
                const cleanRing = sanitizeRing(ring);
                if (!cleanRing.length) return;
                ctx.beginPath();
                cleanRing.forEach((coord, idx) => {
                    const [x, y] = projectCoordinate(coord, bounds, width, height, padding);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                    if (idx === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            });
        });

        // Draw neighbouring parcel outlines on top
        // neighbours is an array of rings, where each ring is [[lng, lat], ...]
        if (Array.isArray(neighbours) && neighbours.length) {
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 3;
            neighbours.forEach(ring => {
                const cleanRing = sanitizeRing(ring);
                if (!cleanRing.length) return;
                ctx.beginPath();
                cleanRing.forEach((coord, idx) => {
                    const [x, y] = projectCoordinate(coord, bounds, width, height, padding);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                    if (idx === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });
                ctx.closePath();
                ctx.stroke();
            });
        }

        if (entry && entry.parcelId) {
            const centerLon = (bounds.minX + bounds.maxX) / 2;
            const centerLat = (bounds.minY + bounds.maxY) / 2;
            const [labelX, labelY] = projectCoordinate([centerLon, centerLat], bounds, width, height, padding);
            if (Number.isFinite(labelX) && Number.isFinite(labelY)) {
                const label = String(entry.parcelId);
                ctx.font = '700 16px "Helvetica Neue", Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.lineWidth = 4;
                ctx.strokeStyle = 'rgba(255,255,255,0.82)';
                ctx.fillStyle = '#0f172a';
                ctx.strokeText(label, labelX, labelY);
                ctx.fillText(label, labelX, labelY);
            }
        }
        imgEl.src = canvas.toDataURL('image/png');
        imgEl.alt = `Parcel ${entry.parcelId} preview`;
    }

    function buildParcelThumbnailLoader(entry, imgEl, neighbours = []) {
        if (!imgEl) return;
        let geometrySource = entry.feature?.geometry || entry.feature || {};
        let polygons = extractPolygonCoordinateSets(geometrySource);
        // If feature is a Leaflet layer (no geometry), try to extract from sub-layers
        if (!polygons.length && entry.feature && typeof entry.feature.getLayers === 'function') {
            const extracted = extractFeatureFromLayer(entry.feature);
            if (extracted && extracted.geometry) {
                geometrySource = extracted.geometry;
                polygons = extractPolygonCoordinateSets(geometrySource);
            }
        }
        if (!polygons.length) {
            imgEl.alt = 'Preview unavailable';
            return;
        }
        const neighbourRings = (Array.isArray(neighbours) ? neighbours : []).map(ring => {
            return (Array.isArray(ring) ? ring : []).map(pt => {
                if (Array.isArray(pt) && pt.length >= 2) return [pt[0], pt[1]];
                if (pt && typeof pt.lng === 'number' && typeof pt.lat === 'number') return [pt.lng, pt.lat];
                if (pt && typeof pt.longitude === 'number' && typeof pt.latitude === 'number') return [pt.longitude, pt.latitude];
                return pt;
            }).filter(coord => Array.isArray(coord) && coord.length >= 2 && Number.isFinite(coord[0]) && Number.isFinite(coord[1]));
        });
        renderParcelThumbnailFallback(polygons, neighbourRings, entry, imgEl);
    }

    function buildExplorerAddressUrl({ chainId, chainSlug, address }) {
        if (!address) return null;
        const base = getParcelExplorerBaseUrl(chainId, chainSlug);
        if (!base) return null;
        const cid = (chainId || chainSlug || '').toString();
        if (cid.startsWith('solana')) {
            const cluster = cid.replace(/^solana-?/, '') || 'devnet';
            const suffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
            return `${base}/address/${encodeURIComponent(address)}${suffix}`;
        }
        return `${base}/address/${encodeURIComponent(address)}`;
    }

    function buildExplorerTxUrl({ chainId, chainSlug, txHash }) {
        if (!txHash) return null;
        const base = getParcelExplorerBaseUrl(chainId, chainSlug);
        if (!base) return null;
        const cid = (chainId || chainSlug || '').toString();
        if (cid.startsWith('solana')) {
            const cluster = cid.replace(/^solana-?/, '') || 'devnet';
            const suffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
            return `${base}/tx/${encodeURIComponent(txHash)}${suffix}`;
        }
        return `${base}/tx/${encodeURIComponent(txHash)}`;
    }

    async function buildParcelMintModal({ parcels, chainSlug, chainId, contractAddress, ownerAddress, onConfirm, onExit }) {
        removeParcelMintModal('replace');
        const overlay = global.document.createElement('div');
        overlay.id = PARCEL_MINT_MODAL_ID;
        overlay.className = 'parcel-mint-overlay';
        parcelMintModalOnExit = typeof onExit === 'function' ? onExit : null;

        const modal = global.document.createElement('div');
        modal.className = 'parcel-mint-modal';

        const header = global.document.createElement('div');
        header.className = 'parcel-mint-header';
        const titleWrap = global.document.createElement('div');
        titleWrap.className = 'parcel-mint-header__text';
        const title = global.document.createElement('h2');
        title.textContent = 'Mint parcel representations as NFTs';
        const subtitle = global.document.createElement('p');
        subtitle.className = 'parcel-mint-subtitle';
        subtitle.textContent = 'Choose which parcels to mint on the ParcelNFT contract. If feasible (not too many), the parcels will all be minted in one transaction.';
        titleWrap.appendChild(title);
        titleWrap.appendChild(subtitle);
        const closeBtn = global.document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close-circle-btn close-circle-btn--lg parcel-mint-close';
        closeBtn.textContent = '×';
        closeBtn.onclick = () => removeParcelMintModal('close');
        header.appendChild(titleWrap);
        header.appendChild(closeBtn);

        const body = global.document.createElement('div');
        body.className = 'parcel-mint-body';

        const meta = global.document.createElement('div');
        meta.className = 'parcel-mint-meta';
        const displayChain = chainSlug ? `${String(chainSlug).charAt(0).toUpperCase()}${String(chainSlug).slice(1)}` : 'unknown';
        const metaList = [
            { label: 'Chain', value: displayChain },
            { label: 'Minting contract', value: contractAddress || 'n/a', monospace: true, url: buildExplorerAddressUrl({ chainId, chainSlug, address: contractAddress }) },
            { label: 'Owner address', value: ownerAddress || 'n/a', monospace: true, url: buildExplorerAddressUrl({ chainId, chainSlug, address: ownerAddress }) }
        ];
        metaList.forEach((item) => {
            const row = global.document.createElement('div');
            row.className = 'parcel-mint-meta__row';
            const label = global.document.createElement('div');
            label.className = 'parcel-mint-meta__label';
            label.textContent = item.label;
            const value = global.document.createElement('div');
            value.className = 'parcel-mint-meta__value';
            if (item.url) {
                const link = global.document.createElement('a');
                link.href = item.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = item.value;
                value.appendChild(link);
            } else {
                value.textContent = item.value;
            }
            if (item.monospace) value.classList.add('is-monospace');
            row.appendChild(label);
            row.appendChild(value);
            meta.appendChild(row);
        });

        const neighbourMap = {};
        try {
            await Promise.all(parcels.map(async (parcel) => {
                neighbourMap[parcel.parcelId] = findNeighbourPolygonsFromCache(parcel.parcelId);
            }));
        } catch (prefetchError) {
            console.warn('Failed to prefetch neighbours for mint thumbnails', prefetchError);
        }

        const list = global.document.createElement('div');
        list.className = 'parcel-mint-list';

        const parcelCheckboxes = [];
        parcels.forEach((parcel, index) => {
            const row = global.document.createElement('div');
            row.className = 'parcel-mint-row';

            const checkbox = global.document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.id = `parcel-mint-checkbox-${index}`;
            checkbox.className = 'parcel-mint-checkbox';

            const left = global.document.createElement('div');
            left.className = 'parcel-mint-row__main';
            const labelWrap = global.document.createElement('label');
            labelWrap.setAttribute('for', checkbox.id);
            labelWrap.className = 'parcel-mint-row__label';
            const nameEl = global.document.createElement('div');
            nameEl.className = 'parcel-mint-row__title';
            nameEl.textContent = parcel.parcelName || `Parcel ${parcel.parcelId}`;
            const idEl = global.document.createElement('div');
            idEl.className = 'parcel-mint-row__meta';
            idEl.textContent = parcel.parcelId;
            labelWrap.appendChild(nameEl);
            labelWrap.appendChild(idEl);

            const thumb = global.document.createElement('img');
            thumb.className = 'parcel-mint-thumb';
            thumb.alt = `Parcel ${parcel.parcelId} preview`;
            // Transparent 1x1 placeholder to avoid broken image icon while thumbnail loads
            thumb.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

            left.appendChild(checkbox);
            left.appendChild(labelWrap);

            row.appendChild(left);
            row.appendChild(thumb);

            list.appendChild(row);
            parcelCheckboxes.push({ checkbox, parcel });

            const neighbours = Array.isArray(neighbourMap[parcel.parcelId]) ? neighbourMap[parcel.parcelId] : [];
            buildParcelThumbnailLoader(parcel, thumb, neighbours);
        });

        const footer = global.document.createElement('div');
        footer.className = 'parcel-mint-footer';
        const status = global.document.createElement('div');
        status.className = 'parcel-mint-status';
        const actions = global.document.createElement('div');
        actions.className = 'parcel-mint-actions';
        const mintBtn = global.document.createElement('button');
        mintBtn.type = 'button';
        mintBtn.className = 'btn btn-primary';
        mintBtn.textContent = 'Mint';

        const setBusy = (busy, message) => {
            mintBtn.disabled = busy;
            overlay.classList.toggle('is-busy', Boolean(busy));
            status.textContent = message || '';
        };

        mintBtn.onclick = async () => {
            const selected = parcelCheckboxes
                .filter(entry => entry.checkbox.checked)
                .map(entry => entry.parcel);
            if (!selected.length) {
                status.textContent = 'Select at least one parcel to mint.';
                return;
            }
            try {
                setBusy(true, 'Preparing mint transaction...');
                const result = await onConfirm({ parcels: selected, setBusy, statusEl: status, neighboursByParcelId: neighbourMap });
                const mintedIds = Array.isArray(result?.mintedParcelIds)
                    ? result.mintedParcelIds.filter(Boolean)
                    : selected.map(entry => entry.parcel?.parcelId || entry.parcelId).filter(Boolean);
                const mintedLayerApi = global.ParcelsMintedLayer || null;
                if (mintedLayerApi && mintedIds.length) {
                    mintedLayerApi.addMintedParcels(mintedIds);
                }
                const mintedAll = mintedIds.length >= parcels.length;
                if (mintedAll) {
                    removeParcelMintModal('completed');
                    showParcelMintSuccessPopup({
                        parcelCount: mintedIds.length,
                        transactions: result?.transactions || [],
                        chainId: result?.chainId || null
                    });
                    return;
                }
                mintBtn.disabled = false;
                overlay.classList.remove('is-busy');
                const hasStatusContent = Boolean(status.innerHTML && status.innerHTML.trim());
                if (!hasStatusContent) {
                    status.textContent = result?.statusMessage || 'Mint successful. You can mint remaining parcels.';
                }
            } catch (error) {
                console.error('Parcel mint failed', error);
                setBusy(false, error?.message || 'Mint failed. Please try again.');
            }
        };

        actions.appendChild(mintBtn);
        footer.appendChild(status);
        footer.appendChild(actions);

        body.appendChild(meta);
        body.appendChild(list);
        body.appendChild(footer);

        modal.appendChild(header);
        modal.appendChild(body);
        overlay.appendChild(modal);
        overlay.onclick = (event) => {
            if (event.target === overlay) {
                removeParcelMintModal('overlay');
            }
        };
        global.document.body.appendChild(overlay);
    }

    function collectCurrentParcelForMint() {
        const layer = global.currentParcel && global.currentParcel.layer ? global.currentParcel.layer : null;
        const parcelFeature = extractFeatureFromLayer(layer);
        if (!parcelFeature) return [];
        const parcelId = deriveParcelIdentifier(parcelFeature);
        if (!parcelId) return [];
        const parcelName = (parcelFeature.properties && parcelFeature.properties.name)
            || (parcelFeature.properties && parcelFeature.properties.parcel_name)
            || `Parcel ${parcelId}`;
        return [{ parcelId, parcelName, feature: parcelFeature }];
    }

    async function uploadParcelMetadataAsset({ imageData, metadata, fileName, chainId }) {
        if (!global.AssetService || typeof global.AssetService.uploadProposalAssets !== 'function') {
            throw new Error('Asset upload service is not available.');
        }

        try {
            return await global.AssetService.uploadProposalAssets({
                imageData,
                metadata,
                fileName,
                chainId,
                target: 'auto'
            });
        } catch (primaryError) {
            console.warn('Primary parcel metadata upload failed, retrying with backend storage.', primaryError);
        }

        return await global.AssetService.uploadProposalAssets({
            imageData,
            metadata,
            fileName,
            chainId: null,
            target: 'backend'
        });
    }

    async function uploadParcelMetadataOnly({ metadata, fileName }) {
        const base = (typeof getBackendBase === 'function' ? getBackendBase() : '').replace(/\/$/, '');
        if (!base) {
            throw new Error('Backend base URL is not available for metadata upload.');
        }

        const response = await fetch(`${base}/metadata`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                metadata,
                fileName
            })
        });

        if (!response.ok) {
            let message = 'Failed to store parcel metadata.';
            try {
                const errorBody = await response.json();
                if (errorBody && errorBody.error) {
                    message = errorBody.error;
                }
            } catch (_) { }
            throw new Error(message);
        }

        return await response.json();
    }

    function requireParcelMetadataUri(metadataUri, parcelId) {
        const value = typeof metadataUri === 'string' ? metadataUri.trim() : '';
        if (value) {
            return value;
        }
        throw new Error(`Failed to create metadata URI for parcel ${parcelId}. Parcel was not minted.`);
    }

    function findNeighbourPolygonsFromCache(parcelId) {
        if (!parcelId) return [];
        try {
            // Get the parcel cache (grid of loaded features)
            const cache = (global.ParcelsState && typeof global.ParcelsState.getParcelCache === 'function')
                ? global.ParcelsState.getParcelCache()
                : global.parcelCache;
            if (!cache || !cache.grid) return [];

            // Find the target feature
            const targetId = parcelId.toString();
            let targetFeature = null;
            if (cache.byId instanceof Map) {
                targetFeature = cache.byId.get(targetId);
            }
            if (!targetFeature) {
                for (const [, cellData] of cache.grid) {
                    if (!cellData || !Array.isArray(cellData.features)) continue;
                    targetFeature = cellData.features.find(f => {
                        const fId = f?.properties?.parcelId || f?.properties?.BROJ_CESTICE;
                        return fId && fId.toString() === targetId;
                    });
                    if (targetFeature) break;
                }
            }
            if (!targetFeature || !targetFeature.geometry) return [];

            // Use turf to find touching/intersecting parcels from loaded cache
            const hasTurf = global.turf && typeof global.turf.booleanIntersects === 'function';
            if (!hasTurf) return [];

            const neighbours = [];
            const seen = new Set();
            seen.add(targetId);

            for (const [, cellData] of cache.grid) {
                if (!cellData || !Array.isArray(cellData.features)) continue;
                for (const feature of cellData.features) {
                    if (!feature || !feature.geometry) continue;
                    const fId = (feature.properties?.parcelId || feature.properties?.BROJ_CESTICE || '').toString();
                    if (!fId || seen.has(fId)) continue;
                    seen.add(fId);
                    try {
                        if (global.turf.booleanIntersects(targetFeature, feature)) {
                            // Extract outer ring(s) as {lat, lng} arrays
                            const coordSets = extractPolygonCoordinateSets(feature.geometry);
                            for (const polygon of coordSets) {
                                if (!Array.isArray(polygon) || !polygon.length) continue;
                                const outerRing = Array.isArray(polygon[0]) && Array.isArray(polygon[0][0]) ? polygon[0] : polygon;
                                const latLngRing = outerRing
                                    .map(coord => Array.isArray(coord) && coord.length >= 2 ? { lat: coord[1], lng: coord[0] } : null)
                                    .filter(pt => pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lng));
                                if (latLngRing.length >= 3) {
                                    neighbours.push(latLngRing);
                                }
                            }
                        }
                    } catch (_) { /* skip invalid geometry */ }
                }
            }
            return neighbours;
        } catch (error) {
            console.warn('Failed to find neighbours from cache', error);
            return [];
        }
    }

    async function prepareParcelMintAssets(parcels, signerAddress, neighboursByParcelId = {}, chainId = null, statusEl = null) {
        const prepared = [];
        for (let idx = 0; idx < parcels.length; idx++) {
            const parcel = parcels[idx];
            let metadataUri = null;
            const neighbours = Array.isArray(neighboursByParcelId[parcel.parcelId])
                ? neighboursByParcelId[parcel.parcelId]
                : findNeighbourPolygonsFromCache(parcel.parcelId);
            // Resolve the GeoJSON feature — handle both direct features and Leaflet layer groups
            const resolvedFeature = (parcel.feature && parcel.feature.geometry) ? parcel.feature : extractFeatureFromLayer(parcel.feature);
            const calculatedArea = resolvedFeature?.properties?.calculatedArea;
            const areaSquareMeters = Number.isFinite(calculatedArea) && calculatedArea > 0
                ? Math.round(calculatedArea * 100) / 100
                : null;

            const attributes = [
                { trait_type: 'Parcel ID', value: parcel.parcelId },
                { trait_type: 'Minted By', value: signerAddress }
            ];

            if (areaSquareMeters !== null) {
                attributes.push({ trait_type: 'Area (m²)', value: areaSquareMeters, display_type: 'number' });
            }

            const metadataPayload = {
                name: parcel.parcelName || `Parcel ${parcel.parcelId}`,
                description: `Digitized cadastral parcel ${parcel.parcelId}. Minted by ${signerAddress}.`,
                image: '',
                attributes,
                parcelId: parcel.parcelId,
                areaSquareMeters,
                geometry: resolvedFeature?.geometry || null
            };

            try {
                if (statusEl) {
                    const storageLabel = (typeof global.getStorageProviderLabel === 'function') ? global.getStorageProviderLabel() : 'decentralized storage';
                    const label = parcels.length > 1 ? `Uploading parcel ${idx + 1}/${parcels.length} to ${storageLabel}...` : `Uploading parcel metadata to ${storageLabel}...`;
                    statusEl.textContent = label;
                }
                if (global.MapScreenshot && typeof global.MapScreenshot.capturePolygonImage === 'function' && global.AssetService && typeof global.AssetService.uploadProposalAssets === 'function') {
                    const polygonRings = extractOuterPolygonRings(resolvedFeature?.geometry || parcel.feature || {});
                    const rings = polygonRings.length > 0 ? polygonRings[0] : [];

                    if (rings.length >= 3 && global.L) {
                        const latLngRings = rings.map(coord => ({ lat: coord[1], lng: coord[0] }));
                        const bounds = global.L.latLngBounds(latLngRings);
                        const screenshot = await global.MapScreenshot.capturePolygonImage({
                            polygon: latLngRings,
                            parcelPolygons: polygonRings.map(ring => ring.map(coord => ({ lat: coord[1], lng: coord[0] }))),
                            bounds,
                            padding: 0.14,
                            size: 640,
                            neighbours,
                            parcelLabel: parcel.parcelId || null
                        });
                        const uploadResult = await uploadParcelMetadataAsset({
                            imageData: screenshot,
                            metadata: metadataPayload,
                            fileName: `parcel-${parcel.parcelId}.png`,
                            chainId
                        });
                        metadataUri = uploadResult?.metadataUri || uploadResult?.metadataUrl || null;
                    }
                }
            } catch (assetError) {
                console.warn('Failed to prepare parcel metadata.', assetError);
            }
            if (!metadataUri) {
                try {
                    const metadataOnlyResult = await uploadParcelMetadataOnly({
                        metadata: metadataPayload,
                        fileName: `parcel-${parcel.parcelId}.json`
                    });
                    metadataUri = metadataOnlyResult?.metadataUrl || null;
                } catch (metadataError) {
                    console.warn('Failed to store parcel metadata without image.', metadataError);
                }
            }
            metadataUri = requireParcelMetadataUri(metadataUri, parcel.parcelId);
            prepared.push({
                parcelId: parcel.parcelId,
                parcelName: parcel.parcelName,
                feature: parcel.feature,
                metadataUri
            });
        }
        return prepared;
    }

    async function executeParcelBatchMint({ parcels, signer, ownerAddress, contractAddress, chainSlug, statusEl }) {
        const ethersLib = global.ethers;
        if (!ethersLib) {
            throw new Error('Blockchain library is not available.');
        }
        const abi = [
            'function mintBatch(address to, string[] parcelIds, string[] metadataURIs) public returns (uint256[])'
        ];
        const contract = new ethersLib.Contract(contractAddress, abi, signer);
        const parcelIds = parcels.map(p => p.parcelId);
        const metadataUris = parcels.map(p => requireParcelMetadataUri(p.metadataUri, p.parcelId));
        if (statusEl) statusEl.textContent = 'Submitting mint transaction...';
        const tx = await contract.mintBatch(ownerAddress, parcelIds, metadataUris);
        if (statusEl) statusEl.textContent = `Waiting for confirmation on ${chainSlug || 'chain'}...`;
        const receipt = typeof tx.wait === 'function' ? await tx.wait() : null;
        return { txHash: tx.hash, receipt };
    }

    async function openParcelMintModal(options = {}) {
        try {
            const providedParcels = Array.isArray(options.parcels) ? options.parcels.filter(Boolean) : null;
            const isMultiActive = !providedParcels && global.multiParcelSelection && global.multiParcelSelection.isActive;
            const parcels = providedParcels && providedParcels.length
                ? providedParcels
                : (isMultiActive ? collectMultiSelectedParcelsForMint() : collectCurrentParcelForMint());
            if (!parcels.length) {
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus('Select a parcel before minting.');
                }
                return;
            }

            const solanaWalletManager = global.solanaWalletManager;
            const solanaState = solanaWalletManager && typeof solanaWalletManager.getState === 'function' ? solanaWalletManager.getState() : null;
            const isSolanaConnected = solanaState && solanaState.status === 'connected' && Array.isArray(solanaState.accounts) && solanaState.accounts.length > 0;

            if (isSolanaConnected && global.mintParcelSolana) {
                const cluster = solanaState.cluster || 'devnet';
                const contractAddress = await resolveParcelNftAddressSolana(cluster);
                if (!contractAddress) {
                    throw new Error('ParcelNFT program not configured for Solana.');
                }
                const ownerAddress = solanaState.accounts[0];
                const chainSlug = `solana-${cluster}`;
                await buildParcelMintModal({
                    parcels,
                    chainSlug,
                    chainId: 'solana',
                    contractAddress,
                    ownerAddress,
                    onExit: typeof options.onExit === 'function' ? options.onExit : null,
                    onConfirm: async ({ parcels: selectedParcels, setBusy, statusEl, neighboursByParcelId }) => {
                        const prepared = await prepareParcelMintAssets(selectedParcels, ownerAddress, neighboursByParcelId, chainSlug, statusEl);
                        const mintedParcelIds = [];
                        const transactions = [];
                        for (let i = 0; i < prepared.length; i++) {
                            const p = prepared[i];
                            if (statusEl) statusEl.textContent = `Minting parcel ${i + 1}/${prepared.length}...`;
                            try {
                                const result = await global.mintParcelSolana(
                                    p.parcelId,
                                    requireParcelMetadataUri(p.metadataUri, p.parcelId),
                                    contractAddress,
                                    cluster
                                );
                                mintedParcelIds.push(p.parcelId);
                                if (result?.txHash) {
                                    transactions.push({ parcelId: p.parcelId, txHash: result.txHash });
                                } else if (result?.alreadyMinted && statusEl) {
                                    statusEl.textContent = `Parcel ${i + 1}/${prepared.length} already minted.`;
                                }
                            } catch (err) {
                                console.error('Solana parcel mint failed', err);
                                setBusy(false, err?.message || 'Mint failed.');
                                return { mintedParcelIds, statusMessage: err?.message };
                            }
                        }
                        setBusy(false);
                        return { mintedParcelIds, transactions, chainId: `solana-${cluster}` };
                    }
                });
                return;
            }

            const walletManager = global.walletManager;
            const walletProvider = walletManager && typeof walletManager.getProvider === 'function' ? walletManager.getProvider() : null;
            if (!walletProvider) {
                throw new Error('Connect your wallet to mint parcels.');
            }
            const ethersLib = global.ethers;
            if (!ethersLib) {
                throw new Error('Blockchain library is not available.');
            }
            const browserProvider = new ethersLib.BrowserProvider(walletProvider);
            const signer = await browserProvider.getSigner();
            const ownerAddress = await signer.getAddress();
            const network = await browserProvider.getNetwork();
            const chainId = normalizeChainIdValue(network?.chainId);
            const chainSlug = resolveChainSlug(chainId);
            const contractAddress = await resolveParcelNftAddress(chainId);
            if (!contractAddress) {
                throw new Error('ParcelNFT address is not configured for this chain.');
            }

            if (isMultiActive) {
                const ethersLib = global.ethers;
                const contract = new ethersLib.Contract(
                    contractAddress,
                    PARCEL_NFT_ABI_FRAGMENT,
                    browserProvider
                );

                const mintedParcels = [];
                for (const parcel of parcels) {
                    try {
                        await fetchParcelTokenId(contract, parcel.parcelId);
                        mintedParcels.push(parcel.parcelId);
                    } catch (error) {
                        if (!(error && error.message === 'TOKEN_NOT_MINTED')) {
                            console.warn('Unable to confirm parcel mint status, treating as already minted', parcel.parcelId, error);
                            mintedParcels.push(parcel.parcelId);
                        }
                    }
                }

                if (mintedParcels.length > 0) {
                    setParcelMintStatusIndicator(
                        'some of the selected parcels have already been minted. deselect them to proceed to mint.',
                        'error',
                        chainSlug
                    );
                    const mintButton = global.document ? global.document.getElementById('mintAndClaimButton') : null;
                    if (mintButton) {
                        mintButton.disabled = false; // keep enabled per requirement; checks happen on press
                    }
                    return;
                }

                setParcelMintStatusIndicator('Selected parcels are ready to mint.', 'not-minted', chainSlug);
            }

            await buildParcelMintModal({
                parcels,
                chainSlug,
                chainId,
                contractAddress,
                ownerAddress,
                onExit: typeof options.onExit === 'function' ? options.onExit : null,
                onConfirm: async ({ parcels: selectedParcels, setBusy, statusEl, neighboursByParcelId }) => {
                    const prepared = await prepareParcelMintAssets(selectedParcels, ownerAddress, neighboursByParcelId, chainId, statusEl);
                    const result = await executeParcelBatchMint({ parcels: prepared, signer, ownerAddress, contractAddress, chainSlug, statusEl });
                    const mintedParcelIds = prepared.map(p => p.parcelId).filter(Boolean);
                    const txHash = result?.txHash || null;
                    const transactions = txHash ? [{ txHash }] : [];
                    setBusy(false);
                    if (typeof triggerParcelToolsTabActivated === 'function') {
                        triggerParcelToolsTabActivated(true);
                    }
                    return {
                        mintedParcelIds,
                        transactions,
                        chainId: chainId
                    };
                }
            });
        } catch (error) {
            console.error('Unable to open parcel mint modal', error);
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(error?.message || 'Unable to open mint modal.');
            }
        }
    }

    const deriveParcelIdentifier = global.Parcels?.blockchain?.deriveParcelIdentifier || global.deriveParcelIdentifier;
    const resolveParcelClaimContext = global.Parcels?.blockchain?.resolveParcelClaimContext || global.resolveParcelClaimContext;
    const buildClaimUrl = global.Parcels?.blockchain?.buildClaimUrl || global.buildClaimUrl;
    const isParcelTokenMissingError = global.Parcels?.blockchain?.isParcelTokenMissingError || global.isParcelTokenMissingError || (() => false);
    const resolveChainSlug = global.Parcels?.blockchain?.resolveChainSlug || global.resolveChainSlug;
    const normalizeChainIdValue = global.Parcels?.blockchain?.normalizeChainIdValue || global.normalizeChainIdValue;
    const resolveParcelNftAddress = global.Parcels?.blockchain?.resolveParcelNftAddress || global.resolveParcelNftAddress;
    const openExternalUrl = global.openExternalUrl || ((targetUrl) => {
        if (!targetUrl || !global.window) return;
        const opened = global.window.open(targetUrl, '_blank', 'noopener,noreferrer');
        if (opened) return;
        if (!global.document || !global.document.body) {
            global.window.location.href = targetUrl;
            return;
        }
        const anchor = global.document.createElement('a');
        anchor.href = targetUrl;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.style.display = 'none';
        global.document.body.appendChild(anchor);
        anchor.click();
        global.document.body.removeChild(anchor);
    });

    global.ParcelsUIClaim = {
        getParcelMintStatusElement,
        normalizeMintStatusState,
        getParcelExplorerBaseUrl,
        buildParcelNftExplorerUrl,
        setButtonEnabledState,
        setParcelClaimButtonsState,
        setParcelMintStatusIndicator,
        resetParcelMintStatusState,
        applyParcelMintStatusResult,
        fetchParcelMintStatus,
        triggerParcelToolsTabActivated,
        recheckParcelMintStatus,
        resolveClaimPortalBaseUrl,
        resolveMintDeclareConfig,
        buildMintDeclareUrl,
        openMintAttestFlow,
        openParcelBuilder,
        buildParcelBuilderUrl,
        openClaimOnly,
        openClaimPortal,
        openParcelMintModal,
        toStringSafe,
        fetchParcelTokenId
    };

    global.openParcelBuilder = openParcelBuilder;
    global.openClaimOnly = openClaimOnly;
    global.openClaimPortal = openClaimPortal;
    global.openParcelMintModal = openParcelMintModal;
    global.setParcelMintStatusIndicator = setParcelMintStatusIndicator;
    global.resetParcelMintStatusState = resetParcelMintStatusState;
    global.applyParcelMintStatusResult = applyParcelMintStatusResult;
    global.triggerParcelToolsTabActivated = triggerParcelToolsTabActivated;
    global.recheckParcelMintStatus = recheckParcelMintStatus;
    global.findNeighbourPolygonsFromCache = findNeighbourPolygonsFromCache;
})(typeof window !== 'undefined' ? window : globalThis);
