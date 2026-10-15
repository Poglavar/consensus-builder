// Transition zones between cross-sections (road-editor.md decision 3): where two stretches of one
// road meet with different profiles, the wider one tapers to the narrower over a zone of
// clamp(10, 60, 8 × Δwidth) metres, and at a junction the narrower continuation widens back to the
// arm it continues before the box. This module decides WHERE the zones are and HOW the strips of
// one profile map onto the other; corridor-profile.js turns that into strips, markings and land.
// Pure planar geometry in metres ([x, y]); profiles are the normalized lane lists.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorTransition = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const MIN_LENGTH_M = 10;
    const MAX_LENGTH_M = 60;
    const METRES_PER_METRE_OF_WIDTH = 8;
    const SAME_WIDTH_LENGTH_M = 20;   // lanes change but the width does not: a short morph
    const MIN_ZONE_M = 3;             // a stretch shorter than this gets no taper
    const MAX_SHARE_OF_STRETCH = 0.45; // a zone never takes more than this of its stretch (two ends fit)
    const NODE_KEY_M = 0.01;
    const CONTINUATION_DOT = -0.7;    // arms at least ~135° apart continue each other
    const SAMPLE_STEP_M = 2;

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const hypot = (x, y) => Math.hypot(x, y);

    function transitionLength(widthA, widthB) {
        const delta = Math.abs((finite(widthA) ? widthA : 0) - (finite(widthB) ? widthB : 0));
        if (delta < 0.05) return SAME_WIDTH_LENGTH_M;
        return Math.max(MIN_LENGTH_M, Math.min(MAX_LENGTH_M, METRES_PER_METRE_OF_WIDTH * delta));
    }

    function nodeKey(point) {
        return `${Math.round(point[0] / NODE_KEY_M)},${Math.round(point[1] / NODE_KEY_M)}`;
    }

    function polylineLength(points) {
        let length = 0;
        for (let i = 1; i < points.length; i += 1) length += hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        return length;
    }

    function profileKey(profile) {
        return JSON.stringify((profile && profile.strips) || []);
    }

    // ---- planning ----------------------------------------------------------------------------

    // Which stretches get a zone, at which end, from which profile. `entries` are one corridor's
    // stretches: [{ points: [[x,y]…], profile, width, segmentId? }]; `options.junctions` are the
    // nodes where OTHER records meet this one, with their arms: [{ point: [x,y], arms: [{ dir:
    // [ux,uy] (away from the node), profile, width }] }]. Returns [{ entryIndex, end: 'start' |
    // 'end', length, from (the profile at the node), to (the stretch's own), kind }].
    //
    // One rule everywhere: a stretch end whose most nearly opposite neighbour — its own road's other
    // stretch, or a foreign arm — is WIDER carries that neighbour's profile at the node and tapers
    // down to its own over the zone. So the wide road runs full width through a junction and the
    // narrowing happens after it; at a plain change of width the narrower side widens back; and a
    // narrow record continuing a wide one widens back too, from the land it owns, because the
    // neighbour's arm is written into its definition when they are joined. The wider side never
    // changes: its land cannot depend on a neighbour it does not know.
    function planTransitions(entries, options = {}) {
        const ends = new Map();
        const note = (point, arm) => {
            const key = nodeKey(point);
            if (!ends.has(key)) ends.set(key, []);
            ends.get(key).push(arm);
        };
        const valid = (entries || []).map(entry => entry && Array.isArray(entry.points) && entry.points.length >= 2 && entry.profile);
        const directionOut = (points, end) => {
            const a = end === 'start' ? points[0] : points[points.length - 1];
            const b = end === 'start' ? points[1] : points[points.length - 2];
            const length = hypot(b[0] - a[0], b[1] - a[1]);
            return length > 1e-9 ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length] : null;
        };
        (entries || []).forEach((entry, entryIndex) => {
            if (!valid[entryIndex]) return;
            ['start', 'end'].forEach(end => {
                const dir = directionOut(entry.points, end);
                if (!dir) return;
                note(end === 'start' ? entry.points[0] : entry.points[entry.points.length - 1], {
                    own: true, entryIndex, end, dir, profile: entry.profile, width: finite(entry.width) ? entry.width : 0, length: polylineLength(entry.points)
                });
            });
        });
        (Array.isArray(options.junctions) ? options.junctions : []).forEach(junction => {
            if (!junction || !Array.isArray(junction.point)) return;
            (junction.arms || []).forEach(arm => {
                if (!arm || !Array.isArray(arm.dir) || !arm.profile) return;
                const length = hypot(arm.dir[0], arm.dir[1]);
                if (length < 1e-9) return;
                note(junction.point, { own: false, dir: [arm.dir[0] / length, arm.dir[1] / length], profile: arm.profile, width: finite(arm.width) ? arm.width : 0 });
            });
        });
        const plans = [];
        ends.forEach(list => {
            if (list.length < 2) return;
            list.forEach(arm => {
                if (!arm.own) return;
                let best = null;
                list.forEach(other => {
                    if (other === arm) return;
                    if (other.own && other.entryIndex === arm.entryIndex) return; // a loop closing on itself
                    const dot = arm.dir[0] * other.dir[0] + arm.dir[1] * other.dir[1];
                    if (dot > CONTINUATION_DOT) return;
                    if (!best || dot < best.dot) best = { other, dot };
                });
                if (!best) return;
                const opposite = best.other;
                if (opposite.width <= arm.width + 0.05) return;
                if (profileKey(opposite.profile) === profileKey(arm.profile)) return;
                const length = Math.min(transitionLength(opposite.width, arm.width), arm.length * MAX_SHARE_OF_STRETCH);
                if (length < MIN_ZONE_M) return;
                plans.push({ entryIndex: arm.entryIndex, end: arm.end, length, from: opposite.profile, to: arm.profile, kind: list.length >= 3 ? 'junction' : 'bend' });
            });
        });
        return plans;
    }

    // ---- splitting ---------------------------------------------------------------------------

    // Split a polyline at arc length `arc` from its start: [head, tail], both sharing the split
    // point. Either may be null when the split falls on an end.
    function splitPolylineAtArc(points, arc) {
        const total = polylineLength(points);
        if (!(arc > 1e-6) || arc >= total - 1e-6) return arc <= 1e-6 ? [null, points.slice()] : [points.slice(), null];
        let run = 0;
        for (let i = 1; i < points.length; i += 1) {
            const a = points[i - 1];
            const b = points[i];
            const length = hypot(b[0] - a[0], b[1] - a[1]);
            if (run + length >= arc) {
                const k = length > 1e-9 ? (arc - run) / length : 0;
                const cut = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
                const head = points.slice(0, i).concat([cut]);
                const tail = [cut].concat(points.slice(i));
                if (k < 1e-9) head.pop();
                if (k > 1 - 1e-9) tail.shift();
                return [head.length >= 2 ? head : null, tail.length >= 2 ? tail : null];
            }
            run += length;
        }
        return [points.slice(), null];
    }

    // The pieces of one stretch after its planned zones are cut off: [{ points, taper }] in
    // polyline order; `taper` is null for the body and { profileStart, profileEnd, length } for a
    // zone, each profile being the one at that end of the piece's own point order.
    function piecesOf(points, plans) {
        const atStart = plans.find(plan => plan.end === 'start') || null;
        const atEnd = plans.find(plan => plan.end === 'end') || null;
        let body = points.slice();
        const pieces = [];
        if (atStart) {
            const [zone, rest] = splitPolylineAtArc(body, atStart.length);
            if (zone) pieces.push({ points: zone, taper: { profileStart: atStart.from, profileEnd: atStart.to, length: atStart.length, kind: atStart.kind } });
            body = rest;
        }
        if (atEnd && body) {
            const [rest, zone] = splitPolylineAtArc(body, polylineLength(body) - atEnd.length);
            if (rest) pieces.push({ points: rest, taper: null });
            if (zone) pieces.push({ points: zone, taper: { profileStart: atEnd.to, profileEnd: atEnd.from, length: atEnd.length, kind: atEnd.kind } });
        } else if (body) {
            pieces.push({ points: body, taper: null });
        }
        return pieces;
    }

    // ---- strip mapping -----------------------------------------------------------------------

    function stripKey(strip) {
        return `${strip.type}|${strip.direction || ''}`;
    }

    // Longest common subsequence of strip keys, in order: pairs of [wideIndex, narrowIndex].
    function matchStripIndexes(wideStrips, narrowStrips) {
        const n = wideStrips.length;
        const m = narrowStrips.length;
        const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
        for (let i = n - 1; i >= 0; i -= 1) {
            for (let j = m - 1; j >= 0; j -= 1) {
                table[i][j] = stripKey(wideStrips[i]) === stripKey(narrowStrips[j])
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
            }
        }
        const pairs = [];
        let i = 0; let j = 0;
        while (i < n && j < m) {
            if (stripKey(wideStrips[i]) === stripKey(narrowStrips[j])) { pairs.push([i, j]); i += 1; j += 1; }
            else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
            else j += 1;
        }
        return pairs;
    }

    // For every strip of the WIDE profile, its span at the narrow end: a matched strip takes its
    // counterpart's span; an unmatched one collapses to a point on the seam where its matched
    // neighbours meet in the narrow profile (a median vanishes into the centre line, a parking
    // lane into the kerb). `wideSpans`/`narrowSpans` are corridorStripSpans output (left/right).
    function mapSpans(wideSpans, narrowSpans) {
        const pairs = matchStripIndexes(wideSpans, narrowSpans);
        const narrowOf = new Map(pairs);
        const narrowLeftEdge = narrowSpans.length ? narrowSpans[0].left : 0;
        const narrowRightEdge = narrowSpans.length ? narrowSpans[narrowSpans.length - 1].right : 0;
        return wideSpans.map((span, index) => {
            if (narrowOf.has(index)) {
                const target = narrowSpans[narrowOf.get(index)];
                return { left: target.left, right: target.right, matched: true };
            }
            // The seam: the right edge of the nearest matched strip to the left, else the narrow
            // profile's left edge; equivalently the left edge of the next matched strip to the right.
            let seam = null;
            for (let k = index - 1; k >= 0 && seam === null; k -= 1) if (narrowOf.has(k)) seam = narrowSpans[narrowOf.get(k)].right;
            if (seam === null) {
                for (let k = index + 1; k < wideSpans.length && seam === null; k += 1) if (narrowOf.has(k)) seam = narrowSpans[narrowOf.get(k)].left;
            }
            if (seam === null) seam = (narrowLeftEdge + narrowRightEdge) / 2;
            return { left: seam, right: seam, matched: false };
        });
    }

    // ---- geometry ----------------------------------------------------------------------------

    // The polyline resampled at ≤ SAMPLE_STEP_M with the fraction of its length at every sample:
    // [{ point, normal (left), s }].
    function sampleWithNormals(points) {
        const clean = points.filter((point, index) => index === 0 || hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 1e-6);
        if (clean.length < 2) return [];
        const total = polylineLength(clean);
        const samples = [];
        let run = 0;
        for (let i = 0; i < clean.length - 1; i += 1) {
            const a = clean[i];
            const b = clean[i + 1];
            const length = hypot(b[0] - a[0], b[1] - a[1]);
            const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP_M));
            for (let k = 0; k < steps; k += 1) {
                const t = k / steps;
                samples.push({ point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], s: (run + length * t) / total, edge: i });
            }
            run += length;
        }
        samples.push({ point: clean[clean.length - 1].slice(), s: 1, edge: clean.length - 2 });
        // Left normals: per edge, averaged at the polyline's own vertices so the two sides stay joined.
        const edgeNormal = i => {
            const a = clean[i]; const b = clean[i + 1];
            const length = hypot(b[0] - a[0], b[1] - a[1]);
            return [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
        };
        samples.forEach((sample, index) => {
            const own = edgeNormal(sample.edge);
            const atVertex = index > 0 && samples[index - 1].edge !== sample.edge;
            if (atVertex) {
                const previous = edgeNormal(sample.edge - 1);
                const sum = [own[0] + previous[0], own[1] + previous[1]];
                const length = hypot(sum[0], sum[1]);
                sample.normal = length > 1e-9 ? [sum[0] / length, sum[1] / length] : own;
            } else {
                sample.normal = own;
            }
        });
        return samples;
    }

    // One strip's ring across a zone: left/right offsets move linearly from the start spans to the
    // end spans along the polyline (a diagonal taper). Null for a strip that is a point at both ends.
    function taperStripRing(samples, startSpan, endSpan) {
        if (!samples.length) return null;
        const lerp = (a, b, s) => a + (b - a) * s;
        const leftSide = samples.map(sample => {
            const offset = lerp(startSpan.left, endSpan.left, sample.s);
            return [sample.point[0] + sample.normal[0] * offset, sample.point[1] + sample.normal[1] * offset];
        });
        const rightSide = samples.map(sample => {
            const offset = lerp(startSpan.right, endSpan.right, sample.s);
            return [sample.point[0] + sample.normal[0] * offset, sample.point[1] + sample.normal[1] * offset];
        });
        if (Math.abs(startSpan.left - startSpan.right) < 1e-6 && Math.abs(endSpan.left - endSpan.right) < 1e-6) return null;
        return [...leftSide, ...rightSide.reverse()];
    }

    // The signed offset of a seam along the zone, for marking lines: s ↦ lerp(start, end, s).
    function taperOffsetLine(samples, startOffset, endOffset) {
        return samples.map(sample => {
            const offset = startOffset + (endOffset - startOffset) * sample.s;
            return [sample.point[0] + sample.normal[0] * offset, sample.point[1] + sample.normal[1] * offset];
        });
    }

    // Width at fraction s of a zone, for the land.
    function taperWidthAt(widthStart, widthEnd, s) {
        return widthStart + (widthEnd - widthStart) * Math.max(0, Math.min(1, s));
    }

    return Object.freeze({
        MIN_LENGTH_M,
        MAX_LENGTH_M,
        SAME_WIDTH_LENGTH_M,
        transitionLength,
        planTransitions,
        splitPolylineAtArc,
        piecesOf,
        matchStripIndexes,
        mapSpans,
        sampleWithNormals,
        taperStripRing,
        taperOffsetLine,
        taperWidthAt,
        polylineLength
    });
});
