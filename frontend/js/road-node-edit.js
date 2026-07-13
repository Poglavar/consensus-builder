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
        return global.roadDrawingMode === true || global.trackDrawingMode === true;
    }

    function selectedCorridorProposal() {
        const key = global.ProposalSelection?.getKey?.() || null;
        if (!key) return null;
        const proposal = global.getProposalByIdOrHash?.(key) || null;
        if (!proposal || !proposal.roadProposal || !proposal.roadProposal.definition) return null;
        const applied = ['applied', 'executed'].includes(String(proposal.roadProposal.status || '').toLowerCase())
            || ['applied', 'executed'].includes(String(proposal.status || '').toLowerCase());
        if (!applied) return null;
        if (typeof global.isProposalMinted === 'function' && global.isProposalMinted(proposal)) return null;
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

    function mutateGeometry(proposalKey, mutator) {
        if (busy || typeof global.updateLocalCorridorGeometry !== 'function') return;
        busy = true;
        Promise.resolve(global.updateLocalCorridorGeometry(proposalKey, mutator)).catch(error => {
            console.warn('[roadNodeEdit] Geometry edit failed', error);
        }).finally(() => {
            busy = false;
            refresh();
        });
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
            if ((definition.metadata?.isTrack === true) !== isTrack) return;
            const applied = ['applied', 'executed'].includes(String(proposal.roadProposal.status || '').toLowerCase())
                || ['applied', 'executed'].includes(String(proposal.status || '').toLowerCase());
            if (!applied) return;
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
        const proposal = global.getProposalByIdOrHash?.(proposalKey) || null;
        const definition = proposal?.roadProposal?.definition;
        if (!definition) return;
        if (moveNodeTargets(definition, targets, latlng)) {
            global.scheduleCorridorStripRefresh?.();
        }
    }

    function commitNodeMove(proposalKey, targets, latlng, origin, isTrack) {
        if (busy || typeof global.updateLocalCorridorGeometry !== 'function') return;
        busy = true;
        const snapped = snapDropLatLng(latlng, origin, isTrack);
        Promise.resolve(global.updateLocalCorridorGeometry(proposalKey, definition => {
            moveNodeTargets(definition, targets, snapped);
        })).catch(error => {
            console.warn('[roadNodeEdit] Node move failed', error);
        }).finally(() => {
            busy = false;
            refresh();
        });
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
        const isTrack = proposal.roadProposal.definition?.metadata?.isTrack === true;

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
            const isJunction = node.targets.length > 1;
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
            marker.on('drag', () => {
                const now = Date.now();
                if (now - lastLiveUpdate < 120) return;
                lastLiveUpdate = now;
                liveMoveNode(activeKey, node.targets, marker.getLatLng());
            });
            marker.on('dragend', () => commitNodeMove(activeKey, node.targets, marker.getLatLng(), origin, isTrack));
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
