// Published URL references resolve to explicit browser copies of publication rows.
// Local keys, chain tokens and fork ancestry never substitute for the linked publication.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SharedLinkCopies = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function rowId(value) {
        const id = String(value ?? '');
        return /^[1-9]\d*$/.test(id) ? id : null;
    }

    function referenceRowId(reference, payload) {
        const ref = String(reference ?? '');
        if (/^\d+$/.test(ref)) return rowId(ref);
        // An authored URL identifier is resolved by the API response, never by a local key.
        return ref && payload?.proposalId === ref ? rowId(payload.id) : null;
    }

    function match(records, references, fetched = new Map()) {
        const rows = new Map();
        for (const reference of references) {
            const ref = String(reference);
            const row = referenceRowId(ref, fetched.get(ref));
            if (row) rows.set(ref, row);
        }
        const wantedRows = new Set(rows.values());
        const byRow = new Map();
        for (const record of records) {
            const row = rowId(record?.serverProposalId);
            if (!row || !wantedRows.has(row)) continue;
            if (byRow.has(row)) throw Object.assign(new Error(`Multiple local copies declare published row ${row}.`), {
                code: 'ambiguous-server-proposal-row'
            });
            byRow.set(row, record);
        }
        return new Map([...rows].filter(([, row]) => byRow.has(row)).map(([ref, row]) => [ref, byRow.get(row)]));
    }

    return Object.freeze({ rowId, referenceRowId, match });
});
