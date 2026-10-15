// Bounded low-speed steering search and physical road space for forward/reverse escape manoeuvres.
(function (root, factory) {
    const api = factory(typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficManeuvers = api;
})(typeof window !== 'undefined' ? window : null, function (G) {
    'use strict';
    const MAX_DISTANCE = 24, MAX_TAIL = 12;
    const angleDifference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
    const xy = p => [p.x, p.y];
    class Space {
        constructor(roads) {
            this.cells = new Map();
            for (const road of roads) {
                const points = road.path.points, half = (road.width || 3) / 2 + .08;
                for (let i = 1; i < points.length; i++) {
                    const a = points[i - 1], b = points[i], dx = b[0] - a[0], dy = b[1] - a[1];
                    const length2 = dx * dx + dy * dy;
                    if (length2 < 1e-8) continue;
                    const segment = { a, dx, dy, length2, half, first: i === 1, last: i === points.length - 1 };
                    for (let x = Math.floor((Math.min(a[0], b[0]) - half) / 12); x <= Math.floor((Math.max(a[0], b[0]) + half) / 12); x++) {
                        for (let y = Math.floor((Math.min(a[1], b[1]) - half) / 12); y <= Math.floor((Math.max(a[1], b[1]) + half) / 12); y++) {
                            const key = `${x}:${y}`;
                            if (!this.cells.has(key)) this.cells.set(key, []);
                            this.cells.get(key).push(segment);
                        }
                    }
                }
            }
        }
        paved(x, y) {
            for (const s of this.cells.get(`${Math.floor(x / 12)}:${Math.floor(y / 12)}`) || []) {
                const t = ((x - s.a[0]) * s.dx + (y - s.a[1]) * s.dy) / s.length2;
                if (s.first && t < 0 || s.last && t > 1) continue;
                const f = Math.max(0, Math.min(1, t));
                if (Math.hypot(x - s.a[0] - f * s.dx, y - s.a[1] - f * s.dy) <= s.half) return true;
            }
            return false;
        }
        contains(pose, vehicle) {
            const c = Math.cos(pose.angle), s = Math.sin(pose.angle), count = Math.ceil(vehicle.length / 1.1);
            for (let i = 0; i <= count; i++) {
                const along = vehicle.length * (i / count - .5);
                for (const across of [-vehicle.width / 2, 0, vehicle.width / 2]) {
                    if (!this.paved(pose.x + c * along - s * across, pose.y + s * along + c * across)) return false;
                }
            }
            return true;
        }
    }

    function primitive(start, gear, steer, radius, length = 1) {
        const points = [{ ...start }], count = Math.ceil(length / .2), step = gear * length / count;
        let p = start;
        for (let i = 0; i < count; i++) {
            const angle = p.angle + step * steer / radius;
            p = steer ? { x: p.x + radius / steer * (Math.sin(angle) - Math.sin(p.angle)),
                y: p.y + radius / steer * (Math.cos(p.angle) - Math.cos(angle)), angle }
                : { x: p.x + step * Math.cos(angle), y: p.y + step * Math.sin(angle), angle };
            points.push(p);
        }
        return points;
    }

    function push(heap, node) {
        let i = heap.length; heap.push(node);
        while (i) {
            const parent = (i - 1) >> 1;
            if (heap[parent].f <= node.f) break;
            heap[i] = heap[parent]; i = parent;
        }
        heap[i] = node;
    }
    function pop(heap) {
        const first = heap[0], last = heap.pop();
        if (!heap.length) return first;
        let i = 0;
        while (i * 2 + 1 < heap.length) {
            let child = i * 2 + 1;
            if (child + 1 < heap.length && heap[child + 1].f < heap[child].f) child++;
            if (last.f <= heap[child].f) break;
            heap[i] = heap[child]; i = child;
        }
        heap[i] = last;
        return first;
    }

    function assemble(node, tail, goal, station) {
        const chain = [];
        for (let n = node; n.parent; n = n.parent) chain.push(n);
        const pieces = chain.reverse().map(n => ({ points: n.points.map(xy), gear: n.gear }));
        if (tail.length > .01) pieces.push({ points: tail.points, gear: 1 });
        const segments = [];
        for (const part of pieces) {
            if (segments.at(-1)?.gear === part.gear) segments.at(-1).points.push(...part.points.slice(1));
            else segments.push({ gear: part.gear, points: [...part.points] });
        }
        return { kind: goal.kind, landing: { ...goal.landing, s: station }, index: 0, s: 0, travelled: 0,
            segments: segments.map(segment => ({ gear: segment.gear, path: G.path(segment.points) })) };
    }

    class Search {
        constructor({ start, vehicle, goals, clear, maxNodes = 2400, maxDistance = MAX_DISTANCE }) {
            Object.assign(this, { start, vehicle, goals, clear, maxNodes, maxDistance });
            this.open = []; this.visited = new Map(); this.nodes = 0; this.done = false; this.result = null;
            push(this.open, { pose: start, gear: 1, steer: 0, cost: 0, f: this.heuristic(start), parent: null });
        }
        heuristic(pose) {
            return Math.min(...this.goals.map(goal => {
                const near = G.nearest(goal.route, xy(pose));
                return near.distance + Math.abs(angleDifference(pose.angle, near.angle)) * this.vehicle.turnRadius * .8;
            }));
        }
        tail(node) {
            for (const goal of this.goals) {
                const near = G.nearest(goal.route, xy(node.pose));
                if (near.distance > 1.3 || Math.abs(angleDifference(node.pose.angle, near.angle)) > .35) continue;
                const station = Math.min(goal.maxS ?? goal.route.length, near.s + Math.max(4, this.vehicle.length));
                if (station < (goal.minS || 0)) continue;
                const end = G.sample(goal.route, station), tail = G.taper(node.pose, end);
                if (tail.length < 2 || tail.length > MAX_TAIL) continue;
                let curvatureOK = true;
                for (let i = 1; i < tail.points.length - 1; i++) {
                    const a = tail.points[i - 1], b = tail.points[i], c = tail.points[i + 1];
                    const before = Math.atan2(b[1] - a[1], b[0] - a[0]), after = Math.atan2(c[1] - b[1], c[0] - b[0]);
                    const run = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2;
                    if (Math.abs(angleDifference(after, before)) > run / this.vehicle.turnRadius * 1.2 + .002) { curvatureOK = false; break; }
                }
                if (!curvatureOK) continue;
                let previous = node.pose, valid = true;
                for (let s = .15; s < tail.length + .15; s += .15) {
                    const p = G.sample(tail, Math.min(s, tail.length));
                    if (!this.clear(p, previous)) { valid = false; break; }
                    previous = p;
                }
                if (valid) return assemble(node, tail, goal, station);
            }
            return null;
        }
        advance(budget = 70) {
            if (this.done) return this;
            while (budget-- > 0 && this.open.length && this.nodes < this.maxNodes) {
                this.nodes++;
                const node = pop(this.open), pose = node.pose;
                const key = `${Math.round(pose.x / .6)}:${Math.round(pose.y / .6)}:${Math.round(angleDifference(pose.angle, 0) / .18)}:${node.gear}`;
                if ((this.visited.get(key) ?? Infinity) <= node.cost) continue;
                this.visited.set(key, node.cost);
                const result = this.tail(node);
                if (result) { this.result = result; this.done = true; return this; }
                for (const gear of [1, -1]) for (const steer of [-1, 0, 1]) {
                    const points = primitive(pose, gear, steer, this.vehicle.turnRadius);
                    const next = points.at(-1);
                    if (Math.hypot(next.x - this.start.x, next.y - this.start.y) > this.maxDistance) continue;
                    let valid = true;
                    for (let i = 1; i < points.length; i++) if (!this.clear(points[i], points[i - 1])) { valid = false; break; }
                    if (!valid) continue;
                    const cost = node.cost + (gear < 0 ? 1.35 : 1) + (gear !== node.gear ? 2.5 : 0)
                        + (steer !== node.steer ? .1 : 0);
                    push(this.open, { pose: next, gear, steer, points, cost, f: cost + this.heuristic(next), parent: node });
                }
            }
            if (!this.open.length || this.nodes >= this.maxNodes) this.done = true;
            return this;
        }
    }
    function find(options) {
        const search = new Search(options);
        while (!search.done) search.advance();
        return search.result;
    }
    function pose(plan) {
        const segment = plan.segments[plan.index], p = G.sample(segment.path, plan.s);
        return { ...p, angle: p.angle + (segment.gear < 0 ? Math.PI : 0) };
    }
    function validate(plan, clear, start = pose(plan)) {
        let previous = start;
        for (const segment of plan.segments) {
            for (let s = 0; s < segment.path.length + .2; s += .2) {
                const p = G.sample(segment.path, Math.min(s, segment.path.length));
                const current = { ...p, angle: p.angle + (segment.gear < 0 ? Math.PI : 0) };
                if (!clear(current, previous)) return false;
                previous = current;
            }
        }
        return true;
    }
    return { Space, Search, find, pose, validate, primitive, MAX_DISTANCE, MAX_TAIL };
});
