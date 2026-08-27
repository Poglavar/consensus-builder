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

    // Below this an intersection is shared-border noise from coordinate rounding, not a real
    // relationship. Two parcels that merely abut produce slivers of a few cm².
    //
    // The floor is the MEASURED noise, not a judgement about what size of take "matters". Measured
    // on real Zagreb fabric (2026-08-08): across 20,001 bbox-adjacent cadastral pairs only 8 overlap
    // at all — three at 0.001 m², three at 0.100 m², and two genuine data defects at 1577/1859 m².
    // So pure rounding noise tops out around 0.1 m², and 0.25 gives 2.5x headroom over it.
    //
    // It used to be 2 m², which is 20x above that noise floor, and it silently DISCARDED real
    // takes: a corridor genuinely covering 0.755 m² of parcel 6804/5 never registered the parcel,
    // so the road never cut it and the corridor simply lay on top of ground someone else still
    // owned. That unregistered double-cover is what forced a string of tolerance exceptions
    // elsewhere (the live-fabric overlap allowance, the severance genuine-overlap guard), and it
    // made the parcel unusable: taking it whole for a square took road surface with it, which the
    // severance test — correctly — read as cutting the road in two. Register the take instead.
    const MIN_INTERSECTION_M2 = 0.25;

    // HR-339270-823/1#p-road-2#p-other-1  ->  HR-339270-823/1
    // Derived ids can nest, so strip repeatedly until the id stops changing.
    function cadastreRootId(parcelId) {
        const id = (parcelId === undefined || parcelId === null) ? '' : String(parcelId).trim();
        const modernBase = id.split('#')[0];
        const legacy = modernBase.match(/^(HR-\d+-.+?)_[a-z0-9]+_\d+$/i);
        return legacy ? legacy[1] : modernBase;
    }

    // The cadastral parcels implied by a declared parent list, in order, deduped. This is the floor:
    // it can only recover parcels a proposal already named, so it misses land the geometry covers but
    // the author never declared (measured: one proposal declared 1 parent while covering 5 parcels).
    // Geometry is the better source; this backs it up when parcels are not loaded.
    function cadastreIdsFromDeclared(parentParcelIds) {
        const out = [];
        (Array.isArray(parentParcelIds) ? parentParcelIds : []).forEach(id => {
            const root = cadastreRootId(id);
            if (root && out.indexOf(root) === -1) out.push(root);
        });
        return out;
    }

    // A road's footprint is derived by the same corridor builder used for cutting. Keeping a Turf
    // buffer here produced a second, round-capped acquisition model whose ancestry disagreed with
    // the square-ended parcel cut.
    function corridorFootprintFromCenterline(definition) {
        const t = T();
        const derive = global && typeof global.corridorSurfaceFootprintForDefinition === 'function'
            ? global.corridorSurfaceFootprintForDefinition
            : null;
        if (!t || !definition || !derive) return null;
        try {
            const geometry = derive(definition);
            return geometry && /Polygon/.test(geometry.type || '') ? t.feature(geometry) : null;
        } catch (_) {
            return null;
        }
    }

    // A proposal's own footprint, from whichever geometry its typology carries. Pure GeoJSON in/out.
    function footprintOf(proposal) {
        const t = T();
        if (!t || !proposal) return null;
        const polys = [];
        const push = g => {
            if (!g) return;
            const geom = g.type === 'Feature' ? g.geometry : g;
            if (geom && /Polygon/.test(geom.type || '')) polys.push(t.feature(geom));
        };

        if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons)) {
            proposal.reparcellization.polygons.forEach(p => push(p && p.geometry));
        }
        const definition = proposal.roadProposal && proposal.roadProposal.definition;
        if (definition && definition.polygon) push(definition.polygon);
        else if (definition) push(corridorFootprintFromCenterline(definition));
        if (proposal.structureProposal && proposal.structureProposal.geometry) push(proposal.structureProposal.geometry);
        // A readjustment's authored polygons are its complete footprint. `proposal.geometry` was
        // formerly an apply-time union of whatever live pool it happened to consume; including it
        // made replay depend on historical fabric rather than the published plan.
        if (!proposal.reparcellization && proposal.geometry && /Polygon/.test(proposal.geometry.type || '')) push(proposal.geometry);
        if (proposal.buildingGeometry) push(proposal.buildingGeometry);
        if (proposal.geometry && Array.isArray(proposal.geometry.buildings)) proposal.geometry.buildings.forEach(push);

        if (!polys.length) return null;
        let acc = polys[0];
        for (let i = 1; i < polys.length; i++) {
            try { acc = t.union(acc, polys[i]) || acc; } catch (_) { /* keep what we have */ }
        }
        return acc;
    }

    // The cadastral ancestry to store on a proposal is what its geometry actually covers. Declared
    // ids are hints for loading only; including them here made stale parents into false ground claims.
    function computeCadastreParcelIds(proposal, baseParcels, options) {
        const footprint = footprintOf(proposal);
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
    // ambiguity. Even along a kilometre of shared boundary it adds 0.1 m2 — below the measured
    // 0.25 m2 ancestry floor — and the returned area is clamped to the unbuffered operands, so it
    // cannot manufacture a larger take. The retry runs only after the exact intersection throws.
    const TOPOLOGY_REPAIR_BUFFER_M = 0.0001;

    function intersectionArea(a, b) {
        const t = T();
        if (!t || !a || !b) return 0;
        try {
            const hit = t.intersect(a, b);
            return hit ? t.area(hit) : 0;
        } catch (_) {
            if (typeof t.buffer !== 'function') return 0;
            const retry = (left, right) => {
                try {
                    const repaired = t.buffer(right, TOPOLOGY_REPAIR_BUFFER_M, { units: 'meters' });
                    const hit = repaired ? t.intersect(left, repaired) : null;
                    if (!hit) return 0;
                    const measured = Number(t.area(hit)) || 0;
                    const ceiling = Math.min(Number(t.area(a)) || 0, Number(t.area(b)) || 0);
                    return ceiling > 0 ? Math.max(0, Math.min(measured, ceiling)) : 0;
                } catch (_) {
                    return null;
                }
            };
            // Base-ancestry callers pass the parcel second, which is the useful first repair. The
            // symmetric retry also keeps this exported helper honest for its other callers.
            const repairedB = retry(a, b);
            if (repairedB !== null) return repairedB;
            const repairedA = retry(b, a);
            return repairedA === null ? 0 : repairedA;
        }
    }

    // The base cadastral parcels a footprint actually covers, largest share first.
    // `baseParcels` is [{ id, feature }] — whatever the caller has loaded for the area.
    function computeBaseAncestry(footprint, baseParcels, options) {
        const opts = options || {};
        const minArea = Number.isFinite(opts.minAreaM2) ? opts.minAreaM2 : MIN_INTERSECTION_M2;
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
            const area = intersectionArea(footprint, entry.feature);
            if (area >= minArea) hits.push({ id: String(entry.id), area: Math.round(area) });
        });
        hits.sort((a, b) => b.area - a.area || String(a.id).localeCompare(String(b.id)));
        return hits;
    }

    function recordKey(record) {
        const value = record && (record.proposalId ?? record.key ?? record.id);
        return value === undefined || value === null ? '' : String(value);
    }

    function numericRecordId(record) {
        const candidates = record ? [record.serverProposalId, record.serverId, record.id] : [];
        for (const value of candidates) {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
        }
        return null;
    }

    function compareFormationOrder(a, b) {
        const at = Date.parse(a && a.createdAt) || 0;
        const bt = Date.parse(b && b.createdAt) || 0;
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
        MIN_INTERSECTION_M2,
        intersectionArea,
        cadastreRootId,
        cadastreIdsFromDeclared,
        footprintOf,
        computeCadastreParcelIds,
        computeBaseAncestry,
        compareFormationOrder,
        orderFormations
    };

    // Namespaced only — a bare global here could shadow one of the existing top-level functions in
    // the classic scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__planOrder = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
