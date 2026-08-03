// Claims model (rethink-proposals.md §13): everything clickable on the map is a CLAIM about a
// piece of ground — a proposal's content (building, lake…), a fabric-changer's output piece
// (corridor, remainder, subdivision slice), or the null claim: the bare cadastral parcel itself,
// i.e. "no change proposed here". This module is the pure half — ranking claims, projecting any
// claim back to the base parcels it stands on (the breadcrumb), and building a base parcel's
// dossier (every proposal claiming any of its ground). No DOM, no Leaflet.

(function (global) {
    'use strict';

    const planOrder = () => (global && global.__planOrder)
        ? global.__planOrder
        : (typeof require === 'function' ? require('./plan-order.js') : null);

    // Z-order of claims at one spot: content sits on fabric, fabric sits on the ground.
    const CLAIM_RANKS = Object.freeze({ content: 3, fabric: 2, ground: 1 });

    function claimKindForGoal(goal) {
        const api = planOrder();
        if (api && api.isFabricGoal(goal)) return 'fabric';
        if (goal === undefined || goal === null || String(goal).trim() === '') return 'ground';
        return 'content';
    }

    function claimRank(kind) {
        return CLAIM_RANKS[String(kind || '').trim()] || 0;
    }

    // The base cadastral parcels a proposal stands on. Prefers the published stamp
    // (cadastreParcelIds, written at upload); falls back to the roots of whatever the proposal
    // declares locally. Never returns derived ids.
    function baseParcelIdsOf(proposal) {
        if (!proposal) return [];
        const api = planOrder();
        const stamped = Array.isArray(proposal.cadastreParcelIds)
            ? proposal.cadastreParcelIds.map(id => String(id)).filter(Boolean)
            : [];
        if (stamped.length) return Array.from(new Set(stamped));
        if (!api) return [];

        const declared = [];
        const push = (arr) => { if (Array.isArray(arr)) arr.forEach(id => declared.push(id)); };
        push(proposal.parentParcelIds);
        if (proposal.roadProposal) push(proposal.roadProposal.parentParcelIds);
        if (proposal.structureProposal) push(proposal.structureProposal.parentParcelIds);
        if (proposal.buildingProposal) push(proposal.buildingProposal.parentParcelIds);
        if (proposal.decideLaterProposal) push(proposal.decideLaterProposal.parentParcelIds);
        if (proposal.reparcellization) push(proposal.reparcellization.parentParcelIds);
        return api.cadastreIdsFromDeclared(declared);
    }

    // Every proposal claiming ground on this base parcel — the dossier a click in cadastre view
    // answers with. `parcelId` may be a derived id; it is projected to its root first.
    // options.isApplied lets the caller supply the app's real applied-state accessor.
    function dossierFor(parcelId, proposals, options) {
        const api = planOrder();
        const opts = options || {};
        const isApplied = (typeof opts.isApplied === 'function')
            ? opts.isApplied
            : (p => p && p.applied === true);
        const root = api ? api.cadastreRootId(parcelId) : String(parcelId || '');
        if (!root) return [];

        const entries = [];
        (Array.isArray(proposals) ? proposals : []).forEach(p => {
            if (!p) return;
            if (baseParcelIdsOf(p).indexOf(root) === -1) return;
            const kind = claimKindForGoal(p.goal);
            entries.push({
                proposalId: p.proposalId ? String(p.proposalId) : null,
                serverProposalId: p.serverProposalId ? String(p.serverProposalId) : null,
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

    // A short human label for a base parcel id: "HR-339270-823/1" -> "823/1".
    function shortParcelLabel(parcelId) {
        const s = String(parcelId || '');
        const match = s.match(/^HR-\d+-(.+)$/);
        return match ? match[1] : s;
    }

    const api = { CLAIM_RANKS, claimKindForGoal, claimRank, baseParcelIdsOf, dossierFor, shortParcelLabel };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__claims = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
