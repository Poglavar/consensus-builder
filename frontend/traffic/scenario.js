// Live lane closures compile to open lane fragments and explicit adjacent-lane detours.
(function (root, factory) {
    const node = typeof module !== 'undefined' && module.exports;
    const api = factory(node ? require('./geometry.js') : root.TrafficGeometry,
        node ? require('./simulation.js') : root.TrafficSimulation);
    if (node) module.exports = api;
    if (root) root.TrafficScenario = api;
})(typeof window !== 'undefined' ? window : null, function (G, Engine) {
    'use strict';
    const BUFFER = 2.5, RUN = 18, EPS = 1e-5;
    const group = lane => `${lane.sectionId}|${lane.direction}`;
    const baseId = lane => lane.baseLaneId || lane.id;
    const key = f => f.toFixed(8);
    function chunk(lane, station, length = 5) {
        const start = Math.floor(Math.max(0, Math.min(lane.path.length - EPS, station)) / length) * length;
        return { id: `${lane.id}@${start}:${length}`, laneId: lane.id, start, end: Math.min(lane.path.length, start + length) };
    }
    function ranges(closures, lane) {
        return closures.filter(c => c.laneId === lane.id).map(c => [Math.max(0, c.start - BUFFER), Math.min(lane.path.length, c.end + BUFFER)]);
    }
    function open(ranges, start, end) { return !ranges.some(([a, b]) => a < end - EPS && b > start + EPS); }

    function compile(base, closures, anchors = []) {
        const lanes = new Map(), connections = new Map(), nodes = new Map([...base.nodes].map(([id, node]) => [id, { ...node }]));
        const fragments = new Map(), groups = new Map(), blocked = new Map();
        const affected = new Set(closures.map(c => group(base.lanes.get(c.laneId))));
        for (const anchor of anchors) if (anchor.s > EPS) affected.add(group(base.lanes.get(anchor.laneId)));
        for (const lane of base.lanes.values()) {
            const k = group(lane);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(lane); blocked.set(lane.id, ranges(closures, lane));
        }
        const cutsByGroup = new Map();
        for (const [k, siblings] of groups) {
            const cuts = new Set([0, 1]);
            if (affected.has(k)) {
                const length = Math.max(...siblings.map(l => l.path.length));
                for (let s = RUN; s < length; s += RUN) cuts.add(s / length);
                for (const lane of siblings) for (const [a, b] of blocked.get(lane.id)) {
                    cuts.add(a / lane.path.length); cuts.add(b / lane.path.length);
                    for (let hop = 1; hop <= siblings.length + 1; hop++) {
                        cuts.add(Math.max(0, a - RUN * hop) / lane.path.length);
                        cuts.add(Math.min(lane.path.length, b + RUN * hop) / lane.path.length);
                    }
                }
                for (const anchor of anchors) {
                    const lane = base.lanes.get(anchor.laneId);
                    if (group(lane) === k) cuts.add(anchor.s / lane.path.length);
                }
            }
            const sorted = [...cuts].sort((a, b) => a - b).filter((v, i, all) => !i || v - all[i - 1] > 1e-7);
            cutsByGroup.set(k, sorted);
            for (const lane of siblings) {
                const parts = [];
                for (let i = 1; i < sorted.length; i++) {
                    const a = sorted[i - 1] * lane.path.length, b = sorted[i] * lane.path.length;
                    if (b - a < EPS || !open(blocked.get(lane.id), a, b)) continue;
                    const id = sorted.length === 2 ? lane.id : `${lane.id}@${key(sorted[i - 1])}:${key(sorted[i])}`;
                    const node = f => `cut:${k}:${key(f)}`;
                    const fromNode = i === 1 ? lane.fromNode : node(sorted[i - 1]);
                    const toNode = i === sorted.length - 1 ? lane.toNode : node(sorted[i]);
                    for (const id of [fromNode, toNode]) if (!nodes.has(id)) nodes.set(id, { id, degree: 2 });
                    const item = { ...lane, id, baseLaneId: lane.id, startS: a, endS: b,
                        fragment: sorted.length > 2, fromNode, toNode,
                        path: sorted.length === 2 ? lane.path : G.slice(lane.path, a, b),
                        signals: lane.signals.filter(s => s.stopS >= a - EPS && s.stopS <= b + EPS)
                            .map(s => ({ ...s, stopS: Math.max(0, s.stopS - a) })), outgoing: [], adjacent: [] };
                    lanes.set(id, item); parts.push(item);
                }
                fragments.set(lane.id, parts);
            }
        }
        const add = c => { connections.set(c.id, c); };
        for (const connection of base.connections.values()) {
            const from = fragments.get(connection.fromLaneId)?.at(-1), to = fragments.get(connection.toLaneId)?.[0];
            if (!from || !to || from.endS < base.lanes.get(connection.fromLaneId).path.length - EPS || to.startS > EPS) continue;
            add({ ...connection, fromLaneId: from.id, toLaneId: to.id });
        }
        for (const [id, parts] of fragments) {
            for (let i = 1; i < parts.length; i++) {
                const from = parts[i - 1], to = parts[i];
                if (Math.abs(from.endS - to.startS) > EPS) continue;
                add({ id: `cut-link:${from.id}`, fromLaneId: from.id, toLaneId: to.id, nodeId: from.toNode,
                    type: 'continue', geometryKind: 'continuation', path: G.taper(G.sample(from.path, from.path.length), G.sample(to.path, 0)) });
            }
            if (!affected.has(group(base.lanes.get(id)))) continue;
            const fromBase = base.lanes.get(id), siblings = groups.get(group(fromBase));
            for (const toBase of siblings.filter(to => Engine.laneChangeAllowed(fromBase, to))) {
                const destinations = fragments.get(toBase.id);
                for (const from of parts) {
                    const fraction = from.endS / fromBase.path.length;
                    const to = destinations.find(p => (p.startS / toBase.path.length - fraction) * fromBase.path.length >= RUN - .05);
                    if (!to) continue;
                    const end = to.startS / toBase.path.length * fromBase.path.length;
                    if (end - from.endS > RUN * 2.1 || !open(blocked.get(id), from.endS, end)
                        || !open(blocked.get(toBase.id), fraction * toBase.path.length, to.startS)) continue;
                    const a = G.sample(from.path, from.path.length), b = G.sample(to.path, 0);
                    if (Math.cos(a.angle - b.angle) < .94) continue;
                    add({ id: `bypass:${from.id}>${to.id}`, fromLaneId: from.id, toLaneId: to.id,
                        nodeId: from.toNode, type: 'bypass', geometryKind: 'taper', path: G.taper(a, b) });
                }
            }
        }
        const closureBlocks = closures.flatMap(closure => {
            const lane = base.lanes.get(closure.laneId), result = [];
            for (let s = closure.start; s < closure.end; s += 1) {
                const length = Math.min(1, closure.end - s);
                result.push({ pose: G.sample(lane.path, s + length / 2), length, width: lane.width || 3 });
            }
            return result;
        });
        const result = Engine.refreshNetwork({ ...base, lanes, connections, nodes, fragments, closures, closureBlocks }, base.junctionGroups);
        // A live car may now be in a one-way feeder into a circulating region. Let it
        // reach that region; new cars still spawn only in the strongly connected graph.
        const viable = new Set([...lanes.values()].filter(l => l.routes.length).map(l => l.id));
        const reverse = new Map();
        for (const c of connections.values()) { if (!reverse.has(c.toLaneId)) reverse.set(c.toLaneId, []); reverse.get(c.toLaneId).push(c.fromLaneId); }
        const queue = [...viable];
        for (let i = 0; i < queue.length; i++) for (const id of reverse.get(queue[i]) || []) if (!viable.has(id)) { viable.add(id); queue.push(id); }
        for (const lane of lanes.values()) if (!lane.routes.length && viable.has(lane.id)) lane.routes = lane.outgoing.filter(id => viable.has(connections.get(id).toLaneId));
        return result;
    }

    function install(sim, next) {
        const old = sim.network;
        const locate = (lane, s, beginning = false) => {
            const station = (lane.startS || 0) + s, parts = next.fragments.get(baseId(lane)) || [];
            return parts.find(p => beginning ? Math.abs(p.startS - station) < EPS : station >= p.startS - EPS && station <= p.endS + EPS);
        };
        const updates = [];
        for (const car of sim.cars) {
            const lane = old.lanes.get(car.laneId);
            if (car.mode === 'lane') {
                const target = locate(lane, car.s);
                if (!target) return false;
                const update = { car, laneId: target.id, s: (lane.startS || 0) + car.s - target.startS };
                if (car.change) {
                    const changed = old.lanes.get(car.change.to), s = car.s * changed.path.length / lane.path.length;
                    const to = locate(changed, s);
                    if (!to) return false;
                    update.change = { ...car.change, to: to.id };
                }
                updates.push(update);
            } else {
                const move = old.connections.get(car.connectionId), receiving = old.lanes.get(move.toLaneId);
                const to = locate(receiving, 0, true);
                if (!to) return false;
                // Keep an already-entered curve exactly until the car reaches its landing.
                // A source fragment behind it may have just been closed or joined again.
                const ghostId = `inflight-lane:${car.id}`;
                next.lanes.set(ghostId, { ...lane, id: ghostId, ghost: true, routes: [], outgoing: [], adjacent: [] });
                const connectionId = `inflight-move:${car.id}`;
                next.connections.set(connectionId, { ...move, id: connectionId, fromLaneId: ghostId, toLaneId: to.id });
                updates.push({ car, laneId: ghostId, connectionId, s: car.s });
            }
        }
        sim.network = next;
        for (const { car, ...update } of updates) {
            Object.assign(car, update);
            if (car.mode === 'lane') {
                const lane = next.lanes.get(car.laneId);
                if (!lane.routes.includes(car.next)) car.next = sim.chooseRoute(lane, car);
            }
        }
        for (const car of sim.cars) car.previousPose = sim.pose(car);
        return true;
    }

    class Editor {
        constructor(base, sim) { this.base = base; this.sim = sim; this.closures = []; this.revision = 0; this.nextRevision = 0; }
        setSimulation(sim) { this.sim = sim; this.updateGates(); }
        toggle(selection) {
            const overlaps = c => c.laneId === selection.laneId && c.start < selection.end - EPS && c.end > selection.start + EPS;
            if (this.closures.some(overlaps)) {
                this.closures = this.closures.flatMap(c => {
                    if (!overlaps(c)) return [c];
                    return [[c.start, Math.min(c.end, selection.start)], [Math.max(c.start, selection.end), c.end]]
                        .filter(([start, end]) => end - start > EPS)
                        .map(([start, end]) => ({ ...c, id: `${c.laneId}@${start}:${end - start}`, start, end }));
                });
            } else this.closures.push({ ...selection, status: 'pending', requestedAt: this.sim.time });
            this.nextRevision++; this.update();
        }
        clear() { this.closures = []; this.nextRevision++; this.update(); }
        window(closure) {
            const lane = this.base.lanes.get(closure.laneId);
            const count = [...this.base.lanes.values()].filter(l => group(l) === group(lane)).length;
            return { start: Math.max(0, closure.start - BUFFER - RUN * (count + 1)), end: Math.min(lane.path.length, closure.end + BUFFER) };
        }
        busy(closure) {
            const window = this.window(closure), n = this.sim.network;
            return this.sim.cars.some(car => {
                const lane = n.lanes.get(car.laneId);
                if (car.mode === 'connection') {
                    const move = n.connections.get(car.connectionId), target = n.lanes.get(move.toLaneId);
                    return baseId(target) === closure.laneId && (target.startS || 0) <= window.end + BUFFER;
                }
                const station = (lane.startS || 0) + car.s;
                return baseId(lane) === closure.laneId && station > window.start - BUFFER + EPS && station <= window.end + BUFFER
                    || car.change && baseId(n.lanes.get(car.change.to)) === closure.laneId;
            });
        }
        updateGates() {
            this.sim.gates = this.closures.filter(c => c.status === 'pending').map(c => {
                const window = this.window(c);
                return {
                    distance: (car, sim) => {
                        if (car.mode !== 'lane') return Infinity;
                        const lane = sim.network.lanes.get(car.laneId), station = (lane.startS || 0) + car.s;
                        return baseId(lane) === c.laneId && station < window.start - BUFFER - EPS ? window.start - BUFFER - station : Infinity;
                    },
                    blocksEntry: (car, move, sim) => {
                        const lane = sim.network.lanes.get(move.toLaneId);
                        return baseId(lane) === c.laneId && (lane.startS || 0) >= window.start - BUFFER - EPS
                            && (lane.startS || 0) <= window.end + BUFFER;
                    }
                };
            });
        }
        update() {
            let changed = this.revision !== this.nextRevision;
            const activating = this.closures.filter(c => c.status === 'pending' && !this.busy(c));
            if (activating.length) changed = true;
            if (changed) {
                // Keep the two paths of a tactical change intact until it lands.
                if (this.sim.cars.some(car => car.change?.recovery)) { this.updateGates(); return false; }
                const active = this.closures.filter(c => c.status === 'active' || activating.includes(c));
                const anchors = this.sim.cars.filter(c => c.mode === 'connection').map(car => {
                    const move = this.sim.network.connections.get(car.connectionId), target = this.sim.network.lanes.get(move.toLaneId);
                    return { laneId: baseId(target), s: target.startS || 0 };
                });
                // An in-progress free lane change needs the same fragment boundaries.
                for (const car of this.sim.cars.filter(c => c.change)) {
                    const lane = this.sim.network.lanes.get(car.laneId);
                    if (active.some(c => group(this.base.lanes.get(c.laneId)) === group(lane))) { this.updateGates(); return false; }
                }
                if (!install(this.sim, compile(this.base, active, anchors))) { this.updateGates(); return false; }
                for (const c of activating) c.status = 'active';
                this.revision = ++this.nextRevision;
            }
            this.updateGates(); return changed;
        }
    }
    return { chunk, compile, install, Editor, baseId, BUFFER, RUN };
});
