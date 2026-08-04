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
        showMidpoints: true
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

            // Midpoints first so real vertices sit above them and win the click.
            if (options.showMidpoints) {
                topo.edgeMidpoints(topology).forEach(mid => {
                    const marker = L.marker([mid.coord[1], mid.coord[0]], markerOptions({
                        icon: L.divIcon({ className: options.midClass, iconSize: options.midSize }),
                        interactive: true,
                        keyboard: false
                    }));
                    marker.on('click', event => {
                        L.DomEvent.stop(event);
                        if (typeof options.onInsert === 'function') options.onInsert(mid.edgeId, mid.coord, topology);
                    });
                    marker.addTo(group);
                });
            }

            topology.nodes.forEach(node => {
                const shared = node.plots.length > 1;
                const className = shared
                    ? `${options.nodeClass} ${options.sharedClass}`
                    : options.nodeClass;
                const marker = L.marker([node.coord[1], node.coord[0]], markerOptions({
                    icon: L.divIcon({ className, iconSize: shared ? options.sharedSize : options.nodeSize }),
                    draggable: true,
                    autoPan: true,
                    keyboard: false
                }));

                marker.on('dragstart', () => {
                    const el = marker.getElement();
                    if (el) el.classList.add('is-dragging');
                });
                marker.on('drag', event => {
                    if (typeof options.onPreview !== 'function') return;
                    const ll = event.target.getLatLng();
                    options.onPreview(node.id, [ll.lng, ll.lat], topology);
                });
                marker.on('dragend', event => {
                    const el = marker.getElement();
                    if (el) el.classList.remove('is-dragging');
                    const ll = event.target.getLatLng();
                    let coord = [ll.lng, ll.lat];
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
