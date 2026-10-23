// Claims model (rethink-proposals.md §13): everything clickable on the map is a CLAIM about a
// piece of ground — a proposal's content (building, lake…), a fabric-changer's output piece
// (corridor, remainder, subdivision slice), or the null claim: the bare cadastral parcel itself,
// i.e. "no change proposed here". This module is the pure half — ranking claims, projecting any
// claim back to the base parcels it stands on (the breadcrumb), building a base parcel's
// dossier (every proposal claiming any of its ground), and the two ground-conflict questions:
// which applied records an apply displaces (appliedRivals) and which ones an in-place edit takes
// the ground from (editDependents). No DOM, no Leaflet.

(function (global) {
    'use strict';

    const formationDepth = () => (global && global.__formationDepth)
        ? global.__formationDepth
        : (typeof require === 'function' ? require('./formation-depth.js') : null);

    // Z-order of claims at one spot: content sits on fabric, fabric sits on the ground.
    const CLAIM_RANKS = Object.freeze({ content: 3, fabric: 2, ground: 1 });

    function claimKindForGoal(goal) {
        if (goal === undefined || goal === null || String(goal).trim() === '') return 'ground';
        const api = formationDepth();
        if (api && api.isFormationGoal(goal)) return 'fabric';
        return 'content';
    }

    function claimRank(kind) {
        return CLAIM_RANKS[String(kind || '').trim()] || 0;
    }

    // The base cadastral parcels a proposal stands on. Durable records are normalized at their
    // storage/import boundary, so reading claims is deliberately boring: no generated-id parser,
    // no ancestry walk, and no reconstruction from duplicated typology fields.
    function cadastreParcelIdsOf(proposal) {
        if (!proposal) return [];
        const declared = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
        return Array.from(new Set(declared.map(id => String(id || '').trim()).filter(Boolean)));
    }

    function materializedParcelsOf(proposal) {
        const proposalId = proposal && proposal.proposalId;
        const fabric = global && global.LiveParcelFabric;
        if (!proposalId || !fabric || typeof fabric.producedBy !== 'function') return [];
        return fabric.producedBy(String(proposalId));
    }

    function materializedParcelIdsOf(proposal) {
        const fabric = global && global.LiveParcelFabric;
        return materializedParcelsOf(proposal)
            .map(feature => fabric && typeof fabric.featureId === 'function'
                ? fabric.featureId(feature)
                : feature?.properties?.parcelId)
            .map(value => String(value || '').trim())
            .filter(Boolean);
    }

    // Whether this replay's formation replaces the cadastral layer for one base parcel. The
    // formation's child ids are intentionally irrelevant to the match: a corridor spanning many
    // roots can name its single body after only the first root.
    function formationReplacesCadastreParcel(proposal, parcelId, options) {
        if (!proposal || parcelId === undefined || parcelId === null) return false;
        const opts = options || {};
        const isApplied = typeof opts.isApplied === 'function'
            ? opts.isApplied
            : (item => item?.applied === true);
        if (!isApplied(proposal)) return false;
        const hasMaterializedOutput = typeof opts.hasMaterializedOutput === 'function'
            ? opts.hasMaterializedOutput(proposal)
            : materializedParcelsOf(proposal).length > 0;
        if (!hasMaterializedOutput) return false;
        return cadastreParcelIdsOf(proposal).includes(String(parcelId));
    }

    // Every proposal claiming ground on this base parcel — the dossier a click in cadastre view
    // answers with. A live id is projected through fabric metadata, never its string shape.
    // options.isApplied lets the caller supply the app's real applied-state accessor.
    function dossierFor(parcelId, proposals, options) {
        const opts = options || {};
        const isApplied = (typeof opts.isApplied === 'function')
            ? opts.isApplied
            : (p => p && p.applied === true);
        const parcelKey = String(parcelId || '').trim();
        const fabric = global && global.LiveParcelFabric;
        const liveFeature = fabric && typeof fabric.get === 'function' ? fabric.get(parcelKey) : null;
        // When no live feature exists, this API's parcelId argument is itself an explicit
        // cadastral anchor (used by dossier views and pure callers). No id-format inference is
        // involved; callers holding a live id must supply the fabric entry or explicit roots.
        const roots = Array.isArray(opts.cadastreParcelIds) && opts.cadastreParcelIds.length
            ? opts.cadastreParcelIds.map(String)
            : (liveFeature && typeof fabric.explicitCadastreIds === 'function'
                ? fabric.explicitCadastreIds(liveFeature)
                : (parcelKey ? [parcelKey] : []));
        if (!roots.length) return [];

        const entries = [];
        (Array.isArray(proposals) ? proposals : []).forEach(p => {
            if (!p) return;
            if (!cadastreParcelIdsOf(p).some(id => roots.includes(id))) return;
            const kind = claimKindForGoal(p.goal);
            entries.push({
                proposalId: p.proposalId ? String(p.proposalId) : null,
                title: p.title || p.name || '',
                goal: p.goal || '',
                kind,
                rank: claimRank(kind),
                applied: !!isApplied(p)
            });
        });
        entries.sort((a, b) => (b.rank - a.rank)
            || (Number(b.applied) - Number(a.applied))
            || String(a.title).localeCompare(String(b.title)));
        return entries;
    }

    // ---- Ground conflicts between applied records ----------------------------------------------
    // Geometry is injected (options.planOrder: intersectionArea, footprintOf, compareFormationOrder;
    // options.area; options.footprintParts) so node tests drive the same code the browser runs.

    const planOrderApi = options => (options && options.planOrder)
        || (global && global.__planOrder)
        || (typeof require === 'function' ? require('./plan-order.js') : null);
    const footprintPartsApi = options => (options && options.footprintParts)
        || (global && global.__footprintParts)
        || (typeof require === 'function' ? require('./footprint-parts.js') : null);
    const appliedAccessor = options => (options && typeof options.isApplied === 'function')
        ? options.isApplied
        : (p => p && p.applied === true);
    const recordIdOf = record => {
        const value = record && (record.proposalId || record.id);
        return value === undefined || value === null ? '' : String(value);
    };

    function isBuildingContentProposal(proposal) {
        return !!(proposal && (
            proposal.buildingProposal
            || proposal.buildingGeometry
            || (proposal.geometry && Array.isArray(proposal.geometry.buildings)
                && proposal.geometry.buildings.length)
        ));
    }

    // These are the apply paths that clear proposed buildings under their authored footprint.
    // A parcel layout is intentionally absent: reshaping parcel fabric is not, by itself, choosing
    // a different building design.
    function displacesBuildingContent(proposal) {
        return !!(proposal && (
            isBuildingContentProposal(proposal)
            || proposal.roadProposal
            || proposal.structureProposal
        ));
    }

    // Which applied proposals are in the way of this one, and so must be unapplied before it can
    // be applied. This is the one apply-conflict rule every pair of proposals gets, a
    // counterproposal and its standing source included: there is no lineage exception.
    //
    // The test is GEOMETRIC: an applied proposal is in the way only when the ground it holds
    // actually overlaps the ground this one takes. Sharing a cadastral parcel is NOT enough. Roads
    // and land readjustments cut a cadastral parcel into many plots and a plan puts a different
    // building on each, so judging by parcel identity made every one of them a rival: on the
    // 299-member Sibenik plan that left 34 of 166 buildings applied, each new member unapplying
    // the one before it, while the summary still reported 298 applied.
    //
    // The 2 m² floor is the same one the building-demolition scanner uses.
    function appliedRivals(proposal, records, options = {}) {
        const targetId = recordIdOf(proposal);
        if (!targetId) return [];
        const isApplied = appliedAccessor(options);
        const planOrder = planOrderApi(options);
        const minimumOverlapM2 = Number.isFinite(Number(options.minimumOverlapM2))
            ? Math.max(0, Number(options.minimumOverlapM2))
            : 2;
        // The footprint is unioned only once a candidate actually needs comparing: a plan of
        // 1,105 buildings takes seconds to union, and an explicit apply with nothing applied nearby
        // asked for it for no one (2026-10-12).
        let targetFootprint;
        const targetFootprintOf = () => {
            if (targetFootprint === undefined) {
                targetFootprint = displacesBuildingContent(proposal)
                    && planOrder && typeof planOrder.footprintOf === 'function'
                    ? planOrder.footprintOf(proposal)
                    : null;
            }
            return targetFootprint;
        };

        return (Array.isArray(records) ? records : []).filter(Boolean).filter(candidate => {
            const candidateId = recordIdOf(candidate);
            if (!candidateId || candidateId === targetId || !isApplied(candidate)) return false;
            // A standing park, square or lake holds its ground as exclusively as a building does:
            // a plan member whose footprint lies inside an applied park must be refused, not
            // stacked on top of it (Šibenik, 2026-09-03: a plan re-applied two buildings inside
            // freshly created structures because only buildings counted as rivals).
            // Distinct roads can meet at a junction. Overlapping published revisions of the same
            // road are alternatives, however: keeping both would leave the old traffic profile
            // standing beside its replacement. Lineage only makes this pair eligible for the
            // ordinary geometric test below; a moved copy with no overlap still coexists.
            const roadRevision = proposal.roadProposal && candidate.roadProposal && (
                (proposal.origin?.cid && proposal.origin.cid === candidate.published?.cid)
                || (candidate.origin?.cid && candidate.origin.cid === proposal.published?.cid)
                || (proposal.origin?.cid && proposal.origin.cid === candidate.origin?.cid));
            if (!isBuildingContentProposal(candidate) && !candidate.structureProposal && !roadRevision) return false;
            // A road or track does not displace a park, square or lake it crosses: it cuts through
            // and the rest of the structure stays (the road tool's "Build through"; the carve is
            // apply/road.js _groundAfterLaterCorridors). Buildings it covers still go.
            if (proposal.roadProposal && candidate.structureProposal && !isBuildingContentProposal(candidate)) return false;
            // No measurable footprint on either side means no demonstrable overlap, and ground that
            // cannot be shown to be taken is left free: refusing here would block on a suspicion.
            if (!planOrder || typeof planOrder.footprintOf !== 'function'
                || typeof planOrder.intersectionArea !== 'function' || !targetFootprintOf()) return false;
            const candidateFootprint = planOrder.footprintOf(candidate);
            return candidateFootprint
                ? planOrder.intersectionArea(targetFootprintOf(), candidateFootprint) >= minimumOverlapM2
                : false;
        });
    }

    // Below this a "touch" is a shared boundary or a rounding artefact (plan-order.js
    // MIN_INTERSECTION_M2), not standing on the ground.
    const DEPENDENT_TOUCH_M2 = 0.25;
    // Two parts are the same ground when their overlap holds essentially all of both.
    const SAME_GROUND_FRACTION = 0.999;

    const asFeature = geometry => (geometry && geometry.type === 'Feature')
        ? geometry
        : { type: 'Feature', properties: {}, geometry };

    // Who has to come off the map when an in-place edit changes the ground a record formed. A
    // later applied record depends on the edit when one of its own parts stands on a part of the
    // edited record's previous ground that the edit changed. The link is geometric on purpose:
    // a Block built on a readjustment's child plot declares the PARENT cadastre parcels
    // (cadastreParcelIds), and the child plot ids are replay-local, so neither names the plot it
    // stands on. A part that sits on a plot the edit left exactly as it was is undisturbed.
    // Returns the dependents, oldest first.
    function editDependents(before, after, records, options = {}) {
        const targetId = recordIdOf(before);
        const partsApi = footprintPartsApi(options);
        const planOrder = planOrderApi(options);
        const area = typeof options.area === 'function'
            ? options.area
            : (global && global.turf && typeof global.turf.area === 'function' ? global.turf.area : null);
        if (!targetId || !partsApi || !planOrder || typeof planOrder.intersectionArea !== 'function' || !area) return [];
        const isApplied = appliedAccessor(options);
        const touchM2 = Number.isFinite(options.touchM2) ? options.touchM2 : DEPENDENT_TOUCH_M2;
        const partsOf = record => {
            const parts = record ? partsApi.footprintParts(record) : null;
            return parts && !parts.invalid ? parts.polygons.map(asFeature) : [];
        };
        const sameGround = (a, b) => {
            const shared = planOrder.intersectionArea(a, b) || 0;
            return shared >= SAME_GROUND_FRACTION * Math.max(area(a) || 0, area(b) || 0);
        };
        const afterParts = partsOf(after);
        const changed = partsOf(before).filter(part => !afterParts.some(next => sameGround(part, next)));
        if (!changed.length) return [];
        const later = typeof planOrder.compareFormationOrder === 'function'
            ? candidate => planOrder.compareFormationOrder(before, candidate) < 0
            : () => true;
        const dependents = (Array.isArray(records) ? records : []).filter(candidate => {
            const id = recordIdOf(candidate);
            if (!id || id === targetId || !isApplied(candidate) || !later(candidate)) return false;
            return partsOf(candidate).some(part => changed.some(ground => (planOrder.intersectionArea(part, ground) || 0) >= touchM2));
        });
        return typeof planOrder.compareFormationOrder === 'function'
            ? dependents.sort(planOrder.compareFormationOrder)
            : dependents;
    }

    // A short human label for a base parcel id: "HR-339270-823/1" -> "823/1".
    function shortParcelLabel(parcelId) {
        const s = String(parcelId || '');
        const match = s.match(/^HR-\d+-(.+)$/);
        return match ? match[1] : s;
    }

    const api = {
        CLAIM_RANKS,
        claimKindForGoal,
        claimRank,
        cadastreParcelIdsOf,
        materializedParcelsOf,
        materializedParcelIdsOf,
        formationReplacesCadastreParcel,
        dossierFor,
        isBuildingContentProposal,
        displacesBuildingContent,
        appliedRivals,
        editDependents,
        shortParcelLabel
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__claims = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
