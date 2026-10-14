// Physical carriageway surfaces are independent of whether every permitted movement is assigned.
(function (root, factory) {
    const api = factory(typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficSurface = api;
})(typeof window !== 'undefined' ? window : null, function (G) {
    'use strict';
    function build(network, sourceLanes) {
        const lanes = sourceLanes.map(source => {
            const route = network.lanes.get(source.id)?.path || G.roundCorners(G.path(source.points.map(network.project)));
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
