// Physical carriageway surfaces are independent of whether every permitted movement is assigned.
(function (root, factory) {
    const api = factory(typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficSurface = api;
})(typeof window !== 'undefined' ? window : null, function (G) {
    'use strict';
    function build(network, sourceLanes) {
        const lanes = sourceLanes.map(source => {
            let route = G.roundCorners(G.path(source.points.map(network.project)));
            const lane = network.lanes.get(source.id);
            // Only a derived width transition or smoothed corner replaces its
            // borrowed road run. Junction routing portals never cut the roadbed.
            if (lane?.startTrim || lane?.endTrim) {
                const start = lane.startTrim ? G.nearest(route, lane.path.points[0]).s : 0;
                const end = lane.endTrim ? G.nearest(route, lane.path.points.at(-1)).s : route.length;
                route = G.slice(route, start, end);
            }
            return { ...source, path: route };
        });
        // Each junction surface follows a real movement at its lane width.
        // Joining unrelated portals would fill empty corners and median islands.
        const connections = [...network.connections.values()].filter(connection => !connection.forbidden)
            .map(connection => ({ ...connection, width: network.lanes.get(connection.fromLaneId).width || 3 }));
        return { lanes, connections };
    }
    return { build };
});
