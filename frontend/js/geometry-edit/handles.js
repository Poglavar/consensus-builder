// One draggable-handle layer for every map geometry editor. Before this, the render/drag/preview/
// commit loop existed five times over — plot boundaries, road nodes, building rings, structure
// furniture — each with its own idea of what a handle looks like and which vertices are "the same".
//
// It takes a TOPOLOGY (plot-topology.js) rather than a raw ring, so a vertex shared by several
// shapes is one handle that moves all of them. The host says what to do on move/insert/remove; this
// owns the markers, the live drag preview and the styling.
(function (global, factory) {
    'use strict';
    const api = factory();
    if (typeof window !== 'undefined') window.GeometryEditHandles = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const DEFAULTS = {
        nodeClass: 'geom-handle geom-handle--vertex',
        sharedClass: 'geom-handle--shared',
        midClass: 'geom-handle geom-handle--mid',
        nodeSize: [12, 12],
        sharedSize: [14, 14],
        midSize: [9, 9],
        edgeClass: 'geom-handle-edge',
        showMidpoints: true,
        dragMidpoints: false,
        dragEdges: false
    };

    // opts:
    //   map, leaflet, pane
    //   getShapes()      -> the geometry list the topology is built from (plots or shapes)
    //   topologyOf(list) -> topology  (defaults to plot-topology.buildTopology)
    //   onMove(nodeId, coord, topology)     -> void   (commit a vertex move)
    //   onInsert(edgeId, coord, topology)   -> void
    //   onRemove(nodeId, topology)          -> void
    //   onPreview(nodeId, coord, topology)  -> void   (optional, live drag feedback)
    //   onNodeClick(node, marker, remove)   -> void   (optional; default: call onRemove on alt-click)
    //   snap(coord)      -> coord (optional, applied at drop)
    //   classes          -> overrides for the class names above
    //   nodePolicy(node, topology) -> { draggable?, className?, size?, constrain?(coord) }
    //       Per-node freedom. A host that owns an invariant — a readjustment may not move the pool
    //       boundary — expresses it here rather than validating after the fact, so the illegal
    //       gesture is simply not reachable. `constrain` also runs during the live drag preview,
    //       so the shape follows what the drop will actually do.
    //   edgePolicy(edge, topology) -> { insertable?, draggable? }   which edges offer an insert
    //       midpoint, and (with dragEdges) which can be dragged as a whole segment
    //   dragMidpoints    -> true: a midpoint can be dragged, inserting the node where it is dropped
    //   onPreviewInsert(edgeId, coord, topology) -> void (optional, live midpoint-drag feedback)
    //   dragEdges        -> true: grabbing a segment between two nodes moves both of its ends
    //   onMoveMany(moves, topology)    -> void   moves = [{ nodeId, coord }]
    //   onPreviewMany(moves, topology) -> void   (optional, live segment-drag feedback)
    //   onEdgeClick(edge, coord, anchorLatLng, topology) -> void (optional, a click on a segment)
    function create(opts) {
        const options = Object.assign({}, DEFAULTS, opts || {}, (opts && opts.classes) || {});
        const L = options.leaflet || (typeof window !== 'undefined' ? window.L : null);
        const map = options.map;
        const topo = options.topology || (typeof window !== 'undefined' ? window.__plotTopology : null);
        if (!L || !map || !topo) return null;

        let group = null;
        let currentTopology = null;
        let destroyed = false;

        function clear() {
            if (group) {
                try { group.remove(); } catch (_) { }
                group = null;
            }
        }

        // `pane: undefined` does NOT fall back to Leaflet's default — setOptions copies the key
        // and getPane(undefined) returns nothing, so the marker fails to attach. Only set it when
        // a pane was actually asked for.
        function markerOptions(base) {
            if (options.pane) base.pane = options.pane;
            return base;
        }

        function shapes() {
            return typeof options.getShapes === 'function' ? (options.getShapes() || []) : [];
        }

        function buildTopology(list) {
            if (typeof options.topologyOf === 'function') return options.topologyOf(list);
            return topo.buildTopology(list);
        }

        // Rebuild every handle from the CURRENT geometry. Called after each commit, so handles
        // always describe what is on the map rather than a stale snapshot.
        function render() {
            if (destroyed) return null;
            clear();
            const list = shapes();
            if (!list.length) return null;
            const topology = buildTopology(list);
            currentTopology = topology;

            group = L.layerGroup().addTo(map);   // markers carry the pane, not the group

            const policyFor = node => {
                if (typeof options.nodePolicy !== 'function') return {};
                try { return options.nodePolicy(node, topology) || {}; } catch (_) { return {}; }
            };
            const edgeInsertable = edge => {
                if (typeof options.edgePolicy !== 'function') return true;
                try { return options.edgePolicy(edge, topology)?.insertable !== false; } catch (_) { return true; }
            };
            const edgeById = new Map((topology.edges || []).map(e => [e.id, e]));

            if (options.dragEdges === true) renderEdgeHandles(topology, policyFor, edgeById);

            // Midpoints first so real vertices sit above them and win the click.
            if (options.showMidpoints) {
                topo.edgeMidpoints(topology).filter(mid => edgeInsertable(edgeById.get(mid.edgeId))).forEach(mid => {
                    const marker = L.marker([mid.coord[1], mid.coord[0]], markerOptions({
                        icon: L.divIcon({ className: options.midClass, iconSize: options.midSize }),
                        interactive: true,
                        draggable: options.dragMidpoints === true,
                        autoPan: options.dragMidpoints === true,
                        keyboard: false
                    }));
                    marker.on('click', event => {
                        L.DomEvent.stop(event);
                        if (typeof options.onInsert === 'function') options.onInsert(mid.edgeId, mid.coord, topology);
                    });
                    if (options.dragMidpoints === true) {
                        // Grab the midpoint and pull: the new node lands where it is dropped, so
                        // bending a boundary is one gesture instead of "click to add, then drag".
                        marker.on('dragstart', () => {
                            const el = marker.getElement();
                            if (el) el.classList.add('is-dragging');
                        });
                        marker.on('drag', event => {
                            if (typeof options.onPreviewInsert !== 'function') return;
                            const ll = event.target.getLatLng();
                            options.onPreviewInsert(mid.edgeId, [ll.lng, ll.lat], topology);
                        });
                        marker.on('dragend', event => {
                            const ll = event.target.getLatLng();
                            let coord = [ll.lng, ll.lat];
                            if (typeof options.snap === 'function') {
                                try { coord = options.snap(coord) || coord; } catch (_) { }
                            }
                            if (typeof options.onInsert === 'function') options.onInsert(mid.edgeId, coord, topology);
                        });
                    }
                    marker.addTo(group);
                });
            }

            topology.nodes.forEach(node => {
                const policy = policyFor(node);
                // A host can say a vertex is not part of the editable design at all. Rendering a
                // handle that refuses every gesture reads as the editor being broken; leaving it
                // out says "this line is a given" without a word of explanation.
                if (policy.hidden === true) return;
                const draggable = policy.draggable !== false;
                const shared = node.plots.length > 1;
                let className = shared
                    ? `${options.nodeClass} ${options.sharedClass}`
                    : options.nodeClass;
                if (policy.className) className += ` ${policy.className}`;
                const constrain = typeof policy.constrain === 'function'
                    ? coord => { try { return policy.constrain(coord) || coord; } catch (_) { return coord; } }
                    : coord => coord;
                const marker = L.marker([node.coord[1], node.coord[0]], markerOptions({
                    icon: L.divIcon({
                        className,
                        iconSize: policy.size || (shared ? options.sharedSize : options.nodeSize)
                    }),
                    draggable,
                    autoPan: draggable,
                    keyboard: false
                }));

                marker.on('dragstart', () => {
                    const el = marker.getElement();
                    if (el) el.classList.add('is-dragging');
                });
                marker.on('drag', event => {
                    // Pull the marker itself onto the allowed position, so the handle cannot be
                    // seen somewhere the drop will not put it.
                    const ll = event.target.getLatLng();
                    const coord = constrain([ll.lng, ll.lat]);
                    if (coord[0] !== ll.lng || coord[1] !== ll.lat) {
                        event.target.setLatLng([coord[1], coord[0]]);
                    }
                    if (typeof options.onPreview !== 'function') return;
                    options.onPreview(node.id, coord, topology);
                });
                marker.on('dragend', event => {
                    const el = marker.getElement();
                    if (el) el.classList.remove('is-dragging');
                    const ll = event.target.getLatLng();
                    let coord = constrain([ll.lng, ll.lat]);
                    if (typeof options.snap === 'function') {
                        try { coord = options.snap(coord) || coord; } catch (_) { }
                    }
                    if (typeof options.onMove === 'function') options.onMove(node.id, coord, topology);
                });

                const removeThis = () => {
                    if (typeof options.onRemove === 'function') options.onRemove(node.id, topology);
                };
                marker.on('click', event => {
                    L.DomEvent.stop(event);
                    if (event.originalEvent && event.originalEvent.altKey) { removeThis(); return; }
                    if (typeof options.onNodeClick === 'function') {
                        options.onNodeClick(node, marker, removeThis, topology);
                        return;
                    }
                    removeThis();
                });

                marker.addTo(group);
            });

            return topology;
        }

        // A pane just under the handle pane for the segment hit-lines, so a node or a midpoint
        // sitting on a segment always wins the pointer.
        function edgePane() {
            const name = `${options.pane || 'overlayPane'}Edges`;
            let pane = map.getPane(name);
            if (!pane && typeof map.createPane === 'function') {
                pane = map.createPane(name);
                const base = Number((map.getPane(options.pane || 'overlayPane') || {}).style?.zIndex) || 400;
                if (pane && pane.style) pane.style.zIndex = String(base - 1);
            }
            return pane ? name : undefined;
        }

        // Every segment between two nodes, as an invisible fat line that can be grabbed. Dragging
        // it moves both ends by the same offset (each end still obeys its own nodePolicy, so an
        // end on the pool outline slides along it); a click without a drag is handed to the host.
        function renderEdgeHandles(topology, policyFor, edgeById) {
            const nodeById = new Map(topology.nodes.map(n => [n.id, n]));
            const paneName = edgePane();
            const renderer = paneName && typeof L.svg === 'function' ? L.svg({ pane: paneName }) : undefined;
            (topology.edges || []).forEach(edge => {
                let edgeRule = {};
                if (typeof options.edgePolicy === 'function') {
                    try { edgeRule = options.edgePolicy(edge, topology) || {}; } catch (_) { edgeRule = {}; }
                }
                if (edgeRule.draggable === false) return;
                const ends = [nodeById.get(edge.a), nodeById.get(edge.b)];
                if (ends.some(node => !node)) return;
                const rules = ends.map(node => policyFor(node));
                if (rules.some(rule => rule.hidden === true || rule.draggable === false)) return;
                const constrainers = rules.map(rule => (typeof rule.constrain === 'function'
                    ? coord => { try { return rule.constrain(coord) || coord; } catch (_) { return coord; } }
                    : coord => coord));
                const line = L.polyline(ends.map(node => [node.coord[1], node.coord[0]]), {
                    pane: paneName,
                    renderer,
                    weight: 14,
                    opacity: 0,
                    interactive: true,
                    bubblingMouseEvents: false,
                    className: options.edgeClass
                });
                line.addTo(group);
                let suppressClick = false;
                line.on('click', event => {
                    L.DomEvent.stop(event);
                    if (suppressClick) { suppressClick = false; return; }
                    if (typeof options.onEdgeClick !== 'function') return;
                    const ll = event.latlng;
                    options.onEdgeClick(edgeById.get(edge.id) || edge, ll ? [ll.lng, ll.lat] : null, ll, topology);
                });
                const el = line.getElement && line.getElement();
                if (!el) return;
                // The map pans on mousedown/touchstart anywhere inside it; this segment is the
                // thing being dragged, so the pan must never start.
                L.DomEvent.on(el, 'mousedown touchstart', L.DomEvent.stopPropagation);
                el.addEventListener('pointerdown', down => {
                    if (down.pointerType === 'mouse' && down.button !== 0) return;
                    down.stopPropagation();
                    const start = map.mouseEventToLatLng(down);
                    const origin = { x: down.clientX, y: down.clientY };
                    let moves = null;
                    try { el.setPointerCapture(down.pointerId); } catch (_) { }
                    const onMove = move => {
                        if (!moves && Math.hypot(move.clientX - origin.x, move.clientY - origin.y) < 4) return;
                        const ll = map.mouseEventToLatLng(move);
                        const dx = ll.lng - start.lng;
                        const dy = ll.lat - start.lat;
                        moves = ends.map((node, i) => ({
                            nodeId: node.id,
                            coord: constrainers[i]([node.coord[0] + dx, node.coord[1] + dy])
                        }));
                        line.setLatLngs(moves.map(m => [m.coord[1], m.coord[0]]));
                        el.classList.add('is-dragging');
                        if (typeof options.onPreviewMany === 'function') options.onPreviewMany(moves, topology);
                    };
                    const onUp = () => {
                        el.removeEventListener('pointermove', onMove);
                        el.removeEventListener('pointerup', onUp);
                        el.removeEventListener('pointercancel', onUp);
                        el.classList.remove('is-dragging');
                        if (!moves) return;
                        suppressClick = true;
                        const snapped = moves.map(m => {
                            let coord = m.coord;
                            if (typeof options.snap === 'function') {
                                try { coord = options.snap(coord) || coord; } catch (_) { }
                            }
                            return { nodeId: m.nodeId, coord };
                        });
                        if (typeof options.onMoveMany === 'function') options.onMoveMany(snapped, topology);
                    };
                    el.addEventListener('pointermove', onMove);
                    el.addEventListener('pointerup', onUp);
                    el.addEventListener('pointercancel', onUp);
                });
            });
        }

        function destroy() {
            destroyed = true;
            clear();
            currentTopology = null;
        }

        return {
            render,
            clear,
            destroy,
            get topology() { return currentTopology; },
            get active() { return !!group; }
        };
    }

    return { create, DEFAULTS };
});
