// The junction as an object of its own (road-editor.md decision 1): where arms meet, this module
// turns the node and its arms into real corner geometry — a kerb-return fillet between every pair
// of angular neighbours, the carriageway surface that results, the sidewalk band that wraps each
// corner, the land each corner needs beyond the straight edges, stop lines and zebras on each
// approach, and how far from the node every arm belongs to the junction (its "cut"). Pure planar
// geometry in metres ([x, y] with y up, as metric-frame.js gives it): no profile vocabulary beyond
// the per-arm edge numbers corridor-profile.js derives, no lat/lng, no DOM. corridor-profile.js
// (2D treatments and marking trims), corridor-footprint.js (land corners) and three-mode.js (3D)
// all consume the same result, so they cannot disagree about where a junction ends.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorJunction = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Kerb-return radius by class, from the NARROWER arm's total width: a turning vehicle is
    // limited by the smaller street. Residential ≤ 12 m → 6 m, collector ≤ 30 m → 9 m, else 12 m.
    const KERB_RETURN_RADIUS = [[12, 6], [30, 9], [Infinity, 12]];
    // A pair of arms closer than this is a sliver, not a corner; wider than MAX is a continuation.
    const MIN_CORNER_ANGLE = 20 * Math.PI / 180;
    const MAX_CORNER_ANGLE = 170 * Math.PI / 180;
    const MIN_FILLET_RADIUS = 0.5;
    const ARC_STEP_RAD = Math.PI / 24; // 7.5° per arc vertex
    // Approach furniture, measured outward from the arm's cut (the farthest corner reach).
    const CROSSING_SETBACK = 0.5;
    const CROSSING_DEPTH = 3;
    const CROSSING_STRIPE = 0.8;
    const CROSSING_GAP = 0.8;
    const STOP_LINE_GAP = 0.5;
    const STOP_LINE_THICKNESS = 0.35;
    const NODE_KEY_M = 0.01;
    // An arm's box starts this far BEHIND the node, so the boxes of two arms that continue
    // through it overlap instead of merely touching along the node line: united they are one
    // surface with no seam, and a strip clipped to them keeps no sub-pixel sliver between them.
    const BOX_OVERLAP = 0.05;
    // A fillet's corner piece reaches this far into the boxes along its two straight edges, and a
    // footway corner band this far past the kerb arc into that piece, for the same reason: pieces
    // that overlap unite into one surface, pieces that only touch leave a hairline between them.
    const PIECE_OVERLAP = 0.02;

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const hypot = (x, y) => Math.hypot(x, y);
    const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k];
    const leftNormal = d => [-d[1], d[0]];
    const normalize = v => {
        const length = hypot(v[0], v[1]);
        return length < 1e-12 ? null : [v[0] / length, v[1] / length];
    };
    const angleOf = v => Math.atan2(v[1], v[0]);
    const TWO_PI = Math.PI * 2;
    const ccwAngle = (from, to) => { // angle turned counter-clockwise from direction `from` to `to`, in (0, 2π]
        let a = angleOf(to) - angleOf(from);
        while (a <= 0) a += TWO_PI;
        while (a > TWO_PI) a -= TWO_PI;
        return a;
    };

    function kerbReturnRadius(widthA, widthB) {
        const narrower = Math.min(finite(widthA) ? widthA : Infinity, finite(widthB) ? widthB : Infinity);
        const row = KERB_RETURN_RADIUS.find(([limit]) => narrower <= limit) || KERB_RETURN_RADIUS[KERB_RETURN_RADIUS.length - 1];
        return row[1];
    }

    // Parameters (t, u) with P + D·t = Q + E·u, or null when the lines are parallel.
    function intersectLines(P, D, Q, E) {
        const det = D[0] * (-E[1]) - D[1] * (-E[0]);
        if (Math.abs(det) < 1e-12) return null;
        const rx = Q[0] - P[0];
        const ry = Q[1] - P[1];
        const t = (rx * (-E[1]) - ry * (-E[0])) / det;
        const u = (D[0] * ry - D[1] * rx) / det;
        return { t, u, point: add(P, D, t) };
    }

    // Points on an arc around C from angle a0 to a1 going the short way, radius interpolated from
    // r0 to r1 (constant when equal); endpoints included.
    function arcPoints(C, r0, r1, a0, a1) {
        let delta = a1 - a0;
        while (delta > Math.PI) delta -= TWO_PI;
        while (delta < -Math.PI) delta += TWO_PI;
        const steps = Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP_RAD));
        const points = [];
        for (let k = 0; k <= steps; k += 1) {
            const s = k / steps;
            const angle = a0 + delta * s;
            const radius = Math.max(0, r0 + (r1 - r0) * s);
            points.push([C[0] + Math.cos(angle) * radius, C[1] + Math.sin(angle) * radius]);
        }
        return points;
    }

    function ringArea(ring) {
        let area = 0;
        for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            area += a[0] * b[1] - b[0] * a[1];
        }
        return area / 2;
    }

    function segmentsCross(a1, a2, b1, b2) {
        const d = (a2[0] - a1[0]) * (b2[1] - b1[1]) - (a2[1] - a1[1]) * (b2[0] - b1[0]);
        if (Math.abs(d) < 1e-12) return false;
        const t = ((b1[0] - a1[0]) * (b2[1] - b1[1]) - (b1[1] - a1[1]) * (b2[0] - b1[0])) / d;
        const u = ((b1[0] - a1[0]) * (a2[1] - a1[1]) - (b1[1] - a1[1]) * (a2[0] - a1[0])) / d;
        return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
    }

    function ringSelfIntersects(ring) {
        const n = ring.length;
        for (let i = 0; i < n; i += 1) {
            for (let j = i + 2; j < n; j += 1) {
                if (i === 0 && j === n - 1) continue;
                if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
            }
        }
        return false;
    }

    // Sutherland–Hodgman against one line: keep the part of `ring` on the left (keepLeft) or right
    // side of the directed line P + D·t. Returns null when nothing is left.
    function clipRingBeyondLine(ring, P, D, keepLeft) {
        const side = point => {
            const s = D[0] * (point[1] - P[1]) - D[1] * (point[0] - P[0]);
            return keepLeft ? s : -s;
        };
        const out = [];
        for (let index = 0; index < ring.length; index += 1) {
            const current = ring[index];
            const next = ring[(index + 1) % ring.length];
            const sc = side(current);
            const sn = side(next);
            if (sc >= -1e-9) out.push(current);
            if ((sc > 1e-9 && sn < -1e-9) || (sc < -1e-9 && sn > 1e-9)) {
                const k = sc / (sc - sn);
                out.push([current[0] + (next[0] - current[0]) * k, current[1] + (next[1] - current[1]) * k]);
            }
        }
        return cleanRing(out);
    }

    // Drop consecutive duplicates and collinear vertices (including a spike that doubles back on
    // itself, which a clip against a line that a vertex already lies on can leave behind), so a
    // degenerate fillet cannot leave a zero-length or zero-area edge for turf or earcut to choke on.
    function cleanRing(ring) {
        let out = [];
        ring.forEach(point => {
            const last = out[out.length - 1];
            if (!last || hypot(point[0] - last[0], point[1] - last[1]) > 1e-6) out.push([point[0], point[1]]);
        });
        if (out.length > 1 && hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-6) out.pop();
        let changed = true;
        while (changed && out.length >= 3) {
            changed = false;
            for (let index = 0; index < out.length; index += 1) {
                const a = out[(index + out.length - 1) % out.length];
                const b = out[index];
                const c = out[(index + 1) % out.length];
                const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
                const scale = hypot(b[0] - a[0], b[1] - a[1]) * hypot(c[0] - b[0], c[1] - b[1]);
                if (scale < 1e-12 || Math.abs(cross) <= 1e-7 * Math.max(1, scale)) {
                    out.splice(index, 1);
                    changed = true;
                    break;
                }
            }
        }
        return out.length >= 3 ? out : null;
    }

    // ---- arms --------------------------------------------------------------------------------

    // An arm as the junction sees it: `dir` is the unit direction AWAY from the node; `edges` are
    // the arm's own numbers measured on ITS left/right looking outward (eL/eR: centre line to the
    // kerb; oL/oR: kerb to the land edge, 0 without a footway); `inbound` is the lateral span of the
    // lanes that run INTO the node ([lo, hi] in the same left-positive frame) or null; `length` is
    // how far the arm runs before its stretch ends or meets another junction.
    function orientArm(arm) {
        const dir = normalize(arm && arm.dir);
        if (!dir) return null;
        const e = (arm.edges && typeof arm.edges === 'object') ? arm.edges : {};
        const reversed = arm.reversed === true;
        // Profile numbers are in the STRETCH frame (left of the direction of travel). An arm that
        // leaves the node against the stretch direction sees them mirrored.
        const carriagewayLeft = finite(e.carriagewayLeft) ? e.carriagewayLeft : (finite(e.total) ? e.total / 2 : 0);
        const carriagewayRight = finite(e.carriagewayRight) ? e.carriagewayRight : (finite(e.total) ? -e.total / 2 : 0);
        const outerLeft = finite(e.outerLeft) ? Math.max(0, e.outerLeft) : 0;
        const outerRight = finite(e.outerRight) ? Math.max(0, e.outerRight) : 0;
        const eL = reversed ? -carriagewayRight : carriagewayLeft;
        const eR = reversed ? carriagewayLeft : -carriagewayRight;
        const oL = reversed ? outerRight : outerLeft;
        const oR = reversed ? outerLeft : outerRight;
        const total = finite(e.total) ? e.total : (eL + eR + oL + oR);
        let inbound = null;
        if (Array.isArray(arm.inbound) && arm.inbound.length === 2 && arm.inbound.every(finite)) {
            const [lo, hi] = arm.inbound;
            inbound = reversed ? [-hi, -lo] : [lo, hi];
            if (inbound[1] - inbound[0] < 0.2) inbound = null;
        }
        return {
            source: arm,
            dir,
            normal: leftNormal(dir),
            angle: angleOf(dir),
            eL: Math.max(0, eL),
            eR: Math.max(0, eR),
            oL,
            oR,
            total: Math.max(total, 0.1),
            inbound,
            hasSidewalk: arm.hasSidewalk === true,
            length: finite(arm.length) ? Math.max(0, arm.length) : Infinity,
            outerStripLeft: reversed ? (arm.outerStrips && arm.outerStrips.right) || null : (arm.outerStrips && arm.outerStrips.left) || null,
            outerStripRight: reversed ? (arm.outerStrips && arm.outerStrips.left) || null : (arm.outerStrips && arm.outerStrips.right) || null,
            cutLeft: 0,
            cutRight: 0,
            cut: 0
        };
    }

    // The point at station `t` along the arm, `l` metres to its left.
    function armPoint(node, arm, t, l) {
        return [node[0] + arm.dir[0] * t + arm.normal[0] * l, node[1] + arm.dir[1] * t + arm.normal[1] * l];
    }

    // ---- corners -----------------------------------------------------------------------------

    // The corner between arm `i` and its counter-clockwise neighbour `j` (the wedge lies on i's
    // left and j's right). `theta` is the angle of that wedge. Returns null when the two kerb lines
    // meet beyond either arm's end (a stub shorter than the other road's half-width).
    function buildCorner(node, i, j, theta) {
        const kerbI = { P: armPoint(node, i, 0, i.eL), D: i.dir };
        const kerbJ = { P: armPoint(node, j, 0, -j.eR), D: j.dir };
        const K = intersectLines(kerbI.P, kerbI.D, kerbJ.P, kerbJ.D);
        if (!K) return null;
        const tK = K.t;
        const uK = K.u;
        if (tK > i.length || uK > j.length) return null;
        let radius = kerbReturnRadius(i.total, j.total);
        const halfTheta = theta / 2;
        // Shrink the fillet so its tangent points stay on the arms; below MIN_FILLET_RADIUS the
        // corner is sharp (a plain kerb corner at K).
        const tangentLimit = Math.min(i.length - tK, j.length - uK) * 0.9;
        radius = Math.min(radius, Math.max(0, tangentLimit * Math.tan(halfTheta)));
        if (!(radius >= MIN_FILLET_RADIUS)) {
            return { i, j, K: K.point, tK, uK, radius: 0, tangent: 0, surface: null, sidewalk: null, land: null };
        }
        const tangent = radius / Math.tan(halfTheta);
        const bisector = normalize([i.dir[0] + j.dir[0], i.dir[1] + j.dir[1]]);
        if (!bisector) return null;
        const C = add(K.point, bisector, radius / Math.sin(halfTheta));
        const Ti = add(K.point, i.dir, tangent);
        const Tj = add(K.point, j.dir, tangent);
        const aI = angleOf([Ti[0] - C[0], Ti[1] - C[1]]);
        const aJ = angleOf([Tj[0] - C[0], Tj[1] - C[1]]);
        const kerbArc = arcPoints(C, radius, radius, aI, aJ);
        // The carriageway gained at the corner: between the sharp corner K and the fillet. Its two
        // straight edges run on the arms' carriageway edges, so they are pushed PIECE_OVERLAP into
        // the carriageway to overlap the arm boxes rather than touch them.
        const intoI = [-i.normal[0] * PIECE_OVERLAP, -i.normal[1] * PIECE_OVERLAP];
        const intoJ = [j.normal[0] * PIECE_OVERLAP, j.normal[1] * PIECE_OVERLAP];
        const surface = cleanRing([
            [K.point[0] + intoI[0] + intoJ[0], K.point[1] + intoI[1] + intoJ[1]],
            add(Ti, intoI), ...kerbArc, add(Tj, intoJ)
        ]);

        // The footway wraps the kerb at each arm's own outer-band width. Where the band is narrower
        // than the fillet radius the back of the footway is an arc too (and the land has to follow,
        // see `land`); where it is wider the straight land edges meet at O and the band just fills
        // the square corner.
        const TiOuter = add(Ti, i.normal, i.oL);
        const TjOuter = add(Tj, j.normal, -j.oR);
        const landI = { P: armPoint(node, i, 0, i.eL + i.oL), D: i.dir };
        const landJ = { P: armPoint(node, j, 0, -(j.eR + j.oR)), D: j.dir };
        const O = intersectLines(landI.P, landI.D, landJ.P, landJ.D);
        const rhoI = radius - i.oL;
        const rhoJ = radius - j.oR;
        let outer;
        let land = null;
        if (rhoI > 0.05 || rhoJ > 0.05) {
            outer = arcPoints(C, Math.max(rhoI, 0), Math.max(rhoJ, 0), aI, aJ);
            // The land the corner needs is whatever lies behind the footway and beyond BOTH straight
            // land edges. With unequal footways the back of the footway dips inside the wider arm's
            // own band before it comes out past the narrower one, so the band is clipped to the
            // quadrant beyond the two land edges rather than taken whole.
            if (O) {
                let landRing = cleanRing([O.point, TiOuter, ...outer, TjOuter]);
                if (landRing) landRing = clipRingBeyondLine(landRing, landI.P, landI.D, true);
                if (landRing) landRing = clipRingBeyondLine(landRing, landJ.P, landJ.D, false);
                if (landRing && Math.abs(ringArea(landRing)) > 0.05 && !ringSelfIntersects(landRing)) land = landRing;
            }
        } else {
            outer = O ? [TiOuter, O.point, TjOuter] : [TiOuter, TjOuter];
        }
        // The band's kerb edge reaches PIECE_OVERLAP past the kerb arc (away from C, the corner
        // piece's side), so it overlaps the corner piece rather than touching it along the arc.
        const sidewalk = (i.oL > 0.05 || j.oR > 0.05)
            ? cleanRing([...arcPoints(C, radius + PIECE_OVERLAP, radius + PIECE_OVERLAP, aI, aJ), ...outer.slice().reverse()])
            : null;
        return { i, j, K: K.point, tK, uK, radius, tangent, C, Ti, Tj, surface, sidewalk, land };
    }

    // ---- the junction ------------------------------------------------------------------------

    // The reach of every OTHER arm's carriageway onto this arm, so an approach with no corner of
    // its own (a sliver neighbour, a straight continuation) still gets a box that covers the
    // overlap. Another arm's box crosses this arm's axis as far as its half-width times the sine
    // of the angle between them: a collinear arm reaches nothing, a perpendicular one its half-width.
    function baseReach(arms, index) {
        const self = arms[index];
        let reach = 0;
        arms.forEach((other, otherIndex) => {
            if (otherIndex === index) return;
            const sin = Math.abs(self.dir[0] * other.dir[1] - self.dir[1] * other.dir[0]);
            reach = Math.max(reach, Math.max(other.eL, other.eR) * sin);
        });
        return reach + 1;
    }

    function approachFurniture(node, arm, degree) {
        const result = { stopLine: null, crossing: [], markingTrim: arm.cut + STOP_LINE_GAP };
        if (degree < 3) { result.markingTrim = arm.cut; return result; }
        const width = arm.eL + arm.eR;
        let station = arm.cut;
        const crossingEnd = station + CROSSING_SETBACK + CROSSING_DEPTH;
        if (arm.hasSidewalk && width >= 2 && arm.length >= crossingEnd + 1) {
            for (let across = -arm.eR + 0.25; across + CROSSING_STRIPE <= arm.eL - 0.25; across += CROSSING_STRIPE + CROSSING_GAP) {
                result.crossing.push([
                    armPoint(node, arm, station + CROSSING_SETBACK, across),
                    armPoint(node, arm, crossingEnd, across),
                    armPoint(node, arm, crossingEnd, across + CROSSING_STRIPE),
                    armPoint(node, arm, station + CROSSING_SETBACK, across + CROSSING_STRIPE)
                ]);
            }
            station = crossingEnd;
        }
        if (arm.inbound && arm.length >= station + STOP_LINE_GAP + STOP_LINE_THICKNESS + 0.5) {
            const from = station + STOP_LINE_GAP;
            const to = from + STOP_LINE_THICKNESS;
            result.stopLine = [
                armPoint(node, arm, from, arm.inbound[0]),
                armPoint(node, arm, to, arm.inbound[0]),
                armPoint(node, arm, to, arm.inbound[1]),
                armPoint(node, arm, from, arm.inbound[1])
            ];
            result.markingTrim = Math.min(arm.length, to + STOP_LINE_GAP);
        } else {
            result.markingTrim = Math.min(arm.length, station + STOP_LINE_GAP);
        }
        return result;
    }

    // A two-arm node between different corridors is a BEND: the ribbons are offset independently,
    // so the outside leaves a notch and the inside overlaps. The surface is the notch triangle on
    // the outside plus the two boxes to the mitre reach; the footway notch gets its own band.
    function buildBend(node, arms) {
        const [a, b] = arms;
        const theta = ccwAngle(a.dir, b.dir); // wedge on a's left / b's right
        const turn = Math.abs(Math.PI - theta);
        const tanHalf = Math.tan(Math.min(turn, Math.PI * 0.49) / 2);
        a.cut = Math.max(b.eL, b.eR) * tanHalf + 0.3;
        b.cut = Math.max(a.eL, a.eR) * tanHalf + 0.3;
        const insideIsLeftOfA = theta < Math.PI; // the wedge (< 180°) is the inside of the bend
        const surface = [];
        const corners = [];
        // Outside notch: between a's outer kerb end, the node and b's outer kerb end.
        const A = insideIsLeftOfA ? armPoint(node, a, 0, -a.eR) : armPoint(node, a, 0, a.eL);
        const B = insideIsLeftOfA ? armPoint(node, b, 0, b.eL) : armPoint(node, b, 0, -b.eR);
        const notch = cleanRing([node, A, B]);
        if (notch && Math.abs(ringArea(notch)) > 0.01) surface.push(notch);
        const oA = insideIsLeftOfA ? a.oR : a.oL;
        const oB = insideIsLeftOfA ? b.oL : b.oR;
        if (oA > 0.05 || oB > 0.05) {
            const Aouter = insideIsLeftOfA ? armPoint(node, a, 0, -(a.eR + a.oR)) : armPoint(node, a, 0, a.eL + a.oL);
            const Bouter = insideIsLeftOfA ? armPoint(node, b, 0, b.eL + b.oL) : armPoint(node, b, 0, -(b.eR + b.oR));
            const band = cleanRing([A, Aouter, Bouter, B]);
            if (band && Math.abs(ringArea(band)) > 0.01) {
                corners.push({ ring: band, strip: insideIsLeftOfA ? (a.outerStripRight || b.outerStripLeft) : (a.outerStripLeft || b.outerStripRight) });
            }
        }
        return { surface, corners };
    }

    /**
     * Build one junction.
     * @param {number[]} node planar [x, y]
     * @param {object[]} armsIn see orientArm; arms pointing the same way are expected to be merged by the caller
     * @param {object} [options] { crossings: boolean }
     * @returns {object|null} { node, degree, arms: [{ dir, cut, cutLeft, cutRight, markingTrim, source }],
     *   surface: [ring], corners: [{ ring, strip }], land: [ring], stopLines: [ring], crossings: [ring],
     *   fillets: [{ K, C, radius }] }
     */
    function buildJunction(node, armsIn, options = {}) {
        if (!Array.isArray(node) || !node.every(finite)) return null;
        const arms = (Array.isArray(armsIn) ? armsIn : []).map(orientArm).filter(Boolean);
        if (arms.length < 2) return null;
        arms.sort((p, q) => p.angle - q.angle);
        const degree = arms.length;
        const surface = [];
        const corners = [];
        const land = [];
        const fillets = [];

        if (degree === 2) {
            const bend = buildBend(node, arms);
            surface.push(...bend.surface);
            corners.push(...bend.corners);
        } else {
            for (let index = 0; index < degree; index += 1) {
                const i = arms[index];
                const j = arms[(index + 1) % degree];
                const theta = ccwAngle(i.dir, j.dir);
                if (theta > MAX_CORNER_ANGLE) {
                    // A continuation that is not dead straight leaves a wedge between the two
                    // boxes' node-line ends on the outside of its slight bend, like a bend's
                    // notch (buildBend): the surface covers it, so the box has no seam there.
                    const notch = cleanRing([node, armPoint(node, i, 0, i.eL), armPoint(node, j, 0, -j.eR)]);
                    if (notch && Math.abs(ringArea(notch)) > 0.01) surface.push(notch);
                    continue;
                }
                if (theta < MIN_CORNER_ANGLE) continue;
                const corner = buildCorner(node, i, j, theta);
                if (!corner) continue;
                i.cutLeft = Math.max(i.cutLeft, corner.tK + corner.tangent);
                j.cutRight = Math.max(j.cutRight, corner.uK + corner.tangent);
                if (corner.surface) surface.push(corner.surface);
                if (corner.sidewalk) corners.push({ ring: corner.sidewalk, strip: i.outerStripLeft || j.outerStripRight || null });
                if (corner.land) land.push(corner.land);
                if (corner.radius > 0) fillets.push({ K: corner.K, C: corner.C, radius: corner.radius, Ti: corner.Ti, Tj: corner.Tj });
            }
            arms.forEach((arm, index) => {
                arm.cut = Math.min(arm.length, Math.max(arm.cutLeft, arm.cutRight, baseReach(arms, index)));
            });
        }

        const stopLines = [];
        const crossings = [];
        const withCrossings = options.crossings !== false;
        arms.forEach(arm => {
            if (arm.cut > 0.01) {
                const box = cleanRing([
                    armPoint(node, arm, -BOX_OVERLAP, arm.eL), armPoint(node, arm, arm.cut, arm.eL),
                    armPoint(node, arm, arm.cut, -arm.eR), armPoint(node, arm, -BOX_OVERLAP, -arm.eR)
                ]);
                if (box) surface.push(box);
            }
            const furniture = approachFurniture(node, arm, degree);
            arm.markingTrim = furniture.markingTrim;
            if (withCrossings) {
                if (furniture.stopLine) stopLines.push(furniture.stopLine);
                crossings.push(...furniture.crossing);
            }
        });

        return {
            node: [node[0], node[1]],
            degree,
            arms: arms.map(arm => ({
                dir: arm.dir,
                cut: arm.cut,
                cutLeft: arm.cutLeft,
                cutRight: arm.cutRight,
                markingTrim: arm.markingTrim,
                length: arm.length,
                source: arm.source
            })),
            surface,
            corners,
            land,
            stopLines,
            crossings,
            fillets
        };
    }

    // ---- collecting arms from polylines --------------------------------------------------------

    function nodeKey(point) {
        // A point's level is topology, never a z value in the planar junction geometry. Missing
        // levels mean ground level, as in corridor-authoring.sameNode.
        const level = finite(point && point[2]) ? point[2] : 0;
        return `${Math.round(point[0] / NODE_KEY_M)},${Math.round(point[1] / NODE_KEY_M)}@${level}`;
    }

    // Every node where polylines meet, with one arm per distinct direction. `entries` are
    // [{ points: [[x,y]…], …anything }]; each arm carries `entryIndex`, `vertexIndex`, `step` (+1
    // towards the polyline's end, −1 towards its start), `reversed` (true when the arm runs against
    // the polyline direction) and the entry itself as `entry`. When two polylines leave a node in the
    // same direction the wider one (by `entry.width`, when given) keeps the arm; equal widths use
    // an optional opaque caller priority to break ties independently of entry order. Arm `length`
    // is the polyline distance from the node to the next node of degree ≥ 3 or to the polyline's end.
    function collectNodes(entries, options = {}) {
        const minDegree = finite(options.minDegree) ? options.minDegree : 2;
        const nodes = new Map();
        const addArm = (point, other, entryIndex, vertexIndex, step) => {
            const dir = normalize([other[0] - point[0], other[1] - point[1]]);
            if (!dir) return;
            const key = nodeKey(point);
            if (!nodes.has(key)) nodes.set(key, { point: [point[0], point[1], finite(point[2]) ? point[2] : 0], arms: [] });
            const node = nodes.get(key);
            const entry = entries[entryIndex];
            const width = finite(entry && entry.width) ? entry.width : 0;
            const suppliedPriority = entry && entry.junctionPriority;
            const junctionPriority = (suppliedPriority && typeof suppliedPriority === 'object')
                ? suppliedPriority[step < 0 ? 'reverse' : 'forward']
                : suppliedPriority;
            const existing = node.arms.find(arm => arm.dir[0] * dir[0] + arm.dir[1] * dir[1] > 0.9999);
            const arm = { dir, entryIndex, vertexIndex, step, reversed: step < 0, entry, width, junctionPriority };
            if (existing) {
                existing.duplicates = (existing.duplicates || []).concat([arm]);
                const equalWidthTieWins = width === existing.width
                    && typeof junctionPriority === 'string'
                    && typeof existing.junctionPriority === 'string'
                    && junctionPriority < existing.junctionPriority;
                if (width > existing.width || equalWidthTieWins) Object.assign(existing, arm, { duplicates: existing.duplicates });
                return;
            }
            node.arms.push(arm);
        };
        (entries || []).forEach((entry, entryIndex) => {
            const points = entry && entry.points;
            if (!Array.isArray(points) || points.length < 2) return;
            points.forEach((point, vertexIndex) => {
                if (!Array.isArray(point) || !point.every(finite)) return;
                if (vertexIndex > 0) addArm(point, points[vertexIndex - 1], entryIndex, vertexIndex, -1);
                if (vertexIndex < points.length - 1) addArm(point, points[vertexIndex + 1], entryIndex, vertexIndex, +1);
            });
        });
        const junctionKeys = new Set([...nodes.entries()].filter(([, node]) => node.arms.length >= 3).map(([key]) => key));
        nodes.forEach(node => {
            node.arms.forEach(arm => {
                const points = entries[arm.entryIndex].points;
                let length = 0;
                let index = arm.vertexIndex;
                while (true) {
                    const next = index + arm.step;
                    if (next < 0 || next >= points.length) break;
                    length += hypot(points[next][0] - points[index][0], points[next][1] - points[index][1]);
                    index = next;
                    if (junctionKeys.has(nodeKey(points[index]))) break;
                }
                arm.length = length;
            });
        });
        return [...nodes.values()].filter(node => node.arms.length >= minDegree);
    }

    return Object.freeze({
        KERB_RETURN_RADIUS,
        MIN_CORNER_ANGLE,
        MAX_CORNER_ANGLE,
        CROSSING_SETBACK,
        CROSSING_DEPTH,
        STOP_LINE_GAP,
        kerbReturnRadius,
        intersectLines,
        arcPoints,
        ringArea,
        ringSelfIntersects,
        buildJunction,
        collectNodes,
        nodeKey
    });
});
