(function (global) {
    'use strict';

    // Ownership-bucket palette mirrors zagreb-veleprojekti so the area-monitor overlay
    // reads as the same map as the Parcele tab there: public-controlled buckets stay in
    // the cool/blue family, private-leaning buckets sit on the warm side, and only
    // 'private' is red. 'mixed' rolls into 'private' (matches zagreb-3d).
    const PARCEL_FILL = {
        city:        '#2c6bed',
        government:  '#0891b2',
        institution: '#7c3aed',
        company:     '#d97706',
        private:     '#d64545',
        unknown:     '#9ca3af'
    };
    const COLORS = {
        polygonFill: '#7ea6f5',
        polygonStroke: '#244a9b'
    };

    function ownershipBucket(rawType) {
        if (rawType === 'city') return 'city';
        if (rawType === 'government') return 'government';
        if (rawType === 'institution') return 'institution';
        if (rawType === 'company') return 'company';
        if (rawType === 'private individual') return 'private';
        if (rawType === 'mixed') return 'private';
        return 'unknown';
    }

    let polygonGroup = null;
    let parcelsGroup = null;
    let footprintsGroup = null;
    let currentMonitorData = null;
    let currentMonitorParcelIds = new Set();
    let currentMonitorOwnershipByParcelId = new Map();
    // cityOwned tracks Grad Zagreb-owned parcels separately from the broader
    // 'government' ownership bucket (which the backend lumps together with
    // RH/ministarstva/županija). Without this, ~89% of monitor 40 paints cyan
    // even though only 67% is actually 'acquired' per the summary count.
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
        if (!footprintsGroup) {
            footprintsGroup = L.featureGroup().addTo(map);
        }
    }

    function clear() {
        if (polygonGroup) polygonGroup.clearLayers();
        if (parcelsGroup) parcelsGroup.clearLayers();
        if (footprintsGroup) footprintsGroup.clearLayers();
    }

    // Building footprints inside the monitor, toggled from the detail panel. Idempotent: called with
    // features to show them, with nothing to hide them.
    function showFootprints(features) {
        ensureGroups();
        if (!footprintsGroup) return 0;
        footprintsGroup.clearLayers();
        const list = Array.isArray(features) ? features : (features && features.features) || [];
        if (!list.length) return 0;
        const layer = L.geoJSON({ type: 'FeatureCollection', features: list }, {
            interactive: false,
            style: { color: '#7c2d12', weight: 1, fillColor: '#ea580c', fillOpacity: 0.35 }
        });
        footprintsGroup.addLayer(layer);
        return list.length;
    }

    function hideFootprints() {
        if (footprintsGroup) footprintsGroup.clearLayers();
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

    function getMonitorParcelStyle(parcelId) {
        const normalizedParcelId = global.getParcelId ? global.getParcelId(parcelId) : String(parcelId || '');
        if (!normalizedParcelId || !isSavedMonitorParcel(normalizedParcelId)) return null;

        // Grad Zagreb-owned parcels get the 'city' blue (true 'acquired' count) so
        // the visual matches the summary %; everything else falls back to its
        // ownership bucket from the backend (government/institution/company/private).
        const bucket = currentMonitorCityOwnedByParcelId.get(String(normalizedParcelId)) === true
            ? 'city'
            : ownershipBucket(getOwnershipTypeForParcel(normalizedParcelId));
        const color = PARCEL_FILL[bucket];
        return {
            fillColor: color,
            fillOpacity: 0.45,
            color: color,
            weight: 2
        };
    }

    function getMonitorColor(parcelId) {
        const monitorStyle = getMonitorParcelStyle(parcelId);
        return monitorStyle ? monitorStyle.fillColor : PARCEL_FILL.unknown;
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
        showFootprints,
        hideFootprints,
        COLORS
    };

})(typeof window !== 'undefined' ? window : globalThis);
