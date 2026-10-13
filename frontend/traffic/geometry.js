// Shared, metre-based lane paths: continuous tapers for cars and guides, without changing permitted movements.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficGeometry = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const unit = angle => [Math.cos(angle), Math.sin(angle)];
    const point = pose => [pose.x, pose.y];

    function path(points) {
        const clean = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-5);
        const arcs = [0];
        for (let i = 1; i < clean.length; i++) {
            arcs.push(arcs[i - 1] + Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]));
        }
        const bounds = clean.reduce((box, p) => [Math.min(box[0], p[0]), Math.min(box[1], p[1]),
            Math.max(box[2], p[0]), Math.max(box[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
        return { points: clean, arcs, bounds, length: arcs.at(-1) || 0 };
    }

    function sample(route, distance) {
        if (route.points.length === 1) return { x: route.points[0][0], y: route.points[0][1], angle: route.heading || 0 };
        const s = clamp(distance, 0, route.length);
        let lo = 1, hi = route.arcs.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (route.arcs[mid] < s) lo = mid + 1; else hi = mid;
        }
        const a = route.points[lo - 1], b = route.points[lo];
        const t = (s - route.arcs[lo - 1]) / (route.arcs[lo] - route.arcs[lo - 1] || 1);
        return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t,
            angle: route.heading ?? Math.atan2(b[1] - a[1], b[0] - a[0]) };
    }

    function slice(route, start, end) {
        return path([point(sample(route, start)),
            ...route.points.filter((p, index) => route.arcs[index] > start && route.arcs[index] < end),
            point(sample(route, end))]);
    }

    function available(lane, atStart, stops) {
        const route = lane.path;
        // Reserving less than half at either end makes adjacent transitions disjoint,
        // including very short OSM sections, without moving another junction's stop line.
        let limit = Math.min(60, route.length * .45);
        for (const stop of stops.get(lane.id) || []) {
            limit = Math.min(limit, Math.max(0, (atStart ? stop : route.length - stop) - .1));
        }
        const anchor = sample(route, atStart ? 0 : route.length);
        const heading = unit(anchor.angle);
        for (let distance = 1; distance <= limit; distance++) {
            const pose = sample(route, atStart ? distance : route.length - distance);
            if (dot(heading, unit(pose.angle)) < Math.cos(Math.PI / 12)) return Math.max(0, distance - 1);
        }
        return limit;
    }

    function taper(start, end) {
        const a = point(start), b = point(end), t0 = unit(start.angle), t1 = unit(end.angle);
        const angle = Math.atan2(t0[1] + t1[1], t0[0] + t1[0]), axis = unit(angle);
        const run = dot([b[0] - a[0], b[1] - a[1]], axis);
        if (run < .05) {
            const route = path([a, b]);
            // Sub-pixel endpoint rounding must not turn a car sideways or backwards.
            if (route.length < .2) route.heading = start.angle;
            return route;
        }
        // A quintic with evenly spaced longitudinal control points is monotone down
        // the road. Paired end handles give zero endpoint curvature on straight lanes.
        const h0 = run / (5 * dot(t0, axis)), h1 = run / (5 * dot(t1, axis));
        const controls = [a, [a[0] + t0[0] * h0, a[1] + t0[1] * h0],
            [a[0] + 2 * t0[0] * h0, a[1] + 2 * t0[1] * h0],
            [b[0] - 2 * t1[0] * h1, b[1] - 2 * t1[1] * h1],
            [b[0] - t1[0] * h1, b[1] - t1[1] * h1], b];
        const count = Math.max(8, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / .75));
        const points = [];
        for (let step = 0; step <= count; step++) {
            const t = step / count, u = 1 - t;
            const weights = [u ** 5, 5 * t * u ** 4, 10 * t ** 2 * u ** 3,
                10 * t ** 3 * u ** 2, 5 * t ** 4 * u, t ** 5];
            points.push(controls.reduce((p, c, i) => [p[0] + c[0] * weights[i], p[1] + c[1] * weights[i]], [0, 0]));
        }
        return path(points);
    }

    function build(sourceLanes, sourceConnections, nodes, signals = []) {
        const lanes = new Map([...sourceLanes].map(([id, lane]) => [id,
            { ...lane, rawPath: lane.path, startTrim: 0, endTrim: 0 }]));
        const connections = new Map([...sourceConnections].map(([id, connection]) => [id, { ...connection }]));
        const stops = new Map(), sections = new Map(), groups = new Map();
        const starts = new Map(), ends = new Map();
        const sectionKey = lane => `${lane.sectionId}:${lane.direction}`;
        const add = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
        for (const signal of signals) for (const control of signal.controls) {
            const lane = lanes.get(control.laneId);
            if (lane) add(stops, lane.id, control.fraction * lane.path.length);
        }
        for (const lane of lanes.values()) add(sections, sectionKey(lane), lane);
        for (const connection of connections.values()) {
            add(ends, connection.fromLaneId, connection);
            add(starts, connection.toLaneId, connection);
            if (nodes.get(connection.nodeId)?.degree !== 2 || !['continue', 'split', 'merge'].includes(connection.type)) continue;
            const from = lanes.get(connection.fromLaneId), to = lanes.get(connection.toLaneId);
            const key = `${connection.nodeId}|${sectionKey(from)}|${sectionKey(to)}`;
            if (!groups.has(key)) groups.set(key, { from: sections.get(sectionKey(from)), to: sections.get(sectionKey(to)), moves: [] });
            groups.get(key).moves.push(connection);
        }
        for (const group of groups.values()) {
            const ids = new Set(group.moves.map(move => move.id));
            // A width transition owns a whole directed cross-section. Real turns or
            // another branch at either endpoint must retain their junction geometry.
            if (group.from.some(lane => (ends.get(lane.id) || []).some(move => !ids.has(move.id)))
                || group.to.some(lane => (starts.get(lane.id) || []).some(move => !ids.has(move.id)))) continue;
            let lateral = 0, gap = Infinity, separation = 0, aligned = true;
            for (const move of group.moves) {
                const from = lanes.get(move.fromLaneId), to = lanes.get(move.toLaneId);
                const a = sample(from.path, from.path.length), b = sample(to.path, 0);
                const t0 = unit(a.angle), t1 = unit(b.angle);
                if (dot(t0, t1) < Math.cos(Math.PI / 7.2)) { aligned = false; break; }
                const axis = unit(Math.atan2(t0[1] + t1[1], t0[0] + t1[0]));
                lateral = Math.max(lateral, Math.abs((b.x - a.x) * -axis[1] + (b.y - a.y) * axis[0]));
                gap = Math.min(gap, (b.x - a.x) * axis[0] + (b.y - a.y) * axis[1]);
                separation = Math.max(separation, Math.hypot(b.x - a.x, b.y - a.y));
            }
            if (!aligned) continue;
            const needed = lateral > .15 || group.from.length !== group.to.length;
            // Rounded/independently offset section ends can overlap by centimetres.
            // Blend that mismatch into a short run instead of reversing across the gap.
            const length = needed ? clamp(Math.max(28, lateral * 8) - gap, 0, 60)
                : separation > 1e-5 ? Math.max(0, 4 - gap) : 0;
            const beforeLimit = Math.min(...group.from.map(lane => available(lane, false, stops)));
            const afterLimit = Math.min(...group.to.map(lane => available(lane, true, stops)));
            let before = Math.min(length / 2, beforeLimit), after = Math.min(length / 2, afterLimit);
            before = Math.min(beforeLimit, length - after);
            after = Math.min(afterLimit, length - before);
            for (const lane of group.from) lane.endTrim = before;
            for (const lane of group.to) lane.startTrim = after;
            for (const move of group.moves) move.geometryKind = needed ? 'taper' : 'continuation';
        }
        for (const lane of lanes.values()) {
            if (lane.startTrim || lane.endTrim) lane.path = slice(lane.rawPath, lane.startTrim, lane.rawPath.length - lane.endTrim);
        }
        for (const move of connections.values()) {
            const from = lanes.get(move.fromLaneId), to = lanes.get(move.toLaneId);
            const start = sample(from.path, from.path.length), end = sample(to.path, 0);
            // A coincident continuation needs no loop even when another movement in
            // its bundle prevents borrowing a shared taper zone.
            if (!move.geometryKind && nodes.get(move.nodeId)?.degree === 2
                && ['continue', 'split', 'merge'].includes(move.type)
                && Math.hypot(end.x - start.x, end.y - start.y) < .2
                && Math.cos(end.angle - start.angle) > Math.cos(Math.PI / 7.2)) {
                move.geometryKind = 'continuation';
            }
            if (move.geometryKind) move.path = taper(start, end);
        }
        return { lanes, connections };
    }

    return { path, sample, build };
});
