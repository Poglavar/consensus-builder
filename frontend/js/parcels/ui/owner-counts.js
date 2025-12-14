(function (global) {
    'use strict';

    let ownerCountLabels = [];
    let ownerCountLabelFilter = null;

    const resolveParcelId = (feature) => {
        const props = feature?.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    function getOwnerCountFromFeature(feature) {
        if (!feature || !feature.properties) return null;

        const props = feature.properties;
        const parcelId = resolveParcelId(feature);

        // First, try to get from feature properties (from backend)
        const ownershipList = Array.isArray(props.ownershipList) ? props.ownershipList : null;
        if (ownershipList && ownershipList.length > 0) {
            return ownershipList.length;
        }

        // Second, try to get from ownership cache
        if (parcelId) {
            const ownershipUi = global?.Parcels?.ownershipUi || {};
            const parcelOwnerDataCache = ownershipUi.parcelOwnerDataCache
                || (global.Parcels && global.Parcels.ownershipUi && global.Parcels.ownershipUi.parcelOwnerDataCache)
                || (global.ParcelsOwnershipUi && global.ParcelsOwnershipUi.parcelOwnerDataCache);
            
            if (parcelOwnerDataCache && typeof parcelOwnerDataCache.get === 'function') {
                const cachedOwners = parcelOwnerDataCache.get(parcelId.toString());
                if (Array.isArray(cachedOwners) && cachedOwners.length > 0) {
                    return cachedOwners.length;
                }
            }
        }

        // Default to 1 if no ownership data available
        return 1;
    }

    function toggleOwnerCounts() {
        const checkbox = document.getElementById('showOwnerCounts');
        const show = checkbox ? checkbox.checked : false;
        if (show) {
            drawOwnerCountLabels();
        } else {
            clearOwnerCountLabels();
        }
    }

    function drawOwnerCountLabels() {
        clearOwnerCountLabels();
        if (!global.parcelLayer) return;

        global.parcelLayer.eachLayer(layer => {
            if (!layer?.feature?.properties) return;
            const parcelId = resolveParcelId(layer.feature);
            if (ownerCountLabelFilter && parcelId && !ownerCountLabelFilter.has(parcelId)) {
                return;
            }

            const ownerCount = getOwnerCountFromFeature(layer.feature);
            if (ownerCount === null) return;

            let labelLatLng = null;
            const geometry = layer.feature.geometry;

            if (geometry && typeof turf !== 'undefined' && typeof turf.centerOfMass === 'function') {
                try {
                    const centroid = turf.centerOfMass(geometry);
                    const coords = centroid?.geometry?.coordinates;
                    if (Array.isArray(coords) && coords.length >= 2) {
                        const [lng, lat] = coords;
                        if (Number.isFinite(lat) && Number.isFinite(lng)) {
                            labelLatLng = L.latLng(lat, lng);
                        }
                    }
                } catch (error) {
                    console.warn('Unable to compute centroid for owner count label', error);
                }
            }

            if (!labelLatLng && typeof layer.getBounds === 'function') {
                const bounds = layer.getBounds();
                if (bounds && typeof bounds.getCenter === 'function') {
                    const center = bounds.getCenter();
                    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
                        labelLatLng = center;
                    }
                }
            }

            if (!labelLatLng) return;

            const label = L.marker(labelLatLng, {
                icon: L.divIcon({
                    className: 'parcel-owner-count-label',
                    html: `${ownerCount}`,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10]
                }),
                interactive: false
            }).addTo(global.map);
            ownerCountLabels.push(label);
        });
    }

    function clearOwnerCountLabels() {
        ownerCountLabels.forEach(label => global.map.removeLayer(label));
        ownerCountLabels = [];
    }

    function refreshOwnerCountLabelsIfVisible() {
        const checkbox = document.getElementById('showOwnerCounts');
        if (checkbox && checkbox.checked) {
            drawOwnerCountLabels();
        }
    }

    function setOwnerCountLabelFilter(ids) {
        if (ids && ids.size) {
            ownerCountLabelFilter = new Set(Array.from(ids).map(id => id.toString()));
        } else {
            ownerCountLabelFilter = null;
        }
        refreshOwnerCountLabelsIfVisible();
    }

    // Export functions
    if (typeof global.Parcels === 'undefined') {
        global.Parcels = {};
    }
    if (typeof global.Parcels.uiOwnerCounts === 'undefined') {
        global.Parcels.uiOwnerCounts = {};
    }
    global.Parcels.uiOwnerCounts.toggleOwnerCounts = toggleOwnerCounts;
    global.Parcels.uiOwnerCounts.drawOwnerCountLabels = drawOwnerCountLabels;
    global.Parcels.uiOwnerCounts.clearOwnerCountLabels = clearOwnerCountLabels;
    global.Parcels.uiOwnerCounts.refreshOwnerCountLabelsIfVisible = refreshOwnerCountLabelsIfVisible;
    global.Parcels.uiOwnerCounts.setOwnerCountLabelFilter = setOwnerCountLabelFilter;

    // Also make available globally for backward compatibility
    global.toggleOwnerCounts = toggleOwnerCounts;
    global.drawOwnerCountLabels = drawOwnerCountLabels;
    global.clearOwnerCountLabels = clearOwnerCountLabels;
    global.refreshOwnerCountLabelsIfVisible = refreshOwnerCountLabelsIfVisible;
    global.setOwnerCountLabelFilter = setOwnerCountLabelFilter;
})(typeof window !== 'undefined' ? window : globalThis);

