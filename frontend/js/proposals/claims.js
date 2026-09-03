// Claims model (rethink-proposals.md §13): everything clickable on the map is a CLAIM about a
// piece of ground — a proposal's content (building, lake…), a fabric-changer's output piece
// (corridor, remainder, subdivision slice), or the null claim: the bare cadastral parcel itself,
// i.e. "no change proposed here". This module is the pure half — ranking claims, projecting any
// claim back to the base parcels it stands on (the breadcrumb), and building a base parcel's
// dossier (every proposal claiming any of its ground). No DOM, no Leaflet.

(function (global) {
    'use strict';

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

    // The base cadastral parcels a proposal stands on. Durable records are normalized at their
    // storage/import boundary, so reading claims is deliberately boring: no generated-id parser,
    // no ancestry walk, and no reconstruction from duplicated typology fields.
    function cadastreParcelIdsOf(proposal) {
        if (!proposal) return [];
        const declared = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
        return Array.from(new Set(declared.map(id => String(id || '').trim()).filter(Boolean)));
    }

    function materializedParcelsOf(proposal) {
        const proposalId = proposal && proposal.proposalId;
        const fabric = global && global.LiveParcelFabric;
        if (!proposalId || !fabric || typeof fabric.producedBy !== 'function') return [];
        return fabric.producedBy(String(proposalId));
    }

    function materializedParcelIdsOf(proposal) {
        const fabric = global && global.LiveParcelFabric;
        return materializedParcelsOf(proposal)
            .map(feature => fabric && typeof fabric.featureId === 'function'
                ? fabric.featureId(feature)
                : feature?.properties?.parcelId)
            .map(value => String(value || '').trim())
            .filter(Boolean);
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
        const hasMaterializedOutput = typeof opts.hasMaterializedOutput === 'function'
            ? opts.hasMaterializedOutput(proposal)
            : materializedParcelsOf(proposal).length > 0;
        if (!hasMaterializedOutput) return false;
        return cadastreParcelIdsOf(proposal).includes(String(parcelId));
    }

    // Every proposal claiming ground on this base parcel — the dossier a click in cadastre view
    // answers with. A live id is projected through fabric metadata, never its string shape.
    // options.isApplied lets the caller supply the app's real applied-state accessor.
    function dossierFor(parcelId, proposals, options) {
        const opts = options || {};
        const isApplied = (typeof opts.isApplied === 'function')
            ? opts.isApplied
            : (p => p && p.applied === true);
        const parcelKey = String(parcelId || '').trim();
        const fabric = global && global.LiveParcelFabric;
        const liveFeature = fabric && typeof fabric.get === 'function' ? fabric.get(parcelKey) : null;
        // When no live feature exists, this API's parcelId argument is itself an explicit
        // cadastral anchor (used by dossier views and pure callers). No id-format inference is
        // involved; callers holding a live id must supply the fabric entry or explicit roots.
        const roots = Array.isArray(opts.cadastreParcelIds) && opts.cadastreParcelIds.length
            ? opts.cadastreParcelIds.map(String)
            : (liveFeature && typeof fabric.explicitCadastreIds === 'function'
                ? fabric.explicitCadastreIds(liveFeature)
                : (parcelKey ? [parcelKey] : []));
        if (!roots.length) return [];

        const entries = [];
        (Array.isArray(proposals) ? proposals : []).forEach(p => {
            if (!p) return;
            if (!cadastreParcelIdsOf(p).some(id => roots.includes(id))) return;
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
        cadastreParcelIdsOf,
        materializedParcelsOf,
        materializedParcelIdsOf,
        formationReplacesCadastreParcel,
        dossierFor,
        shortParcelLabel
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__claims = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
