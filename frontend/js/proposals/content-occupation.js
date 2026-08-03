// What a formation would run over: the applied PROPOSED fabric standing on the ground a
// corridor/structure is about to take (rethink §15 decision 3). Proposed fabric is never cut —
// half a building is not something its author proposed — so an occupation is a conflict the user
// resolves by un-applying the existing proposal. Surveyed buildings are facts on the ground and
// keep the cut/tunnel/demolish impact modes; they are not this module's business.
// Pure: GeoJSON in, verdicts out; the caller supplies the intersection primitives.
(function (global) {
    'use strict';

    // Ground-authoring layers are not "content standing on" anything — a road crossing the plots a
    // reparcellization drew is the normal composition, not a conflict with the reparcellization.
    const GROUND_AUTHORING_GOALS = Object.freeze(['reparcellization', 'decide-later']);

    // Blocking someone's applied proposal is a heavy act, so only a MATERIAL occupation counts:
    // a real bite (both an absolute area and a share of the victim) or a proposal mostly swallowed
    // whatever its size. Sub-threshold slivers are a geometry-precision problem — the footprint vs
    // declared-ground reconciliation owns those, not consent.
    const DEFAULT_MIN_AREA_M2 = 25;
    const DEFAULT_MIN_PCT = 5;
    const DEFAULT_MAJOR_PCT = 50;

    function goalOf(proposal) {
        return String((proposal && proposal.goal) === undefined || (proposal && proposal.goal) === null
            ? '' : proposal.goal).trim();
    }

    function isGroundAuthoring(proposal) {
        return GROUND_AUTHORING_GOALS.indexOf(goalOf(proposal)) !== -1;
    }

    // `candidates` is [{ key, proposal, footprint }] — applied proposals with a resolved footprint.
    // ctx supplies { intersectionArea(a, b), area(f) } so the module stays turf-free and testable.
    // Returns the materially-occupied ones, largest share of THEIR OWN footprint first.
    function occupationsOf(formationFootprint, candidates, ctx, options) {
        const opts = options || {};
        if (!formationFootprint || !ctx || typeof ctx.intersectionArea !== 'function' || typeof ctx.area !== 'function') {
            return [];
        }
        const minArea = Number.isFinite(opts.minAreaM2) ? opts.minAreaM2 : DEFAULT_MIN_AREA_M2;
        const minPct = Number.isFinite(opts.minPct) ? opts.minPct : DEFAULT_MIN_PCT;
        const majorPct = Number.isFinite(opts.majorPct) ? opts.majorPct : DEFAULT_MAJOR_PCT;
        const selfKey = opts.selfKey === undefined || opts.selfKey === null ? null : String(opts.selfKey);
        const exempt = new Set((Array.isArray(opts.exemptKeys) ? opts.exemptKeys : []).map(k => String(k)));

        const hits = [];
        (Array.isArray(candidates) ? candidates : []).forEach(entry => {
            if (!entry || !entry.key || !entry.footprint || !entry.proposal) return;
            const key = String(entry.key);
            if (selfKey !== null && key === selfKey) return;
            if (exempt.has(key)) return;
            if (isGroundAuthoring(entry.proposal)) return;

            let own = 0;
            try { own = ctx.area(entry.footprint) || 0; } catch (_) { return; }
            if (own <= 0) return;

            let covered = 0;
            try { covered = ctx.intersectionArea(entry.footprint, formationFootprint) || 0; } catch (_) { return; }
            const pct = (covered / own) * 100;
            const material = (covered >= minArea && pct >= minPct) || pct >= majorPct;
            if (!material) return;

            hits.push({
                key,
                proposal: entry.proposal,
                goal: goalOf(entry.proposal),
                title: (entry.proposal.title || entry.proposal.name || key),
                ownAreaM2: Math.round(own),
                occupiedM2: Math.round(covered),
                occupiedPct: Math.round(pct)
            });
        });

        hits.sort((a, b) => b.occupiedPct - a.occupiedPct || b.occupiedM2 - a.occupiedM2
            || String(a.key).localeCompare(String(b.key)));
        return hits;
    }

    // One sentence naming what blocks the apply and why — invariant #6: a refusal explains itself.
    function describeOccupations(occupations) {
        const list = Array.isArray(occupations) ? occupations : [];
        if (!list.length) return '';
        const names = list.map(o => `${o.title} (${o.occupiedPct}%)`).join(', ');
        return list.length === 1
            ? `This takes ground held by an applied proposal: ${names}. Un-apply it first — proposed buildings are never cut in half.`
            : `This takes ground held by ${list.length} applied proposals: ${names}. Un-apply them first — proposed buildings are never cut in half.`;
    }

    const api = { GROUND_AUTHORING_GOALS, occupationsOf, describeOccupations, isGroundAuthoring };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__contentOccupation = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
