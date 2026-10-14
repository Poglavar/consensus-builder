// Road-profile snapping and directional crossing counts in physical map coordinates.
(function (root, factory) {
    const node = typeof module !== 'undefined' && module.exports;
    const api = factory(node ? require('./geometry.js') : root.TrafficGeometry);
    if (node) module.exports = api;
    if (root) root.TrafficMeters = api;
})(typeof window !== 'undefined' ? window : null, function (G) {
    'use strict';
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    class LaneIndex {
        constructor(network) {
            this.network = network; this.cells = new Map();
            for (const lane of network.lanes.values()) {
                const b = lane.path.bounds;
                for (let x = Math.floor(b[0] / 40); x <= Math.floor(b[2] / 40); x++) {
                    for (let y = Math.floor(b[1] / 40); y <= Math.floor(b[3] / 40); y++) {
                        const key = `${x}:${y}`;
                        if (!this.cells.has(key)) this.cells.set(key, []);
                        this.cells.get(key).push(lane);
                    }
                }
            }
        }
        near(point, radius = 10) {
            const found = new Map();
            for (let x = Math.floor((point[0] - radius) / 40); x <= Math.floor((point[0] + radius) / 40); x++) {
                for (let y = Math.floor((point[1] - radius) / 40); y <= Math.floor((point[1] + radius) / 40); y++) {
                    for (const lane of this.cells.get(`${x}:${y}`) || []) found.set(lane.id, lane);
                }
            }
            return [...found.values()];
        }
        hit(point, tolerance = 1) {
            return this.near(point).map(lane => ({ lane, ...G.nearest(lane.path, point) }))
                .filter(hit => hit.distance <= (hit.lane.width || 3) / 2 + tolerance).sort((a, b) => a.distance - b.distance)[0] || null;
        }
    }
    function profile(index, hit) {
        if (!hit) return null;
        const lane = hit.lane, station = Math.max(Math.min(3, lane.path.length / 2), Math.min(lane.path.length - 3, hit.s));
        const p = G.sample(lane.path, station), point = [p.x, p.y], tangent = [Math.cos(p.angle), Math.sin(p.angle)], normal = [-tangent[1], tangent[0]];
        const crossings = [];
        for (const candidate of index.near(point, 65)) {
            if (candidate.sectionId !== lane.sectionId && (!lane.name || candidate.name !== lane.name || candidate.highway !== lane.highway)) continue;
            let best = null;
            for (let i = 1; i < candidate.path.points.length; i++) {
                const a = candidate.path.points[i - 1], b = candidate.path.points[i];
                const u = dot([a[0] - point[0], a[1] - point[1]], tangent), v = dot([b[0] - point[0], b[1] - point[1]], tangent);
                if (u * v > 0 || Math.abs(u - v) < 1e-8) continue;
                const f = u / (u - v), xy = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
                const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
                if (Math.abs(Math.cos(angle - p.angle)) < .96) continue;
                const offset = dot([xy[0] - point[0], xy[1] - point[1]], normal);
                if (Math.abs(offset) > 65 || best && Math.abs(best.offset) < Math.abs(offset)) continue;
                best = { laneId: candidate.id, ordinal: candidate.ordinal, width: candidate.width || 3, point: xy, angle, offset,
                    s: candidate.path.arcs[i - 1] + (candidate.path.arcs[i] - candidate.path.arcs[i - 1]) * f,
                    direction: ['E', 'N', 'W', 'S'][(Math.round(angle / (Math.PI / 2)) + 4) % 4] };
            }
            if (best && !crossings.some(c => Math.hypot(c.point[0] - best.point[0], c.point[1] - best.point[1]) < .5)) crossings.push(best);
        }
        if (!crossings.length) return null;
        crossings.sort((a, b) => a.offset - b.offset);
        const min = Math.min(...crossings.map(c => c.offset - c.width / 2)) - 1;
        const max = Math.max(...crossings.map(c => c.offset + c.width / 2)) + 1;
        const end = offset => [point[0] + normal[0] * offset, point[1] + normal[1] * offset];
        return { point, tangent, normal, lanes: crossings, ends: [end(min), end(max)], center: end((min + max) / 2), name: lane.name, min, max };
    }
    class Counters {
        constructor() { this.meters = []; this.nextId = 1; }
        add(shape, time) {
            const meter = { ...shape, id: this.nextId++, since: time, counts: new Map(shape.lanes.map(l => [l.laneId, 0])), events: [], lastCrossing: new Map(), baseline: null };
            this.meters.push(meter); return meter;
        }
        reset(id, time) {
            const meter = this.meters.find(m => m.id === id);
            if (meter) { meter.since = time; meter.counts.forEach((v, k) => meter.counts.set(k, 0)); meter.events = []; meter.lastCrossing.clear(); meter.baseline = null; }
        }
        remove(id) { this.meters = this.meters.filter(m => m.id !== id); }
        markIntervention(time) { for (const m of this.meters) m.baseline = { time, rates: this.rows(m, time).map(row => ({ laneId: row.laneId, rate: row.rate })), duration: Math.min(60, time - m.since) }; }
        observe(car, from, to, time) {
            if (Math.hypot(to.x - from.x, to.y - from.y) < 1e-6) return;
            for (const m of this.meters) {
                const a = dot([from.x - m.point[0], from.y - m.point[1]], m.tangent), b = dot([to.x - m.point[0], to.y - m.point[1]], m.tangent);
                if (a * b > 0 || Math.abs(a - b) < 1e-7 || Math.abs(b) < 1e-7) continue;
                const t = a / (a - b), x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t;
                const offset = dot([x - m.point[0], y - m.point[1]], m.normal);
                if (offset < m.min || offset > m.max) continue;
                const angle = Math.atan2(to.y - from.y, to.x - from.x);
                const lane = m.lanes.filter(l => Math.cos(angle - l.angle) > .5).sort((l, r) => Math.abs(l.offset - offset) - Math.abs(r.offset - offset))[0];
                if (!lane || Math.abs(lane.offset - offset) > lane.width / 2 + .7) continue;
                const last = m.lastCrossing.get(car.id);
                if (last && time - last.time < 2 && Math.hypot(x - last.x, y - last.y) < 6) continue;
                m.lastCrossing.set(car.id, { time, x, y }); m.counts.set(lane.laneId, m.counts.get(lane.laneId) + 1);
                m.events.push({ time, laneId: lane.laneId });
            }
        }
        rows(meter, time) {
            meter.events = meter.events.filter(e => time - e.time <= 60);
            const duration = Math.max(1, Math.min(60, time - meter.since));
            return meter.lanes.map(l => ({ ...l, count: meter.counts.get(l.laneId),
                rate: meter.events.filter(e => e.laneId === l.laneId).length * 60 / duration }));
        }
    }
    return { LaneIndex, profile, Counters };
});
