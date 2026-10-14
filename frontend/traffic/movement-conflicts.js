// Static conflict ranges between permitted connection paths, independent of simulation state.
(function exposeTrafficMovementConflicts(root, factory) {
    'use strict';
    const isNode = typeof module === 'object' && module.exports;
    const api = factory(isNode ? require('./geometry.js') : root?.TrafficGeometry,
        isNode ? require('./collision.js') : root?.TrafficCollision);
    if (isNode) module.exports = api;
    if (root) root.TrafficMovementConflicts = api;
})(typeof window === 'undefined' ? null : window, function createTrafficMovementConflicts(G, Collision) {
    'use strict';
    const STEP = .5, BOUNDS_PADDING = 3, APPROACH = 14, EXIT = 7;

    function boundsOverlap(a, b) {
        const aa = a.path.bounds, bb = b.path.bounds;
        return aa[0] - BOUNDS_PADDING <= bb[2] + BOUNDS_PADDING
            && aa[2] + BOUNDS_PADDING >= bb[0] - BOUNDS_PADDING
            && aa[1] - BOUNDS_PADDING <= bb[3] + BOUNDS_PADDING
            && aa[3] + BOUNDS_PADDING >= bb[1] - BOUNDS_PADDING;
    }

    class Index {
        constructor(network) {
            this.network = network;
            this.cache = new Map();
            this.samples = new Map();
            this.trajectories = new Map();
            this.clearances = new Map();
            this.groupConnections = new Map();
            if (network.junctionGroups) for (const connection of network.connections.values()) {
                const key = network.junctionGroups.get(connection.nodeId);
                if (!this.groupConnections.has(key)) this.groupConnections.set(key, []);
                this.groupConnections.get(key).push(connection);
            }
        }

        trajectory(connection, exitPath = null) {
            const n = this.network, key = n.junctionGroups.get(connection.nodeId);
            const chain = [], visited = new Set();
            let current = connection;
            for (let hop = 0; hop < 128 && current && !visited.has(current.id); hop++) {
                visited.add(current.id); chain.push(current);
                const lane = n.lanes.get(current.toLaneId);
                if (n.junctionGroups.get(lane.toNode) !== key || !lane.exitRoutes?.length) break;
                current = n.connections.get(exitPath ? exitPath[chain.length - 1] : lane.exitRoutes[0]);
            }
            const planKey = chain.map(move => move.id).join('\n');
            if (this.trajectories.has(planKey)) return this.trajectories.get(planKey);
            const points = [], connectionOffsets = new Map(), laneOffsets = new Map(), next = new Map();
            let offset = 0;
            const append = route => {
                points.push(...(points.length ? route.points.slice(1) : route.points));
                offset += route.length;
            };
            // The incoming body can conflict before its centre reaches the link.
            // Include its approach so admission and live motion use one envelope.
            const source = n.lanes.get(connection.fromLaneId);
            const approachStart = Math.max(0, source.path.length - APPROACH);
            laneOffsets.set(source.id, -approachStart);
            append(G.slice(source.path, approachStart, source.path.length));
            for (const [index, current] of chain.entries()) {
                connectionOffsets.set(current.id, offset); append(current.path);
                const lane = n.lanes.get(current.toLaneId);
                laneOffsets.set(lane.id, offset);
                if (index === chain.length - 1) {
                    append(n.junctionGroups.get(lane.toNode) === key ? lane.path
                        : G.slice(lane.path, 0, Math.min(EXIT, lane.path.length))); break;
                }
                append(lane.path);
                next.set(lane.id, chain[index + 1].id);
            }
            const result = { id: `trajectory:${planKey}`, key: planKey, fromLaneId: connection.fromLaneId,
                toLaneId: chain.at(-1).toLaneId, group: key,
                exclusive: chain.some(move => n.lanes.get(move.toLaneId).conflictInterior),
                path: G.path(points), connectionOffsets, laneOffsets, next };
            this.trajectories.set(planKey, result);
            return result;
        }

        sampled(connection) {
            if (this.samples.has(connection.id)) return this.samples.get(connection.id);
            const route = connection.path;
            const count = Math.ceil(route.length / STEP);
            const poses = Array.from({ length: count + 1 }, (_, index) => {
                const station = index === count ? route.length : index * STEP;
                return { station, pose: G.sample(route, station) };
            });
            // The live collision guard sweeps rotation between headings. Include
            // those corner orientations; distance samples alone miss short kinks.
            for (const station of route.arcs.slice(1, -1)) {
                const before = G.sample(route, station - 1e-6), after = G.sample(route, station + 1e-6);
                const turn = Math.atan2(Math.sin(after.angle - before.angle), Math.cos(after.angle - before.angle));
                const steps = Math.max(1, Math.ceil(Math.abs(turn) / .1));
                for (let step = 0; step <= steps; step++) poses.push({ station,
                    pose: { x: before.x, y: before.y, angle: before.angle + turn * step / steps } });
            }
            const spatial = new Collision.Index();
            poses.forEach(({ pose }, index) => spatial.set(index, pose));
            const result = { poses, spatial };
            this.samples.set(connection.id, result);
            return result;
        }

        ranges(firstConnection, secondConnection) {
            const same = firstConnection?.id === secondConnection?.id;
            if (!firstConnection || !secondConnection || same && !firstConnection.connectionOffsets
                || firstConnection.fromLaneId === secondConnection.fromLaneId
                    && !firstConnection.connectionOffsets && !secondConnection.connectionOffsets
                || firstConnection.toLaneId === secondConnection.fromLaneId
                || secondConnection.toLaneId === firstConnection.fromLaneId) return null;
            const cached = this.cache.get(firstConnection);
            if (cached?.has(secondConnection)) return cached.get(secondConnection);
            if (!boundsOverlap(firstConnection, secondConnection)) return null;
            let result = null;
            if (boundsOverlap(firstConnection, secondConnection)) {
                const first = this.sampled(firstConnection), second = this.sampled(secondConnection);
                let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
                for (const b of second.poses) {
                    for (const index of first.spatial.nearby(b.pose)) {
                        const a = first.poses[index];
                        // Following along a path is safe at the ordinary gap.
                        // A loop can return to the same place much later, however.
                        if (same && b.station - a.station < 7) continue;
                        // Cover the space between half-metre samples as well as
                        // the sampled bodies, so a yielding car stops before it.
                        if (!Collision.overlaps(a.pose, b.pose, .12 + STEP / 2)) continue;
                        minA = Math.min(minA, a.station); maxA = Math.max(maxA, a.station);
                        minB = Math.min(minB, b.station); maxB = Math.max(maxB, b.station);
                    }
                }
                if (Number.isFinite(minA)) result = {
                    first: { start: minA, end: maxA },
                    second: { start: minB, end: maxB }
                };
            }
            if (!this.cache.has(firstConnection)) this.cache.set(firstConnection, new Map());
            if (!this.cache.has(secondConnection)) this.cache.set(secondConnection, new Map());
            this.cache.get(firstConnection).set(secondConnection, result);
            if (!same) this.cache.get(secondConnection).set(firstConnection, result && { first: result.second, second: result.first });
            return result;
        }

        overlapsBody(plan, pose, maxStation = Infinity, minStation = 0) {
            const b = plan.path.bounds;
            if (pose.x < b[0] - 3 || pose.x > b[2] + 3 || pose.y < b[1] - 3 || pose.y > b[3] + 3) return false;
            const samples = this.sampled(plan);
            return [...samples.spatial.nearby(pose)].some(index =>
                samples.poses[index].station <= maxStation
                && samples.poses[index].station >= minStation
                && Collision.overlaps(samples.poses[index].pose, pose, .12 + STEP / 2));
        }

        entryClearance(connection) {
            if (this.clearances.has(connection.id)) return this.clearances.get(connection.id);
            const plan = this.trajectory(connection, []);
            const start = plan.connectionOffsets.get(connection.id), end = start + connection.path.length;
            let hold = 7, redHold = 0, exit = 0;
            for (const other of this.groupConnections.get(plan.group) || []) {
                    if (other.fromLaneId === connection.fromLaneId) continue;
                    const conflict = this.ranges(plan, this.trajectory(other, []));
                    if (!conflict) continue;
                    // Queue outside the shared sweep and leave enough downstream
                    // room to clear it; neither rule locks independent lane paths.
                    hold = Math.max(hold, start - conflict.first.start + .6);
                    redHold = Math.max(redHold, start - conflict.first.start + .6);
                    exit = Math.max(exit, conflict.first.end + .6 - end);
            }
            const result = { hold, redHold, exit };
            this.clearances.set(connection.id, result); return result;
        }
    }

    return { Index, APPROACH, EXIT };
});
