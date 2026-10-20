// Read-only consent summaries for a selected set of declared source references.
// Inputs supply the current local roster or a signed-receipt verifier. Saved aggregate flags
// never supply decisions, and reading a comparison never rewrites the proposal's history.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalConsentSummary = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const localApi = () => root.ProposalOwnerAcceptance || require('./owner-acceptance.js');
    const flowApi = () => root.__ownershipFlow || require('./ownership-flow.js');
    const approvalApi = () => root.ProposalApproval || require('./approval.js');
    const ids = values => [...new Set((Array.isArray(values) ? values : [])
        .filter(value => value != null).map(String).filter(Boolean))];
    const unknown = basis => ({ basis, parcelAccepted: null, owners: null, parcels: null });

    function summarize(declared, selected, rows, basis) {
        const wanted = declared.filter(id => selected.includes(id));
        const complete = row => !!row && row.owners.length > 0;
        const accepted = row => complete(row) && row.owners.every(id => row.accepted.includes(id));
        const result = unknown(basis);
        if (declared.length && declared.every(id => complete(rows.get(id)))) {
            result.parcels = { accepted: declared.filter(id => accepted(rows.get(id))).length, total: declared.length };
        }
        if (wanted.length && wanted.every(id => complete(rows.get(id)))) {
            const scoped = wanted.map(id => rows.get(id));
            const owners = new Set(scoped.flatMap(row => row.owners));
            const yes = new Set(scoped.flatMap(row => row.accepted));
            result.owners = { accepted: [...owners].filter(id => yes.has(id)).length, total: owners.size };
            result.parcelAccepted = scoped.every(accepted);
        }
        return result;
    }

    function local(record, selectedIds, { currentHash = null, ownerSlotsByParcel = {} } = {}) {
        const declared = ids(record?.cadastreParcelIds);
        const rows = new Map(declared.map(parcelId => {
            const slots = localApi().currentOwnerSlots(ownerSlotsByParcel[parcelId]);
            const entry = record?.ownerAcceptances?.[parcelId];
            const acceptedKeys = new Set(ids(entry?.acceptedOwnerKeys));
            // A browser owner key is parcel-scoped; equal keys on two parcels remain two entries.
            const key = ownerKey => JSON.stringify([parcelId, ownerKey]);
            return [parcelId, {
                owners: slots.map(slot => key(slot.key)),
                accepted: slots.filter(slot => acceptedKeys.has(slot.key)
                    && flowApi().isAcceptanceRecordValid(entry?.acceptedBy?.[slot.key], currentHash))
                    .map(slot => key(slot.key))
            }];
        }));
        return summarize(declared, ids(selectedIds), rows, 'local-records');
    }

    function signed(record, selectedIds, { currentHash = null, verifyReceipt } = {}) {
        if (typeof verifyReceipt !== 'function') return unknown(null);
        const api = approvalApi();
        const rights = api.inspect(record);
        if (!rights.ready) return unknown('signed-receipts');
        const yes = new Set(api.validOwnerIds(record, currentHash, verifyReceipt));
        // Count declared owner parties once across the selected references. Leaseholder/authority
        // decisions belong to the policy tally, not this owner-consent subtotal.
        const rows = new Map(rights.parcels.map(parcel => [parcel.parcelId, {
            owners: parcel.owners.map(owner => owner.ownerId),
            accepted: parcel.owners.filter(owner => yes.has(owner.ownerId)).map(owner => owner.ownerId)
        }]));
        return summarize(ids(record?.cadastreParcelIds), ids(selectedIds), rows, 'signed-receipts');
    }

    return Object.freeze({ local, signed, unknown });
});
