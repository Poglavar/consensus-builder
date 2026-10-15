// Deterministic traffic motion over an explicit directed lane graph; no DOM or map dependencies.
// Ordinary routes use mapped connections; physical low-speed escapes are planned separately.
// Signal phases are deliberately illustrative.
(function (root, factory) {
    const geometry = typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry;
    const collision = typeof module !== 'undefined' && module.exports ? require('./collision.js') : root.TrafficCollision;
    const signals = typeof module !== 'undefined' && module.exports ? require('./signal-plan.js') : root.TrafficSignals;
    const movements = typeof module !== 'undefined' && module.exports ? require('./movement-conflicts.js') : root.TrafficMovementConflicts;
    const vehicles = typeof module !== 'undefined' && module.exports ? require('./vehicles.js') : root.TrafficVehicles;
    const drivers = typeof module !== 'undefined' && module.exports ? require('./drivers.js') : root.TrafficDrivers;
    const maneuvers = typeof module !== 'undefined' && module.exports ? require('./maneuvers.js') : root.TrafficManeuvers;
    const surface = typeof module !== 'undefined' && module.exports ? require('./surface.js') : root.TrafficSurface;
    const api = factory(geometry, collision, signals, movements, vehicles, drivers, maneuvers, surface);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficSimulation = api;
})(typeof window !== 'undefined' ? window : null, function (Geometry, Collision, Signals, Movements, Vehicles, Drivers, Maneuvers, Surface) {
    'use strict';
    const GAP = Collision.LENGTH + .4;
    const STEP = 0.1;
    const EXIT_CLEAR = 3.2;
    const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

    function randomGenerator(seed = 42) {
        let state = seed >>> 0;
        return () => {
            state += 0x6D2B79F5;
            let t = state;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    const { path, sample } = Geometry;

    function laneChangeAllowed(from, to) {
        if (!from || !to || from.sectionId !== to.sectionId || from.direction !== to.direction
            || from.fromNode !== to.fromNode || from.toNode !== to.toNode
            || Math.abs(from.stripIndex - to.stripIndex) !== 1
            || Math.abs(from.ordinal - to.ordinal) !== 1) return false;
        const left = to.ordinal < from.ordinal;
        const rule = from.change || 'yes';
        return rule === 'yes' || (left && ['not_right', 'only_left'].includes(rule))
            || (!left && ['not_left', 'only_right'].includes(rule));
    }

    function circulationRegions(lanes, connections) {
        const next = new Map([...lanes.values()].map(lane => [lane.id,
            lane.outgoing.map(id => connections.get(id).toLaneId)]));
        const previous = new Map([...lanes.keys()].map(id => [id, []]));
        for (const [from, targets] of next) for (const to of targets) previous.get(to).push(from);
        // Two iterative depth-first passes find strongly connected regions without a
        // recursion limit. A car must be able to return along known permitted movements.
        const seen = new Set(), order = [];
        for (const id of lanes.keys()) {
            if (seen.has(id)) continue;
            seen.add(id);
            const stack = [{ id, index: 0 }];
            while (stack.length) {
                const current = stack.at(-1), targets = next.get(current.id);
                if (current.index === targets.length) { order.push(current.id); stack.pop(); continue; }
                const to = targets[current.index++];
                if (!seen.has(to)) { seen.add(to); stack.push({ id: to, index: 0 }); }
            }
        }
        seen.clear();
        const regions = new Map();
        for (const id of order.reverse()) {
            if (seen.has(id)) continue;
            const component = [id];
            seen.add(id);
            for (let i = 0; i < component.length; i++) {
                for (const from of previous.get(component[i])) {
                    if (!seen.has(from)) { seen.add(from); component.push(from); }
                }
            }
            if (component.length > 1 || next.get(id).includes(id)) {
                for (const member of component) regions.set(member, id);
            }
        }
        return regions;
    }

    function createNetwork(data) {
        const origin = [(data.bbox[0] + data.bbox[2]) / 2, (data.bbox[1] + data.bbox[3]) / 2];
        const xScale = 111320 * Math.cos(origin[1] * Math.PI / 180);
        const project = p => [(p[0] - origin[0]) * xScale, (p[1] - origin[1]) * 111320];
        const unproject = p => [origin[0] + p[0] / xScale, origin[1] + p[1] / 111320];
        let lanes = new Map();
        for (const lane of data.lanes) {
            if (!lane.points?.every(p => p.length >= 2 && p.every(Number.isFinite))) throw new Error(`Invalid lane geometry: ${lane.id}`);
            const route = path(lane.points.map(project));
            if (route.length < .05) continue;
            lanes.set(lane.id, { ...lane, path: route, outgoing: [], adjacent: [], signals: [] });
        }
        const nodes = new Map(data.nodes.map(node => [node.id, { ...node, incoming: [] }]));
        let connections = new Map();
        for (const connection of data.connections) {
            const from = lanes.get(connection.fromLaneId), to = lanes.get(connection.toLaneId);
            if (!from || !to) continue;
            if (from.toNode !== connection.nodeId || to.fromNode !== connection.nodeId) throw new Error(`Disconnected movement: ${connection.id}`);
            const points = connection.points?.map(project) || [];
            // Use the lane endpoints exactly, including zero-gap continuation links.
            const route = path([from.path.points.at(-1), ...points.slice(1, -1), to.path.points[0]]);
            const item = { ...connection, path: route };
            connections.set(item.id, item);
            from.outgoing.push(item.id);
        }
        ({ lanes, connections } = Geometry.build(lanes, connections, nodes, data.signals));
        for (const record of data.signals) for (const control of record.controls) {
            if (!lanes.has(control.laneId) || !Number.isFinite(control.fraction) || control.fraction < 0 || control.fraction > 1) {
                throw new Error(`Invalid mapped signal control: ${record.id}`);
            }
        }
        const network = { origin, lanes, nodes, connections, project, unproject, data };
        Object.assign(network, Signals.build(network, data.signals));
        return refreshNetwork(network);
    }

    function refreshNetwork(network, fixedGroups = null) {
        const { lanes, connections, nodes } = network;
        for (const node of nodes.values()) node.incoming = [];
        for (const lane of lanes.values()) { lane.outgoing = []; lane.adjacent = []; }
        for (const c of connections.values()) lanes.get(c.fromLaneId)?.outgoing.push(c.id);
        // Preserve all permitted connections for inspection; routing only selects a subset.
        const regions = circulationRegions(lanes, connections);
        for (const lane of lanes.values()) {
            lane.region = regions.get(lane.id);
            // Keep traffic within each region: one-way feeders would otherwise fill a small
            // isolated loop forever. The allowed source graph remains available for inspection.
            lane.routes = lane.outgoing.filter(id => lane.region != null
                && regions.get(connections.get(id).toLaneId) === lane.region);
        }
        const sections = new Map();
        for (const lane of lanes.values()) {
            const key = `${lane.sectionId}:${lane.direction}`;
            if (!sections.has(key)) sections.set(key, []);
            sections.get(key).push(lane);
            nodes.get(lane.toNode)?.incoming.push(lane.id);
        }
        for (const siblings of sections.values()) {
            for (const from of siblings) {
                from.adjacent = siblings.filter(to => laneChangeAllowed(from, to)
                    && to.routes.length && to.region === from.region).map(to => to.id);
                from.neighbours = siblings.filter(to => !to.ghost && to.id !== from.id
                    && Math.abs(to.ordinal - from.ordinal) === 1
                    && Math.abs(to.stripIndex - from.stripIndex) === 1).map(to => to.id);
            }
            const distance = new Map(), queue = siblings.filter(lane => lane.routes.length && !lane.ghost);
            for (const lane of queue) distance.set(lane.id, 0);
            for (let i = 0; i < queue.length; i++) for (const id of queue[i].neighbours) {
                const lane = lanes.get(id);
                if (lane.fromNode !== queue[i].fromNode || lane.toNode !== queue[i].toNode || distance.has(id)) continue;
                distance.set(id, distance.get(queue[i].id) + 1); queue.push(lane);
            }
            for (const lane of siblings) lane.recoveryDistance = distance.get(lane.id) ?? Infinity;
        }
        // Group split physical junctions for route selection and spawn placement.
        const parents = new Map([...nodes.keys()].map(id => [id, id]));
        const exclusiveSections = new Set();
        if (!fixedGroups) {
            const roads = new Map();
            for (const lane of lanes.values()) {
                if (lane.fragment || lane.ghost) continue;
                if (!roads.has(lane.sectionId)) roads.set(lane.sectionId, []);
                roads.get(lane.sectionId).push(lane);
            }
            for (const [id, road] of roads) {
                const forward = road.filter(lane => lane.direction === 'forward');
                const backward = road.filter(lane => lane.direction === 'backward');
                if (!forward.length || !backward.length) continue;
                const envelopes = new Movements.Index(network);
                // A short kink can pinch opposing swept bodies even when lane
                // centres and nominal widths look safe. Mark the physical pinch.
                const envelope = new Collision.Index();
                let poseId = 0;
                for (const lane of forward) {
                    for (const { pose } of envelopes.sampled(lane).poses) envelope.set(poseId++, pose);
                }
                if (backward.some(lane => {
                    for (const { pose } of envelopes.sampled(lane).poses) {
                        for (const id of envelope.nearby(pose)) {
                            if (Collision.overlaps(pose, envelope.positions.get(id), .37)) return true;
                        }
                    }
                    return false;
                })) exclusiveSections.add(id);
            }
        }
        const find = id => { let root = id; while (parents.get(root) !== root) root = parents.get(root); return root; };
        // Signal grouping already identifies the physical junction across its
        // split OSM nodes. Motion must keep the same complete boundary.
        for (const controller of network.controllers?.values() || []) {
            const members = [...controller.cluster?.nodes || []].filter(id => parents.has(id));
            for (const id of members.slice(1)) parents.set(find(id), find(members[0]));
        }
        for (const lane of lanes.values()) {
            if (lane.fragment || lane.ghost) continue;
            const a = nodes.get(lane.fromNode), b = nodes.get(lane.toNode);
            if (!a || !b) continue;
            const distance = a.point && b.point ? Math.hypot(...network.project(a.point).map((v, i) => v - network.project(b.point)[i])) : lane.rawPath?.length || lane.path.length;
            const points = (lane.rawPath || lane.path).points;
            const tightBend = points.some((p, i) => {
                if (!i || i === points.length - 1) return false;
                const before = Math.atan2(p[1] - points[i - 1][1], p[0] - points[i - 1][0]);
                const after = Math.atan2(points[i + 1][1] - p[1], points[i + 1][0] - p[0]);
                return Math.cos(after - before) < Math.cos(Math.PI / 6);
            });
            // Overlapping approach/exit envelopes must belong to one plan: a
            // short link cannot release its car between the two hazards.
            if (exclusiveSections.has(lane.sectionId) || distance < 18
                || lane.path.length < Movements.APPROACH + Movements.EXIT
                || lane.width < Collision.WIDTH + .3 || tightBend) {
                parents.set(find(a.id), find(b.id));
            }
        }
        for (const lane of lanes.values()) if (!fixedGroups && !lane.fragment && !lane.ghost) lane.conflictInterior = exclusiveSections.has(lane.sectionId);
        const junctionGroups = new Map([...nodes.keys()].map(id => [id, fixedGroups?.get(id) ?? find(id)]));
        network.junctionGroups = junctionGroups;
        // Prefer a clear exit from a split junction over an internal loop.
        const reverse = new Map(), distance = new Map(), queue = [];
        for (const lane of lanes.values()) {
            lane.exitRoutes = [];
            if (junctionGroups.get(lane.fromNode) !== junctionGroups.get(lane.toNode)) {
                distance.set(lane.id, 0); queue.push(lane.id);
            }
            for (const id of lane.routes) {
                const c = connections.get(id);
                if (!reverse.has(c.toLaneId)) reverse.set(c.toLaneId, []);
                reverse.get(c.toLaneId).push(c);
            }
        }
        for (let i = 0; i < queue.length; i++) {
            const target = lanes.get(queue[i]);
            for (const c of reverse.get(target.id) || []) {
                const from = lanes.get(c.fromLaneId), key = junctionGroups.get(from.toNode);
                if (junctionGroups.get(from.fromNode) !== key) continue;
                const score = c.path.length + (junctionGroups.get(target.toNode) === key ? target.path.length + distance.get(target.id) : EXIT_CLEAR);
                if (score < (distance.get(from.id) ?? Infinity) - 1e-6) {
                    distance.set(from.id, score); queue.push(from.id);
                }
            }
        }
        for (const lane of lanes.values()) {
            const key = junctionGroups.get(lane.fromNode);
            if (key !== junctionGroups.get(lane.toNode) || !distance.has(lane.id)) continue;
            lane.exitRoutes = lane.routes.filter(id => {
                const c = connections.get(id), target = lanes.get(c.toLaneId);
                const score = c.path.length + (junctionGroups.get(target.toNode) === key ? target.path.length + (distance.get(target.id) ?? Infinity) : EXIT_CLEAR);
                return score <= distance.get(lane.id) + 1e-5;
            });
        }
        const spawnLanes = [...lanes.values()].filter(lane => lane.path.length > 25 && lane.routes.length && lane.highway !== 'service' && !lane.ghost && !(lane.width < Collision.WIDTH + .3)
            && junctionGroups.get(lane.fromNode) !== junctionGroups.get(lane.toNode));
        const weights = [];
        let totalWeight = 0;
        for (const lane of spawnLanes) { totalWeight += lane.path.length; weights.push(totalWeight); }
        const movementsByApproach = new Map();
        for (const connection of connections.values()) {
            const from = lanes.get(connection.fromLaneId);
            const key = `${junctionGroups.get(connection.nodeId)}:${from.sectionId}:${from.direction}`;
            if (!movementsByApproach.has(key)) movementsByApproach.set(key, []);
            movementsByApproach.get(key).push(connection.id);
        }
        return Object.assign(network, { spawnLanes, weights, totalWeight, movementsByApproach });
    }

    function signalAspect(signal, phaseKey, time, enabled = true) {
        return Signals.aspect(signal, phaseKey, time, enabled);
    }

    function signalState(network, lane, time, enabled = true, position = 0) {
        const control = lane.signals.find(item => item.stopS >= position - 1e-6);
        return control ? signalAspect(network.signals.get(control.signalId), control.phase, time, enabled) : 'green';
    }

    function signalStoppingDistance(network, lane, position, time, enabled) {
        if (!enabled) return Infinity;
        const control = lane.signals.find(item => item.stopS >= position - 1e-6
            && signalAspect(network.signals.get(item.signalId), item.phase, time) !== 'green');
        return control ? Math.max(0, control.stopS - position) : Infinity;
    }

    class Simulation {
        constructor(network, { count = 220, seed = 42, signals = true, laneChangeRate = .055, physicalNetwork = network } = {}) {
            this.network = network;
            this.random = randomGenerator(seed);
            this.time = 0;
            this.accumulator = 0;
            this.signals = signals;
            this.laneChangeRate = laneChangeRate;
            this.cars = [];
            this.crossings = 0;
            this.laneChanges = 0;
            this.nextId = 1;
            this.targetCount = 0;
            this.listeners = new Set();
            this.gates = [];
            this.physicalNetwork = physicalNetwork;
            this.space = null;
            this.planningTask = null;
            this.planningQueue = [];
            this.nextPlanAt = 0;
            this.setCount(count);
        }

        choose(list) { return list.length ? list[Math.floor(this.random() * list.length)] : null; }

        driverState(car) { return Drivers.view(car); }

        projectStation(route, pose) {
            const near = Geometry.nearest(route, [pose.x, pose.y]);
            if (near.s < .01 || near.s > route.length - .01) {
                const end = sample(route, near.s < .01 ? 0 : route.length);
                const along = (pose.x - end.x) * Math.cos(end.angle) + (pose.y - end.y) * Math.sin(end.angle);
                return near.s < .01 ? Math.min(0, along) : route.length + Math.max(0, along);
            }
            return near.s;
        }

        localStops(start) {
            // Include the search radius, its final landing curve and a full bus body.
            const horizon = Maneuvers.MAX_DISTANCE + Maneuvers.MAX_TAIL + Vehicles.get('bus').length;
            return [...this.network.lanes.values()].filter(lane => lane.signals.length).map(lane => ({ lane,
                controls: lane.signals.filter(control => {
                    const p = sample(lane.path, control.stopS);
                    return Math.hypot(p.x - start.x, p.y - start.y) <= horizon;
                }) })).filter(record => record.controls.length);
        }

        maneuverBlocked(car, pose, before, onPavement = true, stops = car.maneuver?.stops || []) {
            const n = this.network, vehicle = Vehicles.get(car.vehicleType);
            const body = { ...pose, length: vehicle.length, width: vehicle.width };
            if (onPavement && !this.space.contains(pose, vehicle)) return true;
            if ((n.closureBlocks || []).some(block => Collision.overlapsRectangle(body, block.pose, block.length, block.width))) return true;
            if (this.signals && before) {
                // Check actual local stop-line crossings in the direction they control.
                // Reversing away from a stop never grants permission to cross it forwards.
                for (const { lane, controls } of stops) {
                    if (pose.x < lane.path.bounds[0] - 4 || pose.x > lane.path.bounds[2] + 4
                        || pose.y < lane.path.bounds[1] - 4 || pose.y > lane.path.bounds[3] + 4) continue;
                    const a = Geometry.nearest(lane.path, [before.x, before.y]), b = Geometry.nearest(lane.path, [pose.x, pose.y]);
                    if (a.distance > lane.width / 2 + .2 || b.distance > lane.width / 2 + .2 || b.s <= a.s) continue;
                    for (const control of controls) {
                        if (a.s <= control.stopS + 1e-6 && b.s > control.stopS + 1e-6
                            && signalAspect(n.signals.get(control.signalId), control.phase, this.time) !== 'green') return true;
                    }
                }
            }
            return false;
        }

        maneuverClear(car, pose, before, onPavement = true, stops) {
            const vehicle = Vehicles.get(car.vehicleType);
            const body = { ...pose, length: vehicle.length, width: vehicle.width };
            const previous = { ...before, length: vehicle.length, width: vehicle.width };
            return !this.maneuverBlocked(car, pose, before, onPavement, stops)
                && this.bodyIndex.blocker(car.id, body, previous) == null
                && this.maneuverSpaceBlocker(car, body, previous) == null;
        }

        updateManeuverSpace() {
            const index = this.maneuverSpace = new Collision.Index();
            for (const car of this.cars) {
                const maneuver = car.maneuver;
                if (!maneuver) continue;
                const vehicle = Vehicles.get(car.vehicleType);
                let previous = this.pose(car);
                // Let a vehicle finish its bounded parking-speed manoeuvre.
                // Following into its next gear change can otherwise wedge it again.
                segments: for (let part = maneuver.index; part < maneuver.segments.length; part++) {
                    const segment = maneuver.segments[part];
                    for (let s = part === maneuver.index ? maneuver.s : 0; s < segment.path.length + .4; s += .4) {
                        const pose = sample(segment.path, Math.min(s, segment.path.length));
                        const body = { ...pose, angle: pose.angle + (segment.gear < 0 ? Math.PI : 0),
                            length: vehicle.length, width: vehicle.width };
                        if (this.bodyIndex.blocker(car.id, body, previous) != null) break segments;
                        index.set({ carId: car.id }, body);
                        previous = body;
                    }
                }
            }
        }

        maneuverSpaceBlocker(car, pose, before) {
            return this.maneuverSpace?.blocker(null, pose, before, owner => owner.carId === car.id)?.carId ?? null;
        }

        advanceSearch() {
            const task = this.planningTask;
            if (!task) return;
            const current = this.pose(task.car);
            if (task.car.retired || task.car.change !== task.change || task.car.maneuver !== task.maneuver || task.network !== this.network
                || Math.hypot(current.x - task.start.x, current.y - task.start.y) > .2
                || Math.abs(Math.atan2(Math.sin(current.angle - task.start.angle), Math.cos(current.angle - task.start.angle))) > .08) {
                task.car.planning = false; this.planningTask = null; return;
            }
            task.search.advance(45);
            if (!task.search.done) return;
            const plan = task.search.result;
            if (plan && Maneuvers.validate(plan, (pose, before) => this.maneuverClear(task.car, pose, before, true, task.stops), current)) {
                plan.stops = task.stops; task.car.change = null; task.car.maneuver = plan; task.car.speed = 0;
            }
            task.car.planning = false; this.planningTask = null;
            this.nextPlanAt = this.time + .7;
        }

        yieldWinner(a, b) {
            const aa = this.routeInfo(a), bb = this.routeInfo(b);
            const am = aa.move || this.network.connections.get(a.next), bm = bb.move || this.network.connections.get(b.next);
            if (am && bm && am.toLaneId === bm.toLaneId) {
                const receiving = this.network.lanes.get(am.toLaneId).path;
                const difference = this.projectStation(receiving, this.pose(a)) - this.projectStation(receiving, this.pose(b));
                if (Math.abs(difference) > .2) return difference > 0 ? a : b;
            }
            return (a.driver?.priority ?? a.id) < (b.driver?.priority ?? b.id) ? a : b;
        }

        backToGiveWay(car) {
            const { lane, move, route } = this.routeInfo(car);
            const joined = move ? path([...lane.path.points, ...route.points.slice(1)]) : route;
            const station = (move ? lane.path.length : 0) + car.s;
            const start = this.pose(car), stops = this.localStops(start);
            for (const distance of [3.2, 2, 1, .5, .2]) {
                const end = Math.max(.1, station - distance);
                if (station - end < .15) continue;
                const reverse = Geometry.slice(joined, end, station);
                const intoLane = move && end < lane.path.length;
                const landing = intoLane || !move ? { mode: 'lane', laneId: lane.id, connectionId: null, s: end, next: move?.id || car.next }
                    : { mode: 'connection', laneId: lane.id, connectionId: move.id, s: end - lane.path.length, next: car.next };
                const plan = { kind: 'yield', segments: [{ gear: -1, path: path([...reverse.points].reverse()) }],
                    landing, index: 0, s: 0, travelled: 0, stops };
                // A retreat retraces an already mapped route. It needs actual rear space,
                // and never moves through another vehicle, closure, or forward red stop.
                if (Maneuvers.validate(plan, (pose, before) => this.maneuverClear(car, pose, before, false, stops), start)) {
                    car.maneuver = plan; car.speed = 0; return true;
                }
            }
            return false;
        }

        tryDriverAction(car, occupied, previousBlocker) {
            const d = car.driver;
            const activePath = car.maneuver || car.change?.recovery;
            if (!d || car.planning || car.change && !car.change.recovery || car.speed > .4
                || (activePath ? d.stuckFor : car.blockedFor || 0) < d.reaction) return;
            const partner = this.carsById.get(previousBlocker);
            const mutual = partner && this.previousWait.get(partner.id) === car.id;
            if (!activePath && mutual && this.yieldWinner(car, partner) !== car && this.time >= (d.nextYieldAt || 0)) {
                d.nextYieldAt = this.time + 1.5 + this.random() * 2;
                if (this.backToGiveWay(car)) return;
            }
            if (d.stuckFor < d.patience || this.time < d.nextTryAt) return;
            if (!this.planningQueue.includes(car)) this.planningQueue.push(car);
            if (this.planningTask || this.time < this.nextPlanAt || this.planningQueue[0] !== car) return;
            this.planningQueue.shift();
            this.nextPlanAt = this.time + .7;
            d.nextTryAt = this.time + 5 + this.random() * 8;
            const limits = this.limits(car, occupied);
            if (!activePath && limits.signal < .4) return;
            if (!this.physicalNetwork.data?.surfaceLanes) return;
            if (!this.space) {
                const surface = Surface.build(this.physicalNetwork, this.physicalNetwork.data.surfaceLanes);
                this.space = new Maneuvers.Space([...surface.lanes, ...surface.connections]);
            }
            const n = this.network, { lane, move } = this.routeInfo(car), start = this.pose(car), goals = [];
            const addLane = (target, kind) => {
                if (!target || target.ghost || !target.routes.length || target.width < Vehicles.get(car.vehicleType).width + .2) return;
                const near = Geometry.nearest(target.path, [start.x, start.y]);
                if (near.distance > 15 || target.path.length - near.s < 4) return;
                if (kind === 'bypass' && near.distance < .75 && Math.cos(near.angle - start.angle) > .85) return;
                let maxS = target.path.length;
                for (const signal of target.signals) {
                    if (signal.stopS >= near.s - .1 && signalAspect(n.signals.get(signal.signalId), signal.phase, this.time) !== 'green') maxS = Math.min(maxS, signal.stopS - .2);
                }
                goals.push({ route: target.path, kind, maxS, minS: kind === 'escape' ? near.s + 4 : 0,
                    landing: { mode: 'lane', laneId: target.id, connectionId: null } });
            };
            if (move) addLane(n.lanes.get(move.toLaneId), 'escape');
            // A wedged forward-only lane change may need to reverse before it
            // can reach either neighbouring lane. Keep its exact current pose.
            const current = move ? n.lanes.get(move.toLaneId) : lane;
            const changingTo = car.change?.recovery && n.lanes.get(car.change.to);
            const landingAt = car.maneuver && n.lanes.get(car.maneuver.landing.laneId);
            const neighbours = new Set([current, changingTo, landingAt].filter(Boolean)
                .flatMap(source => source.neighbours || []));
            for (const id of neighbours) addLane(n.lanes.get(id), 'bypass');
            for (const id of lane.routes) {
                const connection = n.connections.get(id);
                if (connection.id === move?.id || connection.id === car.next || !this.canEnter(car, connection, occupied, false)) continue;
                addLane(n.lanes.get(connection.toLaneId), 'reroute');
            }
            const roads = new Set([lane.sectionId, move && n.lanes.get(move.toLaneId).sectionId].filter(Boolean));
            for (const target of n.lanes.values()) {
                if (!roads.has(target.sectionId) || target.id === lane.id || target.ghost) continue;
                const near = Geometry.nearest(target.path, [start.x, start.y]);
                if (near.distance <= 9 && Math.cos(near.angle - start.angle) < -.5) addLane(target, 'turnaround');
            }
            if (!goals.length) return;
            const stops = this.localStops(start);
            const search = new Maneuvers.Search({ start, vehicle: Vehicles.get(car.vehicleType), goals,
                clear: (pose, before) => this.maneuverClear(car, pose, before, true, stops) });
            this.planningTask = { search, car, start, network: n, stops, change: car.change, maneuver: car.maneuver }; car.planning = true;
            this.nextPlanAt = this.time + .7;
        }

        chooseRoute(lane, car = null) {
            if (!lane.fragment) {
                return this.choose(lane.exitRoutes?.length ? lane.exitRoutes : lane.routes);
            }
            const moves = lane.routes.map(id => this.network.connections.get(id));
            if (car?.returnLaneId) {
                const target = this.network.fragments?.get(car.returnLaneId)?.[0];
                const returned = moves.filter(c => c.type === 'bypass').find(c => {
                    const to = this.network.lanes.get(c.toLaneId);
                    if (!target || Math.abs(to.ordinal - target.ordinal) >= Math.abs(lane.ordinal - target.ordinal)) return false;
                    return !(this.network.closures || []).some(closure => closure.laneId === car.returnLaneId && closure.end + 2.5 > to.startS);
                });
                if (returned) return returned.id;
            }
            return moves.find(c => c.type !== 'bypass')?.id || this.choose(lane.routes);
        }

        carOccupancies(car) {
            if (car.maneuver) {
                const pose = this.pose(car), { lane, move, route } = this.routeInfo(car);
                const segment = car.maneuver.segments[car.maneuver.index];
                const reversingTo = segment.gear < 0 ? sample(segment.path, segment.path.length) : null;
                // Drivers leave the already-started reversing run clear instead
                // of following into the space the vehicle is backing towards.
                const station = Math.min(this.projectStation(route, pose),
                    reversingTo ? this.projectStation(route, reversingTo) : Infinity);
                const entries = move ? [[move.id, station], [lane.id, lane.path.length + station],
                    [move.toLaneId, station - route.length]] : [[lane.id, station]];
                const landing = car.maneuver.landing;
                const target = landing.mode === 'connection' ? this.network.connections.get(landing.connectionId) : this.network.lanes.get(landing.laneId);
                const near = Geometry.nearest(target.path, [pose.x, pose.y]);
                if (reversingTo || near.distance < Vehicles.get(car.vehicleType).width / 2 + 2) {
                    entries.push([target.id, Math.min(near.s, reversingTo
                        ? this.projectStation(target.path, reversingTo) : Infinity)]);
                }
                return entries;
            }
            if (car.change?.recovery) {
                const change = car.change;
                const entries = this.carOccupancies({ ...car, change: null });
                const target = change.toConnectionId ? this.network.connections.get(change.toConnectionId) : this.network.lanes.get(change.to);
                const pose = this.pose(car), s = Geometry.nearest(target.path, [pose.x, pose.y]).s;
                entries.push([target.id, s]);
                if (change.toConnectionId) entries.push([target.toLaneId, s - target.path.length]);
                return entries;
            }
            if (car.mode === 'lane') {
                const entries = [[car.laneId, car.s]];
                if (car.change) entries.push([car.change.to,
                    car.s * this.network.lanes.get(car.change.to).path.length / this.network.lanes.get(car.laneId).path.length]);
                return entries;
            }
            const connection = this.network.connections.get(car.connectionId);
            const entries = [[car.connectionId, car.s], [connection.toLaneId, -Math.max(0, connection.path.length - car.s)]];
            entries.push([connection.fromLaneId, this.network.lanes.get(connection.fromLaneId).path.length + car.s]);
            return entries;
        }

        occupants() {
            const occupied = new Map();
            const add = (id, car, s) => {
                if (!occupied.has(id)) occupied.set(id, []);
                occupied.get(id).push({ car, s });
            };
            for (const car of this.cars) {
                for (const [id, s] of this.carOccupancies(car)) add(id, car, s);
            }
            return occupied;
        }

        spawn() {
            const n = this.network;
            if (!n.spawnLanes.length) return false;
            const occupied = this.occupants();
            const vehicle = Vehicles.pick(this.random), driver = Drivers.create(this.random, this.time);
            const candidate = { vehicleType: vehicle.type, driver, speed: 0 };
            for (let attempt = 0; attempt < 80; attempt++) {
                const pick = this.random() * n.totalWeight;
                let lo = 0, hi = n.weights.length - 1;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (n.weights[mid] < pick) lo = mid + 1; else hi = mid; }
                const lane = n.spawnLanes[lo];
                if (lane.width < vehicle.width + .25 || lane.path.length < vehicle.length * 3) continue;
                const s = Math.max(8, vehicle.length / 2 + 2) + this.random() * Math.max(0, lane.path.length - Math.max(32, vehicle.length + 24));
                if ((occupied.get(lane.id) || []).some(entry => Math.abs(entry.s - s)
                    < Math.max(GAP * 2, (entry.s > s ? Drivers.gap(candidate, entry.car) : Drivers.gap(entry.car, candidate)) + 2))) continue;
                const pose = { ...sample(lane.path, s), length: vehicle.length, width: vehicle.width };
                if (this.cars.some(other => Collision.overlaps(pose, this.pose(other)))) continue;
                this.cars.push({ id: this.nextId++, laneId: lane.id, mode: 'lane', s, speed: 0,
                    cruise: (7.5 + this.random() * 4.5) * vehicle.cruiseFactor, color: Math.floor(this.random() * 7),
                    vehicleType: vehicle.type, driver,
                    next: this.chooseRoute(lane), state: 'driving', change: null,
                    cooldown: this.time + 4 + this.random() * 10 });
                return true;
            }
            return false;
        }

        setCount(count) {
            this.targetCount = clamp(Math.round(count), 0, 600);
            while (this.cars.length > this.targetCount) this.retire(this.cars.at(-1));
            while (this.cars.length < this.targetCount && this.spawn()) { /* bounded by targetCount */ }
        }

        retire(car) {
            this.cars.splice(this.cars.indexOf(car), 1);
            car.retired = true;
        }

        entryBlocker(car, connection, occupied, checkSignal = true) {
            if (!connection) return { kind: 'noExit' };
            const lane = this.network.lanes.get(car.laneId);
            if (checkSignal && signalState(this.network, lane, this.time, this.signals, car.s) !== 'green') return { kind: 'signal' };
            if (this.gates.some(gate => gate.blocksEntry?.(car, connection, this))) return { kind: 'closure' };
            return null;
        }
        canEnter(car, connection, occupied, checkSignal = true) { return this.entryBlocker(car, connection, occupied, checkSignal) == null; }

        tryRecovery(car, occupied) {
            if (car.planning || car.change || car.maneuver || (car.blockedFor || 0) < (car.driver?.reaction || 1)) return;
            const n = this.network, { lane, move, route } = this.routeInfo(car), start = this.pose(car);
            const choices = [];
            const consider = (target, mode, station) => {
                const source = mode === 'connection' ? n.lanes.get(target.fromLaneId) : target;
                const exit = mode === 'connection' ? n.lanes.get(target.toLaneId) : target;
                const current = move ? n.lanes.get(move.toLaneId) : lane;
                const intermediate = !exit.routes.length && exit.recoveryDistance < current.recoveryDistance;
                if ((!exit.routes.length && !intermediate) || source.ghost) return;
                const near = Geometry.nearest(target.path, [start.x, start.y]);
                if (near.distance > 6 || Math.cos(near.angle - start.angle) < .8) return;
                if (mode === 'connection' && signalState(n, source, this.time, this.signals,
                    Geometry.nearest(source.path, [start.x, start.y]).s) !== 'green') return;
                let endS = Math.min(target.path.length, station ?? near.s + 8);
                if (mode === 'lane') {
                    for (const control of target.signals) if (control.stopS >= near.s - 1e-6) endS = Math.min(endS, control.stopS - .2);
                }
                if (endS < near.s - .01) return;
                const probe = { ...car, change: null, mode, laneId: source.id,
                    connectionId: mode === 'connection' ? target.id : null, s: endS,
                    next: (exit.exitRoutes?.length ? exit.exitRoutes : exit.routes)[0] };
                const space = this.limits(probe, occupied);
                if (space.clearance < 1 || space.gate < .1 || space.signal < .1) return;
                const end = sample(target.path, endS), path = Geometry.taper(start, end);
                if (path.length < 1 || path.length > 22) return;
                // A tactical change may cross a lane marking, never a barrier.
                for (let s = 0; s <= path.length + .5; s += .5) {
                    const pose = { ...sample(path, Math.min(s, path.length)), length: start.length, width: start.width };
                    if ((n.closureBlocks || []).some(block => Collision.overlapsRectangle(pose, block.pose, block.length, block.width))) return;
                }
                choices.push({ to: source.id, toConnectionId: mode === 'connection' ? target.id : null,
                    toS: endS, path, s: 0, progress: 0, recovery: true,
                    score: near.distance + path.length * .05 + (intermediate ? 4 + exit.recoveryDistance * 8 : 0) });
            };
            if (!move) for (const id of lane.neighbours || []) {
                const target = n.lanes.get(id), near = Geometry.nearest(target.path, [start.x, start.y]);
                if (near.distance > 6 || Math.cos(near.angle - start.angle) < .8) continue;
                if (target.path.length - near.s < 8) {
                    const routes = target.routes.length ? target.routes : Number.isFinite(target.recoveryDistance) ? target.outgoing : [];
                    for (const id of routes) consider(n.connections.get(id), 'connection', Math.min(8, n.connections.get(id).path.length));
                }
                consider(target, 'lane');
            }
            if (move) {
                const key = `${n.junctionGroups.get(move.nodeId)}:${lane.sectionId}:${lane.direction}`;
                for (const id of n.movementsByApproach.get(key) || []) {
                    const target = n.connections.get(id), from = n.lanes.get(target.fromLaneId);
                    if (id === move.id || Math.abs(from.ordinal - lane.ordinal) > 1) continue;
                    consider(target, 'connection');
                }
                const receiving = n.lanes.get(move.toLaneId);
                for (const id of receiving.neighbours || []) consider(n.lanes.get(id), 'lane');
            }
            if (!choices.length) return;
            car.change = choices.sort((a, b) => a.score - b.score)[0];
            car.state = 'changing';
        }

        tryLaneChange(car, occupied) {
            const from = this.network.lanes.get(car.laneId);
            if (this.gates.length || from.fragment || car.planning || car.change || car.maneuver || car.speed < 2 || car.s < 15 || from.path.length - car.s < Math.max(40, car.speed * 5)
                || this.time < car.cooldown || this.random() >= this.laneChangeRate * STEP) return;
            const candidates = from.adjacent.filter(id => {
                const to = this.network.lanes.get(id);
                const s = car.s * to.path.length / from.path.length;
                return !(occupied.get(id) || []).some(entry => entry.car !== car
                    && Math.abs(entry.s - s) < (entry.s > s ? Drivers.gap(car, entry.car) : Drivers.gap(entry.car, car)) + car.speed);
            });
            const to = this.choose(candidates);
            if (!to) return;
            car.change = { to, progress: 0, duration: 3.2 };
            car.state = 'changing';
        }

        advance(seconds) {
            if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Simulation time must be finite and nonnegative.');
            this.accumulator += Math.min(seconds, 2);
            while (this.accumulator >= STEP - 1e-9) { this.step(); this.accumulator -= STEP; }
        }

        routeInfo(car) {
            const lane = this.network.lanes.get(car.laneId);
            const move = car.mode === 'connection' ? this.network.connections.get(car.connectionId) : null;
            return { lane, move, route: move ? move.path : lane.path, id: move ? move.id : lane.id };
        }

        limits(car, occupied) {
            const n = this.network, { lane, move, route, id } = this.routeInfo(car);
            let clearance = Infinity, leader = null, gapRatio = 1;
            const ahead = (key, station, ratio = 1, receiving = false) => {
                for (const entry of occupied.get(key) || []) {
                    if (receiving && entry.car.mode === 'connection') {
                        const other = n.connections.get(entry.car.connectionId);
                        if (other.toLaneId === key && other.id !== move.id
                            && other.fromLaneId !== move.fromLaneId) continue;
                    }
                    const distance = (entry.s - station - Drivers.gap(car, entry.car)) / ratio;
                    if (entry.car.id !== car.id && entry.s >= station - 1e-7 && distance < clearance) {
                        clearance = distance; leader = entry.car.id; gapRatio = ratio;
                    }
                }
            };
            ahead(id, car.s);
            if (move) {
                ahead(move.toLaneId, car.s - route.length, 1, true);
                ahead(move.fromLaneId, lane.path.length + car.s);
            }
            if (car.change && !car.change.recovery) {
                const target = n.lanes.get(car.change.to), ratio = target.path.length / lane.path.length;
                ahead(target.id, car.s * ratio, ratio);
            }
            let signal = move ? Infinity : signalStoppingDistance(n, lane, car.s, this.time, this.signals);
            if (car.change && !car.change.recovery) {
                const target = n.lanes.get(car.change.to), ratio = target.path.length / lane.path.length;
                signal = Math.min(signal, signalStoppingDistance(n, target, car.s * ratio, this.time, this.signals) / ratio);
            }
            const connection = !move && n.connections.get(car.next);
            const intended = move || connection;
            if (intended) {
                const receiving = n.lanes.get(intended.toLaneId).path, currentPose = this.pose(car);
                const station = this.projectStation(receiving, currentPose);
                for (const entry of occupied.get(intended.toLaneId) || []) {
                    const other = entry.car;
                    if (other.id === car.id || other.mode !== 'connection' || other.maneuver) continue;
                    const otherMove = n.connections.get(other.connectionId);
                    if (otherMove.toLaneId !== intended.toLaneId || otherMove.fromLaneId === intended.fromLaneId) continue;
                    const otherPose = this.pose(other), range = (Vehicles.get(car.vehicleType).length + Vehicles.get(other.vehicleType).length) / 2 + 3;
                    if (Math.hypot(otherPose.x - currentPose.x, otherPose.y - currentPose.y) > range) continue;
                    const otherStation = this.projectStation(receiving, otherPose), delta = otherStation - station;
                    if (delta < -.2 || Math.abs(delta) <= .2 && this.yieldWinner(car, other) === car) continue;
                    const distance = Math.max(0, delta - Drivers.gap(car, other));
                    if (distance < clearance) { clearance = distance; leader = other.id; gapRatio = 1; }
                }
            }
            const entry = move ? null : car.change ? { kind: 'changing' }
                : this.entryBlocker(car, connection, occupied, false);
            const available = !!move || entry == null;
            // Only an actual stop line ahead controls this lane. A light already
            // passed cannot stop a car again at the lane/connector boundary.
            const entering = !!move || available && signalState(n, lane, this.time, this.signals, car.s) === 'green';
            const gate = Math.min(Infinity, ...this.gates.map(item => item.distance?.(car, this) ?? Infinity));
            const entryDistance = available ? Infinity : Math.max(0, route.length - car.s);
            return { clearance, gapRatio, signal, connection, entering, available, entry, entryDistance, leader,
                stopping: Math.max(0, Math.min(clearance, signal, gate, entryDistance)), gate };
        }

        signalAhead(car, stopping = false) {
            if (!this.signals || car.mode !== 'lane') return null;
            const lane = this.network.lanes.get(car.laneId), approaches = [{ lane, ratio: 1 }];
            if (car.change) {
                const target = this.network.lanes.get(car.change.to);
                approaches.push({ lane: target, ratio: target.path.length / lane.path.length });
            }
            const controls = approaches.flatMap(({ lane: approach, ratio }) => approach.signals
                .filter(control => control.stopS >= car.s * ratio - 1e-6)
                .map(control => {
                    const signal = this.network.signals.get(control.signalId);
                    return { id: signal.id, point: signal.point, sourceIds: signal.sourceIds, name: signal.name, direction: signal.direction,
                        aspect: signalAspect(signal, control.phase, this.time),
                        distance: Math.max(0, (control.stopS - car.s * ratio) / ratio),
                        stop: sample(approach.path, control.stopS) };
                }));
            return controls.filter(control => !stopping || control.aspect !== 'green')
                .sort((a, b) => a.distance - b.distance)[0] || null;
        }

        inspectCar(car) {
            const signal = this.signalAhead(car);
            if (car.speed >= .05) return { kind: 'moving', speed: car.speed * 3.6, signal };
            if (car.change?.blockerId != null) return { kind: 'following', carId: car.change.blockerId, signal };
            if (car.collisionBlocker != null) return { kind: 'collision', carId: car.collisionBlocker, signal };
            const limits = this.limits(car, this.occupants());
            // The nearest constraint determines where this vehicle must wait.
            // A red farther along the approach is not the cause of a queue here.
            const constraints = [
                { kind: 'following', carId: limits.leader, distance: limits.clearance },
                { ...limits.entry, distance: limits.entryDistance },
                { kind: 'closure', distance: limits.gate },
                { kind: 'signal', distance: limits.signal }
            ].filter(item => item.kind && Number.isFinite(item.distance))
                .sort((a, b) => a.distance - b.distance);
            const reason = constraints[0];
            if (reason && reason.distance < .1) return { ...reason, signal: reason.kind === 'signal' ? this.signalAhead(car, true) : signal };
            return { kind: 'starting', signal };
        }

        move(car, distance, occupied) {
            let remaining = distance, travelled = 0;
            // Carry travel through zero-length links and lane fragments in this same tick.
            // A topology cut is not a braking point.
            for (let part = 0; part < 64; part++) {
                const { lane, move, route } = this.routeInfo(car), limits = this.limits(car, occupied);
                const travel = Math.max(0, Math.min(remaining, route.length - car.s, limits.stopping));
                car.s += travel; travelled += travel; remaining -= travel;
                if (route.length - car.s > 1e-6 || car.change) break;
                if (!move) {
                    if (!limits.entering) break;
                    const c = limits.connection;
                    car.mode = 'connection'; car.connectionId = c.id; car.s = 0;
                    car.traversed.push(c.id);
                } else {
                    const next = this.network.lanes.get(move.toLaneId);
                    car.mode = 'lane'; car.laneId = next.id; car.connectionId = null; car.s = 0;
                    if (move.type === 'bypass') car.returnLaneId ||= lane.baseLaneId || lane.id;
                    if (next.baseLaneId === car.returnLaneId) car.returnLaneId = null;
                    car.next = this.chooseRoute(next, car); car.state = 'driving';
                    if (move.type === 'bypass') this.laneChanges++;
                    if (this.network.nodes.get(move.nodeId)?.degree >= 3) this.crossings++;
                }
                if (remaining < 1e-7 && this.routeInfo(car).route.length > 1e-7) break;
            }
            return travelled;
        }

        advanceCar(car, distance, occupied) {
            if (car.maneuver) {
                const m = car.maneuver, segment = m.segments[m.index], start = this.pose(car);
                m.blockerId = null;
                const remaining = segment.path.length - m.s;
                const travel = this.time < (m.shiftUntil || 0) ? 0 : Math.min(distance, remaining);
                m.s += travel;
                const after = Maneuvers.pose(m);
                if (this.maneuverBlocked(car, after, start, m.kind !== 'yield')) { m.s -= travel; return 0; }
                m.travelled += travel;
                const { route } = this.routeInfo(car);
                car.s = this.projectStation(route, after);
                if (segment.path.length - m.s < 1e-6) {
                    if (m.index + 1 < m.segments.length) {
                        m.index++; m.s = 0;
                        if (m.segments[m.index].gear !== segment.gear) { m.shiftUntil = this.time + .6; car.speed = 0; }
                    } else {
                        // The tick's swept-body guard also checks the final lane pose.
                        // Projected lane-change occupancies are queue reservations, not
                        // physical obstacles: they must not trap a completed retreat.
                        const oldMove = car.mode === 'connection' && this.network.connections.get(car.connectionId);
                        Object.assign(car, m.landing); car.maneuver = null; car.change = null;
                        car.next = m.landing.next || (car.mode === 'lane' ? this.chooseRoute(this.network.lanes.get(car.laneId), car) : car.connectionId);
                        if (oldMove && m.landing.laneId === oldMove.toLaneId && this.network.nodes.get(oldMove.nodeId)?.degree >= 3) this.crossings++;
                        if (m.kind !== 'yield') this.laneChanges++;
                        car.maneuverCompletedAt = this.time;
                        car.lastManeuver = { kind: m.kind, gearChanges: m.segments.length - 1, distance: m.travelled };
                        car.blockedFor = 0; car.cooldown = this.time + 6;
                    }
                }
                return travel;
            }
            if (car.change?.recovery) {
                const change = car.change, { route, move } = this.routeInfo(car);
                const limits = this.limits(car, occupied);
                const remaining = change.path.length - change.s;
                let travel = Math.max(0, Math.min(distance, remaining, limits.signal, limits.gate));
                change.blockerId = null;
                if (remaining - travel < .02) {
                    const target = change.toConnectionId ? this.network.connections.get(change.toConnectionId) : null;
                    const landing = { ...car, change: null, mode: target ? 'connection' : 'lane',
                        laneId: change.to, connectionId: target?.id, s: change.toS };
                    for (const [key, s] of this.carOccupancies(landing)) {
                        if (!this.network.lanes.has(key) || s < 0) continue;
                        const blocker = (occupied.get(key) || []).find(entry => entry.car.id !== car.id
                            && entry.s >= 0 && Math.abs(entry.s - s) < (entry.s > s ? Drivers.gap(car, entry.car) : Drivers.gap(entry.car, car)) - .001);
                        if (blocker) { change.blockerId = blocker.car.id; travel = Math.min(travel, Math.max(0, remaining - .02)); break; }
                    }
                }
                change.s += travel; change.progress = change.s / change.path.length;
                const pose = sample(change.path, change.s);
                car.s = Geometry.nearest(route, [pose.x, pose.y]).s;
                if (change.path.length - change.s < 1e-6) {
                    car.laneId = change.to; car.connectionId = change.toConnectionId;
                    car.mode = change.toConnectionId ? 'connection' : 'lane'; car.s = change.toS;
                    car.change = null; car.blockedFor = 0; car.cooldown = this.time + 4;
                    car.next = change.toConnectionId || this.chooseRoute(this.network.lanes.get(car.laneId), car);
                    if (move && !change.toConnectionId && this.network.nodes.get(move.nodeId)?.degree >= 3) this.crossings++;
                    this.laneChanges++;
                }
                return travel;
            }
            const travel = this.move(car, distance, occupied);
        if (car.change) {
            // Lateral progress stops with the vehicle; a queue cannot push a stopped car sideways.
            car.change.progress = Math.min(1, (car.change.progress || 0) + STEP / car.change.duration * Math.min(1, travel / .2));
            if (travel > 1e-7) {
                const from = this.network.lanes.get(car.laneId), to = this.network.lanes.get(car.change.to);
                const a = sample(from.path, car.s), b = sample(to.path, car.s * to.path.length / from.path.length);
                const t = car.change.progress;
                const lateral = 6 * t * (1 - t) / car.change.duration * Math.min(1, travel / .2);
                car.change.angle = Math.atan2(Math.sin(a.angle) * travel / STEP + (b.y - a.y) * lateral,
                    Math.cos(a.angle) * travel / STEP + (b.x - a.x) * lateral);
            }
            if (car.change.progress >= 1) {
                const from = this.network.lanes.get(car.laneId), to = this.network.lanes.get(car.change.to);
                car.s *= to.path.length / from.path.length; car.laneId = to.id;
                car.change = null; car.next = this.chooseRoute(to, car); car.cooldown = this.time + 10; this.laneChanges++;
            }
        }
            return travel;
        }

        step() {
            this.time += STEP;
            const bodies = new Collision.Index();
            this.posesByCar = new Map();
            for (const car of this.cars) {
                const pose = this.pose(car); bodies.set(car.id, pose); this.posesByCar.set(car, pose);
            }
            this.bodyIndex = bodies;
            this.carsById = new Map(this.cars.map(car => [car.id, car]));
            this.previousWait = new Map(this.cars.map(car => [car.id, car.waitingFor ?? car.collisionBlocker]));
            this.planningQueue = this.planningQueue.filter(car => !car.retired && car.driver
                && car.speed <= .4 && car.driver.stuckFor >= car.driver.patience
                && (!car.change || car.change.recovery));
            this.updateManeuverSpace();
            const searching = this.planningTask;
            this.advanceSearch();
            if (searching && searching.car.maneuver !== searching.maneuver) this.updateManeuverSpace();
            const occupied = this.occupants();
            for (const car of this.cars) {
                this.processingCar = car;
                const journal = () => ({ ...car, change: car.change && { ...car.change }, maneuver: car.maneuver && { ...car.maneuver }, traversed: [...car.traversed || []] });
                const before = this.pose(car), snapshot = { ...journal(), traversed: [] };
                const counts = [this.crossings, this.laneChanges];
                car.traversed = [];
                car.collisionBlocker = null;
                const previousKeys = this.carOccupancies(car).map(([id]) => id);
                const { lane, move, route } = this.routeInfo(car);
                const beforeLimits = this.limits(car, occupied);
                const blocked = car.speed < .5 && beforeLimits.signal > .25
                    && (beforeLimits.stopping < .25 || snapshot.collisionBlocker != null || snapshot.state === 'queue');
                const blockedFor = blocked ? (car.blockedFor || 0) + STEP : 0;
                car.blockedFor = blockedFor;
                this.tryDriverAction(car, occupied, snapshot.collisionBlocker ?? snapshot.waitingFor ?? beforeLimits.leader);
                if (!snapshot.maneuver && car.maneuver) this.updateManeuverSpace();
                this.tryRecovery(car, occupied);
                if (!move) this.tryLaneChange(car, occupied);
                const limits = this.limits(car, occupied);
                car.state = car.change ? 'changing' : move && !move.geometryKind ? 'turning' : move?.type === 'bypass' ? 'changing' : 'driving';
                if (!move && !limits.entering && route.length - car.s < 12) car.state = !limits.connection ? 'blocked' : 'queue';
                if (limits.clearance < 15 || limits.gate < 15) car.state = 'queue';
                if (limits.signal < 12 && limits.signal <= limits.clearance) car.state = 'red';
                if (car.maneuver) car.state = 'maneuvering';
                const roadLimit = lane.maxSpeed > 0 ? lane.maxSpeed / 3.6 : 13.9;
                const receivingLimit = move ? this.network.lanes.get(move.toLaneId).maxSpeed / 3.6 : Infinity;
                const cruise = Math.min(car.cruise, roadLimit, receivingLimit > 0 ? receivingLimit : Infinity, move && !move.geometryKind ? 6 : Infinity);
                const desired = car.planning ? 0 : car.maneuver ? (this.time < (car.maneuver.shiftUntil || 0) ? 0 : Math.min(1.2,
                    Math.sqrt(3 * (car.maneuver.segments[car.maneuver.index].path.length - car.maneuver.s))))
                    : car.change?.recovery ? Math.min(cruise, 2.5, Math.sqrt(6 * Math.min(limits.signal, limits.gate)))
                    : Math.min(cruise, Math.sqrt(6 * limits.stopping));
                const oldSpeed = car.speed;
                const followingLimit = Drivers.followingSpeedLimit(car, limits.clearance, STEP, limits.gapRatio);
                car.speed = clamp(desired, Math.max(0, car.speed - 3.5 * STEP), car.speed + 2 * STEP);
                if (!car.maneuver && !car.change?.recovery) car.speed = Math.min(car.speed, followingLimit);
                const requested = car.speed * STEP;
                // Every collision trial starts from its own untouched path journal.
                const motionStart = journal();
                const restore = state => {
                    for (const key of Object.keys(car)) if (!(key in state)) delete car[key];
                    Object.assign(car, state, { change: state.change && { ...state.change }, maneuver: state.maneuver && { ...state.maneuver }, traversed: [...state.traversed || []] });
                };
                let travel = car.planning ? 0 : this.advanceCar(car, requested, occupied);
                let after = this.pose(car);
                const collisionBlocker = bodies.blocker(car.id, after, before) ?? this.maneuverSpaceBlocker(car, after, before);
                if (collisionBlocker != null) {
                    // Keep the safe part of this tick. An occupied last metre
                    // must not discard the free space before it. Retry each tick.
                    let low = 0, high = travel, best = snapshot, bestCounts = counts;
                    travel = 0;
                    for (let attempt = 0; attempt < 8 && high - low > .001; attempt++) {
                        const distance = (low + high) / 2;
                        restore(motionStart); [this.crossings, this.laneChanges] = counts;
                        const advanced = this.advanceCar(car, distance, occupied);
                        if (bodies.blocker(car.id, this.pose(car), before) != null
                            || this.maneuverSpaceBlocker(car, this.pose(car), before) != null) high = distance;
                        else {
                            low = distance; travel = advanced;
                            best = journal();
                            bestCounts = [this.crossings, this.laneChanges];
                        }
                    }
                    restore(best); [this.crossings, this.laneChanges] = bestCounts;
                    car.blockedFor = blockedFor;
                    car.state = 'queue'; car.collisionBlocker = travel < .001 ? collisionBlocker : null;
                    after = this.pose(car);
                }
                if (travel < requested - .001) car.speed = travel / STEP;
                car.waitingFor = car.speed < .5 ? car.collisionBlocker ?? car.maneuver?.blockerId ?? limits.leader : null;
                Drivers.update(car, STEP, travel, limits.signal < .4, this.random, this.time);
                car.braking = car.speed < oldSpeed - .05 || (car.speed < .5 && car.state !== 'driving');
                for (const listener of this.listeners) listener(car, before, after, this.time);
                car.previousPose = before;
                const pose = this.pose(car);
                bodies.set(car.id, pose); this.posesByCar.set(car, pose);
                for (const id of previousKeys) {
                    const entries = occupied.get(id);
                    if (!entries) continue;
                    const index = entries.findIndex(entry => entry.car === car);
                    if (index >= 0) entries.splice(index, 1);
                }
                for (const [id, s] of this.carOccupancies(car)) {
                    if (!occupied.has(id)) occupied.set(id, []);
                    occupied.get(id).push({ car, s });
                }
            }
            this.posesByCar = null; this.processingCar = null; this.bodyIndex = null;
            while (this.cars.length < this.targetCount && this.spawn()) { /* fill requested density */ }
        }

        renderPose(car) {
            const current = this.pose(car), previous = car.previousPose || current;
            const t = clamp(this.accumulator / STEP, 0, 1);
            const turn = Math.atan2(Math.sin(current.angle - previous.angle), Math.cos(current.angle - previous.angle));
            return { x: previous.x + (current.x - previous.x) * t,
                y: previous.y + (current.y - previous.y) * t, angle: previous.angle + turn * t };
        }

        pose(car) {
            if (this.posesByCar && car !== this.processingCar && this.posesByCar.has(car)) return this.posesByCar.get(car);
            const vehicle = Vehicles.get(car.vehicleType);
            return { ...this.pathPose(car), length: vehicle.length, width: vehicle.width };
        }

        pathPose(car) {
            if (car.maneuver) return Maneuvers.pose(car.maneuver);
            if (car.change?.recovery) return sample(car.change.path, car.change.s);
            if (car.mode === 'connection') return sample(this.network.connections.get(car.connectionId).path, car.s);
            const from = this.network.lanes.get(car.laneId);
            const a = sample(from.path, car.s);
            if (!car.change) return a;
            const to = this.network.lanes.get(car.change.to);
            const b = sample(to.path, car.s * to.path.length / from.path.length);
            const t = car.change.progress || 0;
            const blend = t * t * (3 - 2 * t);
            return { x: a.x + (b.x - a.x) * blend, y: a.y + (b.y - a.y) * blend,
                angle: car.change.angle ?? a.angle };
        }

        stats() {
            const waiting = this.cars.filter(car => car.speed < .5).length;
            return { cars: this.cars.length, moving: this.cars.length - waiting, waiting,
                crossings: this.crossings, laneChanges: this.laneChanges, time: this.time };
        }
    }
    return { createNetwork, refreshNetwork, Simulation, signalState, signalAspect, laneChangeAllowed, sample, path, randomGenerator, GAP, STEP };
});
