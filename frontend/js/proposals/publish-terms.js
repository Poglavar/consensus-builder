// The publish terms of a proposal (proposal-kinds.md): the one place that turns the kind and the
// terms chosen for it into record fields, whichever way a proposal is published. Pure: no DOM.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalPublishTerms = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const kinds = () => root.ProposalKind || (typeof require === 'function' ? require('./proposal-kind.js') : null);
    const VOTE_MAX_DAYS = 365;
    const DAY_MS = 86400000;
    const finite = value => typeof value === 'number' ? Number.isFinite(value) : (value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value)));
    const clamp = (value, min, max, fallback) => finite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;

    /** Whole voting days, 1..365; anything else is the full year. */
    function voteDays(value) {
        const days = Math.floor(Number(value));
        return Number.isFinite(days) && days > 0 ? Math.min(days, VOTE_MAX_DAYS) : VOTE_MAX_DAYS;
    }

    /**
     * The record fields for a proposal's terms. `terms` holds what the proposer chose: kind, offer,
     * offerCurrency, isConditional, expiresAt (ISO, owner deals), decayEnabled/decayPercent/
     * decayDurationMs, depositEnabled/depositPercent, voteExpiryDays. A vote carries no money and
     * runs to its voting deadline. `kind` is written only when chosen: a local draft has none.
     * Throws when the kind and its terms do not agree (ProposalKind.kindErrors).
     */
    function publishFields(terms = {}, { now = Date.now(), saleOffer = false } = {}) {
        const api = kinds();
        const kind = terms.kind ?? null;
        const fields = {};
        if (kind !== null) fields.kind = kind;
        const offerCurrency = terms.offerCurrency || 'USDT';
        if (api.isNonBinding({ kind })) {
            const days = voteDays(terms.voteExpiryDays);
            Object.assign(fields, {
                offer: null, budget: null, offerCurrency, budgetCurrency: offerCurrency,
                isConditional: false, disbursementMode: null,
                expiresAt: new Date(now + days * DAY_MS).toISOString(), voteExpiryDays: days,
                decayEnabled: false, decayPercent: 0, decayDurationMs: 0,
                depositEnabled: false, depositPercent: 0
            });
        } else {
            const offer = finite(terms.offer) && Number(terms.offer) > 0 ? Number(terms.offer) : 0;
            const isConditional = terms.isConditional === true;
            const decayEnabled = terms.decayEnabled === true;
            const depositEnabled = terms.depositEnabled === true;
            Object.assign(fields, {
                offer, budget: offer, offerCurrency, budgetCurrency: offerCurrency,
                isConditional, disbursementMode: isConditional ? 'conditional' : 'partial',
                expiresAt: terms.expiresAt || null,
                decayEnabled,
                decayPercent: decayEnabled ? clamp(terms.decayPercent, 1, 100, 50) : 0,
                decayDurationMs: decayEnabled ? Math.max(0, Number(terms.decayDurationMs) || 0) : 0,
                depositEnabled,
                depositPercent: depositEnabled ? clamp(terms.depositPercent, 10, 200, 100) : 0
            });
        }
        const errors = api.kindErrors({ ...fields, ...(saleOffer ? { goal: 'ownership-transfer-from-me' } : {}) });
        if (errors.length) {
            throw Object.assign(new Error(errors[0].message), { code: `invalid-proposal-kind:${errors[0].code}` });
        }
        return fields;
    }

    /** Whether a record still needs its terms chosen before it leaves the device. */
    function needsTerms(record, { isPublished = () => false } = {}) {
        return !!record && record.termsConfirmed !== true && !isPublished(record);
    }

    /** Original whole-proposal consideration, never a budget, balance or recipient entitlement. */
    function authoredOffer(record) {
        if (!record || kinds().kindOf(record) !== kinds().OWNER_DEAL
            || typeof record.offer !== 'number' || !Number.isFinite(record.offer) || record.offer < 0
            || typeof record.offerCurrency !== 'string' || !record.offerCurrency.trim()) return null;
        return { amount: record.offer, currency: record.offerCurrency.trim().toUpperCase() };
    }

    /** Declared payout terms for a positive offer, never evidence of funding or payment. */
    function payoutMode(record = {}) {
        if (kinds().kindOf(record) !== kinds().OWNER_DEAL
            || !['number', 'string'].includes(typeof record.offer)
            || !finite(record.offer) || Number(record.offer) <= 0) return null;
        const mode = record.disbursementMode;
        const fromFlag = typeof record.isConditional === 'boolean'
            ? (record.isConditional ? 'conditional' : 'partial') : null;
        if (mode == null || mode === '') return fromFlag;
        if (mode !== 'conditional' && mode !== 'partial') return null;
        return fromFlag && fromFlag !== mode ? null : mode;
    }

    /**
     * The kind a record's terms were chosen under, for a fork or edit to start from: its own kind,
     * an owner deal for a published record without one (ProposalKind.kindOf), and null for a local
     * drawing whose terms were never chosen (the dialog then opens on its default).
     */
    function chosenKind(record, { isPublished = () => false } = {}) {
        if (!record) return null;
        if (record.kind) return record.kind;
        return needsTerms(record, { isPublished }) ? null : kinds().kindOf(record);
    }

    /**
     * The owner-approval setup a published record carries (land-readjustmend.md §16), or null
     * for none. A land readjustment keeps its setup whatever the kind, since its rights snapshot
     * also says who owns which plot, and one published from a draft gets the default (unanimous,
     * rights unresolved) when none was set. Anything else carries only the setup its author set,
     * and a community vote none at all: owners do not decide it.
     */
    function approvalSetupFor({ kind = null, readjustment = false, approvalConfig = null, fromDraft = false } = {}) {
        if (readjustment) return approvalConfig || (fromDraft ? { schema: 'proposal-approval/v1', rights: null, policy: { type: 'unanimous' } } : null);
        if (kind === kinds().COMMUNITY_VOTE) return null;
        return approvalConfig || null;
    }

    /**
     * What publishing a local record in place writes onto it: the chosen terms, its details and the
     * approval setup its kind allows (approvalSetupFor; null means none). Its design is untouched:
     * publishing appends terms to what was drawn, it never re-creates it.
     */
    function termsInPlace(record, terms, { name = '', description = '', author = '', epochYear = null, now = Date.now() } = {}) {
        const saleOffer = kinds().isOwnerSaleOffer(record);
        const fields = publishFields(saleOffer ? { ...terms, kind: kinds().OWNER_DEAL } : terms, { now, saleOffer });
        const approvalConfig = approvalSetupFor({
            kind: fields.kind ?? null,
            readjustment: record.goal === 'reparcellization' || !!record.reparcellization,
            approvalConfig: record.approvalConfig || null
        });
        return { ...fields, title: name, name, proposalName: name, description, author, epochYear, approvalConfig, termsConfirmed: true };
    }

    /**
     * A local record's terms confirmed under one kind, as Share entire plan does for every proposal
     * it carries: the record's own money terms stay for an owner deal, a vote drops them.
     */
    function confirmedRecordFields(record, kind, { now = Date.now() } = {}) {
        const saleOffer = kinds().isOwnerSaleOffer(record);
        return { ...publishFields({ ...record, kind: saleOffer ? 'owner-deal' : kind }, { now, saleOffer }), termsConfirmed: true };
    }

    return Object.freeze({ VOTE_MAX_DAYS, voteDays, publishFields, needsTerms, authoredOffer, payoutMode, chosenKind, approvalSetupFor, termsInPlace, confirmedRecordFields });
});
