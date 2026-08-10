// Pure road/corridor geometry, lifted out of road-drawing.js so it can be unit-tested headless.
// Everything here is plain math over {lat,lng} points and HTRS96 metres — the only couplings are
// the projection functions (wgs84ToHTRS96 / htrs96ToWGS84) and Leaflet's L.latLng factory, both of
// which are resolved from injected deps (node tests) or the browser globals. No map, no DOM.
//
// This module starts with createRectangularRoadSegment because it carried a live bug: the
// degenerate near-zero-length branch picked its direction with Math.random(), so two clicks in the
// same spot produced a different saved polygon — and a different geometryHash — on every run.
// proposal-manager.js had a second, DIVERGED copy that returned null in that case instead. One
// deterministic copy ends both problems.

(function (global) {
    'use strict';

    function resolveDep(deps, name) {
        if (deps && typeof deps[name] === 'function') return deps[name];
        if (typeof global[name] === 'function') return global[name];
        return null;
    }

    function makeLatLng(deps, lat, lng) {
        if (deps && typeof deps.latLng === 'function') return deps.latLng(lat, lng);
        if (global.L && typeof global.L.latLng === 'function') return global.L.latLng(lat, lng);
        return { lat, lng };
    }

    function isValidHtrsPoint(point) {
        return Array.isArray(point) && point.length === 2 && isFinite(point[0]) && isFinite(point[1]);
    }

    // Build the WGS84 corner ring of a width-wide rectangle running from point1 to point2.
    // Returns an array of latLng corners (closed ring) or null if the inputs can't form one.
    // deps (optional): { wgs84ToHTRS96, htrs96ToWGS84, latLng } — defaults to the browser globals.
    function createRectangularRoadSegment(point1, point2, width, deps = {}) {
        const wgs84ToHTRS96 = resolveDep(deps, 'wgs84ToHTRS96');
        const htrs96ToWGS84 = resolveDep(deps, 'htrs96ToWGS84');
        if (!wgs84ToHTRS96 || !htrs96ToWGS84) {
            console.warn('createRectangularRoadSegment: projection functions unavailable');
            return null;
        }

        if (!point1 || !point2 || !isFinite(width) || width <= 0) {
            console.warn('Invalid inputs to createRectangularRoadSegment');
            return null;
        }
        if (!isFinite(point1.lat) || !isFinite(point1.lng) ||
            !isFinite(point2.lat) || !isFinite(point2.lng)) {
            console.warn('Invalid coordinates in createRectangularRoadSegment');
            return null;
        }

        const htrsPoint1 = wgs84ToHTRS96(point1.lat, point1.lng);
        let htrsPoint2 = wgs84ToHTRS96(point2.lat, point2.lng);
        if (!isValidHtrsPoint(htrsPoint1) || !isValidHtrsPoint(htrsPoint2)) {
            console.warn('Invalid HTRS points in createRectangularRoadSegment');
            return null;
        }

        let dx = htrsPoint2[0] - htrsPoint1[0];
        let dy = htrsPoint2[1] - htrsPoint1[1];
        let length = Math.sqrt(dx * dx + dy * dy);

        // Near-zero-length: nudge the far point a fixed 10 cm DUE EAST so the rectangle is still
        // well-formed. Deterministic on purpose — this was Math.random() and made the footprint
        // (and its geometryHash) irreproducible for coincident clicks.
        if (length < 0.001) {
            const minLength = 0.1; // 10 cm
            htrsPoint2 = [htrsPoint1[0] + minLength, htrsPoint1[1]];
            dx = minLength;
            dy = 0;
            length = minLength;
        }

        const perpX = -dy / length;
        const perpY = dx / length;
        const halfWidth = width / 2;

        const corners = [
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth],
            [htrsPoint2[0] + perpX * halfWidth, htrsPoint2[1] + perpY * halfWidth],
            [htrsPoint2[0] - perpX * halfWidth, htrsPoint2[1] - perpY * halfWidth],
            [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth],
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]
        ];

        const wgsCorners = [];
        for (const corner of corners) {
            const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
            if (isFinite(lat) && isFinite(lng)) {
                wgsCorners.push(makeLatLng(deps, lat, lng));
            }
        }

        if (wgsCorners.length < 4) {
            console.warn('Not enough valid corners for rectangle');
            return null;
        }
        return wgsCorners;
    }

    // ---- Centerline graph geometry (moved out of road-drawing.js) ----------------------------
    // These operate on {lat,lng} centerline segments. External deps (corridorTunnelEdgeKey,
    // calculateSegmentLengthMeters, wgs84ToHTRS96) are resolved from the global scope at call time
    // and every reference is typeof-guarded or try/caught, so the pure geometry is testable alone.

    function planarSegmentIntersection(a1, a2, b1, b2) {
        const d1x = a2.lng - a1.lng;
        const d1y = a2.lat - a1.lat;
        const d2x = b2.lng - b1.lng;
        const d2y = b2.lat - b1.lat;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-18) return null;
        const t = ((b1.lng - a1.lng) * d2y - (b1.lat - a1.lat) * d2x) / denom;
        const u = ((b1.lng - a1.lng) * d1y - (b1.lat - a1.lat) * d1x) / denom;
        if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
        return { lat: a1.lat + t * d1y, lng: a1.lng + t * d1x };
    }

    // Wherever two centerline edges cross, both get a vertex at the crossing point. Edges in the
    // SAME polyline must be compared too: a five-point star drawn in one stroke is one array, but its
    // crossings are just as real as crossings between separate strokes. The old i+1 loop silently
    // skipped that whole class of junctions, leaving one self-crossing strip that 3D could not mesh.
    function insertCorridorCrossingNodes(segments, segmentIds, protectedEdgeKeys = null) {
        const EPS = 1e-7;
        const near = (p, q) => p && q && Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;
        // Tunnel records are keyed by their exact edge — inserting a vertex into a tunnelled edge
        // would orphan the record (the stretch silently reverts to surface). Callers pass those keys.
        const isProtectedEdge = (p, q) => {
            if (!protectedEdgeKeys || !protectedEdgeKeys.size || typeof corridorTunnelEdgeKey !== 'function') return false;
            const key = corridorTunnelEdgeKey(p, q);
            return !!key && protectedEdgeKeys.has(key);
        };
        // The level a stretch runs at (corridor-elevation.md): 0 unless its points say otherwise.
        // A RAMP — a stretch whose two ends sit at different levels — has no single level, and a
        // vertex dropped into the middle of one would have to invent the level it sits at, so a ramp
        // is never noded at all. Two flat stretches meet only when they are on the same level;
        // otherwise one runs over or under the other, which is a grade separation, not a junction.
        const levelOf = point => (point && typeof point.level === 'number' && Number.isFinite(point.level)) ? point.level : 0;
        const flatLevelOf = (p, q) => {
            const a = levelOf(p);
            const b = levelOf(q);
            return a === b ? a : null;
        };
        // Where a crossing point sits along an edge, 0 at its start and 1 at its end — the order the
        // insertions have to go in when one edge is crossed more than once.
        const paramOn = (a, b, p) => {
            const dx = b.lng - a.lng;
            const dy = b.lat - a.lat;
            const lengthSq = dx * dx + dy * dy;
            if (lengthSq < 1e-24) return 0;
            return ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / lengthSq;
        };

        // Collect every crossing in ONE sweep, then splice. This used to restart the whole scan after
        // each single insertion, capped at 200 restarts — which is O(edges² × crossings) and, worse,
        // silently STOPS at the 200th junction. A town's road network has more than that, and the
        // ones past the cap would have been left unnoded with no error anywhere. Splicing changes
        // only how the same locus is written down, never where it runs, so no insertion can create a
        // crossing another insertion would have to find: one sweep sees them all.
        const pending = segments.map(() => new Map());
        const note = (segIndex, edgeIndex, point, t, level) => {
            const edges = pending[segIndex];
            if (!edges.has(edgeIndex)) edges.set(edgeIndex, []);
            edges.get(edgeIndex).push({ point, t, level });
        };

        for (let i = 0; i < segments.length; i += 1) {
            for (let j = i; j < segments.length; j += 1) {
                const A = segments[i];
                const B = segments[j];
                if (!Array.isArray(A) || !Array.isArray(B)) continue;
                for (let ai = 0; ai < A.length - 1; ai += 1) {
                    // Within one polyline, adjacent edges already share their ordinary vertex.
                    // Start two edges later and also skip the first/last pair of a closed loop:
                    // those are neighbours across the array seam, not a self-intersection.
                    const firstBi = i === j ? ai + 2 : 0;
                    for (let bi = firstBi; bi < B.length - 1; bi += 1) {
                        if (i === j && ai === 0 && bi === B.length - 2 && near(B[0], B[B.length - 1])) {
                            continue;
                        }
                        const x = planarSegmentIntersection(A[ai], A[ai + 1], B[bi], B[bi + 1]);
                        if (!x) continue;
                        // A grade separation is the sanctioned way for two stretches to cross
                        // WITHOUT meeting. Neither side gets a node then — noding only the
                        // unprotected side (what this used to do) left a stray vertex under the
                        // bridge, which the junction renderer reads as a T-joint.
                        if (isProtectedEdge(A[ai], A[ai + 1]) || isProtectedEdge(B[bi], B[bi + 1])) continue;
                        const level = flatLevelOf(A[ai], A[ai + 1]);
                        if (level === null || level !== flatLevelOf(B[bi], B[bi + 1])) continue;
                        // Inserting the crossing vertex does NOT change what the segment IS — the id
                        // must survive, because per-segment cross-section overrides are keyed by it.
                        // Nulling it here would orphan a seeded segment's profile at the junction step.
                        if (!near(x, A[ai]) && !near(x, A[ai + 1])) note(i, ai, x, paramOn(A[ai], A[ai + 1], x), level);
                        if (!near(x, B[bi]) && !near(x, B[bi + 1])) note(j, bi, x, paramOn(B[bi], B[bi + 1], x), level);
                    }
                }
            }
        }

        pending.forEach((edges, segIndex) => {
            const segment = segments[segIndex];
            if (!edges.size || !Array.isArray(segment)) return;
            // Later edges first, so an earlier edge's index cannot move underneath the next splice.
            [...edges.keys()].sort((a, b) => b - a).forEach(edgeIndex => {
                const kept = [];
                edges.get(edgeIndex)
                    .slice()
                    .sort((p, q) => p.t - q.t)
                    .forEach(candidate => {
                        // Two roads meeting the same edge at the same spot are ONE node, not two.
                        if (kept.some(existing => near(existing, candidate.point))) return;
                        // A node on a stretch that runs below or above the surface belongs to that
                        // level, exactly like the vertices it sits between.
                        kept.push(candidate.level
                            ? { lat: candidate.point.lat, lng: candidate.point.lng, level: candidate.level }
                            : { lat: candidate.point.lat, lng: candidate.point.lng });
                    });
                if (kept.length) segment.splice(edgeIndex + 1, 0, ...kept);
            });
        });
    }

    const CORRIDOR_NODE_EPS = 1e-7;

    function corridorNodeKey(point) {
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return '';
        return `${Math.round(point.lat / CORRIDOR_NODE_EPS)},${Math.round(point.lng / CORRIDOR_NODE_EPS)}`;
    }

    function corridorPointsNear(a, b) {
        return !!a && !!b
            && Math.abs(a.lat - b.lat) < CORRIDOR_NODE_EPS
            && Math.abs(a.lng - b.lng) < CORRIDOR_NODE_EPS;
    }

    function corridorPieceHasLength(points) {
        if (!Array.isArray(points) || points.length < 2) return false;
        return points.slice(1).some(point => !corridorPointsNear(point, points[0]));
    }

    // Split every polyline at its graph junctions so each stretch between junctions is its own
    // segment — a real node the editor can grab and an arm whose cross-section edits independently.
    // Two kinds of junction split here:
    //   • self-crossing — one polyline passes through the same vertex twice (a star/loop); and
    //   • shared node — a vertex a through-road carries in its INTERIOR that another polyline also
    //     touches (a T where one road's endpoint meets another's mid-span, or an X crossing). Without
    //     this the through-road stayed one segment across the junction, so its two arms shared an id
    //     and were width-edited together. (The name is historical — it now splits at all junctions,
    //     not only self ones.) Splitting is topology-only: every vertex and edge stays where it was.
    // Only INTERIOR occurrences split; a shared node that is already a polyline endpoint is a segment
    // boundary already, so the pass is convergent (re-running it changes nothing).
    //
    // `segmentProfiles` is mutated deliberately. A split stretch gets a stable derived id and a clone
    // of the source override, so graph normalization cannot repaint part of a mixed-width network.
    //
    // `externalNodeKeys` carries the node keys of corridors OUTSIDE this set — a road belonging to
    // another proposal. Its node counts here exactly as a node of a second polyline in this set
    // does, so a through-road splits at a T made by someone else's road just as it does at one made
    // by its own branch. Without it, a network-wide noding pass would leave every cross-record
    // junction sitting mid-segment, un-grabbable and width-edited as one arm.
    function splitCorridorSelfJunctions(segments, segmentIds, segmentProfiles = null, externalNodeKeys = null) {
        if (!Array.isArray(segments)) return { segments: [], segmentIds: [] };
        const ids = Array.isArray(segmentIds) ? segmentIds : [];
        const usedIds = new Set(ids.filter(id => id !== null && id !== undefined).map(String));
        const outSegments = [];
        const outIds = [];

        const cloneProfile = (sourceId, targetId) => {
            if (!segmentProfiles || sourceId === null || sourceId === undefined || targetId === null || targetId === undefined) return;
            const source = segmentProfiles[String(sourceId)];
            if (!source) return;
            try { segmentProfiles[String(targetId)] = JSON.parse(JSON.stringify(source)); }
            catch (_) { segmentProfiles[String(targetId)] = source; }
        };
        const derivedId = (sourceId, partNumber) => {
            const base = sourceId !== null && sourceId !== undefined && String(sourceId)
                ? `${String(sourceId)}~${partNumber}`
                : `split~${partNumber}`;
            let candidate = base;
            let suffix = 2;
            while (usedIds.has(candidate)) candidate = `${base}~${suffix++}`;
            usedIds.add(candidate);
            return candidate;
        };

        const appendPieces = (pieces, sourceId) => {
            let partNumber = 1;
            pieces.filter(corridorPieceHasLength).forEach(piece => {
                const id = partNumber === 1 ? (sourceId ?? null) : derivedId(sourceId, partNumber);
                if (partNumber > 1) cloneProfile(sourceId, id);
                outSegments.push(piece);
                outIds.push(id);
                partNumber += 1;
            });
        };

        // A node key that appears in two or more DISTINCT polylines is a cross-polyline junction (T or
        // X). Count the distinct polylines each key touches once, up front, so the per-polyline walk
        // below can split a through-road where another road meets its mid-span — not only at a
        // polyline's own self-crossings. (Repeats within one polyline are still caught per-segment.)
        const crossPolylineKeys = new Set(
            (externalNodeKeys && typeof externalNodeKeys.forEach === 'function') ? externalNodeKeys : []
        );
        {
            const keyToSegments = new Map();
            segments.forEach((rawSegment, segmentIndex) => {
                if (!Array.isArray(rawSegment) || rawSegment.length < 2) return;
                const closed = rawSegment.length > 2 && corridorPointsNear(rawSegment[0], rawSegment[rawSegment.length - 1]);
                const seenHere = new Set();
                (closed ? rawSegment.slice(0, -1) : rawSegment).forEach(point => {
                    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
                    const key = corridorNodeKey(point);
                    if (!key || seenHere.has(key)) return;
                    seenHere.add(key);
                    if (!keyToSegments.has(key)) keyToSegments.set(key, new Set());
                    keyToSegments.get(key).add(segmentIndex);
                });
            });
            keyToSegments.forEach((segIndexes, key) => { if (segIndexes.size > 1) crossPolylineKeys.add(key); });
        }

        segments.forEach((rawSegment, segmentIndex) => {
            if (!Array.isArray(rawSegment) || rawSegment.length < 2) return;
            const sourceId = ids[segmentIndex] ?? null;
            const closed = rawSegment.length > 2 && corridorPointsNear(rawSegment[0], rawSegment[rawSegment.length - 1]);
            const base = (closed ? rawSegment.slice(0, -1) : rawSegment.slice())
                .filter(point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
            if (base.length < 2) return;

            const occurrences = new Map();
            const representatives = new Map();
            base.forEach((point, index) => {
                const key = corridorNodeKey(point);
                if (!key) return;
                if (!occurrences.has(key)) occurrences.set(key, []);
                occurrences.get(key).push(index);
                if (!representatives.has(key)) representatives.set(key, point);
            });
            const junctionKeys = new Set(
                [...occurrences.entries()]
                    .filter(([key, indexes]) => indexes.length > 1 || crossPolylineKeys.has(key))
                    .map(([key]) => key)
            );

            // A simple closed loop repeats only its seam in rawSegment; it was removed from `base`,
            // so no junction key remains and the established annulus representation stays intact.
            if (!junctionKeys.size) {
                outSegments.push(rawSegment);
                outIds.push(sourceId);
                return;
            }

            // Every occurrence of one graph node must be byte-for-byte identical. This also heals
            // old near-equal vertices (within the same 1e-7 tolerance every consumer already uses).
            const normalized = base.map(point => {
                const representative = representatives.get(corridorNodeKey(point)) || point;
                const healed = { lat: representative.lat, lng: representative.lng };
                // The vertical profile rides on the point (corridor-elevation.md), and the
                // representative is only a canonical POSITION. Rebuilding a bare {lat,lng} here
                // returned an underground stretch to the surface — and a surfaced tunnel starts
                // taking land again. Where a level was recorded, it survives the split.
                const level = (typeof point.level === 'number' && Number.isFinite(point.level))
                    ? point.level
                    : ((typeof representative.level === 'number' && Number.isFinite(representative.level))
                        ? representative.level
                        : null);
                if (level !== null) healed.level = level;
                return healed;
            });
            const pieces = [];

            if (closed) {
                const startIndex = normalized.findIndex(point => junctionKeys.has(corridorNodeKey(point)));
                const rotated = normalized.slice(startIndex).concat(normalized.slice(0, startIndex));
                rotated.push({ ...rotated[0] });
                let piece = [rotated[0]];
                for (let index = 1; index < rotated.length; index += 1) {
                    const point = rotated[index];
                    piece.push(point);
                    if (junctionKeys.has(corridorNodeKey(point))) {
                        if (corridorPieceHasLength(piece)) pieces.push(piece);
                        piece = [point];
                    }
                }
            } else {
                let piece = [normalized[0]];
                for (let index = 1; index < normalized.length; index += 1) {
                    const point = normalized[index];
                    piece.push(point);
                    if (junctionKeys.has(corridorNodeKey(point))) {
                        if (corridorPieceHasLength(piece)) pieces.push(piece);
                        piece = [point];
                    }
                }
                if (corridorPieceHasLength(piece)) pieces.push(piece);
            }

            appendPieces(pieces, sourceId);
        });

        segments.splice(0, segments.length, ...outSegments);
        if (Array.isArray(segmentIds)) segmentIds.splice(0, segmentIds.length, ...outIds);
        return { segments, segmentIds: Array.isArray(segmentIds) ? segmentIds : outIds };
    }

    // The one canonical topology boundary for a corridor centerline. Geometry enters as user/import
    // strokes and leaves as a graph suitable for node editing, junction detection, and 3D meshing.
    function normalizeCorridorGraph(segments, segmentIds, protectedEdgeKeys = null, segmentProfiles = null) {
        insertCorridorCrossingNodes(segments, segmentIds, protectedEdgeKeys);
        return splitCorridorSelfJunctions(segments, segmentIds, segmentProfiles);
    }

    // The same topology boundary, applied to a NETWORK of corridors that belong to different records.
    //
    // normalizeCorridorGraph only ever saw one corridor's own strokes, so two roads drawn as two
    // proposals could cross with no node in either, or — after snapping — with a node in the new
    // road only, sitting on the old road's edge. The junction was then real only to the renderer
    // (buildCrossCorridorJunctionTreatments paints the zebras from a render-only augmentation), and
    // the node editor, which reads one record, could move one road's leg out of the crossing and
    // leave the other behind. Here a crossing between two records is exactly the crossing it would
    // be inside one: both sides get the vertex, and both sides split at it.
    //
    // `entries` are `{ segments, segmentIds, segmentProfiles, protectedEdgeKeys }`, mutated in place.
    // A caller that wants a corridor to contribute its geometry without being rewritten can pass
    // CLONED arrays for it and discard its result — but note that a one-sided junction is not a
    // junction: the other road ends up with a vertex on a line that has no vertex back.
    //
    // Returns one `{ changed }` per entry, in order. Convergent: a second run changes nothing.
    function normalizeCorridorNetwork(entries) {
        const list = (Array.isArray(entries) ? entries : []).filter(
            entry => entry && Array.isArray(entry.segments) && entry.segments.length
        );
        const signatureOf = entry => {
            try {
                return JSON.stringify({
                    segments: entry.segments,
                    segmentIds: entry.segmentIds || null,
                    segmentProfiles: entry.segmentProfiles || null
                });
            } catch (_) { return null; }
        };
        const before = list.map(signatureOf);
        if (!list.length) return [];

        // One flat view over every corridor's polylines. The arrays ARE the owners' arrays, so the
        // crossing-node splices land in the right record without any mapping back.
        const flat = [];
        list.forEach(entry => entry.segments.forEach(segment => {
            if (Array.isArray(segment) && segment.length >= 2) flat.push(segment);
        }));
        const protectedEdgeKeys = new Set();
        list.forEach(entry => {
            const keys = entry.protectedEdgeKeys;
            if (keys && typeof keys.forEach === 'function') keys.forEach(key => { if (key) protectedEdgeKeys.add(key); });
        });
        insertCorridorCrossingNodes(flat, flat.map(() => null), protectedEdgeKeys);

        // Every node key each corridor now carries. Read for ALL of them before splitting any:
        // splitting never moves or drops a vertex, so the keys are the same either way, and taking
        // them up front keeps the pass independent of the order the corridors are visited in.
        const keysOf = segments => {
            const keys = new Set();
            (segments || []).forEach(segment => (Array.isArray(segment) ? segment : []).forEach(point => {
                const key = corridorNodeKey(point);
                if (key) keys.add(key);
            }));
            return keys;
        };
        const perCorridorKeys = list.map(entry => keysOf(entry.segments));

        list.forEach((entry, index) => {
            const external = new Set();
            perCorridorKeys.forEach((keys, other) => {
                if (other !== index) keys.forEach(key => external.add(key));
            });
            splitCorridorSelfJunctions(entry.segments, entry.segmentIds, entry.segmentProfiles || null, external);
        });

        return list.map((entry, index) => ({
            entry,
            changed: before[index] === null || signatureOf(entry) !== before[index]
        }));
    }

    // Normalize a stored definition without touching its footprint. Splitting a centerline at its
    // own crossings changes only array topology — every physical edge stays exactly where it was —
    // so an already-applied local proposal can be upgraded without unapply/reapply parcel churn.
    function normalizeCorridorDefinitionTopology(definition) {
        if (!definition || typeof definition !== 'object') return false;
        const raw = (Array.isArray(definition.points) && definition.points.length)
            ? definition.points
            : (Array.isArray(definition.segments) ? definition.segments : null);
        if (!raw || !raw.length) return false;

        const toPoint = point => {
            if (!point) return null;
            const lat = Number(point.lat !== undefined ? point.lat : (Array.isArray(point) ? point[1] : NaN));
            const lng = Number(point.lng !== undefined ? point.lng : (Array.isArray(point) ? point[0] : NaN));
            return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
        };
        const nested = Array.isArray(raw[0]);
        const segments = (nested ? raw : [raw])
            .map(segment => (Array.isArray(segment) ? segment.map(toPoint).filter(Boolean) : []))
            .filter(segment => segment.length >= 2);
        if (!segments.length) return false;

        const segmentIds = segments.map((_, index) => (
            Array.isArray(definition.segmentIds) && definition.segmentIds[index] !== undefined
                ? definition.segmentIds[index]
                : null
        ));
        const before = JSON.stringify({ segments, segmentIds, segmentProfiles: definition.segmentProfiles || null });
        const protectedEdges = new Set(
            (Array.isArray(definition.tunnels) ? definition.tunnels : [])
                .map(record => record?.edgeKey)
                .filter(Boolean)
        );
        (Array.isArray(definition.gradeSeparations) ? definition.gradeSeparations : []).forEach(record => {
            if (record?.edgeKey) protectedEdges.add(record.edgeKey);
            (Array.isArray(record?.edgeKeys) ? record.edgeKeys : []).forEach(key => {
                if (key) protectedEdges.add(key);
            });
        });
        normalizeCorridorGraph(segments, segmentIds, protectedEdges, definition.segmentProfiles || null);
        const after = JSON.stringify({ segments, segmentIds, segmentProfiles: definition.segmentProfiles || null });
        if (before === after) return false;

        definition.points = segments;
        definition.segments = segments;
        definition.segmentIds = segmentIds;
        return true;
    }

    function cloneCorridorValue(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function corridorEditInputs(segments, segmentIds, segmentProfiles) {
        const sourceSegments = Array.isArray(segments) ? segments : [];
        return {
            segments: sourceSegments.map(segment => (
                Array.isArray(segment) ? segment.map(point => ({ ...point })) : []
            )),
            segmentIds: sourceSegments.map((_, index) => (
                Array.isArray(segmentIds) && segmentIds[index] !== undefined
                    ? segmentIds[index]
                    : null
            )),
            segmentProfiles: segmentProfiles && typeof segmentProfiles === 'object'
                ? cloneCorridorValue(segmentProfiles)
                : null
        };
    }

    function nextSplitSegmentId(sourceId, usedIds) {
        const base = sourceId !== null && sourceId !== undefined && String(sourceId)
            ? `${String(sourceId)}~2`
            : 'split~2';
        let candidate = base;
        let suffix = 2;
        while (usedIds.has(candidate)) candidate = `${base}~${suffix++}`;
        usedIds.add(candidate);
        return candidate;
    }

    function pruneCorridorEditProfiles(segmentIds, segmentProfiles) {
        if (!segmentProfiles) return null;
        const liveIds = new Set(segmentIds.filter(id => id !== null && id !== undefined).map(String));
        Object.keys(segmentProfiles).forEach(id => {
            if (!liveIds.has(String(id))) delete segmentProfiles[id];
        });
        return segmentProfiles;
    }

    // Remove exactly one authored centerline edge. A road is one formation even when this leaves
    // disconnected stretches: those stretches remain in this ONE result and replay re-derives its
    // complete footprint. Segment identity stays index-aligned; when one polyline becomes two, the
    // leading remainder keeps its id and the trailing remainder receives a stable derived id plus a
    // copy of the source profile. Inputs are never mutated.
    function removeCorridorEdge(segments, segmentIds, segmentProfiles, segmentIndex, edgeIndex) {
        const result = corridorEditInputs(segments, segmentIds, segmentProfiles);
        const target = result.segments[segmentIndex];
        if (!Array.isArray(target) || !target[edgeIndex] || !target[edgeIndex + 1]) {
            return { ...result, changed: false };
        }

        const sourceId = result.segmentIds[segmentIndex] ?? null;
        const before = target.slice(0, edgeIndex + 1);
        const after = target.slice(edgeIndex + 1);
        const replacementSegments = [];
        const replacementIds = [];
        if (before.length >= 2) {
            replacementSegments.push(before);
            replacementIds.push(sourceId);
        }
        if (after.length >= 2) {
            replacementSegments.push(after);
            if (replacementSegments.length === 1) {
                replacementIds.push(sourceId);
            } else {
                const usedIds = new Set(result.segmentIds
                    .filter(id => id !== null && id !== undefined)
                    .map(String));
                const derivedId = nextSplitSegmentId(sourceId, usedIds);
                replacementIds.push(derivedId);
                if (result.segmentProfiles && sourceId !== null && sourceId !== undefined
                    && result.segmentProfiles[String(sourceId)]) {
                    result.segmentProfiles[String(derivedId)] = cloneCorridorValue(
                        result.segmentProfiles[String(sourceId)]
                    );
                }
            }
        }

        result.segments.splice(segmentIndex, 1, ...replacementSegments);
        result.segmentIds.splice(segmentIndex, 1, ...replacementIds);
        result.segmentProfiles = pruneCorridorEditProfiles(result.segmentIds, result.segmentProfiles);
        return { ...result, changed: true };
    }

    // Remove one displayed graph node from every polyline occurrence that represents it. Targets
    // are processed from the end of each polyline so a loop seam or self-junction cannot shift a
    // later point index. Dropped one-point polylines take their aligned id/profile with them.
    function removeCorridorNodes(segments, segmentIds, segmentProfiles, targets) {
        const result = corridorEditInputs(segments, segmentIds, segmentProfiles);
        const bySegment = new Map();
        (Array.isArray(targets) ? targets : []).forEach(target => {
            const segmentIndex = Number(target?.segIndex);
            const pointIndex = Number(target?.pointIndex);
            if (!Number.isInteger(segmentIndex) || !Number.isInteger(pointIndex)) return;
            if (!bySegment.has(segmentIndex)) bySegment.set(segmentIndex, new Set());
            bySegment.get(segmentIndex).add(pointIndex);
        });

        let changed = false;
        bySegment.forEach((pointIndexes, segmentIndex) => {
            const segment = result.segments[segmentIndex];
            if (!Array.isArray(segment)) return;
            [...pointIndexes].sort((a, b) => b - a).forEach(pointIndex => {
                if (!segment[pointIndex]) return;
                segment.splice(pointIndex, 1);
                changed = true;
            });
        });
        if (!changed) return { ...result, changed: false };

        const kept = result.segments.map((segment, index) => ({
            segment,
            id: result.segmentIds[index] ?? null
        })).filter(entry => entry.segment.length >= 2);
        result.segments = kept.map(entry => entry.segment);
        result.segmentIds = kept.map(entry => entry.id);
        result.segmentProfiles = pruneCorridorEditProfiles(result.segmentIds, result.segmentProfiles);
        return { ...result, changed: true };
    }

    function segmentsIntersect(p1, q1, p2, q2) {
        const EPS = 1e-9;

        const orient = (a, b, c) => {
            const val = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if (Math.abs(val) < EPS) return 0;
            return val > 0 ? 1 : 2;
        };

        const onSegment = (a, b, c) => {
            return b.x <= Math.max(a.x, c.x) + EPS && b.x + EPS >= Math.min(a.x, c.x)
                && b.y <= Math.max(a.y, c.y) + EPS && b.y + EPS >= Math.min(a.y, c.y);
        };

        const o1 = orient(p1, q1, p2);
        const o2 = orient(p1, q1, q2);
        const o3 = orient(p2, q2, p1);
        const o4 = orient(p2, q2, q1);

        if (o1 !== o2 && o3 !== o4) return true;

        // Colinear cases
        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;

        return false;
    }

    // Does a road centerline cross itself? Works in planar metres (wgs84ToHTRS96) to dodge geodesic
    // edge cases; a false negative would save a self-crossing road with an even-odd hole at the
    // crossing, so parcels inside the loop are never acquired.
    function polylineHasSelfIntersection(latLngPoints) {
        if (!Array.isArray(latLngPoints) || latLngPoints.length < 4) return false;

        const pts = [];
        for (const p of latLngPoints) {
            try {
                const xy = wgs84ToHTRS96(p.lat, p.lng);
                if (Array.isArray(xy) && xy.length >= 2 && isFinite(xy[0]) && isFinite(xy[1])) {
                    pts.push({ x: xy[0], y: xy[1] });
                } else {
                    return false;
                }
            } catch (_) {
                return false;
            }
        }

        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (!a || !b) continue;
            for (let j = i + 2; j < pts.length - 1; j++) {
                if (j === i + 1) continue;
                const c = pts[j];
                const d = pts[j + 1];
                if (!c || !d) continue;
                if (segmentsIntersect(a, b, c, d)) {
                    return true;
                }
            }
        }
        return false;
    }

    // ---- Road-footprint shape conversion (moved out of road-drawing.js) ----------------------
    // Every corridor footprint passes through here on its way to persistence. The only coupling is
    // an `instanceof L.LatLng` probe, guarded by `typeof L !== 'undefined'`, so the branch logic —
    // which is where a MultiPolygon footprint was once misread as polygon-with-holes and lost — is
    // testable without Leaflet.

    // Normalize a road polygon (single ring / polygon-with-holes / MultiPolygon, of LatLng objects
    // or numeric pairs) into [lat,lng] pair rings. Returns null if it can't form a valid ring.
    function convertRoadPolygonToLatLngPairs(polygon) {
        if (!Array.isArray(polygon) || !polygon.length) return null;

        const isLatLngObj = (p) => {
            if (!p) return false;
            if (typeof p.lat === 'number' && typeof p.lng === 'number') return true;
            if (typeof L !== 'undefined' && L.LatLng && p instanceof L.LatLng) return true;
            const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
            const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
            return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);
        };

        const extractLatLng = (p) => {
            if (!p) return null;
            if (typeof L !== 'undefined' && L.LatLng && p instanceof L.LatLng) return [p.lat, p.lng];
            if (typeof p.lat === 'function' && typeof p.lng === 'function') return [p.lat(), p.lng()];
            if (typeof p.lat === 'number' && typeof p.lng === 'number') return [p.lat, p.lng];
            return null;
        };

        const toRingPairs = (ring) => {
            if (!Array.isArray(ring) || !ring.length) return null;
            const pairs = [];
            for (const entry of ring) {
                const extracted = extractLatLng(entry);
                if (extracted) {
                    pairs.push(extracted);
                    continue;
                }
                if (Array.isArray(entry) && entry.length >= 2) {
                    const a = Number(entry[0]);
                    const b = Number(entry[1]);
                    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                    // Assume [lat, lng] but swap if first looks like lng
                    if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
                        pairs.push([b, a]);
                    } else {
                        pairs.push([a, b]);
                    }
                }
            }
            if (pairs.length < 3) return null;
            const first = pairs[0];
            const last = pairs[pairs.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                pairs.push([first[0], first[1]]);
            }
            return pairs.length >= 4 ? pairs : null;
        };

        // MultiPolygon FIRST: [ [ring, hole...], [ring, ...], ... ].
        //
        // This has to be tested before polygon-with-holes, and it has to accept rings made of LatLng
        // OBJECTS, not just numeric pairs. combineRoadPolygons produces exactly that shape whenever the
        // footprint is DISJOINT — which is what a corridor tunnelled through its MIDDLE is: two surface
        // runs, one either side of the tunnel. The old order matched such a footprint as a
        // polygon-with-holes, tried to read each ring as a coordinate pair, produced NaN, and returned
        // null. Every consumer then silently lost the footprint: the 3D view carved nothing at all for
        // a mid-corridor tunnel, and parcel parents under the tunnel were never re-derived.
        //
        // The giveaway is depth: in a MultiPolygon, polygon[0][0] is itself a list of POINTS (one level
        // deeper than in a polygon-with-holes, where polygon[0][0] IS a point).
        const isPoint = (value) => isLatLngObj(value)
            || (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number');
        if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0]) && isPoint(polygon[0][0][0])) {
            const polys = polygon
                .map(poly => Array.isArray(poly) ? poly.map(toRingPairs).filter(Boolean) : [])
                .filter(rings => rings.length);
            return polys.length ? polys : null;
        }

        // Polygon with holes: [ring, hole1, ...]
        if (Array.isArray(polygon[0]) && polygon[0].length) {
            const firstRing = polygon[0];
            if (isLatLngObj(firstRing[0]) || (Array.isArray(firstRing[0]) && firstRing[0].length >= 2)) {
                const rings = polygon.map(toRingPairs).filter(Boolean);
                return rings.length ? rings : null;
            }
        }

        // Single ring
        if (isLatLngObj(polygon[0]) || (Array.isArray(polygon[0]) && polygon[0].length >= 2)) {
            return toRingPairs(polygon);
        }

        // (The MultiPolygon case is handled at the top — it must be tested before polygon-with-holes.)
        return null;
    }

    // [lat,lng] pair rings → a GeoJSON Polygon/MultiPolygon ([lng,lat] order).
    function convertLatLngPairsToGeoJSON(pairs) {
        if (!Array.isArray(pairs) || pairs.length === 0) return null;

        const toLngLatRing = (ring) => {
            if (!Array.isArray(ring)) return null;
            const coords = ring
                .map(entry => {
                    if (!entry || !Array.isArray(entry) || entry.length < 2) return null;
                    const lat = Number(entry[0]);
                    const lng = Number(entry[1]);
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                    return [lng, lat];
                })
                .filter(Boolean);
            return coords.length >= 4 ? coords : null;
        };

        // MultiPolygon
        if (Array.isArray(pairs[0]) && Array.isArray(pairs[0][0]) && Array.isArray(pairs[0][0][0])) {
            const polygons = pairs
                .map(poly => Array.isArray(poly) ? poly.map(toLngLatRing).filter(Boolean) : [])
                .filter(rings => rings.length);
            return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
        }

        // Polygon with holes
        if (Array.isArray(pairs[0]) && Array.isArray(pairs[0][0]) && typeof pairs[0][0][0] === 'number') {
            const rings = pairs.map(toLngLatRing).filter(Boolean);
            return rings.length ? { type: 'Polygon', coordinates: rings } : null;
        }

        // Ring only
        if (Array.isArray(pairs[0]) && typeof pairs[0][0] === 'number') {
            const ring = toLngLatRing(pairs);
            return ring ? { type: 'Polygon', coordinates: [ring] } : null;
        }

        return null;
    }

    function isValidPolygonLatLngPairs(polygon) {
        if (!Array.isArray(polygon) || polygon.length === 0) return false;

        // Ring: [ [lat,lng], ... ]
        if (Array.isArray(polygon[0]) && polygon[0].length >= 2 && Number.isFinite(Number(polygon[0][0])) && Number.isFinite(Number(polygon[0][1]))) {
            return polygon.length >= 3;
        }

        // Polygon with holes: [ ring, hole... ]
        if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0])) {
            const ring = polygon[0];
            if (Array.isArray(ring[0]) && ring[0].length >= 2 && Number.isFinite(Number(ring[0][0])) && Number.isFinite(Number(ring[0][1]))) {
                return ring.length >= 3;
            }
        }

        // MultiPolygon: [ [rings...], [rings...] ... ]
        if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0]) && Array.isArray(polygon[0][0][0])) {
            for (const poly of polygon) {
                if (!Array.isArray(poly) || poly.length === 0) continue;
                const outer = poly[0];
                if (Array.isArray(outer) && outer.length >= 3) return true;
            }
        }

        return false;
    }

    // ---- Track curvature constraints (moved out of road-drawing.js) --------------------------
    // A track vertex must not create a turn tighter than its speed allows. Pure projection math
    // (wgs84ToHTRS96 / htrs96ToWGS84 from the runtime global); the audio feedback stays in the UI.

    // Track speed (km/h) → minimum curvature radius (m), from railway engineering standards.
    const TRACK_SPEED_TO_MIN_RADIUS = {
        50: 300, 80: 500, 120: 1000, 160: 2000, 200: 3500, 250: 5000
    };

    function getMinCurvatureRadius(speed) {
        return TRACK_SPEED_TO_MIN_RADIUS[speed] || 1000;
    }

    // Radius (m) of the circle through three lat/lng points. Infinity when the points are collinear
    // or too close (treated as straight).
    function calculateCurvatureRadius(p1, p2, p3) {
        const toMeters = (latLng) => {
            const [x, y] = wgs84ToHTRS96(latLng.lat, latLng.lng);
            return [x, y];
        };
        const a = toMeters(p1);
        const b = toMeters(p2);
        const c = toMeters(p3);
        const ab = [b[0] - a[0], b[1] - a[1]];
        const bc = [c[0] - b[0], c[1] - b[1]];
        const ac = [c[0] - a[0], c[1] - a[1]];
        const abLen = Math.hypot(ab[0], ab[1]);
        const bcLen = Math.hypot(bc[0], bc[1]);
        const acLen = Math.hypot(ac[0], ac[1]);
        if (abLen < 0.1 || bcLen < 0.1 || acLen < 0.1) {
            return Infinity; // Points too close, treat as straight
        }
        const area = Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) / 2;
        if (area < 0.1) {
            return Infinity; // Collinear, treat as straight
        }
        return (abLen * bcLen * acLen) / (4 * area);
    }

    // Would appending newPoint after `points` violate the minimum radius? Returns
    // { valid, adjustedPoint, violatesConstraint, wasAdjusted }. May nudge the point outward to
    // satisfy the constraint when a small extension fixes it.
    function checkCurvatureConstraint(points, newPoint, minRadius, deps = {}) {
        if (points.length < 2) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }
        const lastPoint = points[points.length - 1];
        const secondLastPoint = points.length >= 2 ? points[points.length - 2] : null;
        if (!secondLastPoint) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }

        const [prevX, prevY] = wgs84ToHTRS96(secondLastPoint.lat, secondLastPoint.lng);
        const [lastX, lastY] = wgs84ToHTRS96(lastPoint.lat, lastPoint.lng);
        const [newX, newY] = wgs84ToHTRS96(newPoint.lat, newPoint.lng);

        const prevDx = lastX - prevX;
        const prevDy = lastY - prevY;
        const prevDist = Math.hypot(prevDx, prevDy);
        const dx = newX - lastX;
        const dy = newY - lastY;
        const dist = Math.hypot(dx, dy);
        if (prevDist < 0.1 || dist < 0.1) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }

        const prevAngle = Math.atan2(prevDy, prevDx);
        const newAngle = Math.atan2(dy, dx);
        let angleDiff = newAngle - prevAngle;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        const absAngleDiff = Math.abs(angleDiff);
        if (absAngleDiff < 0.01) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }

        const radius = calculateCurvatureRadius(secondLastPoint, lastPoint, newPoint);
        if (radius >= minRadius) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }

        // L = 2·R·sin(θ/2): the minimum chord for this turn angle at the minimum radius.
        const chordDx = newX - prevX;
        const chordDy = newY - prevY;
        const chordLength = Math.hypot(chordDx, chordDy);
        const minRequiredChordLength = 2 * minRadius * Math.sin(absAngleDiff / 2);

        if (chordLength < minRequiredChordLength) {
            const cosAngleDiff = Math.cos(absAngleDiff);
            const qa = 1;
            const qb = -2 * prevDist * cosAngleDiff;
            const qc = prevDist * prevDist - minRequiredChordLength * minRequiredChordLength;
            const discriminant = qb * qb - 4 * qa * qc;
            if (discriminant < 0) {
                return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
            }
            const requiredDist = (-qb + Math.sqrt(discriminant)) / (2 * qa);
            if (requiredDist > dist * 2 || requiredDist < dist * 0.5) {
                return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
            }
            const scale = requiredDist / dist;
            const adjustedX = lastX + dx * scale;
            const adjustedY = lastY + dy * scale;
            const [adjustedLat, adjustedLng] = htrs96ToWGS84(adjustedX, adjustedY);
            const adjustedPoint = makeLatLng(deps, adjustedLat, adjustedLng);
            const adjustedRadius = calculateCurvatureRadius(secondLastPoint, lastPoint, adjustedPoint);
            if (adjustedRadius >= minRadius * 0.98) {
                return { valid: true, adjustedPoint: adjustedPoint, violatesConstraint: false, wasAdjusted: true };
            }
        }

        return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
    }

    // ---- Snap-target selection (moved out of road-drawing.js) --------------------------------
    // Pure pixel-space geometry: which existing vertex/edge should a cursor snap to. The UI projects
    // lat/lng to screen pixels and resolves the result back; this decides the priority.

    function projectPointOnPixelSegment(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) return { x: a.x, y: a.y };
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        return { x: a.x + t * dx, y: a.y + t * dy };
    }

    function pixelDistance(p, q) {
        return Math.hypot(p.x - q.x, p.y - q.y);
    }

    // Tiered nearest-snap. localSegments: [[{x,y}...], ...]; externalSegments: [{points:[{x,y}...]}].
    // Priority: any LOCAL VERTEX within radius beats any LOCAL EDGE beats any EXTERNAL (placed road).
    // The active segment's growing tip is skipped (snapping to it makes a zero-length edge) and the
    // active segment is never edge-inserted (that renumbers vertices under the pointer). Returns a
    // raw descriptor (indices + winning pixel) the UI resolves back to a latlng; null if nothing near.
    function pickSnapTarget(cursorPx, localSegments, externalSegments, activeIndex, radiusPx) {
        let best = null;

        // Tier 1: local vertices
        localSegments.forEach((seg, segmentIndex) => {
            if (!Array.isArray(seg) || !seg.length) return;
            seg.forEach((vertex, vertexIndex) => {
                if (segmentIndex === activeIndex && vertexIndex === seg.length - 1) return;
                const distance = pixelDistance(cursorPx, vertex);
                if (distance > radiusPx) return;
                if (best && distance >= best.distance) return;
                const isEndpoint = vertexIndex === 0 || vertexIndex === seg.length - 1;
                best = {
                    distance, source: 'local', kind: isEndpoint ? 'endpoint' : 'vertex',
                    segmentIndex, vertexIndex, atStart: vertexIndex === 0, pixel: vertex
                };
            });
        });
        if (best) return best;

        // Tier 2: local edges
        localSegments.forEach((seg, segmentIndex) => {
            if (!Array.isArray(seg) || seg.length < 2) return;
            if (segmentIndex === activeIndex) return;
            for (let i = 0; i < seg.length - 1; i++) {
                const projected = projectPointOnPixelSegment(cursorPx, seg[i], seg[i + 1]);
                const distance = pixelDistance(cursorPx, projected);
                if (distance > radiusPx) continue;
                if (best && distance >= best.distance) continue;
                best = { distance, source: 'local', kind: 'edge', segmentIndex, insertAfter: i, pixel: projected };
            }
        });
        if (best) return best;

        // Tier 3: every explicit node on a placed (external) corridor. Internal junction/bend
        // vertices are real graph nodes too; limiting this pass to endpoints made the cursor snap
        // to the nearby centreline instead of the existing node the user was aiming at.
        externalSegments.forEach((entry, externalIndex) => {
            const seg = entry && entry.points;
            if (!Array.isArray(seg) || seg.length < 2) return;
            seg.forEach((vertex, vertexIndex) => {
                const isEndpoint = vertexIndex === 0 || vertexIndex === seg.length - 1;
                const distance = pixelDistance(cursorPx, vertex);
                if (distance > radiusPx) return;
                if (best && distance >= best.distance) return;
                best = {
                    distance,
                    source: 'external',
                    kind: isEndpoint ? 'external-endpoint' : 'external-node',
                    externalIndex,
                    vertexIndex,
                    pixel: vertex
                };
            });
        });
        if (best) return best;

        // Tier 4: an arbitrary point on a placed corridor's centreline.
        externalSegments.forEach((entry, externalIndex) => {
            const seg = entry && entry.points;
            if (!Array.isArray(seg) || seg.length < 2) return;
            for (let i = 0; i < seg.length - 1; i++) {
                const projected = projectPointOnPixelSegment(cursorPx, seg[i], seg[i + 1]);
                const distance = pixelDistance(cursorPx, projected);
                if (distance > radiusPx) continue;
                if (best && distance >= best.distance) continue;
                best = { distance, source: 'external', kind: 'external-edge', externalIndex, insertAfter: i, pixel: projected };
            }
        });
        return best;
    }

    const api = {
        createRectangularRoadSegment,
        isValidHtrsPoint,
        getMinCurvatureRadius,
        calculateCurvatureRadius,
        checkCurvatureConstraint,
        projectPointOnPixelSegment,
        pickSnapTarget,
        planarSegmentIntersection,
        insertCorridorCrossingNodes,
        splitCorridorSelfJunctions,
        normalizeCorridorGraph,
        normalizeCorridorNetwork,
        normalizeCorridorDefinitionTopology,
        removeCorridorEdge,
        removeCorridorNodes,
        segmentsIntersect,
        polylineHasSelfIntersection,
        convertRoadPolygonToLatLngPairs,
        convertLatLngPairsToGeoJSON,
        isValidPolygonLatLngPairs
    };

    if (typeof window !== 'undefined') {
        window.CorridorGeometry = api;
        window.createRectangularRoadSegment = createRectangularRoadSegment;
        window.planarSegmentIntersection = planarSegmentIntersection;
        window.insertCorridorCrossingNodes = insertCorridorCrossingNodes;
        window.splitCorridorSelfJunctions = splitCorridorSelfJunctions;
        window.normalizeCorridorGraph = normalizeCorridorGraph;
        window.normalizeCorridorNetwork = normalizeCorridorNetwork;
        window.normalizeCorridorDefinitionTopology = normalizeCorridorDefinitionTopology;
        window.segmentsIntersect = segmentsIntersect;
        window.polylineHasSelfIntersection = polylineHasSelfIntersection;
        window.convertRoadPolygonToLatLngPairs = convertRoadPolygonToLatLngPairs;
        window.convertLatLngPairsToGeoJSON = convertLatLngPairsToGeoJSON;
        window.isValidPolygonLatLngPairs = isValidPolygonLatLngPairs;
        window.getMinCurvatureRadius = getMinCurvatureRadius;
        window.calculateCurvatureRadius = calculateCurvatureRadius;
        window.checkCurvatureConstraint = checkCurvatureConstraint;
        window.pickSnapTarget = pickSnapTarget;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
