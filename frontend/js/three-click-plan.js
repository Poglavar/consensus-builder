// What one click in the 3D model view does (three-mode.js handleParcelClick). Every click is also
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
//     groundParcelId    the parcel slab under the click point, or null off the loaded ground
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
            // The proposal's own parcel slice under the point: the slab the ray reaches through a
            // tall or leaning design can be the neighbour's.
            plan.parcel = view(picked.parcelId ? String(picked.parcelId) : ground);
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

    return { planThreeClick, clickKey };
});
