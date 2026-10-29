// Base-parcel ancestry and immutable record ordering.
// See rethink-proposals.md. Pure: plain GeoJSON + plain objects in and out, no DOM, no map, no
// storage. `turf` resolves to the runtime global (window.turf in the browser, global.turf in tests),
// captured at call time so a late turf load still works.
//
// Records carry immutable cadastral anchors rather than derived parcel ids, which are replay-local.
// This module owns the two operations needed to keep replay independent of browser/map timing:
//
//   ancestry  -> the BASE cadastral parcels a footprint intersects. Same on every machine.
//   ordering  -> every applied record has one total, immutable order: creation time, server row id,
//                then proposal id. Geometry never decides precedence and map-loading timing cannot
//                change it. Editing creates a new record, so no local edit timestamp is needed.

(function (global) {
    'use strict';

    const T = () => (typeof turf !== 'undefined' && turf)
        ? turf
        : (typeof require === 'function' ? require('@turf/turf') : null);

    // A clip the clipper could not do is a typed ClipFailure, recorded in one place
    // (parcel-arrangement.js clipHealth), never a silent zero.
    const arrangementApi = () => (typeof window !== 'undefined' && window.__parcelArrangement)
        || (typeof require === 'function' ? require('./parcel-arrangement.js') : null);
    const clipFailureOf = (operation, error, context, operands) => {
        const api = arrangementApi();
        return api && typeof api.clipFailure === 'function' ? api.clipFailure(operation, error, context, operands) : error;
    };

    // Whether an intersection is a real relationship or cutting debris is the one shared rule
    // (geometry-tolerances.js isGround: wider than the measured 1 mm noise, or than a design's own
    // toleranceM). An area floor here used to be 2 m², then 0.25 m²; the 2 m² floor silently
    // DISCARDED real takes: a corridor genuinely covering 0.755 m² of parcel 6804/5 never registered
    // the parcel, so the road never cut it and the corridor lay on ground someone else still owned.
    const groundApi = () => (typeof window !== 'undefined' && window.GeometryTolerances)
        || (typeof require === 'function' ? require('../geometry-tolerances.js') : null);

    // A road's footprint is derived by the same corridor builder used for cutting. Keeping a Turf
    // buffer here produced a second, round-capped acquisition model whose ancestry disagreed with
    // the square-ended parcel cut. A failed derivation propagates: a corridor whose land cannot be
    // built must not be cut as if it took nothing (projections.md §3, errors propagate).
    function corridorFootprintFromCenterline(definition, options) {
        const t = options?.turf || T();
        const derive = global && typeof global.corridorSurfaceFootprintForDefinition === 'function'
            ? global.corridorSurfaceFootprintForDefinition
            : null;
        if (!t || !definition || !derive) return null;
        const geometry = derive(definition);
        return geometry && /Polygon/.test(geometry.type || '') ? t.feature(geometry) : null;
    }

    const footprintPartsApi = () => (global && global.__footprintParts)
        ? global.__footprintParts
        : (typeof require === 'function' ? require('./footprint-parts.js') : null);

    // One union per record, not per caller. Unioning the parts of a record that has many (a plan
    // of 1,105 courtyard buildings) takes seconds, and the details panel alone asks for the
    // footprint twice per listed parcel: 116 parcels froze the page for minutes (2026-10-12).
    // Keyed by the record object; the content key catches an in-place edit of its geometry. The
    // cached feature is shared by every caller and treated as immutable: no caller mutates a
    // footprint.
    const footprintCache = new WeakMap();
    const footprintKeyOf = parts => JSON.stringify([parts.polygons, parts.centerline ? parts.centerline.definition : null]);

    // A proposal's own footprint, from whichever geometry its typology carries. Pure GeoJSON in/out.
    // WHICH parts count is defined once in footprint-parts.js (shared with the API and migrations);
    // this only unions them, rebuilding a centreline-only road with the exact corridor builder.
    function footprintOf(proposal, options) {
        const t = options?.turf || T();
        const partsApi = footprintPartsApi();
        if (!t || !proposal || !partsApi) return null;
        const parts = partsApi.footprintParts(proposal);
        if (parts.invalid) return null;
        const cacheable = typeof proposal === 'object';
        const key = cacheable ? footprintKeyOf(parts) : null;
        const cached = cacheable ? footprintCache.get(proposal) : null;
        if (cached && cached.key === key) return cached.footprint;
        const { footprint, complete } = unionParts(parts, t);
        // A centreline whose corridor builder is not loaded yet gives an incomplete footprint;
        // that one is not kept, so the next call tries the builder again.
        if (cacheable && complete) footprintCache.set(proposal, { key, footprint });
        return footprint;
    }

    function unionParts(parts, t) {
        const polys = parts.polygons.map(geometry => t.feature(geometry));
        let complete = true;
        if (parts.centerline) {
            const corridor = corridorFootprintFromCenterline(parts.centerline.definition, { turf: t });
            if (corridor) polys.push(corridor);
            else complete = false;
        }

        if (!polys.length) return { footprint: null, complete };
        // Every part or none: keeping "what we have" after a failed union is a partial footprint
        // that looks whole.
        // The shared parcel clip (parcel-arrangement.js, loaded later and read at call time): a raw
        // union of a layout's plots with a carved courtyard left a three-point sliver ring and threw.
        const arrangement = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./parcel-arrangement.js') : null);
        let acc = polys[0];
        for (let i = 1; i < polys.length; i++) {
            const next = arrangement.clipWith(t, 'union', acc, polys[i], { site: 'plan-order.footprint' });
            if (!next) throw new Error('plan-order: the footprint union of a proposal failed');
            acc = next;
        }
        return { footprint: acc, complete };
    }

    // Geometry-only coverage inspection for explicit repair/audit tools. This result is diagnostic;
    // authored proposal identity always comes from proposal.cadastreParcelIds.
    function cadastreCoverageIdsForGeometry(proposal, baseParcels, options) {
        const footprint = footprintOf(proposal, options);
        if (!footprint) return [];
        return computeBaseAncestry(footprint, baseParcels, options).map(hit => hit.id);
    }

    // Polygon-clipping occasionally cannot close an output ring when two valid polygons reuse a
    // long run of EXACTLY the same vertices. That is not hypothetical: the UPU Borovje
    // readjustment was cut from the cadastral fabric itself, and intersecting its 80-part union
    // with parcel 1791/69 threw here. The caller caught that as zero area and reported 37% live
    // coverage although every square metre was present.
    //
    // Moving one operand outwards by a tenth of a millimetre breaks only the coincident-segment
    // ambiguity. It widens the overlap by 0.1 mm — below the 1 mm noise (geometry-tolerances.js) —
    // and the returned area is clamped to the unbuffered operands, so it cannot manufacture a
    // larger take. The retry runs only after the exact intersection throws.
    const TOPOLOGY_REPAIR_BUFFER_M = 0.0001;

    function intersectionArea(a, b) {
        const hit = intersection(a, b);
        return hit ? hit.area : 0;
    }

    // The overlap of `a` and `b` on the shared clip as { feature, area } (area clamped to the
    // smaller operand), or null when they share nothing.
    function intersection(a, b) {
        const t = T();
        if (!t || !a || !b) return null;
        const measured = hit => {
            if (!hit) return null;
            const ceiling = Math.min(Number(t.area(a)) || 0, Number(t.area(b)) || 0);
            const area = Math.max(0, Math.min(Number(t.area(hit)) || 0, ceiling));
            return area > 0 ? { feature: hit, area } : null;
        };
        try {
            return measured(arrangementApi().clipWith(t, 'intersect', a, b, { site: 'plan-order.intersectionArea' }));
        } catch (error) {
            // Zero area here reads as "the footprint does not stand on this parcel" — a wrong
            // ancestry, a wrong coverage. Only the measured repair below may answer instead.
            if (typeof t.buffer !== 'function') {
                throw clipFailureOf('intersect', error, { site: 'plan-order.intersectionArea' }, [a, b]);
            }
            const retry = (left, right) => {
                try {
                    const repaired = t.buffer(right, TOPOLOGY_REPAIR_BUFFER_M, { units: 'meters' });
                    const hit = repaired
                        ? arrangementApi().clipWith(t, 'intersect', left, repaired, { site: 'plan-order.intersectionRepair' })
                        : null;
                    return { hit: measured(hit) };
                } catch (_) {
                    return null;
                }
            };
            // Base-ancestry callers pass the parcel second, which is the useful first repair. The
            // symmetric retry also keeps this exported helper honest for its other callers.
            const repairedB = retry(a, b);
            if (repairedB !== null) return repairedB.hit;
            const repairedA = retry(b, a);
            if (repairedA !== null) return repairedA.hit;
            // Every repair threw too: the overlap is unknown, so say so.
            throw clipFailureOf('intersect', error, { site: 'plan-order.intersectionArea' }, [a, b]);
        }
    }

    // The base cadastral parcels a footprint reaches into (geometry-tolerances.js: their overlap is
    // ground), largest share first. `baseParcels` is [{ id, feature }] — whatever the caller has
    // loaded for the area. `options.toleranceM` is the design's own allowance, when the caller has
    // the record.
    function computeBaseAncestry(footprint, baseParcels, options) {
        return overlapsOf(footprint, baseParcels, options)
            .filter(hit => hit.ground)
            .map(({ id, area }) => ({ id, area }));
    }

    // Every parcel the footprint overlaps at all, as { id, area, ground }, largest first.
    function overlapsOf(footprint, baseParcels, options) {
        const opts = options || {};
        if (!footprint || !Array.isArray(baseParcels)) return [];

        // Bounding box first. A proposal touches a handful of parcels and is asked against every
        // parcel on the map, so nearly every pair is disjoint — and a disjoint pair costs a full
        // polygon intersection to establish. Four number comparisons decide it instead, and can
        // hide nothing: polygons whose boxes do not overlap cannot overlap.
        const t = (typeof turf !== 'undefined' && turf) ? turf : null;
        let box = null;
        if (t && typeof t.bbox === 'function') {
            try { box = t.bbox(footprint); } catch (_) { box = null; }
        }
        const outsideBox = feature => {
            if (!box) return false;
            let other = null;
            try { other = t.bbox(feature); } catch (_) { return false; }
            return !!other && (box[0] > other[2] || other[0] > box[2] || box[1] > other[3] || other[1] > box[3]);
        };

        const hits = [];
        baseParcels.forEach(entry => {
            if (!entry || !entry.feature || !entry.id) return;
            if (outsideBox(entry.feature)) return;
            const hit = intersection(footprint, entry.feature);
            if (!hit) return;
            // Keep the measured area. Rounding here is not presentation-only: repository coverage
            // sums these values and divides by the exact footprint area. A perfectly covered small
            // building of 11.27 m² therefore used to look only 97.6% covered (11 / 11.27) and was
            // refused before materialization. Callers that display an area can round at the edge.
            hits.push({ id: String(entry.id), area: hit.area, ground: groundApi().isGround(T(), hit.feature, opts.toleranceM) });
        });
        hits.sort((a, b) => b.area - a.area || String(a.id).localeCompare(String(b.id)));
        return hits;
    }

    // How much of a footprint the given parcels cover, and which of them it stands on. An ANCESTOR
    // is a parcel the footprint reaches into (its overlap is ground, computeBaseAncestry), but the
    // COVERED AREA counts every overlap, debris included. Summing only the ancestors' areas left the
    // slivers along shared edges out of the covered area, so a footprint lying wholly inside its
    // parcels read as sticking out: a park snapped onto a neighbouring plot touched a third parcel
    // by 0.09 m², that sliver was dropped from the sum, and the park was refused as extending beyond
    // its parcels (2026-10-17). Parcels of one cadastre do not overlap, so the plain sum is the area
    // of the footprint inside their union; coveredArea is a measurement, not a decision.
    // Returns { hits: ancestors (as computeBaseAncestry), coveredArea: m² }.
    function measureCoverage(footprint, baseParcels, options) {
        const overlaps = overlapsOf(footprint, baseParcels, options);
        return {
            hits: overlaps.filter(hit => hit.ground).map(({ id, area }) => ({ id, area })),
            coveredArea: overlaps.reduce((sum, hit) => sum + (Number(hit.area) || 0), 0)
        };
    }

    function recordKey(record) {
        const value = record && (record.proposalId ?? record.key ?? record.id);
        return value === undefined || value === null ? '' : String(value);
    }

    function numericRecordId(record) {
        const candidates = record ? [record.id] : [];
        for (const value of candidates) {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
        }
        return null;
    }

    // A server record's createdAt is when the SERVER received it (it no longer trusts the client's
    // clock); the time the author created it locally travels as authoredAt. Replay order is
    // authoring order, so authoredAt wins when present — local records have only createdAt, which
    // is their authoring time, so both sides of a share order the same way.
    function formationTime(record) {
        return Date.parse(record && (record.authoredAt || record.createdAt)) || 0;
    }

    function compareFormationOrder(a, b) {
        const at = formationTime(a);
        const bt = formationTime(b);
        if (at !== bt) return at - bt;
        const ai = numericRecordId(a);
        const bi = numericRecordId(b);
        if (ai !== null && bi !== null && ai !== bi) return ai - bi;
        if (ai !== null && bi === null) return -1;
        if (ai === null && bi !== null) return 1;
        return recordKey(a).localeCompare(recordKey(b), undefined, { numeric: true });
    }

    function orderFormations(records) {
        return (Array.isArray(records) ? records.filter(Boolean) : []).slice().sort(compareFormationOrder);
    }

    const api = {
        intersectionArea,
        footprintOf,
        cadastreCoverageIdsForGeometry,
        computeBaseAncestry,
        measureCoverage,
        compareFormationOrder,
        orderFormations
    };

    // Namespaced only — a bare global here could shadow one of the existing top-level functions in
    // the classic scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__planOrder = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
