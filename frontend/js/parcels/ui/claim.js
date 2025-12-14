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

    function getParcelExplorerBaseUrl(chainId, chainSlug) {
        const normalizedId = chainId !== undefined && chainId !== null ? chainId.toString() : '';
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
        if (chainSlug) {
            const slug = chainSlug.toString().toLowerCase();
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
        const encodedAddress = encodeURIComponent(address);
        const encodedToken = encodeURIComponent(tokenValue);
        return `${base}/nft/${encodedAddress}/${encodedToken}`;
    }

    function setButtonEnabledState(button, enabled) {
        if (!button) return;
        button.disabled = !enabled;
        button.classList.toggle('disabled', !enabled);
    }

    function setParcelClaimButtonsState(state = 'neutral') {
        const normalized = normalizeMintStatusState(state);
        const mintAndClaimButton = global.document ? global.document.getElementById('mintAndClaimButton') : null;
        const claimButton = global.document ? global.document.getElementById('claimButton') : null;

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

    function setParcelMintStatusIndicator(message, state = 'neutral', chainSlug = null) {
        const indicator = getParcelMintStatusElement();
        if (!indicator) return;

        indicator.removeAttribute('data-i18n-key');
        indicator.removeAttribute('data-i18n-attr');
        indicator.removeAttribute('data-i18n-params');

        const cachedChain = chainSlug || currentParcelMintStatusCache?.result?.chainSlug || null;
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

        if (result.minted) {
            const chainText = result.chainSlug
                ? tParcel('panel.parcel.nft.chainSuffix', { chain: result.chainSlug }, ` (${result.chainSlug})`)
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
        } else {
            setParcelMintStatusIndicator(
                null,
                'not-minted',
                result.chainSlug
            );
        }
    }

    async function fetchParcelMintStatus(parcelId) {
        const claimContext = await resolveParcelClaimContext();
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
            if (!isParcelTokenMissingError(error)) {
                console.warn('Unable to fetch parcel token ID, assuming parcel is not minted.', {
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

        const props = (global.currentParcel && global.currentParcel.layer && global.currentParcel.layer.feature)
            ? (global.currentParcel.layer.feature.properties || {})
            : {};

        const parcelNumber = props.BROJ_CESTICE || props.parcel_number || null;
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
            if (parcelId) {
                params.set('parcel', parcelId);
            } else if (parcelNumber) {
                params.set('parcel', parcelNumber);
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

    const deriveParcelIdentifier = global.Parcels?.blockchain?.deriveParcelIdentifier || global.deriveParcelIdentifier;
    const resolveParcelClaimContext = global.Parcels?.blockchain?.resolveParcelClaimContext || global.resolveParcelClaimContext;
    const buildClaimUrl = global.Parcels?.blockchain?.buildClaimUrl || global.buildClaimUrl;
    const isParcelTokenMissingError = global.Parcels?.blockchain?.isParcelTokenMissingError || global.isParcelTokenMissingError || (() => false);
    const resolveChainSlug = global.Parcels?.blockchain?.resolveChainSlug || global.resolveChainSlug;
    const normalizeChainIdValue = global.Parcels?.blockchain?.normalizeChainIdValue || global.normalizeChainIdValue;
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
        toStringSafe,
        fetchParcelTokenId
    };

    global.openParcelBuilder = openParcelBuilder;
    global.openClaimOnly = openClaimOnly;
    global.openClaimPortal = openClaimPortal;
    global.setParcelMintStatusIndicator = setParcelMintStatusIndicator;
    global.resetParcelMintStatusState = resetParcelMintStatusState;
    global.applyParcelMintStatusResult = applyParcelMintStatusResult;
    global.triggerParcelToolsTabActivated = triggerParcelToolsTabActivated;
    global.recheckParcelMintStatus = recheckParcelMintStatus;
})(typeof window !== 'undefined' ? window : globalThis);

