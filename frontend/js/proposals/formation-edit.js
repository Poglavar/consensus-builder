// Pure geometry and identity rules for stamping one flat formation over the live fabric.
// Edits mint a replacement proposal and the fabric is replayed from immutable cadastre, so this
// module deliberately contains no restore, previous-generation matching, or unloaded-parent
// recovery machinery.
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

    const DEFAULT_TOLERANCE_PCT = 1;
    const DEFAULT_TOLERANCE_M2 = 1;
    // Slivers below this are rounding, not land.
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

    // The formation token and index a derived id carries: 'HR-1-824#c-tok-3' →
    // { base: 'HR-1-824', token: 'c-tok', index: 3 }. Null for base ids. The base keeps any
    // deeper derivation intact ('x#c-a-1#c-b-2' → base 'x#c-a-1', token 'c-b') — callers that
    // need the cadastral root flatten with baseIdOf.
    function derivedIdParts(parcelId) {
        const id = (parcelId === undefined || parcelId === null) ? '' : String(parcelId).trim();
        const match = id.match(/^(.+)#([A-Za-z0-9_-]+)-(\d+)$/);
        if (!match) return null;
        return { base: match[1], token: match[2], index: Number(match[3]) };
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

    // §15b (decision 2026-08-06): the taker AMENDS the taken — one partition, latest wins.
    // Clip a formation's authored pieces by the ground a newer action took. Carry fields survive
    // on every output piece; a piece the taking SPLITS becomes several pieces (a parcel is ONE
    // connected piece of ground); a residual sliver below the floor is dropped as rounding, and
    // a fully-taken piece leaves the list. Pieces the taking does not touch are returned by
    // REFERENCE, so callers can cheaply tell churn from change.
    //
    //   pieces:  [{ geometry, ...carry }]   (each entry's non-geometry fields ride along)
    //   returns { changed, pieces, takenAreaM2, removedCount, splitCount }
    function clipPiecesByTaking(pieces, takenFootprint, ctx, options) {
        const opts = options || {};
        const minPieceM2 = Number.isFinite(opts.minPieceM2) ? opts.minPieceM2 : MIN_DELTA_PIECE_M2;
        const taken = asFeature(takenFootprint);
        const list = Array.isArray(pieces) ? pieces : [];
        if (!taken || !ctx || typeof ctx.difference !== 'function') {
            return { changed: false, pieces: list.slice(), takenAreaM2: 0, removedCount: 0, splitCount: 0 };
        }
        const out = [];
        let changed = false;
        let takenAreaM2 = 0;
        let removedCount = 0;
        let splitCount = 0;
        list.forEach(piece => {
            const feature = piece ? asFeature(piece.geometry || piece) : null;
            if (!feature) { out.push(piece); return; }
            const overlap = safeIntersectionArea(ctx, feature, taken);
            if (overlap <= minPieceM2) { out.push(piece); return; } // untouched (or rounding)
            let residual = null;
            try { residual = asFeature(ctx.difference(feature, taken)); } catch (_) { residual = null; }
            const before = safeArea(ctx, feature);
            const left = safeArea(ctx, residual);
            if (!residual || left < minPieceM2) {
                // Fully taken: the piece leaves the plan.
                changed = true;
                removedCount += 1;
                takenAreaM2 += before;
                return;
            }
            changed = true;
            takenAreaM2 += Math.max(0, before - left);
            const geom = residual.geometry;
            const parts = geom.type === 'MultiPolygon'
                ? (geom.coordinates || []).map(coordinates => ({ type: 'Polygon', coordinates }))
                : [geom];
            const kept = parts
                .map(poly => ({ ...piece, geometry: poly }))
                .filter(candidate => safeArea(ctx, asFeature(candidate.geometry)) >= minPieceM2);
            if (kept.length === 0) { removedCount += 1; return; }
            if (kept.length > 1) splitCount += kept.length - 1;
            out.push(...kept);
        });
        return { changed, pieces: out, takenAreaM2, removedCount, splitCount };
    }

    // The ROAD form of the §15b amendment: trim a corridor centerline by the ground a newer
    // action took. Each segment is split where it crosses the taken polygon; pieces whose
    // midpoint lies INSIDE are the taken stretch and leave the definition; pieces shorter than
    // `minPieceM` are endpoint slivers, dropped as rounding. A crossing segment therefore
    // becomes two segments (the road may disconnect — the caller's split machinery owns that).
    //
    //   segments: [[{lat,lng},…], …]      ctx: { lineSplit, pointInPolygon, lengthM }
    //   returns  { changed, segments: [{ points, sourceIndex }], removedCount, splitCount }
    //
    // sourceIndex maps every surviving piece to the segment it came from, so the caller can
    // carry per-segment metadata (ids, profiles) across the trim.
    function trimCenterlineByTaking(segments, takenFootprint, ctx, options) {
        const opts = options || {};
        const minPieceM = Number.isFinite(opts.minPieceM) ? opts.minPieceM : 1;
        const taken = asFeature(takenFootprint);
        const list = Array.isArray(segments) ? segments : [];
        const out = [];
        let changed = false;
        let removedCount = 0;
        let splitCount = 0;
        if (!taken || !ctx || typeof ctx.lineSplit !== 'function' || typeof ctx.pointInPolygon !== 'function') {
            return {
                changed: false,
                segments: list.map((points, sourceIndex) => ({ points, sourceIndex })),
                removedCount: 0,
                splitCount: 0
            };
        }
        const midpointInside = coords => {
            if (!Array.isArray(coords) || coords.length < 2) return false;
            const mid = Math.floor((coords.length - 1) / 2);
            const a = coords[mid];
            const b = coords[mid + 1] || a;
            const point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            try { return ctx.pointInPolygon(point, taken) === true; } catch (_) { return false; }
        };
        list.forEach((points, sourceIndex) => {
            const coords = (Array.isArray(points) ? points : [])
                .filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
                .map(p => [p.lng, p.lat]);
            if (coords.length < 2) { out.push({ points, sourceIndex }); return; }
            const line = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
            let pieces = null;
            try {
                const split = ctx.lineSplit(line, taken);
                pieces = (split && Array.isArray(split.features) && split.features.length) ? split.features : [line];
            } catch (_) { pieces = [line]; }
            // A segment changes ONLY when part of it lies INSIDE the taking. A boundary graze —
            // lineSplit firing at a junction where the centerline touches the taken ground's
            // edge — is not a taking, and dropping its sub-metre kerf would churn the victim's
            // record (editSeq, persist, redraw) on every such taker. Untouched segments return
            // by REFERENCE (same contract as clipPiecesByTaking).
            const anyInside = pieces.some(piece => {
                const pc = piece && piece.geometry && piece.geometry.coordinates;
                return Array.isArray(pc) && pc.length >= 2 && midpointInside(pc);
            });
            if (!anyInside) {
                out.push({ points, sourceIndex });
                return;
            }
            const kept = [];
            pieces.forEach(piece => {
                const pc = piece && piece.geometry && piece.geometry.coordinates;
                if (!Array.isArray(pc) || pc.length < 2) return;
                if (midpointInside(pc)) { changed = true; return; } // the taken stretch
                let lengthM = Infinity;
                if (typeof ctx.lengthM === 'function') {
                    try { lengthM = ctx.lengthM(piece); } catch (_) { lengthM = Infinity; }
                }
                if (lengthM < minPieceM) { changed = true; return; } // sliver beside the taken stretch
                kept.push(pc.map(([lng, lat]) => ({ lat, lng })));
            });
            if (kept.length === 0) {
                changed = true;
                removedCount += 1;
                return;
            }
            if (kept.length > 1) splitCount += kept.length - 1;
            kept.forEach(pieceCoords => out.push({ points: pieceCoords, sourceIndex }));
        });
        return { changed, segments: out, removedCount, splitCount };
    }

    // Connected components of a corridor graph — the contiguity test behind the 2026-08-07
    // ruling (a road proposal is ONE contiguous stretch; disconnected stretches are separate
    // proposals). Two segments connect when an ENDPOINT of one coincides with any VERTEX of
    // the other: normalizeCorridorGraph gives a T-branch and its through-segment a shared
    // node without splitting the through polyline, so the junction lives mid-polyline.
    // segments: [[{lat,lng},…], …] → arrays of segment indices, largest component first.
    function corridorComponents(segments, options) {
        const opts = options || {};
        const tolM = Number.isFinite(opts.toleranceM) ? opts.toleranceM : 0.05;
        const list = Array.isArray(segments) ? segments : [];
        const verts = list.map(points => (Array.isArray(points) ? points : [])
            .filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)));
        const ends = verts.map(pts => (pts.length ? [pts[0], pts[pts.length - 1]] : []));
        const parent = list.map((_, i) => i);
        const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
        const closeM = (a, b) => {
            const latRad = ((a.lat + b.lat) / 2) * Math.PI / 180;
            const dx = (a.lng - b.lng) * 111320 * Math.cos(latRad);
            const dy = (a.lat - b.lat) * 111320;
            return Math.sqrt(dx * dx + dy * dy) <= tolM;
        };
        const touches = (i, j) => ends[i].some(e => verts[j].some(v => closeM(e, v)))
            || ends[j].some(e => verts[i].some(v => closeM(e, v)));
        for (let i = 0; i < list.length; i += 1) {
            for (let j = i + 1; j < list.length; j += 1) {
                if (find(i) !== find(j) && touches(i, j)) union(i, j);
            }
        }
        const groups = new Map();
        list.forEach((_, i) => {
            const root = find(i);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root).push(i);
        });
        return Array.from(groups.values()).sort((a, b) => b.length - a.length);
    }

    function corridorWidthMeters(definition) {
        const widths = [];
        const add = value => {
            const width = Number(value);
            if (Number.isFinite(width) && width > 0) widths.push(width);
        };
        const profileWidth = profile => {
            if (!profile || !Array.isArray(profile.strips)) return 0;
            return profile.strips.reduce((sum, strip) => sum + (Number(strip && strip.width) || 0), 0);
        };
        add(definition && definition.width);
        add(profileWidth(definition && definition.profile));
        Object.values((definition && definition.segmentProfiles) || {}).forEach(profile => add(profileWidth(profile)));
        return widths.length ? Math.max(...widths) : 0;
    }

    // A road victim is represented by its centreline and a centred cross-section. Cutting that
    // centreline at the taker's exact boundary leaves the road's half-width protruding back into
    // the taking; replay then trims it again, moving the endpoint on every reload. Expand the taking
    // by the victim's half-width before trimming so the re-derived footprint is disjoint in one pass.
    function roadCenterlineTaking(definition, takenFootprint, ctx, options) {
        const taken = asFeature(takenFootprint);
        if (!taken || !ctx || typeof ctx.buffer !== 'function') return taken;
        const opts = options || {};
        const width = corridorWidthMeters(definition);
        if (!(width > 0)) return taken;
        const clearanceM = width / 2 + (Number.isFinite(opts.paddingM) ? opts.paddingM : 0.05);
        try {
            return ctx.buffer(taken, clearanceM) || taken;
        } catch (_) {
            return taken;
        }
    }

    // §15c severance test (drawing-board rules 2/3; footprint ruling 2026-08-07): a proposal's
    // footprint must stay ONE connected piece through any amendment. A taking that fully
    // consumes the pool, or leaves it in more than one meaningful part, SEVERS the
    // readjustment — it is destroyed and the taker applies against the cadastre beneath.
    // Anything less is rule 3: the cut REDUCES output parcels, SPLITS one into two output
    // parcels, or destroys those fully under it, without touching the readjustment's life.
    // Sub-sliver crumbs below minPartM2 never count as parts.
    // Returns { verdict: 'unaffected' | 'reduced' | 'severed', touchedPlots, destroyedPlots }.
    function severanceVerdict(plan, poolGeometry, takenFootprint, ctx, options) {
        const opts = options || {};
        const minPartM2 = Number.isFinite(opts.minPartM2) ? opts.minPartM2 : 1;
        const taken = asFeature(takenFootprint);
        const out = { verdict: 'unaffected', touchedPlots: 0, destroyedPlots: 0, splitPlots: 0 };
        if (!taken || !ctx || typeof ctx.difference !== 'function') return out;

        const meaningfulParts = geometry => {
            if (!geometry) return 0;
            const polys = geometry.type === 'MultiPolygon'
                ? geometry.coordinates.map(coords => ({ type: 'Polygon', coordinates: coords }))
                : [geometry];
            return polys.filter(poly => safeArea(ctx, { type: 'Feature', properties: {}, geometry: poly }) >= minPartM2).length;
        };
        const clipParts = geometry => {
            const feature = asFeature(geometry);
            if (!feature) return null;
            const overlap = safeIntersectionArea(ctx, feature, taken);
            if (overlap < MIN_DELTA_PIECE_M2) return { touched: false, parts: meaningfulParts(feature.geometry) };
            let diff = null;
            try { diff = ctx.difference(feature, taken); } catch (_) { diff = null; }
            return { touched: true, parts: diff && diff.geometry ? meaningfulParts(diff.geometry) : 0 };
        };

        let touched = false;
        let poolFragmented = false;
        let poolConsumed = false;

        const pool = clipParts(poolGeometry);
        if (pool && pool.touched) {
            touched = true;
            if (pool.parts > 1) poolFragmented = true;
            if (pool.parts === 0) poolConsumed = true; // the whole domain taken
        }

        const polygons = plan && Array.isArray(plan.polygons) ? plan.polygons : [];
        polygons.forEach(slice => {
            const result = clipParts(slice && slice.geometry);
            if (!result || !result.touched) return;
            touched = true;
            out.touchedPlots += 1;
            if (result.parts === 0) out.destroyedPlots += 1;      // fully under the cut — rule 3
            else if (result.parts > 1) out.splitPlots += 1;        // an output parcel cut in two
        });

        // Severance is purely geometric (ruling 2026-08-07): the footprint may shrink but never
        // disconnect. A fragmented or consumed pool severs regardless of what happened to
        // individual plots; a plot split while the domain holds together stays rule 3 (the plot
        // becomes two contiguous output parcels).
        const severed = poolConsumed || poolFragmented;
        out.verdict = severed ? 'severed' : (touched ? 'reduced' : 'unaffected');
        return out;
    }

    // The reparcellization form of the §15b amendment: the plan's authored plots lose the taken
    // ground. The plots ARE the plan (the §14.2 pool and remainders re-derive from them at
    // apply), so amending the polygons amends the readjustment.
    function amendReparcellizationPlanByTaking(plan, takenFootprint, ctx, options) {
        const polygons = plan && Array.isArray(plan.polygons) ? plan.polygons : null;
        if (!polygons || !polygons.length) {
            return { changed: false, polygons: polygons || [], takenAreaM2: 0, removedCount: 0, splitCount: 0 };
        }
        const result = clipPiecesByTaking(polygons, takenFootprint, ctx, options);
        return {
            changed: result.changed,
            polygons: result.pieces,
            takenAreaM2: result.takenAreaM2,
            removedCount: result.removedCount,
            splitCount: result.splitCount
        };
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
        MIN_DELTA_PIECE_M2,
        baseIdOf,
        derivedIdParts,
        baseIdsOfFeatures,
        overlappingBaseIds,
        applyCarriedIdentity,
        clipPiecesByTaking,
        amendReparcellizationPlanByTaking,
        severanceVerdict,
        trimCenterlineByTaking,
        corridorComponents,
        corridorWidthMeters,
        roadCenterlineTaking,
        wholeParcelTakePlan
    };
});
