// Purpose: node-edit mode for applied local corridors — selecting a road outside drawing mode
// shows draggable node handles; dragging a node moves the centerline and the road re-applies.
// Drawing mode is drawing-only: handles hide while a corridor tool is active. Every edit creates
// a fresh local replacement snapshot, so the published/minted source itself remains immutable.
(function attachRoadNodeEdit(global) {
    'use strict';

    let handleGroup = null;
    let activeKey = null;
    let busy = false;
    // The bulldoze squares, with the stretch each one belongs to, so they can be re-placed on zoom
    // without rebuilding every handle. And how big the node handle at each position is, which is
    // what they have to keep clear of.
    let bulldozeHandles = [];
    const handleRadiusByPosition = new Map();

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
        clearDragPreview();
        bulldozeHandles = [];
        handleRadiusByPosition.clear();
        handleGroup = null;
        activeKey = null;
        // Dragging a node is the finest road work there is; the deep zoom goes with the handles.
        global.RoadEditingZoom?.exit('nodes');
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
            .map(segment => segment.map(point => ({ ...point, lat: point.lat, lng: point.lng })));
    }

    function writeSegments(definition, segments, segmentIds = null, segmentProfiles = undefined) {
        const ids = Array.isArray(segmentIds)
            ? segmentIds
            : (Array.isArray(definition.segmentIds) ? definition.segmentIds : []);
        const kept = segments.map((segment, index) => ({ segment, id: ids[index] ?? null }))
            .filter(entry => entry.segment.length >= 2);
        definition.points = kept.map(entry => entry.segment);
        definition.segments = definition.points;
        definition.segmentIds = kept.map(entry => entry.id);
        if (segmentProfiles !== undefined) {
            if (segmentProfiles && Object.keys(segmentProfiles).length) {
                definition.segmentProfiles = segmentProfiles;
            } else {
                delete definition.segmentProfiles;
            }
        }
    }

    // A handle captures array indexes from the snapshot it was rendered against. The moment an edit
    // starts those indexes are stale, so remove the handles until the atomic replacement/replay has
    // selected and rendered the new snapshot. Queuing a second click against the old proposal was
    // what created duplicate replacement records and removed unrelated stretches.
    function runExclusiveEdit(runFn) {
        if (typeof runFn !== 'function') return;
        if (busy) return;
        busy = true;
        if (handleGroup) {
            try { global.map?.removeLayer(handleGroup); } catch (_) { }
            handleGroup = null;
        }
        Promise.resolve(runFn()).catch(error => {
            console.warn('[roadNodeEdit] Geometry edit failed', error);
        }).finally(() => {
            busy = false;
            refresh();
        });
    }

    // Every road geometry edit funnels through here — node drag, node delete, bulldoze — so this
    // is the one place undo has to hook. The stack is the shared GeometryEditHistory, same as the
    // plot and building editors.
    let historyCtl = null;
    let historyKey = null;

    function ensureHistory(proposalKey) {
        const factory = global.GeometryEditHistory;
        if (!factory) return null;
        // A different road is a different stack: undoing into another proposal's geometry would
        // be nonsense.
        if (historyCtl && historyKey === String(proposalKey)) return historyCtl;
        if (historyCtl) historyCtl.destroy();
        historyKey = String(proposalKey);
        historyCtl = factory.create({
            capture: () => {
                const proposal = global.getProposalByIdOrHash?.(historyKey);
                const definition = proposal?.roadProposal?.definition;
                return definition ? JSON.parse(JSON.stringify(definition)) : undefined;
            },
            restore: (snapshot) => {
                if (!snapshot || typeof global.updateLocalCorridorGeometry !== 'function') return;
                runExclusiveEdit(() => global.updateLocalCorridorGeometry(historyKey, definition => {
                    // Put the whole captured centreline back; the update path re-cuts from it.
                    const segments = (typeof global.corridorCenterlineOf === 'function')
                        ? global.corridorCenterlineOf(snapshot)
                        : null;
                    if (segments) writeSegments(
                        definition,
                        segments,
                        snapshot.segmentIds,
                        snapshot.segmentProfiles
                    );
                }));
            },
            onChange: () => { }
        });
        historyCtl.bindKeyboard(global.window || global, {
            // Only while road nodes are actually being edited, so Cmd+Z elsewhere is untouched.
            enabled: () => !!handleGroup
        });
        return historyCtl;
    }

    function mutateGeometry(proposalKey, mutator) {
        if (typeof global.updateLocalCorridorGeometry !== 'function') return;
        const history = ensureHistory(proposalKey);
        if (history) history.record();
        runExclusiveEdit(() => global.updateLocalCorridorGeometry(proposalKey, mutator));
    }

    // Bulldoze one stretch. Disconnected remainders stay stretches of this same road formation.
    function bulldozeEdge(proposalKey, segIndex, edgeIndex) {
        mutateGeometry(proposalKey, definition => {
            const segments = normalizedSegmentsOf(definition);
            const result = global.CorridorGeometry.removeCorridorEdge(
                segments,
                definition.segmentIds,
                definition.segmentProfiles,
                segIndex,
                edgeIndex
            );
            if (!result.changed) return;
            writeSegments(definition, result.segments, result.segmentIds, result.segmentProfiles);
        });
    }

    // Alt-click a node: remove the vertex from every leg that shares it (each polyline
    // straightens through; any disconnected results remain in the same road formation).
    function deleteNode(proposalKey, targets) {
        mutateGeometry(proposalKey, definition => {
            const segments = normalizedSegmentsOf(definition);
            const result = global.CorridorGeometry.removeCorridorNodes(
                segments,
                definition.segmentIds,
                definition.segmentProfiles,
                targets
            );
            if (!result.changed) return;
            writeSegments(definition, result.segments, result.segmentIds, result.segmentProfiles);
        });
    }

    // Every applied corridor of the same kind (road or track — the two are separate networks, as
    // they are for snapping). A junction is a property of the NETWORK, so the handles have to know
    // about the roads meeting this one, not only about the road that happens to be selected.
    function appliedCorridorsOfKind(isTrack) {
        const store = global.proposalStorage;
        if (!store || typeof store.getAllProposals !== 'function') return [];
        return (store.getAllProposals() || [])
            .map(proposal => {
                const definition = proposal && proposal.roadProposal && proposal.roadProposal.definition;
                if (!definition) return null;
                if (!isApplied(proposal, proposal.roadProposal)) return null;
                if (global.corridorIsTrack?.(definition) !== isTrack) return null;
                const segments = global.corridorCenterlineOf?.(definition) || [];
                if (!segments.length) return null;
                const key = (global.getProposalKey?.(proposal)) || proposal.proposalId;
                return { key: String(key), segments };
            })
            .filter(Boolean);
    }

    // Targets arrive as {proposalKey, segIndex, pointIndex} — a junction's legs can belong to
    // different records. Group them so each record is edited once, with all of its legs at once.
    function targetsByProposal(targets) {
        const grouped = new Map();
        (targets || []).forEach(target => {
            const key = String(target.proposalKey);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push({ segIndex: target.segIndex, pointIndex: target.pointIndex });
        });
        return grouped;
    }

    // A junction is ONE node: every coincident vertex (one per crossing segment) moves together,
    // so dragging the center of an X carries all four legs.
    function moveNodeTargets(definition, targets, latlng) {
        const segments = (global.corridorCenterlineOf?.(definition) || [])
            .map(segment => segment.map(point => ({ ...point, lat: point.lat, lng: point.lng })));
        let moved = false;
        targets.forEach(({ segIndex, pointIndex }) => {
            if (segments[segIndex] && segments[segIndex][pointIndex]) {
                segments[segIndex][pointIndex] = {
                    ...segments[segIndex][pointIndex],
                    lat: latlng.lat,
                    lng: latlng.lng
                };
                moved = true;
            }
        });
        if (moved) {
            definition.points = segments;
            definition.segments = segments;
        }
        return moved;
    }

    // Dragging a node near a centerline (this road's other stretches, or another road) snaps it
    // exactly onto the line, so a junction gets a genuine shared node instead of a near miss.
    //
    // Same ladder the drawing tool uses (corridor-geometry's pickSnapTarget): a NODE beats a
    // centerline, whatever the raw pixel distances say. Landing a few centimetres along someone's
    // edge when you were plainly aiming at their corner is the near-miss this exists to prevent —
    // and it is worse here than while drawing, because the result looks connected on the map and
    // simply is not. Same radius as drawing, too, so the two gestures feel like one gesture.
    const SNAP_PX = coarsePointer ? 26 : 12;

    function findNodeSnap(latlng, origin, isTrack) {
        const map = global.map;
        if (!map || typeof global.proposalStorage?.getAllProposals !== 'function') return null;
        const EPS = 1e-7;
        const nearOrigin = (p) => origin && Math.abs(p.lat - origin.lat) < EPS && Math.abs(p.lng - origin.lng) < EPS;
        const cursor = map.latLngToLayerPoint(latlng);
        let bestNode = null;
        let bestEdge = null;
        const consider = (slot, candidate) => {
            const distance = cursor.distanceTo(map.latLngToLayerPoint(candidate));
            if (distance > SNAP_PX) return null;
            if (slot && distance >= slot.distance) return slot;
            return { distance, latlng: candidate };
        };
        global.proposalStorage.getAllProposals().forEach(proposal => {
            const definition = proposal?.roadProposal?.definition;
            if (!definition) return;
            if (global.corridorIsTrack(definition) !== isTrack) return;
            if (!isApplied(proposal, proposal.roadProposal)) return;
            (global.corridorCenterlineOf?.(definition) || []).forEach(segment => {
                segment.forEach(vertex => {
                    if (nearOrigin(vertex)) return;
                    bestNode = consider(bestNode, global.L.latLng(vertex.lat, vertex.lng)) || bestNode;
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
                    let t = ((cursor.x - a.x) * abX + (cursor.y - a.y) * abY) / lengthSq;
                    t = Math.max(0, Math.min(1, t));
                    // Pixels choose WHERE along the edge (that is what the user is aiming with), but
                    // the point itself is interpolated on the geographic edge. Projecting in pixel
                    // space and unprojecting lands within half a pixel of the line, not ON it — at a
                    // typical zoom that is a decimetre or two, and a decimetre is a mile as far as
                    // noding is concerned: the two centrelines never actually meet, so no crossing
                    // is found, no shared node is inserted, and the drop that plainly looked like a
                    // T-junction produces two roads that merely touch on screen. (The cross-corridor
                    // renderer paints the zebras off proximity, which is why it still LOOKED joined.)
                    bestEdge = consider(bestEdge, global.L.latLng(
                        segment[i].lat + t * (segment[i + 1].lat - segment[i].lat),
                        segment[i].lng + t * (segment[i + 1].lng - segment[i].lng)
                    )) || bestEdge;
                }
            });
        });
        if (bestNode) return { ...bestNode, kind: 'node' };
        if (bestEdge) return { ...bestEdge, kind: 'edge' };
        return null;
    }

    // The ring that says "let go here and it joins". Blue for an existing node, hollow amber for a
    // point along a centerline — the drawing tool's vocabulary, so the gestures read alike.
    let snapRing = null;

    function showSnapRing(snap) {
        if (!snap) {
            clearSnapRing();
            return;
        }
        const style = snap.kind === 'node'
            ? { radius: 11, color: '#2563eb', weight: 3, fillColor: '#ffffff', fillOpacity: 0.9 }
            : { radius: 8, color: '#f59e0b', weight: 3, fillColor: '#ffffff', fillOpacity: 0.85 };
        if (snapRing) {
            snapRing.setLatLng(snap.latlng);
            try { snapRing.setStyle(style); snapRing.setRadius(style.radius); } catch (_) { }
            return;
        }
        snapRing = global.L.circleMarker(snap.latlng, { ...style, interactive: false, pane: 'road-node-handles' });
        try { snapRing.addTo(global.map); } catch (_) { snapRing = null; }
    }

    function clearSnapRing() {
        if (!snapRing) return;
        try { global.map?.removeLayer(snapRing); } catch (_) { }
        snapRing = null;
    }

    // Live feedback mid-drag. This used to re-run the whole corridor strip refresh on every tick,
    // which rebuilds the cross-section of every applied road in the plan, re-cuts the structures
    // against all of them and rebuilds the 2D building layer — hundreds of milliseconds, several
    // times a second, for a change confined to a handful of legs. What the drag actually has to show
    // is where those legs are going, so it draws exactly that: one thin line per moving leg. The
    // real geometry follows on drop.
    let dragPreviewLayer = null;

    function clearDragPreview() {
        if (!dragPreviewLayer) return;
        try { global.map?.removeLayer(dragPreviewLayer); } catch (_) { }
        dragPreviewLayer = null;
    }

    function liveMoveNode(targets, latlng) {
        const map = global.map;
        if (!map || !global.L) return;
        const lines = [];
        targetsByProposal(targets).forEach((legs, proposalKey) => {
            const proposal = global.getProposalByIdOrHash?.(proposalKey) || null;
            const definition = proposal?.roadProposal?.definition;
            if (!definition) return;
            const segments = global.corridorCenterlineOf?.(definition) || [];
            legs.forEach(({ segIndex, pointIndex }) => {
                const segment = segments[segIndex];
                if (!segment || !segment[pointIndex]) return;
                // The one or two edges that hinge on this vertex — everything else stays put.
                [pointIndex - 1, pointIndex + 1].forEach(neighbourIndex => {
                    const neighbour = segment[neighbourIndex];
                    if (neighbour) lines.push([[neighbour.lat, neighbour.lng], [latlng.lat, latlng.lng]]);
                });
            });
        });
        if (!lines.length) return;
        if (!dragPreviewLayer) {
            dragPreviewLayer = global.L.layerGroup().addTo(map);
        } else {
            dragPreviewLayer.clearLayers();
        }
        lines.forEach(line => dragPreviewLayer.addLayer(global.L.polyline(line, {
            color: '#f59e0b', weight: 3, opacity: 0.95, dashArray: '6 4', interactive: false,
            pane: 'road-node-handles'
        })));
    }

    // Did the drop actually JOIN anything? Say so out loud, either way.
    //
    // A junction is invisible in the one place it matters: two centrelines a decimetre apart draw
    // exactly like two that meet, because the cross-corridor renderer paints its zebras off
    // proximity. So a drop that failed to connect looks identical to one that worked, and the only
    // way to find out was to notice the handle had not turned amber. The drop now states the
    // outcome, and when it did not join, why not — distance to the nearest centreline, or the fact
    // that the road it landed on is published and can never take a node.
    function reportJunctionOutcome(position, isTrack) {
        const map = global.map;
        if (!map || typeof global.updateStatus !== 'function') return;
        if (typeof global.proposalStorage?.getAllProposals !== 'function') return;
        const tolerance = 1e-7;
        const atNode = new Set();
        let nearest = null;

        (global.proposalStorage.getAllProposals() || []).forEach(proposal => {
            const definition = proposal?.roadProposal?.definition;
            if (!definition) return;
            if (global.corridorIsTrack?.(definition) !== isTrack) return;
            if (!isApplied(proposal, proposal.roadProposal)) return;
            const key = String((global.getProposalKey?.(proposal)) || proposal.proposalId);
            (global.corridorCenterlineOf?.(definition) || []).forEach(segment => {
                segment.forEach(vertex => {
                    if (Math.abs(vertex.lat - position.lat) < tolerance && Math.abs(vertex.lng - position.lng) < tolerance) {
                        atNode.add(key);
                    }
                });
                for (let i = 0; i < segment.length - 1; i += 1) {
                    const a = map.latLngToLayerPoint(segment[i]);
                    const b = map.latLngToLayerPoint(segment[i + 1]);
                    const abX = b.x - a.x;
                    const abY = b.y - a.y;
                    const lengthSq = abX * abX + abY * abY;
                    if (lengthSq < 1e-9) continue;
                    const cursor = map.latLngToLayerPoint(position);
                    let t = ((cursor.x - a.x) * abX + (cursor.y - a.y) * abY) / lengthSq;
                    t = Math.max(0, Math.min(1, t));
                    const foot = global.L.latLng(
                        segment[i].lat + t * (segment[i + 1].lat - segment[i].lat),
                        segment[i].lng + t * (segment[i + 1].lng - segment[i].lng)
                    );
                    const metres = map.distance(position, foot);
                    if (!nearest || metres < nearest.metres) nearest = { metres, key, title: proposal.title || key };
                }
            });
        });

        if (atNode.size > 1) {
            global.updateStatus(`Junction — ${atNode.size} roads share this node.`);
            return;
        }
        if (nearest && nearest.metres < 1) {
            global.updateStatus(`No junction: the node sits ${nearest.metres.toFixed(2)} m from "${nearest.title}" instead of on it.`);
            return;
        }
        global.updateStatus(nearest
            ? `Loose end — the nearest road centreline is ${nearest.metres.toFixed(1)} m away.`
            : 'Loose end — no other road near it.');
    }

    // Commit the drop. A junction shared by several roads is several records' edits, one per road:
    // each forks into its own local replacement, exactly as editing that road on its own would.
    // They run in sequence (the fabric queue serialises them anyway) with network noding held back
    // until the last one lands — mid-sequence the junction is half-moved, and noding THAT would
    // record crossings that stop existing a moment later.
    function commitNodeMove(targets, latlng, origin, isTrack, preEditSnapshots) {
        if (typeof global.updateLocalCorridorGeometry !== 'function') return;
        // Snap at drop time (the snap targets are read from the map as it is now), then serialize the
        // re-apply. Hand over the geometry captured at dragstart: liveMoveNode has already streamed the
        // drag into the live definition, so updateLocalCorridorGeometry can no longer snapshot the true
        // original itself — without it, changed-edge detection and the reroute-rollback baseline would
        // be the dragged shape, not the starting one.
        clearDragPreview();
        clearSnapRing();
        const snap = findNodeSnap(latlng, origin, isTrack);
        const snapped = snap ? snap.latlng : latlng;
        const grouped = targetsByProposal(targets);
        // The selected road first, so its replacement is the one the editor re-selects; the roads it
        // meets follow.
        const order = [...grouped.keys()].sort((a, b) => (a === activeKey ? -1 : b === activeKey ? 1 : 0));
        const run = async () => {
            for (const proposalKey of order) {
                const legs = grouped.get(proposalKey);
                try {
                    await global.updateLocalCorridorGeometry(proposalKey, definition => {
                        moveNodeTargets(definition, legs, snapped);
                    }, { preEditSnapshot: (preEditSnapshots && preEditSnapshots.get(proposalKey)) || null });
                } catch (error) {
                    // One leg failing must not abandon the rest at the old position — report it and
                    // keep going, so the junction ends up as whole as it can be.
                    console.error('[roadNodeEdit] could not move a leg of this junction', proposalKey, error);
                }
            }
        };
        // Two holds around the whole junction move: strip redraws (one at the end instead of one per
        // record) and network noding (nothing is noded while the junction is half-moved).
        const held = () => (global.withCorridorStripRefreshHeld
            ? global.withCorridorStripRefreshHeld(run)
            : run());
        runExclusiveEdit(async () => {
            await (global.CorridorNetworkNodes?.deferred ? global.CorridorNetworkNodes.deferred(held) : held());
            // After the noding pass has had its turn, so the answer is the settled one.
            try { reportJunctionOutcome(snapped, isTrack); } catch (_) { }
        });
    }

    // Same quantisation the plot topology uses, so a junction and a plot corner agree on what
    // counts as one node.
    function nodeKeyFor(lng, lat) {
        const topo = global.__plotTopology;
        const tolerance = (topo && topo.DEFAULT_TOLERANCE) || 1e-7;
        const q = v => Math.round(v / tolerance) * tolerance;
        return `${q(lng).toFixed(9)},${q(lat).toFixed(9)}`;
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
        global.RoadEditingZoom?.enter('nodes');
        // Dragging nodes is a road operation: the buildings it could hit appear immediately.
        try { global.ensureRoadOperationBuildings?.(); } catch (_) { }
        const isTrack = global.corridorIsTrack(proposal.roadProposal.definition);

        // ONE handle per unique position: a junction's coincident vertices share a handle, so
        // dragging the junction moves every leg together — INCLUDING the legs that belong to other
        // road proposals. Reading only the selected record was the bug: at a crossing between two
        // roads the handle moved one of them and left the other sitting at the old position, tearing
        // the junction apart. Handles are still only drawn where the SELECTED road has a vertex —
        // this widens what a handle carries, not how many handles there are.
        const nodesByPosition = new Map();
        appliedCorridorsOfKind(isTrack).forEach(corridor => {
            corridor.segments.forEach((segment, segIndex) => {
                segment.forEach((point, pointIndex) => {
                    // Node identity comes from the shared topology engine, so "the same corner"
                    // means one thing across every editor (it used to be this file's own toFixed(7)).
                    const positionKey = nodeKeyFor(point.lng, point.lat);
                    if (!nodesByPosition.has(positionKey)) {
                        nodesByPosition.set(positionKey, { lat: point.lat, lng: point.lng, targets: [] });
                    }
                    nodesByPosition.get(positionKey).targets.push({
                        proposalKey: corridor.key,
                        segIndex,
                        pointIndex,
                        isEnd: pointIndex === 0 || pointIndex === segment.length - 1
                    });
                });
            });
        });

        nodesByPosition.forEach(node => {
            const mine = node.targets.filter(target => target.proposalKey === activeKey);
            if (!mine.length) return;
            // A junction is where two or more DISTINCT legs meet — count distinct stretches, not raw
            // coincident vertices, and count them ACROSS records: a crossing between two roads is a
            // junction even though neither road has two stretches there on its own. A single stretch
            // can leave two vertices at one spot (a loop that closes on itself, or a stray duplicate
            // from a drag/weld); that is one leg, not a junction, and must render like every other
            // plain node instead of the emphasised amber handle.
            const legs = new Set(node.targets.map(target => `${target.proposalKey}|${target.segIndex}`));
            const isJunction = legs.size > 1;
            // How many OTHER roads meet here — what the drag is about to carry with it.
            const otherRoads = new Set(
                node.targets.filter(target => target.proposalKey !== activeKey).map(target => target.proposalKey)
            ).size;
            // What the bulldoze squares have to stay clear of. Junction circles are the big ones,
            // and the ones it matters most not to bury.
            handleRadiusByPosition.set(
                nodeKeyFor(node.lng, node.lat),
                (isJunction ? (coarsePointer ? 32 : 18) : (coarsePointer ? 26 : 14)) / 2
            );
            const marker = global.L.marker([node.lat, node.lng], {
                draggable: true,
                icon: isJunction ? junctionIcon() : handleIcon(),
                pane: 'road-node-handles'
            });
            // A LOOSE END — one leg, and this is that leg's last vertex. It connects to nothing, so
            // the useful thing to say about it is that dragging it onto a road joins the two.
            const isLooseEnd = !isJunction && node.targets.length === 1 && node.targets[0].isEnd;
            marker.bindTooltip(editHint(
                isJunction ? 'panel.road.junctionHint' : (isLooseEnd ? 'panel.road.looseEndHint' : 'panel.road.nodeHint'),
                isJunction
                    ? 'Junction — drag to move all legs · ⌥-click to disconnect'
                    : (isLooseEnd
                        ? 'Loose end — drag onto a road or node to join it · ⌥-click to remove'
                        : 'Drag to move · ⌥-click to remove this node')
            ) + (otherRoads ? ` (${otherRoads} other road${otherRoads > 1 ? 's' : ''} meet here)` : ''),
            { sticky: true, pane: 'road-node-handles' });
            const origin = { lat: node.lat, lng: node.lng };
            let lastLiveUpdate = 0;
            // The TRUE pre-drag geometry of every record the drag will touch, frozen before
            // liveMoveNode starts mutating them — handed to commitNodeMove so each re-apply reasons
            // from its own original shape.
            let dragStartSnapshots = null;
            marker.on('dragstart', () => {
                dragStartSnapshots = new Map();
                targetsByProposal(node.targets).forEach((_legs, proposalKey) => {
                    const proposal = global.getProposalByIdOrHash?.(proposalKey) || null;
                    const definition = proposal?.roadProposal?.definition;
                    if (definition) dragStartSnapshots.set(proposalKey, JSON.parse(JSON.stringify(definition)));
                });
            });
            marker.on('drag', () => {
                const now = Date.now();
                // The preview is a handful of polylines now, not a whole-plan redraw, so it can run
                // at something that actually feels like dragging.
                if (now - lastLiveUpdate < 40) return;
                lastLiveUpdate = now;
                const cursor = marker.getLatLng();
                const snap = findNodeSnap(cursor, origin, isTrack);
                showSnapRing(snap);
                liveMoveNode(node.targets, snap ? snap.latlng : cursor);
            });
            marker.on('dragend', () => {
                commitNodeMove(node.targets, marker.getLatLng(), origin, isTrack, dragStartSnapshots);
                dragStartSnapshots = null;
            });
            marker.on('click', (event) => {
                if (event.originalEvent && (event.originalEvent.altKey || event.originalEvent.metaKey)) {
                    try { global.L.DomEvent.stop(event.originalEvent); } catch (_) { }
                    // ⌥-click DISCONNECTS this road from the junction — it drops the vertex from the
                    // selected road only. The other roads keep their node and stay where they are,
                    // which is exactly what leaving a junction means.
                    deleteNode(activeKey, mine);
                }
            });
            handleGroup.addLayer(marker);
        });

        segments.forEach((segment, segIndex) => {
            // Bulldoze handles: one per stretch, nominally at the edge midpoint.
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
                bulldozeHandles.push({ marker: midpoint, a, b });
            }
        });
        placeBulldozeHandles();
    }

    // Keep the bulldoze square off the node handles at either end of its stretch.
    //
    // The midpoint of a short stretch between two junctions lands right on top of a junction circle,
    // burying the one handle you most need to grab. So the square slides ALONG its own stretch to the
    // nearest spot that clears both ends — never onto another stretch, so it still unambiguously
    // names the one it would bulldoze. A stretch with no clear spot at all keeps the midpoint: being
    // in the way beats being somewhere it does not belong.
    //
    // The clearances are pixels, so this is redone on zoom rather than baked into a latlng.
    function bulldozeRadiusPx() {
        return (coarsePointer ? 24 : 12) / 2;
    }

    function placeBulldozeHandles() {
        const map = global.map;
        if (!map || !global.L) return;
        const gap = 2;
        const reach = bulldozeRadiusPx();
        bulldozeHandles.forEach(({ marker, a, b }) => {
            const start = map.latLngToLayerPoint(a);
            const end = map.latLngToLayerPoint(b);
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const length = Math.hypot(dx, dy);
            if (length < 1e-6) return;
            const clearStart = (handleRadiusByPosition.get(nodeKeyFor(a.lng, a.lat)) || 0) + reach + gap;
            const clearEnd = (handleRadiusByPosition.get(nodeKeyFor(b.lng, b.lat)) || 0) + reach + gap;
            let along = length / 2;
            if (clearStart + clearEnd <= length) {
                along = Math.max(clearStart, Math.min(length - clearEnd, along));
            }
            const t = along / length;
            marker.setLatLng(map.layerPointToLatLng(global.L.point(start.x + dx * t, start.y + dy * t)));
        });
    }

    function initialize() {
        if (global.ProposalSelection?.subscribe) {
            global.ProposalSelection.subscribe(refresh);
        }
        global.document?.addEventListener('corridor-drawing-mode-changed', refresh);
        // Clearances are pixels; zooming changes how much of a stretch a fixed pixel gap covers, so
        // the squares are re-placed rather than left where the old zoom happened to want them.
        try { global.map?.on?.('zoomend', () => { if (handleGroup) placeBulldozeHandles(); }); } catch (_) { }
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
