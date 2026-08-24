// Can this proposal be applied — decided BEFORE anything is mutated.
//
// The old shape was: apply optimistically, and if it goes wrong, restore the world from a deep copy
// of every proposal in the store. That copy is why applying member 250 of a plan costs more than
// applying member 3, and it is the whole reason a plan open is quadratic. Knowing the answer first
// removes the need for the copy rather than making the copy cheaper.
//
// This module is the decision only: pure, no map, no storage, no DOM. Callers pass in what they
// found (which parents could not be resolved, and who is already sitting on the ground) and get back
// a verdict they can show a person or act on. The rule itself is unchanged — it is the same one
// _analyzeParentAvailability has always applied — it has simply moved somewhere it can be tested and
// run ahead of time, for a whole plan at once.
(function attachProposalApplyValidate(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__applyValidate = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalApplyValidateFactory() {
    'use strict';

    const CODE_CONFLICT = 'parcel-conflict';
    const CODE_MISSING = 'dependency-missing';

    const asIds = (value) => Array.from(new Set(
        (Array.isArray(value) ? value : [])
            .map(id => (id === undefined || id === null) ? '' : String(id))
            .filter(Boolean)
    ));

    /**
     * @param {object} input
     * @param {string[]} input.declaredParentIds  parcels the proposal says it stands on
     * @param {string[]} input.unresolvableIds    of those, the ones that could not be resolved
     * @param {string}   input.selfProposalId     so a proposal never conflicts with itself
     * @param {(parcelId: string) => string[]} input.occupiedBy  applied proposals holding a parcel
     * @param {(proposalId: string) => string} [input.titleOf]   for a message a person can read
     */
    function validateApply(input) {
        const declared = asIds(input && input.declaredParentIds);
        const unresolvable = new Set(asIds(input && input.unresolvableIds));
        const self = String((input && input.selfProposalId) || '');
        const occupiedBy = (input && typeof input.occupiedBy === 'function') ? input.occupiedBy : () => [];
        const titleOf = (input && typeof input.titleOf === 'function') ? input.titleOf : (id) => String(id);

        // Who is standing on each declared parcel, excluding ourselves — re-applying a proposal
        // over its own ground is not a conflict, it is a no-op.
        const occupiers = new Map();
        const occupiedIds = new Set();
        declared.forEach(parcelId => {
            const holders = asIds(occupiedBy(parcelId)).filter(id => id !== self);
            if (!holders.length) return;
            occupiedIds.add(parcelId);
            holders.forEach(holder => {
                if (!occupiers.has(holder)) occupiers.set(holder, new Set());
                occupiers.get(holder).add(parcelId);
            });
        });

        // Occupied beats not-loaded for the same parcel: "someone is already there" is the true
        // answer, and it is the one that says retrying will never help.
        const notLoaded = Array.from(unresolvable).filter(id => !occupiedIds.has(id));
        const conflicts = Array.from(occupiers.entries()).map(([proposalId, parcels]) => ({
            proposalId,
            title: titleOf(proposalId),
            parcelIds: Array.from(parcels)
        }));

        if (!conflicts.length && !notLoaded.length) {
            return { ok: true, code: null, message: '', conflicts: [], notLoaded: [], retryable: false };
        }

        // A pure geography conflict is final: the ground is taken, and fetching again cannot change
        // that. A missing parent may simply not be loaded yet, which a fetch CAN change — the
        // distinction is what stops a caller retrying forever against an answer that will not move.
        if (conflicts.length && !notLoaded.length) {
            const titles = conflicts.map(c => c.title).filter(Boolean);
            return {
                ok: false,
                code: CODE_CONFLICT,
                message: `Overlaps applied proposal(s): ${titles.join(', ')}`,
                conflicts,
                notLoaded: [],
                retryable: false
            };
        }

        return {
            ok: false,
            code: CODE_MISSING,
            message: 'Prerequisite parcels unavailable or in conflict',
            conflicts,
            notLoaded,
            retryable: true
        };
    }

    /**
     * The same verdict for a whole plan, before a single member is applied — which is the point:
     * a reader can be told what will not apply while nothing has happened yet, instead of finding
     * out at member 140 of 299.
     *
     * Members are judged against the fabric as it stands NOW. A member blocked by another member of
     * the same plan is reported as blocked; ordering the plan so that resolves is the caller's job
     * (plan-order.js), not this one's.
     */
    function validatePlan(members, lookups) {
        const list = Array.isArray(members) ? members.filter(Boolean) : [];
        const applicable = [];
        const blocked = [];

        // A plan's own members take ground from each other by design — §15b, the taker amends the
        // taken — so an occupier that is itself a member of THIS plan is not a blocker. Without
        // this, re-opening a plan whose members are already applied would report almost all of them
        // as conflicting with each other, which is both wrong and useless.
        const planMembers = new Set(list.map(m => String(m.proposalId || '')).filter(Boolean));
        const occupiedByOutsiders = (parcelId) => {
            const holders = (lookups && typeof lookups.occupiedBy === 'function')
                ? lookups.occupiedBy(parcelId)
                : [];
            return asIds(holders).filter(id => !planMembers.has(id));
        };

        list.forEach(member => {
            const verdict = validateApply({
                declaredParentIds: member.declaredParentIds,
                unresolvableIds: member.unresolvableIds,
                selfProposalId: member.proposalId,
                occupiedBy: occupiedByOutsiders,
                titleOf: lookups && lookups.titleOf
            });
            const entry = {
                proposalId: String(member.proposalId || ''),
                title: member.title || String(member.proposalId || ''),
                verdict
            };
            (verdict.ok ? applicable : blocked).push(entry);
        });
        return { applicable, blocked, total: list.length };
    }

    return { validateApply, validatePlan, CODE_CONFLICT, CODE_MISSING };
});
