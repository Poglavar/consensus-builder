// Painted lane boundaries follow the road; widening does not paint vehicle-routing fans.
(function (root, factory) {
    const api = factory(typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficMarkings = api;
})(typeof window !== 'undefined' ? window : null, function (G) {
    'use strict';
    const sectionKey = lane => `${lane.sectionId}:${lane.direction}`;
    const xy = pose => [pose.x, pose.y];

    function paved(point, roads) {
        return roads.some(road => {
            const half = (road.width || 3) / 2, bounds = road.path.bounds;
            if (point[0] < bounds[0] - half || point[0] > bounds[2] + half
                || point[1] < bounds[1] - half || point[1] > bounds[3] + half) return false;
            const hit = G.nearest(road.path, point);
            if (hit.distance > half + .02) return false;
            // Pavement strokes have flat end caps, not a radius extending beyond the road.
            const along = (point[0] - hit.x) * Math.cos(hit.angle) + (point[1] - hit.y) * Math.sin(hit.angle);
            return !(hit.s < .01 && along < -.02 || hit.s > road.path.length - .01 && along > .02);
        });
    }

    function clip(route, roads) {
        const result = [], count = Math.max(1, Math.ceil(route.length / .5));
        let previous = xy(G.sample(route, 0)), inside = paved(previous, roads), points = inside ? [previous] : [];
        const finish = () => {
            if (points.length > 1) {
                const part = G.path(points);
                if (part.length > .02) result.push(part);
            }
            points = [];
        };
        for (let i = 1; i <= count; i++) {
            const current = xy(G.sample(route, route.length * i / count)), nextInside = paved(current, roads);
            if (nextInside !== inside) {
                let a = previous, b = current;
                for (let j = 0; j < 10; j++) {
                    const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                    if (paved(middle, roads) === inside) a = middle; else b = middle;
                }
                const boundary = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                if (inside) { points.push(boundary); finish(); } else points = [boundary];
            }
            if (nextInside) points.push(current);
            previous = current; inside = nextInside;
        }
        finish();
        return result;
    }

    function build(network, surface, offsetPolyline) {
        const sections = new Map(), surfaceSections = new Map(), groups = new Map(), widthMoves = new Set();
        const add = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
        for (const lane of network.lanes.values()) add(sections, sectionKey(lane), lane);
        for (const lane of surface.lanes) add(surfaceSections, sectionKey(lane), lane);
        for (const move of network.connections.values()) {
            if (move.geometryKind !== 'taper') continue;
            const from = network.lanes.get(move.fromLaneId), to = network.lanes.get(move.toLaneId);
            const before = sections.get(sectionKey(from)), after = sections.get(sectionKey(to));
            if (before.length === after.length) continue;
            const key = `${move.nodeId}|${sectionKey(from)}|${sectionKey(to)}`;
            if (!groups.has(key)) groups.set(key, { before, after, moves: [] });
            groups.get(key).moves.push(move); widthMoves.add(move.id);
        }
        const starts = new Map(), ends = new Map();
        for (const group of groups.values()) {
            group.roads = [
                ...(surfaceSections.get(sectionKey(group.before[0])) || []),
                ...(surfaceSections.get(sectionKey(group.after[0])) || []),
                ...group.moves.map(move => ({ path: move.path, width: network.lanes.get(move.fromLaneId).width }))
            ];
            for (const lane of group.before) ends.set(lane.id, group);
            for (const lane of group.after) starts.set(lane.id, group);
        }
        const adjacent = (lane, side) => sections.get(sectionKey(lane)).some(other =>
            other.ordinal === lane.ordinal - side && Math.abs(other.stripIndex - lane.stripIndex) === 1);
        const boundaryBecomesDivider = (lane, side, atEnd, others) => {
            const pose = G.sample(lane.rawPath, atEnd ? lane.rawPath.length : 0);
            const normal = [-Math.sin(pose.angle), Math.cos(pose.angle)];
            const edge = [pose.x + normal[0] * side * (lane.width || 3) / 2,
                pose.y + normal[1] * side * (lane.width || 3) / 2];
            const spans = others.map(other => {
                const center = G.sample(other.rawPath, atEnd ? 0 : other.rawPath.length);
                const lateral = (center.x - edge[0]) * normal[0] + (center.y - edge[1]) * normal[1];
                return [lateral - (other.width || 3) / 2, lateral + (other.width || 3) / 2];
            });
            return Math.min(...spans.map(span => span[0])) < -.1 && Math.max(...spans.map(span => span[1])) > .1;
        };
        const lanes = new Map(), connections = [];
        const edges = (route, lane, dashed, roads = null) => [-1, 1].flatMap(side => {
            const points = offsetPolyline(route.points, side * (lane.width || 3) / 2);
            if (!points) return [];
            const edge = G.path(points), paths = roads ? clip(edge, roads) : [edge];
            return paths.map(path => ({ route: path, dashed: dashed(side) }));
        });
        for (const lane of network.lanes.values()) {
            const marked = edges(lane.path, lane, side => adjacent(lane, side));
            if (starts.has(lane.id) || ends.has(lane.id)) {
                const raw = G.roundCorners(lane.rawPath, { protectedStations: lane.sourceStops.map(stop => stop.sourceS) });
                for (const [atEnd, group] of [[false, starts.get(lane.id)], [true, ends.get(lane.id)]]) {
                    if (!group || !(atEnd ? lane.endTrim : lane.startTrim)) continue;
                    const station = G.nearest(raw, lane.path.points[atEnd ? lane.path.points.length - 1 : 0]).s;
                    const run = G.slice(raw, atEnd ? station : 0, atEnd ? raw.length : station);
                    marked.push(...edges(run, lane, side => adjacent(lane, side)
                        || boundaryBecomesDivider(lane, side, atEnd, atEnd ? group.after : group.before), group.roads));
                }
            }
            lanes.set(lane.id, marked);
        }
        for (const move of network.connections.values()) {
            if (widthMoves.has(move.id) || move.path.length < 1) continue;
            const from = network.lanes.get(move.fromLaneId), to = network.lanes.get(move.toLaneId);
            const width = ((from.width || 3) + (to.width || 3)) / 2;
            connections.push(...edges(move.path, { width }, side => !move.geometryKind
                || adjacent(from, side) || adjacent(to, side)));
        }
        return { lanes, connections };
    }
    return { build };
});
