// Splits a road network into the pieces a person would call "one segment": the run of centreline
// between two segment-breaking points. A break is either
//   * a JUNCTION — any node where a third road-end meets, so a T yields three segments (the through
//     street is cut at the stem too) rather than a through-segment plus a stub; or
//   * a CORNER — the centreline turning through ~90 degrees within a few metres, so an L yields two
//     segments even when the data calls it one street or one OSM way.
// Junctions are read from SHARED OSM NODES rather than from geometric crossings, which is what makes
// a bridge over another road correctly not a junction: those ways cross but share no node.
//
// Everything here is planar (metres, x east, y north) and pure — projection and fetching stay with
// the caller, like corridor-clearance.js — so each function is unit-testable without a map.
(function (global) {
    'use strict';

    const SEGMENTATION_DEFAULTS = {
        snapTolerance: 0.6,   // m — absorbs float noise between ways that share a junction node
        cornerAngleDeg: 80,   // turning at least this much inside cornerWindow reads as a corner
        // m — the window that separates a corner from a curve by how TIGHTLY it turns. A junction
        // corner turns its 90 degrees within ~15 m of centreline (>5 deg/m); a road curving round a
        // block spreads the same 90 over 50-150 m (<2 deg/m) and must stay one segment. 25 m sits in
        // the gap: it captures a whole chamfered corner, and collects only ~45 deg of a 30 m-radius curve.
        cornerWindow: 25,
        minPieceLength: 8     // m — never cut a stub shorter than this off either end
    };

    const SEG_EPS = 1e-9;

    function isFinitePoint(p) {
        return Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
    }

    // Drop non-finite and repeated-in-place vertices; a line needs two distinct points to have a
    // direction at all.
    function cleanPlanarLine(line, tolerance = 0) {
        if (!Array.isArray(line)) return null;
        const out = [];
        line.forEach(raw => {
            if (!isFinitePoint(raw)) return;
            const p = [Number(raw[0]), Number(raw[1])];
            const previous = out[out.length - 1];
            if (previous && Math.hypot(p[0] - previous[0], p[1] - previous[1]) <= tolerance) return;
            out.push(p);
        });
        return out.length >= 2 ? out : null;
    }

    function polylineLength(points) {
        if (!Array.isArray(points) || points.length < 2) return 0;
        let total = 0;
        for (let i = 1; i < points.length; i += 1) {
            total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        }
        return total;
    }

    function arclengths(points) {
        const out = [0];
        for (let i = 1; i < points.length; i += 1) {
            out.push(out[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
        }
        return out;
    }

    // Welds coincident vertices into one node id. A grid bucket with a 3x3 neighbourhood search
    // rather than plain cell rounding, so two points a hair apart never land in different cells.
    function createNodeIndex(tolerance) {
        const cell = Math.max(Number(tolerance) || 0, 1e-6);
        const buckets = new Map();
        const points = [];
        const key = (cx, cy) => `${cx},${cy}`;

        function idFor(p) {
            const cx = Math.floor(p[0] / cell);
            const cy = Math.floor(p[1] / cell);
            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dy = -1; dy <= 1; dy += 1) {
                    const bucket = buckets.get(key(cx + dx, cy + dy));
                    if (!bucket) continue;
                    for (let i = 0; i < bucket.length; i += 1) {
                        const q = points[bucket[i]];
                        if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= cell) return bucket[i];
                    }
                }
            }
            const id = points.length;
            points.push([p[0], p[1]]);
            const k = key(cx, cy);
            if (!buckets.has(k)) buckets.set(k, []);
            buckets.get(k).push(id);
            return id;
        }

        return { idFor, points };
    }

    // The network as a node/edge graph. Every OSM vertex becomes a node; a vertex in the middle of a
    // way has degree 2, a junction has 3+, a dead end (cul-de-sac tip) has 1. An edge shared by two
    // ways is stored once, so overlapping ways do not inflate a node's degree into a false junction.
    function buildRoadGraph(lines, options = {}) {
        const tolerance = Number(options.snapTolerance) > 0
            ? Number(options.snapTolerance) : SEGMENTATION_DEFAULTS.snapTolerance;
        const index = createNodeIndex(tolerance);
        const edges = [];
        const seen = new Set();

        (lines || []).forEach(line => {
            const clean = cleanPlanarLine(line, tolerance / 2);
            if (!clean) return;
            const ids = clean.map(point => index.idFor(point));
            for (let i = 0; i < ids.length - 1; i += 1) {
                const a = ids[i];
                const b = ids[i + 1];
                if (a === b) continue;
                const edgeKey = a < b ? `${a}-${b}` : `${b}-${a}`;
                if (seen.has(edgeKey)) continue;
                seen.add(edgeKey);
                edges.push({ a, b });
            }
        });

        const adjacency = index.points.map(() => []);
        edges.forEach((edge, i) => {
            adjacency[edge.a].push(i);
            adjacency[edge.b].push(i);
        });

        return { points: index.points, edges, adjacency };
    }

    // Walk the graph into chains that run from one break node to the next, passing straight through
    // every degree-2 vertex on the way. Leftover edges belong to rings where nothing branches (a
    // roundabout, a closed loop); those are cut once, at an arbitrary node, so they still segment.
    function chainsFromGraph(graph) {
        const { edges, adjacency, points } = graph;
        const visited = new Set();
        const chains = [];
        const isBreak = node => adjacency[node].length !== 2;

        function walk(startNode, startEdge) {
            const nodes = [startNode];
            let current = startNode;
            let edgeIndex = startEdge;
            while (edgeIndex != null && !visited.has(edgeIndex)) {
                visited.add(edgeIndex);
                const edge = edges[edgeIndex];
                const next = edge.a === current ? edge.b : edge.a;
                nodes.push(next);
                current = next;
                if (isBreak(current) || current === startNode) break;
                const onward = adjacency[current].find(candidate => !visited.has(candidate));
                edgeIndex = onward === undefined ? null : onward;
            }
            return nodes;
        }

        for (let node = 0; node < points.length; node += 1) {
            if (!isBreak(node)) continue;
            adjacency[node].forEach(edgeIndex => {
                if (visited.has(edgeIndex)) return;
                chains.push(walk(node, edgeIndex));
            });
        }
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
            if (visited.has(edgeIndex)) continue;
            chains.push(walk(edges[edgeIndex].a, edgeIndex));
        }

        return chains
            .filter(nodes => nodes.length >= 2)
            .map(nodes => nodes.map(id => points[id]));
    }

    // Signed turn at each vertex, in radians: how far the direction of travel rotates there.
    // Endpoints get 0 — a chain does not turn at a point where it starts or stops.
    function turnProfile(points) {
        const turns = points.map(() => 0);
        for (let i = 1; i < points.length - 1; i += 1) {
            const inX = points[i][0] - points[i - 1][0];
            const inY = points[i][1] - points[i - 1][1];
            const outX = points[i + 1][0] - points[i][0];
            const outY = points[i + 1][1] - points[i][1];
            if (Math.hypot(inX, inY) < SEG_EPS || Math.hypot(outX, outY) < SEG_EPS) continue;
            turns[i] = Math.atan2(inX * outY - inY * outX, inX * outX + inY * outY);
        }
        return turns;
    }

    // Where the chain turns a corner. Judged on the turn accumulated within a short window rather
    // than on any single vertex: a real corner is often drawn as two or three vertices with a small
    // chamfer, which a strict per-vertex 90-degree test misses entirely, while a sweeping curve
    // turns just as far but spreads it over a much longer run and must NOT split.
    function findCornerIndices(points, options = {}) {
        if (!Array.isArray(points) || points.length < 3) return [];
        const thresholdDeg = Number(options.cornerAngleDeg) > 0
            ? Number(options.cornerAngleDeg) : SEGMENTATION_DEFAULTS.cornerAngleDeg;
        const window = Number(options.cornerWindow) > 0
            ? Number(options.cornerWindow) : SEGMENTATION_DEFAULTS.cornerWindow;
        const minPiece = Number(options.minPieceLength) >= 0
            ? Number(options.minPieceLength) : SEGMENTATION_DEFAULTS.minPieceLength;

        const threshold = thresholdDeg * Math.PI / 180;
        const turns = turnProfile(points);
        const arc = arclengths(points);
        const total = arc[arc.length - 1];
        const half = window / 2;

        // Turn accumulated within +/- half a window of each vertex. Signed, so an S-bend's two
        // opposite kinks cancel (a jog is not a corner) while a genuine corner adds up.
        const windowed = points.map((_, i) => {
            let sum = 0;
            for (let j = 1; j < points.length - 1; j += 1) {
                if (Math.abs(arc[j] - arc[i]) <= half) sum += turns[j];
            }
            return sum;
        });

        const corners = [];
        let run = [];
        const flushRun = () => {
            if (!run.length) return;
            // One split per corner: the sharpest vertex in the run, not every vertex above threshold.
            const best = run.reduce((a, b) => (Math.abs(turns[b]) > Math.abs(turns[a]) ? b : a));
            corners.push(best);
            run = [];
        };
        for (let i = 1; i < points.length - 1; i += 1) {
            if (Math.abs(windowed[i]) >= threshold) run.push(i);
            else flushRun();
        }
        flushRun();

        // Never cut a stub off either end, and never twice in the same place.
        let lastArc = 0;
        return corners.filter(i => {
            if (arc[i] - lastArc < minPiece) return false;
            if (total - arc[i] < minPiece) return false;
            lastArc = arc[i];
            return true;
        });
    }

    function splitAtCorners(points, options = {}) {
        const corners = findCornerIndices(points, options);
        if (!corners.length) return [points];
        const pieces = [];
        let start = 0;
        corners.forEach(index => {
            pieces.push(points.slice(start, index + 1));
            start = index;
        });
        pieces.push(points.slice(start));
        return pieces.filter(piece => piece.length >= 2);
    }

    // The whole pipeline: a set of centrelines in, the segments a person would point at out.
    function segmentRoadNetwork(lines, options = {}) {
        const graph = buildRoadGraph(lines, options);
        const chains = chainsFromGraph(graph);
        const segments = [];
        chains.forEach(chain => {
            splitAtCorners(chain, options).forEach(piece => {
                const clean = cleanPlanarLine(piece);
                if (clean) segments.push(clean);
            });
        });
        return segments;
    }

    function pointToSegmentDistance(p, a, b) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        if (len2 < SEG_EPS) return Math.hypot(p[0] - a[0], p[1] - a[1]);
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
        return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
    }

    function distanceToPolyline(point, points) {
        let best = Infinity;
        for (let i = 0; i < points.length - 1; i += 1) {
            best = Math.min(best, pointToSegmentDistance(point, points[i], points[i + 1]));
        }
        return best;
    }

    // The segment the user meant by clicking there. Ties on distance are broken toward the longer
    // segment, so brushing a junction picks the street rather than the two-metre stub beside it.
    function nearestSegment(segments, point, options = {}) {
        if (!Array.isArray(segments) || !segments.length || !isFinitePoint(point)) return null;
        const minLength = Number(options.minPieceLength) >= 0
            ? Number(options.minPieceLength) : 0;
        let best = null;
        segments.forEach((points, index) => {
            const distance = distanceToPolyline(point, points);
            const length = polylineLength(points);
            if (!Number.isFinite(distance)) return;
            const usable = length >= minLength;
            if (!best) { best = { index, points, distance, length, usable }; return; }
            // Prefer a usable segment over a stub; then nearer; then longer.
            if (usable !== best.usable) { if (usable) best = { index, points, distance, length, usable }; return; }
            if (distance < best.distance - 0.25
                || (Math.abs(distance - best.distance) <= 0.25 && length > best.length)) {
                best = { index, points, distance, length, usable };
            }
        });
        return best;
    }

    // Every segment cut down to the parts that lie inside the parcel. Doing this BEFORE the pick is
    // what stops a click landing on a cross street: a side street is long (so it looks like a fine
    // segment) but its run inside THIS road parcel is just the width of the carriageway, and picking
    // by full length hands back that little crossing square instead of the street under the pointer.
    function runsInsideRings(segments, rings) {
        const runs = [];
        (segments || []).forEach(segment => {
            if (!Array.isArray(segment) || segment.length < 2) return;
            const pieces = (Array.isArray(rings) && rings.length)
                ? clipPolylineToRings(segment, rings)
                : [segment];
            pieces.forEach(piece => { if (piece && piece.length >= 2) runs.push(piece); });
        });
        return runs;
    }

    // The run a click meant: the nearest, with near-ties broken toward the longer one (two
    // centrelines within a couple of metres of the pointer are a dual carriageway or a junction
    // overlap, and the longer is the street rather than the stub).
    //
    // The tie window has to stay SMALL. Clipping the runs to the parcel first already removes almost
    // every stub, so a generous window buys nothing and costs a lot: measured over 1509 pointer
    // positions across one road parcel, a 15 m window highlighted a run the pointer was not on 16%
    // of the time — the street next to the one under the cursor — against 1.3% at 2 m, while stubs
    // only rose from 0.0% to 0.5%.
    function pickRunForClick(runs, point, options = {}) {
        if (!Array.isArray(runs) || !runs.length || !isFinitePoint(point)) return null;
        const radius = Number.isFinite(options.pickRadius) ? Number(options.pickRadius) : 2;
        const scored = runs
            .map((points, index) => ({
                index,
                points,
                distance: distanceToPolyline(point, points),
                length: polylineLength(points)
            }))
            .filter(entry => Number.isFinite(entry.distance));
        if (!scored.length) return null;
        const nearest = scored.reduce((best, entry) => (entry.distance < best.distance ? entry : best));
        const contenders = scored.filter(entry => entry.distance <= nearest.distance + radius);
        return contenders.reduce((best, entry) => (entry.length > best.length ? entry : best), contenders[0]);
    }

    function pointInRings(point, rings) {
        let inside = false;
        (rings || []).forEach(ring => {
            if (!Array.isArray(ring) || ring.length < 3) return;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const xi = ring[i][0];
                const yi = ring[i][1];
                const xj = ring[j][0];
                const yj = ring[j][1];
                const crosses = ((yi > point[1]) !== (yj > point[1]))
                    && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
                if (crosses) inside = !inside;
            }
        });
        return inside;
    }

    // Cut a polyline at every polygon-boundary crossing and keep the runs that lie inside. Used to
    // bound an adopted segment to the road parcel that was actually clicked, so adoption can never
    // reach into land the click did not select.
    function clipPolylineToRings(points, rings) {
        if (!Array.isArray(points) || points.length < 2 || !Array.isArray(rings) || !rings.length) return [];
        const pieces = [];
        let current = [];

        const startsInside = pointInRings(points[0], rings);
        if (startsInside) current.push(points[0]);

        for (let i = 0; i < points.length - 1; i += 1) {
            const a = points[i];
            const b = points[i + 1];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const hits = [];
            rings.forEach(ring => {
                if (!Array.isArray(ring) || ring.length < 3) return;
                for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) {
                    const cx = ring[k][0];
                    const cy = ring[k][1];
                    const ex = ring[j][0] - cx;
                    const ey = ring[j][1] - cy;
                    const det = dx * ey - dy * ex;
                    if (Math.abs(det) < 1e-12) continue;
                    const t = ((cx - a[0]) * ey - (cy - a[1]) * ex) / det;
                    const u = ((cx - a[0]) * dy - (cy - a[1]) * dx) / det;
                    if (t > SEG_EPS && t < 1 - SEG_EPS && u >= 0 && u <= 1) {
                        hits.push({ t, point: [a[0] + dx * t, a[1] + dy * t] });
                    }
                }
            });
            hits.sort((x, y) => x.t - y.t);

            let inside = pointInRings(a, rings);
            hits.forEach(hit => {
                if (inside) {
                    current.push(hit.point);
                    if (current.length >= 2) pieces.push(current);
                    current = [];
                } else {
                    current = [hit.point];
                }
                inside = !inside;
            });
            if (inside) current.push(b);
        }
        if (current.length >= 2) pieces.push(current);
        return pieces.map(piece => cleanPlanarLine(piece)).filter(Boolean);
    }

    function quantile(sorted, q) {
        if (!sorted.length) return NaN;
        const position = (sorted.length - 1) * q;
        const low = Math.floor(position);
        const high = Math.ceil(position);
        if (low === high) return sorted[low];
        return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    }

    // How wide the road actually has room to be here, measured as the gap between the two sides of
    // the road parcel itself: rays cast perpendicular from the centreline to the parcel boundary,
    // reusing the corridor-clearance sampler. A low quantile rather than the mean, so the width
    // stays inside the parcel along most of the run instead of averaging over a wide junction mouth
    // — and staying inside the ROAD parcel is what keeps an adopted road off the buildings beside it.
    // Every centreline near this run that is not the run itself — the neighbours whose presence bounds
    // how wide it may be (see measureAvailableWidth).
    //
    // It must be taken from the WHOLE network, not from the runs of one parcel: a street's neighbours
    // are usually in other parcels, and at a junction they always are. Bounded only by its own parcel's
    // streets, a run reaching a junction found nothing to stop it and spread its pavement across
    // everything meeting there.
    //
    // `runsInsideRings` hands back CLIPPED COPIES, so the run's own parent segment is not the same
    // object and has to be recognised by geometry: if most of the run lies along a segment, that
    // segment is the run, not a neighbour.
    function neighbourSegments(runXY, segments, options = {}) {
        if (!Array.isArray(runXY) || runXY.length < 2 || !Array.isArray(segments)) return [];
        const reach = Number(options.reach) > 0 ? Number(options.reach) : 60;
        const sameTolerance = Number(options.sameTolerance) > 0 ? Number(options.sameTolerance) : 3;
        const share = Number.isFinite(options.share) ? Number(options.share) : 0.5;

        const box = runXY.reduce((b, p) => [
            Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])
        ], [Infinity, Infinity, -Infinity, -Infinity]);

        return segments.filter(segment => {
            if (!Array.isArray(segment) || segment.length < 2) return false;
            const sb = segment.reduce((b, p) => [
                Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])
            ], [Infinity, Infinity, -Infinity, -Infinity]);
            if (box[0] > sb[2] + reach || box[2] < sb[0] - reach
                || box[1] > sb[3] + reach || box[3] < sb[1] - reach) return false;
            const along = runXY.filter(point => distanceToPolyline(point, segment) <= sameTolerance).length;
            return along / runXY.length < share;
        });
    }

    function measureAvailableWidth(points, rings, options = {}) {
        const sampler = (typeof global.corridorClearanceSamples === 'function')
            ? global.corridorClearanceSamples
            : (typeof require === 'function' ? require('./corridor-clearance.js').corridorClearanceSamples : null);
        if (typeof sampler !== 'function') return null;
        if (!Array.isArray(points) || points.length < 2 || !Array.isArray(rings) || !rings.length) return null;

        const maxDistance = Number(options.maxDistance) > 0 ? Number(options.maxDistance) : 60;
        const step = Number(options.stationStep) > 0 ? Number(options.stationStep) : 4;
        const q = Number.isFinite(options.quantile) ? Number(options.quantile) : 0.25;

        // NEIGHBOURING STREETS BOUND A RUN TOO, not just the parcel edge and the buildings. One
        // cadastral road parcel routinely holds a whole boulevard — Ulica grada Vukovara's parcel is
        // both carriageways, the tram median and both pavements, ~60 m of it — and measured against
        // the parcel alone EACH carriageway claimed the lot: 50-72 m, which the section then had to
        // spend, producing 36-40 m "pavements" that covered the other carriageway and the buildings
        // beyond it. A street's room ends where the next street's begins, so a ray that reaches
        // another centreline stops HALF WAY: the two split what lies between them, and neither
        // overlaps the other.
        //
        // The barrier is the neighbour's centreline traced out and back — a zero-area ring, so the
        // ring-walking index above raises no spurious closing chord across the map.
        const obstacles = [{ id: 'parcel', kind: 'parcel', rings }];
        const neighbours = (options.neighbours || [])
            .filter(line => Array.isArray(line) && line.length >= 2)
            .map(line => [...line, ...line.slice().reverse()]);
        if (neighbours.length) obstacles.push({ id: 'street', kind: 'street', rings: neighbours });

        const samples = sampler(points, obstacles, { maxDistance, stationStep: step });
        if (!samples.length) return null;

        // How much of one side this run may have: all of it against the parcel or a building, half of
        // it against another street.
        const room = side => {
            if (!side || !Number.isFinite(side.distance)) return null;
            return side.kind === 'street' ? side.distance / 2 : side.distance;
        };

        // Only stations that found the parcel edge on BOTH sides measure a width; a one-sided
        // station sits at a junction mouth or past the parcel end and would report the ray cap.
        const widths = samples
            .filter(sample => sample.left && sample.right)
            .map(sample => room(sample.left) + room(sample.right))
            .filter(width => Number.isFinite(width) && width > 0)
            .sort((a, b) => a - b);
        if (!widths.length) return null;

        // The width that fits along the run. The road is centred on the centreline, so each station
        // allows twice its tighter side. A high percentile is wrong here — at the 25th, a quarter of
        // the run is narrower than the road built on it, which is exactly where it cuts — but so is
        // the strict minimum: ONE pinched station collapses the whole street. That happens for real,
        // at both ends, where the run meets a junction whose corridor has already been taken; the
        // second street adopted in a parcel came out at the 2 m floor because of a single station.
        //
        // So: ignore the junction mouths at either end, then take a low percentile of the rest. The
        // caller still verifies the result geometrically before building anything.
        const endSkip = Number(options.endSkipMeters) >= 0 ? Number(options.endSkipMeters) : 8;
        const runLength = polylineLength(points);
        const interior = samples.filter(sample => sample.s >= endSkip && sample.s <= runLength - endSkip);
        const measuredOver = interior.length >= 3 ? interior : samples;
        const symmetric = measuredOver
            .filter(sample => sample.left && sample.right)
            .map(sample => 2 * Math.min(room(sample.left), room(sample.right)))
            .filter(width => Number.isFinite(width) && width > 0)
            .sort((a, b) => a - b);

        // Each side on its own. An OSM centreline is very often NOT centred in its cadastral road
        // parcel — the parcel is one side of the street, or a leftover strip — and a symmetric width
        // then collapses to twice the narrow side: along Strojarska cesta, corridors of 21 m + 4 m and
        // 1 m + 16 m came out as 3.8 m and 1.3 m, drawn as hairlines a viewer reads as "not rendered".
        // A caller that can place the section off-centre uses these two instead of fitWidth.
        const sideRoom = pick => measuredOver
            .filter(sample => sample.left && sample.right)
            .map(sample => room(pick(sample)))
            .filter(value => Number.isFinite(value) && value > 0)
            .sort((a, b) => a - b);
        const leftRoom = sideRoom(sample => sample.left);
        const rightRoom = sideRoom(sample => sample.right);

        return {
            width: quantile(widths, q),
            fitWidth: symmetric.length ? quantile(symmetric, 0.1) : null,
            leftWidth: leftRoom.length ? quantile(leftRoom, 0.1) : null,
            rightWidth: rightRoom.length ? quantile(rightRoom, 0.1) : null,
            min: widths[0],
            median: quantile(widths, 0.5),
            max: widths[widths.length - 1],
            sampleCount: widths.length
        };
    }

    // The segment's real footprint: the strip of road parcel between its two edges, along this run
    // only. Built from the same perpendicular rays measureAvailableWidth uses, so it follows the
    // parcel's actual edges rather than assuming the run is centred in it — an OSM centreline rarely
    // is. A parcel carrying a pavement on one side is wider on that side, and a constant-width band
    // drawn about the centreline leaves that strip showing beyond it.
    function segmentBandRing(points, rings, options = {}) {
        const sampler = (typeof global.corridorClearanceSamples === 'function')
            ? global.corridorClearanceSamples
            : (typeof require === 'function' ? require('./corridor-clearance.js').corridorClearanceSamples : null);
        const halo = (typeof global.corridorClearanceHalo === 'function')
            ? global.corridorClearanceHalo
            : (typeof require === 'function' ? require('./corridor-clearance.js').corridorClearanceHalo : null);
        if (typeof sampler !== 'function' || typeof halo !== 'function') return null;
        if (!Array.isArray(points) || points.length < 2 || !Array.isArray(rings) || !rings.length) return null;

        const maxDistance = Number(options.maxDistance) > 0 ? Number(options.maxDistance) : 60;
        // A tight station step: the band has to hug a kerb line that bends, not cut the corner.
        const step = Number(options.stationStep) > 0 ? Number(options.stationStep) : 3;
        const samples = sampler(points, [{ id: 'parcel', kind: 'parcel', rings }], { maxDistance, stationStep: step });
        if (!samples.length) return null;

        // Two things would wreck this band if the rays were trusted raw. A station whose ray escapes
        // — a junction mouth, with no parcel edge to stop it — reports nothing and would reach the
        // full cap; and a station opening onto a junction plaza can measure 60 m where its neighbour
        // three metres away measures 12. Either way the ring lurches sideways and folds over itself,
        // which then clips to nothing. Clamping every side to a high quantile of the distances
        // actually measured here keeps the band on the kerb line along the street and simply carries
        // that width across the gaps.
        const reaches = [];
        samples.forEach(sample => {
            if (sample.left) reaches.push(sample.left.distance);
            if (sample.right) reaches.push(sample.right.distance);
        });
        if (!reaches.length) return null;
        reaches.sort((a, b) => a - b);
        const cap = quantile(reaches, Number.isFinite(options.reachQuantile) ? Number(options.reachQuantile) : 0.9);
        if (!(cap > 0)) return null;

        const ring = halo(samples, cap + 0.5);
        return (Array.isArray(ring) && ring.length >= 3) ? ring : null;
    }

    function segmentBands(runs, rings, options = {}) {
        return (runs || []).map(run => segmentBandRing(run, rings, options));
    }

    // The run the pointer is ON: the one whose strip of road parcel contains it.
    //
    // This is the honest test, and it replaces "nearest centreline" for a reason. Distance to a
    // centreline assumes the centreline sits in the middle of the road, and an OSM centreline in a
    // cadastral parcel does not — the two surveys were made independently and disagree by metres.
    // Where they disagree the nearest-centreline pick lands on the street NEXT DOOR while the
    // pointer is plainly inside this one. Containment cannot make that mistake: whatever the
    // centreline is doing, the pointer is either in this road's strip or it is not.
    //
    // Inside no band — a junction plaza, a verge, the parcel's outer corners — it falls back to the
    // nearest run, but ONLY if that run is within arm's reach. A cadastral road parcel holds open
    // ground that belongs to no street in particular, and an unbounded fallback there reaches for
    // whatever centreline happens to be closest: measured over one parcel, 3.2% of positions
    // highlighted a street the pointer was not on, one of them 116 m away. Past the limit the honest
    // answer is nothing at all, which the caller renders as no outline.
    function pickRunAtPoint(runs, bands, point, options = {}) {
        if (!Array.isArray(runs) || !runs.length || !isFinitePoint(point)) return null;
        const reach = Number.isFinite(options.fallbackReach) ? Number(options.fallbackReach) : 15;
        const describe = index => ({
            index,
            points: runs[index],
            distance: distanceToPolyline(point, runs[index]),
            length: polylineLength(runs[index])
        });

        const containing = [];
        (bands || []).forEach((band, index) => {
            if (band && runs[index] && pointInRings(point, [band])) containing.push(index);
        });
        if (containing.length === 1) return describe(containing[0]);
        if (containing.length > 1) {
            // Overlapping strips at a junction: fall back to the nearest centreline among them only.
            return describe(containing.reduce((a, b) => (
                distanceToPolyline(point, runs[a]) <= distanceToPolyline(point, runs[b]) ? a : b
            )));
        }
        const nearest = pickRunForClick(runs, point, options);
        return (nearest && nearest.distance <= reach) ? nearest : null;
    }

    const api = {
        SEGMENTATION_DEFAULTS,
        segmentBandRing,
        segmentBands,
        pickRunAtPoint,
        cleanPlanarLine,
        polylineLength,
        buildRoadGraph,
        chainsFromGraph,
        turnProfile,
        findCornerIndices,
        splitAtCorners,
        segmentRoadNetwork,
        nearestSegment,
        runsInsideRings,
        neighbourSegments,
        pickRunForClick,
        distanceToPolyline,
        pointInRings,
        clipPolylineToRings,
        measureAvailableWidth
    };

    global.RoadSegmentation = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
