(function (global) {
    'use strict';

    const parcelNumberLabelMarkers = new Map();
    const activeParcelNumberMarkerIds = new Set();
    let parcelNumberLabelFilter = null;
    let parcelNumberMapListenersAttached = false;
    let parcelNumberLabelCity = null;
    let centroidCache = new WeakMap();
    let centroidCacheCity = null;
    const featureRevisionById = new Map();

    if (typeof global.addEventListener === 'function') {
        global.addEventListener('parcelFabricCommitted', event => {
            const detail = event?.detail || {};
            const removedIds = new Set((detail.removedIds || []).map(String));
            const changedIds = new Set([
                ...(detail.addedIds || []),
                ...(detail.updatedIds || [])
            ].map(String));
            changedIds.forEach(id => featureRevisionById.set(id, (featureRevisionById.get(id) || 0) + 1));
            if (removedIds.size) {
                // Revisions are needed only while an ID is live. Reset the WeakMap once on removals
                // so a later re-add that reuses the same feature object cannot hit an old centroid.
                centroidCache = new WeakMap();
                removedIds.forEach(id => {
                    featureRevisionById.delete(id);
                    forgetNumberMarker(id);
                });
            }
        });
    }

    function currentCity() {
        try { return String(global.getCurrentCityId ? global.getCurrentCityId() || '' : ''); }
        catch (_) { return ''; }
    }

    function parcelLabelPosition(feature, layer, parcelId) {
        if (!feature || typeof feature !== 'object') return null;
        const city = currentCity();
        if (city !== centroidCacheCity) {
            centroidCache = new WeakMap();
            featureRevisionById.clear();
            centroidCacheCity = city;
        }
        const id = parcelId === undefined || parcelId === null ? null : String(parcelId);
        const revision = id ? featureRevisionById.get(id) || 0 : null;
        const cached = centroidCache.get(feature);
        if (cached && cached.id === id && cached.revision === revision) return cached.position;

        let position = null;
        const geometry = feature.geometry;
        if (geometry && global.turf && typeof global.turf.centerOfMass === 'function') {
            try {
                const coords = global.turf.centerOfMass(geometry)?.geometry?.coordinates;
                if (Array.isArray(coords) && coords.length >= 2
                    && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
                    position = global.L.latLng(coords[1], coords[0]);
                }
            } catch (error) {
                console.warn('Unable to compute centroid for parcel label', error);
            }
        }
        if (!position && layer && typeof layer.getBounds === 'function') {
            try {
                const center = layer.getBounds()?.getCenter?.();
                if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
                    position = global.L.latLng(center.lat, center.lng);
                }
            } catch (_) { /* fall through */ }
        }
        centroidCache.set(feature, { id, revision, position });
        return position;
    }

    global.ParcelLabelModel = Object.freeze({ currentCity, position: parcelLabelPosition });

    function parcelIdForLayer(layer) {
        return global.ParcelPresenter?.getIdForLayer?.(layer) || null;
    }

    function parcelFeature(parcelId) {
        return parcelId && global.LiveParcelFabric?.get?.(parcelId) || null;
    }

    function parcelLayersInViewport(bounds) {
        // The presenter owns the parcel bbox index; all parcel UI modules use it to avoid walking
        // the retained citywide layer after each pan/zoom.
        return global.getParcelsInBounds(bounds);
    }

    function detachNumberMarker(id) {
        const record = parcelNumberLabelMarkers.get(id);
        if (record && global.map && global.map.hasLayer(record.marker)) {
            global.map.removeLayer(record.marker);
        }
        activeParcelNumberMarkerIds.delete(id);
    }

    function clearNumberMarkerCache() {
        activeParcelNumberMarkerIds.forEach(detachNumberMarker);
        parcelNumberLabelMarkers.clear();
        activeParcelNumberMarkerIds.clear();
    }

    function forgetNumberMarker(id) {
        detachNumberMarker(id);
        parcelNumberLabelMarkers.delete(id);
    }

    function parcelNumberIcon(text) {
        const content = document.createElement('span');
        content.className = 'parcel-number-label';
        content.textContent = text;
        return global.L.divIcon({
            className: 'parcel-number-label-anchor',
            html: content,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        });
    }

    function toggleParcelNumbers() {
        const checkbox = document.getElementById('showParcelNumbers');
        const show = checkbox ? checkbox.checked : false;
        if (show) {
            attachParcelNumberMapListeners();
            drawParcelNumberLabels();
        } else {
            clearParcelNumberLabels();
        }
    }

    function drawParcelNumberLabels() {
        if (!global.parcelLayer || !global.map) return;
        const city = currentCity();
        if (city !== parcelNumberLabelCity) {
            clearNumberMarkerCache();
            parcelNumberLabelCity = city;
        }
        const bounds = global.map.getBounds();
        const parcelNumberProperty = city === 'buenos_aires'
            ? 'smp'
            : city === 'belgrade'
                ? 'parcelNum'
                : 'BROJ_CESTICE';
        const visibleIds = new Set();

        parcelLayersInViewport(bounds).forEach(layer => {
            const parcelId = parcelIdForLayer(layer);
            const feature = parcelFeature(parcelId);
            if (!feature) return;
            const parcelNumber = feature.properties?.[parcelNumberProperty];
            if (!parcelNumber || (parcelNumberLabelFilter && parcelId && !parcelNumberLabelFilter.has(parcelId))) return;
            const position = parcelLabelPosition(feature, layer, parcelId);
            if (!position || (bounds && !bounds.contains(position))) return;

            const id = String(parcelId);
            visibleIds.add(id);
            const text = String(parcelNumber);
            let record = parcelNumberLabelMarkers.get(id);
            if (!record) {
                const marker = global.L.marker(position, {
                    icon: parcelNumberIcon(text),
                    interactive: false
                });
                record = { marker, text };
                parcelNumberLabelMarkers.set(id, record);
            } else {
                if (record.marker.getLatLng) {
                    const current = record.marker.getLatLng();
                    if (current.lat !== position.lat || current.lng !== position.lng) record.marker.setLatLng(position);
                } else {
                    record.marker.setLatLng(position);
                }
                if (record.text !== text) {
                    record.marker.setIcon(parcelNumberIcon(text));
                    record.text = text;
                }
            }
            if (!global.map.hasLayer(record.marker)) global.map.addLayer(record.marker);
            activeParcelNumberMarkerIds.add(id);
        });

        parcelNumberLabelMarkers.forEach((_record, id) => {
            if (!visibleIds.has(id)) forgetNumberMarker(id);
        });
    }

    function clearParcelNumberLabels() {
        activeParcelNumberMarkerIds.forEach(detachNumberMarker);
    }

    function refreshParcelNumberLabelsIfVisible() {
        const checkbox = document.getElementById('showParcelNumbers');
        if (checkbox && checkbox.checked) drawParcelNumberLabels();
    }

    function attachParcelNumberMapListeners() {
        if (!global.map || typeof global.map.on !== 'function' || parcelNumberMapListenersAttached) return;
        global.map.on('moveend', refreshParcelNumberLabelsIfVisible);
        global.map.on('zoomend', refreshParcelNumberLabelsIfVisible);
        parcelNumberMapListenersAttached = true;
    }

    function setParcelNumberLabelFilter(ids) {
        parcelNumberLabelFilter = ids && ids.size
            ? new Set(Array.from(ids).map(id => id.toString()))
            : null;
        refreshParcelNumberLabelsIfVisible();
    }

    global.toggleParcelNumbers = toggleParcelNumbers;
    global.drawParcelNumberLabels = drawParcelNumberLabels;
    global.clearParcelNumberLabels = clearParcelNumberLabels;
    global.refreshParcelNumberLabelsIfVisible = refreshParcelNumberLabelsIfVisible;
    global.setParcelNumberLabelFilter = setParcelNumberLabelFilter;
})(typeof window !== 'undefined' ? window : globalThis);
