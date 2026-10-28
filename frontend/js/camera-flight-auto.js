// Generated camera flights in a flight's metric frame. One design: fly in, then a descending orbit
// that keeps it in view. A plan: orbit its first building, wind between obstacles to its last and
// orbit that. Obstacles come from a top-down height grid; the playback curve itself is checked.
(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./camera-flight.js') : root.CameraFlight);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightAuto = api;
})(typeof window !== 'undefined' ? window : null, function (Flight) {
    'use strict';
    const OPTIONS = Object.freeze({
        clearanceM: 2,          // vertical margin over anything the camera passes above
        sideClearanceM: 3,      // horizontal margin the playback curve keeps from obstacles (checked)
        pathClearanceM: 6,      // horizontal margin the planned path keeps (planned, wider than checked)
        streetPreferenceM: 16,  // within this distance of an obstacle the path pays extra: it keeps to streets
        cruiseAltitudeM: 15,    // about one and a half street-tree heights
        cornerRadiusM: 25,      // a street corner becomes a curve this far either side of it
        maxTurnDegPerS: 15,     // the camera never turns faster than this: orbits slow the flight, the path eases its looks
        maxTravelTurnDegPerS: 30, // the flight slows for curves it would otherwise round faster than this
        accelerationMps2: 1.5, slowestMps: 2, // speed changes no faster than this, and slows to no less than this
        tourTurns: .75,         // orbit at each end of a plan tour
        perTurn: 16, spacingM: 30, aheadM: 25, targetSeconds: 50, minSpeedMps: 4, maxSpeedMps: 16, maxPoints: 240
    });
    const TAU = Math.PI * 2;
    const finite = x => typeof x === 'number' && Number.isFinite(x);
    const vector = (x, n) => Array.isArray(x) && x.length === n && x.every(finite);
    const sub = (a, b) => a.map((x, i) => x - b[i]);
    const norm = a => Math.hypot(...a);
    const scale = (a, s) => a.map(x => x * s);
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const distance2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

    // Seeded so "Try another" is reproducible from its seed; seed 0 is the deterministic default.
    function random(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0; let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Camera orientation in the metric frame (east, north, up): the camera looks along its -Z with
    // +Y up, the same convention CameraFlightCamera converts to the scene. The horizon stays level.
    function lookAt(eye, target) {
        const offset = sub(target, eye), length = norm(offset);
        if (length < 1e-9) return [0, 0, 0, 1];
        const f = scale(offset, 1 / length);
        let r = cross(f, [0, 0, 1]);
        r = norm(r) < 1e-6 ? [1, 0, 0] : scale(r, 1 / norm(r));
        const u = cross(r, f), b = scale(f, -1);
        const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = [r[0], u[0], b[0], r[1], u[1], b[1], r[2], u[2], b[2]];
        const trace = m11 + m22 + m33;
        let q;
        if (trace > 0) { const s = .5 / Math.sqrt(trace + 1); q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, .25 / s]; }
        else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); q = [.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
        else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); q = [(m12 + m21) / s, .25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
        else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); q = [(m13 + m31) / s, (m23 + m32) / s, .25 * s, (m21 - m12) / s]; }
        return scale(q, 1 / norm(q));
    }

    // Top height (true metres) of everything in each cell, row-major from the south-west origin.
    // Outside the grid nothing was rendered, so it reads as open ground.
    function grid({ origin, cell, cols, rows, heights }) {
        if (!vector(origin, 2) || !finite(cell) || cell <= 0 || !Number.isInteger(cols) || !Number.isInteger(rows)
            || cols < 1 || rows < 1 || !heights || heights.length !== cols * rows) throw new TypeError('Invalid flight height grid.');
        const index = (x, y) => {
            const c = Math.floor((x - origin[0]) / cell), r = Math.floor((y - origin[1]) / cell);
            return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : r * cols + c;
        };
        return Object.freeze({ origin: origin.slice(), cell, cols, rows, heights, index,
            at(x, y) { const i = index(x, y); return i < 0 ? 0 : heights[i]; },
            point(i) { return [origin[0] + (i % cols + .5) * cell, origin[1] + (Math.floor(i / cols) + .5) * cell]; } });
    }

    // Disc max filter: a point within radiusM of an obstacle reads that obstacle's height. A disc, not a
    // square, so it agrees with the distances the path is planned with (openness) at street corners too.
    function dilate(g, radiusM) {
        const reach = radiusM / g.cell, r = Math.floor(reach);
        if (r < 1) return g;
        const { cols, rows } = g, out = new Float32Array(cols * rows), offsets = [];
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.hypot(dx, dy) <= reach) offsets.push([dx, dy]);
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
            let top = 0;
            for (const [dx, dy] of offsets) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) top = Math.max(top, g.heights[ny * cols + nx]);
            }
            out[y * cols + x] = top;
        }
        return grid({ ...g, heights: out });
    }

    // Metres from each cell to the nearest cell the camera could not cross at this altitude (chamfer).
    function openness(g, altitude, verticalM) {
        const { cols, rows, cell } = g, d = new Float32Array(cols * rows), a = cell, b = cell * Math.SQRT2;
        for (let i = 0; i < d.length; i++) d[i] = g.heights[i] + verticalM > altitude ? 0 : 1e9;
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
            const i = y * cols + x; let v = d[i];
            if (x > 0) v = Math.min(v, d[i - 1] + a);
            if (y > 0) {
                v = Math.min(v, d[i - cols] + a);
                if (x > 0) v = Math.min(v, d[i - cols - 1] + b);
                if (x < cols - 1) v = Math.min(v, d[i - cols + 1] + b);
            }
            d[i] = v;
        }
        for (let y = rows - 1; y >= 0; y--) for (let x = cols - 1; x >= 0; x--) {
            const i = y * cols + x; let v = d[i];
            if (x < cols - 1) v = Math.min(v, d[i + 1] + a);
            if (y < rows - 1) {
                v = Math.min(v, d[i + cols] + a);
                if (x < cols - 1) v = Math.min(v, d[i + cols + 1] + b);
                if (x > 0) v = Math.min(v, d[i + cols - 1] + b);
            }
            d[i] = v;
        }
        return d;
    }

    function nearestOpen(g, open, point, minimum, searchM) {
        const centre = g.index(point[0], point[1]);
        if (centre >= 0 && open[centre] >= minimum) return centre;
        const r = Math.ceil(searchM / g.cell), c0 = Math.floor((point[0] - g.origin[0]) / g.cell), r0 = Math.floor((point[1] - g.origin[1]) / g.cell);
        let best = -1, bestDistance = Infinity;
        for (let y = Math.max(0, r0 - r); y <= Math.min(g.rows - 1, r0 + r); y++) {
            for (let x = Math.max(0, c0 - r); x <= Math.min(g.cols - 1, c0 + r); x++) {
                const i = y * g.cols + x; if (open[i] < minimum) continue;
                const d = distance2(g.point(i), point); if (d < bestDistance) { best = i; bestDistance = d; }
            }
        }
        return best;
    }

    // A* over the grid at one altitude: 8-connected, no corner cutting, and cells near obstacles cost
    // more, so the path keeps to the middle of streets and squares. Returns cell indices or null.
    function findPath(g, open, from, to, options = OPTIONS) {
        const minimum = options.pathClearanceM, prefer = options.streetPreferenceM;
        const start = nearestOpen(g, open, from, minimum, 60), goal = nearestOpen(g, open, to, minimum, 60);
        if (start < 0 || goal < 0) return null;
        const { cols, rows, cell } = g, n = cols * rows, cost = new Float32Array(n).fill(Infinity), came = new Int32Array(n).fill(-1);
        const closed = new Uint8Array(n), heap = [], target = g.point(goal);
        const push = (f, i) => {
            heap.push([f, i]); let k = heap.length - 1;
            while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
        };
        const pop = () => {
            const top = heap[0], last = heap.pop();
            if (heap.length) {
                heap[0] = last; let k = 0;
                for (;;) {
                    const l = 2 * k + 1, r = l + 1; let m = k;
                    if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                    if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                    if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
                }
            }
            return top;
        };
        const passable = i => open[i] >= minimum;
        cost[start] = 0; push(distance2(g.point(start), target), start);
        while (heap.length) {
            const [, i] = pop();
            if (closed[i]) continue;
            if (i === goal) break;
            closed[i] = 1;
            const x = i % cols, y = (i - x) / cols;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                const j = ny * cols + nx;
                if (closed[j] || !passable(j)) continue;
                if (dx && dy && (!passable(y * cols + nx) || !passable(ny * cols + x))) continue;
                const step = cell * (dx && dy ? Math.SQRT2 : 1) * (1 + 2 * Math.max(0, (prefer - open[j]) / prefer));
                if (cost[i] + step < cost[j]) {
                    cost[j] = cost[i] + step; came[j] = i;
                    push(cost[j] + distance2(g.point(j), target), j);
                }
            }
        }
        if (start !== goal && came[goal] < 0) return null;
        const cells = [goal];
        while (cells[cells.length - 1] !== start) cells.push(came[cells[cells.length - 1]]);
        return cells.reverse();
    }

    // Keep only the cells where the path has to bend (and every `stays` cell: the designs it passes),
    // round each bend into a curve whose chord stays clear, and fill long straights in.
    // Returns { xy, k }: k is the path cell the point stands for.
    function waypoints(g, open, cells, options = OPTIONS, stays = new Set()) {
        const points = cells.map(i => g.point(i)), minimum = options.sideClearanceM + g.cell;
        const clear = (a, b) => {
            const steps = Math.max(1, Math.ceil(distance2(a, b) / (g.cell / 2)));
            for (let s = 1; s < steps; s++) {
                const i = g.index(a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps);
                if (i >= 0 && open[i] < minimum) return false;
            }
            return true;
        };
        const kept = [0];
        let i = 0;
        while (i < points.length - 1) {
            let j = i + 1;
            while (j + 1 < points.length && !stays.has(j) && clear(points[i], points[j + 1])) j++;
            kept.push(j); i = j;
        }
        const out = [{ xy: points[0], k: 0 }];
        let from = { xy: points[0], k: 0 };
        const straight = (to, k) => {
            const parts = Math.ceil(distance2(from.xy, to) / options.spacingM);
            for (let s = 1; s < parts; s++) {
                out.push({ xy: [from.xy[0] + (to[0] - from.xy[0]) * s / parts, from.xy[1] + (to[1] - from.xy[1]) * s / parts],
                    k: Math.round(from.k + (k - from.k) * s / parts) });
            }
            out.push({ xy: to, k }); from = { xy: to, k };
        };
        for (let c = 1; c + 1 < kept.length; c++) {
            const here = points[kept[c]], before = points[kept[c - 1]], after = points[kept[c + 1]], k = kept[c];
            const inLength = distance2(before, here), outLength = distance2(here, after);
            const u1 = [(here[0] - before[0]) / inLength, (here[1] - before[1]) / inLength], u2 = [(after[0] - here[0]) / outLength, (after[1] - here[1]) / outLength];
            // Each side takes under half its leg, so neighbouring curves never overlap.
            let r = Math.min(options.cornerRadiusM, inLength * .45, outLength * .45), a = null, b = null;
            for (; r >= 2; r /= 2) {
                a = [here[0] - u1[0] * r, here[1] - u1[1] * r]; b = [here[0] + u2[0] * r, here[1] + u2[1] * r];
                if (clear(a, b)) break;
            }
            if (r < 2) { straight(here, k); continue; }
            straight(a, k);
            // A quadratic curve with the corner as its control point leaves and joins the legs along them.
            // At most one view every 4 m: a tight curve is flown slowly, and views closer than that add only jitter.
            const bend = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
            const count = Math.max(2, Math.min(Math.ceil(bend / (Math.PI / 8)), Math.floor(2 * r / 4)));
            for (let s = 1; s < count; s++) {
                const t = s / count, w0 = (1 - t) ** 2, w1 = 2 * (1 - t) * t, w2 = t * t;
                out.push({ xy: [w0 * a[0] + w1 * here[0] + w2 * b[0], w0 * a[1] + w1 * here[1] + w2 * b[1]], k });
            }
            out.push({ xy: b, k }); from = { xy: b, k };
        }
        if (kept.length > 1) straight(points[kept[kept.length - 1]], kept[kept.length - 1]);
        return out.filter((point, index) => !index || distance2(point.xy, out[index - 1].xy) > 1e-6);
    }

    // One complete turn per `turns`, climbing or descending evenly, every view aimed at the target.
    function orbit({ centre, radius, from, to, start, turns, direction, target, own, perTurn }) {
        const count = Math.max(4, Math.round(perTurn * turns)), nodes = [];
        for (let s = 0; s <= count; s++) {
            const angle = start + direction * TAU * turns * s / count;
            nodes.push({ position: [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle), from + (to - from) * s / count],
                target: target.slice(), own, section: 'orbit' });
        }
        return nodes;
    }

    function box(items) {
        if (!items.length) return null;
        return { min: [Math.min(...items.map(b => b.min[0])), Math.min(...items.map(b => b.min[1]))],
            max: [Math.max(...items.map(b => b.max[0])), Math.max(...items.map(b => b.max[1]))], top: Math.max(0, ...items.map(b => b.top || 0)) };
    }
    const outlineBox = points => points.length ? box(points.map(p => ({ min: p, max: p, top: 0 }))) : null;
    const centreOf = b => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
    const radiusOf = b => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2;
    // Orbit framing for one building or a whole design: the radius clears its footprint, the orbit
    // starts high above it and finishes near half its height (just above the ground when it is flat).
    function framing(b) {
        const top = b.top, radius = Math.max(radiusOf(b) * 1.6 + 15, 35);
        return { centre: centreOf(b), radius, top, high: Math.max(top * 2.2, top + 45, 50), low: Math.max(top * .55, 10),
            target: [...centreOf(b), top * .45] };
    }

    function checkSubjects(subjects) {
        if (!Array.isArray(subjects) || !subjects.length) throw new Error('Choose a design or plan to fly around.');
        for (const subject of subjects) {
            if (!subject || !Array.isArray(subject.buildings) || !Array.isArray(subject.outline)
                || subject.buildings.some(b => !vector(b.min, 2) || !vector(b.max, 2) || !finite(b.top))
                || subject.outline.some(p => !vector(p, 2))) throw new TypeError('Invalid flight subject.');
        }
        if (subjects.every(s => !s.buildings.length && !s.outline.length)) throw new Error('These designs have nothing to fly around.');
    }
    const subjectBox = s => box(s.buildings) || outlineBox(s.outline);

    // The ground the height grid must cover for these subjects, as [minX, minY, maxX, maxY] metres.
    function bounds(subjects) {
        checkSubjects(subjects);
        const all = box(subjects.map(subjectBox).filter(Boolean)), f = framing(all);
        const margin = subjects.length === 1 ? Math.max(f.radius * 3, f.radius + 150) + 40 : 160;
        return [all.min[0] - margin, all.min[1] - margin, all.max[0] + margin, all.max[1] + margin];
    }

    function designNodes(subject, rng, seeded) {
        const f = framing(subjectBox(subject));
        const start = seeded ? rng() * TAU : Math.PI * 1.25, direction = seeded && rng() < .5 ? -1 : 1;
        const out = Math.max(f.radius * 3, f.radius + 150);
        const own = subjectBox(subject), heading = start + direction * Math.PI / 2;
        // The approach arrives along the orbit's own direction, so the flight curves into it without a corner.
        const entry = [f.centre[0] + f.radius * Math.cos(start), f.centre[1] + f.radius * Math.sin(start)];
        return [{ position: [entry[0] - out * Math.cos(heading), entry[1] - out * Math.sin(heading), f.high * 1.15], target: f.target, own, section: 'approach' },
            ...orbit({ centre: f.centre, radius: f.radius, from: f.high, to: f.low, start, turns: 1.25, direction, target: f.target, own, perTurn: OPTIONS.perTurn })];
    }

    // First and last stops of a plan tour: its buildings; designs without buildings stand in with
    // their outline centres; with no buildings at all, two points of the plan's outline.
    function stops(subjects, rng, seeded) {
        let candidates = subjects.flatMap(s => s.buildings.map(b => ({ box: b, design: s.id })));
        if (candidates.length < 2) {
            candidates = candidates.concat(subjects.filter(s => !s.buildings.length && s.outline.length)
                .map(s => ({ box: outlineBox(s.outline), design: s.id })));
        }
        if (candidates.length < 2) {
            const points = subjects.flatMap(s => s.outline), all = outlineBox(points) || subjectBox(subjects[0]), c = centreOf(all);
            const inward = p => [c[0] + (p[0] - c[0]) * .85, c[1] + (p[1] - c[1]) * .85];
            const pick = seeded
                ? [0, 1].map(() => [all.min[0] + rng() * (all.max[0] - all.min[0]), all.min[1] + rng() * (all.max[1] - all.min[1])])
                : farthest(points.length >= 2 ? points : [all.min, all.max], p => p).map(inward);
            return pick.map(p => ({ box: { min: p, max: p, top: 0 }, design: null }));
        }
        if (!seeded) return farthest(candidates, c => centreOf(c.box));
        const a = Math.floor(rng() * candidates.length);
        let b = Math.floor(rng() * (candidates.length - 1)); if (b >= a) b++;
        return [candidates[a], candidates[b]];
    }
    function farthest(items, at) {
        let pair = [items[0], items[1]], best = -1;
        for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
            const d = distance2(at(items[i]), at(items[j])); if (d > best) { best = d; pair = [items[i], items[j]]; }
        }
        return pair;
    }

    function planNodes(subjects, field, rng, seeded) {
        const [first, last] = stops(subjects, rng, seeded), a = framing(first.box), b = framing(last.box);
        const outward = Math.atan2(b.centre[1] - a.centre[1], b.centre[0] - a.centre[0]);
        const direction = seeded && rng() < .5 ? -1 : 1, turns = OPTIONS.tourTurns;
        // An orbit point at angle θ moves along θ + direction·90°: the intro ends, and the finale begins,
        // where that is the direction of the tour, so the path leaves and joins them without a corner.
        const side = outward - direction * Math.PI / 2;
        const intro = orbit({ centre: a.centre, radius: a.radius, from: a.high, to: a.low, start: side - direction * TAU * turns, turns, direction, target: a.target, own: first.box, perTurn: OPTIONS.perTurn });
        const finale = orbit({ centre: b.centre, radius: b.radius, from: b.low, to: b.high, start: side, turns, direction, target: b.target, own: last.box, perTurn: OPTIONS.perTurn });
        // The orbit views next to the street path may give way where the path turns back on them (despike).
        intro.slice(-2).forEach(node => { node.tail = true; }); finale.slice(0, 2).forEach(node => { node.tail = true; });
        // The tour passes the plan's other designs in order along the way from first to last.
        const axis = [b.centre[0] - a.centre[0], b.centre[1] - a.centre[1]], span = Math.max(1e-9, axis[0] ** 2 + axis[1] ** 2);
        const vias = subjects.filter(s => s.id !== first.design && s.id !== last.design).map(subjectBox).filter(Boolean).map(centreOf)
            .map(p => ({ p, t: ((p[0] - a.centre[0]) * axis[0] + (p[1] - a.centre[1]) * axis[1]) / span }))
            .sort((x, y) => x.t - y.t).slice(0, 6).map(v => v.p);
        const exit = intro[intro.length - 1].position, entry = finale[0].position;
        let highest = 0;
        for (const h of field.heights) highest = Math.max(highest, h);
        const top = highest + OPTIONS.clearanceM + 5;
        const altitudes = [OPTIONS.cruiseAltitudeM, 25, 40, 60, 90, 130].filter(h => h < top).concat([Math.max(top, OPTIONS.cruiseAltitudeM)]);
        for (const altitude of altitudes) {
            // A design the path cannot reach at this height (an enclosed courtyard) is passed by.
            const open = openness(field, altitude, OPTIONS.clearanceM), legs = [];
            let from = exit;
            for (const via of vias) {
                const cells = findPath(field, open, from, via);
                if (cells) { legs.push(cells); from = field.point(cells[cells.length - 1]); }
            }
            const last = findPath(field, open, from, entry);
            if (!last) continue;
            legs.push(last);
            // One path through every leg, so the corners where legs meet are rounded like any other.
            const cells = [], stays = new Set();
            for (const leg of legs) {
                if (cells.length) stays.add(cells.length - 1);
                cells.push(...(cells.length && cells[cells.length - 1] === leg[0] ? leg.slice(1) : leg));
            }
            const path = waypoints(field, open, cells, OPTIONS, stays).map(({ xy: [x, y], k }) => ({ position: [x, y, altitude], section: 'path', leg: 0, k, cells }));
            // Orbit ends already stand where the path starts and finishes. A path that starts behind the
            // intro's end (its nearest street lies back the way the orbit came) or runs on past the finale's
            // start would make the camera double back there: those street views go too.
            const ahead = [Math.cos(outward), Math.sin(outward)];
            const along = (node, end) => (node.position[0] - end.position[0]) * ahead[0] + (node.position[1] - end.position[1]) * ahead[1];
            const near = (node, end) => distance2(node.position, end.position) < 12;
            const exitNode = intro[intro.length - 1], entryNode = finale[0];
            while (path.length && (near(path[0], exitNode) || (along(path[0], exitNode) < 0 && distance2(path[0].position, exitNode.position) < 60))) path.shift();
            while (path.length && (near(path[path.length - 1], entryNode) || (along(path[path.length - 1], entryNode) > 0 && distance2(path[path.length - 1].position, entryNode.position) < 60))) path.pop();
            return [...intro, ...path, ...finale];
        }
        throw new Error('No clear path between the first and last building.');
    }

    // Every view looks at its target or along the path ahead. Views on the path then turn by at most
    // perMetre radians per metre flown (heading and pitch, both ways along the route), so the look
    // eases between an orbited building and the way ahead instead of snapping.
    function aim(nodes, perMetre = Infinity) {
        const at = (i, ahead) => {
            let left = ahead, here = nodes[i].position;
            for (let k = i + 1; k < nodes.length; k++) {
                const next = nodes[k].position, step = Math.hypot(...sub(next, here));
                if (step >= left) return here.map((x, axis) => x + (next[axis] - x) * left / step);
                left -= step; here = next;
            }
            return here;
        };
        const looks = nodes.map((node, i) => {
            if (node.target) return sub(node.target, node.position);
            const ahead = at(i, OPTIONS.aheadM);
            return sub([ahead[0], ahead[1], ahead[2] - 5], node.position);
        });
        const heading = [], pitch = [];
        looks.forEach((d, i) => {
            const h = Math.atan2(d[1], d[0]), p = Math.atan2(d[2], Math.hypot(d[0], d[1]));
            heading.push(i ? heading[i - 1] + Math.atan2(Math.sin(h - heading[i - 1]), Math.cos(h - heading[i - 1])) : h);
            pitch.push(p);
        });
        if (Number.isFinite(perMetre)) {
            const step = i => Math.hypot(...sub(nodes[i].position, nodes[i - 1].position)) * perMetre;
            const limit = (values, i, j) => {
                if (nodes[i].target) return;
                const most = step(Math.max(i, j));
                values[i] = Math.min(values[j] + most, Math.max(values[j] - most, values[i]));
            };
            for (const values of [heading, pitch]) {
                for (let i = 1; i < nodes.length; i++) limit(values, i, i - 1);
                for (let i = nodes.length - 2; i >= 0; i--) limit(values, i, i + 1);
            }
        }
        return nodes.map((node, i) => {
            if (node.target && !Number.isFinite(perMetre)) return lookAt(node.position, node.target);
            const c = Math.cos(pitch[i]);
            return lookAt(node.position, [node.position[0] + c * Math.cos(heading[i]), node.position[1] + c * Math.sin(heading[i]), node.position[2] + Math.sin(pitch[i])]);
        });
    }

    // Radians the look turns per metre on the views that aim at a subject (orbits), whose looks are fixed.
    function fixedTurnPerMetre(nodes) {
        let most = 0;
        for (let i = 1; i < nodes.length; i++) {
            const a = nodes[i - 1], b = nodes[i];
            if (!a.target || !b.target) continue;
            const da = sub(a.target, a.position), db = sub(b.target, b.position), length = Math.hypot(...sub(b.position, a.position));
            const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(db[1], db[0]) - Math.atan2(da[1], da[0])), Math.cos(Math.atan2(db[1], db[0]) - Math.atan2(da[1], da[0]))));
            if (length > 1e-6) most = Math.max(most, turn / length);
        }
        return most;
    }

    function toRoute(nodes, perMetre = Infinity) {
        const quaternions = aim(nodes, perMetre);
        return nodes.map((node, i) => ({ id: 'auto-' + (i + 1), position: node.position.map(x => Math.round(x * 1000) / 1000),
            quaternion: quaternions[i], travelSeconds: null, holdSeconds: i === 0 ? 1 : i === nodes.length - 1 ? 2 : 0, turn: null }));
    }

    // Places where the playback curve (not only the views) comes within the margins of an obstacle.
    function obstructions(route, field, options = OPTIONS, side = dilate(field, options.sideClearanceM)) {
        const times = Flight.timeline({ route, speedMps: 10, looks: [], cues: [] }), found = [];
        route.forEach((point, i) => {
            const need = side.at(point.position[0], point.position[1]) + options.clearanceM;
            if (point.position[2] < need) found.push({ segment: i, fraction: 0, deficit: need - point.position[2] });
            if (!i) return;
            const segment = times.segments[i], steps = Math.max(2, Math.ceil(segment.length));
            let worst = null;
            for (let s = 1; s < steps; s++) {
                const p = segment.at(s / steps), lack = side.at(p[0], p[1]) + options.clearanceM - p[2];
                if (lack > 0 && (!worst || lack > worst.deficit)) worst = { segment: i, fraction: s / steps, deficit: lack };
            }
            if (worst) found.push(worst);
        });
        return found;
    }

    // Whether anything outside the subject's own footprint stands between the eye and the target.
    function sees(field, eye, target, own) {
        const steps = Math.max(2, Math.ceil(distance2(eye, target) / field.cell));
        for (let s = 1; s < steps; s++) {
            const p = eye.map((x, i) => x + (target[i] - x) * s / steps);
            if (own && p[0] >= own.min[0] - 3 && p[0] <= own.max[0] + 3 && p[1] >= own.min[1] - 3 && p[1] <= own.max[1] + 3) continue;
            if (field.at(p[0], p[1]) > p[2]) return false;
        }
        return true;
    }

    // Drops views where the route turns back on itself within a short stretch (a design reached up a
    // dead end, a loop round a design it passes, a street starting behind an orbit's end): flown, those
    // are a jerk, not a turn. Only path views and an orbit's last or first two views next to the path
    // go; the stretch is replaced by a straight line, and the clearance repair runs afterwards.
    function despike(nodes, maxTurn = Math.PI * 5 / 9, shortM = 25) {
        const removable = node => node.section === 'path' || node.tail;
        const signed = (a, b, c) => {
            const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
            return Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
        };
        for (let changed = true; changed;) {
            changed = false;
            for (let i = 0; i + 2 < nodes.length && !changed; i++) {
                let length = distance2(nodes[i].position, nodes[i + 1].position), turned = 0;
                for (let j = i + 2; j < nodes.length && removable(nodes[j - 1]); j++) {
                    const step = distance2(nodes[j - 1].position, nodes[j].position);
                    if (step < 1 || distance2(nodes[j - 2].position, nodes[j - 1].position) < 1) { nodes.splice(j - 1, 1); changed = true; break; }
                    turned += signed(nodes[j - 2].position, nodes[j - 1].position, nodes[j].position);
                    length += step;
                    if (length > shortM && j > i + 2) break;
                    if (Math.abs(turned) > maxTurn) { nodes.splice(i + 1, j - i - 1); changed = true; break; }
                }
            }
        }
        return nodes;
    }

    // Lift every view clear of what is below it and, when it looks at a subject, high enough to see
    // it over its neighbours. Then fix the curve between views: where the straight line between two
    // views is clear and the curve only bulges off it, a midpoint on that line pins the curve; otherwise
    // a path segment takes back the planned cells it skipped, and anything else climbs until it is clear.
    function clear(nodes, field) {
        const side = dilate(field, OPTIONS.sideClearanceM);
        let highest = 0;
        for (const h of field.heights) highest = Math.max(highest, h);
        for (const node of nodes) {
            node.position[2] = Math.max(node.position[2], side.at(node.position[0], node.position[1]) + OPTIONS.clearanceM);
            if (!node.target) continue;
            while (node.position[2] < highest + 60 && !sees(field, node.position, node.target, node.own)) node.position[2] += 4;
        }
        const chordClear = (a, b) => {
            const steps = Math.max(2, Math.ceil(distance2(a, b)));
            for (let s = 0; s <= steps; s++) {
                const p = a.map((x, i) => x + (b[i] - x) * s / steps);
                if (side.at(p[0], p[1]) + OPTIONS.clearanceM > p[2]) return false;
            }
            return true;
        };
        for (let round = 0; round < 24; round++) {
            const found = obstructions(toRoute(nodes), field, OPTIONS, side);
            if (!found.length) return nodes;
            // Raises first, then insertions from the end, so every index still names its segment.
            for (const issue of found.filter(f => !f.fraction)) nodes[issue.segment].position[2] += issue.deficit + 1;
            for (const issue of found.filter(f => f.fraction).sort((x, y) => y.segment - x.segment)) {
                const i = issue.segment, a = nodes[i - 1], b = nodes[i], onPath = a.section === 'path' || b.section === 'path';
                const pathNode = a.section === 'path' ? a : b;
                if (onPath && Math.hypot(...sub(b.position, a.position)) > 4 && chordClear(a.position, b.position)) {
                    nodes.splice(i, 0, { ...pathNode, position: a.position.map((x, k) => (x + b.position[k]) / 2), section: 'path' });
                } else if (a.section === 'path' && b.section === 'path' && a.leg === b.leg && b.k - a.k > 1) {
                    const k = (a.k + b.k) >> 1, [x, y] = field.point(a.cells[k]);
                    nodes.splice(i, 0, { position: [x, y, Math.max(a.position[2], b.position[2])], section: 'path', leg: a.leg, k, cells: a.cells });
                } else {
                    a.position[2] += issue.deficit + 1; b.position[2] += issue.deficit + 1;
                }
            }
        }
        throw new Error('No clear flight path around these buildings.');
    }

    // Travel times that slow the flight where its path curves tightly, and ease it into and out of those
    // curves with limited acceleration. A segment is flown at the mean of its two ends' speeds (playback
    // is uniform within a segment); one already flown at cruise speed keeps no override.
    function pace(route, speedMps) {
        const lengths = Flight.timeline({ route, speedMps, looks: [], cues: [] }).segments.map(segment => (segment ? segment.length : 0));
        const heading = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]), turnCap = OPTIONS.maxTravelTurnDegPerS * Math.PI / 180;
        const speeds = route.map((point, k) => {
            if (!k || k === route.length - 1) return speedMps;
            const a = route[k - 1].position, b = point.position, c = route[k + 1].position;
            if (distance2(a, b) < 1e-6 || distance2(b, c) < 1e-6) return speedMps;
            const turn = Math.abs(Math.atan2(Math.sin(heading(b, c) - heading(a, b)), Math.cos(heading(b, c) - heading(a, b))));
            return turn < 1e-6 ? speedMps : Math.min(speedMps, Math.max(OPTIONS.slowestMps, turnCap * (lengths[k] + lengths[k + 1]) / 2 / turn));
        });
        const a2 = 2 * OPTIONS.accelerationMps2;
        for (let k = 1; k < speeds.length; k++) speeds[k] = Math.min(speeds[k], Math.sqrt(speeds[k - 1] ** 2 + a2 * lengths[k]));
        for (let k = speeds.length - 2; k >= 0; k--) speeds[k] = Math.min(speeds[k], Math.sqrt(speeds[k + 1] ** 2 + a2 * lengths[k + 1]));
        return route.map((point, k) => {
            if (!k || lengths[k] < 1e-9) return point;
            const seconds = 2 * lengths[k] / (speeds[k - 1] + speeds[k]), cruise = Math.max(Flight.LIMITS.minTravelSeconds, lengths[k] / speedMps);
            return Math.abs(seconds - cruise) / cruise < .01 ? point : { ...point, travelSeconds: Math.round(seconds * 100) / 100 };
        });
    }

    // generate({ subjects, field, seed }) → { kind, route, speedMps }. Subjects carry metric building
    // boxes { min, max, top } and outline points; the field is a grid() of rendered top heights.
    function generate({ subjects, field, seed = 0 }) {
        checkSubjects(subjects);
        if (!field || typeof field.at !== 'function') throw new TypeError('Invalid flight height grid.');
        const seeded = !!seed, rng = random(seed), kind = subjects.length === 1 ? 'design' : 'plan';
        // The clearance repair can leave a hook where it adds or lifts views: smooth again, then repair once more.
        const nodes = kind === 'design' ? clear(designNodes(subjects[0], rng, seeded), field)
            : clear(despike(clear(despike(planNodes(subjects, field, rng, seeded)), field)), field);
        if (nodes.length > OPTIONS.maxPoints) throw new Error('This plan is too large for one generated flight.');
        const length = Flight.timeline({ route: toRoute(nodes), speedMps: 1, looks: [], cues: [] }).segments.reduce((sum, s) => sum + (s ? s.length : 0), 0);
        // Fast enough for the target duration, slow enough that an orbit never turns the camera past the cap.
        const cap = OPTIONS.maxTurnDegPerS * Math.PI / 180, orbitTurn = fixedTurnPerMetre(nodes);
        let speedMps = Math.min(OPTIONS.maxSpeedMps, Math.max(OPTIONS.minSpeedMps, length / OPTIONS.targetSeconds));
        if (orbitTurn > 0) speedMps = Math.max(OPTIONS.minSpeedMps, Math.min(speedMps, cap / orbitTurn));
        if (length / speedMps > Flight.LIMITS.seconds - 10) speedMps = Math.min(Flight.LIMITS.maxSpeedMps, length / (Flight.LIMITS.seconds - 10));
        speedMps = Math.round(speedMps * 10) / 10;
        return { kind, route: pace(toRoute(nodes, cap / speedMps), speedMps), speedMps };
    }

    return Object.freeze({ OPTIONS, lookAt, grid, dilate, openness, findPath, bounds, obstructions, sees, generate });
});
