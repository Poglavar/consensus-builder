// Step 2b: fit a vectorized floor plan into its storey outline. Works in local metres ([x, y],
// y north). Printed scale and north are soft priors that add to a fit's score, never gates.
// Pure geometry; turf supplies planar polygon intersection only (areas are computed here).
import * as turf from '@turf/turf';

const DEG = Math.PI / 180;

export function ringArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    return Math.abs(sum) / 2;
}
const closed = ring => (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ? [...ring, ring[0]] : ring);
const open = ring => (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring);

function geometryArea(geometry) {
    if (!geometry) return 0;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polygons.reduce((sum, rings) => sum + ringArea(rings[0]) - rings.slice(1).reduce((h, ring) => h + ringArea(ring), 0), 0);
}

const snap = ring => ring.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);

function inside([x, y], ring) {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
}

// Overlap by sampling a grid; the fallback when exact clipping fails on near-degenerate input.
export function sampledIntersectionArea(a, b, step = 0.2) {
    const xs = a.map(p => p[0]), ys = a.map(p => p[1]);
    let count = 0;
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
        for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) if (inside([x, y], a) && inside([x, y], b)) count++;
    return count * step * step;
}

export function intersectionArea(a, b) {
    try {
        const hit = turf.intersect(turf.polygon([closed(snap(a))]), turf.polygon([closed(snap(b))]));
        return hit ? geometryArea(hit.geometry) : 0;
    } catch {
        return sampledIntersectionArea(open(a), open(b));
    }
}

export function centroid(ring) {
    const points = open(ring);
    let a = 0, x = 0, y = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const f = points[j][0] * points[i][1] - points[i][0] * points[j][1];
        a += f; x += (points[j][0] + points[i][0]) * f; y += (points[j][1] + points[i][1]) * f;
    }
    return a ? [x / (3 * a), y / (3 * a)] : points[0];
}

// Length-weighted dominant wall direction, folded into [0, 90) degrees.
export function dominantAngle(ring) {
    const bins = new Array(90).fill(0), points = open(ring);
    for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
        const length = Math.hypot(x2 - x1, y2 - y1);
        if (!length) continue;
        const angle = ((Math.atan2(y2 - y1, x2 - x1) / DEG) % 90 + 90) % 90;
        bins[Math.round(angle) % 90] += length;
    }
    const peak = bins.indexOf(Math.max(...bins));
    // Refine within ±2° of the peak bin.
    let weight = 0, sum = 0;
    for (let d = -2; d <= 2; d++) { const k = (peak + d + 90) % 90; weight += bins[k]; sum += bins[k] * (peak + d); }
    return weight ? ((sum / weight) % 90 + 90) % 90 : 0;
}

export function transformRing(ring, { scale, rotationDeg, tx, ty }) {
    const c = Math.cos(rotationDeg * DEG), s = Math.sin(rotationDeg * DEG);
    return ring.map(([x, y]) => [scale * (c * x - s * y) + tx, scale * (s * x + c * y) + ty]);
}

function segmentDistance([px, py], [x1, y1], [x2, y2]) {
    const dx = x2 - x1, dy = y2 - y1, length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / length2)) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Share of a ring's perimeter that lies within `tolerance` metres of the target boundary.
export function boundaryCoincidence(ring, target, tolerance = 0.4, step = 0.25) {
    const points = open(ring), edges = open(target).map((point, i, all) => [point, all[(i + 1) % all.length]]);
    let total = 0, near = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const samples = Math.max(1, Math.ceil(length / step));
        for (let k = 0; k < samples; k++) {
            const t = (k + 0.5) / samples, p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
            total += length / samples;
            if (edges.some(([e1, e2]) => segmentDistance(p, e1, e2) <= tolerance)) near += length / samples;
        }
    }
    return total ? near / total : 0;
}

const angleGap = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };

// The key plan shows where the unit sits in its floor, drawn in the plan's own orientation: turn the
// placed unit back into that orientation and compare its position within the storey's extent.
export function positionAgreement(placedRing, target, rotationDeg, [u, v]) {
    const c = Math.cos(-rotationDeg * DEG), s = Math.sin(-rotationDeg * DEG);
    const turn = ([x, y]) => [c * x - s * y, s * x + c * y];
    const t = open(target).map(turn), [px, py] = turn(centroid(placedRing));
    const xs = t.map(p => p[0]), ys = t.map(p => p[1]);
    const nu = (px - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs)), nv = (Math.max(...ys) - py) / (Math.max(...ys) - Math.min(...ys));
    return Math.hypot(nu - u, nv - v);
}

function priorBonus(placement, { scalePrior, rotationPrior }) {
    let bonus = 0;
    // Deviating from the plan's own scale costs score, so shrinking a unit to fit is not free.
    if (scalePrior?.mPerUnit) bonus -= (scalePrior.weight ?? 1.5) * Math.abs(placement.scale / scalePrior.mPerUnit - 1);
    if (typeof rotationPrior?.deg === 'number') bonus += angleGap(placement.rotationDeg, rotationPrior.deg) <= (rotationPrior.toleranceDeg ?? 15) ? 0.08 : -0.08;
    return bonus;
}

function sameTransform(a, b) {
    return Math.abs(a.scale / b.scale - 1) < 0.02 && angleGap(a.rotationDeg, b.rotationDeg) < 3 && Math.hypot(a.tx - b.tx, a.ty - b.ty) < 0.75;
}

function rankPlacements(placements, minimum) {
    const ranked = [];
    for (const placement of placements.sort((a, b) => b.score - a.score)) if (!ranked.some(other => sameTransform(other, placement))) ranked.push(placement);
    const [top, second] = ranked;
    const margin = top ? top.score - (second?.score ?? 0) : 0;
    const status = !top || top.score < minimum ? 'unplaced' : margin < 0.03 ? 'ambiguous' : 'placed';
    return { status, margin: Math.round(margin * 1000) / 1000, placements: ranked.slice(0, 5) };
}

function fitFloor(plan, target, scales, rotations, priors) {
    const targetArea = ringArea(target), [cx, cy] = centroid(target), out = [];
    for (const scale of scales) for (const rotationDeg of rotations) {
        const base = transformRing(plan, { scale, rotationDeg, tx: 0, ty: 0 });
        const [px, py] = centroid(base);
        let best = null;
        for (let dx = -2; dx <= 2; dx += 0.5) for (let dy = -2; dy <= 2; dy += 0.5) {
            const t = { scale, rotationDeg, tx: cx - px + dx, ty: cy - py + dy };
            const placed = transformRing(plan, t), shared = intersectionArea(placed, target);
            const iou = shared / (ringArea(placed) + targetArea - shared);
            if (!best || iou > best.iou) best = { ...t, iou };
        }
        out.push({ ...best, score: best.iou + priorBonus(best, priors) });
    }
    return out;
}

// Grow a local-metre ring outward. turf buffers in degrees, so the ring is mapped onto the equator,
// where a degree is the same length in both axes, buffered there and mapped back.
export function growRing(ring, metres) {
    const k = 111320;
    const grown = turf.buffer(turf.polygon([closed(open(ring).map(([x, y]) => [x / k, y / k]))]), metres / 1000, { units: 'kilometers', steps: 2 });
    const rings = grown.geometry.type === 'Polygon' ? [grown.geometry.coordinates[0]] : grown.geometry.coordinates.map(p => p[0]);
    return open(rings.sort((a, b) => ringArea(b) - ringArea(a))[0]).map(([x, y]) => [x * k, y * k]);
}

// Balconies and loggias commonly project beyond a permit's ground footprint; a unit may reach this far out.
export const PROJECTION_M = 1.8;

// Where the key plan puts the unit: its normalized position in the storey, drawn in the plan's own
// orientation, mapped back into world metres for a given rotation.
function priorPoint(target, rotationDeg, [u, v]) {
    const c = Math.cos(-rotationDeg * DEG), s = Math.sin(-rotationDeg * DEG);
    const t = open(target).map(([x, y]) => [c * x - s * y, s * x + c * y]);
    const xs = t.map(p => p[0]), ys = t.map(p => p[1]);
    const local = [Math.min(...xs) + u * (Math.max(...xs) - Math.min(...xs)), Math.max(...ys) - v * (Math.max(...ys) - Math.min(...ys))];
    const cb = Math.cos(rotationDeg * DEG), sb = Math.sin(rotationDeg * DEG);
    return [cb * local[0] - sb * local[1], sb * local[0] + cb * local[1]];
}

// Candidate offsets: plan corners on storey corners, and — when the key plan says where the unit is —
// the unit centred there and slid onto each nearby parallel facade (mid-facade units have no corner).
function unitOffsets(base, target, rotationDeg, priors) {
    const offsets = [];
    for (const corner of open(base)) for (const vertex of open(target)) offsets.push([vertex[0] - corner[0], vertex[1] - corner[1]]);
    if (priors.positionPrior) {
        const [px, py] = priorPoint(target, rotationDeg, priors.positionPrior.center), [cx, cy] = centroid(base);
        const centred = [px - cx, py - cy];
        offsets.push(centred);
        const moved = base.map(([x, y]) => [x + centred[0], y + centred[1]]);
        const edges = ring => open(ring).map((p, i, all) => [p, all[(i + 1) % all.length]]);
        for (const [a, b] of edges(target)) {
            const ex = b[0] - a[0], ey = b[1] - a[1], length = Math.hypot(ex, ey);
            if (length < 2) continue;
            const nx = -ey / length, ny = ex / length;
            for (const [p, q] of edges(moved)) {
                const px2 = q[0] - p[0], py2 = q[1] - p[1], plen = Math.hypot(px2, py2);
                if (plen < 1 || Math.abs((px2 * ex + py2 * ey) / (plen * length)) < Math.cos(5 * DEG)) continue;
                const gap = (a[0] - p[0]) * nx + (a[1] - p[1]) * ny;
                if (Math.abs(gap) <= 12) offsets.push([centred[0] + gap * nx, centred[1] + gap * ny]);
            }
        }
    }
    return offsets;
}

function fitUnit(plan, target, scales, rotations, priors) {
    const out = [], allowed = growRing(target, PROJECTION_M);
    for (const scale of scales) for (const rotationDeg of rotations) {
        const base = transformRing(plan, { scale, rotationDeg, tx: 0, ty: 0 }), planArea = ringArea(base);
        for (const [dx, dy] of unitOffsets(base, target, rotationDeg, priors)) {
            const t = { scale, rotationDeg, tx: dx, ty: dy };
            const placed = transformRing(plan, t);
            const containment = intersectionArea(placed, allowed) / planArea;
            if (containment < 0.9) continue;
            const coincidence = boundaryCoincidence(placed, target);
            let position = 0, positionDistance = null;
            if (priors.positionPrior) {
                positionDistance = positionAgreement(placed, target, t.rotationDeg, priors.positionPrior.center);
                position = (priors.positionPrior.weight ?? 0.2) * (0.5 - Math.min(1, positionDistance / 0.5));
            }
            out.push({ ...t, containment, coincidence, positionDistance, score: 0.5 * containment + 0.5 * coincidence + position + priorBonus(t, priors) });
        }
    }
    return out;
}

// plan: outline ring in plan units (y up); target: storey outline ring in metres.
export function fitPlan({ plan, target, scope = 'floor', scalePrior = null, rotationPrior = null, positionPrior = null }) {
    if (!Array.isArray(plan) || plan.length < 3 || !Array.isArray(target) || target.length < 3) return { status: 'unplaced', reason: 'missing-outline', placements: [] };
    const planArea = ringArea(plan), targetArea = ringArea(target);
    let scales;
    // A measured scale may be off by a few percent; an estimated one (doors, listing area) by much more.
    if (scalePrior?.mPerUnit > 0) {
        const tolerance = scalePrior.tolerance ?? 0.03, steps = Math.max(1, Math.round(tolerance / 0.03));
        scales = Array.from({ length: 2 * steps + 1 }, (_, i) => scalePrior.mPerUnit * (1 + tolerance * (i - steps) / steps));
    }
    else if (scope === 'floor') { const s = Math.sqrt(targetArea / planArea); scales = [0.95, 1, 1.05].map(f => s * f); }
    else {
        // A "unit" drawing with no scale may still be the whole storey (a roof flat bounded by party
        // walls): accept a full-floor fit when the shapes broadly agree (a drawn rectangle against a
        // notched footprint reaches about 0.65).
        const whole = fitPlan({ plan, target, scope: 'floor', rotationPrior });
        const best = whole.placements?.[0];
        return best?.iou >= 0.6 ? { ...whole, scope: 'floor-inferred' } : { status: 'unplaced', reason: 'unit-without-scale', placements: [] };
    }
    const turn = ((dominantAngle(target) - dominantAngle(plan)) % 90 + 90) % 90;
    const rotations = [0, 90, 180, 270].map(k => (turn + k) % 360);
    const priors = { scalePrior, rotationPrior, positionPrior };
    const placements = scope === 'floor' ? fitFloor(plan, target, scales, rotations, priors) : fitUnit(plan, target, scales, rotations, priors);
    return { ...rankPlacements(placements, scope === 'floor' ? 0.6 : 0.65), scope };
}

// Local tangent-plane metres around an origin, for footprints given in WGS84.
export function toLocalMetres(ring, [lng0, lat0]) {
    const kx = 111320 * Math.cos(lat0 * DEG), ky = 110574;
    return ring.map(([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky]);
}
export function toLngLat(ring, [lng0, lat0]) {
    const kx = 111320 * Math.cos(lat0 * DEG), ky = 110574;
    return ring.map(([x, y]) => [lng0 + x / kx, lat0 + y / ky]);
}
