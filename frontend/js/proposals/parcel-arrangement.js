// What one cadastral parcel looks like once roads have taken their share.
//
// The outcome is a FUNCTION of a cadastral parcel and the set of corridors that overlap it — not a
// sequence of cuts. A rectangle crossed by road A and, perpendicular, road B yields the road area
// plus four remainders; which road was drawn first changes nothing, and no remainder is a "child"
// of another remainder. They are all simply pieces of the parcel. Roads and tracks are the ONLY
// takers: everything else either sits on top of a piece (a building) or reforms whole parcels (a
// readjustment), so neither splits anything here.
//
// Two consequences fall straight out, and both are the point:
//
//   * adding a road only requires recomputing the parcels under it — the rest of the map is
//     untouched, so the cost of finishing a road stops growing with the size of the plan;
//   * a junction is not a special case. Where two corridors cross, the road area is simply covered
//     by two takers; unapply one and the same function, given one fewer take, returns the right
//     answer with no holder rule, no precedence and no ordered replay.
//
// IDENTITY IS THE GEOMETRY. A piece's id is its cadastral parcel plus a hash of its own outline, so
// a piece whose shape did not change keeps its id for free, and one that did change gets a new one —
// which is exactly the signal a consumer (a building standing on it) needs. The hash is taken from a
// canonicalised ring (fixed precision, fixed winding, fixed starting vertex) so that a piece which is
// geometrically identical cannot get two different ids because turf happened to emit its vertices
// starting somewhere else. The precision applies to the KEY only — never to the geometry, which
// stays exactly as turf produced it (rounding the pipeline is what once left slivers between a
// corridor and the remainders it cut).

(function (global) {
    'use strict';

    const T = () => (typeof turf !== 'undefined' && turf)
        ? turf
        : (typeof require === 'function' ? require('@turf/turf') : null);

    // Below this a piece is boundary noise from the cut, not a parcel. Same measured floor the rest
    // of the ancestry work uses (plan-order.MIN_INTERSECTION_M2).
    const MIN_PIECE_M2 = 0.25;

    // ~1 cm at this latitude: fine enough that two genuinely different pieces cannot collide, coarse
    // enough that a vertex re-emitted with floating-point noise still hashes the same.
    const KEY_PRECISION = 7;

    // turf 6 clips with `polygon-clipping`, whose sweep line can fail outright on real cadastre:
    //
    //   "Infinite loop when passing sweep line over endpoints (too many sweep line segments)"
    //
    // It is a robustness limit, not bad data. The sweep line compares event points at full double
    // precision, and around 15.88°E / 43.7°N one ulp is ~2e-15 degrees — so two vertices that are
    // the same corner to any surveyor, but differ in the last bit, order inconsistently and the
    // algorithm never converges. HR-330264-519 hit it and was recorded as "could not arrange", which
    // leaves the parcel WHOLE: a 5,048 m² parcel sat uncut under two roads that plainly crossed it,
    // with nothing on screen to say it had been skipped.
    //
    // So EVERY clip runs on coordinates snapped to a grid, which collapses those near-duplicates
    // into genuinely equal points before the sweep line can order them inconsistently.
    //
    // This used to be a retry: the first attempt ran unsnapped and only a throw brought the grid
    // out. That was the conservative choice — "the happy path never snaps, so every parcel that
    // already worked is bit-for-bit unchanged" — and it was wrong about how rare the failures are.
    // Panning across Šibenik produced several per second, each one a thrown exception, a discarded
    // clip and a full re-run. Worse, it left the fabric on TWO grids: source parcels arrive from the
    // cadastre at ~9 dp, derived pieces carry the full 15-dp output of the previous clip, and
    // feeding those back in is precisely how a shared boundary comes to differ in its last bit.
    // One grid for everything removes the failure at its source rather than recovering from it.
    //
    // 9 decimal places is 0.1 mm at this latitude — orders of magnitude below cadastral survey
    // precision, so nothing anyone surveyed moves.
    //
    // It DOES shift some piece ids once. A vertex within 0.05 mm of a KEY_PRECISION rounding
    // boundary (7 dp ≈ 1 cm) lands on the other side of it, which measures at ~0.5% of vertices, so
    // a piece with twenty vertices has roughly a one-in-ten chance of hashing differently than it
    // did before this change. That is survivable because a piece id is a content address, not a
    // foreign key: an applied proposal finds its ground through the live-fabric GEOMETRY resolver
    // (_resolveLiveFormationParents), never by looking a piece id up. Ids stay stable across
    // rebuilds, which is what they are for; they are not stable across a change in how the fabric
    // is computed, and nothing is entitled to assume they are.
    const CLIP_SNAP_DECIMALS = 9;

    // Whatever still fails gets a coarser grid: 1.1 mm, then 1.1 cm. If every attempt fails the
    // error is rethrown, because a clip that cannot be done must stay loud.
    const CLIP_RETRY_DECIMALS = [8, 7];

    function snapCoordinates(value, factor) {
        if (Array.isArray(value)) {
            return typeof value[0] === 'number'
                ? value.map(n => Math.round(n * factor) / factor)
                : value.map(entry => snapCoordinates(entry, factor));
        }
        return value;
    }

    function snapFeature(feature, decimals) {
        if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) return feature;
        const factor = Math.pow(10, decimals);
        return {
            type: 'Feature',
            properties: feature.properties || {},
            geometry: {
                type: feature.geometry.type,
                coordinates: snapCoordinates(feature.geometry.coordinates, factor)
            }
        };
    }

    // Every clip that has run, and every one that needed a coarser grid than the standard one.
    // A count, not a log line per event: the point is whether the failure class still exists.
    const clipTrouble = { clips: 0, rescued: 0, failed: 0, lastMessage: null };

    // Run a two-operand turf clip on the shared grid, coarsening it if the clipper still gives up.
    function clip(operation, a, b) {
        const t = T();
        clipTrouble.clips += 1;
        try {
            return t[operation](snapFeature(a, CLIP_SNAP_DECIMALS), snapFeature(b, CLIP_SNAP_DECIMALS));
        } catch (error) {
            for (const decimals of CLIP_RETRY_DECIMALS) {
                try {
                    const result = t[operation](snapFeature(a, decimals), snapFeature(b, decimals));
                    clipTrouble.rescued += 1;
                    clipTrouble.lastMessage = `${operation} @${decimals}dp: ${error && error.message}`;
                    console.warn(`[parcel-arrangement] ${operation} needed ${decimals}-dp snapping to clip:`, error && error.message);
                    return result;
                } catch (_) { /* try a coarser grid */ }
            }
            clipTrouble.failed += 1;
            clipTrouble.lastMessage = `${operation} FAILED: ${error && error.message}`;
            throw error;
        }
    }

    /** How the clipper has been coping. Read it from the console after a pan. */
    function clipHealth() { return { ...clipTrouble }; }

    function featureOf(geometry) {
        if (!geometry) return null;
        if (geometry.type === 'Feature') return geometry;
        return { type: 'Feature', properties: {}, geometry };
    }

    function geometryOf(value) {
        if (!value) return null;
        return value.type === 'Feature' ? value.geometry : value;
    }

    function boxesDisjoint(t, a, b) {
        try {
            const x = t.bbox(a);
            const y = t.bbox(b);
            return x[0] > y[2] || y[0] > x[2] || x[1] > y[3] || y[1] > x[3];
        } catch (_) {
            return false;
        }
    }

    // The clipper sometimes returns two separate lobes as ONE polygon, joined by a slit far thinner
    // than the grid its own inputs were snapped to. Cadastral parcel HR-330264-575, cut by the two
    // corridors meeting south of it, came back as a single 1,165 m² Polygon whose ring runs out along
    // a corridor edge and back: the turn segment measures 0.019 mm, against a 0.1 mm grid. GEOS, given
    // the identical rows, returns the two parts it actually is (859.87 + 305.35 m²).
    //
    // A connection narrower than the grid cannot be survey data, so it is an artifact by construction
    // — that is what makes this measurable rather than a tolerance someone picked. Below the grid the
    // clipper is describing its own rounding, not ground.
    //
    // Snapping cannot simply be dropped to avoid it (see CLIP_SNAP_DECIMALS: unsnapped clips threw
    // several times per second across Šibenik), and re-normalising the output through a self-union
    // shatters the parcel into four or five slivers. So the artifact is removed here instead, at the
    // one function that answers "how many pieces is this".
    const NECK_OPEN_MM = 1;
    // ~3 mm in degrees at this latitude. Below this nothing on a cadastral boundary is real, and a
    // false positive costs only the erosion probe below, which then finds nothing and changes
    // nothing — so the threshold is deliberately generous.
    const NECK_DEGREES = 3e-8;
    // The pair scan is O(n²), so it is skipped on rings far larger than any parcel. `explode` only
    // ever sees a parcel's own remainder or the takes over it, both small; this is a backstop.
    const NECK_SCAN_MAX_VERTICES = 400;

    // The slit takes a different shape depending on where the clipper turned it — on this one parcel
    // it is a 0.019 mm turn segment with two takes, and 260 mm edges running back alongside each
    // other with three. Neither a short-edge test nor a vertex-pair test sees both, and the vertex of
    // one lobe often lies near an EDGE of the other with no vertex anywhere close.
    //
    // So ask the question directly: does the boundary come within a neck's width of ITSELF, anywhere
    // it is not simply continuing along its own length? Point-to-segment, which covers every shape a
    // slit can take. Planar in degrees — this is a threshold test, and at 3e-8 the latitude scaling
    // is far too small to matter.
    function pointToSegmentDegrees(px, py, ax, ay, bx, by) {
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSq = (dx * dx) + (dy * dy);
        let t = lengthSq > 0 ? (((px - ax) * dx) + ((py - ay) * dy)) / lengthSq : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + (t * dx);
        const cy = ay + (t * dy);
        return Math.hypot(px - cx, py - cy);
    }

    function hasArtifactNeck(polygonGeometry) {
        const rings = polygonGeometry && polygonGeometry.coordinates;
        if (!Array.isArray(rings)) return false;
        for (const ring of rings) {
            if (!Array.isArray(ring) || ring.length < 4) continue;
            if (ring.length > NECK_SCAN_MAX_VERTICES) continue;
            const open = ring.length - 1; // the closing vertex repeats the first
            for (let i = 0; i < open; i += 1) {
                for (let j = 0; j < open; j += 1) {
                    // Skip the two edges this vertex is an endpoint of: the boundary is always
                    // zero distance from those, and that is it continuing, not closing on itself.
                    const next = (j + 1) % open;
                    if (j === i || next === i) continue;
                    const d = pointToSegmentDegrees(
                        ring[i][0], ring[i][1],
                        ring[j][0], ring[j][1], ring[next][0], ring[next][1]
                    );
                    if (d < NECK_DEGREES) return true;
                }
            }
        }
        return false;
    }

    // Open the polygon by a hair: erode, keep whatever separates, then dilate each component back and
    // clip it to the original outline, so the pieces are made of the ORIGINAL boundary and no ground
    // is invented or lost. Returns null when nothing separates, which is the overwhelmingly common
    // case and costs one buffer.
    function splitAtArtifactNeck(feature) {
        const t = T();
        const metres = NECK_OPEN_MM / 1000;
        let eroded = null;
        try { eroded = t.buffer(feature, -metres, { units: 'meters' }); } catch (_) { return null; }
        const geom = eroded && eroded.geometry;
        if (!geom || geom.type !== 'MultiPolygon' || geom.coordinates.length < 2) return null;

        const pieces = [];
        for (const rings of geom.coordinates) {
            let grown = null;
            try { grown = t.buffer(featureOf({ type: 'Polygon', coordinates: rings }), metres * 1.5, { units: 'meters' }); }
            catch (_) { return null; }
            let piece = null;
            try { piece = clip('intersect', feature, grown); } catch (_) { return null; }
            if (piece && piece.geometry) pieces.push(featureOf(piece.geometry));
        }
        // All or nothing: a partial split would drop ground, which is the one outcome worse than the
        // artifact itself.
        return pieces.length === geom.coordinates.length ? pieces : null;
    }

    function asPieces(polygonGeometry) {
        const feature = featureOf(polygonGeometry);
        if (!hasArtifactNeck(polygonGeometry)) return [feature];
        return splitAtArtifactNeck(feature) || [feature];
    }

    // Every polygon of a Polygon/MultiPolygon, as separate features. A polygon WITH holes stays one
    // piece — a hole is part of that piece's shape, not a separate one.
    function explode(geometry) {
        const geom = geometryOf(geometry);
        if (!geom) return [];
        if (geom.type === 'Polygon') return asPieces(geom);
        if (geom.type === 'MultiPolygon') {
            return geom.coordinates
                .filter(rings => Array.isArray(rings) && rings.length)
                .reduce((all, rings) => all.concat(asPieces({ type: 'Polygon', coordinates: rings })), []);
        }
        return [];
    }

    // A ring reduced to one canonical string: fixed precision, fixed direction, and rotated to start
    // at its smallest vertex. Two identical outlines therefore produce identical text however they
    // were emitted.
    function canonicalRing(ring) {
        if (!Array.isArray(ring) || ring.length < 4) return '';
        // Drop the repeated closing vertex before rotating, then restore the closure implicitly.
        const open = ring.slice(0, ring.length - 1)
            .map(point => [Number(point[0]).toFixed(KEY_PRECISION), Number(point[1]).toFixed(KEY_PRECISION)]);
        if (!open.length) return '';

        let start = 0;
        for (let i = 1; i < open.length; i += 1) {
            if (open[i][0] < open[start][0] || (open[i][0] === open[start][0] && open[i][1] < open[start][1])) {
                start = i;
            }
        }
        const rotated = open.slice(start).concat(open.slice(0, start));
        // Direction: compare the step after the start vertex in each sense and keep the smaller, so
        // a ring and its reverse canonicalise the same way.
        const forward = rotated.map(p => `${p[0]},${p[1]}`).join(' ');
        const backward = [rotated[0]].concat(rotated.slice(1).reverse()).map(p => `${p[0]},${p[1]}`).join(' ');
        return forward <= backward ? forward : backward;
    }

    function canonicalPolygon(geometry) {
        const geom = geometryOf(geometry);
        if (!geom || geom.type !== 'Polygon') return '';
        // The outer ring first, then holes in a stable order of their own canonical text.
        const [outer, ...holes] = geom.coordinates;
        const holeText = holes.map(canonicalRing).filter(Boolean).sort();
        return [canonicalRing(outer)].concat(holeText).join('|');
    }

    // FNV-1a, 32-bit. Not a security hash — a short, stable, dependency-free content address.
    function hash32(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < String(text).length; i += 1) {
            hash ^= String(text).charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash >>> 0;
    }

    function hashText(text) {
        return hash32(text).toString(36);
    }

    function pieceId(parcelId, kind, geometry) {
        const text = canonicalPolygon(geometry);
        if (!text) return null;
        return `${parcelId}#${kind === 'road' ? 'r' : 'p'}${hashText(text)}`;
    }

    // Is this id one of OURS?
    //
    // A scoped re-derivation compares what the arrangement says a parcel is made of against what is
    // on the map, and removes the difference. Other things also mint derived ids under a cadastral
    // parcel — a readjustment's plots, a building's carved host — and those are not the
    // arrangement's to remove: it would delete a standing plan's plots the moment a road was drawn
    // anywhere across the same parcel. The piece format is this module's, so the test belongs here.
    function isPieceId(id) {
        const text = (id === undefined || id === null) ? '' : String(id);
        const cut = text.indexOf('#');
        if (cut === -1) return false;
        return /^[rp][0-9a-z]+$/.test(text.slice(cut + 1));
    }

    /**
     * The pieces one cadastral parcel is divided into by the corridors that cross it.
     *
     * @param {object} parcel  GeoJSON Feature/geometry of a CADASTRAL parcel.
     * @param {string} parcelId  Its cadastral id — the stem of every piece id.
     * @param {Array<{id: string, geometry: object}>} takes  Applied road/track footprints. Any that
     *        does not reach this parcel is ignored, so callers may pass the whole plan.
     * @param {Array<{take: object, hit: object}>} [precomputedHits]  The output of
     *        takeHitsOn(parcel, takes), when the caller already computed it to decide this parcel
     *        was worth arranging. When given, `takes` is not consulted at all — the hits ARE the
     *        takes that matter, and recomputing them here is the doubled work this parameter exists
     *        to remove.
     * @returns {{pieces: Array, takersUsed: Array<string>}} `pieces` are `{ id, parcelId, kind,
     *        geometry, takers, areaM2 }`, ordered largest first. An untouched parcel comes back as a
     *        single piece carrying its OWN cadastral id: nothing took it, so it is still itself.
     */
    function arrangementOf(parcel, parcelId, takes, precomputedHits) {
        const t = T();
        if (!t) throw new Error('parcel-arrangement: turf is unavailable');
        const parcelFeature = featureOf(parcel);
        if (!parcelFeature || !parcelFeature.geometry) throw new Error('parcel-arrangement: parcel has no geometry');
        const id = String(parcelId || '');
        if (!id) throw new Error('parcel-arrangement: a cadastral parcel id is required');

        const hits = Array.isArray(precomputedHits) ? precomputedHits : takeHitsOn(parcelFeature, takes);

        if (!hits.length) {
            return {
                pieces: [{
                    id,
                    parcelId: id,
                    kind: 'remainder',
                    geometry: parcelFeature.geometry,
                    takers: [],
                    areaM2: t.area(parcelFeature)
                }],
                takersUsed: []
            };
        }

        // The taken area of THIS parcel, as one shape: a junction is two corridors meeting, and the
        // union is what makes it a single connected piece instead of a precedence question.
        let taken = null;
        const takersUsed = [];
        const takenParts = [];
        hits.forEach(entry => {
            takersUsed.push(String(entry.take.id || ''));
            takenParts.push(entry.hit);
            taken = taken ? (clip('union', taken, entry.hit) || taken) : entry.hit;
        });

        // Subtract the takes ONE AT A TIME rather than subtracting their union in a single call.
        // P \ (A ∪ B) is the same set as (P \ A) \ B, but the union of several corridors over a
        // parcel is a MultiPolygon that turf's clipper can recurse to death on — measured on real
        // Šibenik parcel 4975/4 with five takes over it: `difference` against the union throws
        // "Maximum call stack size exceeded", while the same subtraction taken in five steps
        // returns cleanly. Each step is a plain polygon, which is the case the clipper handles well.
        //
        // And it must NOT be caught. A failed difference means the parcel's remaining ground could
        // not be computed; swallowing it returned road pieces with no remainders, i.e. it silently
        // deleted 1,282 m² of someone's land from the map while every test stayed green.
        let leftover = parcelFeature;
        for (const hit of takenParts) {
            if (!leftover) break;
            leftover = clip('difference', leftover, hit);
        }

        const pieces = [];
        const push = (feature, kind) => {
            const areaM2 = t.area(feature);
            if (!(areaM2 > MIN_PIECE_M2)) return;
            const pid = pieceId(id, kind, feature.geometry);
            if (!pid) return;
            const takers = kind === 'road'
                ? hits
                    .filter(entry => {
                        try {
                            // A road piece is inside the parcel, so intersecting it with the
                            // take's HIT (take ∩ parcel) answers the same membership question as
                            // the take's whole footprint — against a handful of vertices instead
                            // of a kilometres-long ribbon. A take whose hit was below MIN can
                            // never claim a piece: the piece's overlap is a subset of the hit.
                            const overlap = clip('intersect', feature, entry.hit);
                            return !!overlap && t.area(overlap) > MIN_PIECE_M2;
                        } catch (_) { return false; }
                    })
                    .map(entry => String(entry.take.id || ''))
                    .sort()
                : [];
            pieces.push({ id: pid, parcelId: id, kind, geometry: feature.geometry, takers, areaM2 });
        };

        explode(taken).forEach(feature => push(feature, 'road'));
        explode(leftover).forEach(feature => push(feature, 'remainder'));

        // Largest first, then by id: a total order that does not depend on the order the takes
        // arrived in, so two machines with the same records draw the same map.
        pieces.sort((a, b) => (b.areaM2 - a.areaM2) || a.id.localeCompare(b.id));
        return { pieces, takersUsed: Array.from(new Set(takersUsed)).sort() };
    }

    /** Which of `takes` reach this parcel at all — the recompute set for one corridor's ground. */
    // A corridor's bbox, computed once and remembered against the geometry object it came from.
    //
    // This is asked once per (parcel, take) pair. A whole-plan derivation over 13,000 loaded parcels
    // and 130 corridors is 1.7 million pairs, and boxesDisjoint recomputed BOTH boxes every time —
    // so a corridor polyline's box was rebuilt 13,000 times from all of its vertices, to answer a
    // question whose answer never changes. Cached, the pair costs four number comparisons.
    const takeBoxCache = (typeof WeakMap === 'function') ? new WeakMap() : null;

    function boxOf(t, geometryOrFeature) {
        if (!takeBoxCache || !geometryOrFeature || typeof geometryOrFeature !== 'object') {
            try { return t.bbox(featureOf(geometryOrFeature)); } catch (_) { return null; }
        }
        const cached = takeBoxCache.get(geometryOrFeature);
        if (cached) return cached;
        let box = null;
        try { box = t.bbox(featureOf(geometryOrFeature)); } catch (_) { box = null; }
        if (box) takeBoxCache.set(geometryOrFeature, box);
        return box;
    }

    /**
     * The takes that reach this parcel, each paired with the exact piece of the parcel it takes.
     *
     * This is THE overlap test and THE overlap geometry, computed once. The whole-plan derivation
     * used to ask twice — takesOverlapping to decide a parcel was worth arranging, then
     * arrangementOf recomputing the same intersections to arrange it — which doubled the dominant
     * cost of a replay (~12 s of turf clipping over 1,087 parcels × 132 corridors, half of it
     * repeats). A caller that filters first hands the result to arrangementOf/fabricOver instead.
     * clip() snaps both operands the same way on every call, so a handed-in hit is byte-identical
     * to a recomputed one — reuse cannot change a piece id.
     *
     * @returns {Array<{take: object, hit: object}>} the caller's take objects, with the clipped
     *          intersection feature of each; only takes whose overlap clears MIN_PIECE_M2 appear.
     */
    function takeHitsOn(parcel, takes) {
        const t = T();
        if (!t) return [];
        const parcelFeature = featureOf(parcel);
        if (!parcelFeature) return [];
        // The parcel's box once per call rather than once per take.
        let parcelBox = null;
        try { parcelBox = t.bbox(parcelFeature); } catch (_) { parcelBox = null; }
        const hits = [];
        (Array.isArray(takes) ? takes : []).forEach(take => {
            if (!take || !take.geometry) return;
            const takeBox = boxOf(t, take.geometry);
            if (parcelBox && takeBox
                && (parcelBox[0] > takeBox[2] || takeBox[0] > parcelBox[2]
                    || parcelBox[1] > takeBox[3] || takeBox[1] > parcelBox[3])) return;
            const feature = featureOf(take.geometry);
            if (!parcelBox && boxesDisjoint(t, parcelFeature, feature)) return;
            try {
                const hit = clip('intersect', parcelFeature, feature);
                if (hit && t.area(hit) > MIN_PIECE_M2) hits.push({ take, hit });
            } catch (_) { /* an unclippable take cannot reach this parcel */ }
        });
        return hits;
    }

    function takesOverlapping(parcel, takes) {
        return takeHitsOn(parcel, takes).map(entry => entry.take);
    }

    /**
     * The fabric over a set of cadastral parcels: every piece of every parcel, given every take.
     * The whole-plan derivation and a one-road recompute are the SAME function — the second just
     * passes fewer parcels — so the fast path cannot drift from the canonical one.
     *
     * @param {Array<{id: string, feature: object}>} parcels  cadastral parcels to arrange.
     * @param {Array<{id: string, geometry: object}>} takes   every applied corridor.
     * @param {Map<string, Array>} [hitsById]  takeHitsOn output per parcel id, for callers that
     *        already filtered these parcels through it. A parcel with no entry computes its own.
     * @returns {{pieces: Array, failed: Array<{parcelId: string, error: string}>}}
     */
    function fabricOver(parcels, takes, hitsById) {
        const pieces = [];
        const failed = [];
        (Array.isArray(parcels) ? parcels : []).forEach(entry => {
            if (!entry || !entry.feature || !entry.id) return;
            try {
                const precomputed = (hitsById && typeof hitsById.get === 'function')
                    ? hitsById.get(String(entry.id))
                    : undefined;
                pieces.push(...arrangementOf(entry.feature, entry.id, takes, precomputed).pieces);
            } catch (error) {
                // One unusable parcel is recorded and skipped; it must not void the rest of the map.
                failed.push({ parcelId: String(entry.id), error: String(error && error.message || error) });
            }
        });
        return { pieces, failed };
    }

    /**
     * Remove already-formed parcel ground from corridor REMAINDERS.
     *
     * A coordinated plan may publish its non-road plots first and its road bands second. The
     * corridor arrangement is still derived from the cadastre, so its ordinary remainder is the
     * entire cadastral parcel minus the road. Minting that remainder on top of the standing plots
     * would create two live parcels over the same land. The plots remain authoritative there; only
     * the part of the remainder outside them is new ground.
     *
     * Road pieces are never clipped here. If a road actually crosses a standing plot, the ground
     * sweep invalidates that plot formation and the next derivation restores its remainder. This
     * helper handles only the valid, pre-tessellated case where plots and road bands meet at edges.
     *
     * @param {Array<object>} pieces arrangementOf/fabricOver output
     * @param {Map<string, Array<object>>} occupiedByParcel base parcel id -> GeoJSON shapes
     */
    function remaindersOutsideOccupiedGround(pieces, occupiedByParcel) {
        const t = T();
        if (!t || !(occupiedByParcel instanceof Map) || occupiedByParcel.size === 0) {
            return Array.isArray(pieces) ? pieces.slice() : [];
        }
        const out = [];
        (Array.isArray(pieces) ? pieces : []).forEach(piece => {
            if (!piece || piece.kind !== 'remainder') {
                if (piece) out.push(piece);
                return;
            }
            const occupied = occupiedByParcel.get(String(piece.parcelId)) || [];
            if (!occupied.length) {
                out.push(piece);
                return;
            }

            let fragments = [featureOf(piece.geometry)];
            occupied.forEach(shape => {
                const blocker = featureOf(shape);
                if (!blocker || !blocker.geometry || !fragments.length) return;
                const next = [];
                fragments.forEach(fragment => {
                    if (boxesDisjoint(t, fragment, blocker)) {
                        next.push(fragment);
                        return;
                    }
                    const leftover = clip('difference', fragment, blocker);
                    if (leftover) next.push(...explode(leftover));
                });
                fragments = next;
            });

            fragments.forEach(fragment => {
                const areaM2 = t.area(fragment);
                if (!(areaM2 > MIN_PIECE_M2)) return;
                const id = pieceId(piece.parcelId, 'remainder', fragment.geometry);
                if (!id) return;
                out.push({
                    ...piece,
                    id,
                    geometry: fragment.geometry,
                    areaM2,
                    takers: []
                });
            });
        });
        out.sort((a, b) => (b.areaM2 - a.areaM2) || String(a.id).localeCompare(String(b.id)));
        return out;
    }

    /**
     * What changed between the fabric on the map and the fabric that should be there.
     *
     * Because a piece is named by its own shape, this is a set difference and nothing more: pieces
     * present in both are byte-identical and are left alone — not removed and re-added — so a road
     * drawn at one end of the map does not disturb anything at the other end. That is the whole
     * mechanism by which finishing a road stops costing the size of the plan.
     */
    function diffPieces(current, next) {
        const currentIds = new Set((Array.isArray(current) ? current : [])
            .map(piece => (typeof piece === 'string' ? piece : (piece && piece.id)))
            .filter(Boolean).map(String));
        const nextById = new Map();
        (Array.isArray(next) ? next : []).forEach(piece => {
            if (piece && piece.id) nextById.set(String(piece.id), piece);
        });

        const added = [];
        nextById.forEach((piece, id) => { if (!currentIds.has(id)) added.push(piece); });
        const removed = [];
        currentIds.forEach(id => { if (!nextById.has(id)) removed.push(id); });
        const unchanged = [];
        currentIds.forEach(id => { if (nextById.has(id)) unchanged.push(id); });

        return { added, removed, unchanged };
    }

    /**
     * A piece as a map feature, in the shape the rest of the app already reads.
     *
     * The base cadastral parcel is cloned, so everything the map, the panels and the 3D world get
     * from a parcel — the KO, the parcel number, ownership, road-parcel status — travels into every
     * piece cut from it. Only what the cut changes is overwritten.
     *
     * `proposalId` is the first taker rather than "the proposal that made this", because under this
     * model no single proposal made it: a remainder between two roads is formed by both. The full
     * set travels as `formedByProposalIds` for anything that needs to be exact, and the legacy field
     * keeps the existing click/style routing working.
     */
    function featureForPiece(piece, baseFeature, options = {}) {
        if (!piece || !baseFeature) return null;
        const feature = JSON.parse(JSON.stringify(baseFeature));
        feature.geometry = JSON.parse(JSON.stringify(piece.geometry));

        const props = feature.properties || (feature.properties = {});
        const baseProps = baseFeature.properties || {};
        const primary = piece.takers && piece.takers.length ? piece.takers[0] : null;

        props.calculatedArea = piece.areaM2;
        props.parentParcelId = piece.parcelId;
        props.parentParcelNumber = baseProps.BROJ_CESTICE !== undefined ? baseProps.BROJ_CESTICE : null;
        props.rootParcelId = piece.parcelId;
        props.rootParcelNumber = baseProps.BROJ_CESTICE !== undefined ? baseProps.BROJ_CESTICE : null;
        props.baseParcelIds = [piece.parcelId];
        props.formedByProposalIds = (piece.takers || []).slice();
        if (primary) props.proposalId = primary;
        else delete props.proposalId;

        if (piece.kind === 'road') {
            props.isCorridor = true;
            props.isTrack = !!options.isTrack;
            props.isRoad = !options.isTrack;
            props.isProposed = true;
            if (options.roadName) props.roadName = options.roadName;
        } else {
            // A remainder is ordinary ground again. Corridor flags from the clone would paint it as
            // road surface and route its clicks into the corridor panel.
            delete props.isCorridor;
            delete props.isTrack;
            props.isProposed = true;
            // A remainder of a parcel that WAS a road parcel stays one — legacy road parcels carry
            // their status in the road set rather than on the feature, so the clone's flag is kept
            // as it came rather than being asserted either way.
        }

        // Identity last: several of the fields above are also written by _ensureParcelIdOnProperties
        // in the browser, and the piece id must be the one that survives.
        props.parcelId = piece.id;
        props.PARCEL_ID = piece.id;
        props.id = piece.id;
        return feature;
    }

    const api = {
        MIN_PIECE_M2,
        arrangementOf,
        fabricOver,
        remaindersOutsideOccupiedGround,
        diffPieces,
        featureForPiece,
        takesOverlapping,
        takeHitsOn,
        pieceId,
        isPieceId,
        canonicalPolygon,
        // Exported so nothing else re-implements the content address. A block's name is built on
        // this too, from its own outline rather than from any parcel in it.
        hash32,
        // The clipper's own surface, exported so its grid and its failure handling can be tested
        // directly rather than inferred from whatever the arrangement happened to produce.
        clip,
        clipHealth
    };

    // Namespaced only — a bare global here could shadow one of the top-level functions in the
    // classic scripts loaded alongside this file.
    if (typeof window !== 'undefined') window.__parcelArrangement = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
