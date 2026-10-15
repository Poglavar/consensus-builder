// Derived approach stop lines and shared junction phases, with original OSM nodes as evidence.
(function (root, factory) {
    const api = factory(typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficSignals = api;
})(typeof window !== 'undefined' ? window : null, function (G) {
    'use strict';
    const GREEN = 24, AMBER = 3, CLEAR = 2, SLOT = GREEN + AMBER + CLEAR, REVERT_NOTICE = 3;
    const overrides = new Map();
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const angleGap = (a, b) => Math.acos(Math.min(1, Math.abs(Math.cos(a - b))));
    const hash = text => [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);

    function clusters(network) {
        const groups = new Map(), membership = new Map();
        const positions = new Map();
        for (const lane of network.lanes.values()) {
            for (const [id, s] of [[lane.fromNode, 0], [lane.toNode, lane.path.length]]) {
                if (!positions.has(id)) { const pose = G.sample(lane.path, s); positions.set(id, [pose.x, pose.y]); }
            }
        }
        for (const node of network.nodes.values()) {
            const p = node.point ? network.project(node.point) : positions.get(node.id);
            if (!p) continue;
            groups.set(node.id, { id: node.id, nodes: new Set([node.id]), points: [p], junction: node.degree >= 3 });
            membership.set(node.id, node.id);
        }
        const links = [...network.lanes.values()].map(lane => {
            const a = groups.get(lane.fromNode), b = groups.get(lane.toNode);
            return a && b ? { lane, length: distance(a.points[0], b.points[0]) } : null;
        }).filter(Boolean).sort((a, b) => a.length - b.length);
        for (const { lane, length } of links) {
            const a = groups.get(membership.get(lane.fromNode)), b = groups.get(membership.get(lane.toNode));
            if (a === b || length > (a.junction && b.junction ? 60 : 35)) continue;
            const points = [...a.points, ...b.points];
            const span = Math.hypot(Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])),
                Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1])));
            if (span > 90) continue;
            const id = [a.id, b.id].sort()[0], joined = { id, points, nodes: new Set([...a.nodes, ...b.nodes]), junction: a.junction || b.junction };
            groups.delete(a.id); groups.delete(b.id); groups.set(id, joined);
            for (const node of joined.nodes) membership.set(node, id);
        }
        return { groups, membership };
    }

    function build(network, records) {
        const { groups, membership } = clusters(network), controllers = new Map(), standalone = [];
        const sourcePosition = (lane, control) => lane.sourceStops.find(stop => Math.abs(stop.sourceS - control.fraction * lane.rawPath.length) < 1e-6)?.station;
        for (const record of records) {
            const point = network.project(record.point), candidates = new Map();
            const mapped = record.controls.map(control => ({ lane: network.lanes.get(control.laneId), control }))
                .filter(item => item.lane).map(item => ({ ...item, station: sourcePosition(item.lane, item.control) }))
                .filter(item => Number.isFinite(item.station));
            for (const { lane, station } of mapped) {
                for (const [node, remaining] of [[lane.toNode, lane.path.length - station], [lane.fromNode, station]]) {
                    const cluster = groups.get(membership.get(node));
                    if (!cluster?.junction || remaining > 55) continue;
                    const nearest = Math.min(...cluster.points.map(p => distance(p, point)));
                    if (nearest <= (record.kind === 'signalised_crossing' ? 25 : 45)) candidates.set(cluster.id, { cluster, nearest });
                }
            }
            const chosen = [...candidates.values()].sort((a, b) => a.nearest - b.nearest)[0];
            if (chosen) {
                if (!controllers.has(chosen.cluster.id)) controllers.set(chosen.cluster.id,
                    { id: chosen.cluster.id, cluster: chosen.cluster, sources: [], controls: [] });
                controllers.get(chosen.cluster.id).sources.push(record);
            } else if (mapped.length) standalone.push({ record, point, mapped });
        }
        // Multiple OSM tags around one crossing describe one stop, not successive lights.
        const crossings = [];
        for (const item of standalone) {
            const roads = new Set(item.mapped.map(({ lane }) => lane.name || String(lane.sourceWayId)));
            let crossing = crossings.find(c => c.points.every(p => distance(p, item.point) <= 25)
                && [...roads].some(road => c.roads.has(road)));
            if (!crossing) { crossing = { id: item.record.id, points: [], roads: new Set(), sources: [], controls: [] }; crossings.push(crossing); }
            crossing.points.push(item.point); roads.forEach(road => crossing.roads.add(road)); crossing.sources.push(item.record);
            crossing.controls.push(...item.mapped.map(({ lane, station }) => ({ lane, station: Math.max(0, station - 2.5) })));
        }
        for (const crossing of crossings) controllers.set(`crossing:${crossing.id}`, { ...crossing, id: `crossing:${crossing.id}` });
        for (const controller of controllers.values()) if (controller.cluster) {
            for (const lane of network.lanes.values()) {
                if (membership.get(lane.toNode) !== controller.id || membership.get(lane.fromNode) === controller.id) continue;
                if (lane.highway === 'service' && !controller.sources.some(record => record.controls.some(c => c.laneId === lane.id))) continue;
                controller.controls.push({ lane, station: Math.max(0, lane.path.length - 2.5) });
            }
        }
        const signals = new Map();
        for (const lane of network.lanes.values()) lane.signals = [];
        const predecessors = new Map();
        for (const move of network.connections.values()) {
            if (!predecessors.has(move.toLaneId)) predecessors.set(move.toLaneId, []);
            predecessors.get(move.toLaneId).push(move);
        }
        for (const controller of controllers.values()) {
            const controls = new Map();
            for (const item of controller.controls) {
                const old = controls.get(item.lane.id);
                if (!old || item.station < old.station) controls.set(item.lane.id, item);
            }
            if (!controller.cluster) {
                for (const [id, item] of [...controls]) {
                    if ((predecessors.get(id) || []).some(move => {
                        const upstream = controls.get(move.fromLaneId);
                        return upstream && upstream.lane.path.length - upstream.station + move.path.length + item.station < 35;
                    })) controls.delete(id);
                }
            }
            const axes = [], approaches = new Map();
            for (const { lane, station } of controls.values()) {
                const pose = G.sample(lane.path, station);
                let axis = axes.findIndex(angle => angleGap(angle, pose.angle) < Math.PI / 7);
                if (axis < 0) { axis = axes.length; axes.push(pose.angle); }
                const key = `${lane.sectionId}:${lane.direction}`;
                if (!approaches.has(key)) approaches.set(key, { axis, entries: [] });
                approaches.get(key).entries.push({ lane, station, pose });
            }
            controller.phases = axes.map((_, index) => `axis:${index}`);
            if (controller.phases.length === 1) controller.phases.push('crossing-clearance');
            controller.offset = hash(controller.id) % (Math.max(1, controller.phases.length) * SLOT);
            for (const [key, approach] of approaches) {
                const outer = approach.entries.sort((a, b) => b.lane.ordinal - a.lane.ordinal)[0];
                const { lane, pose } = outer, width = (lane.width || 3) / 2 + .8;
                const point = network.unproject([pose.x + Math.sin(pose.angle) * width, pose.y - Math.cos(pose.angle) * width]);
                const id = `signal:${controller.id}:${key}`, phase = `axis:${approach.axis}`;
                const sourceIds = [...new Set(controller.sources.map(record => record.id))].sort();
                const signal = { id, point, sourceIds, sourcePoints: controller.sources.map(record => record.point),
                    controllerId: controller.id, phases: controller.phases, phase, offset: controller.offset,
                    name: lane.name, direction: ['E', 'N', 'W', 'S'][(Math.round(pose.angle / (Math.PI / 2)) + 4) % 4], derived: true };
                signals.set(id, signal);
                for (const entry of approach.entries) entry.lane.signals.push({ signalId: id, phase, stopS: entry.station });
            }
        }
        for (const lane of network.lanes.values()) lane.signals.sort((a, b) => a.stopS - b.stopS);
        return { signals, controllers };
    }

    function scheduledAspect(signal, phase, time, enabled = true) {
        if (!enabled) return 'green';
        const index = signal.phases.indexOf(phase);
        if (index < 0) return 'red';
        const cycle = Math.max(2, signal.phases.length) * SLOT;
        const t = ((time + signal.offset) % cycle + cycle) % cycle;
        if (Math.floor(t / SLOT) !== index) return 'red';
        return t % SLOT < GREEN ? 'green' : t % SLOT < GREEN + AMBER ? 'amber' : 'red';
    }

    function state(signal, phase, time, enabled = true) {
        const override = overrides.get(signal.id);
        if (enabled && override && time < override.expiresAt) {
            return { aspect: override.aspect, remaining: override.expiresAt - time,
                overridden: true, reverted: false, expiresAt: override.expiresAt };
        }
        const aspect = scheduledAspect(signal, phase, time, enabled);
        const index = signal.phases.indexOf(phase);
        let remaining = 0;
        if (enabled && index >= 0) {
            const cycle = Math.max(2, signal.phases.length) * SLOT;
            const t = ((time + signal.offset) % cycle + cycle) % cycle;
            const phaseTime = ((t - index * SLOT) % cycle + cycle) % cycle;
            const boundary = aspect === 'green' ? GREEN
                : aspect === 'amber' ? GREEN + AMBER : cycle;
            remaining = boundary - phaseTime;
        }
        const reverted = !!override && time >= override.expiresAt
            && time < override.expiresAt + REVERT_NOTICE;
        return { aspect, remaining: Math.max(0, remaining), overridden: false, reverted,
            expiresAt: override?.expiresAt ?? null };
    }

    function aspect(signal, phase, time, enabled = true) {
        return state(signal, phase, time, enabled).aspect;
    }

    function duration(signal, aspect) {
        if (aspect === 'green') return GREEN;
        if (aspect === 'amber') return AMBER;
        return Math.max(1, Math.max(2, signal.phases.length) * SLOT - GREEN - AMBER);
    }

    function cycle(signal, phase, time) {
        const current = state(signal, phase, time).aspect;
        const next = ({ red: 'green', green: 'amber', amber: 'red' })[current] || 'green';
        const expiresAt = time + duration(signal, next);
        overrides.set(signal.id, { aspect: next, expiresAt });
        return state(signal, phase, time);
    }

    function clearOverrides() { overrides.clear(); }

    return { build, aspect, state, cycle, clearOverrides, GREEN, AMBER, CLEAR, SLOT, REVERT_NOTICE };
});
