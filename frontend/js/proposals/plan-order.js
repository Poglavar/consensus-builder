// Base-parcel ancestry and apply ordering for a plan, derived from GEOMETRY rather than from ids.
// See rethink-proposals.md. Pure: plain GeoJSON + plain objects in and out, no DOM, no map, no
// storage. `turf` resolves to the runtime global (window.turf in the browser, global.turf in tests),
// captured at call time so a late turf load still works.
//
// Why this exists. Today a proposal names the land it affects with DERIVED parcel ids
// (HR-339270-823/1#p-road-2), which are re-minted on every apply and therefore exist in exactly one
// browser. Measured on the live plan 97-104: 3 of 14 such references were already dead on the server,
// and two proposals were each other's ancestor — an unsatisfiable cycle — despite intersecting in
// 0 m². This module replaces both mechanisms:
//
//   ancestry  -> the BASE cadastral parcels a footprint intersects. Same on every machine.
//   ordering  -> only fabric-changers whose footprints INTERSECT constrain each other, and those
//                pairs are ordered by creation time. Creation time is a total order, so the induced
//                partial order is acyclic by construction: a cycle cannot be represented, let alone
//                deadlock a plan.
//
// Replaying the live plan through all 24 permutations showed order only ever mattered for the two
// intersecting pairs, and by exactly the intersection area; roads that do not touch commute exactly.

(function (global) {
    'use strict';

    const T = () => (typeof turf !== 'undefined' && turf)
        ? turf
        : (typeof require === 'function' ? require('@turf/turf') : null);

    // Below this an intersection is shared-border noise from coordinate rounding, not a real
    // relationship. Two parcels that merely abut produce slivers of a few cm².
    const MIN_INTERSECTION_M2 = 2;

    // Typologies that CONSUME parcels and mint new ones. Everything else (building, park, square,
    // lake, stations) overlays: it draws on top and changes no boundary, so it can never constrain
    // another proposal's order. apply/buildings.js and apply/structures.js never touch the parcel
    // layer at all, which is what makes this split real rather than a naming convention.
    const FABRIC_GOALS = Object.freeze(['reparcellization', 'road-track', 'decide-later']);

    function isFabricGoal(goal) {
        return FABRIC_GOALS.indexOf(String(goal || '').trim()) !== -1;
    }

    // HR-339270-823/1#p-road-2#p-other-1  ->  HR-339270-823/1
    // Derived ids can nest, so strip repeatedly until the id stops changing.
    function cadastreRootId(parcelId) {
        let current = (parcelId === undefined || parcelId === null) ? '' : String(parcelId).trim();
        let previous = '';
        while (current && current !== previous) {
            previous = current;
            current = current.replace(/#[A-Za-z0-9_-]+-\d+$/i, '');
        }
        return current;
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

    // Roads drawn before the corridor rework stored only a centerline and a width — no polygon. For
    // ANCESTRY (which cadastral parcels does this cover) a buffered centerline is enough: we threshold
    // at 2 m² anyway, and the difference from the app's rectangular-segment construction is confined
    // to corner mitring. This is deliberately NOT cut geometry and must never be used as such — the
    // authoritative corridor is calculateRoadPolygon() in road-drawing.js.
    function corridorFootprintFromCenterline(definition) {
        const t = T();
        const width = Number(definition && definition.width);
        if (!t || !definition || !Number.isFinite(width) || width <= 0) return null;

        const raw = definition.points;
        if (!Array.isArray(raw) || !raw.length) return null;
        const isLatLng = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
        // Either a single centerline or a list of disjoint ones.
        const segments = isLatLng(raw[0]) ? [raw] : raw.filter(s => Array.isArray(s) && s.length >= 2 && isLatLng(s[0]));

        const buffered = [];
        segments.forEach(segment => {
            const coords = segment.filter(isLatLng).map(p => [p.lng, p.lat]);
            if (coords.length < 2) return;
            try {
                const band = t.buffer(t.lineString(coords), width / 2, { units: 'meters', steps: 8 });
                if (band && band.geometry) buffered.push(band);
            } catch (_) { /* a degenerate centerline contributes nothing */ }
        });
        if (!buffered.length) return null;

        let acc = buffered[0];
        for (let i = 1; i < buffered.length; i++) {
            try { acc = t.union(acc, buffered[i]) || acc; } catch (_) { /* keep what we have */ }
        }
        return acc;
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
        const definition = (proposal.roadProposal && proposal.roadProposal.definition)
            || proposal.definition
            || (proposal.geometry && proposal.geometry.roadPlan);
        if (definition && definition.polygon) push(definition.polygon);
        else if (definition) push(corridorFootprintFromCenterline(definition));
        if (proposal.structureProposal && proposal.structureProposal.geometry) push(proposal.structureProposal.geometry);
        if (proposal.geometry && /Polygon/.test(proposal.geometry.type || '')) push(proposal.geometry);
        if (proposal.buildingGeometry) push(proposal.buildingGeometry);
        if (proposal.geometry && Array.isArray(proposal.geometry.buildings)) proposal.geometry.buildings.forEach(push);

        if (!polys.length) return null;
        let acc = polys[0];
        for (let i = 1; i < polys.length; i++) {
            try { acc = t.union(acc, polys[i]) || acc; } catch (_) { /* keep what we have */ }
        }
        return acc;
    }

    // The cadastral ancestry to store on a proposal: what its geometry actually covers, plus the
    // roots of whatever it declared, so a proposal is never recorded as touching LESS than it claims.
    function computeCadastreParcelIds(proposal, baseParcels, options) {
        const geometric = computeBaseAncestry(footprintOf(proposal), baseParcels, options).map(hit => hit.id);
        const declared = cadastreIdsFromDeclared(proposal && proposal.parentParcelIds);
        const merged = geometric.slice();
        declared.forEach(id => { if (merged.indexOf(id) === -1) merged.push(id); });
        return merged;
    }

    function intersectionArea(a, b) {
        const t = T();
        if (!t || !a || !b) return 0;
        try {
            const hit = t.intersect(a, b);
            return hit ? t.area(hit) : 0;
        } catch (_) {
            // A self-intersecting or otherwise degenerate footprint must not take the whole plan
            // down; treat it as "no measurable relationship" and let the caller see it in warnings.
            return 0;
        }
    }

    // The base cadastral parcels a footprint actually covers, largest share first.
    // `baseParcels` is [{ id, feature }] — whatever the caller has loaded for the area.
    function computeBaseAncestry(footprint, baseParcels, options) {
        const opts = options || {};
        const minArea = Number.isFinite(opts.minAreaM2) ? opts.minAreaM2 : MIN_INTERSECTION_M2;
        if (!footprint || !Array.isArray(baseParcels)) return [];

        const hits = [];
        baseParcels.forEach(entry => {
            if (!entry || !entry.feature || !entry.id) return;
            const area = intersectionArea(footprint, entry.feature);
            if (area >= minArea) hits.push({ id: String(entry.id), area: Math.round(area) });
        });
        hits.sort((a, b) => b.area - a.area || String(a.id).localeCompare(String(b.id)));
        return hits;
    }

    // Which fabric-changing proposals genuinely constrain each other. Overlays are excluded outright,
    // and two fabric-changers with disjoint footprints get no edge — they commute.
    // `proposals` is [{ id, goal, footprint, createdAt }].
    function buildConstraintGraph(proposals, options) {
        const opts = options || {};
        const minArea = Number.isFinite(opts.minAreaM2) ? opts.minAreaM2 : MIN_INTERSECTION_M2;
        const list = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
        const fabric = list.filter(p => isFabricGoal(p.goal) && p.footprint);

        const edges = [];
        for (let i = 0; i < fabric.length; i++) {
            for (let j = i + 1; j < fabric.length; j++) {
                const a = fabric[i], b = fabric[j];
                const area = intersectionArea(a.footprint, b.footprint);
                if (area < minArea) continue;
                // The earlier proposal cuts first; the later one operates on what is left. Ties fall
                // back to id so the order is total and deterministic even with equal timestamps.
                const aFirst = compareCreation(a, b) <= 0;
                edges.push({
                    from: aFirst ? a.id : b.id,
                    to: aFirst ? b.id : a.id,
                    intersectionM2: Math.round(area)
                });
            }
        }
        return { edges, fabricIds: fabric.map(p => p.id) };
    }

    function compareCreation(a, b) {
        const at = Date.parse(a && a.createdAt) || 0;
        const bt = Date.parse(b && b.createdAt) || 0;
        if (at !== bt) return at - bt;
        return String(a && a.id).localeCompare(String(b && b.id));
    }

    // A valid apply order for the plan. Because every edge points from earlier to later in a single
    // total ordering, sorting by that ordering already satisfies every edge — there is nothing to
    // topologically sort and no cycle to detect. The graph is returned so callers can show WHICH
    // pairs actually constrain each other (usually very few) and audit the claim.
    function resolveApplyOrder(proposals, options) {
        const list = (Array.isArray(proposals) ? proposals.filter(Boolean) : []).slice();
        const graph = buildConstraintGraph(list, options);
        const ordered = list.slice().sort(compareCreation);

        const position = new Map(ordered.map((p, i) => [p.id, i]));
        // Assertion, not decoration: if this ever fires the invariant above has been broken.
        const violated = graph.edges.filter(e => position.get(e.from) > position.get(e.to));

        return {
            order: ordered.map(p => p.id),
            constraints: graph.edges,
            unconstrained: ordered
                .filter(p => isFabricGoal(p.goal))
                .map(p => p.id)
                .filter(id => !graph.edges.some(e => e.from === id || e.to === id)),
            overlays: ordered.filter(p => !isFabricGoal(p.goal)).map(p => p.id),
            violated
        };
    }

    const api = {
        MIN_INTERSECTION_M2,
        FABRIC_GOALS,
        isFabricGoal,
        intersectionArea,
        cadastreRootId,
        cadastreIdsFromDeclared,
        footprintOf,
        computeCadastreParcelIds,
        computeBaseAncestry,
        buildConstraintGraph,
        resolveApplyOrder
    };

    // Namespaced only — a bare global here could shadow one of the existing top-level functions in
    // the classic scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__planOrder = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
