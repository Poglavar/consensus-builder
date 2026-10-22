// A derivation relationship (proposalOrigin) has one explicitly scoped source: a record in this
// browser by its local key, or a published design by its CID. Browser keys never travel: a local
// source is made portable as the CID it has since been published under, or dropped. apiBase
// normalises the API base a design is published at (proposals/design-sync.js).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalOrigin = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const RELATIONS = new Set(['copy', 'revision', 'rebind']);
    const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
    const cidApi = () => root?.Cid || (typeof require === 'function' ? require('../cid.js') : null);
    const isCid = value => typeof value === 'string' && !!cidApi()?.isCid(value);
    // The CID a local record is published under (`published.cid`), or null.
    const publishedCid = record => (record && record.published && isCid(record.published.cid) ? record.published.cid : null);

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
            if (value.source.kind === 'local' && text(value.source.localProposalId) && value.source.cid == null) {
                source = { kind: 'local', localProposalId: text(value.source.localProposalId) };
            } else if (value.source.kind === 'design' && isCid(value.source.cid) && value.source.localProposalId == null) {
                source = { kind: 'design', cid: value.source.cid };
            } else {
                throw new TypeError('A proposal origin requires a local key or a design CID.');
            }
        }
        return { relation: value.relation, source, title: text(value.title) };
    }

    // The source of a record derived from `record`: the design it is published as, else its local key.
    function fromRecord(record, { relation = 'revision', localProposalId } = {}) {
        if (!record || typeof record !== 'object') throw new TypeError('A source proposal is required.');
        const cid = publishedCid(record);
        const local = text(localProposalId) || text(record.proposalId);
        const source = cid ? { kind: 'design', cid } : local ? { kind: 'local', localProposalId: local } : null;
        if (!source) throw new TypeError('The source proposal has no qualified identity.');
        return normalize({ relation, source, title: record.title || record.name });
    }

    // The record in `records` the origin names: the one with its local key, or a local copy of its
    // design (the first, when this browser holds several).
    function resolveLocal(value, records) {
        const origin = normalize(value);
        if (!origin?.source) return null;
        const ref = origin.source;
        return (Array.isArray(records) ? records : []).find(record => (ref.kind === 'local'
            ? text(record?.proposalId) === ref.localProposalId
            : publishedCid(record) === ref.cid)) || null;
    }

    // An unpublished browser key has no meaning in another browser. Preserve the authored
    // relationship/title with an unknown source, or name the design the source has since been
    // published as.
    function portable(value, { findLocal } = {}) {
        const origin = normalize(value);
        if (!origin || origin.source?.kind !== 'local') return origin;
        const record = typeof findLocal === 'function' ? findLocal(origin.source.localProposalId) : null;
        const cid = text(record?.proposalId) === origin.source.localProposalId ? publishedCid(record) : null;
        return { ...origin, source: cid ? { kind: 'design', cid } : null };
    }

    return Object.freeze({ normalize, fromRecord, resolveLocal, portable, apiBase });
});
