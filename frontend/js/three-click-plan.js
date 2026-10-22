// What one click in the 3D model view does (three-mode.js handleParcelClick). Every click is also
// a parcel click: the parcel under the click point, through whatever stands on it, becomes the
// parcel in view (its panel, its massing, its outline), while the thing the ray hit first keeps its
// own meaning on top (a massing opens its inspector, an existing building its record, a proposal
// building selects and isolates the proposal). Isolation of a parcel, which dims the rest of the
// city, is a deliberate second click on the same parcel; a third click clears it. Pure: the caller
// resolves the pick and the ground parcel and passes what it found.
//
//   planThreeClick({ picked, groundParcelId, viewedParcelId, isolatedParcelId, isolatedProposalId, proposalKnown })
//     picked            pickMapSubjectFromEvent's answer: { planningId } | { builtFeature, parcelId }
//                       | { proposalId, parcelId } | null
//     groundParcelId    the parcel slab under the click point, or null off the loaded ground
//     proposalKnown     whether picked.proposalId resolves to a stored proposal
//   -> { selectMassing, inspectBuilding, clearSelection, proposal, parcel, openMassing }
//     proposal          null | { id, action: 'isolate' | 'clear' }
//     parcel            null | { id, action: 'view' | 'isolate' | 'clear' }   (id null for 'clear')
//     openMassing       whether a viewed parcel's cached massing should open in the inspector
//                       (only when nothing the click hit already claimed the inspector)
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeClickPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function planThreeClick(input) {
        const picked = (input && input.picked) || null;
        const ground = input && input.groundParcelId != null && input.groundParcelId !== '' ? String(input.groundParcelId) : null;
        const viewed = input && input.viewedParcelId != null ? String(input.viewedParcelId) : null;
        const isolated = input && input.isolatedParcelId != null ? String(input.isolatedParcelId) : null;
        const isolatedProposal = input && input.isolatedProposalId != null ? String(input.isolatedProposalId) : null;
        const plan = { selectMassing: null, inspectBuilding: null, clearSelection: false, proposal: null, parcel: null, openMassing: false };
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
            if (isolatedProposal === id) { plan.proposal = { id, action: 'clear' }; return plan; }
            plan.proposal = { id, action: 'isolate' };
            plan.parcel = view(ground);
            return plan;
        }
        const pid = ground || (picked && picked.parcelId ? String(picked.parcelId) : null);
        if (!pid) {
            if (viewed || isolated || isolatedProposal) plan.parcel = { id: null, action: 'clear' };
            return plan;
        }
        if (pid === isolated) { plan.parcel = { id: pid, action: 'clear' }; return plan; }
        if (pid === viewed && !isolatedProposal) { plan.parcel = { id: pid, action: 'isolate' }; return plan; }
        plan.parcel = { id: pid, action: 'view' };
        plan.openMassing = true;
        return plan;
    }

    return { planThreeClick };
});
