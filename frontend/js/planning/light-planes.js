// Light planes: whether a building stays under a plane rising at a stated angle from a base (a plot
// boundary, a block's street edge), the test many building codes state ("must not be capable of being
// touched by a line elevated N degrees from the boundary"). Pure, in local metres (x east, y north):
// the caller projects geometry and builds the massing. A line from each base point to each point of the
// building rises at the plane's angle, which may depend on the line's compass direction; an
// intervening building can raise the line without rotating it until it just clears its top. The
// existing volume of a raised building never counts against a plane (codes allow keeping it).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LightPlanes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const RAD = Math.PI / 180;
    // How finely boundaries and footprints are sampled, and how deep a piercing must be to count.
    const STEP_M = 1;
    const TOLERANCE_M = 0.02;

    // Points every stepM along a ring (its vertices included).
    function sampleRing(ring, stepM = STEP_M) {
        const out = [];
        for (let i = 0; i + 1 < ring.length; i++) {
            const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
            const length = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(length / stepM));
            for (let k = 0; k < n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
        }
        return out;
    }
    function inRing(ring, [x, y]) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }
    // polygons: [[outer, ...holes], ...]
    const inPolygons = (polygons, p) => polygons.some(polygon => inRing(polygon[0], p) && !polygon.slice(1).some(hole => inRing(hole, p)));
    function pointSegment([px, py], [ax, ay], [bx, by]) {
        const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
        return Math.hypot(px - ax - t * dx, py - ay - t * dy);
    }
    // Distance from a point to the nearest edge of polygons (0 on an edge).
    function edgeDistance(polygons, p) {
        let best = Infinity;
        for (const polygon of polygons) for (const ring of polygon) for (let i = 0; i + 1 < ring.length; i++) best = Math.min(best, pointSegment(p, ring[i], ring[i + 1]));
        return best;
    }
    const boxOf = points => points.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);

    /**
     * The points of a massing to test: its footprint boundary every stepM, and a grid inside it.
     * polygons: [[outer, ...holes], ...] in local metres.
     */
    function massingPoints(polygons, stepM = STEP_M) {
        const out = polygons.flatMap(polygon => polygon.flatMap(ring => sampleRing(ring, stepM)));
        const box = boxOf(polygons.flatMap(polygon => polygon[0]));
        for (let x = box[0] + stepM / 2; x < box[2]; x += stepM) for (let y = box[1] + stepM / 2; y < box[3]; y += stepM) if (inPolygons(polygons, [x, y])) out.push([x, y]);
        return out;
    }

    /**
     * The elevation angle (degrees) of a plane's line in a compass direction (dx east, dy north).
     * `angle` is a number, or { northOfEastWest, fromSouth: { base, perDegree } }: a line running north
     * of due east or west rises at northOfEastWest; one x° away from due south at base + x·perDegree.
     */
    function degreesFor(angle, dx, dy) {
        if (finite(angle)) return angle;
        if (dy > 0) return angle.northOfEastWest;
        const fromSouth = Math.atan2(Math.abs(dx), -dy) / RAD;
        return angle.fromSouth.base + fromSouth * angle.fromSouth.perDegree;
    }

    // Where the segment q→p first enters a raiser's footprint (distance from q), or null.
    function entryDistance(q, p, raiser) {
        const dx = p[0] - q[0], dy = p[1] - q[1], length = Math.hypot(dx, dy);
        if (!length) return null;
        if (inPolygons(raiser.polygons, q)) return 0;
        let first = Infinity;
        for (const polygon of raiser.polygons) for (const ring of polygon) for (let i = 0; i + 1 < ring.length; i++) {
            const [ax, ay] = ring[i], ex = ring[i + 1][0] - ax, ey = ring[i + 1][1] - ay;
            const denominator = dx * ey - dy * ex;
            if (!denominator) continue;
            const t = ((ax - q[0]) * ey - (ay - q[1]) * ex) / denominator, u = ((ax - q[0]) * dy - (ay - q[1]) * dx) / denominator;
            if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < first) first = t;
        }
        return first === Infinity ? null : first * length;
    }

    /**
     * The plane's height at p: the lowest line from any base point to p. plane = { base: points,
     * baseHeightM, angle, raisers: [{ polygons, heightM, box }] } — a raiser is a building between the
     * base and the development that lifts the line, without rotating it, until it just touches its
     * top. `reachM` skips base points from which no line can be the lowest.
     */
    function heightAt(plane, p, reachM = Infinity) {
        let best = Infinity, from = null;
        for (const q of plane.base) {
            const dx = p[0] - q[0], dy = p[1] - q[1], d = Math.hypot(dx, dy);
            if (d > reachM) continue;
            const slope = Math.tan(degreesFor(plane.angle, dx, dy) * RAD);
            let start = plane.baseHeightM || 0;
            for (const raiser of plane.raisers || []) {
                const [minX, minY, maxX, maxY] = raiser.box;
                if (Math.max(q[0], p[0]) < minX || Math.min(q[0], p[0]) > maxX || Math.max(q[1], p[1]) < minY || Math.min(q[1], p[1]) > maxY) continue;
                const entry = entryDistance(q, p, raiser);
                if (entry !== null && entry < d) start = Math.max(start, raiser.heightM - entry * slope);
            }
            const height = start + d * slope;
            if (height < best) { best = height; from = q; }
        }
        return { heightM: best, from };
    }

    /**
     * Whether a massing stays under a plane. massing = { polygons, topAt(p) → metres or null,
     * exemptBelowM } where exemptBelowM is the existing building's height (its volume is kept), null
     * when unknown, or 0 for a new building. Returns { status: 'clear' | 'pierced' | 'unknown',
     * clearM (the least room above the massing, negative when pierced), at, from }.
     * `checkSteps` is the same as a generator that yields after each point of the massing, so a
     * caller can slice it between browser frames (work-slicer.js runSliced); `check` runs it through.
     */
    function check(plane, massing, options) {
        const steps = checkSteps(plane, massing, options);
        let step = steps.next();
        while (!step.done) step = steps.next();
        return step.value;
    }
    function* checkSteps(plane, massing, { stepM = STEP_M } = {}) {
        const points = massingPoints(massing.polygons, stepM);
        const tops = points.map(p => massing.topAt(p));
        if (!points.length || tops.some(top => !finite(top))) return { status: 'unknown', clearM: null, at: null, from: null };
        const highest = Math.max(...tops);
        const shallowest = finite(plane.angle) ? plane.angle : Math.min(plane.angle.northOfEastWest, plane.angle.fromSouth.base);
        const lift = Math.max(plane.baseHeightM || 0, ...(plane.raisers || []).map(raiser => raiser.heightM));
        const reachM = (highest + Math.max(0, lift)) / Math.tan(shallowest * RAD) + stepM;
        const exempt = massing.exemptBelowM;
        let worst = { clearM: Infinity, at: null, from: null }, unsure = false;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (finite(exempt) && tops[i] <= exempt) continue;
            const { heightM, from } = heightAt(plane, p, reachM);
            yield;
            if (!finite(heightM)) continue;
            const room = (finite(exempt) ? Math.max(heightM, exempt) : heightM) - tops[i];
            // Above the plane but within a volume that may be existing, of unknown height: unknown.
            if (room < -TOLERANCE_M && exempt === null) { unsure = true; continue; }
            if (room < worst.clearM) worst = { clearM: room, at: p, from };
        }
        if (unsure && !(worst.clearM < -TOLERANCE_M)) return { status: 'unknown', clearM: null, at: null, from: null };
        if (worst.clearM === Infinity) return { status: 'clear', clearM: null, at: null, from: null };
        return { status: worst.clearM < -TOLERANCE_M ? 'pierced' : 'clear', clearM: Math.round(worst.clearM * 100) / 100, at: worst.at, from: worst.from };
    }

    /**
     * The points of plot boundaries that face away from the plots of one area: the edge of a block
     * (its plots' boundaries not shared with another of its plots). plots: [{ polygons }].
     */
    function outerEdge(plots, { stepM = STEP_M, toleranceM = 0.5 } = {}) {
        const out = [];
        const boxes = plots.map(plot => boxOf(plot.polygons.flatMap(polygon => polygon[0])));
        const near = (b, [x, y]) => x >= b[0] - toleranceM && x <= b[2] + toleranceM && y >= b[1] - toleranceM && y <= b[3] + toleranceM;
        plots.forEach((plot, index) => {
            for (const point of plot.polygons.flatMap(polygon => polygon.flatMap(ring => sampleRing(ring, stepM)))) {
                const shared = plots.some((other, j) => j !== index && near(boxes[j], point) && (inPolygons(other.polygons, point) || edgeDistance(other.polygons, point) <= toleranceM));
                if (!shared) out.push(point);
            }
        });
        return out;
    }

    // The boundary points of polygons, every stepM.
    const boundaryPoints = (polygons, stepM = STEP_M) => polygons.flatMap(polygon => polygon.flatMap(ring => sampleRing(ring, stepM)));
    // Whether a massing stands on a plot: some of its footprint points lie inside it.
    function standsOn(plotPolygons, massingPolygons, { stepM = STEP_M } = {}) {
        return massingPoints(massingPolygons, stepM).some(p => inPolygons(plotPolygons, p) && edgeDistance(plotPolygons, p) > TOLERANCE_M);
    }
    // The least distance from one set of polygons' boundary to another's.
    function apart(a, b, { stepM = STEP_M } = {}) {
        let best = Infinity;
        for (const p of boundaryPoints(a, stepM)) best = Math.min(best, inPolygons(b, p) ? 0 : edgeDistance(b, p));
        return best;
    }
    const raiser = (polygons, heightM) => ({ polygons, heightM, box: boxOf(polygons.flatMap(polygon => polygon[0])) });

    return { STEP_M, TOLERANCE_M, sampleRing, inPolygons, edgeDistance, boxOf, massingPoints, degreesFor, heightAt, check, checkSteps, outerEdge, boundaryPoints, standsOn, apart, raiser };
});
