// Can this proposal be applied — answered from the RECORD, before any work is done.
//
// The apply already refuses in about thirty named ways (`building-over-road`, `no-slices`,
// `readjustment-taken-ground`, …) and records `{code, message}` for each. Those refusals are
// correct; they just arrive late, one proposal at a time, after the expensive setup — so a plan of
// 299 finds out at member 140 that member 140 was never applicable.
//
// This module hoists the subset that can be decided from the stored record alone, so a whole plan
// can be judged before a single member is applied. It is deliberately CONSERVATIVE: it must never
// refuse something the apply would have accepted, because a false refusal is silent lost work. When
// in doubt it says ok and lets the apply have the final word — the apply's own checks are unchanged
// and still run.
//
// Codes are the apply's own, so a precheck refusal and a runtime refusal read identically.
// Pure: no map, no storage, no DOM, no turf.
(function attachProposalApplyValidate(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__applyValidate = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalApplyValidateFactory() {
    'use strict';

    const CODE_INVALID = 'invalid-proposal';
    const CODE_NO_BUILDING_GEOMETRY = 'missing-building-geometry';

    const ok = () => ({ ok: true, code: null, message: '' });
    const refuse = (code, message) => ({ ok: false, code, message });

    // Mirrors apply/buildings.js: geometry.buildings, each entry kept only if it survives cloning
    // with a `geometry`. Counting the same way is the point — a precheck that counts differently
    // from the apply is a precheck that disagrees with it.
    function usableBuildingFootprints(record) {
        const raw = record && record.geometry && record.geometry.buildings;
        if (!Array.isArray(raw)) return 0;
        return raw.filter(feature => feature && feature.geometry).length;
    }

    /**
     * @param {object} record            the stored proposal
     * @param {object} [deps]
     * @param {(record: object) => {route: string}} [deps.classify]  apply/route.js's classifier
     */
    function validateApply(record, deps) {
        if (!record || typeof record !== 'object') {
            return refuse(CODE_INVALID, 'The proposal record is empty — there is no data to apply.');
        }

        const classify = deps && typeof deps.classify === 'function' ? deps.classify : null;
        // Without the classifier we cannot tell a building from a road, and a rule applied to the
        // wrong kind is exactly the false refusal this must not produce. Say ok and move on.
        if (!classify) return ok();

        let route = null;
        try {
            route = classify(record);
        } catch (_) {
            return ok();
        }
        const kind = route && route.route;

        if (kind === 'building') {
            if (usableBuildingFootprints(record) === 0) {
                return refuse(
                    CODE_NO_BUILDING_GEOMETRY,
                    'The proposal stores no building footprints (geometry.buildings is empty).'
                );
            }
        }

        // Every other kind: no record-level rule yet. The apply's own checks still decide.
        return ok();
    }

    /**
     * The same verdict for a whole plan, before a single member is applied — so the reader can be
     * told what will not apply while nothing has happened, instead of finding out part-way through.
     */
    function validatePlan(records, deps) {
        const list = Array.isArray(records) ? records.filter(Boolean) : [];
        const applicable = [];
        const blocked = [];
        list.forEach(entry => {
            const record = entry && entry.record ? entry.record : entry;
            const verdict = validateApply(record, deps);
            const item = {
                proposalId: String((entry && entry.proposalId) || (record && record.proposalId) || ''),
                title: (record && (record.title || record.name)) || String((entry && entry.proposalId) || ''),
                verdict
            };
            (verdict.ok ? applicable : blocked).push(item);
        });
        return { applicable, blocked, total: list.length };
    }

    return { validateApply, validatePlan, CODE_INVALID, CODE_NO_BUILDING_GEOMETRY };
});
