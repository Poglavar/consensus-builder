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
                if (translated !== undefined && translated !== null && translated !== key) {
                    return translated;
                }
            }
        } catch (_) { }
        return fallback || key || '';
    };

    const PARCEL_NFT_ABI_FRAGMENT = [
        'function tokenIdForParcelId(string parcelId) view returns (uint256)'
    ];

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
    let activeMintStatusRetry = null;

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
            row.hidden = isMultiActive && !keep;
        });
    }

    function isWalletConnected() {
        const walletManager = global.walletManager;
        const walletState = walletManager && typeof walletManager.getState === 'function' ? walletManager.getState() : null;
        const accounts = walletState && Array.isArray(walletState.accounts) ? walletState.accounts : [];
        return Boolean(walletState && walletState.status === 'connected' && accounts.length > 0);
    }

    function getLiveParcelFeature(parcelId) {
        const id = parcelId !== undefined && parcelId !== null ? String(parcelId) : '';
        if (!id || !global.LiveParcelFabric || typeof global.LiveParcelFabric.get !== 'function') return null;
        return global.LiveParcelFabric.get(id);
    }

    function getCurrentLiveParcelFeature() {
        const parcelId = global.currentParcel?.id ?? global.selectedParcelId ?? null;
        return getLiveParcelFeature(parcelId);
    }

    function collectMultiSelectedParcelsForMint() {
        const multi = global.multiParcelSelection;
        if (!multi || !multi.selectedParcels || multi.selectedParcels.size === 0) {
            return [];
        }

        const parcels = [];
        multi.selectedParcels.forEach((id) => {
            const feature = getLiveParcelFeature(id);
            if (!feature) return;
            const parcelId = deriveParcelIdentifier(feature);
            if (!parcelId) return;
            const props = feature.properties || {};
            const parcelName = props.name || props.parcel_name || props.parcel || props.BROJ_CESTICE || `Parcel ${parcelId}`;
            parcels.push({ parcelId, parcelName, feature });
        });
        return parcels;
    }

    // Mint, the Tools tab's one primary action (btn-primary in index.html), is enabled while the
    // selected parcel has no anchor, or while several parcels are selected and a wallet is connected.
    function setParcelClaimButtonsState(state = 'neutral') {
        const normalized = normalizeMintStatusState(state);
        const mintAndClaimButton = global.document ? global.document.getElementById('mintAndClaimButton') : null;

        const multi = global.multiParcelSelection;
        const hasMultiMode = Boolean(multi && (multi.isActive || multi.selectedParcels?.size > 0));
        const multiCount = hasMultiMode && multi && multi.selectedParcels ? multi.selectedParcels.size : 0;

        updateToolsButtonsVisibilityForMulti(hasMultiMode);
        if (hasMultiMode) {
            setButtonEnabledState(mintAndClaimButton, isWalletConnected() && multiCount > 0);
            return;
        }
        setButtonEnabledState(mintAndClaimButton, normalized === 'not-minted');
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
            // Chain should always be available when checking the anchor
            // If we don't have it, this is an unexpected state - we attempted to check on a chain
            console.error('Chain information not available for the anchor status indicator - this should not happen as we attempted to check on a specific chain');
        }
        // Always use the chain if we have it - we attempted to check on this chain
        const chainParam = cachedChain ? { chain: cachedChain } : {};
        // "No anchor minted yet" is only said when the chain answered that the parcel has no anchor. When the
        // check itself could not run (no RPC, RPC down, wrong program), say so — never imply absence.
        let retryMessage;
        if (state === 'error') {
            retryMessage = cachedChain
                ? tParcel('panel.parcel.nft.checkFailedRetry', chainParam, `Couldn't check the anchor on ${cachedChain}. Click to try again.`)
                : tParcel('panel.parcel.nft.checkFailedRetryNoChain', {}, "Couldn't check the anchor. Click to try again.");
        } else {
            retryMessage = cachedChain
                ? tParcel('panel.parcel.nft.statusNotMinted', {}, 'No anchor minted yet')
                : tParcel('panel.parcel.nft.statusUnknown', {}, 'Anchor not checked yet.');
        }
        const retryTooltip = tParcel('panel.parcel.nft.retryTooltip', {}, 'Click to check again');
        const resolvedMessage = message || tParcel('panel.parcel.nft.statusUnknown', {}, 'Anchor not checked yet.');

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
            const retryButton = global.document.createElement('button');
            retryButton.type = 'button';
            retryButton.className = 'btn btn-quiet';
            retryButton.textContent = displayMessage;
            retryButton.title = retryTooltip;
            retryButton.addEventListener('click', event => {
                activeMintStatusRetry = retryButton;
                global.BusyControl.track(retryButton, () => recheckParcelMintStatus(event))
                    .catch(error => console.error('Parcel anchor status retry failed:', error))
                    .finally(() => { if (activeMintStatusRetry === retryButton) activeMintStatusRetry = null; });
            });
            indicator.replaceChildren(retryButton);
        } else {
            if (state === 'loading' && activeMintStatusRetry && indicator.contains(activeMintStatusRetry)) {
                activeMintStatusRetry.textContent = resolvedMessage || retryMessage;
            } else {
                setIndicatorContent(resolvedMessage || retryMessage);
            }
        }
        indicator.title = '';

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
            tParcel('panel.parcel.nft.statusUnknown', {}, 'Anchor not checked yet.'),
            'neutral'
        );
    }

    function applyParcelMintStatusResult(result) {
        if (!result) {
            setParcelMintStatusIndicator(
                tParcel('panel.parcel.nft.statusUnknown', {}, 'Anchor not checked yet.'),
                'neutral'
            );
            return;
        }

        const mintedLayerApi = global.ParcelsMintedLayer || null;
        const activeLayer = global.currentParcel && global.currentParcel.layer ? global.currentParcel.layer : null;
        const activeFeature = getCurrentLiveParcelFeature();
        const parcelIdForLayer = currentParcelMintStatusCache?.parcelId
            || currentParcelMintStatusParcelId
            || resolveParcelId(activeFeature);

        const displayChain = formatChainLabel(result.chainSlug);

        if (result.minted) {
            const onSolana = String(result.chainSlug || result.chainId || '').startsWith('solana');
            const messageText = onSolana || !displayChain
                ? tParcel('panel.parcel.nft.statusMinted', {}, 'Anchor minted on Solana')
                : tParcel('panel.parcel.nft.statusMintedOn', { chain: displayChain }, `Anchored on ${displayChain}`);
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
                    link.title = tParcel('panel.parcel.nft.viewOnExplorer', {}, 'View on explorer');
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

        const isMultiActive = global.multiParcelSelection && (global.multiParcelSelection.isActive || global.multiParcelSelection.selectedParcels?.size > 0);
        if (isMultiActive) {
            setParcelMintStatusIndicator(
                tParcel('panel.parcel.nft.multiReady', {}, 'Ready to mint anchors for the selected parcels.'),
                'neutral'
            );
            return null;
        }

        const parcelFeature = getCurrentLiveParcelFeature();
        if (!parcelFeature) {
            setParcelMintStatusIndicator(
                tParcel('panel.parcel.nft.statusPrompt', {}, 'Select a parcel to check its anchor.'),
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
                tParcel('panel.parcel.nft.checking', {}, 'Checking the anchor…'),
                'loading'
            );
            return currentParcelMintStatusPromise;
        }

        currentParcelMintStatusParcelId = parcelId;
        setParcelMintStatusIndicator(
            tParcel('panel.parcel.nft.checking', {}, 'Checking the anchor…'),
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
                        console.warn('Parcel anchor status check failed:', error);
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
        return triggerParcelToolsTabActivated(true);
    }

    function ensureArray(value) {
        if (value === undefined || value === null) return [];
        return Array.isArray(value) ? value : [value];
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
            // Only the contract's own "Parcel does not exist" revert proves absence. A network error,
            // timeout or unrelated revert means the check did not run — surface it as an error.
            if (!isExpectedMissing) {
                throw error;
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

        const feature = getCurrentLiveParcelFeature();
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

    function isParcelBuilderAvailable() {
        const cityId = global.CityConfigManager?.getCurrentCityId?.() || global.currentCityId;
        return String(cityId || '').toLowerCase() === 'zagreb';
    }

    function updateParcelBuilderButton() {
        const button = global.document?.getElementById('parcelBuilderButton');
        if (!button) return;
        const enabled = isParcelBuilderAvailable();
        setButtonEnabledState(button, enabled);
        button.title = enabled
            ? tParcel('panel.parcel.builderTooltip', {}, 'Open parcel builder')
            : tParcel('commandPalette.reason.hiddenForCity', {}, 'Not available in this city');
    }

    function openParcelBuilder() {
        if (!isParcelBuilderAvailable()) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(tParcel('commandPalette.reason.hiddenForCity', {}, 'Not available in this city'));
            }
            return false;
        }
        try {
            const targetUrl = buildParcelBuilderUrl();
            if (typeof global.open === 'function') {
                global.open(targetUrl, '_blank', 'noopener,noreferrer');
            }
            return true;
        } catch (error) {
            console.error('Failed to open Parcel Builder', error);
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(tParcel('status.messages.unable_to_open_parcel_builder_please_try_again', {}, 'Unable to open Parcel Builder. Please try again.'));
            }
            return false;
        }
    }

    /* Parcel mint modal: the shared dialog (js/ui/dialogs.js). Its overlay keeps the
       parcel-mint-modal-overlay id and the parcel-mint-overlay class (is-busy) as hooks. */
    const PARCEL_MINT_MODAL_ID = 'parcel-mint-modal-overlay';
    let parcelMintModalOnExit = null;
    let parcelMintDialog = null;
    let parcelMintSuccessDialog = null;

    // The receipt after a mint: the shared dialog, closed by OK (or Escape / the close button),
    // which runs onClose either way.
    function showParcelMintSuccessPopup({ parcelCount, transactions, chainId, onClose }) {
        try {
            if (parcelMintSuccessDialog) parcelMintSuccessDialog.close();
            const doc = global.document;

            const body = doc.createElement('p');
            body.textContent = parcelCount === 1
                ? tParcel('panel.parcel.anchorDialog.anchoredOne', {}, 'The parcel is anchored.')
                : tParcel('panel.parcel.anchorDialog.anchoredMany', { count: parcelCount }, `${parcelCount} anchors are minted.`);
            const content = [body];

            const isSolana = typeof chainId === 'string' && chainId.startsWith('solana');
            const txList = Array.isArray(transactions) ? transactions.filter(t => t && t.txHash) : [];
            const explorerTitle = tParcel('panel.parcel.nft.viewOnExplorer', {}, 'View on explorer');
            const explorerLink = (url, text) => {
                const link = doc.createElement('a');
                link.href = url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.className = 'cb-link cb-link--external';
                link.textContent = text;
                return link;
            };

            // Explorer links: one link for one transaction, a list for several.
            if (txList.length === 1) {
                const url = buildExplorerTxUrl({ chainId, chainSlug: chainId, txHash: txList[0].txHash });
                if (url) {
                    const row = doc.createElement('p');
                    row.appendChild(explorerLink(url, explorerTitle));
                    content.push(row);
                }
            } else if (txList.length > 1) {
                const list = doc.createElement('div');
                list.className = 'parcel-mint-success__links';
                txList.forEach((tx, idx) => {
                    const url = buildExplorerTxUrl({ chainId, chainSlug: chainId, txHash: tx.txHash });
                    if (!url) return;
                    const link = explorerLink(url, tParcel('panel.parcel.anchorDialog.transaction', { number: idx + 1 }, `Transaction ${idx + 1}`));
                    link.title = explorerTitle;
                    list.appendChild(link);
                });
                content.push(list);
            }

            const dialogApi = global.CbDialog.open({
                title: tParcel('panel.parcel.anchorDialog.successTitle', {}, 'Anchors minted'),
                size: 'sm',
                top: true,
                className: 'parcel-mint-success',
                body: content,
                actions: [{ id: 'ok', label: tParcel('modal.common.ok', {}, 'OK'), role: 'primary' }],
                onClose: () => {
                    if (parcelMintSuccessDialog === dialogApi) parcelMintSuccessDialog = null;
                    if (typeof onClose === 'function') {
                        try { onClose(); } catch (_) { }
                    }
                }
            });
            if (!dialogApi) return;
            dialogApi.overlay.id = 'parcel-mint-success-modal';
            parcelMintSuccessDialog = dialogApi;
        } catch (err) {
            console.warn('Failed to show parcel mint success popup:', err);
        }
    }

    function removeParcelMintModal(reason = 'dismiss') {
        const dialog = parcelMintDialog;
        parcelMintDialog = null;
        if (dialog) dialog.close(reason);
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
            imgEl.alt = tParcel('panel.parcel.anchorDialog.previewUnavailable', {}, 'Preview unavailable');
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
        imgEl.alt = tParcel('panel.parcel.anchorDialog.previewAlt', { id: entry.parcelId }, `Parcel ${entry.parcelId} preview`);
    }

    function buildParcelThumbnailLoader(entry, imgEl, neighbours = []) {
        if (!imgEl) return;
        const geometrySource = entry.feature?.geometry || {};
        const polygons = extractPolygonCoordinateSets(geometrySource);
        if (!polygons.length) {
            imgEl.alt = tParcel('panel.parcel.anchorDialog.previewUnavailable', {}, 'Preview unavailable');
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
        parcelMintModalOnExit = typeof onExit === 'function' ? onExit : null;

        const subtitle = global.document.createElement('p');
        subtitle.className = 'parcel-mint-subtitle';
        // The one sentence that explains an anchor, also the Tools tab button's tooltip.
        subtitle.textContent = tParcel('panel.parcel.mintTooltip', {}, 'Mint a parcel anchor: a public record of the parcel on the blockchain. Nobody owns it, and it doesn’t grant ownership.');

        const meta = global.document.createElement('div');
        meta.className = 'parcel-mint-meta';
        const displayChain = chainSlug ? `${String(chainSlug).charAt(0).toUpperCase()}${String(chainSlug).slice(1)}` : 'unknown';
        const metaList = [
            { label: tParcel('panel.parcel.anchorDialog.chain', {}, 'Chain'), value: displayChain },
            { label: tParcel('panel.parcel.anchorDialog.program', {}, 'Anchor program'), value: contractAddress || 'n/a', monospace: true, url: buildExplorerAddressUrl({ chainId, chainSlug, address: contractAddress }) },
            // The wallet pays the rent of each anchor; it does not become an owner.
            { label: tParcel('panel.parcel.anchorDialog.payer', {}, 'Paid by'), value: ownerAddress || 'n/a', monospace: true, url: buildExplorerAddressUrl({ chainId, chainSlug, address: ownerAddress }) }
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
                link.className = 'cb-link cb-link--external';
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
                neighbourMap[parcel.parcelId] = findNeighbourPolygonsFromLiveFabric(parcel.parcelId);
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
            thumb.alt = tParcel('panel.parcel.anchorDialog.previewAlt', { id: parcel.parcelId }, `Parcel ${parcel.parcelId} preview`);
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

        const status = global.document.createElement('div');
        status.className = 'parcel-mint-status';
        status.setAttribute('role', 'status');

        // The dialog has no automatic dismissals: while a mint transaction is in flight (is-busy)
        // neither the close button, the backdrop nor Escape may close it, so it owns all three.
        const dialogApi = global.CbDialog.open({
            title: tParcel('panel.parcel.anchorDialog.title', {}, 'Mint parcel anchors'),
            size: 'md',
            top: true,
            className: 'parcel-mint-modal',
            overlayClassName: 'parcel-mint-overlay',
            bodyClassName: 'parcel-mint-body',
            showClose: false,
            closeOnBackdrop: false,
            closeOnEscape: false,
            body: [subtitle, meta, list, status],
            actions: [{ id: 'mint', label: tParcel('panel.parcel.mintAndClaimButton', {}, 'Mint anchor'), role: 'primary', keepOpen: true, onClick: () => mint() }]
        });
        if (!dialogApi) return;
        parcelMintDialog = dialogApi;
        const overlay = dialogApi.overlay;
        overlay.id = PARCEL_MINT_MODAL_ID;
        const isBusy = () => overlay.classList.contains('is-busy');
        const closeBtn = global.document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close-circle-btn parcel-mint-close';
        closeBtn.setAttribute('aria-label', tParcel('modal.common.close', {}, 'Close'));
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
            if (!isBusy()) removeParcelMintModal('close');
        });
        dialogApi.header.appendChild(closeBtn);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay && !isBusy()) removeParcelMintModal('overlay');
        });
        const unregisterEscape = global.ModalEscape && typeof global.ModalEscape.register === 'function'
            ? global.ModalEscape.register(overlay, () => { if (!isBusy()) removeParcelMintModal('escape'); })
            : null;
        dialogApi.closed.then(() => { if (unregisterEscape) unregisterEscape(); });
        const mintBtn = dialogApi.getActionButton('mint');

        const setBusy = (busy, message) => {
            mintBtn.disabled = busy;
            overlay.classList.toggle('is-busy', Boolean(busy));
            status.textContent = message || '';
        };

        const mint = async () => {
            const selected = parcelCheckboxes
                .filter(entry => entry.checkbox.checked)
                .map(entry => entry.parcel);
            if (!selected.length) {
                status.textContent = tParcel('panel.parcel.anchorDialog.selectOne', {}, 'Select at least one parcel to anchor.');
                return;
            }
            try {
                setBusy(true, tParcel('panel.parcel.anchorDialog.preparing', {}, 'Preparing the transactions…'));
                const result = await onConfirm({ parcels: selected, setBusy, statusEl: status });
                const mintedIds = Array.isArray(result?.mintedParcelIds)
                    ? result.mintedParcelIds.filter(Boolean)
                    : selected.map(entry => entry.parcel?.parcelId || entry.parcelId).filter(Boolean);
                const mintedLayerApi = global.ParcelsMintedLayer || null;
                if (mintedLayerApi && mintedIds.length) {
                    mintedLayerApi.addMintedParcels(mintedIds);
                }
                const mintedAll = mintedIds.length >= parcels.length;
                // An id longer than an anchor seed allows is reported, not anchored.
                const skippedIds = (result?.skipped || []).map(entry => entry.parcelId);
                if (mintedAll && !skippedIds.length) {
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
                if (skippedIds.length) {
                    status.textContent = tParcel('panel.parcel.anchorDialog.skipped', { parcels: skippedIds.join(', ') }, `Not anchored, because the parcel id is longer than an anchor allows: ${skippedIds.join(', ')}`);
                } else if (!hasStatusContent) {
                    status.textContent = result?.statusMessage || tParcel('panel.parcel.anchorDialog.partial', {}, 'Some anchors are minted. You can anchor the remaining ones.');
                }
            } catch (error) {
                console.error('Parcel mint failed', error);
                setBusy(false, error?.message || tParcel('panel.parcel.anchorDialog.failed', {}, 'Minting failed. Please try again.'));
            }
        };
    }

    function collectCurrentParcelForMint() {
        const parcelFeature = getCurrentLiveParcelFeature();
        if (!parcelFeature) return [];
        const parcelId = deriveParcelIdentifier(parcelFeature);
        if (!parcelId) return [];
        const parcelName = (parcelFeature.properties && parcelFeature.properties.name)
            || (parcelFeature.properties && parcelFeature.properties.parcel_name)
            || `Parcel ${parcelId}`;
        return [{ parcelId, parcelName, feature: parcelFeature }];
    }

    // Bounding boxes of immutable feature snapshots returned by the committed fabric.
    const featureBoundingBoxCache = new WeakMap();

    function featureBoundingBox(geometry) {
        if (!geometry || !geometry.coordinates) return null;
        const cached = featureBoundingBoxCache.get(geometry);
        if (cached !== undefined) return cached;

        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        const visit = (coords) => {
            if (!Array.isArray(coords)) return;
            if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                if (coords[0] < minLng) minLng = coords[0];
                if (coords[0] > maxLng) maxLng = coords[0];
                if (coords[1] < minLat) minLat = coords[1];
                if (coords[1] > maxLat) maxLat = coords[1];
                return;
            }
            coords.forEach(visit);
        };
        visit(geometry.coordinates);

        const box = Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null;
        featureBoundingBoxCache.set(geometry, box);
        return box;
    }

    // Touching counts: neighbours share an edge, so boxes that merely abut must pass.
    function boundingBoxesTouch(a, b) {
        if (!a || !b) return false;
        const EPSILON = 1e-9;
        return a[0] <= b[2] + EPSILON && b[0] <= a[2] + EPSILON
            && a[1] <= b[3] + EPSILON && b[1] <= a[3] + EPSILON;
    }

    function findNeighbourPolygonsFromLiveFabric(parcelId) {
        if (!parcelId) return [];
        try {
            const fabric = global.LiveParcelFabric;
            if (!fabric || typeof fabric.get !== 'function' || typeof fabric.queryBounds !== 'function') return [];
            const targetId = parcelId.toString();
            const targetFeature = fabric.get(targetId);
            if (!targetFeature || !targetFeature.geometry) return [];

            // Use turf to find touching/intersecting parcels from loaded cache
            const hasTurf = global.turf && typeof global.turf.booleanIntersects === 'function';
            if (!hasTurf) return [];

            const neighbours = [];
            const seen = new Set();
            seen.add(targetId);

            // booleanIntersects is a full polygon-vs-polygon test, and the cache holds every parcel
            // loaded so far — thousands of them. Reject the ones whose bounding boxes cannot touch
            // before paying for it: a parcel a kilometre away is four number comparisons, not a
            // segment-intersection sweep. (Without this, one selected parcel cost ~1.4 s.)
            const targetBox = featureBoundingBox(targetFeature.geometry);
            if (!targetBox) return [];

            const candidates = fabric.queryBounds(targetBox, { includeCorridors: false });
            for (const feature of candidates) {
                    const id = fabric.featureId?.(feature);
                    if (!feature || !feature.geometry) continue;
                    const fId = String(id || '');
                    if (!fId || seen.has(fId)) continue;
                    seen.add(fId);
                    if (!boundingBoxesTouch(targetBox, featureBoundingBox(feature.geometry))) continue;
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
            return neighbours;
        } catch (error) {
            console.warn('Failed to find neighbours from cache', error);
            return [];
        }
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
        // The same URI as a Solana anchor: the parcel's page on the public site (ParcelAnchor.anchorUri).
        const metadataUris = parcelIds.map(parcelId => (global.ParcelAnchor || require('../parcel-anchor.js')).anchorUri(parcelId));
        if (statusEl) statusEl.textContent = tParcel('panel.parcel.anchorDialog.submitting', {}, 'Submitting the transaction…');
        const tx = await contract.mintBatch(ownerAddress, parcelIds, metadataUris);
        if (statusEl) statusEl.textContent = tParcel('panel.parcel.anchorDialog.confirming', { chain: chainSlug || 'chain' }, `Waiting for confirmation on ${chainSlug || 'chain'}…`);
        const receipt = typeof tx.wait === 'function' ? await tx.wait() : null;
        return { txHash: tx.hash, receipt };
    }

    async function openParcelMintModal(options = {}) {
        try {
            const providedParcels = Array.isArray(options.parcels) ? options.parcels.filter(Boolean) : null;
            const isMultiActive = !providedParcels && global.multiParcelSelection && (global.multiParcelSelection.isActive || global.multiParcelSelection.selectedParcels?.size > 0);
            const parcels = providedParcels && providedParcels.length
                ? providedParcels
                : (isMultiActive ? collectMultiSelectedParcelsForMint() : collectCurrentParcelForMint());
            if (!parcels.length) {
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus(tParcel('panel.parcel.anchorDialog.selectFirst', {}, 'Select a parcel before anchoring it.'));
                }
                return;
            }

            const solanaWalletManager = global.solanaWalletManager;
            const solanaState = solanaWalletManager && typeof solanaWalletManager.getState === 'function' ? solanaWalletManager.getState() : null;
            const isSolanaConnected = solanaState && solanaState.status === 'connected' && Array.isArray(solanaState.accounts) && solanaState.accounts.length > 0;

            if (isSolanaConnected && global.SolanaParcelAnchors) {
                const cluster = solanaState.cluster || 'devnet';
                const contractAddress = await resolveParcelNftAddressSolana(cluster);
                if (!contractAddress) {
                    throw new Error(tParcel('panel.parcel.anchorDialog.noProgram', {}, 'The parcel anchor program is not configured for this chain.'));
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
                    // Anchors already on chain cost nothing; the rest go several to a transaction, signed
                    // with one wallet approval where the wallet can (solana/parcel-mint.js).
                    onConfirm: async ({ parcels: selectedParcels, setBusy, statusEl }) => {
                        const progress = ({ done, total }) => {
                            if (statusEl) statusEl.textContent = tParcel('panel.parcel.anchorDialog.progress', { done, total }, `Minting anchors: ${done} of ${total}…`);
                        };
                        try {
                            const result = await global.SolanaParcelAnchors.anchorParcels(selectedParcels.map(p => p.parcelId), { programId: contractAddress, cluster, onProgress: progress });
                            setBusy(false);
                            return { mintedParcelIds: result.anchoredParcelIds, transactions: result.transactions, chainId: `solana-${cluster}`, skipped: result.skipped };
                        } catch (err) {
                            console.error(`[${new Date().toISOString()}] Solana parcel anchoring failed`, err);
                            setBusy(false, err?.message || tParcel('panel.parcel.anchorDialog.failed', {}, 'Minting failed. Please try again.'));
                            return { mintedParcelIds: err?.anchoredParcelIds || [], statusMessage: err?.message };
                        }
                    }
                });
                return;
            }

            const walletManager = global.walletManager;
            const walletProvider = walletManager && typeof walletManager.getProvider === 'function' ? walletManager.getProvider() : null;
            if (!walletProvider) {
                throw new Error(tParcel('panel.parcel.anchorDialog.connectWallet', {}, 'Connect a wallet to anchor parcels.'));
            }
            await global.ensureWalletVendors?.('evm');
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
                throw new Error(tParcel('panel.parcel.anchorDialog.noProgram', {}, 'The parcel anchor program is not configured for this chain.'));
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
                        tParcel('panel.parcel.anchorDialog.someAnchored', {}, 'Some of the selected parcels are already anchored. Deselect them to continue.'),
                        'error',
                        chainSlug
                    );
                    const mintButton = global.document ? global.document.getElementById('mintAndClaimButton') : null;
                    if (mintButton) {
                        mintButton.disabled = false; // keep enabled per requirement; checks happen on press
                    }
                    return;
                }

                setParcelMintStatusIndicator(tParcel('panel.parcel.nft.multiReady', {}, 'Ready to mint anchors for the selected parcels.'), 'not-minted', chainSlug);
            }

            await buildParcelMintModal({
                parcels,
                chainSlug,
                chainId,
                contractAddress,
                ownerAddress,
                onExit: typeof options.onExit === 'function' ? options.onExit : null,
                onConfirm: async ({ parcels: selectedParcels, setBusy, statusEl }) => {
                    const result = await executeParcelBatchMint({ parcels: selectedParcels, signer, ownerAddress, contractAddress, chainSlug, statusEl });
                    const mintedParcelIds = selectedParcels.map(p => p.parcelId).filter(Boolean);
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
                global.updateStatus(error?.message || tParcel('panel.parcel.anchorDialog.failed', {}, 'Minting failed. Please try again.'));
            }
        }
    }

    const deriveParcelIdentifier = global.Parcels?.blockchain?.deriveParcelIdentifier || global.deriveParcelIdentifier;
    const resolveParcelClaimContext = global.Parcels?.blockchain?.resolveParcelClaimContext || global.resolveParcelClaimContext;
    const isParcelTokenMissingError = global.Parcels?.blockchain?.isParcelTokenMissingError || global.isParcelTokenMissingError || (() => false);
    const resolveChainSlug = global.Parcels?.blockchain?.resolveChainSlug || global.resolveChainSlug;
    const normalizeChainIdValue = global.Parcels?.blockchain?.normalizeChainIdValue || global.normalizeChainIdValue;
    const resolveParcelNftAddress = global.Parcels?.blockchain?.resolveParcelNftAddress || global.resolveParcelNftAddress;

    // index.html's Tools-tab buttons translate their text through data-i18n-key, but their tooltips
    // are plain title attributes; set those here, and re-render the status line (its text is set from
    // JS without a data-i18n-key) whenever the language changes.
    function localizeToolsTab() {
        const doc = global.document;
        if (!doc) return;
        const titles = [
            ['mintAndClaimButton', 'panel.parcel.mintTooltip', 'Mint a parcel anchor: a public record of the parcel on the blockchain. Nobody owns it, and it doesn’t grant ownership.']
        ];
        titles.forEach(([id, key, fallback]) => {
            const el = doc.getElementById(id);
            if (el) el.title = tParcel(key, {}, fallback);
        });
        updateParcelBuilderButton();
    }

    function handleToolsTabLanguageChange() {
        localizeToolsTab();
        const toolsTab = global.document ? global.document.getElementById('tools-tab') : null;
        if (toolsTab && !toolsTab.hidden) {
            triggerParcelToolsTabActivated(false);
        } else if (!currentParcelMintStatusCache && !currentParcelMintStatusPromise) {
            resetParcelMintStatusState();
        }
    }

    if (global.i18n && typeof global.i18n.onChange === 'function') {
        global.i18n.onChange(handleToolsTabLanguageChange);
    }
    if (typeof global.addEventListener === 'function') {
        global.addEventListener('i18n:translationsLoaded', handleToolsTabLanguageChange);
        global.addEventListener('cityChanged', localizeToolsTab);
    }
    if (global.document && typeof global.document.addEventListener === 'function') {
        if (global.document.readyState === 'loading') {
            global.document.addEventListener('DOMContentLoaded', localizeToolsTab);
        } else {
            localizeToolsTab();
        }
    }

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
        openParcelBuilder,
        isParcelBuilderAvailable,
        buildParcelBuilderUrl,
        openParcelMintModal,
        toStringSafe,
        fetchParcelTokenId
    };

    global.openParcelBuilder = openParcelBuilder;
    global.openParcelMintModal = openParcelMintModal;
    global.setParcelMintStatusIndicator = setParcelMintStatusIndicator;
    global.resetParcelMintStatusState = resetParcelMintStatusState;
    global.applyParcelMintStatusResult = applyParcelMintStatusResult;
    global.triggerParcelToolsTabActivated = triggerParcelToolsTabActivated;
    global.recheckParcelMintStatus = recheckParcelMintStatus;
    global.findNeighbourPolygonsFromLiveFabric = findNeighbourPolygonsFromLiveFabric;
})(typeof window !== 'undefined' ? window : globalThis);
