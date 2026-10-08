(function (global) {
    'use strict';

    const ownerCountLabelMarkers = new Map();
    const activeOwnerCountMarkerIds = new Set();
    let ownerCountLabelFilter = null;
    let ownerCountMapListenersAttached = false;
    let ownerCountHotkeyAttached = false;
    let ownerCountLabelCity = null;

    if (typeof global.addEventListener === 'function') {
        global.addEventListener('parcelFabricCommitted', event => {
            (event?.detail?.removedIds || []).forEach(id => forgetOwnerCountMarker(String(id)));
        });
    }

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

    const parcelIdForLayer = layer => global.ParcelPresenter?.getIdForLayer?.(layer) || null;
    const parcelFeature = parcelId => parcelId && global.LiveParcelFabric?.get?.(parcelId) || null;

    function detachOwnerCountMarker(id) {
        const record = ownerCountLabelMarkers.get(id);
        if (record && global.map && global.map.hasLayer(record.marker)) global.map.removeLayer(record.marker);
        activeOwnerCountMarkerIds.delete(id);
    }

    function forgetOwnerCountMarker(id) {
        detachOwnerCountMarker(id);
        ownerCountLabelMarkers.delete(id);
    }

    function clearOwnerCountLabelMarkers() {
        activeOwnerCountMarkerIds.forEach(detachOwnerCountMarker);
        ownerCountLabelMarkers.clear();
        activeOwnerCountMarkerIds.clear();
    }

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
        if (!global.parcelLayer || !global.map) return;
        const city = global.ParcelLabelModel?.currentCity?.() || '';
        if (city !== ownerCountLabelCity) {
            clearOwnerCountLabelMarkers();
            ownerCountLabelCity = city;
        }
        const bounds = global.map.getBounds();
        const visibleIds = new Set();

        global.getParcelsInBounds(bounds).forEach(layer => {
            const parcelId = parcelIdForLayer(layer);
            const feature = parcelFeature(parcelId);
            if (!feature) return;
            if (ownerCountLabelFilter && parcelId && !ownerCountLabelFilter.has(parcelId)) {
                return;
            }

            const ownerCount = getOwnerCountFromFeature(feature);
            if (ownerCount === null) return;

            const labelPosition = global.ParcelLabelModel?.position?.(feature, layer, parcelId);
            if (!labelPosition || (bounds && !bounds.contains(labelPosition))) return;

            const id = String(parcelId);
            visibleIds.add(id);
            let record = ownerCountLabelMarkers.get(id);
            if (!record) {
                const marker = L.marker(labelPosition, {
                    icon: ownerCountLabelIcon(ownerCount),
                    interactive: false
                });
                record = { marker, ownerCount };
                ownerCountLabelMarkers.set(id, record);
            } else {
                const current = record.marker.getLatLng();
                if (current.lat !== labelPosition.lat || current.lng !== labelPosition.lng) {
                    record.marker.setLatLng(labelPosition);
                }
                if (record.ownerCount !== ownerCount) {
                    record.marker.setIcon(ownerCountLabelIcon(ownerCount));
                    record.ownerCount = ownerCount;
                }
            }
            if (!global.map.hasLayer(record.marker)) global.map.addLayer(record.marker);
            activeOwnerCountMarkerIds.add(id);
        });

        ownerCountLabelMarkers.forEach((_record, id) => {
            if (!visibleIds.has(id)) forgetOwnerCountMarker(id);
        });
    }

    function ownerCountLabelIcon(ownerCount) {
        return L.divIcon({
            className: 'parcel-owner-count-label',
            html: String(ownerCount),
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });
    }

    function clearOwnerCountLabels() {
        activeOwnerCountMarkerIds.forEach(detachOwnerCountMarker);
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
