// The flat-record invariant: a PUBLISHED record is at most three levels deep —
// base cadastral parcel → one formation → content. The live fabric has no historical stack;
// applied records are replayed in order and all declarations flatten to cadastral ids.
// Pure: id strings and plain records in, verdicts out.
(function (global) {
    'use strict';

    const LEGACY_DERIVED_PARCEL = /^(HR-\d+-.+?)_[a-z0-9]+_\d+$/i;

    // Derivation generations encoded in an id: 'HR-1-2' → 0, 'HR-1-2#c-abc-1' → 1, nested → 2…
    function parcelIdDepth(parcelId) {
        if (parcelId === undefined || parcelId === null) return 0;
        const id = String(parcelId);
        const modernDepth = id.split('#').length - 1;
        return modernDepth || (LEGACY_DERIVED_PARCEL.test(id) ? 1 : 0);
    }

    function isBaseParcelId(parcelId) {
        return parcelIdDepth(parcelId) === 0;
    }

    // The base cadastral id a derived id descends from, however many generations deep.
    function baseParcelIdOf(parcelId) {
        const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
        const hashAt = id.indexOf('#');
        const modernBase = hashAt > 0 ? id.slice(0, hashAt) : id;
        const legacy = modernBase.match(LEGACY_DERIVED_PARCEL);
        return legacy ? legacy[1] : modernBase;
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

    function parentIdsOf(proposal) {
        const out = collectIds(proposal, 'parentParcelIds');
        const push = list => {
            if (!Array.isArray(list)) return;
            list.forEach(id => {
                if (id !== undefined && id !== null && String(id)) out.push(String(id));
            });
        };
        push(proposal && proposal.parcelIds);
        push(proposal && proposal.cadastreParcelIds);
        push(proposal && proposal.reparcellization && proposal.reparcellization.parcelIds);
        return out;
    }
    function childIdsOf(proposal) { return collectIds(proposal, 'childParcelIds'); }

    // What a record DOES, not merely what its goal implies: a building that fits a plot someone
    // else formed mints nothing and is content on that plot; the same goal drawn over raw ground
    // forms its own parcel. Children present ⇒ it formed ground.
    function roleOf(proposal) {
        if (!proposal) return 'content';
        if (childIdsOf(proposal).length > 0) return 'formation';
        return isFormationGoal(proposal.goal) ? 'potential-formation' : 'content';
    }

    // Verdict for one record. Roles remain useful for reporting, but every published parent
    // declaration names cadastral ground. A derived parcel id is replay output, never input data.
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

        Array.from(new Set(parents)).forEach(id => {
            if (parcelIdDepth(id) > 0) {
                violations.push({ code: 'non-cadastral-parent', id, depth: parcelIdDepth(id) });
            }
        });

        return {
            role,
            maxParentDepth,
            flat: violations.length === 0,
            violations
        };
    }

    // The cadastral parents every record should declare once flattened. Derived parcel ids are
    // local replay output and must never cross the publish boundary as parent declarations.
    //
    // `opts.geometricBaseIds` is AUTHORITATIVE and required: a
    // slice id names only the root it was minted against, and a comasation mints every slice
    // against ONE root even when it consumed dozens of base parcels (Borovje: 38 slices all named
    // `1791/25#…`, 29 real base parents). Parsing ids would therefore under-declare the ground.
    function flattenedParentsFor(proposal, options) {
        const opts = options || {};
        const parents = parentIdsOf(proposal);

        if (!Array.isArray(opts.geometricBaseIds) || opts.geometricBaseIds.length === 0) return null;
        const out = [];
        const taken = new Set();
        opts.geometricBaseIds.forEach(id => {
            const key = baseParcelIdOf(id);
            if (key && !taken.has(key)) { taken.add(key); out.push(key); }
        });
        const declared = [];
        const declaredSet = new Set();
        parents.forEach(id => {
            const key = String(id);
            if (key && !declaredSet.has(key)) { declaredSet.add(key); declared.push(key); }
        });
        const unchanged = declared.length === out.length && declared.every((id, index) => id === out[index]);
        return unchanged ? null : out;
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

    // The publish gate (§15a): mechanically flatten every parent declaration to base cadastral
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
            || (out.roadProposal && out.roadProposal.definition && out.roadProposal.definition.kind === 'government_plan');
        delete out.childParcelIds;
        delete out.descendantParcelIds;
        delete out.parentFeatures;
        delete out.localEditAt;
        delete out.editSeq;
        delete out.revertSnapshot;
        if (!isGovernmentPlan) delete out.childFeatures;
        ['roadProposal', 'reparcellization', 'decideLaterProposal', 'buildingProposal', 'structureProposal'].forEach(key => {
            const sub = out[key];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
            const clean = { ...sub };
            delete clean.childParcelIds;
            delete clean.parentFeatures;
            delete clean.parentsToRemove;
            delete clean.formation;
            // Demolition results are apply-time scans for every formation.
            if (key === 'structureProposal' || key === 'buildingProposal') {
                delete clean.demolishedBuildings;
                delete clean.demolitionScanned;
            }
            if (key === 'roadProposal' && clean.definition && typeof clean.definition === 'object') {
                clean.definition = { ...clean.definition };
                delete clean.definition.surfaceFootprint;
                delete clean.definition.demolishedBuildings;
                delete clean.definition.demolitionScanned;
            }
            if (!(key === 'roadProposal' && isGovernmentPlan)) delete clean.childFeatures;
            out[key] = clean;
        });
        if (out.roadProposal) {
            delete out.definition;
            if (out.geometry && typeof out.geometry === 'object' && !Array.isArray(out.geometry)) {
                out.geometry = { ...out.geometry };
                delete out.geometry.roadPlan;
                delete out.geometry.roadGeometry;
                if (Object.keys(out.geometry).length === 0) delete out.geometry;
            }
        }
        return out;
    }

    function preparePublishRecord(proposal, options) {
        const opts = options || {};
        let out = { ...(proposal || {}) };
        const flat = flattenedParentsFor(out, opts);
        if (Array.isArray(flat)) {
            out.parentParcelIds = flat.slice();
            if (Array.isArray(out.parcelIds)) out.parcelIds = flat.slice();
            if (Array.isArray(out.cadastreParcelIds)) out.cadastreParcelIds = flat.slice();
            // Keep duplicate declarations in typology sub-records consistent with the root.
            ['roadProposal', 'reparcellization', 'decideLaterProposal', 'structureProposal', 'buildingProposal'].forEach(key => {
                const sub = out[key];
                if (sub && typeof sub === 'object' && !Array.isArray(sub) && Array.isArray(sub.parentParcelIds)) {
                    out[key] = { ...sub, parentParcelIds: flat.slice() };
                }
            });
            if (out.reparcellization && Array.isArray(out.reparcellization.parcelIds)) {
                out.reparcellization = { ...out.reparcellization, parcelIds: flat.slice() };
            }
        }
        // Verify BEFORE stripping: children are part of the conformance verdict (they decide
        // the record's role and carry depth violations); the strip then removes them from what
        // actually ships.
        let verdict = conformanceOf(out, opts);
        if (!Array.isArray(opts.geometricBaseIds) || opts.geometricBaseIds.length === 0) {
            verdict = {
                ...verdict,
                flat: false,
                violations: [...verdict.violations, { code: 'geometric-parent-resolution-required' }]
            };
        }
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
