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
    // So a failed clip is retried on coordinates snapped to a grid, which collapses those
    // near-duplicates into genuinely equal points. 9 then 8 decimal places is 0.1 mm then 1.1 mm —
    // orders of magnitude below cadastral survey precision, and below KEY_PRECISION, so a piece
    // still hashes to the same id. The happy path never snaps, so every parcel that already worked
    // is bit-for-bit unchanged; only the ones that would otherwise be dropped are touched. If every
    // attempt fails the error is rethrown, because a clip that cannot be done must stay loud.
    const CLIP_RETRY_DECIMALS = [9, 8];

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

    // Run a two-operand turf clip, retrying on snapped coordinates if the clipper gives up.
    function clip(operation, a, b) {
        const t = T();
        try {
            return t[operation](a, b);
        } catch (error) {
            for (const decimals of CLIP_RETRY_DECIMALS) {
                try {
                    const result = t[operation](snapFeature(a, decimals), snapFeature(b, decimals));
                    console.warn(`[parcel-arrangement] ${operation} needed ${decimals}-dp snapping to clip:`, error && error.message);
                    return result;
                } catch (_) { /* try a coarser grid */ }
            }
            throw error;
        }
    }

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

    // Every polygon of a Polygon/MultiPolygon, as separate features. A polygon WITH holes stays one
    // piece — a hole is part of that piece's shape, not a separate one.
    function explode(geometry) {
        const geom = geometryOf(geometry);
        if (!geom) return [];
        if (geom.type === 'Polygon') return [featureOf(geom)];
        if (geom.type === 'MultiPolygon') {
            return geom.coordinates
                .filter(rings => Array.isArray(rings) && rings.length)
                .map(rings => featureOf({ type: 'Polygon', coordinates: rings }));
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
    function hashText(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(36);
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
     * @returns {{pieces: Array, takersUsed: Array<string>}} `pieces` are `{ id, parcelId, kind,
     *        geometry, takers, areaM2 }`, ordered largest first. An untouched parcel comes back as a
     *        single piece carrying its OWN cadastral id: nothing took it, so it is still itself.
     */
    function arrangementOf(parcel, parcelId, takes) {
        const t = T();
        if (!t) throw new Error('parcel-arrangement: turf is unavailable');
        const parcelFeature = featureOf(parcel);
        if (!parcelFeature || !parcelFeature.geometry) throw new Error('parcel-arrangement: parcel has no geometry');
        const id = String(parcelId || '');
        if (!id) throw new Error('parcel-arrangement: a cadastral parcel id is required');

        const relevant = (Array.isArray(takes) ? takes : [])
            .map(take => (take && take.geometry) ? { id: String(take.id || ''), feature: featureOf(take.geometry) } : null)
            .filter(take => take && take.feature && !boxesDisjoint(t, parcelFeature, take.feature));

        if (!relevant.length) {
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
        relevant.forEach(take => {
            let hit = null;
            try { hit = clip('intersect', parcelFeature, take.feature); } catch (_) { hit = null; }
            if (!hit || !(t.area(hit) > MIN_PIECE_M2)) return;
            takersUsed.push(take.id);
            takenParts.push(hit);
            taken = taken ? (clip('union', taken, hit) || taken) : hit;
        });

        if (!taken) {
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
                ? relevant
                    .filter(take => {
                        try {
                            const hit = clip('intersect', feature, take.feature);
                            return !!hit && t.area(hit) > MIN_PIECE_M2;
                        } catch (_) { return false; }
                    })
                    .map(take => take.id)
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
    function takesOverlapping(parcel, takes) {
        const t = T();
        if (!t) return [];
        const parcelFeature = featureOf(parcel);
        if (!parcelFeature) return [];
        return (Array.isArray(takes) ? takes : []).filter(take => {
            if (!take || !take.geometry) return false;
            const feature = featureOf(take.geometry);
            if (boxesDisjoint(t, parcelFeature, feature)) return false;
            try {
                const hit = clip('intersect', parcelFeature, feature);
                return !!hit && t.area(hit) > MIN_PIECE_M2;
            } catch (_) { return false; }
        });
    }

    /**
     * The fabric over a set of cadastral parcels: every piece of every parcel, given every take.
     * The whole-plan derivation and a one-road recompute are the SAME function — the second just
     * passes fewer parcels — so the fast path cannot drift from the canonical one.
     *
     * @param {Array<{id: string, feature: object}>} parcels  cadastral parcels to arrange.
     * @param {Array<{id: string, geometry: object}>} takes   every applied corridor.
     * @returns {{pieces: Array, failed: Array<{parcelId: string, error: string}>}}
     */
    function fabricOver(parcels, takes) {
        const pieces = [];
        const failed = [];
        (Array.isArray(parcels) ? parcels : []).forEach(entry => {
            if (!entry || !entry.feature || !entry.id) return;
            try {
                pieces.push(...arrangementOf(entry.feature, entry.id, takes).pieces);
            } catch (error) {
                // One unusable parcel is recorded and skipped; it must not void the rest of the map.
                failed.push({ parcelId: String(entry.id), error: String(error && error.message || error) });
            }
        });
        return { pieces, failed };
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
        diffPieces,
        featureForPiece,
        takesOverlapping,
        pieceId,
        isPieceId,
        canonicalPolygon
    };

    // Namespaced only — a bare global here could shadow one of the top-level functions in the
    // classic scripts loaded alongside this file.
    if (typeof window !== 'undefined') window.__parcelArrangement = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
