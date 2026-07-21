// Purpose: node-edit mode for applied local corridors — selecting a road outside drawing mode
// shows draggable node handles; dragging a node moves the centerline and the road re-applies.
// Drawing mode is drawing-only: handles hide while a corridor tool is active. Minted proposals
// are immutable and never get handles (they go through the draft/replacement editor instead).
(function attachRoadNodeEdit(global) {
    'use strict';

    let handleGroup = null;
    let activeKey = null;
    let busy = false;

    function drawingActive() {
        return global.roadDrawingMode === true;
    }

    function selectedCorridorProposal() {
        const key = global.ProposalSelection?.getKey?.() || null;
        if (!key) return null;
        const proposal = global.getProposalByIdOrHash?.(key) || null;
        if (!proposal || !proposal.roadProposal || !proposal.roadProposal.definition) return null;
        if (!isApplied(proposal, proposal.roadProposal)) return null;
        // A minted road is node-editable too — the drag forks it into your local copy
        // (updateLocalCorridorGeometry detaches its published pointers), never touching the NFT.
        return proposal;
    }

    function clearHandles() {
        if (handleGroup) {
            try { global.map?.removeLayer(handleGroup); } catch (_) { }
        }
        handleGroup = null;
        activeKey = null;
    }

    // A divIcon's element IS its hit area — on touch screens the mouse-sized handles were
    // nearly impossible to grab, so coarse pointers get finger-sized ones.
    const coarsePointer = typeof global.matchMedia === 'function' && global.matchMedia('(pointer: coarse)').matches;

    function handleIcon() {
        const size = coarsePointer ? 26 : 14;
        return global.L.divIcon({
            className: 'road-node-handle',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        });
    }

    function junctionIcon() {
        const size = coarsePointer ? 32 : 18;
        return global.L.divIcon({
            className: 'road-node-handle road-node-handle--junction',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        });
    }

    function bulldozeIcon() {
        const size = coarsePointer ? 24 : 12;
        return global.L.divIcon({
            className: 'road-edge-bulldoze',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        });
    }

    function editHint(key, fallback) {
        try {
            const value = global.i18n?.t?.(key);
            if (value && value !== key) return value;
        } catch (_) { }
        return fallback;
    }

    function normalizedSegmentsOf(definition) {
        return (global.corridorCenterlineOf?.(definition) || [])
            .map(segment => segment.map(point => ({ lat: point.lat, lng: point.lng })));
    }

    function writeSegments(definition, segments) {
        const kept = segments.filter(segment => segment.length >= 2);
        definition.points = kept;
        definition.segments = kept;
        const ids = Array.isArray(definition.segmentIds) ? definition.segmentIds : [];
        definition.segmentIds = kept.map((_, index) => ids[index] || null);
    }

    // Corridor re-apply is stateful (unapply→apply + parcel/building re-cut) and cannot safely run
    // twice at once. Rather than DROP an edit that arrives mid-apply (which lost the drag and orphaned
    // its node), edits are serialized and COALESCED: the newest queued edit wins, because liveMoveNode
    // has already written every drag into the live definition, so one final re-apply captures them all.
    // A non-blocking "Applying…" spinner (in updateLocalCorridorGeometry) tells the user work is running.
    let pendingEdit = null;
    function runExclusiveEdit(runFn) {
        if (typeof runFn !== 'function') return;
        if (busy) { pendingEdit = runFn; return; } // coalesce: only the latest matters
        busy = true;
        Promise.resolve(runFn()).catch(error => {
            console.warn('[roadNodeEdit] Geometry edit failed', error);
        }).finally(() => {
            busy = false;
            if (pendingEdit) {
                const next = pendingEdit;
                pendingEdit = null;
                runExclusiveEdit(next);
            } else {
                refresh();
            }
        });
    }

    function mutateGeometry(proposalKey, mutator) {
        if (typeof global.updateLocalCorridorGeometry !== 'function') return;
        runExclusiveEdit(() => global.updateLocalCorridorGeometry(proposalKey, mutator));
    }

    // Bulldoze one stretch: the edge disappears, the segment splits around it, and if the body
    // disconnects, updateLocalCorridorGeometry splits it into separate roads.
    function bulldozeEdge(proposalKey, segIndex, edgeIndex) {
        mutateGeometry(proposalKey, definition => {
            const segments = normalizedSegmentsOf(definition);
            const segment = segments[segIndex];
            if (!segment || !segment[edgeIndex + 1]) return;
            const before = segment.slice(0, edgeIndex + 1);
            const after = segment.slice(edgeIndex + 1);
            const replacement = [];
            if (before.length >= 2) replacement.push(before);
            if (after.length >= 2) replacement.push(after);
            segments.splice(segIndex, 1, ...replacement);
            writeSegments(definition, segments);
        });
    }

    // Alt-click a node: remove the vertex from every leg that shares it (each polyline
    // straightens through; disconnected results split via updateLocalCorridorGeometry).
    function deleteNode(proposalKey, targets) {
        mutateGeometry(proposalKey, definition => {
            const segments = normalizedSegmentsOf(definition);
            targets.forEach(({ segIndex, pointIndex }) => {
                const segment = segments[segIndex];
                if (segment && segment[pointIndex]) segment.splice(pointIndex, 1);
            });
            writeSegments(definition, segments);
        });
    }

    // A junction is ONE node: every coincident vertex (one per crossing segment) moves together,
    // so dragging the center of an X carries all four legs.
    function moveNodeTargets(definition, targets, latlng) {
        const segments = (global.corridorCenterlineOf?.(definition) || [])
            .map(segment => segment.map(point => ({ lat: point.lat, lng: point.lng })));
        let moved = false;
        targets.forEach(({ segIndex, pointIndex }) => {
            if (segments[segIndex] && segments[segIndex][pointIndex]) {
                segments[segIndex][pointIndex] = { lat: latlng.lat, lng: latlng.lng };
                moved = true;
            }
        });
        if (moved) {
            definition.points = segments;
            definition.segments = segments;
        }
        return moved;
    }

    // Dropping a node near a centerline (own body's other stretches or another road) snaps it
    // exactly onto the line, so T-junctions get a genuine shared node instead of a near miss.
    function snapDropLatLng(latlng, origin, isTrack) {
        const map = global.map;
        if (!map || typeof global.proposalStorage?.getAllProposals !== 'function') return latlng;
        const SNAP_PX = 15;
        const EPS = 1e-7;
        const nearOrigin = (p) => origin && Math.abs(p.lat - origin.lat) < EPS && Math.abs(p.lng - origin.lng) < EPS;
        const dropPoint = map.latLngToLayerPoint(latlng);
        let best = null;
        const consider = (candidate) => {
            const distance = dropPoint.distanceTo(map.latLngToLayerPoint(candidate));
            if (distance > SNAP_PX) return;
            if (!best || distance < best.distance) best = { distance, latlng: candidate };
        };
        global.proposalStorage.getAllProposals().forEach(proposal => {
            const definition = proposal?.roadProposal?.definition;
            if (!definition) return;
            if (global.corridorIsTrack(definition) !== isTrack) return;
            if (!isApplied(proposal, proposal.roadProposal)) return;
            (global.corridorCenterlineOf?.(definition) || []).forEach(segment => {
                segment.forEach(vertex => {
                    if (!nearOrigin(vertex)) consider(global.L.latLng(vertex.lat, vertex.lng));
                });
                for (let i = 0; i < segment.length - 1; i += 1) {
                    // Edges touching the dragged node follow the drag — never snap back onto them.
                    if (nearOrigin(segment[i]) || nearOrigin(segment[i + 1])) continue;
                    const a = map.latLngToLayerPoint(segment[i]);
                    const b = map.latLngToLayerPoint(segment[i + 1]);
                    const abX = b.x - a.x;
                    const abY = b.y - a.y;
                    const lengthSq = abX * abX + abY * abY;
                    if (lengthSq < 1e-9) continue;
                    let t = ((dropPoint.x - a.x) * abX + (dropPoint.y - a.y) * abY) / lengthSq;
                    t = Math.max(0, Math.min(1, t));
                    consider(map.layerPointToLatLng(global.L.point(a.x + t * abX, a.y + t * abY)));
                }
            });
        });
        return best ? best.latlng : latlng;
    }

    // Live feedback mid-drag: mutate the stored centerline and redraw the cross-section strips.
    // The expensive part (footprint rebuild, parcel re-cut, re-apply) waits for the drop.
    function liveMoveNode(proposalKey, targets, latlng) {
        // A re-apply may be in flight (non-blocking) and reading this very definition across its awaits;
        // mutating it here would race the unapply→apply. Skip the live write while that runs — the
        // Leaflet marker still tracks the cursor natively, and the drop's commit re-applies the final
        // position. The strips simply pause until the apply finishes.
        if (global.isCorridorApplyInFlight?.()) return;
        const proposal = global.getProposalByIdOrHash?.(proposalKey) || null;
        const definition = proposal?.roadProposal?.definition;
        if (!definition) return;
        if (moveNodeTargets(definition, targets, latlng)) {
            global.scheduleCorridorStripRefresh?.();
        }
    }

    function commitNodeMove(proposalKey, targets, latlng, origin, isTrack, preEditSnapshot) {
        if (typeof global.updateLocalCorridorGeometry !== 'function') return;
        // Snap at drop time (the snap targets are read from the map as it is now), then serialize the
        // re-apply. Hand over the geometry captured at dragstart: liveMoveNode has already streamed the
        // drag into the live definition, so updateLocalCorridorGeometry can no longer snapshot the true
        // original itself — without it, changed-edge detection and the reroute-rollback baseline would
        // be the dragged shape, not the starting one.
        const snapped = snapDropLatLng(latlng, origin, isTrack);
        runExclusiveEdit(() => global.updateLocalCorridorGeometry(proposalKey, definition => {
            moveNodeTargets(definition, targets, snapped);
        }, { preEditSnapshot: preEditSnapshot || null }));
    }

    function refresh() {
        const map = global.map;
        if (!map || !global.L) return;
        if (busy) return;
        clearHandles();
        if (drawingActive()) return;
        const proposal = selectedCorridorProposal();
        if (!proposal) return;
        const key = (global.getProposalKey?.(proposal)) || proposal.proposalId;
        const segments = global.corridorCenterlineOf?.(proposal.roadProposal.definition) || [];
        if (!segments.length) return;

        if (!map.getPane('road-node-handles')) {
            map.createPane('road-node-handles').style.zIndex = 660;
        }
        handleGroup = global.L.layerGroup().addTo(map);
        activeKey = String(key);
        const isTrack = global.corridorIsTrack(proposal.roadProposal.definition);

        // ONE handle per unique position: a junction's coincident vertices (one per crossing
        // segment) share a handle, so dragging the junction moves every leg together.
        const nodesByPosition = new Map();
        segments.forEach((segment, segIndex) => {
            segment.forEach((point, pointIndex) => {
                const positionKey = `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;
                if (!nodesByPosition.has(positionKey)) {
                    nodesByPosition.set(positionKey, { lat: point.lat, lng: point.lng, targets: [] });
                }
                nodesByPosition.get(positionKey).targets.push({ segIndex, pointIndex });
            });
        });

        nodesByPosition.forEach(node => {
            // A junction is where two or more DISTINCT legs meet — count distinct segments, not raw
            // coincident vertices. A single segment can leave two vertices at one spot (a loop that
            // closes on itself, or a stray duplicate from a drag/weld); that is one leg, not a
            // junction, and must render like every other plain node instead of the emphasised amber
            // handle. The drag still carries every coincident vertex (all `targets`) regardless.
            const isJunction = new Set(node.targets.map(target => target.segIndex)).size > 1;
            const marker = global.L.marker([node.lat, node.lng], {
                draggable: true,
                icon: isJunction ? junctionIcon() : handleIcon(),
                pane: 'road-node-handles'
            });
            marker.bindTooltip(editHint(
                isJunction ? 'panel.road.junctionHint' : 'panel.road.nodeHint',
                isJunction
                    ? 'Junction — drag to move all legs · ⌥-click to disconnect'
                    : 'Drag to move · ⌥-click to remove this node'
            ), { sticky: true, pane: 'road-node-handles' });
            const origin = { lat: node.lat, lng: node.lng };
            let lastLiveUpdate = 0;
            // The TRUE pre-drag geometry, frozen before liveMoveNode starts mutating the live
            // definition — handed to commitNodeMove so the re-apply reasons from the original shape.
            let dragStartSnapshot = null;
            marker.on('dragstart', () => {
                const proposal = global.getProposalByIdOrHash?.(activeKey) || null;
                const definition = proposal?.roadProposal?.definition;
                dragStartSnapshot = definition ? JSON.parse(JSON.stringify(definition)) : null;
            });
            marker.on('drag', () => {
                const now = Date.now();
                if (now - lastLiveUpdate < 120) return;
                lastLiveUpdate = now;
                liveMoveNode(activeKey, node.targets, marker.getLatLng());
            });
            marker.on('dragend', () => {
                commitNodeMove(activeKey, node.targets, marker.getLatLng(), origin, isTrack, dragStartSnapshot);
                dragStartSnapshot = null;
            });
            marker.on('click', (event) => {
                if (event.originalEvent && (event.originalEvent.altKey || event.originalEvent.metaKey)) {
                    try { global.L.DomEvent.stop(event.originalEvent); } catch (_) { }
                    deleteNode(activeKey, node.targets);
                }
            });
            handleGroup.addLayer(marker);
        });

        segments.forEach((segment, segIndex) => {
            // Bulldoze handles: one per stretch, at the edge midpoint.
            for (let edgeIndex = 0; edgeIndex < segment.length - 1; edgeIndex += 1) {
                const a = segment[edgeIndex];
                const b = segment[edgeIndex + 1];
                const midpoint = global.L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {
                    icon: bulldozeIcon(),
                    pane: 'road-node-handles',
                    keyboard: false
                });
                midpoint.bindTooltip(editHint('panel.road.bulldozeHint', '🚜 Bulldoze this stretch'), { sticky: true, pane: 'road-node-handles' });
                midpoint.on('click', (event) => {
                    try { global.L.DomEvent.stop(event.originalEvent || event); } catch (_) { }
                    bulldozeEdge(activeKey, segIndex, edgeIndex);
                });
                handleGroup.addLayer(midpoint);
            }
        });
    }

    function initialize() {
        if (global.ProposalSelection?.subscribe) {
            global.ProposalSelection.subscribe(refresh);
        }
        global.document?.addEventListener('corridor-drawing-mode-changed', refresh);
        // Re-applies, parks, and deletes all funnel through proposalCreated/list refreshes; the
        // selection subscription covers most, this covers geometry rebuilds while selected.
        global.document?.addEventListener('proposalCreated', refresh);
        refresh();
    }

    if (global.document) {
        if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', initialize);
        else initialize();
    }

    global.refreshRoadNodeHandles = refresh;
})(typeof window !== 'undefined' ? window : globalThis);
