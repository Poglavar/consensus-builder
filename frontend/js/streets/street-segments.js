// Streets, their segments and the plots along each side (docs/vocabulary.md: Street, Segment, Side),
// from OSM-shaped ways, buildings and house numbers. Pure: no DOM, no network. The backend's
// GET /streets/segments, MCP and the browser's street picker all run this module.
//
// A street is the connected set of road ways sharing one name, branches included. Its segments
// lie between referable points: an end, a branching (another road, or a branch of the street
// itself), a bend of 30° or more measured over 20 m chords on both sides, a bridge longer than
// 3 m along it or one wider than 3 m over it, and a gap over 50 m between buildings. House numbers
// are referable points too; they name segment ends and bound a selection between two points, but
// do not cut the offered segments.
//
// Geometry runs in a local ground-metre frame about an anchor (equirectangular on turf's sphere,
// R = 6378137 m), which is exact enough over a street's few kilometres.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StreetSegments = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Roads a street is made of, and that branch from it. A service way (a drive, a car park aisle)
    // branches only when it is named; footways, paths, cycleways, steps and tracks never do.
    const ROAD_CLASSES = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
        'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
        'pedestrian', 'road', 'busway', 'service']);
    const BEND_DEGREES = 30;
    const BEND_BASELINE_M = 20;
    const BRIDGE_MIN_M = 3;
    const BUILDING_GAP_M = 50;
    // A building fronts the street when part of it lies this close to the centreline.
    const BUILDING_REACH_M = 40;
    const NUMBER_REACH_M = 50;
    // Ways of one name whose ends lie this close are one street (a short unnamed link between them).
    const JOIN_M = 20;
    // Referable points closer than this are one point; a segment shorter than it is not offered.
    const MERGE_M = 5;
    // Plots: rays every STEP_M, reaching REACH_M from the centreline; a plot fronts a side with at
    // least MIN_FRONTAGE_M of rays reaching it first.
    const PLOT_STEP_M = 2;
    const PLOT_REACH_M = 40;
    const MIN_FRONTAGE_M = 3;
    // Overpass width defaults, for a bridge over the street without a width tag.
    const DEFAULT_WIDTH_M = { railway: 5, footway: 2, path: 2, cycleway: 2.5, steps: 2, bridleway: 2.5, corridor: 2 };
    const ROAD_DEFAULT_WIDTH_M = 6;
    const KIND_PRIORITY = { end: 0, branch: 1, 'bridge-start': 2, 'bridge-end': 2, overpass: 3, bend: 4, 'gap-start': 5, 'gap-end': 5 };
    const SIDES = ['left', 'right', 'both'];
    const KINDS = ['end', 'branch', 'bridge-start', 'bridge-end', 'overpass', 'bend', 'gap-start', 'gap-end', 'number'];

    const EARTH_RADIUS_M = 6378137;
    const M_PER_DEG = Math.PI * EARTH_RADIUS_M / 180;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const round7 = value => Math.round(value * 1e7) / 1e7;
    const fail = message => { throw new Error(message); };

    function frame(lng0, lat0) {
        const mx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180);
        return {
            toM: ([lng, lat]) => [(lng - lng0) * mx, (lat - lat0) * M_PER_DEG],
            toLL: ([x, y]) => [round7(lng0 + x / mx), round7(lat0 + y / M_PER_DEG)]
        };
    }

    // One street name, compared without case, extra spaces, full stops or apostrophe variants.
    function normaliseName(name) {
        if (typeof name !== 'string') return '';
        return name.normalize('NFKC').toLocaleLowerCase('en').replace(/[’‘`]/g, "'").replace(/\./g, '')
            .replace(/\s+/g, ' ').trim();
    }

    const isBridge = tags => !!tags && tags.bridge != null && tags.bridge !== 'no';
    const isRoad = way => ROAD_CLASSES.has(way.highway);
    // A way the street can be made of: a road class, named. A named service road is a street too.
    const streetWay = way => isRoad(way) && !!normaliseName(way.name);
    const branchWay = way => isRoad(way) && (way.highway !== 'service' || !!normaliseName(way.name));

    function widthOf(tags) {
        const raw = tags && tags.width != null ? String(tags.width).trim().replace(',', '.') : '';
        const match = raw.match(/^(\d+(?:\.\d+)?)\s*(m|meter|metres|meters)?$/i);
        return match ? Number(match[1]) : null;
    }

    /**
     * /osm-road features (or Overpass `out geom` ways) → { id, name, highway, railway, tags, coords }.
     * Ways without a usable line are dropped; each OSM id appears once.
     */
    function normaliseWays(input) {
        const out = [], seen = new Set();
        for (const item of Array.isArray(input) ? input : []) {
            if (!item) continue;
            let id, tags, coords;
            if (item.type === 'Feature') {
                const p = item.properties || {};
                id = p.osm_id ?? item.id;
                tags = { ...(p.tags || {}) };
                if (p.highway_type && !tags.highway) tags.highway = p.highway_type;
                if (p.railway_type && !tags.railway) tags.railway = p.railway_type;
                if (p.name && !tags.name) tags.name = p.name;
                coords = item.geometry && item.geometry.type === 'LineString' ? item.geometry.coordinates : null;
            } else if (item.type === 'way') {
                id = item.id; tags = { ...(item.tags || {}) };
                coords = Array.isArray(item.geometry) ? item.geometry.map(point => [point.lon, point.lat]) : null;
            } else continue;
            id = id == null ? '' : String(id).replace(/^w/, '');
            if (!id || seen.has(id) || !Array.isArray(coords)) continue;
            coords = coords.filter(c => Array.isArray(c) && finite(c[0]) && finite(c[1]));
            if (coords.length < 2) continue;
            seen.add(id);
            out.push({ id, name: tags.name || null, highway: tags.highway || null, railway: tags.railway || null, tags, coords });
        }
        return out;
    }

    // ── planar helpers ──────────────────────────────────────────────────────────────────────────
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const len = v => Math.hypot(v[0], v[1]);
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    function projectOnLine(points, cumul, p) {
        let best = { distance: Infinity, measure: 0, side: 0 };
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1], ab = sub(b, a), l2 = ab[0] * ab[0] + ab[1] * ab[1];
            const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
            const q = [a[0] + ab[0] * t, a[1] + ab[1] * t], d = len(sub(p, q));
            if (d < best.distance) best = { distance: d, measure: cumul[i] + t * Math.sqrt(l2), side: Math.sign(cross(ab, sub(p, a))) };
        }
        return best;
    }
    function cumulative(points) {
        const out = [0];
        for (let i = 1; i < points.length; i++) out.push(out[i - 1] + len(sub(points[i], points[i - 1])));
        return out;
    }
    function pointAt(points, cumul, measure) {
        const m = Math.max(0, Math.min(cumul[cumul.length - 1], measure));
        let i = 0;
        while (i < cumul.length - 2 && cumul[i + 1] < m) i++;
        const span = cumul[i + 1] - cumul[i], t = span ? (m - cumul[i]) / span : 0;
        return { point: [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t], edge: i };
    }
    function slice(points, cumul, from, to) {
        const out = [pointAt(points, cumul, from).point];
        for (let i = 0; i < points.length; i++) if (cumul[i] > from + 1e-6 && cumul[i] < to - 1e-6) out.push(points[i]);
        out.push(pointAt(points, cumul, to).point);
        return out;
    }
    // Where segment p→p2 crosses q→q2, as a share of p→p2, or null. `ends` also counts a crossing
    // at a vertex (a bridge drawn over a vertex of the street).
    function segmentsCross(p, p2, q, q2, ends = false) {
        const r = sub(p2, p), s = sub(q2, q), denom = cross(r, s);
        if (Math.abs(denom) < 1e-12) return null;
        const t = cross(sub(q, p), s) / denom, u = cross(sub(q, p), r) / denom;
        const e = ends ? -1e-9 : 1e-9;
        return t > e && t < 1 - e && u > e && u < 1 - e ? t : null;
    }
    function angleBetween(a, b) {
        const d = Math.abs(Math.atan2(cross(a, b), a[0] * b[0] + a[1] * b[1])) * 180 / Math.PI;
        return d;
    }

    // ── finding a street ───────────────────────────────────────────────────────────────────────

    /** The nearest named road way to a WGS84 point within maxDistanceM, or null: { wayId, name, distanceM }. */
    function streetAt(ways, point, { maxDistanceM = 30 } = {}) {
        const f = frame(point[0], point[1]);
        let best = null;
        for (const way of ways) {
            if (!streetWay(way)) continue;
            const pts = way.coords.map(f.toM), hit = projectOnLine(pts, cumulative(pts), [0, 0]);
            if (hit.distance <= maxDistanceM && (!best || hit.distance < best.distanceM)) best = { wayId: way.id, name: way.name, distanceM: Math.round(hit.distance * 10) / 10 };
        }
        return best;
    }

    /** The ways with a given name, or the ways of the street a seed way belongs to. */
    function streetWays(ways, { seedWayId = null, name = null } = {}) {
        const seed = seedWayId != null ? ways.find(way => way.id === String(seedWayId)) : null;
        const key = normaliseName(seed ? seed.name : name);
        if (!key) return [];
        const named = ways.filter(way => streetWay(way) && normaliseName(way.name) === key);
        if (!seed) return named;
        // Connected to the seed: a shared vertex, or ends within JOIN_M.
        const f = frame(seed.coords[0][0], seed.coords[0][1]);
        const keysOf = way => new Set(way.coords.map(c => `${c[0].toFixed(7)},${c[1].toFixed(7)}`));
        const keys = new Map(named.map(way => [way.id, keysOf(way)]));
        const endsOf = way => [way.coords[0], way.coords[way.coords.length - 1]].map(f.toM);
        const linked = (a, b) => {
            const ka = keys.get(a.id);
            for (const k of keys.get(b.id)) if (ka.has(k)) return true;
            return endsOf(a).some(p => endsOf(b).some(q => len(sub(p, q)) <= JOIN_M));
        };
        const inStreet = new Set([seed.id]), queue = [seed];
        while (queue.length) {
            const way = queue.shift();
            for (const other of named) if (!inStreet.has(other.id) && linked(way, other)) { inStreet.add(other.id); queue.push(other); }
        }
        return named.filter(way => inStreet.has(way.id));
    }

    // ── segmentation ───────────────────────────────────────────────────────────────────────────

    /**
     * Cut a street into segments.
     *   ways       every normalised way loaded around the street (for branchings and overpasses);
     *   street     the street's own ways (streetWays());
     *   buildings  GeoJSON Polygon/MultiPolygon features near the street (for gaps), or null when unknown;
     *   numbers    [{ number, street, point: [lng, lat] }] house numbers near it.
     * Returns { name, wayIds, lengthM, points, segments }. Each segment: { id, chain, fromM, toM,
     * lengthM, coordinates, wayIds, from, to, numbers }; each end: a referable point.
     */
    function segmentStreet({ ways = [], street = [], buildings = null, numbers = [] } = {}) {
        if (!street.length) fail('The street has no ways.');
        const name = street[0].name;
        const nameKey = normaliseName(name);
        const anchor = street[0].coords[0];
        const f = frame(anchor[0], anchor[1]);
        const keyOf = c => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
        const streetIds = new Set(street.map(way => way.id));

        // The street's graph: vertices by coordinate, edges between consecutive vertices of a way.
        const coordOf = new Map(), adjacency = new Map();
        const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
        const edges = new Map();
        for (const way of street) {
            for (let i = 0; i < way.coords.length - 1; i++) {
                const a = keyOf(way.coords[i]), b = keyOf(way.coords[i + 1]);
                if (a === b) continue;
                coordOf.set(a, way.coords[i]); coordOf.set(b, way.coords[i + 1]);
                const k = edgeKey(a, b);
                if (!edges.has(k)) edges.set(k, { a, b, wayId: way.id, bridge: isBridge(way.tags) });
                for (const [x, y] of [[a, b], [b, a]]) {
                    if (!adjacency.has(x)) adjacency.set(x, new Set());
                    adjacency.get(x).add(y);
                }
            }
        }
        // Other roads meeting the street at a shared vertex.
        const branchesAt = new Map();
        for (const way of ways) {
            if (streetIds.has(way.id) || !branchWay(way)) continue;
            for (const c of way.coords) {
                const k = keyOf(c);
                if (!adjacency.has(k)) continue;
                if (!branchesAt.has(k)) branchesAt.set(k, new Map());
                const label = way.name || null;
                branchesAt.get(k).set(label || `#${way.highway}`, { name: label, highway: way.highway });
            }
        }
        const degree = k => adjacency.get(k).size;
        const isBreak = k => degree(k) !== 2 || branchesAt.has(k);

        // Chains: maximal paths between break vertices (a loop without one is a chain of its own).
        const used = new Set(), chains = [];
        function walk(start, next) {
            const keys = [start];
            let prev = start, cur = next;
            used.add(edgeKey(start, next));
            keys.push(cur);
            while (!isBreak(cur) && cur !== start) {
                const step = [...adjacency.get(cur)].find(n => n !== prev && !used.has(edgeKey(cur, n)));
                if (!step) break;
                used.add(edgeKey(cur, step));
                prev = cur; cur = step; keys.push(cur);
            }
            return keys;
        }
        const starts = [...adjacency.keys()].filter(isBreak).sort();
        for (const k of starts) for (const n of [...adjacency.get(k)].sort()) if (!used.has(edgeKey(k, n))) chains.push(walk(k, n));
        for (const k of [...adjacency.keys()].sort()) for (const n of [...adjacency.get(k)].sort()) if (!used.has(edgeKey(k, n))) chains.push(walk(k, n));
        // A chain's direction does not depend on the walk: it runs west to east, or south to north
        // when it runs more north–south; chains are listed from the west.
        chains.forEach((keys, i) => {
            const a = f.toM(coordOf.get(keys[0])), b = f.toM(coordOf.get(keys[keys.length - 1]));
            const dx = b[0] - a[0], dy = b[1] - a[1];
            if (Math.abs(dx) >= Math.abs(dy) ? dx < 0 : dy < 0) chains[i] = keys.reverse();
        });
        const startOf = keys => coordOf.get(keys[0]);
        chains.sort((a, b) => startOf(a)[0] - startOf(b)[0] || startOf(a)[1] - startOf(b)[1] || a.length - b.length);

        // Buildings and house numbers in metres, once.
        const buildingRings = buildings == null ? null : buildings.flatMap(feature => {
            const g = feature && feature.geometry;
            const polys = !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
            return polys.map(rings => (rings[0] || []).map(f.toM));
        }).filter(ring => ring.length >= 3);
        const numberPoints = (numbers || []).filter(row => row && row.number && Array.isArray(row.point)
            && normaliseName(row.street) === nameKey).map(row => ({ number: String(row.number), p: f.toM(row.point) }));
        // Each house number belongs to the one chain it lies nearest (a corner house is not on both).
        const chainLines = chains.map(keys => { const pts = keys.map(k => f.toM(coordOf.get(k))); return { pts, cumul: cumulative(pts) }; });
        for (const row of numberPoints) {
            let best = null;
            chainLines.forEach(({ pts, cumul }, i) => {
                const hit = projectOnLine(pts, cumul, row.p);
                if (!best || hit.distance < best.hit.distance) best = { chain: i, hit };
            });
            row.chain = best && best.hit.distance <= NUMBER_REACH_M ? best.chain : -1;
            row.hit = best && best.hit;
        }
        const otherLines = ways.filter(way => !streetIds.has(way.id) && isBridge(way.tags) && (way.highway || way.railway))
            .map(way => ({ way, pts: way.coords.map(f.toM) }));

        const points = [], segments = [];
        // A vertex ending a chain: the street's end, or a branching (`names`: the other roads there;
        // `own`: the street itself branches).
        const endOf = k => {
            const branches = branchesAt.has(k) ? [...branchesAt.get(k).values()] : [];
            const names = [...new Set(branches.map(row => row.name).filter(Boolean))].sort();
            if (!branches.length && degree(k) < 3) return { kind: 'end' };
            return { kind: 'branch', ...(names.length ? { names } : {}), ...(degree(k) >= 3 ? { own: true } : {}) };
        };
        chains.forEach((keys, chainIndex) => {
            const ll = keys.map(k => coordOf.get(k)), pts = ll.map(f.toM), cumul = cumulative(pts);
            const total = cumul[cumul.length - 1];
            const wayOfEdge = keys.slice(1).map((k, i) => edges.get(edgeKey(keys[i], k)));
            const found = [];
            const loop = keys[0] === keys[keys.length - 1] && !isBreak(keys[0]);
            found.push({ m: 0, ...(loop ? { kind: 'end', loop: true } : endOf(keys[0])) });
            found.push({ m: total, ...(loop ? { kind: 'end', loop: true } : endOf(keys[keys.length - 1])) });
            // Bends at vertices, over BEND_BASELINE_M chords both sides; the sharpest within a baseline wins.
            const bends = [];
            for (let i = 1; i < pts.length - 1; i++) {
                const m = cumul[i];
                if (m < BEND_BASELINE_M || m > total - BEND_BASELINE_M) continue;
                const before = pointAt(pts, cumul, m - BEND_BASELINE_M).point, after = pointAt(pts, cumul, m + BEND_BASELINE_M).point;
                const turn = angleBetween(sub(pts[i], before), sub(after, pts[i]));
                if (turn >= BEND_DEGREES) bends.push({ m, turn });
            }
            bends.sort((a, b) => b.turn - a.turn);
            const keptBends = [];
            for (const bend of bends) if (!keptBends.some(other => Math.abs(other.m - bend.m) < BEND_BASELINE_M)) keptBends.push(bend);
            keptBends.forEach(bend => found.push({ m: bend.m, kind: 'bend', degrees: Math.round(bend.turn) }));
            // Bridges carrying the street, longer than BRIDGE_MIN_M.
            let run = null;
            const closeRun = end => {
                if (run && end - run.from > BRIDGE_MIN_M) {
                    if (run.from > 0) found.push({ m: run.from, kind: 'bridge-start' });
                    if (end < total) found.push({ m: end, kind: 'bridge-end' });
                }
                run = null;
            };
            wayOfEdge.forEach((edge, i) => {
                if (edge.bridge) { if (!run) run = { from: cumul[i] }; } else closeRun(cumul[i]);
            });
            closeRun(total);
            // Bridges over the street (no shared vertex), wider than BRIDGE_MIN_M.
            for (const { way, pts: other } of otherLines) {
                const width = widthOf(way.tags) ?? (way.railway ? DEFAULT_WIDTH_M.railway : DEFAULT_WIDTH_M[way.highway] ?? ROAD_DEFAULT_WIDTH_M);
                if (!(width > BRIDGE_MIN_M)) continue;
                for (let i = 0; i < pts.length - 1; i++) for (let j = 0; j < other.length - 1; j++) {
                    const t = segmentsCross(pts[i], pts[i + 1], other[j], other[j + 1], true);
                    if (t != null) found.push({ m: cumul[i] + t * (cumul[i + 1] - cumul[i]), kind: 'overpass', name: way.name || null, ...(way.railway ? { railway: true } : {}) });
                }
            }
            // Gaps over BUILDING_GAP_M between the buildings fronting the chain.
            if (buildingRings && buildingRings.length) {
                const spans = [];
                for (const ring of buildingRings) {
                    const hits = ring.map(p => projectOnLine(pts, cumul, p));
                    if (Math.min(...hits.map(h => h.distance)) > BUILDING_REACH_M) continue;
                    const measures = hits.filter(h => h.distance <= BUILDING_REACH_M * 1.5).map(h => h.measure);
                    spans.push([Math.min(...measures), Math.max(...measures)]);
                }
                spans.sort((a, b) => a[0] - b[0]);
                let end = null;
                for (const [from, to] of spans) {
                    if (end != null && from - end > BUILDING_GAP_M) {
                        found.push({ m: end, kind: 'gap-start' });
                        found.push({ m: from, kind: 'gap-end' });
                    }
                    end = end == null ? to : Math.max(end, to);
                }
            }
            // Referable points, structural first; nearby duplicates fold into the higher priority.
            found.sort((a, b) => a.m - b.m || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
            const cuts = [];
            for (const point of found) {
                const near = cuts.find(other => Math.abs(other.m - point.m) < MERGE_M);
                if (!near) { cuts.push(point); continue; }
                if (KIND_PRIORITY[point.kind] < KIND_PRIORITY[near.kind]) Object.assign(near, point, { m: near.m === 0 || near.m === total ? near.m : point.m });
            }
            cuts.sort((a, b) => a.m - b.m);
            const numbersHere = numberPoints.filter(row => row.chain === chainIndex).map(row => ({ row, hit: row.hit }))
                .map(({ row, hit }) => ({ m: hit.measure, kind: 'number', houseNumber: row.number, side: hit.side > 0 ? 'left' : 'right' }));
            const all = [...cuts, ...numbersHere].sort((a, b) => a.m - b.m);
            const register = point => {
                const out = { id: `p${points.length}`, chain: chainIndex, measureM: Math.round(point.m * 10) / 10, kind: point.kind,
                    point: f.toLL(pointAt(pts, cumul, point.m).point) };
                for (const key of ['names', 'own', 'loop', 'degrees', 'name', 'railway', 'houseNumber', 'side']) if (point[key] !== undefined && point[key] !== null) out[key] = point[key];
                points.push(out);
                return out;
            };
            const registered = new Map(all.map(point => [point, register(point)]));
            const ends = cuts.map(point => registered.get(point));
            for (let i = 0; i < ends.length - 1; i++) {
                const from = ends[i], to = ends[i + 1];
                if (cuts[i + 1].m - cuts[i].m < MERGE_M) continue;
                segments.push(describe(chainIndex, cuts[i].m, cuts[i + 1].m, from, to));
            }
            function describe(chain, fromM, toM, from, to) {
                const wayIds = [...new Set(wayOfEdge.filter((edge, i) => cumul[i + 1] > fromM + 1e-6 && cumul[i] < toM - 1e-6).map(edge => edge.wayId))].sort();
                const inside = numbersHere.filter(row => row.m >= fromM && row.m <= toM).sort((a, b) => a.m - b.m);
                return { id: `${chain}.${segments.length}`, chain, fromM: Math.round(fromM * 10) / 10, toM: Math.round(toM * 10) / 10,
                    lengthM: Math.round(toM - fromM), coordinates: slice(pts, cumul, fromM, toM).map(f.toLL), wayIds, from, to,
                    numbers: inside.map(row => ({ houseNumber: row.houseNumber, side: row.side, measureM: Math.round(row.m * 10) / 10 })) };
            }
            chains[chainIndex] = { keys, pts, cumul, describe };
        });
        const lengthM = Math.round(segments.reduce((sum, segment) => sum + segment.toM - segment.fromM, 0));
        const result = { name, wayIds: [...streetIds].sort(), lengthM, points, segments, buildingsKnown: buildingRings != null };
        // Between any two referable points on one chain (a house number to a branching, say).
        Object.defineProperty(result, 'between', { enumerable: false, value(fromId, toId) {
            const a = points.find(point => point.id === fromId), b = points.find(point => point.id === toId);
            if (!a || !b) fail('Choose two referable points of this street.');
            if (a.chain !== b.chain) fail('The two points are on different branches of the street; choose points on one stretch.');
            const [from, to] = a.measureM <= b.measureM ? [a, b] : [b, a];
            if (to.measureM - from.measureM < MERGE_M) fail('The two points are too close together.');
            return { ...chains[a.chain].describe(a.chain, from.measureM, to.measureM, from, to), id: `${from.id}-${to.id}` };
        } });
        return result;
    }

    // ── plots along a segment ──────────────────────────────────────────────────────────────────

    /**
     * The plots whose boundary runs along a line, by side. A perpendicular ray every PLOT_STEP_M
     * meets the first parcel boundary it crosses; parcels containing the centreline (the road's own
     * parcel, or ground a street crosses) and `transparent` ids (other road parcels) are looked
     * through. parcels: [{ id, geometry }] in WGS84. side: left | right | both.
     * Returns [{ id, side, frontageM }] in order along the line.
     */
    function plotsAlong({ coordinates, parcels = [], side = 'both', transparent = [], reachM = PLOT_REACH_M, stepM = PLOT_STEP_M, minFrontageM = MIN_FRONTAGE_M }) {
        if (!SIDES.includes(side)) fail('The side must be left, right or both.');
        if (!Array.isArray(coordinates) || coordinates.length < 2) fail('The segment has no line.');
        const f = frame(coordinates[0][0], coordinates[0][1]);
        const pts = coordinates.map(f.toM), cumul = cumulative(pts), total = cumul[cumul.length - 1];
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const box = [Math.min(...xs) - reachM, Math.min(...ys) - reachM, Math.max(...xs) + reachM, Math.max(...ys) + reachM];
        const skip = new Set(Array.from(transparent || [], String));
        const shapes = [];
        for (const parcel of parcels) {
            const g = parcel && parcel.geometry, id = parcel && parcel.id != null ? String(parcel.id) : '';
            if (!g || !id || skip.has(id)) continue;
            const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
            const rings = polys.flatMap(rings => rings).map(ring => ring.map(f.toM)).filter(ring => ring.length >= 3);
            if (!rings.length) continue;
            const all = rings.flat(), bx = [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))];
            if (bx[2] < box[0] || bx[0] > box[2] || bx[3] < box[1] || bx[1] > box[3]) continue;
            shapes.push({ id, polys: polys.map(rs => rs.map(ring => ring.map(f.toM))), rings, bx });
        }
        const inside = (polys, p) => polys.some(rs => {
            let isIn = false;
            rs.forEach((ring, index) => {
                let c = false;
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const a = ring[i], b = ring[j];
                    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
                }
                if (index === 0) isIn = c; else if (c) isIn = false;
            });
            return isIn;
        });
        const wanted = side === 'both' ? [1, -1] : side === 'left' ? [1] : [-1];
        const hits = new Map();
        for (let s = stepM / 2; s < total; s += stepM) {
            const { point: p, edge } = pointAt(pts, cumul, s);
            const t = sub(pts[edge + 1], pts[edge]), l = len(t);
            if (!l) continue;
            const normal = [-t[1] / l, t[0] / l];
            const around = shapes.filter(shape => p[0] >= shape.bx[0] - reachM && p[0] <= shape.bx[2] + reachM && p[1] >= shape.bx[1] - reachM && p[1] <= shape.bx[3] + reachM);
            const open = around.filter(shape => !inside(shape.polys, p));
            for (const sign of wanted) {
                const end = [p[0] + normal[0] * sign * reachM, p[1] + normal[1] * sign * reachM];
                let best = null;
                for (const shape of open) for (const ring of shape.rings) for (let i = 0; i < ring.length - 1; i++) {
                    const u = segmentsCross(p, end, ring[i], ring[i + 1]);
                    if (u != null && (!best || u < best.u)) best = { u, id: shape.id };
                }
                if (!best) continue;
                const key = `${best.id}|${sign}`;
                if (!hits.has(key)) hits.set(key, { id: best.id, side: sign > 0 ? 'left' : 'right', count: 0, first: s });
                hits.get(key).count += 1;
            }
        }
        const byId = new Map();
        for (const row of [...hits.values()].sort((a, b) => a.first - b.first)) {
            const frontageM = row.count * stepM;
            if (frontageM < minFrontageM) continue;
            const known = byId.get(row.id);
            if (known) { known.side = 'both'; known.frontageM += frontageM; } else byId.set(row.id, { id: row.id, side: row.side, frontageM, first: row.first });
        }
        return [...byId.values()].map(({ first, ...row }) => row);
    }

    // The compass word of each side of a line: the left normal of its overall direction.
    const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
    function sideCompass(coordinates) {
        const f = frame(coordinates[0][0], coordinates[0][1]);
        const d = sub(f.toM(coordinates[coordinates.length - 1]), f.toM(coordinates[0]));
        const bearing = (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360;
        const word = b => COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8];
        return { left: word(bearing - 90), right: word(bearing + 90) };
    }

    // ── the record a street vote keeps ─────────────────────────────────────────────────────────

    function endRecord(point) {
        const out = { kind: point.kind, point: [round7(point.point[0]), round7(point.point[1])] };
        if (Array.isArray(point.names) && point.names.length) out.names = point.names.slice(0, 8);
        if (point.name) out.name = point.name;
        if (point.houseNumber) out.houseNumber = point.houseNumber;
        return out;
    }
    /** The `consultation.voting.street` reference of a whole street or one segment of it, by side. */
    function reference(street, segment, side, official = null) {
        if (!SIDES.includes(side)) fail('The side must be left, right or both.');
        const out = { name: street.name, osmWayIds: (segment ? segment.wayIds : street.wayIds).slice().sort(), part: segment ? 'segment' : 'street', side };
        if (official) out.official = { scheme: official.scheme, id: String(official.id) };
        if (segment) { out.from = endRecord(segment.from); out.to = endRecord(segment.to); }
        return normaliseReference(out);
    }
    const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
    function normaliseEnd(raw) {
        if (!raw || typeof raw !== 'object' || Object.keys(raw).some(key => !['kind', 'point', 'names', 'name', 'houseNumber'].includes(key))
            || !KINDS.includes(raw.kind) || !Array.isArray(raw.point) || raw.point.length !== 2
            || !finite(raw.point[0]) || !finite(raw.point[1]) || Math.abs(raw.point[0]) > 180 || Math.abs(raw.point[1]) > 90) fail('A street end needs its kind and point.');
        const out = { kind: raw.kind, point: [round7(raw.point[0]), round7(raw.point[1])] };
        if (raw.names != null) {
            if (!Array.isArray(raw.names) || raw.names.length > 8 || raw.names.some(n => !text(n, 200))) fail('A street end names at most 8 roads.');
            out.names = [...raw.names];
        }
        if (raw.name != null) { if (!text(raw.name, 200)) fail('A street end name must be text.'); out.name = raw.name; }
        if (raw.houseNumber != null) { if (!text(raw.houseNumber, 20)) fail('A house number must be short text.'); out.houseNumber = raw.houseNumber; }
        return out;
    }
    /** Validate and canonicalise a street reference (strict keys); throws on anything else. */
    function normaliseReference(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The street reference must be an object.');
        const keys = Object.keys(raw);
        if (keys.some(key => !['name', 'official', 'osmWayIds', 'part', 'from', 'to', 'side'].includes(key))) fail('The street reference has unknown fields.');
        if (!text(raw.name, 200)) fail('The street needs its name.');
        if (!['street', 'segment'].includes(raw.part)) fail('The street reference covers a whole street or a segment.');
        if (!SIDES.includes(raw.side)) fail('The side must be left, right or both.');
        if (!Array.isArray(raw.osmWayIds) || !raw.osmWayIds.length || raw.osmWayIds.length > 500
            || raw.osmWayIds.some(id => typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id))) fail('The street reference lists its OSM way ids.');
        const out = { name: raw.name, osmWayIds: [...new Set(raw.osmWayIds)].sort(), part: raw.part, side: raw.side };
        if (raw.official != null) {
            if (!raw.official || typeof raw.official !== 'object' || Object.keys(raw.official).some(key => !['scheme', 'id'].includes(key))
                || !text(raw.official.scheme, 60) || !text(raw.official.id, 100)) fail('An official street reference needs its scheme and id.');
            out.official = { scheme: raw.official.scheme, id: raw.official.id };
        }
        if (raw.part === 'segment') {
            out.from = normaliseEnd(raw.from);
            out.to = normaliseEnd(raw.to);
        } else if (raw.from != null || raw.to != null) fail('A whole street has no ends to record.');
        return out;
    }

    /**
     * The lines of a recorded street reference, from a GET /streets/segments answer of that street:
     * every segment for a whole street; for a segment, the answer's segments between its two ends
     * (ends within MERGE_M of a referable point, along the chain they bound). Ends that are no
     * referable point of the answer (a house number) give the straight line between them, marked
     * `approximate`. Returns { lines: [[lng, lat]...][], approximate } or null when the answer is
     * another street.
     */
    function linesFor(reference, answer) {
        const segments = Array.isArray(answer?.segments) ? answer.segments : [];
        if (!segments.length || normaliseName(answer.street?.name) !== normaliseName(reference.name)) return null;
        if (reference.part === 'street') return { lines: segments.map(segment => segment.coordinates), approximate: false };
        const f = frame(reference.from.point[0], reference.from.point[1]);
        const near = (a, b) => { const [ax, ay] = f.toM(a), [bx, by] = f.toM(b); return Math.hypot(ax - bx, ay - by) <= MERGE_M; };
        const ends = [reference.from.point, reference.to.point];
        const endOf = segment => [segment.coordinates[0], segment.coordinates[segment.coordinates.length - 1]];
        // Walk from the segment starting at one end to the other end, through consecutive segments.
        for (const [start, goal] of [ends, [...ends].reverse()]) {
            let at = start;
            const used = new Set(), lines = [];
            for (let step = 0; step < segments.length; step++) {
                const next = segments.findIndex((segment, i) => !used.has(i) && near(endOf(segment)[0], at));
                const back = next < 0 ? segments.findIndex((segment, i) => !used.has(i) && near(endOf(segment)[1], at)) : -1;
                const index = next >= 0 ? next : back;
                if (index < 0) break;
                used.add(index);
                const coordinates = next >= 0 ? segments[index].coordinates : [...segments[index].coordinates].reverse();
                lines.push(coordinates);
                at = coordinates[coordinates.length - 1];
                if (near(at, goal)) return { lines, approximate: false };
                if (lines.length > 1 && segments.filter((segment, i) => !used.has(i) && (near(endOf(segment)[0], at) || near(endOf(segment)[1], at))).length > 1) break;
            }
        }
        return { lines: [[reference.from.point, reference.to.point]], approximate: true };
    }

    return Object.freeze({ ROAD_CLASSES, SIDES, KINDS, BEND_DEGREES, BEND_BASELINE_M, BUILDING_GAP_M, BRIDGE_MIN_M,
        normaliseName, normaliseWays, streetAt, streetWays, segmentStreet, plotsAlong, sideCompass, reference, normaliseReference, linesFor });
});
