(function (global) {
    'use strict';

    const adParcelIdSet = (global.adParcelIdSet instanceof Set) ? global.adParcelIdSet : new Set();
    global.adParcelIdSet = adParcelIdSet;
    const adParcelLinkMap = (global.adParcelLinkMap instanceof Map) ? global.adParcelLinkMap : new Map();
    global.adParcelLinkMap = adParcelLinkMap;

    const state = {
        adParcelLayer: null,
        adParcelFeatures: [],
        isLoading: false,
        showAdParcels: Boolean(global.showAdParcels)
    };

    const DEFAULT_MIN_DATE = '1900-01-01';
    const AD_PANE_NAME = 'adParcelsPane';

    function format(template, params = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    }

    function t(key, fallback, params = {}) {
        const api = (typeof global !== 'undefined') ? global.i18n : null;
        if (api && typeof api.t === 'function') {
            return api.t(key, params);
        }
        return format(fallback, params);
    }

    function setStatus(key, fallback, params) {
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(t(key, fallback, params));
        }
    }

    function resolveCountryPrefix() {
        const manager = global.CityConfigManager;
        const cityId = manager && typeof manager.getCurrentCityId === 'function'
            ? manager.getCurrentCityId()
            : null;
        if (cityId === 'buenos_aires') return 'AR';
        if (cityId === 'belgrade') return 'SR';
        return 'HR';
    }

    function buildPrefixedParcelId(parcel) {
        const prefix = resolveCountryPrefix();
        const cadMun = parcel?.maticni_broj_ko ?? parcel?.MATICNI_BROJ_KO;
        const parcelNumber = parcel?.broj_cestice ?? parcel?.BROJ_CESTICE;
        const cesticaId = parcel?.cestica_id ?? parcel?.CESTICA_ID;
        if (cadMun && parcelNumber) {
            return `${prefix}-${cadMun}-${parcelNumber}`;
        }
        if (cesticaId !== undefined && cesticaId !== null) {
            return `${prefix}-${cesticaId}`;
        }
        return null;
    }

    function resolveCitywideBbox() {
        const manager = global.CityConfigManager;
        const cityConfig = manager && typeof manager.getCurrentCityConfig === 'function'
            ? manager.getCurrentCityConfig()
            : null;
        const datasetBounds = cityConfig?.projection?.datasetBounds;
        const hasDatasetBounds = datasetBounds
            && Number.isFinite(datasetBounds.minX)
            && Number.isFinite(datasetBounds.minY)
            && Number.isFinite(datasetBounds.maxX)
            && Number.isFinite(datasetBounds.maxY);
        if (hasDatasetBounds) {
            return `${datasetBounds.minX},${datasetBounds.minY},${datasetBounds.maxX},${datasetBounds.maxY}`;
        }

        const toDataset = manager && typeof manager.latLngToDataset === 'function'
            ? manager.latLngToDataset
            : (typeof global.wgs84ToHTRS96 === 'function' ? global.wgs84ToHTRS96 : null);

        const initialBounds = (() => {
            if (!cityConfig?.map?.initialView) return null;
            const view = cityConfig.map.initialView;
            if (view.type === 'bounds' && Array.isArray(view.value) && view.value.length === 2) {
                const sw = view.value[0];
                const ne = view.value[1];
                if (Array.isArray(sw) && Array.isArray(ne)) {
                    return { sw: { lat: sw[0], lng: sw[1] }, ne: { lat: ne[0], lng: ne[1] } };
                }
            }
            return null;
        })();

        const boundsSource = initialBounds || (() => {
            try {
                if (global.map && typeof global.map.getBounds === 'function') {
                    const b = global.map.getBounds();
                    const sw = b.getSouthWest();
                    const ne = b.getNorthEast();
                    return { sw: { lat: sw.lat, lng: sw.lng }, ne: { lat: ne.lat, lng: ne.lng } };
                }
            } catch (_) { /* ignore */ }
            return null;
        })();

        if (!boundsSource || !toDataset) {
            return null;
        }

        const swDataset = toDataset(boundsSource.sw.lat, boundsSource.sw.lng);
        const neDataset = toDataset(boundsSource.ne.lat, boundsSource.ne.lng);
        if (!Array.isArray(swDataset) || !Array.isArray(neDataset)) {
            return null;
        }
        const minX = Math.min(swDataset[0], neDataset[0]);
        const maxX = Math.max(swDataset[0], neDataset[0]);
        const minY = Math.min(swDataset[1], neDataset[1]);
        const maxY = Math.max(swDataset[1], neDataset[1]);
        return `${minX},${minY},${maxX},${maxY}`;
    }

    function ensureAdPane() {
        if (!global.map || typeof global.map.getPane !== 'function' || typeof global.map.createPane !== 'function') {
            return null;
        }
        const existing = global.map.getPane(AD_PANE_NAME);
        if (existing) return AD_PANE_NAME;
        const pane = global.map.createPane(AD_PANE_NAME);
        pane.style.zIndex = '425';
        pane.style.pointerEvents = 'none';
        return AD_PANE_NAME;
    }

    function getBackendBase() {
        if (typeof global.getBackendBase === 'function') {
            return global.getBackendBase().replace(/\/$/, '');
        }
        return '';
    }

    function getAdOverlayStyle() {
        if (global.adParcelStyle) {
            return { ...global.adParcelStyle };
        }
        return {
            fillColor: '#b5f7b2',
            fillOpacity: 0.45,
            color: '#2e7d32',
            weight: 2,
            opacity: 1
        };
    }

    function clearAdOverlay() {
        if (state.adParcelLayer && global.map && global.map.hasLayer(state.adParcelLayer)) {
            global.map.removeLayer(state.adParcelLayer);
        }
        state.adParcelLayer = null;
    }

    function rebuildAdOverlay() {
        clearAdOverlay();
        if (!state.showAdParcels || !state.adParcelFeatures.length || !global.L) {
            return;
        }
        const converted = typeof global.convertGeoJSON === 'function'
            ? global.convertGeoJSON({ type: 'FeatureCollection', features: state.adParcelFeatures })
            : { type: 'FeatureCollection', features: state.adParcelFeatures };
        const paneName = ensureAdPane();
        state.adParcelLayer = global.L.geoJSON(converted, {
            pane: paneName || undefined,
            style: getAdOverlayStyle,
            interactive: false
        });
        if (global.map) {
            state.adParcelLayer.addTo(global.map);
        }
    }

    function applyAdStylesToParcelLayer(force = false) {
        if (!force && !state.showAdParcels) {
            return;
        }
        if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
            global.refreshParcelStylesForAppliedProposals();
            return;
        }
        if (!global.parcelLayer || typeof global.parcelLayer.eachLayer !== 'function') {
            return;
        }
        global.parcelLayer.eachLayer(layer => {
            const parcelId = layer?.feature?.properties?.CESTICA_ID;
            const idStr = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
            if (!idStr) return;
            if (state.showAdParcels && adParcelIdSet.has(idStr)) {
                layer.setStyle(getAdOverlayStyle());
            } else if (typeof global.getParcelBaseStyle === 'function') {
                layer.setStyle(global.getParcelBaseStyle(idStr));
            }
        });
    }

    async function fetchAdParcels() {
        if (state.isLoading) return;
        const base = getBackendBase();
        const bbox = resolveCitywideBbox();
        if (!base || !bbox) {
            setStatus('sidebar.parcels.adsError', 'Unable to load ad parcels.');
            return;
        }

        const params = new URLSearchParams({
            bbox,
            min_date: DEFAULT_MIN_DATE
        });
        const url = `${base}/ads?${params.toString()}`;

        state.isLoading = true;
        setStatus('sidebar.parcels.adsLoading', 'Loading ad parcels...');
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch ads (${response.status})`);
            }
            const payload = await response.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];

            adParcelIdSet.clear();
            adParcelLinkMap.clear();
            const features = [];
            items.forEach(item => {
                const parcel = item?.parcel || {};
                const geometry = parcel.geometry;
                const parcelId = parcel.cestica_id ?? parcel.CESTICA_ID;
                if (!geometry || parcelId === undefined || parcelId === null) {
                    return;
                }
                const idStr = parcelId.toString();
                adParcelIdSet.add(idStr);
                const adLink = item?.ad?.url || item?.adParcel?.ad_url || null;
                if (adLink) {
                    adParcelLinkMap.set(idStr, adLink);
                }
                const prefixedId = buildPrefixedParcelId(parcel);
                const properties = Object.assign({}, parcel, {
                    adParcelId: idStr,
                    prefixedParcelId: prefixedId,
                    ad: item?.ad || null,
                    adParcel: item?.adParcel || null
                });
                features.push({
                    type: 'Feature',
                    properties,
                    geometry
                });
            });

            if (!state.showAdParcels) {
                return;
            }
            state.adParcelFeatures = features;
            rebuildAdOverlay();
            applyAdStylesToParcelLayer();
            setStatus('sidebar.parcels.adsLoaded', 'Loaded {{count}} ad parcels', { count: adParcelIdSet.size });
        } catch (error) {
            console.error('Failed to fetch ad parcels', error);
            setStatus('sidebar.parcels.adsError', 'Unable to load ad parcels.');
        } finally {
            state.isLoading = false;
        }
    }

    async function toggleAdParcels(checked) {
        state.showAdParcels = !!checked;
        global.showAdParcels = state.showAdParcels;
        if (!state.showAdParcels) {
            clearAdOverlay();
            applyAdStylesToParcelLayer(true);
            return;
        }
        await fetchAdParcels();
    }

    function handleCheckboxChange(event) {
        toggleAdParcels(event.target.checked);
    }

    function initAdParcelsCheckbox() {
        const checkbox = document.getElementById('showAdParcelsCheckbox');
        if (!checkbox) return;
        checkbox.checked = state.showAdParcels;
        checkbox.addEventListener('change', handleCheckboxChange);
    }

    if (typeof global.addEventListener === 'function') {
        global.addEventListener('parcelDataLoaded', () => {
            if (state.showAdParcels) {
                applyAdStylesToParcelLayer();
            }
        });
    }

    document.addEventListener('DOMContentLoaded', initAdParcelsCheckbox);

    global.ParcelsAdParcels = {
        toggleAdParcels,
        fetchAdParcels,
        applyAdStylesToParcelLayer,
        getAdParcelIds: () => new Set(adParcelIdSet),
        getAdLink: (parcelId) => {
            const idStr = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
            if (!idStr) return null;
            return adParcelLinkMap.get(idStr) || null;
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);

