// Shift+drag on the 2D map draws a box and adds every parcel it touches to the multi-parcel
// selection, as Shift+click adds one; plain drags still pan and plain clicks then add or remove
// single parcels. It takes over Leaflet's Shift+drag box zoom handler, so Leaflet keeps treating the
// drag as no click. Where parcels are not taking clicks (an editor or tool owns the map, the site
// tool, a shared plan or the proposal list is open, 3D) the box zooms as it always did.
// parcelsInBox is pure and exported via CommonJS for headless tests; install is the DOM layer.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelBoxSelect = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    // candidates: [{ id, bounds: [west, south, east, north], feature }]; box: [west, south, east, north].
    // A parcel is in the box when its outline touches it, not merely its bounding rectangle;
    // intersects(feature, boxPolygon) decides that (turf.booleanIntersects in the app).
    function parcelsInBox(candidates, box, intersects) {
        const [west, south, east, north] = box;
        const polygon = { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
        return candidates
            .filter(item => item.bounds[0] <= east && item.bounds[2] >= west && item.bounds[1] <= north && item.bounds[3] >= south)
            .filter(item => intersects(item.feature, polygon))
            .map(item => item.id);
    }

    // ---- DOM layer -------------------------------------------------------------------------
    function selectionAvailable() {
        const selection = root.ParcelsUISelection;
        if (!root.multiParcelSelection || !selection || selection.parcelClicksOwnedElsewhere()) return false;
        if (root.sharePlanMode || root.proposalListBrowseMode) return false;
        if (root.SiteTool && typeof root.SiteTool.isActive === 'function' && root.SiteTool.isActive()) return false;
        return !(root.document.body.classList.contains('three-mode-active'));
    }

    function selectInBounds(latLngBounds) {
        const layerGroup = root.ParcelsState && root.ParcelsState.getParcelLayer ? root.ParcelsState.getParcelLayer() : null;
        if (!layerGroup) return 0;
        const layers = new Map();
        const candidates = [];
        layerGroup.eachLayer(layer => {
            const id = root.ParcelPresenter.getIdForLayer(layer);
            const feature = id ? root.LiveParcelFabric.get(id) : null;
            if (!feature || typeof layer.getBounds !== 'function') return;
            const b = layer.getBounds();
            layers.set(id, layer);
            candidates.push({ id, feature, bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] });
        });
        const box = [latLngBounds.getWest(), latLngBounds.getSouth(), latLngBounds.getEast(), latLngBounds.getNorth()];
        const ids = parcelsInBox(candidates, box, (feature, polygon) => root.turf.booleanIntersects(feature, polygon));
        const multi = root.multiParcelSelection;
        // Like Shift+click: the box enters multi-select on the fly, keeping the viewed parcel as the seed.
        if (!multi.isActive) multi.toggle({ preserveSelectedParcel: true });
        const added = multi.addLayers(ids.map(id => layers.get(id)));
        console.log(`[${new Date().toISOString()}] [BoxSelect] ${ids.length} parcel(s) in the box, ${added} added; ${multi.selectedParcels.size} selected`);
        return added;
    }

    // Leaflet's BoxZoom with a different ending: the same box, crosshair and Escape, and the same
    // deferred reset of `moved` that tells the map the mouseup was a drag, not a click.
    function install(map) {
        const L = root.L;
        if (!map || !L || !L.Map || !L.Map.BoxZoom) throw new Error('ParcelBoxSelect: Leaflet BoxZoom is not available');
        const BoxSelect = L.Map.BoxZoom.extend({
            _onMouseUp(event) {
                if (event.which !== 1 && event.button !== 1) return;
                this._finish();
                if (!this._moved) return;
                this._clearDeferredResetState();
                this._resetStateTimeout = setTimeout(L.Util.bind(this._resetState, this), 0);
                const bounds = L.latLngBounds(this._map.containerPointToLatLng(this._startPoint), this._map.containerPointToLatLng(this._point));
                if (selectionAvailable()) selectInBounds(bounds);
                else this._map.fitBounds(bounds).fire('boxzoomend', { boxZoomBounds: bounds });
            }
        });
        const wasEnabled = map.boxZoom && map.boxZoom.enabled();
        if (map.boxZoom) map.boxZoom.disable();
        // The map reads `map.boxZoom.moved()` to drop the click that ends a drag, and 3D mode
        // disables and re-enables `map.boxZoom`: the handler keeps that name.
        map.boxZoom = new BoxSelect(map);
        if (wasEnabled !== false) map.boxZoom.enable();
        return map.boxZoom;
    }

    if (root && root.map && root.L) install(root.map);

    return { parcelsInBox, install };
});
