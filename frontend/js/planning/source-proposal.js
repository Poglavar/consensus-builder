// Source-backed obligatory proposals and pinned references. The provider's durable record is
// the source of truth; this projection adds no duplicate geometry/cache and confers no consent.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningSourceProposal = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const schemaVersion = 'source-proposal.v1';
    const text = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
    const invalid = message => { throw Object.assign(new Error(message), { status: 422, code: 'invalid-source-reference' }); };
    function fromRepresentation(item) {
        const source = item?.source;
        if (item?.role !== 'permitted' || !text(source?.id) || !text(source.recordId) || !text(source.version)) return null;
        return {
            schemaVersion, proposalId: `source:${item.id}`, proposalClass: 'obligatory-source', decisionKind: null,
            title: item.title, readOnly: true,
            source: { providerId: source.id, city: source.city, recordId: source.recordId, edition: source.edition,
                revision: source.version, url: source.url, storage: source.storage },
            authority: { effect: item.authority?.effect || 'unknown', basis: item.authority?.basis || 'unknown',
                issuer: source.issuer || null, instrument: source.label, effectiveFrom: null, effectiveUntil: null },
            applicability: { status: item.authority?.applicability || 'unresolved',
                parcelIds: source.parcel ? [source.parcel] : [], scenario: source.scenario || null,
                // The adapter does not guess legal conditions from a scalar envelope.
                conditions: null },
            lifecycle: { availability: item.assessment.current === false ? 'withdrawn' : 'available',
                revisionMode: 'latest-only', supersedes: null },
            constraints: item.constraints || [], representationId: item.id,
            assessment: { status: item.assessment.status || null, reason: item.assessment.reason || null,
                quality: item.assessment.meaning, constraints: item.assessment.constraints }
        };
    }
    function reference(proposal) {
        if (proposal?.schemaVersion !== schemaVersion) throw new Error('Invalid source proposal');
        return { proposalId: proposal.proposalId, providerId: proposal.source.providerId,
            recordId: proposal.source.recordId, edition: proposal.source.edition, revision: proposal.source.revision,
            city: proposal.source.city, parcelId: proposal.applicability.parcelIds[0] || null, scenario: proposal.applicability.scenario };
    }
    function validateReferences(values) {
        if (values === undefined) return;
        if (!Array.isArray(values) || values.length > 100) invalid('Source references must be a bounded array');
        const seen = new Set();
        for (const value of values) {
            if (!value || !['proposalId', 'providerId', 'recordId', 'edition', 'revision', 'city', 'scenario'].every(key => text(value[key]))
                || (value.parcelId !== null && !text(value.parcelId))
                || Object.keys(value).some(key => !['proposalId', 'providerId', 'recordId', 'edition', 'revision', 'city', 'parcelId', 'scenario'].includes(key))
                || !value.proposalId.startsWith('source:') || seen.has(value.proposalId)) invalid('Invalid or duplicate source reference');
            seen.add(value.proposalId);
        }
    }
    function compareReference(value, proposal) {
        validateReferences([value]);
        if (!proposal) return 'unavailable';
        const current = reference(proposal);
        if (['proposalId', 'providerId', 'recordId', 'edition', 'city', 'parcelId', 'scenario'].some(key => value[key] !== current[key])) return 'different-source';
        if (value.revision !== current.revision) return 'changed';
        return proposal.lifecycle.availability === 'withdrawn' ? 'withdrawn' : 'same';
    }
    return { schemaVersion, fromRepresentation, reference, validateReferences, compareReference };
});
