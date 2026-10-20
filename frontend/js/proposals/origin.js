// A derivation relationship has one explicitly scoped source. Browser keys never name API rows.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalOrigin = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const RELATIONS = new Set(['copy', 'revision', 'rebind']);
    const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
    const rowId = value => /^[1-9]\d*$/.test(String(value ?? '')) ? String(value) : null;
    function apiBase(value) {
        if (!text(value)) return null;
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
            return url.href.replace(/\/+$/, '');
        } catch { return null; }
    }

    function normalize(value) {
        if (value == null) return null;
        if (!value || typeof value !== 'object' || !RELATIONS.has(value.relation)) {
            throw new TypeError('A proposal origin requires a copy, revision or rebind relationship.');
        }
        let source = null;
        if (value.source != null) {
            if (value.source.kind === 'local' && text(value.source.localProposalId)
                && value.source.proposalRowId == null && value.source.apiBase == null) {
                source = { kind: 'local', localProposalId: text(value.source.localProposalId) };
            } else if (value.source.kind === 'publication' && rowId(value.source.proposalRowId) && apiBase(value.source.apiBase)
                && value.source.localProposalId == null) {
                source = { kind: 'publication', apiBase: apiBase(value.source.apiBase), proposalRowId: rowId(value.source.proposalRowId) };
            } else {
                throw new TypeError('A proposal origin requires a qualified local or publication reference.');
            }
        }
        return { relation: value.relation, source, title: text(value.title) };
    }

    function fromRecord(record, { relation = 'revision', backendBase, localProposalId } = {}) {
        if (!record || typeof record !== 'object') throw new TypeError('A source proposal is required.');
        const local = text(localProposalId) || text(record.proposalId);
        const row = rowId(record.serverProposalId);
        const base = apiBase(record.publicationApiBase);
        const source = row && base
            ? { kind: 'publication', apiBase: base, proposalRowId: row }
            : local ? { kind: 'local', localProposalId: local } : null;
        if (!source) throw new TypeError('The source proposal has no qualified identity.');
        return normalize({ relation, source, title: record.title || record.name });
    }

    function resolveLocal(value, records, backendBase) {
        const origin = normalize(value);
        if (!origin?.source) return null;
        const ref = origin.source;
        const candidates = (Array.isArray(records) ? records : []).filter(record => {
            if (ref.kind === 'local') return text(record?.proposalId) === ref.localProposalId;
            return rowId(record?.serverProposalId) === ref.proposalRowId
                && apiBase(record?.publicationApiBase) === ref.apiBase;
        });
        if (candidates.length > 1) throw new Error('The source proposal has multiple local copies.');
        return candidates[0] || null;
    }

    // An unpublished browser key has no meaning in another browser. Preserve the authored
    // relationship/title with an unknown source, or qualify the source if it has since published.
    function portable(value, { findLocal, backendBase } = {}) {
        const origin = normalize(value);
        if (!origin || origin.source?.kind !== 'local') return origin;
        const record = typeof findLocal === 'function' ? findLocal(origin.source.localProposalId) : null;
        if (text(record?.proposalId) === origin.source.localProposalId && rowId(record?.serverProposalId) && apiBase(record?.publicationApiBase)) {
            return fromRecord(record, { relation: origin.relation, backendBase });
        }
        return { ...origin, source: null };
    }

    function sameReference(left, right) {
        if (!left || !right || left.kind !== right.kind) return false;
        return left.kind === 'local'
            ? text(left.localProposalId) !== null && text(left.localProposalId) === text(right.localProposalId)
            : left.kind === 'publication' && apiBase(left.apiBase) !== null
                && apiBase(left.apiBase) === apiBase(right.apiBase)
                && rowId(left.proposalRowId) !== null && rowId(left.proposalRowId) === rowId(right.proposalRowId);
    }

    return Object.freeze({ normalize, fromRecord, resolveLocal, portable, sameReference, apiBase, rowId });
});
