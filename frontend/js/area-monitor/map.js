(function (global) {
    'use strict';

    const COLORS = {
        government: '#2c6bed',
        remaining: '#d64545',
        polygonFill: '#7ea6f5',
        polygonStroke: '#244a9b'
    };

    let polygonGroup = null;
    let parcelsGroup = null;
    let currentMonitorData = null;
    let currentMonitorParcelIds = new Set();
    let currentMonitorOwnershipByParcelId = new Map();
    let currentMonitorCityOwnedByParcelId = new Map();
    let currentMonitorOverlayFeatures = [];
    let overlayLoadRequestId = 0;

    function nowMs() {
        return (global.performance && typeof global.performance.now === 'function')
            ? global.performance.now()
            : Date.now();
    }

    function roundMs(value) {
        return Number(value.toFixed(2));
    }

    function getMap() {
        return global.map;
    }

    function ensureGroups() {
        const map = getMap();
        if (!map) return;

        if (!polygonGroup) {
            polygonGroup = L.featureGroup().addTo(map);
        }
        if (!parcelsGroup) {
            parcelsGroup = L.featureGroup().addTo(map);
        }
    }

    function clear() {
        if (polygonGroup) polygonGroup.clearLayers();
        if (parcelsGroup) parcelsGroup.clearLayers();
    }

    function resetParcelStyles() {
        if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
            global.refreshParcelStylesForAppliedProposals();
            return;
        }

        const parcelLayer = global.parcelLayer;
        if (!parcelLayer || typeof parcelLayer.eachLayer !== 'function') return;

        const styleFn = typeof global.getParcelStyle === 'function'
            ? global.getParcelStyle
            : global.getParcelBaseStyle;
        if (typeof styleFn !== 'function') return;

        parcelLayer.eachLayer(layer => {
            const feature = layer?.feature;
            if (!feature) return;

            const parcelId = global.getParcelId ? global.getParcelId(feature) : (feature.properties?.parcelId || feature.properties?.id);
            if (!parcelId || typeof layer.setStyle !== 'function') return;

            layer.setStyle(styleFn(String(parcelId), layer));
        });
    }

    function cacheMonitorData(data) {
        currentMonitorData = data || null;
        currentMonitorParcelIds = new Set();
        currentMonitorOwnershipByParcelId = new Map();
        currentMonitorCityOwnedByParcelId = new Map();
        currentMonitorOverlayFeatures = [];

        const monitor = data && data.monitor;
        const parcels = data && data.parcels;

        if (monitor && Array.isArray(monitor.parcelIds)) {
            monitor.parcelIds.forEach(parcelId => {
                const normalizedParcelId = global.getParcelId ? global.getParcelId(parcelId) : String(parcelId || '');
                if (normalizedParcelId) {
                    currentMonitorParcelIds.add(String(normalizedParcelId));
                }
            });
        }

        if (Array.isArray(parcels)) {
            parcels.forEach(parcel => {
                const normalizedParcelId = global.getParcelId ? global.getParcelId(parcel?.parcelId) : String(parcel?.parcelId || '');
                if (normalizedParcelId) {
                    currentMonitorOwnershipByParcelId.set(String(normalizedParcelId), parcel.ownershipType || null);
                    currentMonitorCityOwnedByParcelId.set(String(normalizedParcelId), parcel.cityOwned === true);
                }
            });
        }
    }

    function isSavedMonitorParcel(normalizedParcelId) {
        const normalizedId = normalizedParcelId ? String(normalizedParcelId) : null;
        return Boolean(normalizedId && currentMonitorParcelIds.has(normalizedId));
    }

    function getOwnershipTypeForParcel(parcelId) {
        const normalizedParcelId = global.getParcelId ? global.getParcelId(parcelId) : String(parcelId || '');
        if (!normalizedParcelId || !isSavedMonitorParcel(normalizedParcelId)) return null;
        return currentMonitorOwnershipByParcelId.get(String(normalizedParcelId)) || null;
    }

    function isCityOwnedParcel(parcelId) {
        const normalizedParcelId = global.getParcelId ? global.getParcelId(parcelId) : String(parcelId || '');
        if (!normalizedParcelId || !isSavedMonitorParcel(normalizedParcelId)) return false;

        if (currentMonitorCityOwnedByParcelId.has(String(normalizedParcelId))) {
            return currentMonitorCityOwnedByParcelId.get(String(normalizedParcelId)) === true;
        }

        return getOwnershipTypeForParcel(normalizedParcelId) === 'government';
    }

    function getMonitorParcelStyle(parcelId) {
        const normalizedParcelId = global.getParcelId ? global.getParcelId(parcelId) : String(parcelId || '');
        if (!normalizedParcelId || !isSavedMonitorParcel(normalizedParcelId)) return null;

        const color = isCityOwnedParcel(normalizedParcelId) ? COLORS.government : COLORS.remaining;
        return {
            fillColor: color,
            fillOpacity: 0.45,
            color: color,
            weight: 2
        };
    }

    function getMonitorColor(parcelId) {
        const monitorStyle = getMonitorParcelStyle(parcelId);
        return monitorStyle ? monitorStyle.fillColor : COLORS.remaining;
    }

    function renderClippedOverlay() {
        if (!parcelsGroup) return 0;

        parcelsGroup.clearLayers();
        if (!Array.isArray(currentMonitorOverlayFeatures) || !currentMonitorOverlayFeatures.length) {
            return 0;
        }

        const overlayLayer = L.geoJSON({
            type: 'FeatureCollection',
            features: currentMonitorOverlayFeatures
        }, {
            interactive: false,
            style: (feature) => {
                const parcelId = global.getParcelId ? global.getParcelId(feature) : (feature?.properties?.parcelId || feature?.properties?.id);
                const color = getMonitorColor(parcelId);
                return {
                    fillColor: color,
                    fillOpacity: 0.42,
                    color: color,
                    weight: 1,
                    opacity: 0.85
                };
            }
        });

        parcelsGroup.addLayer(overlayLayer);
        return currentMonitorOverlayFeatures.length;
    }

    async function loadOverlayGeometries(data) {
        const monitorId = data?.monitor?.id;
        if (!monitorId) {
            currentMonitorOverlayFeatures = [];
            return [];
        }

        const requestId = ++overlayLoadRequestId;
        const backendBase = typeof global.resolveBackendBaseUrl === 'function'
            ? global.resolveBackendBaseUrl()
            : 'http://localhost:3000';
        const overlayStartedAt = nowMs();
        const response = await fetch(`${backendBase}/area-monitors/${monitorId}/overlay`);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Overlay fetch failed (${response.status})`);
        }

        const payload = await response.json();
        if (requestId !== overlayLoadRequestId) {
            return [];
        }

        currentMonitorOverlayFeatures = Array.isArray(payload?.features) ? payload.features : [];
        console.info('[area-monitor] loadOverlayGeometries diagnostics', {
            monitorId,
            featureCount: currentMonitorOverlayFeatures.length,
            totalMs: roundMs(nowMs() - overlayStartedAt)
        });
        return currentMonitorOverlayFeatures;
    }

    function clearActiveMonitor() {
        overlayLoadRequestId += 1;
        cacheMonitorData(null);
        clear();
        resetParcelStyles();
    }

    function renderMonitor(data, options = {}) {
        const { monitor, parcels } = data;
        const map = getMap();
        if (!map) return;

        const renderStartedAt = nowMs();
        const fitBounds = options.fitBounds !== false;

        cacheMonitorData(null);
        const resetStartedAt = nowMs();
        resetParcelStyles();
        const resetParcelStylesMs = roundMs(nowMs() - resetStartedAt);

        clear();
        ensureGroups();
        cacheMonitorData(data);

        // Render the polygon boundary
        const polygonStartedAt = nowMs();
        if (monitor.polygon && monitor.polygon.coordinates) {
            const geoJsonLayer = L.geoJSON(monitor.polygon, {
                interactive: false,
                style: {
                    color: COLORS.polygonStroke,
                    weight: 2.5,
                    fillColor: COLORS.polygonFill,
                    fillOpacity: 0.06,
                    dashArray: '8, 4'
                }
            });
            polygonGroup.addLayer(geoJsonLayer);
        }
        const polygonRenderMs = roundMs(nowMs() - polygonStartedAt);

        const overlayStartedAt = nowMs();
        const overlayFeatureCount = renderClippedOverlay();
        const overlayRenderMs = roundMs(nowMs() - overlayStartedAt);

        // Also render parcels that may not be on the parcel layer yet
        // (the user may have zoomed/panned away). Create GeoJSON overlay
        // for parcels we got features for from the creation flow.
        // This is handled by the parcel layer itself when the user pans back.

        // Fit map to polygon bounds
        const fitBoundsStartedAt = nowMs();
        if (fitBounds && polygonGroup.getLayers().length) {
            const bounds = polygonGroup.getBounds();
            if (bounds.isValid()) {
                map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
            }
        }

        console.info('[area-monitor] renderMonitor diagnostics', {
            monitorId: monitor?.id,
            parcelCount: monitor?.parcelIds?.length || 0,
            ownershipPayloadCount: Array.isArray(parcels) ? parcels.length : 0,
            resetParcelStylesMs,
            polygonRenderMs,
            overlayFeatureCount,
            overlayRenderMs,
            fitBoundsMs: roundMs(nowMs() - fitBoundsStartedAt),
            totalMs: roundMs(nowMs() - renderStartedAt)
        });
    }

    function setCurrentMonitor(data) {
        cacheMonitorData(data);
    }

    function reapplyStyles() {
        if (currentMonitorData) {
            renderClippedOverlay();
        }
    }

    // Public API
    global.AreaMonitorMap = {
        renderMonitor,
        clear,
        clearActiveMonitor,
        setCurrentMonitor,
        loadOverlayGeometries,
        reapplyStyles,
        COLORS
    };

})(typeof window !== 'undefined' ? window : globalThis);
