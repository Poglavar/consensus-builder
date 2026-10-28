// The centre lines of a road placed into a parcel left for it (docs/road-in-parcel.md): a site
// polygon in, the street graph that fills it out. v1 reads straight grids (a Schelling layout's
// street strips, a cadastral road parcel, an L, a T): every street is a strip between two facing
// kerbs, the edges of the site that run along one of its two dominant directions. Curved or
// irregular sites are refused (`not-a-grid`) until the medial-axis reading exists. Pure and planar
// in the frame the caller passes (metric-frame.js); no DOM, no turf, so node tests and the MCP
// server run the same reading as the browser (backend/test/corridor-site-centreline.test.js).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorSiteCentreline = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const DEFAULTS = Object.freeze({
        minStreetWidthM: 3,      // a strip narrower than this is not a street
        maxStreetWidthM: 60,     // nor one wider (an 80 m boulevard parcel is placed by hand)
        axisToleranceDeg: 3,     // an edge this close to a dominant direction is a kerb
        minLengthRatio: 1.5,     // a street is at least this many widths long (a square is not a street)
        squareRatio: 0.15,       // a lone rectangle whose sides differ less than this is a square
        minCoverage: 0.6,        // the streets found must cover this share of the site, or it is not a grid
        rectangularity: 0.85,    // a lone site fills this share of its rectangle to be read as one street
        joinToleranceM: 1        // how far apart two ends may be and still meet
    });
    const EPS = 1e-7;

    const finite = value => typeof value === 'number' && Number.isFinite(value);

    // ---- rings ---------------------------------------------------------------------------------

    function openRing(ring) {
        const out = [];
        ring.forEach(p => {
            if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) throw new Error('corridor-site-centreline: ring positions must be finite [x, y]');
            const last = out[out.length - 1];
            if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-6) return;
            out.push([p[0], p[1]]);
        });
        if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
        return out;
    }

    function signedArea(ring) {
        let sum = 0;
        for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            sum += a[0] * b[1] - b[0] * a[1];
        }
        return sum / 2;
    }

    // The outer ring counter-clockwise and the holes clockwise, so the inside of the site is
    // always on the left of an edge's direction.
    function orientedPolygon(rings) {
        return rings.map(openRing).filter(ring => ring.length >= 3).map((ring, index) => {
            const ccw = signedArea(ring) > 0;
            return (index === 0) === ccw ? ring : ring.slice().reverse();
        });
    }

    function polygonArea(rings) {
        return rings.reduce((sum, ring, index) => sum + (index === 0 ? 1 : -1) * Math.abs(signedArea(ring)), 0);
    }

    function edgesOf(rings) {
        const edges = [];
        rings.forEach(ring => {
            for (let i = 0; i < ring.length; i += 1) edges.push([ring[i], ring[(i + 1) % ring.length]]);
        });
        return edges;
    }

    // The site's two street directions: the direction (modulo 90°) that the most edge length runs
    // along within the kerb tolerance, refined to the length-weighted mean of those edges. A mean of
    // ALL edges would be pulled off the streets by an oblique boundary (a pool cut across a street
    // grid), and then no street edge would read as a kerb.
    function dominantAngle(rings, toleranceDeg = DEFAULTS.axisToleranceDeg) {
        const quarter = Math.PI / 2;
        const fold = phi => { let a = phi % quarter; if (a < -quarter / 2) a += quarter; if (a >= quarter / 2) a -= quarter; return a; };
        const diff = (a, b) => Math.abs(fold(a - b));
        const tolerance = toleranceDeg * Math.PI / 180;
        const edges = edgesOf(rings).map(([a, b]) => ({ angle: fold(Math.atan2(b[1] - a[1], b[0] - a[0])), length: Math.hypot(b[0] - a[0], b[1] - a[1]) }))
            .filter(edge => edge.length > 0);
        if (!edges.length) return 0;
        let best = null;
        edges.forEach(candidate => {
            const score = edges.reduce((sum, edge) => sum + (diff(edge.angle, candidate.angle) <= tolerance ? edge.length : 0), 0);
            if (!best || score > best.score + 1e-9) best = { angle: candidate.angle, score };
        });
        // The mean of the agreeing edges, as offsets from the winner (so ±45° folding cannot split them).
        let weighted = 0;
        let total = 0;
        edges.forEach(edge => {
            if (diff(edge.angle, best.angle) > tolerance) return;
            weighted += fold(edge.angle - best.angle) * edge.length;
            total += edge.length;
        });
        return fold(best.angle + (total ? weighted / total : 0));
    }

    function rotator(theta) {
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        return {
            // into the street frame (streets run along x and y)
            into: p => [p[0] * cos + p[1] * sin, -p[0] * sin + p[1] * cos],
            // back to the caller's frame
            out: p => [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos]
        };
    }

    // ---- pieces: a strip between two facing kerbs ------------------------------------------------

    // Coordinates along one axis: `a` runs with the streets, `c` across them. Lines along x read
    // the plane as it is; lines along y read it turned by −90° (a = y, c = −x), which keeps the
    // inside of the site on the left of every edge.
    const toAC = { x: p => [p[0], p[1]], y: p => [p[1], -p[0]] };

    // c on edge e at along-position a (the edge runs mostly along a).
    function cAt(edge, a) {
        const [p, q] = edge;
        const da = q[0] - p[0];
        if (Math.abs(da) < 1e-12) return (p[1] + q[1]) / 2;
        return p[1] + (q[1] - p[1]) * ((a - p[0]) / da);
    }

    // The first edge above (larger c than) c0 at along-position a, of all edges, kerbs or not.
    function firstHitAbove(edges, a, c0) {
        let best = null;
        edges.forEach(edge => {
            const a0 = Math.min(edge[0][0], edge[1][0]);
            const a1 = Math.max(edge[0][0], edge[1][0]);
            if (a1 - a0 < 1e-12 || a < a0 || a > a1) return;
            const c = cAt(edge, a);
            if (c > c0 + EPS && (!best || c < best.c)) best = { edge, c };
        });
        return best;
    }

    // Every strip whose lower kerb (an edge running +a, the site above it) faces an upper kerb
    // (running −a) at a street's distance: { from, to, low, high } in along/across coordinates.
    // Sub-intervals between the vertices' along-positions have one first edge above them, since
    // the edges of a simple polygon never cross, so the pairing is exact without sampling.
    function piecesAlong(edgesAC, options) {
        const tolerance = Math.sin(options.axisToleranceDeg * Math.PI / 180);
        const kerbOf = new Map();
        edgesAC.forEach(edge => {
            const da = edge[1][0] - edge[0][0];
            const dc = edge[1][1] - edge[0][1];
            const length = Math.hypot(da, dc);
            if (length < 1e-9 || Math.abs(dc) > length * tolerance) return;
            kerbOf.set(edge, da > 0 ? 'low' : 'high');
        });
        const alongs = [...new Set(edgesAC.map(edge => edge[0][0]))].sort((u, v) => u - v);
        const pieces = [];
        edgesAC.forEach(edge => {
            if (kerbOf.get(edge) !== 'low') return;
            const a0 = Math.min(edge[0][0], edge[1][0]);
            const a1 = Math.max(edge[0][0], edge[1][0]);
            const cuts = [a0, ...alongs.filter(a => a > a0 + 1e-9 && a < a1 - 1e-9), a1];
            for (let k = 0; k + 1 < cuts.length; k += 1) {
                const u = cuts[k];
                const v = cuts[k + 1];
                if (v - u < 1e-6) continue;
                const mid = (u + v) / 2;
                const hit = firstHitAbove(edgesAC, mid, cAt(edge, mid));
                if (!hit || kerbOf.get(hit.edge) !== 'high') continue;
                const width = hit.c - cAt(edge, mid);
                if (width < options.minStreetWidthM || width > options.maxStreetWidthM) continue;
                const low = Math.max(cAt(edge, u), cAt(edge, v));
                const high = Math.min(cAt(hit.edge, u), cAt(hit.edge, v));
                if (high - low < options.minStreetWidthM) continue;
                pieces.push({ from: u, to: v, low, high });
            }
        });
        return pieces;
    }

    // Pieces in along/across coordinates back to the street frame: along x, across is y; along y,
    // across is x (c = −x flips the band).
    function worldPiece(axis, piece) {
        return axis === 'x' ? { ...piece } : { from: piece.from, to: piece.to, low: -piece.high, high: -piece.low };
    }

    // ---- runs and lines --------------------------------------------------------------------------

    const bandOverlap = (p, q) => Math.min(p.high, q.high) - Math.max(p.low, q.low);
    const sameStreet = (p, q) => bandOverlap(p, q) >= 0.5 * Math.min(p.high - p.low, q.high - q.low);

    function runOf(axis, pieces) {
        const sorted = pieces.slice().sort((p, q) => p.from - q.from);
        return {
            axis,
            pieces: sorted,
            from: Math.min(...sorted.map(p => p.from)),
            to: Math.max(...sorted.map(p => p.to)),
            low: Math.min(...sorted.map(p => p.low)),
            high: Math.max(...sorted.map(p => p.high))
        };
    }

    // Consecutive pieces of one street (touching, and mostly the same band) are one run.
    function runsOf(axis, pieces) {
        const sorted = pieces.slice().sort((p, q) => p.from - q.from || p.low - q.low);
        const parent = sorted.map((_, i) => i);
        const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        for (let i = 0; i < sorted.length; i += 1) {
            for (let j = i + 1; j < sorted.length; j += 1) {
                if (sorted[j].from > sorted[i].to + 1e-3) break;
                if (Math.abs(sorted[j].from - sorted[i].to) <= 1e-3 || (sorted[j].from < sorted[i].to && sorted[j].to > sorted[i].from)) {
                    if (sameStreet(sorted[i], sorted[j])) parent[find(j)] = find(i);
                }
            }
        }
        const groups = new Map();
        sorted.forEach((piece, i) => {
            const key = find(i);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(piece);
        });
        return [...groups.values()].map(group => runOf(axis, group));
    }

    // A crossing or a T opening has no kerbs in either direction, so a street's runs stop on both
    // sides of it. Two runs of one street are one line when a run of the other direction meets
    // the gap between them.
    function bridgeRuns(runs, others, options) {
        const tol = options.joinToleranceM;
        let merged = runs.slice();
        let changed = true;
        while (changed) {
            changed = false;
            merged.sort((p, q) => p.from - q.from);
            outer: for (let i = 0; i < merged.length; i += 1) {
                for (let j = 0; j < merged.length; j += 1) {
                    if (i === j) continue;
                    const r1 = merged[i];
                    const r2 = merged[j];
                    const gap = r2.from - r1.to;
                    if (gap < -1e-3 || gap > options.maxStreetWidthM + tol) continue;
                    const band = { low: Math.max(r1.low, r2.low), high: Math.min(r1.high, r2.high) };
                    if (!(band.high - band.low >= 0.5 * Math.min(r1.high - r1.low, r2.high - r2.low))) continue;
                    const crossing = others.some(p => {
                        const mid = (p.low + p.high) / 2;
                        return mid >= r1.to - tol && mid <= r2.from + tol
                            && p.from <= Math.max(r1.high, r2.high) + tol && p.to >= Math.min(r1.low, r2.low) - tol;
                    });
                    if (!crossing) continue;
                    merged = merged.filter((_, k) => k !== i && k !== j);
                    merged.push(runOf(r1.axis, r1.pieces.concat(r2.pieces)));
                    changed = true;
                    break outer;
                }
            }
        }
        return merged;
    }

    // The across-position of a line: the middle of the band every piece shares, so the lanes fit
    // the narrowest part (the user's rule); when the pieces share no band, their length-weighted mean.
    function lineOf(run) {
        const shared = { low: Math.max(...run.pieces.map(p => p.low)), high: Math.min(...run.pieces.map(p => p.high)) };
        let c;
        if (shared.high > shared.low) c = (shared.low + shared.high) / 2;
        else {
            const total = run.pieces.reduce((sum, p) => sum + (p.to - p.from), 0) || 1;
            c = run.pieces.reduce((sum, p) => sum + ((p.low + p.high) / 2) * (p.to - p.from), 0) / total;
        }
        const widths = run.pieces.map(p => ({ width: p.high - p.low, length: p.to - p.from })).sort((p, q) => p.width - q.width);
        const half = widths.reduce((sum, w) => sum + w.length, 0) / 2;
        let acc = 0;
        let median = widths[0].width;
        for (const w of widths) { acc += w.length; if (acc >= half) { median = w.width; break; } }
        return { axis: run.axis, c, from: run.from, to: run.to, low: run.low, high: run.high, pieces: run.pieces, medianWidth: median };
    }

    const pointOn = (line, s) => (line.axis === 'x' ? [s, line.c] : [line.c, s]);

    // The nearest boundary crossing along a ray, as a distance (Infinity when nothing is hit).
    function rayToBoundary(edges, origin, direction) {
        let best = Infinity;
        edges.forEach(([a, b]) => {
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const det = direction[0] * (-dy) - direction[1] * (-dx);
            if (Math.abs(det) < 1e-12) return;
            const ox = a[0] - origin[0];
            const oy = a[1] - origin[1];
            const t = (ox * (-dy) - oy * (-dx)) / det;
            const u = (direction[0] * oy - direction[1] * ox) / det;
            if (u < -1e-9 || u > 1 + 1e-9 || t < -1e-9) return;
            if (t < best) best = t;
        });
        return best;
    }

    // Each end of a line runs on to the centre of a street it meets (a T or a corner), else to the
    // site's boundary (where the street leaves the site).
    function extendEnds(lines, edges, options) {
        const tol = options.joinToleranceM;
        const original = lines.map(line => ({ from: line.from, to: line.to }));
        lines.forEach((line, index) => {
            const own = original[index];
            const reachOwn = (line.high - line.low) / 2 + tol;
            ['from', 'to'].forEach(end => {
                const at = own[end];
                const sign = end === 'to' ? 1 : -1;
                let target = null;
                lines.forEach((other, k) => {
                    if (other.axis === line.axis) return;
                    // This end stops at the other street's near kerb (half its width short of
                    // its centre), and the other street reaches this one (runs past it, or stops
                    // at its kerb too: a corner).
                    const ahead = sign * (other.c - at);
                    if (ahead < -tol || ahead > (other.high - other.low) / 2 + tol) return;
                    const span = original[k];
                    if (line.c < span.from - reachOwn || line.c > span.to + reachOwn) return;
                    if (target === null || Math.abs(other.c - at) < Math.abs(target - at)) target = other.c;
                });
                if (target !== null) {
                    line[end] = end === 'to' ? Math.max(line[end], target) : Math.min(line[end], target);
                    line[`${end}Joined`] = true;
                    return;
                }
                const direction = line.axis === 'x' ? [sign, 0] : [0, sign];
                const distance = rayToBoundary(edges, pointOn(line, at), direction);
                if (Number.isFinite(distance) && distance <= 1.5 * (line.high - line.low) + tol) {
                    line[end] = at + sign * distance;
                }
            });
        });
    }

    // Where a line along x meets a line along y: a node both carry, at exactly one position.
    function nodesOf(lines, options) {
        const tol = options.joinToleranceM;
        const nodes = [];
        lines.filter(line => line.axis === 'x').forEach(h => {
            lines.filter(line => line.axis === 'y').forEach(v => {
                if (v.c < h.from - tol || v.c > h.to + tol || h.c < v.from - tol || h.c > v.to + tol) return;
                const node = { x: v.c, y: h.c, lines: [h, v] };
                nodes.push(node);
                h.from = Math.min(h.from, v.c); h.to = Math.max(h.to, v.c);
                v.from = Math.min(v.from, h.c); v.to = Math.max(v.to, h.c);
            });
        });
        return nodes;
    }

    // The width each arm of a line has room for: twice the nearest kerb over the pieces it runs
    // along, so lanes centred on the line fit its narrowest part. An arm with no piece (inside a
    // crossing, or the stretch run on to the boundary) takes the narrowest of its line.
    function armsOf(line, stops) {
        const halfRoom = piece => Math.min(line.c - piece.low, piece.high - line.c);
        const lineRoom = Math.min(...line.pieces.map(halfRoom));
        const arms = [];
        for (let k = 0; k + 1 < stops.length; k += 1) {
            const from = stops[k];
            const to = stops[k + 1];
            const covering = line.pieces.filter(p => Math.min(p.to, to) - Math.max(p.from, from) > 1e-6);
            const room = covering.length ? Math.min(...covering.map(halfRoom)) : lineRoom;
            arms.push({ from, to, widthM: Math.max(0, 2 * room) });
        }
        return arms;
    }

    // ---- the reading -----------------------------------------------------------------------------

    function lineFallback(rings, options) {
        if (rings.length !== 1) return null;
        const xs = rings[0].map(p => p[0]);
        const ys = rings[0].map(p => p[1]);
        const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
        const w = box.x1 - box.x0;
        const h = box.y1 - box.y0;
        if (!(w > 0 && h > 0) || polygonArea(rings) < options.rectangularity * w * h) return null;
        const square = Math.abs(w - h) <= options.squareRatio * Math.max(w, h);
        const alongX = options.turn ? w < h : w >= h;
        // Across the street it runs along, the rectangle must still be a street's width: a block is not.
        if ((alongX ? h : w) > options.maxStreetWidthM) return null;
        const piece = alongX
            ? { from: box.x0, to: box.x1, low: box.y0, high: box.y1 }
            : { from: box.y0, to: box.y1, low: box.x0, high: box.x1 };
        const line = lineOf(runOf(alongX ? 'x' : 'y', [piece]));
        return { line, square };
    }

    /**
     * The street graph of one polygon given as planar rings ([outer, ...holes], [x, y] metres).
     * Returns { theta, lines: [{ axis, points: [[x, y], ...], arms: [{ widthM, lengthM }], nodeKeys }],
     * nodes: [[x, y]], issues: [{ code }] } in the caller's frame. Issues: `not-a-grid` (nothing
     * here reads as straight streets; no lines), `square` (a lone square: the street could run
     * either way, `options.turn` picks the other).
     */
    function streetGraphOfRings(inputRings, inputOptions = {}) {
        const options = { ...DEFAULTS, ...inputOptions };
        const rings0 = orientedPolygon(inputRings || []);
        if (!rings0.length) return { theta: 0, lines: [], nodes: [], issues: [{ code: 'not-a-grid' }] };
        const theta = dominantAngle(rings0);
        const rot = rotator(theta);
        const rings = rings0.map(ring => ring.map(rot.into));
        const edges = edgesOf(rings);
        const area = polygonArea(rings);

        const runs = {};
        ['x', 'y'].forEach(axis => {
            const edgesAC = edges.map(([a, b]) => [toAC[axis](a), toAC[axis](b)]);
            runs[axis] = runsOf(axis, piecesAlong(edgesAC, options).map(piece => worldPiece(axis, piece)));
        });
        // A run of the other direction, read as a band in this direction's along-coordinate.
        const crossBands = axis => runs[axis === 'x' ? 'y' : 'x'].map(run => ({ low: run.low, high: run.high, from: run.from, to: run.to }));
        let lines = ['x', 'y']
            .flatMap(axis => bridgeRuns(runs[axis], crossBands(axis), options))
            .map(lineOf)
            .filter(line => line.to - line.from >= options.minLengthRatio * line.medianWidth);

        const issues = [];
        if (!lines.length) {
            const fallback = lineFallback(rings, options);
            if (!fallback) return { theta, lines: [], nodes: [], issues: [{ code: 'not-a-grid' }] };
            lines = [fallback.line];
            if (fallback.square) issues.push({ code: 'square' });
        } else {
            const covered = lines.reduce((sum, line) => sum + line.pieces.reduce((s, p) => s + (p.to - p.from) * (p.high - p.low), 0), 0);
            if (covered < options.minCoverage * area) return { theta, lines: [], nodes: [], issues: [{ code: 'not-a-grid', coverage: covered / area }] };
        }

        extendEnds(lines, edges, options);
        const nodes = nodesOf(lines, options);
        const nodeKey = (x, y) => `${Math.round(x * 1000)}:${Math.round(y * 1000)}`;
        const out = lines.map(line => {
            const stops = [line.from, ...nodes.filter(node => node.lines.includes(line)).map(node => (line.axis === 'x' ? node.x : node.y)), line.to]
                .sort((u, v) => u - v)
                .filter((s, k, all) => k === 0 || s - all[k - 1] > 1e-6);
            const arms = armsOf(line, stops).map(arm => ({ widthM: arm.widthM, lengthM: arm.to - arm.from }));
            const points = stops.map(s => pointOn(line, s));
            return {
                axis: line.axis,
                points: points.map(rot.out),
                arms,
                nodeKeys: points.map(p => nodeKey(p[0], p[1]))
            };
        }).filter(line => line.points.length >= 2);
        return { theta, lines: out, nodes: nodes.map(node => rot.out([node.x, node.y])), issues };
    }

    const polygonsOf = site => {
        const geometry = site && site.type === 'Feature' ? site.geometry : site;
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return [geometry.coordinates];
        if (geometry.type === 'MultiPolygon') return geometry.coordinates;
        throw new Error('corridor-site-centreline: the site must be a Polygon or MultiPolygon');
    };

    /**
     * The street graph of a site (GeoJSON Polygon/MultiPolygon in lon/lat), one part per polygon:
     * { parts: [{ lines: [{ axis, points: [{ lat, lng }], arms, nodeKeys }], issues }] }.
     * `frame` is a metric frame (metric-frame.js): toMetric([lon, lat]) and toLngLat([x, y]).
     */
    function streetGraphOfSite(site, frame, options = {}) {
        if (!frame || typeof frame.toMetric !== 'function' || typeof frame.toLngLat !== 'function') {
            throw new Error('corridor-site-centreline: a metric frame is required');
        }
        const parts = polygonsOf(site).map(rings => {
            const graph = streetGraphOfRings(rings.map(ring => ring.map(position => frame.toMetric(position))), options);
            return {
                issues: graph.issues,
                lines: graph.lines.map(line => ({
                    axis: line.axis,
                    arms: line.arms,
                    nodeKeys: line.nodeKeys,
                    points: line.points.map(xy => { const [lng, lat] = frame.toLngLat(xy); return { lat, lng }; })
                }))
            };
        });
        return { parts };
    }

    return Object.freeze({ DEFAULTS, streetGraphOfRings, streetGraphOfSite, dominantAngle, orientedPolygon });
});
