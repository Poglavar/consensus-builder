// Deterministic traffic motion over an explicit directed lane graph; no DOM or map dependencies.
// Unknown turns are never inferred. Signal phases are deliberately illustrative.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficSimulation = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const GAP = 7;
    const STEP = 0.1;
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
        const s = clamp(distance, 0, route.length);
        let lo = 1, hi = route.arcs.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (route.arcs[mid] < s) lo = mid + 1; else hi = mid;
        }
        const a = route.points[lo - 1], b = route.points[lo] || a;
        const t = (s - route.arcs[lo - 1]) / (route.arcs[lo] - route.arcs[lo - 1] || 1);
        return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t,
            angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
    }

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

    function createNetwork(data) {
        const origin = [(data.bbox[0] + data.bbox[2]) / 2, (data.bbox[1] + data.bbox[3]) / 2];
        const xScale = 111320 * Math.cos(origin[1] * Math.PI / 180);
        const project = p => [(p[0] - origin[0]) * xScale, (p[1] - origin[1]) * 111320];
        const unproject = p => [origin[0] + p[0] / xScale, origin[1] + p[1] / 111320];
        const lanes = new Map();
        for (const lane of data.lanes) {
            if (!lane.points?.every(p => p.length >= 2 && p.every(Number.isFinite))) throw new Error(`Invalid lane geometry: ${lane.id}`);
            const route = path(lane.points.map(project));
            if (route.length < .05) continue;
            lanes.set(lane.id, { ...lane, path: route, outgoing: [], adjacent: [] });
        }
        const nodes = new Map(data.nodes.map(node => [node.id, { ...node, incoming: [], phases: [] }]));
        const connections = new Map();
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
        const sections = new Map();
        for (const lane of lanes.values()) {
            const key = `${lane.sectionId}:${lane.direction}`;
            if (!sections.has(key)) sections.set(key, []);
            sections.get(key).push(lane);
            nodes.get(lane.toNode)?.incoming.push(lane.id);
        }
        for (const siblings of sections.values()) {
            for (const from of siblings) from.adjacent = siblings.filter(to => laneChangeAllowed(from, to) && to.outgoing.length).map(to => to.id);
        }
        for (const node of nodes.values()) {
            const incoming = node.incoming.map(id => lanes.get(id)).filter(lane => lane.outgoing.length && lane.highway !== 'service');
            const mainApproaches = new Set(incoming.map(lane => lane.sectionId));
            node.signal = node.degree >= 3 && mainApproaches.size >= 2;
            node.phases = [...new Set(node.incoming.map(id => lanes.get(id))
                .filter(lane => lane.outgoing.length).map(lane => lane.sectionId))].sort();
            node.offset = [...node.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 37;
        }
        // Spawn on through streets with enough room to see the cars moving, weighted by length.
        const spawnLanes = [...lanes.values()].filter(lane => lane.path.length > 25 && lane.outgoing.length && lane.highway !== 'service');
        const weights = [];
        let totalWeight = 0;
        for (const lane of spawnLanes) { totalWeight += lane.path.length; weights.push(totalWeight); }
        return { origin, lanes, nodes, connections, project, unproject, spawnLanes, weights, totalWeight, data };
    }

    function signalState(network, lane, time, enabled = true) {
        const node = network.nodes.get(lane.toNode);
        if (!enabled || !node?.signal) return 'green';
        const phase = node.phases.indexOf(lane.sectionId);
        // Service approaches at a signalised junction also wait; they receive their own phase.
        const phases = node.phases.length;
        if (phase < 0) return 'red';
        const slot = 12;
        const t = ((time + node.offset) % (slot * phases) + slot * phases) % (slot * phases);
        if (Math.floor(t / slot) !== phase) return 'red';
        return t % slot < 9 ? 'green' : t % slot < 10.5 ? 'amber' : 'red';
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
            this.reservations = new Map();
            this.crossings = 0;
            this.laneChanges = 0;
            this.trips = 0;
            this.nextId = 1;
            this.targetCount = 0;
            this.setCount(count);
        }

        choose(list) { return list.length ? list[Math.floor(this.random() * list.length)] : null; }

        carOccupancies(car) {
            if (car.mode === 'lane') {
                const entries = [[car.laneId, car.s]];
                if (car.change) entries.push([car.change.to,
                    car.s * this.network.lanes.get(car.change.to).path.length / this.network.lanes.get(car.laneId).path.length]);
                return entries;
            }
            const connection = this.network.connections.get(car.connectionId);
            return [[car.connectionId, car.s], [connection.toLaneId, -Math.max(0, connection.path.length - car.s)]];
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
                const s = 8 + this.random() * Math.max(0, lane.path.length - 20);
                if ((occupied.get(lane.id) || []).some(entry => Math.abs(entry.s - s) < GAP * 2)) continue;
                this.cars.push({ id: this.nextId++, laneId: lane.id, mode: 'lane', s, speed: 0,
                    cruise: 7.5 + this.random() * 4.5, color: Math.floor(this.random() * 7),
                    next: this.choose(lane.outgoing), state: 'driving', change: null,
                    stoppedFor: 0, cooldown: this.time + 4 + this.random() * 10, clearance: null });
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
            for (const [id, owner] of this.reservations) if (owner === car.id) this.reservations.delete(id);
        }

        canEnter(car, connection, occupied) {
            if (!connection) return false;
            const lane = this.network.lanes.get(car.laneId);
            if (signalState(this.network, lane, this.time, this.signals) !== 'green') return false;
            const owner = this.reservations.get(connection.nodeId);
            if (owner != null && owner !== car.id) return false;
            if ((occupied.get(connection.toLaneId) || []).some(entry => entry.car !== car && entry.s < GAP + 2)) return false;
            return true;
        }

        tryLaneChange(car, occupied) {
            const from = this.network.lanes.get(car.laneId);
            if (car.change || car.speed < 2 || car.s < 15 || from.path.length - car.s < Math.max(40, car.speed * 5)
                || this.time < car.cooldown || this.random() >= this.laneChangeRate * STEP) return;
            const candidates = from.adjacent.filter(id => {
                const to = this.network.lanes.get(id);
                const s = car.s * to.path.length / from.path.length;
                return !(occupied.get(id) || []).some(entry => entry.car !== car && Math.abs(entry.s - s) < GAP + car.speed * 2);
            });
            const to = this.choose(candidates);
            if (!to) return;
            car.change = { to, started: this.time, duration: 3.2 };
            car.state = 'changing';
        }

        advance(seconds) {
            if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Simulation time must be finite and nonnegative.');
            this.accumulator += Math.min(seconds, 2);
            while (this.accumulator >= STEP - 1e-9) { this.step(); this.accumulator -= STEP; }
        }

        step() {
            this.time += STEP;
            const occupied = this.occupants();
            for (const car of [...this.cars]) {
                const previousKeys = this.carOccupancies(car).map(([id]) => id);
                const n = this.network;
                const lane = n.lanes.get(car.laneId);
                const route = car.mode === 'lane' ? lane.path : n.connections.get(car.connectionId).path;
                const routeId = car.mode === 'lane' ? car.laneId : car.connectionId;
                let clearance = Infinity;
                for (const entry of occupied.get(routeId) || []) {
                    if (entry.car !== car && entry.s >= car.s) clearance = Math.min(clearance, entry.s - car.s - GAP);
                }
                if (car.mode === 'lane') this.tryLaneChange(car, occupied);
                if (car.change) {
                    const target = n.lanes.get(car.change.to);
                    const ratio = target.path.length / lane.path.length;
                    for (const entry of occupied.get(target.id) || []) {
                        if (entry.car !== car && entry.s >= car.s * ratio) clearance = Math.min(clearance, (entry.s - car.s * ratio - GAP) / ratio);
                    }
                }
                const connection = car.mode === 'lane' ? n.connections.get(car.next) : null;
                const entering = car.mode === 'lane' && this.canEnter(car, connection, occupied);
                let stopping = clearance;
                car.state = car.mode === 'connection' ? 'turning' : car.change ? 'changing' : 'driving';
                if (car.mode === 'lane' && !entering) {
                    stopping = Math.min(stopping, route.length - car.s);
                    if (route.length - car.s < 12) car.state = !connection ? 'blocked'
                        : signalState(n, lane, this.time, this.signals) !== 'green' ? 'red' : 'queue';
                }
                if (clearance < 15 && car.state === 'driving') car.state = 'queue';
                const roadLimit = typeof lane.maxSpeed === 'number' && lane.maxSpeed > 0 ? lane.maxSpeed / 3.6 : 13.9;
                const cruise = Math.min(car.cruise, roadLimit, car.mode === 'connection' ? 6 : Infinity);
                const targetSpeed = Math.min(cruise, Math.sqrt(2 * 3 * Math.max(0, stopping)));
                const oldSpeed = car.speed;
                car.speed = clamp(targetSpeed, Math.max(0, car.speed - 3.5 * STEP), car.speed + 2 * STEP);
                const travel = Math.max(0, Math.min(car.speed * STEP, clearance, route.length - car.s));
                car.s += travel;
                if (travel < car.speed * STEP - .001) car.speed = travel / STEP;
                car.braking = car.speed < oldSpeed - .05 || (car.speed < .5 && car.state !== 'driving');
                if (car.clearance) {
                    car.clearance.remaining -= travel;
                    if (car.clearance.remaining <= 0) {
                        this.reservations.delete(car.clearance.nodeId);
                        car.clearance = null;
                    }
                }
                if (car.change && this.time - car.change.started >= car.change.duration) {
                    const to = n.lanes.get(car.change.to);
                    car.s *= to.path.length / lane.path.length;
                    car.laneId = to.id;
                    car.change = null;
                    car.next = this.choose(to.outgoing);
                    car.cooldown = this.time + 10;
                    this.laneChanges++;
                }
                if (car.mode === 'lane' && !car.change && route.length - car.s < .02) {
                    car.s = route.length;
                    if (connection && this.canEnter(car, connection, occupied)) {
                        car.mode = 'connection'; car.connectionId = connection.id; car.s = 0;
                        if (n.nodes.get(connection.nodeId)?.degree >= 3) this.reservations.set(connection.nodeId, car.id);
                        car.state = 'turning'; car.stoppedFor = 0;
                    } else if (!connection) {
                        car.stoppedFor += STEP;
                        car.speed = 0;
                        if (car.stoppedFor > 3) { this.retire(car); this.trips++; }
                    } else car.speed = 0;
                } else if (car.mode === 'connection' && route.length - car.s < .02) {
                    const completed = n.connections.get(car.connectionId);
                    const nextLane = n.lanes.get(completed.toLaneId);
                    car.mode = 'lane'; car.laneId = nextLane.id; car.connectionId = null; car.s = 0;
                    car.next = this.choose(nextLane.outgoing); car.state = 'driving';
                    car.clearance = { nodeId: completed.nodeId, remaining: Math.min(GAP, nextLane.path.length * .8) };
                    if (n.nodes.get(completed.nodeId)?.degree >= 3) this.crossings++;
                }
                // Update only this car's entries so simultaneous merges cannot both take a gap.
                for (const id of previousKeys) {
                    const entries = occupied.get(id);
                    const index = entries.findIndex(entry => entry.car === car);
                    if (index >= 0) entries.splice(index, 1);
                }
                if (!car.retired) for (const [id, s] of this.carOccupancies(car)) {
                    if (!occupied.has(id)) occupied.set(id, []);
                    occupied.get(id).push({ car, s });
                }
            }
            while (this.cars.length < this.targetCount && this.spawn()) { /* replace completed trips */ }
        }

        pose(car) {
            if (car.mode === 'connection') return sample(this.network.connections.get(car.connectionId).path, car.s);
            const from = this.network.lanes.get(car.laneId);
            const a = sample(from.path, car.s);
            if (!car.change) return a;
            const to = this.network.lanes.get(car.change.to);
            const b = sample(to.path, car.s * to.path.length / from.path.length);
            const t = clamp((this.time - car.change.started) / car.change.duration, 0, 1);
            const blend = t * t * (3 - 2 * t);
            const lateral = 6 * t * (1 - t) / car.change.duration;
            return { x: a.x + (b.x - a.x) * blend, y: a.y + (b.y - a.y) * blend,
                angle: Math.atan2(Math.sin(a.angle) * car.speed + (b.y - a.y) * lateral,
                    Math.cos(a.angle) * car.speed + (b.x - a.x) * lateral) };
        }

        stats() {
            const waiting = this.cars.filter(car => car.speed < .5).length;
            return { cars: this.cars.length, moving: this.cars.length - waiting, waiting,
                crossings: this.crossings, laneChanges: this.laneChanges, time: this.time };
        }
    }
    return { createNetwork, Simulation, signalState, laneChangeAllowed, sample, path, randomGenerator, GAP, STEP };
});
