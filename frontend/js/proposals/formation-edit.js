// A formation edit (a road narrowed or widened, a node dragged, a readjustment boundary moved) is
// an edit to the PARTITION that formation stamps on the ground — never a new generation of it.
// This module holds the pure decisions that make that true (rethink-proposals.md §12 step 5,
// decision 2026-08-05: `cadastral parcel(s) → one formation → content`, flattened along the way):
//
//   - matchPieces:       which output pieces of the new partition ARE pieces of the old one, so
//                        they keep their parcel identity instead of minting a fresh generation.
//   - footprintDelta:    which ground actually changed, so only content standing on it is
//                        disclosed and unapplied (content on unchanged ground is left alone).
//   - retainedUnloadedParents: which declared parents an edit may keep as "off-screen" — never the
//                        editing road's own just-destroyed children (the self-ghost bug).
//   - applyCarriedIdentity / baseIdOf: the flat-anchor bookkeeping.
//
// Pure: plain records in, verdicts out; the caller injects the geometry primitives (turf).
(function (global, factory) {
    'use strict';
    const api = factory();
    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__formationEdit = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Same tolerances as reparcel-edit-impact.js: two pieces are "the same ground" when their
    // areas agree and they overlap almost completely — vertex noise and re-serialisation must not
    // read as a change.
    const DEFAULT_TOLERANCE_PCT = 1;
    const DEFAULT_TOLERANCE_M2 = 1;
    // A reshaped piece still IS its predecessor when they share at least this fraction of the
    // smaller of the two — a remainder that grew a few metres wider keeps its parcel number, the
    // way a cadastral boundary adjustment keeps the parcel it adjusts.
    const DEFAULT_RESHAPE_MIN_SHARE = 0.5;
    // Slivers below this are rounding, not land (plot-heal.js uses the same floor).
    const MIN_DELTA_PIECE_M2 = 0.5;

    function asFeature(geometry) {
        if (!geometry) return null;
        if (geometry.type === 'Feature') return geometry.geometry ? geometry : null;
        return { type: 'Feature', properties: {}, geometry };
    }

    function safeArea(ctx, feature) {
        if (!feature) return 0;
        try { return ctx.area(feature) || 0; } catch (_) { return 0; }
    }

    function safeIntersectionArea(ctx, a, b) {
        if (!a || !b) return 0;
        try { return ctx.intersectionArea(a, b) || 0; } catch (_) { return 0; }
    }

    // The base cadastral id a derived id descends from, however many generations deep — the same
    // repeated-suffix strip _stripSyntheticSuffix performs (`X#a-1#b-2` → `X`). Plain base ids
    // pass through unchanged.
    function baseIdOf(parcelId) {
        let current = (parcelId !== undefined && parcelId !== null) ? String(parcelId).trim() : '';
        if (!current) return '';
        let previous = '';
        while (current && current !== previous) {
            previous = current;
            current = current.replace(/#[A-Za-z0-9_-]+-\d+$/i, '');
        }
        return current;
    }

    // Two features cover the same ground within tolerance: same area, near-total overlap.
    function sameGround(aFeature, bFeature, ctx, options) {
        const opts = options || {};
        const tolPct = Number.isFinite(opts.tolerancePct) ? opts.tolerancePct : DEFAULT_TOLERANCE_PCT;
        const tolM2 = Number.isFinite(opts.toleranceM2) ? opts.toleranceM2 : DEFAULT_TOLERANCE_M2;
        const a = asFeature(aFeature);
        const b = asFeature(bFeature);
        if (!a || !b) return false;
        const areaA = safeArea(ctx, a);
        const areaB = safeArea(ctx, b);
        if (areaA <= 0 || areaB <= 0) return false;
        const tolerance = Math.max(tolM2, areaA * tolPct / 100);
        if (Math.abs(areaA - areaB) > tolerance) return false;
        const shared = safeIntersectionArea(ctx, a, b);
        return (areaA - shared) <= tolerance;
    }

    // Match the pieces of a formation's previous output partition (`before`) against its freshly
    // recomputed one (`after`), so identity can carry over.
    //
    //   before: [{ id, number, baseId, feature, isCorridor }]   — the applied children of the last
    //           apply (feature = their geometry as GeoJSON Feature/geometry)
    //   after:  [{ baseId, feature, isCorridor }]               — the new pieces, pre-identity
    //
    // Corridor pieces match by ROLE, not geometry: the corridor parcel IS the road object, and it
    // keeps its identity through any reshape, exactly as the proposal id itself does. Remainder
    // pieces match per base parcel in two tiers: tier 1 same-ground (unchanged), tier 2 best
    // mutual overlap ≥ reshapeMinShare × the smaller piece (reshaped-but-same). Everything else is
    // added or removed ground.
    //
    // Returns { assignments, unchangedAfterIndices, reshapedAfterIndices,
    //           addedAfterIndices, removedBeforeIndices }
    // where assignments[i] = index into `before` (or null) for after piece i.
    function matchPieces(before, after, ctx, options) {
        const opts = options || {};
        const reshapeMinShare = Number.isFinite(opts.reshapeMinShare) ? opts.reshapeMinShare : DEFAULT_RESHAPE_MIN_SHARE;
        const beforeList = Array.isArray(before) ? before : [];
        const afterList = Array.isArray(after) ? after : [];
        const assignments = afterList.map(() => null);
        const beforeTaken = beforeList.map(() => false);
        const unchanged = new Set();
        const reshaped = new Set();

        // Corridor role match, in order (there is normally exactly one on each side).
        const beforeCorridors = [];
        beforeList.forEach((entry, index) => { if (entry && entry.isCorridor) beforeCorridors.push(index); });
        const afterCorridors = [];
        afterList.forEach((entry, index) => { if (entry && entry.isCorridor) afterCorridors.push(index); });
        for (let k = 0; k < Math.min(beforeCorridors.length, afterCorridors.length); k += 1) {
            const bi = beforeCorridors[k];
            const ai = afterCorridors[k];
            assignments[ai] = bi;
            beforeTaken[bi] = true;
            if (sameGround(beforeList[bi].feature, afterList[ai].feature, ctx, opts)) unchanged.add(ai);
            else reshaped.add(ai);
        }

        // Remainder pieces: per base parcel, best-overlap-first, tier 1 then tier 2.
        const groups = new Map();
        const groupKey = value => (value === undefined || value === null ? '' : String(value));
        afterList.forEach((entry, index) => {
            if (!entry || entry.isCorridor || assignments[index] !== null) return;
            const key = groupKey(entry.baseId);
            if (!groups.has(key)) groups.set(key, { before: [], after: [] });
            groups.get(key).after.push(index);
        });
        beforeList.forEach((entry, index) => {
            if (!entry || entry.isCorridor || beforeTaken[index]) return;
            const key = groupKey(entry.baseId);
            if (!groups.has(key)) return; // no new piece shares this base parcel — the id dies
            groups.get(key).before.push(index);
        });

        groups.forEach(group => {
            if (!group.before.length || !group.after.length) return;
            const pairs = [];
            group.after.forEach(ai => {
                const afterFeature = asFeature(afterList[ai].feature);
                const afterArea = safeArea(ctx, afterFeature);
                if (!afterFeature || afterArea <= 0) return;
                group.before.forEach(bi => {
                    const beforeFeature = asFeature(beforeList[bi].feature);
                    const beforeArea = safeArea(ctx, beforeFeature);
                    if (!beforeFeature || beforeArea <= 0) return;
                    const overlap = safeIntersectionArea(ctx, afterFeature, beforeFeature);
                    if (overlap <= 0) return;
                    pairs.push({ ai, bi, overlap, minArea: Math.min(afterArea, beforeArea), afterFeature, beforeFeature });
                });
            });
            pairs.sort((a, b) => b.overlap - a.overlap);
            // Tier 1: same ground — identity carries, piece counts as unchanged.
            pairs.forEach(pair => {
                if (assignments[pair.ai] !== null || beforeTaken[pair.bi]) return;
                if (!sameGround(pair.beforeFeature, pair.afterFeature, ctx, opts)) return;
                assignments[pair.ai] = pair.bi;
                beforeTaken[pair.bi] = true;
                unchanged.add(pair.ai);
            });
            // Tier 2: reshaped-but-same — identity carries, piece counts as changed ground.
            pairs.forEach(pair => {
                if (assignments[pair.ai] !== null || beforeTaken[pair.bi]) return;
                if (pair.overlap < reshapeMinShare * pair.minArea) return;
                assignments[pair.ai] = pair.bi;
                beforeTaken[pair.bi] = true;
                reshaped.add(pair.ai);
            });
        });

        const addedAfterIndices = [];
        assignments.forEach((value, index) => { if (value === null) addedAfterIndices.push(index); });
        const removedBeforeIndices = [];
        beforeTaken.forEach((taken, index) => { if (!taken) removedBeforeIndices.push(index); });
        return {
            assignments,
            unchangedAfterIndices: Array.from(unchanged).sort((a, b) => a - b),
            reshapedAfterIndices: Array.from(reshaped).sort((a, b) => a - b),
            addedAfterIndices,
            removedBeforeIndices
        };
    }

    // Write a carried identity onto a freshly minted child's properties. Contiguity splits can
    // clone one stamped feature into several parts, so `usedIds` guarantees an id is consumed at
    // most once per assignment run — later duplicates fall through to counter minting.
    // Returns true when the identity was applied.
    function applyCarriedIdentity(props, carried, usedIds) {
        if (!props || !carried || !carried.parcelId) return false;
        const id = String(carried.parcelId);
        if (usedIds && usedIds.has(id)) return false;
        if (usedIds) usedIds.add(id);
        props.parcelId = id;
        if (carried.parcelNumber !== undefined && carried.parcelNumber !== null && String(carried.parcelNumber)) {
            props.BROJ_CESTICE = String(carried.parcelNumber);
        }
        const parsed = id.match(/#([A-Za-z0-9_-]+)-(\d+)$/);
        if (parsed) {
            props.syntheticToken = parsed[1];
            props.syntheticIndex = Number(parsed[2]);
        }
        return true;
    }

    // The ground an edit actually changed: pieces of the old footprint the new one no longer
    // covers, plus pieces of the new footprint the old one did not cover. Content is disclosed
    // and unapplied only when it stands on one of these pieces. Returns
    // { changed, pieces: Feature[] }, or null when the geometry cannot be computed — callers fall
    // back to their conservative path.
    function footprintDelta(beforeGeometry, afterGeometry, ctx, options) {
        const opts = options || {};
        const minPieceM2 = Number.isFinite(opts.minPieceM2) ? opts.minPieceM2 : MIN_DELTA_PIECE_M2;
        const beforeFeature = asFeature(beforeGeometry);
        const afterFeature = asFeature(afterGeometry);
        if (!beforeFeature || !afterFeature || !ctx || typeof ctx.difference !== 'function') return null;
        const pieces = [];
        const collect = diff => {
            const feature = asFeature(diff);
            if (!feature) return;
            const geom = feature.geometry;
            const polys = geom.type === 'MultiPolygon'
                ? (geom.coordinates || []).map(coordinates => ({ type: 'Polygon', coordinates }))
                : (geom.type === 'Polygon' ? [geom] : []);
            polys.forEach(poly => {
                const pieceFeature = asFeature(poly);
                if (safeArea(ctx, pieceFeature) >= minPieceM2) pieces.push(pieceFeature);
            });
        };
        try {
            collect(ctx.difference(beforeFeature, afterFeature));
            collect(ctx.difference(afterFeature, beforeFeature));
        } catch (_) {
            return null;
        }
        return { changed: pieces.length > 0, pieces };
    }

    // Applied proposals standing on changed ground: candidates whose footprint genuinely overlaps
    // a delta piece (a shared boundary line is not standing on it — hence the small area floor).
    // candidates: [{ key, footprint, ... }] — entries pass through untouched.
    function proposalsOnChangedGround(deltaPieces, candidates, ctx, options) {
        const opts = options || {};
        const minM2 = Number.isFinite(opts.minM2) ? opts.minM2 : MIN_DELTA_PIECE_M2;
        const pieces = (Array.isArray(deltaPieces) ? deltaPieces : []).map(asFeature).filter(Boolean);
        if (!pieces.length) return [];
        const out = [];
        (Array.isArray(candidates) ? candidates : []).forEach(entry => {
            if (!entry) return;
            const footprint = asFeature(entry.footprint);
            if (!footprint) return;
            const hit = pieces.some(piece => safeIntersectionArea(ctx, footprint, piece) >= minM2);
            if (hit) out.push(entry);
        });
        return out;
    }

    // Which declared parents a corridor edit keeps as "off-screen, still consumed". A declared
    // parent survives re-derivation only when the new footprint could not check it (its layer is
    // not loaded) AND it is not something this very edit destroyed: the road's own previous
    // children are gone from the loaded-id map precisely because the unapply removed them, so
    // without the ownChildIds exclusion every recut re-declared its own dead generation as
    // "unloaded parents" — the ghost chain this module exists to end.
    // The part of a parcel's ground that live fabric does NOT already own — what a restore may
    // honestly put back on the map. The restorable-parents test is structural (id prefixes) and
    // cannot see cross-token consumption across a dead intermediate generation: un-applying road
    // B restored road A's slice at FULL stale geometry under a readjustment's plots minted two
    // generations later, and the recut baked the overlap into a 3,984 m² remainder covering five
    // live plots. liveEntries: [{ feature }] live parcels near the candidate (bbox-prefiltered is
    // fine; the candidate itself and pieces being removed must not be in the list).
    // Returns { residual, coveredShare } — residual is a bare geometry Feature (callers re-attach
    // their own properties); null when live fabric owns (almost) all of the ground. A candidate
    // covered below `keepWholeShare` keeps its original geometry verbatim, so micro-sliver
    // overlaps cannot churn stored geometry on every restore cycle.
    function residualGround(feature, liveEntries, ctx, options) {
        const opts = options || {};
        const minResidualM2 = Number.isFinite(opts.minResidualM2) ? opts.minResidualM2 : 0.5;
        const keepWholeShare = Number.isFinite(opts.keepWholeShare) ? opts.keepWholeShare : 0.01;
        const candidate = asFeature(feature && feature.geometry ? feature.geometry : feature);
        if (!candidate || !ctx || typeof ctx.difference !== 'function') {
            return { residual: candidate, coveredShare: 0 };
        }
        const total = safeArea(ctx, candidate);
        if (!(total > 0)) return { residual: null, coveredShare: 1 };
        let residual = candidate;
        (Array.isArray(liveEntries) ? liveEntries : []).forEach(entry => {
            if (!residual) return;
            const other = entry && entry.feature ? entry.feature : entry;
            if (!other || !other.geometry) return;
            if (safeIntersectionArea(ctx, residual, other) <= 0) return;
            try { residual = asFeature(ctx.difference(residual, other)); } catch (_) { /* keep as-is */ }
        });
        const left = safeArea(ctx, residual);
        const coveredShare = Math.min(1, Math.max(0, (total - left) / total));
        if (!residual || left < minResidualM2) return { residual: null, coveredShare: 1 };
        if (coveredShare <= keepWholeShare) return { residual: candidate, coveredShare };
        return { residual, coveredShare };
    }

    function retainedUnloadedParents(declaredIds, options) {
        const opts = options || {};
        const touched = new Set((Array.isArray(opts.touchedIds) ? opts.touchedIds : []).map(String));
        const loaded = opts.loadedIds instanceof Set
            ? opts.loadedIds
            : new Set((Array.isArray(opts.loadedIds) ? opts.loadedIds : []).map(String));
        const ownChildren = new Set((Array.isArray(opts.ownChildIds) ? opts.ownChildIds : []).map(String));
        const seen = new Set();
        const kept = [];
        (Array.isArray(declaredIds) ? declaredIds : []).forEach(raw => {
            const id = raw === undefined || raw === null ? '' : String(raw);
            if (!id || seen.has(id)) return;
            seen.add(id);
            if (touched.has(id)) return;
            if (loaded.has(id)) return;
            if (ownChildren.has(id)) return;
            kept.push(id);
        });
        return kept;
    }

    // Unique base cadastral ids under a set of features — the flat declaration a formation writes
    // (`cadastreParcelIds`), derived from what it actually consumed, one hop deep.
    function baseIdsOfFeatures(features) {
        const seen = new Set();
        const out = [];
        (Array.isArray(features) ? features : []).forEach(feature => {
            const props = (feature && feature.properties) || {};
            const raw = props.rootParcelId || props.parcelId || props.parcel_id || props.id || null;
            const baseId = baseIdOf(raw);
            if (baseId && baseId !== 'parcel' && !seen.has(baseId)) {
                seen.add(baseId);
                out.push(baseId);
            }
        });
        return out;
    }

    // Which parents' base ids lie under ONE piece — the per-piece flat anchor for plots that span
    // several base parcels (a comasation plot with thirty parents is one formation at one level
    // with thirty base anchors, §15.1). parentEntries: [{ baseId, feature }].
    function overlappingBaseIds(pieceFeature, parentEntries, ctx, options) {
        const opts = options || {};
        const minM2 = Number.isFinite(opts.minM2) ? opts.minM2 : 1;
        const piece = asFeature(pieceFeature);
        if (!piece) return [];
        const seen = new Set();
        const out = [];
        (Array.isArray(parentEntries) ? parentEntries : []).forEach(entry => {
            if (!entry || !entry.baseId || seen.has(String(entry.baseId))) return;
            const parent = asFeature(entry.feature);
            if (!parent) return;
            if (safeIntersectionArea(ctx, piece, parent) >= minM2) {
                seen.add(String(entry.baseId));
                out.push(String(entry.baseId));
            }
        });
        return out;
    }

    // Whole-parcel taking (decision 2026-08-05): a structure (park/square/lake) ADOPTS the one
    // parcel matching its footprint, or MERGE-TAKES a union of whole parcels into one — never a
    // part of anything. If only part of a parcel is wanted, a road or a land readjustment cuts
    // first; a footprint that partly covers some parcel is refused with the offenders named.
    // candidates: [{ id, feature }] — the live parcels under the footprint.
    // Returns { mode: 'adopt'|'merge'|'refuse', reason, parcelIds, partials, uncoveredShare }.
    function wholeParcelTakePlan(footprint, candidates, ctx, options) {
        const opts = options || {};
        const tolPct = Number.isFinite(opts.tolerancePct) ? opts.tolerancePct : DEFAULT_TOLERANCE_PCT;
        const tolM2 = Number.isFinite(opts.toleranceM2) ? opts.toleranceM2 : DEFAULT_TOLERANCE_M2;
        const foot = asFeature(footprint);
        const footArea = safeArea(ctx, foot);
        if (!foot || footArea <= 0) {
            return { mode: 'refuse', reason: 'no-footprint', parcelIds: [], partials: [], uncoveredShare: 1 };
        }
        const taken = [];
        const partials = [];
        let coveredM2 = 0;
        (Array.isArray(candidates) ? candidates : []).forEach(entry => {
            if (!entry || entry.id === undefined || entry.id === null) return;
            const parcel = asFeature(entry.feature);
            const parcelArea = safeArea(ctx, parcel);
            if (!parcel || parcelArea <= 0) return;
            const overlap = safeIntersectionArea(ctx, foot, parcel);
            if (overlap < tolM2) return; // shares at most a boundary — not under the footprint
            coveredM2 += overlap;
            const outside = parcelArea - overlap;
            if (outside <= Math.max(tolM2, parcelArea * tolPct / 100)) {
                taken.push(String(entry.id));
            } else {
                partials.push({ id: String(entry.id), coveredShare: overlap / parcelArea });
            }
        });
        const uncoveredM2 = Math.max(0, footArea - coveredM2);
        const uncoveredShare = uncoveredM2 / footArea;
        if (partials.length) {
            return { mode: 'refuse', reason: 'partial-parcels', parcelIds: taken, partials, uncoveredShare };
        }
        if (uncoveredM2 > Math.max(tolM2, footArea * tolPct / 100)) {
            return { mode: 'refuse', reason: 'uncovered-ground', parcelIds: taken, partials, uncoveredShare };
        }
        if (!taken.length) {
            return { mode: 'refuse', reason: 'no-parcels', parcelIds: [], partials, uncoveredShare };
        }
        return { mode: taken.length === 1 ? 'adopt' : 'merge', reason: null, parcelIds: taken, partials: [], uncoveredShare };
    }

    return {
        DEFAULT_TOLERANCE_PCT,
        DEFAULT_TOLERANCE_M2,
        DEFAULT_RESHAPE_MIN_SHARE,
        MIN_DELTA_PIECE_M2,
        baseIdOf,
        baseIdsOfFeatures,
        overlappingBaseIds,
        sameGround,
        matchPieces,
        applyCarriedIdentity,
        footprintDelta,
        residualGround,
        proposalsOnChangedGround,
        retainedUnloadedParents,
        wholeParcelTakePlan
    };
});
