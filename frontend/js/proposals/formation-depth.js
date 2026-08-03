// The flat-record invariant: a PUBLISHED record is at most three levels deep —
// base cadastral parcel → one formation → content. Locally, operations may stack in time
// (draw a road, then another road cutting its remainder); at share/mint/upload the
// declarations flatten so nothing in the record ever chains formation onto formation.
// Pure: id strings and plain records in, verdicts out.
(function (global) {
    'use strict';

    // Derivation generations encoded in an id: 'HR-1-2' → 0, 'HR-1-2#c-abc-1' → 1, nested → 2…
    function parcelIdDepth(parcelId) {
        if (parcelId === undefined || parcelId === null) return 0;
        return String(parcelId).split('#').length - 1;
    }

    function isBaseParcelId(parcelId) {
        return parcelIdDepth(parcelId) === 0;
    }

    // The base cadastral id a derived id descends from, however many generations deep.
    function baseParcelIdOf(parcelId) {
        const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
        const hashAt = id.indexOf('#');
        return hashAt > 0 ? id.slice(0, hashAt) : id;
    }

    // Goals whose typology forms ground (they mint parcels and move ownership). Mirrors
    // ownership-flow's DESTINATION_BY_GOAL; kept local so this module stays dependency-free.
    const FORMATION_GOALS = Object.freeze([
        'road-track', 'park', 'square', 'lake', 'station', 'single', 'buildings',
        'reparcellization', 'decide-later'
    ]);

    function isFormationGoal(goal) {
        return FORMATION_GOALS.indexOf(String(goal === undefined || goal === null ? '' : goal).trim()) !== -1;
    }

    const SUB_KEYS = ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal'];

    function collectIds(proposal, field) {
        const out = [];
        const push = list => {
            if (!Array.isArray(list)) return;
            list.forEach(id => { if (id !== undefined && id !== null && String(id)) out.push(String(id)); });
        };
        if (!proposal) return out;
        push(proposal[field]);
        SUB_KEYS.forEach(key => { if (proposal[key]) push(proposal[key][field]); });
        return out;
    }

    function parentIdsOf(proposal) { return collectIds(proposal, 'parentParcelIds'); }
    function childIdsOf(proposal) { return collectIds(proposal, 'childParcelIds'); }

    // What a record DOES, not merely what its goal implies: a building that fits a plot someone
    // else formed mints nothing and is content on that plot; the same goal drawn over raw ground
    // forms its own parcel. Children present ⇒ it formed ground.
    function roleOf(proposal) {
        if (!proposal) return 'content';
        if (childIdsOf(proposal).length > 0) return 'formation';
        return isFormationGoal(proposal.goal) ? 'potential-formation' : 'content';
    }

    // Verdict for one record. What matters is whether the record MINTS ground, not what its goal
    // implies: a park sitting on a plot shaped for it by an earlier reparcellization mints nothing
    // and is content on that plot — the legal third level. Callers that can predict minting before
    // apply (the publish gate, the draw path) pass `mintsGround` explicitly.
    function conformanceOf(proposal, options) {
        const opts = options || {};
        const role = opts.mintsGround === true ? 'formation'
            : (opts.mintsGround === false ? 'content' : roleOf(proposal));
        const parents = parentIdsOf(proposal);
        const children = childIdsOf(proposal);
        const maxParentDepth = parents.reduce((max, id) => Math.max(max, parcelIdDepth(id)), 0);
        const violations = [];

        children.forEach(id => {
            if (parcelIdDepth(id) > 1) {
                violations.push({ code: 'parcel-id-too-deep', id, depth: parcelIdDepth(id) });
            }
        });

        parents.forEach(id => {
            if (parcelIdDepth(id) > 1) {
                violations.push({ code: 'parent-id-too-deep', id, depth: parcelIdDepth(id) });
            }
        });

        const formsOnDerived = parents.filter(id => parcelIdDepth(id) === 1);
        if (formsOnDerived.length && role === 'formation') {
            violations.push({ code: 'formation-on-formed-ground', ids: formsOnDerived.slice() });
        }

        return {
            role,
            maxParentDepth,
            flat: violations.length === 0,
            violations
        };
    }

    // The parents a FORMATION should declare once flattened. Content keeps its plot — the plot IS
    // the third level, so flattening it away would erase which ground the content stands on.
    //
    // `opts.geometricBaseIds` is AUTHORITATIVE when supplied, and callers should supply it: a
    // slice id names only the root it was minted against, and a comasation mints every slice
    // against ONE root even when it consumed dozens of base parcels (Borovje: 38 slices all named
    // `1791/25#…`, 29 real base parents). Parsing ids would therefore under-declare the ground.
    // The id projection below is the last-resort fallback when no geometry is available.
    function flattenedParentsFor(proposal, options) {
        const opts = options || {};
        const verdict = conformanceOf(proposal, opts);
        if (verdict.role !== 'formation') return null;
        const parents = parentIdsOf(proposal);
        if (!parents.some(id => parcelIdDepth(id) > 0)) return null;

        if (Array.isArray(opts.geometricBaseIds) && opts.geometricBaseIds.length) {
            const out = [];
            const taken = new Set();
            opts.geometricBaseIds.forEach(id => {
                const key = String(id);
                if (key && !taken.has(key)) { taken.add(key); out.push(key); }
            });
            return out;
        }
        const seen = new Set();
        const flat = [];
        parents.forEach(id => {
            const base = baseParcelIdOf(id);
            if (base && !seen.has(base)) { seen.add(base); flat.push(base); }
        });
        return flat;
    }

    // Scan a set of records — the publish gate and the fabric conformance report use the same call.
    function scanRecords(proposals, options) {
        const list = Array.isArray(proposals) ? proposals : [];
        const records = [];
        const byCode = {};
        list.forEach(proposal => {
            if (!proposal) return;
            const verdict = conformanceOf(proposal, options);
            if (verdict.flat) return;
            const id = proposal.proposalId || proposal.id || null;
            verdict.violations.forEach(v => { byCode[v.code] = (byCode[v.code] || 0) + 1; });
            records.push({ proposalId: id, goal: proposal.goal || null, role: verdict.role, violations: verdict.violations });
        });
        return { total: list.length, offending: records.length, byCode, records };
    }

    const api = {
        FORMATION_GOALS,
        parcelIdDepth,
        isBaseParcelId,
        baseParcelIdOf,
        isFormationGoal,
        roleOf,
        conformanceOf,
        flattenedParentsFor,
        scanRecords
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__formationDepth = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
