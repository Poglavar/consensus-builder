// Deterministic traffic motion over an explicit directed lane graph; no DOM or map dependencies.
// Unknown turns are never inferred. Signal phases are deliberately illustrative.
(function (root, factory) {
    const geometry = typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry;
    const collision = typeof module !== 'undefined' && module.exports ? require('./collision.js') : root.TrafficCollision;
    const signals = typeof module !== 'undefined' && module.exports ? require('./signal-plan.js') : root.TrafficSignals;
    const movements = typeof module !== 'undefined' && module.exports ? require('./movement-conflicts.js') : root.TrafficMovementConflicts;
    const api = factory(geometry, collision, signals, movements);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficSimulation = api;
})(typeof window !== 'undefined' ? window : null, function (Geometry, Collision, Signals, Movements) {
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
        constructor(network, { count = 220, seed = 42, signals = true, laneChangeRate = .055 } = {}) {
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
            this.setCount(count);
        }

        choose(list) { return list.length ? list[Math.floor(this.random() * list.length)] : null; }

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
            for (let attempt = 0; attempt < 80; attempt++) {
                const pick = this.random() * n.totalWeight;
                let lo = 0, hi = n.weights.length - 1;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (n.weights[mid] < pick) lo = mid + 1; else hi = mid; }
                const lane = n.spawnLanes[lo];
                const s = 8 + this.random() * Math.max(0, lane.path.length - 32);
                if ((occupied.get(lane.id) || []).some(entry => Math.abs(entry.s - s) < GAP * 2)) continue;
                const pose = sample(lane.path, s);
                if (this.cars.some(other => Collision.overlaps(pose, this.pose(other)))) continue;
                this.cars.push({ id: this.nextId++, laneId: lane.id, mode: 'lane', s, speed: 0,
                    cruise: 7.5 + this.random() * 4.5, color: Math.floor(this.random() * 7),
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
            if (car.change || (car.blockedFor || 0) < 1) return;
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
                    const pose = sample(path, Math.min(s, path.length));
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
            if (this.gates.length || from.fragment || car.change || car.speed < 2 || car.s < 15 || from.path.length - car.s < Math.max(40, car.speed * 5)
                || this.time < car.cooldown || this.random() >= this.laneChangeRate * STEP) return;
            const candidates = from.adjacent.filter(id => {
                const to = this.network.lanes.get(id);
                const s = car.s * to.path.length / from.path.length;
                return !(occupied.get(id) || []).some(entry => entry.car !== car && Math.abs(entry.s - s) < GAP + car.speed * 2);
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
            let clearance = Infinity, leader = null;
            const ahead = (key, station, ratio = 1, receiving = false) => {
                for (const entry of occupied.get(key) || []) {
                    if (receiving && entry.car.mode === 'connection') {
                        const other = n.connections.get(entry.car.connectionId);
                        if (other.toLaneId === key && other.id !== move.id
                            && other.fromLaneId !== move.fromLaneId) continue;
                    }
                    const distance = (entry.s - station - GAP) / ratio;
                    if (entry.car.id !== car.id && entry.s >= station - 1e-7 && distance < clearance) {
                        clearance = distance; leader = entry.car.id;
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
            const entry = move ? null : car.change ? { kind: 'changing' }
                : this.entryBlocker(car, connection, occupied, false);
            const available = !!move || entry == null;
            // Only an actual stop line ahead controls this lane. A light already
            // passed cannot stop a car again at the lane/connector boundary.
            const entering = !!move || available && signalState(n, lane, this.time, this.signals, car.s) === 'green';
            const gate = Math.min(Infinity, ...this.gates.map(item => item.distance?.(car, this) ?? Infinity));
            const entryDistance = available ? Infinity : Math.max(0, route.length - car.s);
            return { clearance, signal, connection, entering, available, entry, entryDistance, leader,
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
                            && entry.s >= 0 && Math.abs(entry.s - s) < GAP - .001);
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
            const occupied = this.occupants(), bodies = new Collision.Index();
            this.posesByCar = new Map();
            for (const car of this.cars) {
                const pose = this.pose(car); bodies.set(car.id, pose); this.posesByCar.set(car, pose);
            }
            for (const car of this.cars) {
                this.processingCar = car;
                const before = this.pose(car), snapshot = { ...car, change: car.change && { ...car.change }, traversed: [] };
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
                this.tryRecovery(car, occupied);
                if (!move) this.tryLaneChange(car, occupied);
                const limits = this.limits(car, occupied);
                car.state = car.change ? 'changing' : move && !move.geometryKind ? 'turning' : move?.type === 'bypass' ? 'changing' : 'driving';
                if (!move && !limits.entering && route.length - car.s < 12) car.state = !limits.connection ? 'blocked' : 'queue';
                if (limits.clearance < 15 || limits.gate < 15) car.state = 'queue';
                if (limits.signal < 12 && limits.signal <= limits.clearance) car.state = 'red';
                const roadLimit = lane.maxSpeed > 0 ? lane.maxSpeed / 3.6 : 13.9;
                const receivingLimit = move ? this.network.lanes.get(move.toLaneId).maxSpeed / 3.6 : Infinity;
                const cruise = Math.min(car.cruise, roadLimit, receivingLimit > 0 ? receivingLimit : Infinity, move && !move.geometryKind ? 6 : Infinity);
                const desired = car.change?.recovery ? Math.min(cruise, 2.5, Math.sqrt(6 * Math.min(limits.signal, limits.gate)))
                    : Math.min(cruise, Math.sqrt(6 * limits.stopping));
                const oldSpeed = car.speed;
                car.speed = clamp(desired, Math.max(0, car.speed - 3.5 * STEP), car.speed + 2 * STEP);
                const requested = car.speed * STEP;
                // Every collision trial starts from its own untouched path journal.
                const motionStart = { ...car, change: car.change && { ...car.change }, traversed: [] };
                const restore = state => {
                    for (const key of Object.keys(car)) if (!(key in state)) delete car[key];
                    Object.assign(car, state, { change: state.change && { ...state.change }, traversed: [...state.traversed || []] });
                };
                let travel = this.advanceCar(car, requested, occupied);
                let after = this.pose(car);
                const collisionBlocker = bodies.blocker(car.id, after, before);
                if (collisionBlocker != null) {
                    // Keep the safe part of this tick. An occupied last metre
                    // must not discard the free space before it. Retry each tick.
                    let low = 0, high = travel, best = snapshot, bestCounts = counts;
                    travel = 0;
                    for (let attempt = 0; attempt < 8 && high - low > .001; attempt++) {
                        const distance = (low + high) / 2;
                        restore(motionStart); [this.crossings, this.laneChanges] = counts;
                        const advanced = this.advanceCar(car, distance, occupied);
                        if (bodies.blocker(car.id, this.pose(car), before) != null) high = distance;
                        else {
                            low = distance; travel = advanced;
                            best = { ...car, change: car.change && { ...car.change }, traversed: [...car.traversed] };
                            bestCounts = [this.crossings, this.laneChanges];
                        }
                    }
                    restore(best); [this.crossings, this.laneChanges] = bestCounts;
                    car.blockedFor = blockedFor;
                    car.state = 'queue'; car.collisionBlocker = travel < .001 ? collisionBlocker : null;
                    after = this.pose(car);
                }
                if (travel < requested - .001) car.speed = travel / STEP;
                car.braking = car.speed < oldSpeed - .05 || (car.speed < .5 && car.state !== 'driving');
                for (const listener of this.listeners) listener(car, before, after, this.time);
                car.previousPose = before;
                const pose = this.pose(car);
                bodies.set(car.id, pose); this.posesByCar.set(car, pose);
                for (const id of previousKeys) {
                    const entries = occupied.get(id), index = entries.findIndex(entry => entry.car === car);
                    if (index >= 0) entries.splice(index, 1);
                }
                for (const [id, s] of this.carOccupancies(car)) {
                    if (!occupied.has(id)) occupied.set(id, []);
                    occupied.get(id).push({ car, s });
                }
            }
            this.posesByCar = null; this.processingCar = null;
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
