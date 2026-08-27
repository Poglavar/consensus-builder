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

    // The base cadastral parcels a proposal stands on. Prefers the published stamp
    // (cadastreParcelIds, written at upload); falls back to the roots of whatever the proposal
    // declares locally. Never returns derived ids.
    function baseParcelIdsOf(proposal) {
        if (!proposal) return [];
        const api = planOrder();
        const stamped = Array.isArray(proposal.cadastreParcelIds)
            ? proposal.cadastreParcelIds.map(id => String(id)).filter(Boolean)
            : [];
        if (stamped.length) {
            return api ? api.cadastreIdsFromDeclared(stamped) : Array.from(new Set(stamped));
        }
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

    // The smallest part of the live plan that can change when one or more cadastral parcels
    // change. Proposals and original parcels form a bipartite graph: a proposal is connected to
    // every base parcel in its flat cadastre stamp. Starting from the changed bases, walk that
    // graph to a fixed point. Generated parcel ids never participate, so the answer cannot depend
    // on which replay happened to mint or consume a transient child.
    function connectedComponent(seedParcelIds, proposals, options) {
        const opts = options || {};
        const include = typeof opts.include === 'function' ? opts.include : (() => true);
        const api = planOrder();
        const roots = new Set();
        (Array.isArray(seedParcelIds) ? seedParcelIds : Array.from(seedParcelIds || [])).forEach(id => {
            const root = api ? api.cadastreRootId(id) : String(id || '');
            if (root) roots.add(root);
        });

        const candidates = (Array.isArray(proposals) ? proposals : [])
            .filter(proposal => proposal && include(proposal))
            .map(proposal => ({ proposal, baseParcelIds: baseParcelIdsOf(proposal) }));
        const members = [];
        const memberIds = new Set();
        let changed = true;
        while (changed) {
            changed = false;
            candidates.forEach(entry => {
                const key = entry.proposal.proposalId === undefined || entry.proposal.proposalId === null
                    ? entry.proposal
                    : String(entry.proposal.proposalId);
                if (memberIds.has(key)) return;
                if (!entry.baseParcelIds.some(id => roots.has(id))) return;
                memberIds.add(key);
                members.push(entry.proposal);
                entry.baseParcelIds.forEach(id => {
                    if (!roots.has(id)) {
                        roots.add(id);
                        changed = true;
                    }
                });
                changed = true;
            });
        }
        return { baseParcelIds: Array.from(roots), proposals: members };
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
        if (!Array.isArray(proposal.childParcelIds) || proposal.childParcelIds.length === 0) return false;
        return baseParcelIdsOf(proposal).includes(String(parcelId));
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

    const api = {
        CLAIM_RANKS,
        claimKindForGoal,
        claimRank,
        baseParcelIdsOf,
        connectedComponent,
        formationReplacesCadastreParcel,
        dossierFor,
        shortParcelLabel
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__claims = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
