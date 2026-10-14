// Physical carriageway surfaces are independent of whether every permitted movement is assigned.
(function (root, factory) {
    const api = factory(typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficSurface = api;
})(typeof window !== 'undefined' ? window : null, function (G) {
    'use strict';
    function hull(points) {
        const ordered = points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const part = list => {
            const result = [];
            for (const p of list) { while (result.length > 1 && cross(result.at(-2), result.at(-1), p) <= 0) result.pop(); result.push(p); }
            return result;
        };
        return [...part(ordered).slice(0, -1), ...part([...ordered].reverse()).slice(0, -1)];
    }
    function build(network, sourceLanes) {
        const lanes = [], portals = new Map();
        for (const source of sourceLanes) {
            const route = network.lanes.get(source.id)?.path || G.roundCorners(G.path(source.points.map(network.project)));
            lanes.push({ ...source, path: route });
            for (const [id, station] of [[source.fromNode, 0], [source.toNode, route.length]]) {
                const node = network.nodes.get(id);
                if (!node || node.degree < 3) continue;
                const pose = G.sample(route, station), half = (source.width || 3) / 2;
                if (node.point && Math.hypot(...network.project(node.point).map((n, i) => n - [pose.x, pose.y][i])) > 45) continue;
                if (!portals.has(id)) portals.set(id, []);
                for (const side of [-1, 1]) portals.get(id).push([
                    pose.x + Math.sin(pose.angle) * half * side,
                    pose.y - Math.cos(pose.angle) * half * side
                ]);
            }
        }
        const junctions = [...portals].map(([nodeId, points]) => ({ nodeId, points: hull(points) })).filter(j => j.points.length > 2);
        return { lanes, junctions };
    }
    return { build, hull };
});
