(function (global) {
    'use strict';

    let ownerCountLabels = [];
    let ownerCountLabelFilter = null;
    let ownerCountMapListenersAttached = false;
    let ownerCountHotkeyAttached = false;

    const isEditableTarget = (target) => {
        if (!target) return false;
        const tagName = target.tagName;
        return target.isContentEditable
            || tagName === 'INPUT'
            || tagName === 'TEXTAREA'
            || tagName === 'SELECT'
            || tagName === 'OPTION';
    };

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
            attachOwnerCountMapListeners();
            drawOwnerCountLabels();
        } else {
            clearOwnerCountLabels();
        }
    }

    function drawOwnerCountLabels() {
        clearOwnerCountLabels();
        if (!global.parcelLayer) return;

        const bounds = (global.map && typeof global.map.getBounds === 'function')
            ? global.map.getBounds()
            : null;

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

            if (bounds && !bounds.contains(labelLatLng)) {
                return;
            }

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

    function attachOwnerCountMapListeners() {
        if (!global.map || typeof global.map.on !== 'function' || ownerCountMapListenersAttached) {
            return;
        }
        try {
            global.map.on('moveend', refreshOwnerCountLabelsIfVisible);
            global.map.on('zoomend', refreshOwnerCountLabelsIfVisible);
            ownerCountMapListenersAttached = true;
        } catch (_) { /* ignore */ }
    }

    function setOwnerCountLabelFilter(ids) {
        if (ids && ids.size) {
            ownerCountLabelFilter = new Set(Array.from(ids).map(id => id.toString()));
        } else {
            ownerCountLabelFilter = null;
        }
        refreshOwnerCountLabelsIfVisible();
    }

    // Toggle owner count labels with the "O" keyboard shortcut when not typing in a form field.
    function handleOwnerCountHotkey(event) {
        if (!event || event.defaultPrevented) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isEditableTarget(event.target)) return;
        if (event.key !== 'o' && event.key !== 'O') return;

        const checkbox = document.getElementById('showOwnerCounts');
        if (!checkbox) return;

        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        event.preventDefault();
    }

    function attachOwnerCountHotkey() {
        if (ownerCountHotkeyAttached) return;
        document.addEventListener('keydown', handleOwnerCountHotkey);
        ownerCountHotkeyAttached = true;
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachOwnerCountHotkey, { once: true });
    } else {
        attachOwnerCountHotkey();
    }
})(typeof window !== 'undefined' ? window : globalThis);

