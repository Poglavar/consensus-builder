// Editing a saved land readjustment re-forms the ground under it. Anything already applied on a
// plot whose shape CHANGED cannot survive that — its ground is no longer the ground it accepted —
// so saving must disclose those proposals and un-apply them, and is refused if the user declines.
// Scoped to what actually moved: plots the edit left alone keep whatever stands on them.
// Pure: plans and records in, verdicts out; the caller supplies the geometry primitives.
(function (global) {
    'use strict';

    // Two plots are "the same ground" when their symmetric difference is negligible against their
    // own size — vertex noise and re-serialisation must not read as a change.
    const DEFAULT_TOLERANCE_PCT = 1;
    const DEFAULT_TOLERANCE_M2 = 1;

    function geometryOf(entry) {
        if (!entry) return null;
        if (entry.geometry) return entry.geometry.type === 'Feature' ? entry.geometry.geometry : entry.geometry;
        if (entry.type === 'Feature') return entry.geometry;
        return null;
    }

    function asFeature(geometry) {
        return geometry ? { type: 'Feature', properties: {}, geometry } : null;
    }

    // Which plots of `before` are no longer present unchanged in `after`. Returns their indices in
    // `before`, so the caller can map them to the child parcels minted for those plots.
    // ctx: { area(feature), intersectionArea(a, b) }
    function changedPlotIndices(before, after, ctx, options) {
        const opts = options || {};
        const beforeList = Array.isArray(before) ? before : [];
        const afterList = Array.isArray(after) ? after : [];
        if (!ctx || typeof ctx.area !== 'function' || typeof ctx.intersectionArea !== 'function') return [];
        const tolPct = Number.isFinite(opts.tolerancePct) ? opts.tolerancePct : DEFAULT_TOLERANCE_PCT;
        const tolM2 = Number.isFinite(opts.toleranceM2) ? opts.toleranceM2 : DEFAULT_TOLERANCE_M2;

        const afterFeatures = afterList.map(entry => asFeature(geometryOf(entry))).filter(Boolean);
        const afterAreas = afterFeatures.map(f => { try { return ctx.area(f) || 0; } catch (_) { return 0; } });

        const changed = [];
        beforeList.forEach((entry, index) => {
            const feature = asFeature(geometryOf(entry));
            if (!feature) return;
            let ownArea = 0;
            try { ownArea = ctx.area(feature) || 0; } catch (_) { ownArea = 0; }
            if (ownArea <= 0) return;

            // Unchanged means SOME plot in the new plan is essentially this same shape: same area
            // and almost complete overlap. A plot that merely moved in the list is not a change.
            const survives = afterFeatures.some((other, j) => {
                const otherArea = afterAreas[j];
                if (otherArea <= 0) return false;
                const areaGap = Math.abs(otherArea - ownArea);
                if (areaGap > Math.max(tolM2, ownArea * tolPct / 100)) return false;
                let shared = 0;
                try { shared = ctx.intersectionArea(feature, other) || 0; } catch (_) { return false; }
                const missing = ownArea - shared;
                return missing <= Math.max(tolM2, ownArea * tolPct / 100);
            });
            if (!survives) changed.push(index);
        });
        return changed;
    }

    // The child parcel ids minted for the given plot indices. Children are minted in plot order,
    // so index i of the plan corresponds to entry i of childParcelIds — but a caller that knows
    // better (a stored per-plot id) can pass `childIdAt`.
    function childIdsForPlots(indices, childParcelIds, childIdAt) {
        const ids = [];
        const list = Array.isArray(childParcelIds) ? childParcelIds : [];
        (Array.isArray(indices) ? indices : []).forEach(index => {
            const id = typeof childIdAt === 'function' ? childIdAt(index) : list[index];
            if (id !== undefined && id !== null && String(id)) ids.push(String(id));
        });
        return ids;
    }

    // Applied proposals standing on any of those child parcels. Declared parents are the link:
    // a proposal that accepted a plot names it, whatever generation the id belongs to.
    function proposalsOnPlots(changedChildIds, appliedProposals, options) {
        const opts = options || {};
        const wanted = new Set((Array.isArray(changedChildIds) ? changedChildIds : []).map(String));
        if (!wanted.size) return [];
        const selfKey = opts.selfKey === undefined || opts.selfKey === null ? null : String(opts.selfKey);
        const out = [];
        (Array.isArray(appliedProposals) ? appliedProposals : []).forEach(entry => {
            if (!entry || !entry.key || !entry.proposal) return;
            const key = String(entry.key);
            if (selfKey !== null && key === selfKey) return;
            const parents = [];
            const push = list => { if (Array.isArray(list)) list.forEach(id => parents.push(String(id))); };
            push(entry.proposal.parentParcelIds);
            ['roadProposal', 'buildingProposal', 'structureProposal', 'decideLaterProposal']
                .forEach(k => { if (entry.proposal[k]) push(entry.proposal[k].parentParcelIds); });
            const hit = parents.filter(id => wanted.has(id));
            if (hit.length) {
                out.push({
                    key,
                    proposal: entry.proposal,
                    title: entry.proposal.title || entry.proposal.name || key,
                    onPlots: Array.from(new Set(hit))
                });
            }
        });
        out.sort((a, b) => String(a.title).localeCompare(String(b.title)));
        return out;
    }

    const api = { changedPlotIndices, childIdsForPlots, proposalsOnPlots };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__reparcelEditImpact = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
