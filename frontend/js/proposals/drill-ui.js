// What stands at one map point (proposals and parcels, via __drillStack) and the map hover
// outline that follows it. Map clicks are not handled here any more: every layer hands its
// click to the click stack (click-stack.md), which shows everything under the point in one
// panel. stackAt is the stack's source for designs and parcels.
(function (global) {
    'use strict';

    // ── candidate collection ─────────────────────────────────────────────────────────────────

    // footprint cache: proposalKey → { stamp, footprint, bbox }. The stamp moves whenever the
    // proposal is edited or re-applied, so a mutated road
    // definition cannot serve a stale corridor polygon.
    const footprintCache = new Map();
    let footprintCacheScope = null;

    function currentFabricScope() {
        const city = global.CityConfigManager?.getCurrentCityId?.() || 'default';
        const revision = global.LiveParcelFabric?.snapshot?.().revision ?? 'none';
        return `${city}|${revision}`;
    }

    function scopedFootprintKey(key) {
        const scope = currentFabricScope();
        if (scope !== footprintCacheScope) {
            footprintCache.clear();
            footprintCacheScope = scope;
        }
        return `${scope}\u0000${key}`;
    }

    function stampOf(proposal) {
        return `${proposal.updatedAt || ''}|${proposal.appliedAt || ''}`;
    }

    function footprintFor(proposal, key) {
        const planOrder = global.__planOrder;
        if (!planOrder || typeof planOrder.footprintOf !== 'function') return null;
        const stamp = stampOf(proposal);
        const cacheKey = scopedFootprintKey(key);
        const cached = footprintCache.get(cacheKey);
        if (cached && cached.stamp === stamp) return cached;
        let footprint = null;
        let bbox = null;
        try {
            footprint = planOrder.footprintOf(proposal) || null;
            if (footprint && global.turf && typeof global.turf.bbox === 'function') {
                bbox = global.turf.bbox(footprint);
            }
        } catch (_) { footprint = null; }
        const entry = { stamp, footprint, bbox };
        footprintCache.set(cacheKey, entry);
        return entry;
    }

    function bboxContains(bbox, lng, lat) {
        if (!Array.isArray(bbox) || bbox.length < 4) return true; // no bbox — let the exact test decide
        return lng >= bbox[0] && lat >= bbox[1] && lng <= bbox[2] && lat <= bbox[3];
    }

    function collectCandidates(latlng) {
        const parcels = [];
        const fabric = global.LiveParcelFabric;
        const pointBounds = [latlng.lng, latlng.lat, latlng.lng, latlng.lat];
        (fabric?.queryBounds?.(pointBounds, { includeCorridors: true }) || []).forEach(feature => {
            const id = fabric.featureId?.(feature);
            if (id) parcels.push({ id: String(id), feature, live: true });
        });

        const proposals = [];
        const storage = global.proposalStorage;
        const all = (storage && typeof storage.getAllProposals === 'function') ? storage.getAllProposals() : [];
        all.forEach(proposal => {
            if (typeof global.isProposalApplied === 'function' && !global.isProposalApplied(proposal)) return;
            const key = (typeof global.getProposalKey === 'function' && global.getProposalKey(proposal)) || proposal.proposalId;
            if (!key) return;
            const cached = footprintFor(proposal, String(key));
            if (!cached || !cached.footprint) return;
            if (!bboxContains(cached.bbox, latlng.lng, latlng.lat)) return;
            proposals.push({ key: String(key), proposal, footprint: cached.footprint });
        });

        return { parcels, proposals };
    }

    function stackAt(latlng) {
        const drill = global.__drillStack;
        if (!drill || !latlng || !global.turf || typeof global.turf.booleanPointInPolygon !== 'function') return [];
        const { parcels, proposals } = collectCandidates(latlng);
        if (!parcels.length && !proposals.length) return [];
        return drill.buildDrillStack([latlng.lng, latlng.lat], {
            parcels,
            proposals,
            pointInPolygon: (pt, poly) => global.turf.booleanPointInPolygon(pt, poly)
        });
    }


    // ── hover ────────────────────────────────────────────────────────────────────────────────

    let lastHoverRef = null;

    function hoverOutlineFor(entry) {
        if (!entry) return null;
        if (entry.kind === 'proposal') {
            const cached = footprintFor(entry.proposal, entry.key);
            return cached ? cached.footprint : null;
        }
        return entry.feature || null;
    }

    function showHoverOutline(entry) {
        const ref = entryRef(entry);
        if (ref === lastHoverRef) return;
        const feature = hoverOutlineFor(entry);
        if (!feature || typeof global.highlightFeaturesForHover !== 'function') return;
        lastHoverRef = ref;
        // Base parcels get their number label; slice ids would render their synthetic token.
        const showLabels = entry.kind === 'parcel' && entry.depth === 0;
        global.highlightFeaturesForHover([feature], { showLabels });
    }

    function clearHoverOutline() {
        if (lastHoverRef === null) return;
        lastHoverRef = null;
        if (typeof global.highlightFeaturesForHover === 'function') global.highlightFeaturesForHover([]);
    }

    // The full list — an editor holding the map, plus every mode that already meant "do not select
    // anything" — lives in map-edit-lock.js so the several places that ask this question cannot
    // drift apart. The local list stays only as the fallback if that script failed to load.
    function interactionBlocked() {
        try {
            if (global.__mapEditLock) return global.__mapEditLock.blocksSelection();
            if (global.measureMode) return true;
            if (global.roadDrawingMode === true) return true;
            if (global.cadastreViewActive === true) return true;
            if (global.proposalListBrowseMode) return true;
            if (global.MapPick?.active()) return true;
            if (typeof global.isParcelDrawingModeActive === 'function' && global.isParcelDrawingModeActive()) return true;
            if (typeof global.isStructureGeometryEditorActive === 'function' && global.isStructureGeometryEditorActive()) return true;
            if (global.AreaMonitorPaint && global.AreaMonitorPaint.isActive()) return true;
        } catch (_) { }
        return false;
    }

    let hoverPending = null;
    let lastHoverPoint = null;

    function onMapMouseMove(e) {
        if (!e || !e.latlng) return;
        if (interactionBlocked()) { clearHoverOutline(); return; }
        if (lastHoverPoint && e.containerPoint
            && Math.abs(e.containerPoint.x - lastHoverPoint.x) < 4
            && Math.abs(e.containerPoint.y - lastHoverPoint.y) < 4) return;
        lastHoverPoint = e.containerPoint;
        if (hoverPending) return;
        hoverPending = requestAnimationFrame(() => {
            hoverPending = null;
            if (global.ClickStack?.holdsHighlight?.()) return;
            const stack = stackAt(e.latlng);
            const top = global.multiParcelSelection?.isActive
                ? stack.find(entry => entry.kind === 'parcel') : stack[0];
            // The drill is the single hover authority (the parcels' own mouseover styling defers
            // to it): whatever claim is topmost — proposal, slice, or bare parcel — gets the
            // outline, so hover and click always agree on what the cursor is over.
            if (top) showHoverOutline(top);
            else clearHoverOutline();
        });
    }

    function onMapMouseOut() {
        clearHoverOutline();
    }

    // ── click entry points ───────────────────────────────────────────────────────────────────

    // Parcel, structure and corridor surfaces, and the map background, all hand their click to
    // the click stack; the returned shape keeps the old callers' contract.
    function handleParcelClick(latlng) {
        const handled = !!(latlng && global.ClickStack && global.ClickStack.handleClick(latlng));
        return { handled, selectedKind: null, selectedRef: null };
    }

    function handleSurfaceClick(latlng) {
        return !!(latlng && global.ClickStack && global.ClickStack.handleClick(latlng));
    }

    function onMapClick(e) {
        if (!e || !e.latlng || interactionBlocked()) return;
        global.ClickStack.handleClick(e.latlng);
    }

    function entryRef(entry) {
        return entry.kind === 'proposal' ? `p:${entry.key}` : `c:${entry.id}`;
    }

    // ── wiring ───────────────────────────────────────────────────────────────────────────────

    let mapWired = false;
    function wireMap() {
        if (mapWired) return true;
        const leafletMap = global.map;
        if (!leafletMap || typeof leafletMap.on !== 'function') return false;
        leafletMap.on('mousemove', onMapMouseMove);
        leafletMap.on('mouseout', onMapMouseOut);
        leafletMap.on('click', onMapClick);
        // Selection flows wipe the shared hover group (clearProposalHoverLayers); dropping the
        // memoised ref makes the next mousemove redraw instead of skipping as "already shown".
        if (global.ProposalSelection && typeof global.ProposalSelection.subscribe === 'function') {
            global.ProposalSelection.subscribe(() => { lastHoverRef = null; });
        }
        mapWired = true;
        return true;
    }

    // Whether the drill currently owns map hover — the parcels' own mouseover styling and the
    // corridor hover defer to it exactly when this is true.
    function ownsHover() {
        return mapWired && !interactionBlocked();
    }
    if (!wireMap() && typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', wireMap);
    }

    // notifyHover: for layers that keep bubblingMouseEvents off (corridor hit targets) and so
    // starve the map of mousemove — they forward their own moves here instead.
    const api = { stackAt, handleParcelClick, handleSurfaceClick, notifyHover: onMapMouseMove, ownsHover };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__drillUi = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
