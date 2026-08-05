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

    // The publish gate (§15a): mechanically flatten a formation's parent declarations to base
    // ids, then VERIFY the record is flat. The caller refuses to publish when verdict.flat is
    // false — nothing here heals beyond the deterministic flatten; a record that cannot be made
    // flat is an error the author sees, not a repair job for every future reader.
    // Data a record must never carry ACROSS BROWSERS (§15a: children, formations, demolition
    // scans are DERIVED — apply regenerates them from the definition against the receiver's live
    // fabric). Shipping them makes the receiver trust another browser's fabric: an uploaded
    // formation record made the receiving apply skip forming entirely, and uploaded child lists
    // merged into locally minted ids and permanently failed the presence check (the reload
    // re-apply loop through a new door). Applied at PUBLISH and again at IMPORT — old server rows
    // still carry the fields.
    //
    // Government-plan roads are the one exception: their child features ARE the authored plan
    // (the apply clones them instead of cutting), so they stay.
    function stripDerivedRecordData(record) {
        if (!record || typeof record !== 'object') return record;
        const out = { ...record };
        const isGovernmentPlan = !!(out.tags && out.tags.governmentPlan === true)
            || (out.roadProposal && out.roadProposal.definition && out.roadProposal.definition.kind === 'government_plan')
            || (out.geometry && out.geometry.roadPlan && out.geometry.roadPlan.kind === 'government_plan');
        delete out.childParcelIds;
        delete out.descendantParcelIds;
        delete out.parentFeatures;
        if (!isGovernmentPlan) delete out.childFeatures;
        ['roadProposal', 'reparcellization', 'decideLaterProposal', 'buildingProposal', 'structureProposal'].forEach(key => {
            const sub = out[key];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
            const clean = { ...sub };
            delete clean.childParcelIds;
            delete clean.parentFeatures;
            delete clean.parentsToRemove;
            delete clean.formation;
            // Structure/building demolition results are apply-time scans, not authored decisions
            // (a road's cut/demolish/tunnel choices live inside definition, which is untouched).
            if (key === 'structureProposal' || key === 'buildingProposal') {
                delete clean.demolishedBuildings;
                delete clean.demolitionScanned;
            }
            if (!(key === 'roadProposal' && isGovernmentPlan)) delete clean.childFeatures;
            out[key] = clean;
        });
        return out;
    }

    function preparePublishRecord(proposal, options) {
        const opts = options || {};
        let out = { ...(proposal || {}) };
        const flat = flattenedParentsFor(out, opts);
        if (Array.isArray(flat) && flat.length) {
            out.parentParcelIds = flat.slice();
            // flattenedParentsFor returned ids only for a record that MINTED ground — and a
            // structure/building that minted (merge/footprint formation) flattens like any other
            // formation. The content-keeps-its-plot exemption belongs to records that mint
            // nothing (an adopt park standing on a formed plot): those never reach this branch,
            // because their role is not 'formation'. Without the two content sub-keys here,
            // publishing an APPLIED merged park threw formation-on-formed-ground on its own
            // consumed road slices.
            ['roadProposal', 'reparcellization', 'decideLaterProposal', 'structureProposal', 'buildingProposal'].forEach(key => {
                const sub = out[key];
                if (sub && typeof sub === 'object' && !Array.isArray(sub) && Array.isArray(sub.parentParcelIds)) {
                    out[key] = { ...sub, parentParcelIds: flat.slice() };
                }
            });
        }
        // Verify BEFORE stripping: children are part of the conformance verdict (they decide
        // the record's role and carry depth violations); the strip then removes them from what
        // actually ships.
        const verdict = conformanceOf(out, opts);
        out = stripDerivedRecordData(out);
        return { proposal: out, verdict };
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
        stripDerivedRecordData,
        preparePublishRecord,
        scanRecords
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__formationDepth = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
