// What one click in either 3D view does (three-mode.js handleParcelClick). Every click is also
// a parcel click: the parcel under the click point, through whatever stands on it, becomes the
// parcel in view (its figures and outline), while the thing the ray hit first keeps its
// own meaning on top (a massing opens its inspector, an existing building its record, a proposal
// building selects the design without isolating or reframing it, and its own parcel slice is the parcel in view).
// Repeated-click section cycling is handled by ThreeClickStack before scene selection. Pure: the caller
// resolves the pick and the ground parcel and passes what it found.
//
//   planThreeClick({ picked, groundParcelId, viewedParcelId, isolatedParcelId, isolatedProposalId, proposalKnown })
//     picked            pickMapSubjectFromEvent's answer: { planningId } | { builtFeature, parcelId }
//                       | { proposalId, parcelId } | null
//     groundParcelId    the parcel at the visible click point, or null off the loaded ground
//     pointParcelId     for a design hit: the live parcel straight under the point the ray met
//                       it at (a formed plot under a drawn building), or null
//     proposalKnown     whether picked.proposalId resolves to a stored proposal
//   -> { selectMassing, inspectBuilding, clearSelection, proposal, parcel }
//     proposal          null | { id, action: 'select' | 'retain' }
//     parcel            null | { id, action: 'view' | 'retain' | 'clear' }   (id null for 'clear')
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeClickPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function clickKey({ picked, groundParcelId, builtId, proposalKnown } = {}) {
        const ground = groundParcelId ? String(groundParcelId) : null;
        if (picked?.planningId) return JSON.stringify(['permitted', String(picked.planningId), ground]);
        if (picked?.builtFeature && builtId) return JSON.stringify(['built', String(builtId), ground]);
        if (picked?.proposalId && proposalKnown) return JSON.stringify(['designs', String(picked.proposalId), String(picked.parcelId || ground || '')]);
        const parcel = ground || picked?.parcelId;
        return parcel ? JSON.stringify(['parcels', String(parcel)]) : null;
    }

    // Raycasting descends through hidden groups too. Resolve only subjects whose entire scene
    // ancestry is visible; an invisible authored pick mesh may still represent a visible design.
    // The nearest subject is the pick, with the two exceptions the 2D order makes (a design, then
    // the building there, then the permitted massing): a see-through permitted hull or tier
    // (`planningSeeThrough`) gives way to a building or design standing inside it, and a condemned
    // building volume (`condemned`) to the design that takes its place. With nothing of that kind
    // behind it along the ray, the hull or the condemned building itself is the pick.
    // Only a surface is picked: a building's edge and floor lines are drawn detail, and the ray
    // takes a line from a metre away, so a line near the click named its parcel instead of the
    // building it outlines.
    function subjectHit(hits) {
        let yielding = null;
        for (const hit of hits) {
            if (hit.object.isLine || hit.object.isPoints) continue;
            let proposalId = null, parcelId = null, planningId = null, builtFeature = null, visible = true;
            let seeThrough = false, condemned = false;
            for (let object = hit.object; object; object = object.parent) {
                if (object.visible === false) visible = false;
                const data = object.userData || {};
                if (data.planningRepresentationId) planningId = data.planningRepresentationId;
                if (data.planningBuiltFeature) builtFeature = data.planningBuiltFeature;
                if (data.planningSeeThrough) seeThrough = true;
                if (data.condemned) condemned = true;
                if (!proposalId && data.proposalId) proposalId = String(data.proposalId);
                if (!parcelId && data.parcelId) parcelId = String(data.parcelId);
            }
            if (!visible) continue;
            const picked = planningId ? { planningId } : builtFeature && !proposalId
                ? { builtFeature, parcelId } : proposalId || parcelId ? { proposalId, parcelId } : null;
            if (!picked) continue;
            const found = { picked, point: hit.point, distance: hit.distance };
            if (picked.planningId && seeThrough) { if (!yielding) yielding = found; continue; }
            if (picked.builtFeature && condemned) { if (!yielding || yielding.picked.planningId) yielding = found; continue; }
            if (!yielding || picked.proposalId || (picked.builtFeature && yielding.picked.planningId)) return found;
            // Ground, or something that ranks no higher: what gave way was the click after all.
            return yielding;
        }
        return yielding;
    }

    // Google tiles supply a surface position, while identity comes from our source records.
    // Authored geometry wins when it is in front, or when it replaces the raw tile surface at
    // that spot (GPU carving does not remove the tile's CPU raycast triangles).
    function photoHit({ authored, surface, designs = [], built = [] }) {
        const replacesSurface = authored?.picked.proposalId && designs.some(item => !item.onParcel
            && String(item.id) === authored.picked.proposalId);
        if (authored && (!surface || authored.distance <= surface.distance + 0.05 || replacesSurface)) return authored;
        if (!surface) return null;
        const building = built.find(item => !item.onParcel);
        return { point: surface.point, distance: surface.distance,
            picked: building ? { builtFeature: building.feature } : null };
    }

    // Outline segments follow loaded terrain; a missing sample does not become a sea-level point.
    function drapeSegments(segments, heightAt, step = 8) {
        const result = [];
        for (let i = 0; i + 5 < segments.length; i += 6) {
            const [ax, ay, az, bx, by, bz] = segments.slice(i, i + 6);
            const count = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
            let previous = null;
            for (let j = 0; j <= count; j++) {
                const t = j / count, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
                const height = heightAt(x, y);
                const point = typeof height === 'number' && Number.isFinite(height)
                    ? [x, y, height + az + (bz - az) * t] : null;
                if (point && previous) result.push(...previous, ...point);
                previous = point;
            }
        }
        return result;
    }

    function planThreeClick(input) {
        const picked = (input && input.picked) || null;
        const ground = input && input.groundParcelId != null && input.groundParcelId !== '' ? String(input.groundParcelId) : null;
        const viewed = input && input.viewedParcelId != null ? String(input.viewedParcelId) : null;
        const isolated = input && input.isolatedParcelId != null ? String(input.isolatedParcelId) : null;
        const isolatedProposal = input && input.isolatedProposalId != null ? String(input.isolatedProposalId) : null;
        const plan = { selectMassing: null, inspectBuilding: null, clearSelection: false, proposal: null, parcel: null };
        const view = id => (id ? { id, action: 'view' } : null);

        if (picked && picked.planningId) {
            plan.selectMassing = picked.planningId;
            plan.parcel = view(ground);
            return plan;
        }
        if (picked && picked.builtFeature) {
            plan.inspectBuilding = picked.builtFeature;
            plan.parcel = view(ground);
            return plan;
        }
        plan.clearSelection = true;
        if (picked && picked.proposalId && input.proposalKnown) {
            const id = String(picked.proposalId);
            if (isolatedProposal === id) {
                plan.clearSelection = false;
                plan.proposal = { id, action: 'retain' };
                plan.parcel = view(picked.parcelId ? String(picked.parcelId) : ground);
                return plan;
            }
            plan.proposal = { id, action: 'select' };
            // The live parcel under the point the ray met the design at, as the 2D stack shows it
            // (the formed plot a drawn building stands on); else the proposal's own parcel slice.
            // Never the slab the ray would reach through a tall or leaning design: that can be the
            // neighbour's.
            const under = input.pointParcelId != null && input.pointParcelId !== '' ? String(input.pointParcelId) : null;
            plan.parcel = view(under || (picked.parcelId ? String(picked.parcelId) : ground));
            return plan;
        }
        const pid = ground || (picked && picked.parcelId ? String(picked.parcelId) : null);
        if (!pid) {
            if (viewed || isolated || isolatedProposal) plan.parcel = { id: null, action: 'clear' };
            return plan;
        }
        if (pid === isolated || pid === viewed && !isolatedProposal) { plan.clearSelection = false; plan.parcel = { id: pid, action: 'retain' }; return plan; }
        plan.parcel = { id: pid, action: 'view' };
        return plan;
    }

    return { planThreeClick, clickKey, subjectHit, photoHit, drapeSegments };
});
