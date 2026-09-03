// Leaflet projection of LiveParcelFabric.
//
// ParcelPresenter is the only runtime module allowed to add/remove parcel geometry in Leaflet.
// It prepares replacement layers before a fabric transaction commits, swaps them synchronously,
// and can put the previous presentation back if a swap fails.  The map is therefore a view of a
// fabric revision, never a source from which parcel geometry is reconstructed.
(function attachParcelPresenter(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelPresenter = api.presenter;
})(typeof window !== 'undefined' ? window : globalThis, function parcelPresenterFactory(global) {
    'use strict';

    const layersById = new Map();
    const boxesById = new Map();
    let group = null;
    let revision = null;

    function featureId(feature) {
        if (global.LiveParcelFabric && typeof global.LiveParcelFabric.featureId === 'function') {
            return global.LiveParcelFabric.featureId(feature);
        }
        const props = feature && feature.properties || {};
        const id = props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id;
        return id === undefined || id === null ? '' : String(id);
    }

    function clone(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function ensureGroup() {
        if (group) return group;
        if (global.parcelLayer && typeof global.parcelLayer.addLayer === 'function') {
            group = global.parcelLayer;
        } else if (global.L && typeof global.L.featureGroup === 'function') {
            group = global.L.featureGroup();
            global.parcelLayer = group;
        }
        return group;
    }

    function addGroupToMapIfAppropriate() {
        const parcelGroup = ensureGroup();
        if (!parcelGroup || !global.map) return false;
        const allowed = typeof global.isZoomWithinParcelRange === 'function'
            ? global.isZoomWithinParcelRange()
            : true;
        if (!allowed) {
            if (typeof global.map.hasLayer === 'function' && global.map.hasLayer(parcelGroup)) {
                global.map.removeLayer(parcelGroup);
            }
            return false;
        }
        if (typeof global.map.hasLayer !== 'function' || !global.map.hasLayer(parcelGroup)) {
            if (typeof parcelGroup.addTo === 'function') parcelGroup.addTo(global.map);
            else if (typeof global.map.addLayer === 'function') global.map.addLayer(parcelGroup);
        }
        return true;
    }

    function styleFor(feature) {
        const props = feature && feature.properties || {};
        if (props.isTrack === true) {
            return { color: '#000000', weight: 2, opacity: 0.9, dashArray: '', fillColor: '#d3d3d3', fillOpacity: 0.35 };
        }
        if (props.isRoad === true || props.isCorridor === true) {
            return props.isCorridor === true && global.corridorParcelStyle
                ? global.corridorParcelStyle
                : (global.roadStyle || { color: '#555', weight: 2, fillOpacity: 0.5 });
        }
        if (props.color) {
            return { color: '#333333', weight: 1, fillColor: props.color, fillOpacity: 0.35 };
        }
        const id = featureId(feature);
        const style = typeof global.getParcelStyle === 'function'
            ? global.getParcelStyle(id, { feature }, {})
            : (typeof global.getParcelBaseStyle === 'function'
                ? global.getParcelBaseStyle(id, { feature }, {})
                : global.normalStyle);
        return style || { color: '#666', weight: 1, fillOpacity: 0.08 };
    }

    function attachInteraction(feature, layer) {
        const selectionOnEach = global.Parcels && global.Parcels.selection
            && typeof global.Parcels.selection.onEachFeature === 'function'
            ? global.Parcels.selection.onEachFeature
            : global.onEachFeature;
        if (typeof selectionOnEach === 'function') selectionOnEach(feature, layer);
        else if (typeof layer.on === 'function') {
            const events = {};
            if (typeof global.highlightFeature === 'function') events.mouseover = global.highlightFeature;
            if (typeof global.resetHighlight === 'function') events.mouseout = global.resetHighlight;
            if (typeof global.onParcelClick === 'function') events.click = global.onParcelClick;
            layer.on(events);
        }
        if (layer.options) layer.options.interactive = true;
        if (feature && feature.properties && feature.properties.isTrack === true) {
            layer._trackStyle = styleFor(feature);
        }
    }

    function boxForLayer(layer) {
        if (!layer || typeof layer.getBounds !== 'function') return null;
        try {
            const bounds = layer.getBounds();
            if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return null;
            return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        } catch (_) {
            return null;
        }
    }

    function buildLayer(feature) {
        if (!global.L || typeof global.L.geoJSON !== 'function') {
            const error = new Error('Leaflet is unavailable while preparing parcel presentation.');
            error.code = 'leaflet-unavailable';
            throw error;
        }
        const source = clone(feature);
        const collection = global.L.geoJSON(source, {
            renderer: typeof global.parcelCanvasRenderer === 'function'
                ? global.parcelCanvasRenderer()
                : undefined,
            style: () => styleFor(source),
            onEachFeature: attachInteraction
        });
        const children = typeof collection.getLayers === 'function' ? collection.getLayers() : [];
        if (!children.length) {
            const error = new Error(`Leaflet produced no layer for parcel ${featureId(source)}.`);
            error.code = 'parcel-layer-empty';
            throw error;
        }
        const layer = children.length === 1 ? children[0] : collection;
        layer.feature = source;
        layer.__parcelPresenterOwned = true;
        if (source.properties && source.properties.isTrack === true) layer._trackStyle = styleFor(source);
        return layer;
    }

    function boundsArray(bounds) {
        if (Array.isArray(bounds) && bounds.length >= 4) return bounds.map(Number);
        if (!bounds || typeof bounds.getSouthWest !== 'function' || typeof bounds.getNorthEast !== 'function') return null;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        return [Number(sw.lng), Number(sw.lat), Number(ne.lng), Number(ne.lat)];
    }

    function intersects(left, right) {
        return !!left && !!right
            && left[0] <= right[2] && left[2] >= right[0]
            && left[1] <= right[3] && left[3] >= right[1];
    }

    async function prepare(change, draftView) {
        ensureGroup();
        const replacements = new Map();
        const replacementIds = [...(change.addedIds || []), ...(change.updatedIds || [])];
        for (const requestedId of replacementIds) {
            const feature = draftView?.get?.(requestedId);
            if (!feature) throw new Error(`Fabric draft has no feature for presenter replacement ${requestedId}.`);
            const id = featureId(feature);
            replacements.set(id, buildLayer(feature));
        }
        const touched = new Set([
            ...(change.removedIds || []).map(String),
            ...Array.from(replacements.keys())
        ]);
        const previous = new Map();
        touched.forEach(id => {
            if (layersById.has(id)) previous.set(id, layersById.get(id));
        });
        return { change, replacements, previous, previousRevision: revision, committed: false };
    }

    function removePresented(id) {
        const parcelGroup = ensureGroup();
        const layer = layersById.get(String(id));
        if (!layer) return;
        if (parcelGroup && typeof parcelGroup.hasLayer === 'function' && parcelGroup.hasLayer(layer)) {
            parcelGroup.removeLayer(layer);
        }
        layersById.delete(String(id));
        boxesById.delete(String(id));
    }

    function addPresented(id, layer) {
        const parcelGroup = ensureGroup();
        if (!parcelGroup) throw new Error('Parcel layer group is unavailable.');
        if (layersById.has(id)) removePresented(id);
        parcelGroup.addLayer(layer);
        layersById.set(id, layer);
        boxesById.set(id, boxForLayer(layer));
    }

    function commit(prepared) {
        const renderer = typeof global.parcelCanvasRenderer === 'function'
            ? global.parcelCanvasRenderer()
            : null;
        const canHold = renderer && typeof renderer.holdRedraws === 'function';
        if (canHold) renderer.holdRedraws();
        // Mark the prepared swap as rollbackable before its first side effect. If Leaflet throws
        // halfway through an add/remove sequence, LiveParcelFabric invokes rollback and the old
        // complete projection is restored instead of leaving a half-painted revision behind.
        prepared.committed = true;
        try {
            for (const id of prepared.change.removedIds || []) removePresented(id);
            for (const id of prepared.change.updatedIds || []) removePresented(id);
            prepared.replacements.forEach((layer, id) => addPresented(id, layer));
        } finally {
            if (canHold) renderer.releaseRedraws();
        }
        revision = prepared.change.revision;
        addGroupToMapIfAppropriate();
        restoreSelectionStyles();
    }

    function rollback(prepared) {
        if (!prepared || !prepared.committed) return;
        prepared.replacements.forEach((_layer, id) => removePresented(id));
        prepared.previous.forEach((layer, id) => addPresented(id, layer));
        revision = prepared.previousRevision;
        restoreSelectionStyles();
    }

    function notifyPresentationChanged(change) {
        try {
            if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
                global.dispatchEvent(new global.CustomEvent('parcelFabricCommitted', { detail: change }));
                const parcelIds = [
                    ...(change.addedIds || []).map(String),
                    ...(change.updatedIds || []).map(String),
                    ...(change.removedIds || []).map(String)
                ].filter(Boolean);
                global.dispatchEvent(new global.CustomEvent('parcelDataLoaded', {
                    detail: { source: 'live-fabric', revision: change.revision, parcelIds }
                }));
                global.dispatchEvent(new global.CustomEvent('parcelCoverageUpdated', {
                    detail: { source: 'live-fabric', revision: change.revision, timestamp: Date.now() }
                }));
            }
        } catch (_) { /* presentation notifications are non-authoritative */ }
        try { global.refreshParcelNumberLabelsIfVisible?.(); } catch (_) { }
        try { global.updateVisibleParcelsCount?.(); } catch (_) { }
        try { global.multiParcelSelection?.reconcileWithFabric?.(); } catch (_) { }
    }

    function restoreSelectionStyles() {
        const selected = new Set();
        if (global.selectedParcelId !== undefined && global.selectedParcelId !== null) {
            selected.add(String(global.selectedParcelId));
        }
        if (global.multiParcelSelection?.selectedParcels
            && typeof global.multiParcelSelection.selectedParcels.forEach === 'function') {
            global.multiParcelSelection.selectedParcels.forEach(id => selected.add(String(id)));
        }
        selected.forEach(id => {
            const layer = layersById.get(id);
            if (!layer || typeof layer.setStyle !== 'function') return;
            const isMulti = global.multiParcelSelection?.selectedParcels?.has?.(id);
            const style = isMulti
                ? { fillColor: '#ff9800', fillOpacity: 0.6, color: '#f57c00', weight: 3 }
                : (layer._trackStyle ? { ...layer._trackStyle, weight: 4 } : global.selectedParcelStyle);
            if (style) layer.setStyle(style);
            if (typeof layer.bringToFront === 'function') layer.bringToFront();
        });
    }

    function getLayer(id) {
        return layersById.get(String(id)) || null;
    }

    function getLayers(ids) {
        return Array.from(ids || [], id => getLayer(id)).filter(Boolean);
    }

    function getLayersWithinBounds(bounds) {
        const box = boundsArray(bounds);
        if (!box) return [];
        const result = [];
        boxesById.forEach((layerBox, id) => {
            if (intersects(box, layerBox)) result.push(layersById.get(id));
        });
        return result.filter(Boolean);
    }

    function resolveLiveLayers(parcelIds, options = {}) {
        const fabric = global.LiveParcelFabric;
        if (!fabric) return [];
        const requested = Array.from(parcelIds || []).map(String).filter(Boolean);
        const exact = [];
        const cadastral = [];
        requested.forEach(id => {
            if (fabric.get(id)) exact.push(id);
            else cadastral.push(id);
        });
        const features = [
            ...exact.map(id => fabric.get(id)).filter(Boolean),
            ...fabric.entriesForCadastre(cadastral, { includeCorridors: options.includeCorridors === true })
        ];
        const seen = new Set();
        return features.map(feature => featureId(feature)).filter(id => {
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        }).map(getLayer).filter(layer => {
            if (!layer || !options.bounds) return !!layer;
            const id = featureId(layer.feature);
            return intersects(boundsArray(options.bounds), boxesById.get(id));
        });
    }

    // The parcel group may predate this module (or survive a hot reload). Adopt it only after
    // reconciling its complete membership to the current fabric revision; a partial or stale group
    // must never become the presenter's starting point.
    function reconcileWithFabric() {
        const fabric = global.LiveParcelFabric;
        const parcelGroup = ensureGroup();
        if (!fabric || !parcelGroup) return false;
        const features = fabric.list();
        const replacements = new Map(features.map(feature => [featureId(feature), buildLayer(feature)]));
        const existing = typeof parcelGroup.getLayers === 'function'
            ? parcelGroup.getLayers().slice()
            : Array.from(layersById.values());
        existing.forEach(layer => {
            if (typeof parcelGroup.hasLayer !== 'function' || parcelGroup.hasLayer(layer)) {
                parcelGroup.removeLayer(layer);
            }
        });
        layersById.clear();
        boxesById.clear();
        replacements.forEach((layer, id) => addPresented(id, layer));
        revision = fabric.snapshot().revision;
        addGroupToMapIfAppropriate();
        restoreSelectionStyles();
        return true;
    }

    const presenter = Object.freeze({
        prepare,
        commit,
        rollback,
        ensureGroup,
        addGroupToMapIfAppropriate,
        getLayer,
        getLayers,
        getLayersWithinBounds,
        resolveLiveLayers,
        reconcileWithFabric,
        restoreSelectionStyles,
        snapshot: () => ({ revision, layerCount: layersById.size, parcelIds: Array.from(layersById.keys()) })
    });

    if (global.LiveParcelFabric && typeof global.LiveParcelFabric.addCommitParticipant === 'function') {
        global.LiveParcelFabric.addCommitParticipant(presenter);
        // Subscribers run only after the fabric and every prepared projection have committed. UI
        // refreshes therefore never observe the brief synchronous swap inside a failed commit.
        global.LiveParcelFabric.subscribe(change => notifyPresentationChanged(change));
    }
    ensureGroup();
    reconcileWithFabric();
    return { presenter };
});
