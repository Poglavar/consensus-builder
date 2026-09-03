// The vertical stack at one map point. This is a flat view of CURRENT claims, not a reconstruction
// of parcel history: live Fabric parcels carry explicit one-hop producer metadata and proposals
// carry authored footprints. Parcel IDs remain opaque throughout.
(function (global) {
    'use strict';

    const GROUND_AUTHORING_GOALS = ['reparcellization', 'decide-later'];

    function isGroundAuthoring(proposal) {
        const goal = String(proposal?.goal ?? '').trim();
        return GROUND_AUTHORING_GOALS.includes(goal);
    }

    function createdAtOf(proposal) {
        const raw = proposal && (proposal.createdAt || proposal.created_at);
        const ts = raw ? Date.parse(raw) : NaN;
        return Number.isFinite(ts) ? ts : 0;
    }

    function producerOf(feature) {
        const value = feature?.properties?.producedByProposalId;
        return value === undefined || value === null || String(value) === '' ? null : String(value);
    }

    // Returns entries top-first. Depth is presentation ordering only:
    //   bare cadastre 0
    //   a ground-authoring proposal 0.5
    //   its current live output 1
    //   content/corridor proposal claim 1.5
    // There is no generation number and no ancestry traversal.
    function buildDrillStack(point, ctx) {
        if (!point || !ctx || typeof ctx.pointInPolygon !== 'function') return [];
        const pt = Array.isArray(point)
            ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point } }
            : point;
        const coversPoint = feature => {
            if (!feature?.geometry) return false;
            try { return ctx.pointInPolygon(pt, feature) === true; } catch (_) { return false; }
        };

        const parcelsAt = [];
        (Array.isArray(ctx.parcels) ? ctx.parcels : []).forEach(entry => {
            if (!entry?.id || entry.live === false || !coversPoint(entry.feature)) return;
            const producerId = producerOf(entry.feature);
            parcelsAt.push({
                kind: 'parcel',
                id: String(entry.id),
                feature: entry.feature,
                live: true,
                producerId,
                depth: producerId ? 1 : 0
            });
        });

        const proposalsAt = [];
        (Array.isArray(ctx.proposals) ? ctx.proposals : []).forEach(entry => {
            if (!entry?.key || !entry.proposal) return;
            let footprint = entry.footprint;
            if (footprint === undefined && typeof ctx.footprintOf === 'function') {
                try { footprint = ctx.footprintOf(entry.proposal); } catch (_) { footprint = null; }
            }
            if (!footprint || !coversPoint(footprint)) return;
            const key = String(entry.key);
            proposalsAt.push({
                kind: 'proposal',
                key,
                proposal: entry.proposal,
                // Readjustment/merge authors the parcel partition and is shown below that output.
                // Every other proposal is the visible claim itself and is shown above parcel fabric.
                depth: isGroundAuthoring(entry.proposal) ? 0.5 : 1.5
            });
        });

        const stack = parcelsAt.concat(proposalsAt);
        stack.sort((a, b) => {
            if (b.depth !== a.depth) return b.depth - a.depth;
            if (a.kind === 'proposal' && b.kind === 'proposal') {
                return createdAtOf(b.proposal) - createdAtOf(a.proposal);
            }
            const aKey = a.kind === 'proposal' ? a.key : a.id;
            const bKey = b.kind === 'proposal' ? b.key : b.id;
            return String(aKey).localeCompare(String(bKey));
        });
        return stack;
    }

    const api = { buildDrillStack, isGroundAuthoring, producerOf };
    if (typeof window !== 'undefined') window.__drillStack = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
