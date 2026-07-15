// Pure apply-routing decisions for ProposalManager — extracted from the 8k-line monolith as the
// first step of decomposing it. This module owns two things and NOTHING else (no map, no storage,
// no DOM): normalising a proposal's `goal` into a canonical key, and deciding which apply path a
// proposal takes. Because it is pure, it is exhaustively unit-testable in node — unlike the
// I/O-heavy _apply<Type> methods it routes to.
//
// The routes:
//   'noop'         parcel / ownership-transfer / to-buyer — no map payload, apply is an idempotent
//                  success (ownership moves at execute time, not here).
//   'unsupported'  a goal with no apply path — a hard failure.
//   'road-track' | 'reparcellization' | 'decide-later' | 'building' | 'structure'
//                  dispatch to the matching _apply<Type>Proposal method.
//
// Wrapped in a UMD factory so its functions are NOT top-level globals — the app already has a global
// `normalizeGoalKey` (proposals/core.js); a second top-level one would shadow it. It exposes a single
// namespaced handle, `window.__applyRoute`, and a CommonJS export for node tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__applyRoute = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Canonical goal key — the single source of truth for goal aliases in ProposalManager, which
    // delegates its _normalizeGoalKey here so the ~40 call sites cannot drift.
    function normalizeGoalKey(rawGoal) {
        if (rawGoal === undefined || rawGoal === null) return '';
        const text = String(rawGoal).trim().toLowerCase();
        if (!text) return '';
        const key = text.replace(/\s+/g, '-').replace(/\//g, '-');
        if (key === 'road-track' || key === 'road' || key === 'track') return 'road-track';
        if (key === 'decide-later' || key === 'decide') return 'decide-later';
        if (key === 'reparcellization') return 'reparcellization';
        if (key === 'park' || key === 'square' || key === 'lake') return key;
        if (key === 'buildings' || key === 'residences') return 'buildings';
        if (key === 'building(s)' || key === 'single' || key === 'single-building') return 'single';
        if (key === 'row') return 'row';
        if (key === 'parcelbased' || key === 'parcel-based') return 'parcelBased';
        if (key === 'urban-rule') return 'urban-rule';
        if (key === 'parcel') return 'parcel';
        return key;
    }

    // A building-typology goal (as opposed to road / structure / reparcellization).
    function isBuildingGoal(goalKey) {
        return goalKey === 'buildings' || goalKey === 'single' || goalKey === 'row'
            || goalKey === 'parcelbased' || goalKey === 'parcelBased';
    }

    // Which apply path a proposal takes. Pure mirror of the ProposalManager.applyProposal dispatch —
    // returns { route, goalKey } so the caller keeps the goalKey it already needs.
    function classifyApplyRoute(proposalData) {
        const goalKey = normalizeGoalKey(proposalData && proposalData.goal);

        if (goalKey === 'parcel'
            || goalKey === 'to-buyer'
            || (typeof goalKey === 'string' && goalKey.startsWith('ownership-transfer'))) {
            return { route: 'noop', goalKey };
        }

        if (goalKey === 'road-track') return { route: 'road-track', goalKey };
        if (goalKey === 'reparcellization') return { route: 'reparcellization', goalKey };
        if (goalKey === 'decide-later') return { route: 'decide-later', goalKey };
        if (isBuildingGoal(goalKey)) return { route: 'building', goalKey };
        if (goalKey === 'park' || goalKey === 'square' || goalKey === 'lake') return { route: 'structure', goalKey };

        return { route: 'unsupported', goalKey };
    }

    return { normalizeGoalKey, isBuildingGoal, classifyApplyRoute };
});
