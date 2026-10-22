// The authored-record boundary. Published records declare their ground once, as an explicit flat
// set of cadastral IDs. Live output IDs are opaque materialization details and are never parsed to
// infer depth, parents, or cadastral identity.
(function (global) {
    'use strict';

    // Goals whose typology forms ground (they mint parcels and move ownership). Mirrors
    // ownership-flow's DESTINATION_BY_GOAL; kept local so this module stays dependency-free.
    const FORMATION_GOALS = Object.freeze([
        'road-track', 'park', 'square', 'lake', 'station', 'single', 'buildings',
        'reparcellization', 'decide-later'
    ]);

    function isFormationGoal(goal) {
        return FORMATION_GOALS.indexOf(String(goal === undefined || goal === null ? '' : goal).trim()) !== -1;
    }

    function normalizedIds(values) {
        return Array.from(new Set((Array.isArray(values) ? values : [])
            .map(value => value === undefined || value === null ? '' : String(value).trim())
            .filter(Boolean)));
    }

    // Record role comes from authored intent. Materialized children are deliberately unavailable
    // here: observing them would make the same proposal change meaning after it was applied.
    function roleOf(proposal) {
        if (!proposal) return 'content';
        return isFormationGoal(proposal.goal) ? 'potential-formation' : 'content';
    }

    function siteBindingApi() {
        if (typeof globalThis !== 'undefined' && globalThis.__siteBinding) return globalThis.__siteBinding;
        return typeof require === 'function' ? require('./site-binding.js') : null;
    }

    // Whether this record may stand with an empty declaration: a material proposal (not an act on
    // parcels) with a site or a footprint of its own (PARCEL-OPTIONAL.md rule 4). Its binding is
    // computed from that site at publish; on bare ground it is empty.
    function mayHaveEmptyDeclaration(proposal) {
        const api = siteBindingApi();
        if (!api || typeof api.requiresParcels !== 'function') return false;
        return !api.requiresParcels(proposal);
    }

    // The cadastral declaration is authoritative by field, not by ID syntax. Current records have
    // exactly one land declaration. Compatibility fields are migration input, never a second view
    // retained by an API or browser record. A material record with a site may declare nothing.
    function conformanceOf(proposal, options) {
        const opts = options || {};
        const role = opts.mintsGround === true ? 'formation'
            : (opts.mintsGround === false ? 'content' : roleOf(proposal));
        const anchors = normalizedIds(proposal?.cadastreParcelIds);
        const violations = [];
        if (!anchors.length && !mayHaveEmptyDeclaration(proposal)) violations.push({ code: 'missing-cadastral-provenance' });
        const authored = (typeof globalThis !== 'undefined' && globalThis.ProposalAuthoredRecord)
            ? globalThis.ProposalAuthoredRecord
            : (typeof require === 'function' ? require('./authored-record.js') : null);
        anchors.forEach((id, index) => {
            if (authored && typeof authored.isDerivedParcelId === 'function'
                && authored.isDerivedParcelId(id)) {
                violations.push({
                    code: 'generated-cadastral-anchor',
                    field: `cadastreParcelIds[${index}]`,
                    id
                });
            }
        });
        const aliases = authored && typeof authored.legacyCadastreDeclarations === 'function'
            ? authored.legacyCadastreDeclarations(proposal)
            : [];
        aliases.forEach(alias => violations.push({
            code: 'legacy-cadastral-declaration',
            field: alias.path
        }));

        return {
            role,
            cadastreParcelIds: anchors,
            flat: violations.length === 0,
            violations
        };
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

    // The publish gate (§15a) verifies the already-authored root declaration and projects away
    // disposable materialization output. It never resolves or flattens a generated parcel id;
    // that one-time conversion belongs to the explicit migration.
    // Data a record must never carry ACROSS BROWSERS (§15a: children, formations, demolition
    // scans are DERIVED — apply regenerates them from the definition against the receiver's live
    // fabric). Shipping them makes the receiver trust another browser's fabric: an uploaded
    // formation record made the receiving apply skip forming entirely, and uploaded child lists
    // merged into locally minted ids and permanently failed the presence check (the reload
    // re-apply loop through a new door). Applied at PUBLISH and again at IMPORT — old server rows
    // still carry the fields.
    //
    // Government-plan road features are authored, but live under roadProposal.definition.features
    // rather than the runtime-sounding childFeatures field.
    function corridorOsmForm() {
        if (global.__corridorOsmForm) return global.__corridorOsmForm;
        if (typeof require === 'function') return require('../corridor-osm-form.js');
        throw new Error('Cannot project authored proposal: the corridor record form is unavailable.');
    }

    // `options.keepDemolition` keeps the apply-time demolition results (`demolishedBuildings`,
    // `demolitionScanned`) on the sub-records: the proposal store's in-memory canonical form needs
    // them, because the carve, the 2D building outcomes and the server carve read them from the
    // applied record there. The authored projections (local rows, publish, share, chain) never
    // carry them; a replay re-derives them (2026-10-22: stripping them at index time had silently
    // emptied every demolition since 2026-09-03).
    function stripDerivedRecordData(record, options = {}) {
        if (!record || typeof record !== 'object') return record;
        const keepDemolition = !!(options && options.keepDemolition);
        const out = { ...record };
        delete out.status;
        delete out.childParcelIds;
        delete out.descendantParcelIds;
        delete out.parentFeatures;
        delete out.localEditAt;
        delete out.editSeq;
        delete out.revertSnapshot;
        delete out.childFeatures;
        ['roadProposal', 'reparcellization', 'decideLaterProposal', 'buildingProposal', 'structureProposal'].forEach(key => {
            const sub = out[key];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
            const clean = { ...sub };
            delete clean.applied;
            delete clean.appliedAt;
            delete clean.status;
            delete clean.childParcelIds;
            delete clean.parentFeatures;
            delete clean.parentsToRemove;
            delete clean.formation;
            // Demolition results are apply-time scans for every formation.
            if ((key === 'structureProposal' || key === 'buildingProposal') && !keepDemolition) {
                delete clean.demolishedBuildings;
                delete clean.demolitionScanned;
            }
            if (key === 'roadProposal' && clean.definition && typeof clean.definition === 'object') {
                clean.definition = { ...clean.definition };
                delete clean.definition.surfaceFootprint;
                if (!keepDemolition) {
                    delete clean.definition.demolishedBuildings;
                    delete clean.definition.demolitionScanned;
                }
                // The road keeps its VIEW here (stretch fields): this projection runs in memory,
                // between the draft and the store, where every reader expects the view. Only the
                // two storage boundaries encode the record (encodeRoadRecord: the local store's
                // row and the publish body); the store decodes on load (decodeRoadView).
                // 2026-10-16: encoding here made the draft's road a record before the land check
                // and the junction planner read it, and a drawn road failed at Finish.
            }
            delete clean.childFeatures;
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
        const authored = (typeof globalThis !== 'undefined' && globalThis.ProposalAuthoredRecord)
            ? globalThis.ProposalAuthoredRecord
            : (typeof require === 'function' ? require('./authored-record.js') : null);
        if (!authored || typeof authored.cleanFeatureContainers !== 'function') {
            throw new Error('Cannot project authored proposal: authored-record boundary is unavailable.');
        }
        const cleaned = authored.cleanFeatureContainers(out);
        if (typeof authored.stripCadastreAliases !== 'function') {
            throw new Error('Cannot project authored proposal: cadastre-alias projection is unavailable.');
        }
        return authored.stripCadastreAliases(cleaned);
    }

    function findNonCadastralReference(proposal) {
        const authored = (typeof globalThis !== 'undefined' && globalThis.ProposalAuthoredRecord)
            ? globalThis.ProposalAuthoredRecord
            : (typeof require === 'function' ? require('./authored-record.js') : null);
        return authored && typeof authored.findNonCadastralReference === 'function'
            ? authored.findNonCadastralReference(proposal)
            : null;
    }

    // The stored shape of a road (roads.md §11): the OSM document alone under
    // roadProposal.definition.osm. Applied at the local store's row and the publish body.
    function encodeRoadRecord(record) {
        const definition = record && record.roadProposal && record.roadProposal.definition;
        if (!definition || typeof definition !== 'object') return record;
        return { ...record, roadProposal: { ...record.roadProposal, definition: corridorOsmForm().toRecord(definition) } };
    }

    // The running shape: the stretch and cross-section fields decoded from the stored document.
    // Applied when a record enters the store, before anything reads its geometry.
    function decodeRoadView(record) {
        const definition = record && record.roadProposal && record.roadProposal.definition;
        if (!definition || typeof definition !== 'object' || !definition.osm) return record;
        return { ...record, roadProposal: { ...record.roadProposal, definition: corridorOsmForm().toView(definition) } };
    }

    function preparePublishRecord(proposal, options) {
        const opts = options || {};
        let out = { ...(proposal || {}) };
        const anchors = normalizedIds(out.cadastreParcelIds);
        if (anchors.length) {
            out.cadastreParcelIds = anchors.slice();
        }
        // Validate the unstripped input.  Otherwise a conflicting legacy declaration could be
        // deleted by the projection and silently pass the publish gate.
        let verdict = conformanceOf(out, opts);
        const invalid = findNonCadastralReference(out);
        if (invalid) {
            verdict = {
                ...verdict,
                flat: false,
                violations: [...verdict.violations, {
                    code: 'non-cadastral-reference',
                    field: invalid.path,
                    id: invalid.id
                }]
            };
        }
        if (!anchors.length && !mayHaveEmptyDeclaration(out)) {
            verdict = {
                ...verdict,
                flat: false,
                violations: [...verdict.violations, { code: 'geometric-parent-resolution-required' }]
            };
        }
        out = encodeRoadRecord(stripDerivedRecordData(out));
        // Application is local materialization state.  It belongs in the browser's authored log
        // so boot can replay the standing set, but it has no meaning in a portable proposal.
        delete out.applied;
        delete out.appliedAt;
        delete out.localPurchaseSimulation;
        // Unsigned consent bookkeeping belongs to this browser. Verified decisions travel through
        // the signed receipt relay, separately from this authored definition.
        delete out.acceptedParcelIds;
        delete out.ownerAcceptances;
        // This unqualified client timestamp has no verified execution-event source.
        delete out.executedAt;
        return { proposal: out, verdict };
    }

    const api = {
        FORMATION_GOALS,
        isFormationGoal,
        roleOf,
        mayHaveEmptyDeclaration,
        conformanceOf,
        findNonCadastralReference,
        stripDerivedRecordData,
        encodeRoadRecord,
        decodeRoadView,
        preparePublishRecord,
        scanRecords
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__formationDepth = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
