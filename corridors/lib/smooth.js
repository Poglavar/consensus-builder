// Curvature smoothing: turn a jagged least-cost grid path into a rail-legal
// centerline made of straight tangents joined by circular arcs of radius
// >= minCurveRadius (clothoid transitions are a refinement left for later —
// arc-fitting is the binding horizontal constraint for parcel selection).
export function simplify(points, tolerance) {
    // Douglas-Peucker.
    if (points.length <= 2) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let maxD = 0, maxI = -1;
        for (let i = a + 1; i < b; i++) {
            const d = pointSegDist(points[i], points[a], points[b]);
            if (d > maxD) { maxD = d; maxI = i; }
        }
        if (maxD > tolerance) {
            keep[maxI] = 1;
            stack.push([a, maxI], [maxI, b]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

export function filletPath(points, radius, sampleStep = 10) {
    // Fit an arc of `radius` at every interior vertex. If the tangent lengths
    // don't fit on the adjacent segments, drop the vertex with the smallest
    // turn (loses the least shape) and retry. Returns null if the path
    // degenerates to fewer than 2 points.
    let pts = points.slice();
    for (let guard = 0; guard < points.length + 10; guard++) {
        const turns = interiorTurns(pts);
        const t = turns.map(turn => radius * Math.tan(turn / 2));
        let violated = -1;
        for (let k = 0; k < pts.length - 1; k++) {
            const need = (k > 0 ? t[k - 1] : 0) + (k < pts.length - 2 ? t[k] : 0);
            if (need > dist(pts[k], pts[k + 1])) { violated = k; break; }
        }
        if (violated === -1) return sampleFillets(pts, turns, t, radius, sampleStep);
        // Drop the endpoint of the violated segment with the smaller turn.
        const leftTurn = violated > 0 ? turns[violated - 1] : Infinity;
        const rightTurn = violated < pts.length - 2 ? turns[violated] : Infinity;
        const dropIdx = leftTurn <= rightTurn ? violated : violated + 1;
        if (dropIdx === 0 || dropIdx === pts.length - 1 || pts.length <= 3) return null;
        pts.splice(dropIdx, 1);
    }
    return null;
}

function interiorTurns(pts) {
    const turns = [];
    for (let k = 1; k < pts.length - 1; k++) {
        const d1 = unit(sub(pts[k], pts[k - 1]));
        const d2 = unit(sub(pts[k + 1], pts[k]));
        const dot = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]));
        turns.push(Math.acos(dot));
    }
    return turns;
}

function sampleFillets(pts, turns, t, radius, step) {
    const out = [pts[0].slice()];
    for (let k = 1; k < pts.length - 1; k++) {
        const turn = turns[k - 1], tk = t[k - 1];
        const d1 = unit(sub(pts[k], pts[k - 1]));
        const d2 = unit(sub(pts[k + 1], pts[k]));
        if (turn < 1e-4) { out.push(pts[k].slice()); continue; }
        const p1 = [pts[k][0] - d1[0] * tk, pts[k][1] - d1[1] * tk]; // arc entry
        const side = Math.sign(d1[0] * d2[1] - d1[1] * d2[0]) || 1;  // turn direction
        const center = [p1[0] - d1[1] * side * radius, p1[1] + d1[0] * side * radius];
        const a1 = Math.atan2(p1[1] - center[1], p1[0] - center[0]);
        const steps = Math.max(2, Math.ceil(turn * radius / step));
        for (let s = 0; s <= steps; s++) {
            const a = a1 + side * turn * s / steps;
            out.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
        }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
}

export function pathLength(coords) {
    let len = 0;
    for (let k = 0; k < coords.length - 1; k++) len += dist(coords[k], coords[k + 1]);
    return len;
}

export function minDiscreteRadius(coords, spacing = 25) {
    // Resample at fixed spacing, then take the min circumradius over
    // consecutive point triples — a discrete curvature check on the result.
    const rs = resample(coords, spacing);
    let minR = Infinity;
    for (let k = 1; k < rs.length - 1; k++) {
        const r = circumradius(rs[k - 1], rs[k], rs[k + 1]);
        if (r < minR) minR = r;
    }
    return minR;
}

export function resample(coords, spacing) {
    const out = [coords[0].slice()];
    let carry = 0;
    for (let k = 0; k < coords.length - 1; k++) {
        const segLen = dist(coords[k], coords[k + 1]);
        if (segLen === 0) continue;
        let d = spacing - carry;
        while (d <= segLen) {
            const f = d / segLen;
            out.push([coords[k][0] + (coords[k + 1][0] - coords[k][0]) * f,
                coords[k][1] + (coords[k + 1][1] - coords[k][1]) * f]);
            d += spacing;
        }
        carry = segLen - (d - spacing);
    }
    out.push(coords[coords.length - 1].slice());
    return out;
}

function circumradius(a, b, c) {
    const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a);
    const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (area2 < 1e-9) return Infinity; // collinear
    return (ab * bc * ca) / (2 * area2);
}

function pointSegDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function unit(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
