// The drill stack: everything vertically stacked at one map point, ordered top → ground.
// A click (or hover) anywhere resolves to base cadastral parcels at depth 0, the formation
// proposal that consumed them just above, the slices it minted above that, and content
// proposals (buildings/structures/roads) on top. Pure — geometry and storage are injected.
(function (global) {
    'use strict';

    // How derived a parcel id is: each '#…-N' suffix is one generation of derivation.
    // 'HR-123-45' → 0, 'HR-123-45#c-abc-2' → 1, nested slices → 2…
    function parcelDepth(parcelId) {
        if (parcelId === undefined || parcelId === null) return 0;
        return String(parcelId).split('#').length - 1;
    }

    // The proposal id a derived parcel id encodes ('<parent>#<proposalId>-N' → proposalId).
    // Format-agnostic: works for new 'c-…'/'c2-…' ids and the old 'p-…' tokens alike.
    function mintingProposalIdOf(parcelId) {
        const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
        const hashAt = id.lastIndexOf('#');
        if (hashAt <= 0) return null;
        const token = id.slice(hashAt + 1).replace(/-\d+$/, '');
        return token || null;
    }

    // Every parcel id a proposal declares as a parent, across the top level and all
    // typology sub-objects (same union _collectProposalAncestorIds computes, kept local
    // so this module stays pure).
    function collectParentParcelIds(proposal) {
        const out = new Set();
        const push = list => {
            if (!Array.isArray(list)) return;
            list.forEach(id => { if (id !== undefined && id !== null) out.add(String(id)); });
        };
        if (!proposal) return out;
        push(proposal.parentParcelIds);
        ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
            .forEach(key => { if (proposal[key]) push(proposal[key].parentParcelIds); });
        return out;
    }

    // Ground-authoring formations mint parcels FOR OTHERS to stand on, so they sit below their own
    // slices. Every other formation's minted parcel is its own body — a corridor parcel IS the
    // road — so the proposal is the claim and sits above it. Without this split the same road
    // reads as "the road" where it cut nothing and as "a parcel" where it did, along one corridor.
    const GROUND_AUTHORING_GOALS = ['reparcellization', 'decide-later'];

    function isGroundAuthoring(proposal) {
        const goal = String((proposal && proposal.goal) === undefined || (proposal && proposal.goal) === null
            ? '' : proposal.goal).trim();
        return GROUND_AUTHORING_GOALS.indexOf(goal) !== -1;
    }

    function createdAtOf(proposal) {
        const raw = proposal && (proposal.createdAt || proposal.created_at);
        const ts = raw ? Date.parse(raw) : NaN;
        return Number.isFinite(ts) ? ts : 0;
    }

    // Build the ordered stack at `point` ([lng, lat] or a GeoJSON Point feature).
    //
    // ctx = {
    //   parcels:   [{ id, feature, live }]        candidates near the point (bbox-prefiltered is fine)
    //   proposals: [{ key, proposal, footprint }] applied candidates; footprint precomputed or null
    //   footprintOf(proposal) -> GeoJSON feature  used when an entry has no precomputed footprint
    //   pointInPolygon(point, polygonFeature) -> boolean
    // }
    //
    // Returns entries top-first:
    //   { kind: 'parcel', id, feature, live, depth }
    //   { kind: 'proposal', key, proposal, depth }
    // Depth places a proposal between the ground it consumes and the parcels it mints:
    // base parcel 0 → formation proposal 0.5 → its slices 1 → proposal on a slice 1.5.
    function buildDrillStack(point, ctx) {
        if (!point || !ctx || typeof ctx.pointInPolygon !== 'function') return [];
        const pt = Array.isArray(point) ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point } } : point;
        const pip = feature => {
            if (!feature || !feature.geometry) return false;
            try { return ctx.pointInPolygon(pt, feature) === true; } catch (_) { return false; }
        };

        // Parcels under the point. The product has no time view: consumed cadastral parcels and
        // dead intermediate slices are ancestry data, not members of the live tessellation.
        const parcelsAt = [];
        (Array.isArray(ctx.parcels) ? ctx.parcels : []).forEach(entry => {
            if (!entry || !entry.id || !pip(entry.feature)) return;
            if (entry.live === false) return;
            const depth = parcelDepth(entry.id);
            parcelsAt.push({ kind: 'parcel', id: String(entry.id), feature: entry.feature, live: true, depth });
        });

        const parcelDepthById = new Map();
        let maxParcelDepth = 0;
        parcelsAt.forEach(p => {
            parcelDepthById.set(p.id, p.depth);
            if (p.depth > maxParcelDepth) maxParcelDepth = p.depth;
        });

        // Proposals whose footprint covers the point.
        const proposalsAt = [];
        (Array.isArray(ctx.proposals) ? ctx.proposals : []).forEach(entry => {
            if (!entry || !entry.key || !entry.proposal) return;
            let footprint = entry.footprint;
            if (footprint === undefined && typeof ctx.footprintOf === 'function') {
                try { footprint = ctx.footprintOf(entry.proposal); } catch (_) { footprint = null; }
            }
            if (!footprint || !pip(footprint)) return;

            const key = String(entry.key);
            let depth = null;

            // A proposal that MINTED a slice under the point sits just below that slice.
            let minMintedDepth = null;
            parcelsAt.forEach(p => {
                const minter = (p.feature && p.feature.properties && p.feature.properties.ancestorProposal)
                    ? String(p.feature.properties.ancestorProposal)
                    : mintingProposalIdOf(p.id);
                if (minter !== key) return;
                if (minMintedDepth === null || p.depth < minMintedDepth) minMintedDepth = p.depth;
            });
            if (minMintedDepth !== null) {
                depth = isGroundAuthoring(entry.proposal) ? minMintedDepth - 0.5 : minMintedDepth + 0.5;
            } else {
                // Otherwise it stands ON its parents: just above the deepest parent present here.
                const parents = collectParentParcelIds(entry.proposal);
                let maxParentDepth = null;
                parents.forEach(id => {
                    const d = parcelDepthById.get(String(id));
                    if (d !== undefined && (maxParentDepth === null || d > maxParentDepth)) maxParentDepth = d;
                });
                // Re-based/geometry-only records with no declared parent at the point still sit
                // on top of whatever ground is here.
                depth = (maxParentDepth !== null ? maxParentDepth : maxParcelDepth) + 0.5;
                // A ground-authoring formation authors ground for OTHERS; at a spot whose live
                // fabric was minted by a DIFFERENT proposal it never outranks that fabric. A
                // degraded record can declare another road's corridor slice as its parent
                // (measured: a reparcellization that once re-applied over a standing road), and
                // without this cap that parent lifts it above the road — so clicking the
                // corridor selected the subdivision. Base ground (depth 0) is unaffected: a
                // readjustment still sits above the pool parcels it stands on.
                if (isGroundAuthoring(entry.proposal)) {
                    let foreignLiveDepth = null;
                    parcelsAt.forEach(p => {
                        if (!p.live || p.depth <= 0) return;
                        const minter = (p.feature && p.feature.properties && p.feature.properties.ancestorProposal)
                            ? String(p.feature.properties.ancestorProposal)
                            : mintingProposalIdOf(p.id);
                        if (!minter || minter === key) return;
                        if (foreignLiveDepth === null || p.depth > foreignLiveDepth) foreignLiveDepth = p.depth;
                    });
                    if (foreignLiveDepth !== null && depth > foreignLiveDepth - 0.5) {
                        depth = foreignLiveDepth - 0.5;
                    }
                }
            }

            proposalsAt.push({ kind: 'proposal', key, proposal: entry.proposal, depth });
        });

        const stack = parcelsAt.concat(proposalsAt);
        stack.sort((a, b) => {
            if (b.depth !== a.depth) return b.depth - a.depth;
            if (a.kind === 'proposal' && b.kind === 'proposal') {
                return createdAtOf(b.proposal) - createdAtOf(a.proposal);
            }
            const ka = a.kind === 'proposal' ? a.key : a.id;
            const kb = b.kind === 'proposal' ? b.key : b.id;
            return String(ka).localeCompare(String(kb));
        });
        return stack;
    }

    const api = { buildDrillStack, parcelDepth, mintingProposalIdOf, collectParentParcelIds };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__drillStack = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
