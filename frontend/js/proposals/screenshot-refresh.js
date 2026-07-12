// Regenerates a proposal's stored screenshot in the background after its geometry changes, so
// list thumbnails never show a stale footprint (e.g. a road whose nodes moved). Debounced per
// proposal; every failure is silent — a stale thumbnail is better than a broken edit flow.
(function (global) {
    'use strict';

    const pendingRefreshes = new Map(); // proposalId -> timeout handle

    function pushGeometryRings(geometry, out) {
        if (!geometry || !geometry.type || !geometry.coordinates) return;
        if (geometry.type === 'Polygon' && geometry.coordinates[0]) {
            out.push(geometry.coordinates[0].map(c => [c[1], c[0]])); // [lat, lng]
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(rings => {
                if (rings[0]) out.push(rings[0].map(c => [c[1], c[0]]));
            });
        }
    }

    // The proposal's OWN geometry first (that is what the edit changed); loaded parent
    // parcels only as a fallback for types without an own footprint.
    function polygonsForProposal(proposal) {
        const polys = [];
        const definition = proposal.roadProposal?.definition || proposal.geometry?.roadPlan || null;
        if (definition?.polygon?.type) pushGeometryRings(definition.polygon, polys);
        (proposal.geometry?.buildings || []).forEach(feature => pushGeometryRings(feature?.geometry || feature, polys));
        pushGeometryRings(proposal.structureProposal?.geometry, polys);
        (proposal.reparcellization?.polygons || []).forEach(entry => pushGeometryRings(entry?.geometry || entry, polys));
        if (!polys.length) {
            (proposal.parentParcelIds || []).forEach(id => {
                const layer = typeof global.resolveParcelLayerById === 'function'
                    ? global.resolveParcelLayerById(String(id))
                    : null;
                pushGeometryRings(layer?.feature?.geometry, polys);
            });
        }
        return polys;
    }

    async function refreshProposalScreenshot(proposalId) {
        try {
            const proposal = global.proposalStorage?.getProposal?.(proposalId);
            if (!proposal) return;
            if (typeof global.shouldSkipProposalScreenshot === 'function' && global.shouldSkipProposalScreenshot(proposal)) return;
            if (!global.MapScreenshot?.captureViaTileStitch) return;
            if (typeof global.persistProposalScreenshotDataUrl !== 'function') return;
            const polys = polygonsForProposal(proposal);
            if (!polys.length) return;
            const goalKey = (typeof global.resolveProposalGoalKey === 'function'
                ? global.resolveProposalGoalKey(proposal, null)
                : null) || 'proposal';
            const dataUrl = await global.MapScreenshot.captureViaTileStitch({
                polygon: polys.flat(),
                parcelPolygons: polys,
                padding: 0.12,
                zoom: 19,
                badge: goalKey.replace(/-/g, ' ')
            });
            if (dataUrl) global.persistProposalScreenshotDataUrl(proposalId, dataUrl);
        } catch (error) {
            console.debug('[screenshot-refresh] regeneration skipped', proposalId, error);
        }
    }

    // Debounced: bursts of geometry updates (merge chains, split-offs) collapse to one capture.
    function scheduleProposalScreenshotRefresh(proposalId) {
        const key = proposalId === undefined || proposalId === null ? '' : String(proposalId);
        if (!key) return;
        if (pendingRefreshes.has(key)) clearTimeout(pendingRefreshes.get(key));
        pendingRefreshes.set(key, setTimeout(() => {
            pendingRefreshes.delete(key);
            refreshProposalScreenshot(key);
        }, 1500));
    }

    global.scheduleProposalScreenshotRefresh = scheduleProposalScreenshotRefresh;
})(typeof window !== 'undefined' ? window : globalThis);
