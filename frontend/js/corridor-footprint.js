// The one construction path for a corridor's land (projections.md §3): centre line + cross-section →
// the footprint polygon the street takes. Built entirely in an explicit metric frame (metric-frame.js)
// and used by the browser for previews and by the server as the authority, so both get the same
// polygon from the same definition. Pure: turf, the frame module, corridor-profile's segment entries
// and corridor-levels' spans are its only dependencies, resolved from the browser globals or require()
// in node. Every failure THROWS — a partial footprint must never be built, let alone published.
//
// Recipe (ALGORITHM below names it; change the name when the recipe changes):
//   1. per piece (corridorRenderPieces: a stretch's body at its own width, and each transition
//      zone tapering linearly to its neighbour's width — corridor-transition.js), per acquiring
//      span (corridor-levels: fully underground stretches take nothing): a rectangle (a trapezoid
//      across a zone) per edge and a bevel wedge at every interior bend, unioned in order;
//   2. a wedge at every node where two pieces of ONE original stretch meet (a bend that a junction
//      split turned into two arm ends), so splitting never loses a sliver of footprint, and at every
//      two-arm node where two different stretches bend into each other (a road drawn in two strokes);
//   3. at every node where three or more arms meet, the land each kerb-return corner needs beyond
//      the straight edges (corridor-junction.js, road-editor.md decision 2) — a junction's corners
//      belong to the junction, so the land take has them too;
//   4. all metric coordinates snapped to SNAP_M before clipping; every output edge split into pieces of
//      at most DENSIFY_M, then the union back to WGS84 through the same frame. Densifying matters
//      because whoever reads the stored polygon (PostGIS, Leaflet, turf) treats each edge as a
//      straight line in lon/lat, while it was straight in the frame: an undivided 500 m edge bows
//      ~5 mm at 45° latitude; a 50 m one stays under 0.6 mm up to 85°.

(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorFootprint = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const ALGORITHM = 'corridor-footprint/3';
    const SNAP_M = 1e-4;
    const DENSIFY_M = 50;
    const NUDGE_M = 0.1; // a zero-length edge is nudged this far due east, deterministically
    const NODE_KEY_M = 1e-3;

    // A dependency from the browser global or, in node, require(). The global is either the function
    // itself (a classic script's top-level `function corridorSegmentEntries`) or a namespace holding
    // it (`window.__corridorLevels.acquiringSpans`); `pick` names the function in the namespace and in
    // the required module.
    function fromGlobalOrRequire(globalKey, modulePath, pick) {
        const found = global && global[globalKey];
        if (found) {
            if (!pick) return found;
            if (typeof found === 'function') return found;
            if (typeof found[pick] === 'function') return found[pick];
        }
        if (typeof require === 'function') {
            const loaded = require(modulePath);
            return pick ? loaded[pick] : loaded;
        }
        throw new Error(`corridor-footprint: ${globalKey} is not available`);
    }
    function turfLib() {
        if (global && global.turf && typeof global.turf.union === 'function') return global.turf;
        if (typeof require === 'function') {
            try { return require('@turf/turf'); } catch (_) { /* not resolvable from frontend/js */ }
            try { return require(require.resolve('@turf/turf', { paths: [process.cwd()] })); } catch (_) { /* fall through */ }
        }
        throw new Error('corridor-footprint: turf is not available');
    }
    const frames = () => fromGlobalOrRequire('__metricFrame', './metric-frame.js');
    const segmentEntries = definition => fromGlobalOrRequire('corridorSegmentEntries', './corridor-profile.js', 'corridorSegmentEntries')(definition);
    const profileWidth = profile => fromGlobalOrRequire('corridorProfileWidth', './corridor-profile.js', 'corridorProfileWidth')(profile);
    const acquiringSpans = points => fromGlobalOrRequire('__corridorLevels', './proposals/corridor-levels.js', 'acquiringSpans')(points);
    const junctionApi = () => fromGlobalOrRequire('__corridorJunction', './corridor-junction.js');
    const profileEdges = profile => fromGlobalOrRequire('corridorProfileEdges', './corridor-profile.js', 'corridorProfileEdges')(profile);
    const renderPieces = (entries, frame, options) => fromGlobalOrRequire('corridorRenderPieces', './corridor-profile.js', 'corridorRenderPieces')(entries, frame, options);

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const snap = value => Math.round(value / SNAP_M) * SNAP_M;
    const snapPoint = p => [snap(p[0]), snap(p[1])];

    // ---- planar pieces (metric [x, y]) ---------------------------------------------------------

    // One edge's piece: a rectangle at `width`, or a trapezoid when `widthEnd` differs (a
    // transition zone tapers linearly along its edges).
    function rectangle(a, b, width, widthEnd = width) {
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let length = Math.hypot(dx, dy);
        let end = b;
        if (length < 1e-3) { end = [a[0] + NUDGE_M, a[1]]; dx = NUDGE_M; dy = 0; length = NUDGE_M; }
        const nx = -dy / length;
        const ny = dx / length;
        const ha = width / 2;
        const hb = (finite(widthEnd) ? widthEnd : width) / 2;
        return [[a[0] + nx * ha, a[1] + ny * ha], [end[0] + nx * hb, end[1] + ny * hb], [end[0] - nx * hb, end[1] - ny * hb], [a[0] - nx * ha, a[1] - ny * ha], [a[0] + nx * ha, a[1] + ny * ha]];
    }

    // The bevel patch on the outer side of a bend: the triangle pA–pB–anchor whose only new boundary
    // is the bevel edge pA→pB; null when the bend is straight.
    function bendWedge(p0, pj, p1, width) {
        const v1 = [pj[0] - p0[0], pj[1] - p0[1]];
        const v2 = [p1[0] - pj[0], p1[1] - pj[1]];
        const len1 = Math.hypot(v1[0], v1[1]);
        const len2 = Math.hypot(v2[0], v2[1]);
        if (len1 < 1e-6 || len2 < 1e-6) return null;
        const u1 = [v1[0] / len1, v1[1] / len1];
        const u2 = [v2[0] / len2, v2[1] / len2];
        const cross = u1[0] * u2[1] - u1[1] * u2[0];
        const outerIsRight = cross > 0;
        const n1 = outerIsRight ? [u1[1], -u1[0]] : [-u1[1], u1[0]];
        const n2 = outerIsRight ? [u2[1], -u2[0]] : [-u2[1], u2[0]];
        const half = width / 2;
        const pA = [pj[0] + n1[0] * half, pj[1] + n1[1] * half];
        const pB = [pj[0] + n2[0] * half, pj[1] + n2[1] * half];
        const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
        const bisLen = Math.hypot(bisector[0], bisector[1]);
        if (bisLen < 1e-8) return null;
        const inward = [-bisector[0] / bisLen, -bisector[1] / bisLen];
        const anchor = [pj[0] + inward[0] * half * 0.25, pj[1] + inward[1] * half * 0.25];
        return [pA, pB, anchor, pA];
    }

    function unionFeatures(turf, accumulated, ring) {
        const piece = turf.polygon([ring.map(snapPoint)]);
        if (!accumulated) return piece;
        const attempts = [
            () => turf.union(accumulated, piece),
            () => turf.union(turf.cleanCoords(accumulated, { mutate: false }), turf.cleanCoords(piece, { mutate: false }))
        ];
        let lastError = null;
        for (const attempt of attempts) {
            try {
                const result = attempt();
                if (result && result.geometry && /Polygon/.test(result.geometry.type)) return result;
            } catch (error) {
                lastError = error;
            }
        }
        throw new Error(`corridor-footprint: union failed${lastError ? `: ${lastError.message}` : ''}`);
    }

    // Which ORIGINAL stretch a piece belongs to. splitCorridorSelfJunctions derives a split piece's id
    // as `${sourceId}~2`, `~3`… so everything before the first `~` names the stretch the pieces came
    // from — the thing that used to be one polyline.
    function baseStretchId(segmentId) {
        if (segmentId === null || segmentId === undefined) return null;
        const text = String(segmentId);
        const cut = text.indexOf('~');
        return cut === -1 ? text : text.slice(0, cut);
    }

    // The outer gap at a bend is filled by a bevel wedge, and the per-arm construction only adds one
    // at a vertex INTERIOR to a polyline. The moment topology splits a road at a junction, a bend that
    // was interior becomes the shared END of two arms — and the wedge would silently disappear, taking
    // a sliver of the footprint with it. That is not cosmetic: the corridor's take is its footprint,
    // so a lost sliver re-cuts the parcels underneath, and anything standing on ground that stops
    // being whole is swept off the map. (It bit a row-house proposal several junctions away from an
    // edited node.)
    //
    // A joint belongs to the NODE, not to whichever polyline happens to contain it, so it is rebuilt
    // here from the arms that meet — but ONLY between two pieces of the same original stretch. That
    // pair is precisely what used to be one polyline bending through an interior vertex, so restoring
    // its wedge restores the exact pre-split footprint and nothing else.
    //
    // Wedging every pair of arms at a node instead is wrong, and visibly so: at a T it fills the outer
    // corners between the branch and each half of the through road, which together pave a patch on
    // the FAR side of the through road — a phantom fourth arm, showing up as an extra strip of footway
    // sticking out of the junction. A junction's corners are junctionLandCorners' business below; the
    // wedge only owes the road its own continuity. A node with exactly TWO ends is a bend whatever
    // the stretch ids say (a road drawn in two strokes bends through it exactly as one polyline
    // would), so it is wedged too. The wider arm sets the wedge, so it always reaches the outer
    // corner that needs covering.
    function sharedNodeWedges(arms) {
        const key = p => `${Math.round(p[0] / NODE_KEY_M)},${Math.round(p[1] / NODE_KEY_M)}@${finite(p[2]) ? p[2] : 0}`;
        const byNode = new Map();
        const note = (node, neighbour, arm) => {
            if (!node || !neighbour) return;
            const k = key(node);
            if (!byNode.has(k)) byNode.set(k, { node, ends: [] });
            byNode.get(k).ends.push({ neighbour, width: arm.width, stretchId: arm.stretchId });
        };
        arms.forEach(arm => {
            note(arm.points[0], arm.points[1], arm);
            note(arm.points[arm.points.length - 1], arm.points[arm.points.length - 2], arm);
        });
        const wedges = [];
        [...byNode.keys()].sort().forEach(k => {
            const { node, ends } = byNode.get(k);
            const bend = ends.length === 2;
            for (let a = 0; a < ends.length - 1; a += 1) {
                for (let b = a + 1; b < ends.length; b += 1) {
                    if (!bend && (!ends[a].stretchId || ends[a].stretchId !== ends[b].stretchId)) continue;
                    const wedge = bendWedge(ends[a].neighbour, node, ends[b].neighbour, Math.max(ends[a].width || 0, ends[b].width || 0));
                    if (wedge) wedges.push(wedge);
                }
            }
        });
        return wedges;
    }

    // The land every junction corner needs: where three or more arms meet, corridor-junction.js
    // fits a kerb-return fillet between each pair of angular neighbours, and the footway wrapping
    // that fillet reaches past the two straight land edges by a corner piece. An arm knows its kerbs
    // and footways through `edges` (corridorProfileEdges); an arm given only a width has no footway,
    // so the whole fillet is land. `foreign` are the arms of OTHER records at nodes this corridor
    // shares with them ([{ point: [x,y,level], arms: [{ dir, edges, width }] }], from the definition's
    // stored junctions), so a branch takes the corner land of the junction it joins. Returns metric
    // rings to union.
    function junctionLandCorners(arms, foreign = []) {
        const api = junctionApi();
        const entries = arms.map(arm => ({ points: arm.points, width: arm.width, edges: arm.edges || null }));
        const rings = [];
        const nodes = api.collectNodes(entries, { minDegree: 1 });
        const byKey = new Map(nodes.map(node => [api.nodeKey(node.point), node]));
        const widthOnly = width => ({ total: width, carriagewayLeft: width / 2, carriagewayRight: -width / 2, outerLeft: 0, outerRight: 0 });
        const specs = new Map();
        nodes.forEach(node => specs.set(node, node.arms.map(arm => ({
            dir: arm.dir,
            reversed: arm.reversed,
            length: arm.length,
            edges: arm.entry.edges || widthOnly(arm.width)
        }))));
        (foreign || []).forEach(junction => {
            const node = byKey.get(api.nodeKey(junction.point));
            if (!node) return;
            (junction.arms || []).forEach(arm => {
                const length = Math.hypot(arm.dir[0], arm.dir[1]);
                if (!(length > 1e-9)) return;
                const dir = [arm.dir[0] / length, arm.dir[1] / length];
                // An arm this corridor already has in that direction is the same arm.
                if (specs.get(node).some(own => own.dir[0] * dir[0] + own.dir[1] * dir[1] > 0.9999)) return;
                specs.get(node).push({ dir, reversed: false, length: Infinity, edges: arm.edges || widthOnly(arm.width) });
            });
        });
        nodes.forEach(node => {
            const armSpecs = specs.get(node);
            if (armSpecs.length < 3) return;
            const junction = api.buildJunction(node.point, armSpecs, { crossings: false });
            if (junction) junction.land.forEach(ring => rings.push([...ring, ring[0]]));
        });
        return rings;
    }

    // A closed metric ring with every edge split into equal pieces no longer than maxM.
    function densifyRing(ring, maxM) {
        const out = [];
        for (let i = 0; i < ring.length - 1; i += 1) {
            const [x1, y1] = ring[i];
            const [x2, y2] = ring[i + 1];
            out.push([x1, y1]);
            const pieces = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / maxM);
            for (let k = 1; k < pieces; k += 1) out.push([x1 + (x2 - x1) * k / pieces, y1 + (y2 - y1) * k / pieces]);
        }
        out.push([ring[ring.length - 1][0], ring[ring.length - 1][1]]);
        return out;
    }

    // ---- the footprint -----------------------------------------------------------------------

    // corridorCenterlineOf silently drops a vertex it cannot read; here that is a refusal, because a
    // footprint built from a centre line missing a vertex is wrong without looking wrong.
    function assertFiniteCentreline(definition) {
        const raw = definition && ((Array.isArray(definition.points) && definition.points.length && definition.points) || definition.segments);
        const check = point => {
            if (Array.isArray(point)) { point.forEach(check); return; }
            if (!point || typeof point !== 'object') return;
            const lat = point.lat !== undefined ? point.lat : point[1];
            const lng = point.lng !== undefined ? point.lng : point[0];
            if (!finite(lat) || !finite(lng)) throw new Error('corridor-footprint: a centre-line point is not finite');
        };
        if (Array.isArray(raw)) raw.forEach(check);
    }

    // Every authored centre-line position of the definition, in order: what the anchor derives from.
    function centerlinePositions(definition) {
        assertFiniteCentreline(definition);
        const positions = [];
        segmentEntries(definition).forEach(entry => entry.points.forEach(p => positions.push([p.lng, p.lat])));
        if (!positions.length) throw new Error('corridor-footprint: the definition has no centre line');
        return positions;
    }

    // The footprint of a set of arms — [{ points: [{lat, lng}, …], width, stretchId?, edges? }] — in
    // `frame`, as GeoJSON (Polygon or MultiPolygon), or null when no arm has an edge. The recipe above
    // without a definition: what the drawing tool and the editor build their in-progress pieces with,
    // so a preview is constructed exactly like the land the server stores. `stretchId` is already the
    // BASE stretch id (baseStretchId); `edges` are the arm's kerb and footway numbers
    // (corridorProfileEdges) and decide how much land its junction corners take. Throws on a
    // non-finite point, a width that is not positive, a point outside the frame, or a failed union.
    function footprintOfArms(arms, frame, options = {}) {
        const turf = turfLib();
        let accumulated = null;
        const metricArms = [];
        // Junctions with other records, as the definition stores them, in this frame.
        const foreign = (Array.isArray(options.junctions) ? options.junctions : []).map(junction => {
            if (!junction || !finite(junction.lat) || !finite(junction.lng)) return null;
            const point = frame.toMetric([junction.lng, junction.lat]);
            const foreignArms = (junction.arms || []).map(arm => {
                if (!arm || !arm.toward || !finite(arm.toward.lat) || !finite(arm.toward.lng)) return null;
                const toward = frame.toMetric([arm.toward.lng, arm.toward.lat]);
                const edges = arm.profile ? profileEdges(arm.profile) : null;
                const width = edges ? edges.total : Number(arm.width);
                if (!finite(width) || width <= 0) return null;
                return { dir: [toward[0] - point[0], toward[1] - point[1]], edges, width };
            }).filter(Boolean);
            return foreignArms.length ? { point: [point[0], point[1], finite(junction.level) ? junction.level : 0], arms: foreignArms } : null;
        }).filter(Boolean);
        (Array.isArray(arms) ? arms : []).forEach(arm => {
            const width = Number(arm && arm.width);
            if (!finite(width) || width <= 0) throw new Error('corridor-footprint: an arm has no width');
            const points = Array.isArray(arm.points) ? arm.points : [];
            if (points.length < 2) return;
            const metric = points.map(p => {
                if (!p || !finite(p.lat) || !finite(p.lng)) throw new Error('corridor-footprint: a centre-line point is not finite');
                const xy = frame.toMetric([p.lng, p.lat]);
                return [xy[0], xy[1], finite(p.level) ? p.level : 0];
            });
            // Per-vertex widths (a zone) or the one width everywhere.
            const widths = Array.isArray(arm.widths) && arm.widths.length === metric.length && arm.widths.every(w => finite(w) && w > 0)
                ? arm.widths
                : metric.map(() => width);
            for (let i = 0; i < metric.length - 1; i += 1) {
                accumulated = unionFeatures(turf, accumulated, rectangle(metric[i], metric[i + 1], widths[i], widths[i + 1]));
                if (i >= 1) {
                    const wedge = bendWedge(metric[i - 1], metric[i], metric[i + 1], widths[i]);
                    if (wedge) accumulated = unionFeatures(turf, accumulated, wedge);
                }
            }
            metricArms.push({ points: metric, width: Math.max(...widths), stretchId: arm.stretchId === undefined ? null : arm.stretchId, edges: arm.edges || null });
        });
        if (!accumulated) return null;
        sharedNodeWedges(metricArms).forEach(wedge => { accumulated = unionFeatures(turf, accumulated, wedge); });
        junctionLandCorners(metricArms, foreign).forEach(corner => { accumulated = unionFeatures(turf, accumulated, corner); });

        const geometry = accumulated.geometry;
        const toLngLatRing = ring => densifyRing(ring, DENSIFY_M).map(xy => frame.toLngLat(xy));
        if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map(toLngLatRing) };
        return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(rings => rings.map(toLngLatRing)) };
    }

    // The footprint of `definition` in `frame`, as GeoJSON (Polygon, or MultiPolygon when tunnels
    // split it). Throws on any point outside the frame, any non-finite input, or a failed union.
    function footprintIn(definition, frame, options = {}) {
        const entries = segmentEntries(definition);
        if (!entries.length) throw new Error('corridor-footprint: the definition has no centre line');
        entries.forEach(entry => {
            // corridorSegmentEntries falls back to 10 m when neither a profile nor `width` says
            // anything; a footprint must not be built from a width nobody declared.
            const declared = profileWidth(entry.profile) || Number(definition.width);
            if (!finite(declared) || declared <= 0) throw new Error(`corridor-footprint: segment ${entry.segmentId ?? ''} has no width`);
            const width = Number(entry.width);
            if (!finite(width) || width <= 0) throw new Error(`corridor-footprint: segment ${entry.segmentId ?? ''} has no width`);
        });
        const arms = [];
        // Transition zones are derived from the stretches' own profiles in this same frame, so the
        // land tapers exactly where the strips do.
        renderPieces(entries, frame, { transitions: options.transitions !== false, junctions: definition.junctions }).forEach(piece => {
            const edges = piece.profile ? profileEdges(piece.profile) : null;
            const widthAt = piece.taper
                ? (() => {
                    const metric = piece.points.map(p => frame.toMetric([p.lng, p.lat]));
                    const stations = [0];
                    for (let i = 1; i < metric.length; i += 1) stations.push(stations[i - 1] + Math.hypot(metric[i][0] - metric[i - 1][0], metric[i][1] - metric[i - 1][1]));
                    const total = stations[stations.length - 1] || 1;
                    return point => {
                        const index = piece.points.indexOf(point);
                        const s = index >= 0 ? stations[index] / total : 0;
                        return piece.taper.widthStart + (piece.taper.widthEnd - piece.taper.widthStart) * s;
                    };
                })()
                : null;
            acquiringSpans(piece.points).forEach(span => {
                if (span.length < 2) return;
                arms.push({
                    points: span,
                    width: Number(piece.width),
                    widths: widthAt ? span.map(point => widthAt(point)) : null,
                    stretchId: baseStretchId(piece.segmentId),
                    edges
                });
            });
        });
        const polygon = footprintOfArms(arms, frame, { junctions: definition.junctions });
        if (!polygon) throw new Error('corridor-footprint: nothing acquires the surface (every edge is underground)');
        return polygon;
    }

    // The frame a corridor is built, edited and drawn in: its persisted provenance (a prepared or
    // published corridor), else the canonical frame of its own authored centre line — the frame the
    // server would materialise it in. Never a city's projection, never the viewport.
    function frameForDefinition(definition) {
        const api = frames();
        const provenance = definition && definition.constructionFrame;
        if (provenance && provenance.kind === api.CONTRACT.KIND) return api.frameFromProvenance(provenance);
        return api.frameFor(centerlinePositions(definition));
    }

    // The geodesic diameter bound of a footprint, conservatively: its metric bbox diagonal.
    function diameterIn(polygon, frame) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const visit = ring => ring.forEach(position => {
            const [x, y] = frame.toMetric(position);
            if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        });
        (polygon.type === 'Polygon' ? [polygon.coordinates] : polygon.coordinates).forEach(rings => rings.forEach(visit));
        return Math.hypot(maxX - minX, maxY - minY);
    }

    function versions() {
        const out = {};
        if (typeof require === 'function') {
            try { out.turf = require(require.resolve('@turf/turf/package.json', { paths: [process.cwd()] })).version; } catch (_) { /* browser bundle */ }
        }
        return out;
    }

    /**
     * The canonical materialisation of a corridor: its footprint and the provenance that reproduces
     * it. `options.frame` reuses a frame (an edit session, a server re-derivation from stored
     * provenance); otherwise the frame is anchored on the definition's own centre line.
     * @returns {{ polygon, constructionFrame: { kind, anchor, proj, proj4, algorithm, turf? } }}
     */
    function materialize(definition, options = {}) {
        const api = frames();
        const frame = options.frame || api.frameFor(centerlinePositions(definition));
        // `options.transitions === false` builds the stepped land without transition zones: a
        // diagnostic for comparing against land built before zones existed, never a stored recipe.
        const polygon = footprintIn(definition, frame, { transitions: options.transitions !== false });
        const diameter = diameterIn(polygon, frame);
        if (diameter > api.CONTRACT.MAX_FOOTPRINT_DIAMETER_M) {
            throw new Error(`corridor-footprint: footprint spans ${Math.round(diameter)} m, more than the ${api.CONTRACT.MAX_FOOTPRINT_DIAMETER_M} m allowed`);
        }
        return { polygon, constructionFrame: { ...frame.provenance(), algorithm: ALGORITHM, ...versions() } };
    }

    return Object.freeze({ ALGORITHM, SNAP_M, DENSIFY_M, rectangle, bendWedge, sharedNodeWedges, junctionLandCorners, densifyRing, baseStretchId, centerlinePositions, footprintOfArms, footprintIn, frameForDefinition, materialize });
});
