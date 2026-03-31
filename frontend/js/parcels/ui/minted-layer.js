(function (global) {
    'use strict';

    const state = {
        layer: null,
        markers: new Map(),
        mintedIds: new Set(),
        pending: new Set(),
        visible: false,
        paneName: 'minted-parcels-pane',
        icon: null,
        fetchInProgress: false,
        totalMinted: null
    };

    const getCache = () => (global.ParcelsState && typeof global.ParcelsState.getParcelCache === 'function')
        ? global.ParcelsState.getParcelCache()
        : global.parcelCache;

    function normalizeParcelId(parcelId) {
        if (parcelId === undefined || parcelId === null) return null;
        const str = parcelId.toString().trim();
        return str ? str : null;
    }

    function ensurePane() {
        const map = global.map;
        if (!map || typeof map.getPane !== 'function') return null;
        let pane = map.getPane(state.paneName);
        if (!pane && typeof map.createPane === 'function') {
            pane = map.createPane(state.paneName);
            if (pane && pane.style) {
                pane.style.zIndex = '650';
                pane.style.pointerEvents = 'none';
            }
        }
        return state.paneName;
    }

    function buildIcon() {
        if (state.icon || typeof L === 'undefined') return state.icon;
        state.icon = L.divIcon({
            className: 'minted-parcel-icon',
            html: '<i class="fas fa-sun"></i>',
            iconSize: [22, 22],
            iconAnchor: [11, 11]
        });
        return state.icon;
    }

    function ensureLayer() {
        if (state.layer || typeof L === 'undefined') return state.layer;
        state.layer = L.layerGroup();
        return state.layer;
    }

    function getCachedFeature(parcelId) {
        const cache = getCache();
        if (cache && cache.byId instanceof Map) {
            const feature = cache.byId.get(parcelId);
            if (feature) return feature;
        }
        return null;
    }

    function resolveParcelLayer(parcelId) {
        if (typeof global.resolveParcelLayerById === 'function') {
            return global.resolveParcelLayerById(parcelId);
        }
        return null;
    }

    function computeLatLng(feature, layer) {
        if (layer && typeof layer.getBounds === 'function') {
            try {
                const bounds = layer.getBounds();
                if (bounds && typeof bounds.getCenter === 'function') {
                    return bounds.getCenter();
                }
            } catch (_) { /* ignore */ }
        }

        if (feature && feature.geometry) {
            if (global.turf && typeof global.turf.centerOfMass === 'function') {
                try {
                    const center = global.turf.centerOfMass(feature);
                    const coords = center?.geometry?.coordinates;
                    if (Array.isArray(coords) && coords.length >= 2) {
                        const [lng, lat] = coords;
                        if (Number.isFinite(lat) && Number.isFinite(lng)) {
                            return L.latLng(lat, lng);
                        }
                    }
                } catch (_) { /* ignore */ }
            }

            try {
                const tempLayer = L.geoJSON(feature);
                const bounds = tempLayer && typeof tempLayer.getBounds === 'function'
                    ? tempLayer.getBounds()
                    : null;
                if (bounds && typeof bounds.getCenter === 'function') {
                    return bounds.getCenter();
                }
            } catch (_) { /* ignore */ }
        }

        return null;
    }

    function ensureLayerOnMap() {
        const layer = ensureLayer();
        const map = global.map;
        if (!map || !layer) return;
        if (state.visible) {
            if (!map.hasLayer(layer)) {
                layer.addTo(map);
            }
        } else if (map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    }

    function upsertMarker(parcelId, options = {}) {
        const normalizedId = normalizeParcelId(parcelId);
        if (!normalizedId || typeof L === 'undefined') return;

        state.mintedIds.add(normalizedId);

        const layer = options.layer || resolveParcelLayer(normalizedId);
        const featureHint = options.feature || (layer && layer.feature) || getCachedFeature(normalizedId);
        const latLng = computeLatLng(featureHint, layer);

        if (!latLng) {
            state.pending.add(normalizedId);
            return;
        }

        state.pending.delete(normalizedId);

        let marker = state.markers.get(normalizedId);
        if (marker) {
            marker.setLatLng(latLng);
        } else {
            const icon = buildIcon();
            if (!icon) return;
            marker = L.marker(latLng, {
                icon,
                interactive: false,
                pane: ensurePane()
            });
            ensureLayer()?.addLayer(marker);
            state.markers.set(normalizedId, marker);
        }

        if (state.visible) {
            ensureLayerOnMap();
        }
    }

    function removeMintedParcel(parcelId) {
        const normalizedId = normalizeParcelId(parcelId);
        if (!normalizedId) return;

        state.mintedIds.delete(normalizedId);
        state.pending.delete(normalizedId);

        const marker = state.markers.get(normalizedId);
        if (marker && state.layer) {
            state.layer.removeLayer(marker);
        }
        state.markers.delete(normalizedId);
    }

    function refreshMarkers() {
        if (!state.mintedIds.size) return;
        state.mintedIds.forEach(id => upsertMarker(id));
    }

    function setVisibility(visible) {
        state.visible = !!visible;
        if (state.visible) {
            refreshMarkers();
        }
        ensureLayerOnMap();
        syncCheckbox();
    }

    function syncCheckbox() {
        const checkbox = global.document ? global.document.getElementById('markMintedCheckbox') : null;
        if (!checkbox) return;

        if (checkbox.checked !== state.visible) {
            checkbox.checked = state.visible;
        }

        // Update label with count if available
        const label = checkbox.parentElement?.querySelector('[data-i18n-key="sidebar.parcels.markMinted"]');
        if (label) {
            const baseText = label.getAttribute('data-base-text') || label.textContent.replace(/\s*\(\d+\)$/, '');
            label.setAttribute('data-base-text', baseText);

            if (state.totalMinted !== null && state.totalMinted > 0) {
                label.textContent = `${baseText} (${state.totalMinted})`;
            } else {
                label.textContent = baseText;
            }
        }
    }

    async function fetchAndMarkMintedParcels() {
        if (state.fetchInProgress) {
            console.log('Fetch already in progress, skipping');
            return;
        }

        state.fetchInProgress = true;

        try {
            // Get parcel claim context
            if (typeof global.resolveParcelClaimContext !== 'function') {
                throw new Error('resolveParcelClaimContext not available');
            }

            const context = await global.resolveParcelClaimContext();
            if (!context || !context.contractAddress || !context.chainId) {
                throw new Error('Could not resolve parcel contract context');
            }

            // Solana path
            if (context.chainType === 'solana' && global.SolanaChainDataLoader && typeof global.SolanaChainDataLoader.getAllMintedParcelIds === 'function') {
                const cluster = (context.chainSlug || '').replace('solana-', '') || 'devnet';
                const parcelIds = await global.SolanaChainDataLoader.getAllMintedParcelIds(cluster, context.contractAddress);
                state.totalMinted = parcelIds.length;
                syncCheckbox();
                parcelIds.forEach(parcelId => {
                    if (parcelId) {
                        upsertMarker(parcelId);
                    }
                });
                console.log(`Successfully loaded ${parcelIds.length} minted parcels from Solana`);
                return;
            }

            // EVM path
            // First, get and display the total count
            if (global.ChainDataLoader && typeof global.ChainDataLoader.getTotalMintedParcels === 'function') {
                try {
                    const total = await global.ChainDataLoader.getTotalMintedParcels(
                        context.chainId,
                        context.contractAddress
                    );
                    state.totalMinted = total;
                    syncCheckbox();
                } catch (error) {
                    console.warn('Failed to fetch total minted parcels:', error);
                }
            }

            // Then fetch all minted parcel IDs in the background
            if (global.ChainDataLoader && typeof global.ChainDataLoader.getAllMintedParcelIds === 'function') {
                const parcelIds = await global.ChainDataLoader.getAllMintedParcelIds(
                    context.chainId,
                    context.contractAddress,
                    {
                        batchSize: 20,
                        onProgress: (current, total) => {
                            console.log(`Loaded ${current}/${total} minted parcels`);
                        }
                    }
                );

                // Mark all fetched parcels as minted
                parcelIds.forEach(parcelId => {
                    if (parcelId) {
                        upsertMarker(parcelId);
                    }
                });

                console.log(`Successfully loaded ${parcelIds.length} minted parcels`);
            }
        } catch (error) {
            console.error('Error fetching minted parcels:', error);
            const errorMessage = error?.message || String(error);
            if (global.showToast && typeof global.showToast === 'function') {
                global.showToast(`Failed to load minted parcels: ${errorMessage}`, 'error');
            }
        } finally {
            state.fetchInProgress = false;
        }
    }

    function handleCheckboxBinding() {
        if (!global.document) return;
        const checkbox = global.document.getElementById('markMintedCheckbox');
        if (!checkbox || checkbox.dataset.mintedBound === '1') return;
        checkbox.dataset.mintedBound = '1';
        checkbox.addEventListener('change', async () => {
            const isChecked = checkbox.checked;
            setVisibility(isChecked);

            // When checkbox is turned on, fetch all minted parcels from blockchain
            if (isChecked) {
                await fetchAndMarkMintedParcels();
            }
        });
    }

    function handleParcelDataLoaded(event) {
        if (!state.mintedIds.size) return;
        const eventIds = event && event.detail && Array.isArray(event.detail.parcelIds)
            ? event.detail.parcelIds.map(id => id && id.toString()).filter(Boolean)
            : null;
        const toRefresh = eventIds && eventIds.length
            ? eventIds.filter(id => state.mintedIds.has(id) || state.pending.has(id))
            : Array.from(state.pending);
        if (!toRefresh.length) return;
        toRefresh.forEach(id => upsertMarker(id));
        if (state.visible) {
            ensureLayerOnMap();
        }
    }

    function addMintedParcels(ids, options = {}) {
        if (!ids) return;
        const arr = Array.isArray(ids) ? ids : [ids];
        arr.forEach(id => upsertMarker(id, options));
        if (state.visible) {
            ensureLayerOnMap();
        }
    }

    if (global && typeof global.addEventListener === 'function') {
        global.addEventListener('parcelDataLoaded', handleParcelDataLoaded);
    }

    if (global && global.document && typeof global.document.addEventListener === 'function') {
        global.document.addEventListener('DOMContentLoaded', () => {
            handleCheckboxBinding();
            const checkbox = global.document.getElementById('markMintedCheckbox');
            if (checkbox && checkbox.checked) {
                setVisibility(true);
            }
        });
    }

    global.ParcelsMintedLayer = {
        addMintedParcels,
        markMinted: addMintedParcels,
        removeMintedParcel,
        markUnminted: removeMintedParcel,
        refreshMarkers,
        setVisibility,
        toggleVisibility: setVisibility,
        syncCheckbox: syncCheckbox,
        fetchAndMarkMintedParcels: fetchAndMarkMintedParcels,
        getTotalMinted: () => state.totalMinted,
        getMintedCount: () => state.mintedIds.size
    };
})(typeof window !== 'undefined' ? window : globalThis);
