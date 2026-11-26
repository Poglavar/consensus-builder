// When a lens member may state AgreementDecision-v1 `satisfied` for an agreement, and with which fields:
// one rule for the reference member's service (backend/lens/agreement-decision.js) and for a member
// whose key is in a person's wallet, such as a city authority confirming in the agreement panel.
// - An owners' or other counted agreement: the member counts the relayed signed decisions with the
//   approval engine and may state `satisfied` only once the rule passes; the evidence is the hash of
//   the counted receipts and the source time the last counted decision's signing time. A member
//   confirming from its wallet whose key is also one of the rule's required authorities decides as
//   that authority by this confirmation: its key signs the attestation on chain, so no separate signed
//   decision is needed. The evidence then also names it, and the source time is the chain time.
// - A crowdfunding (investors) agreement: the program checks the funding target itself; the lens
//   states its own approval (investor eligibility, a city's consent to the plan, any condition it was
//   named for). The reference service issues no automatic one; a member's wallet may, and its evidence
//   names the member and its source time is the chain time of its decision.
// Pure, UMD: window.AgreementDecisionPlan, module.exports for node. Refusals are thrown as Errors with
// { status, code, details } (the service maps them to LensError).
(function attachAgreementDecisionPlan(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgreementDecisionPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function agreementDecisionPlanFactory(root) {
    'use strict';

    const approvalApi = () => (root && root.ProposalApproval) || require('./proposals/approval.js');
    const relayApi = () => (root && root.ProposalApprovalRelay) || require('./proposals/approval-relay.js');
    const seconds = instant => Math.floor(Date.parse(instant) / 1000);
    const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    function refusal(status, code, message, details = {}) {
        return Object.assign(new Error(message), { status, code, details });
    }

    /**
     * The decisions that count: relayed receipts folded (each verified) into every party's current
     * approval, `counted` in signing order, the engine's tally, and when the last applied decision was signed.
     * `subject` is the agreement's decision subject (agreements/decisions.js decisionSubject).
     */
    function countDecisions(subject, receipts) {
        const relay = relayApi();
        const folded = relay.fold(subject, receipts || []);
        const counted = relay.countedApprovals(folded);
        const last = folded.applied.at(-1) ?? null;
        const approvedIds = Object.keys(folded.ownerApprovals);
        return { subject, counted, approvedIds, tally: approvalApi().tally(subject, approvedIds), lastDecidedAt: last?.decidedAt ?? null };
    }

    // The checks every member makes before stating a decision. `agreement` is { cid, content, status,
    // deadline, onchain: { lenses, decision } | null } as GET /agreements/:cid serves it (status from
    // the chain once minted); the browser builds the same from the published record and the account.
    function commonChecks({ agreement, lensKey, nowSeconds, details }) {
        const content = agreement.content || {};
        if (typeof content.sponsor !== 'string' || !BASE58_KEY.test(content.sponsor)) {
            throw refusal(422, 'no_sponsor', 'the agreement names no sponsor wallet, so no chain account can carry its decision', details);
        }
        if (!approvalApi().lensKeys({ lens: content.rule?.lens }).includes(lensKey)) {
            throw refusal(409, 'not_in_lens', 'this lens member is not in the agreement\'s lens', details);
        }
        const onchain = agreement.onchain;
        if (onchain && !onchain.lenses.includes(lensKey)) {
            throw refusal(409, 'not_agreement_lens', `the agreement's account names lens members ${onchain.lenses.join(', ') || '(none)'}; only their attestations settle it`, details);
        }
        if (agreement.status === 'executed' || agreement.status === 'cancelled') {
            throw refusal(409, 'agreement_closed', `the agreement is ${agreement.status}`, details);
        }
        if (onchain && onchain.decision !== 'pending') {
            throw refusal(409, 'decision_recorded', `the agreement's account already records the decision ${onchain.decision}`, details);
        }
        // The program records a decision only before the deadline (attest: DeadlinePassed).
        if (agreement.deadline && seconds(agreement.deadline) <= nowSeconds) {
            throw refusal(409, 'deadline_passed', `the deadline ${agreement.deadline} has passed; the account can only expire`, details);
        }
        return content.sponsor;
    }

    /**
     * The fields of a counted agreement's decision (owners, community-led rules): `count` from
     * countDecisions. `asAuthority`: the member decides from its own wallet, so when its key is a
     * required authority of the rule this confirmation is that authority's decision (never for the
     * reference service, which acts on an operator's request). → { fields, tally, counted, asAuthority }
     */
    function countedDecision({ agreement, count, lensKey, nowSeconds, asAuthority = false }) {
        const authorityIds = count.tally.authorities?.map(row => row.authorityId) || [];
        const decidesAsAuthority = asAuthority && authorityIds.includes(lensKey) && !(count.approvedIds || []).includes(lensKey);
        const tally = decidesAsAuthority ? approvalApi().tally(count.subject, [...count.approvedIds, lensKey]) : count.tally;
        const sponsor = commonChecks({ agreement, lensKey, nowSeconds, details: { tally } });
        if (!tally.passed) {
            throw refusal(409, 'rule_not_met', tally.ready ? 'the decision rule is not met' : `the decision rule cannot be counted: ${tally.reason}`, { tally });
        }
        if (decidesAsAuthority) {
            if (!Number.isSafeInteger(nowSeconds)) throw refusal(422, 'source_time_missing', 'the decision needs the chain time it is made at', { tally });
            return {
                fields: { agreementCid: agreement.cid, sponsor, decision: 'satisfied',
                    evidenceRef: approvalApi().decisionEvidenceRef({ counted: count.counted, decidedBy: lensKey }), sourceObservedAt: nowSeconds },
                tally, counted: count.counted.length, asAuthority: true
            };
        }
        if (!count.lastDecidedAt) throw refusal(422, 'source_time_missing', 'no counted decision gives the outcome a source time', { tally });
        const sourceObservedAt = seconds(count.lastDecidedAt);
        if (sourceObservedAt > nowSeconds) {
            throw refusal(409, 'source_time_in_future', 'the last counted decision is signed later than this member\'s clock; ask again shortly', { tally });
        }
        return {
            fields: { agreementCid: agreement.cid, sponsor, decision: 'satisfied', evidenceRef: approvalApi().decisionEvidenceRef(count.counted), sourceObservedAt },
            tally,
            counted: count.counted.length,
            asAuthority: false
        };
    }

    /**
     * A member's own decision on a crowdfunding (investors) agreement, stated from its wallet at
     * `decidedAtSeconds` (the chain's clock when it decides). → { fields }
     */
    function ownDecision({ agreement, lensKey, decidedAtSeconds, nowSeconds = decidedAtSeconds }) {
        if (agreement.content?.rule?.electorate !== 'investors') {
            throw refusal(409, 'rule_counted', 'this agreement is decided by counted signed decisions; the member states satisfied only once they pass');
        }
        const sponsor = commonChecks({ agreement, lensKey, nowSeconds });
        if (!Number.isSafeInteger(decidedAtSeconds)) throw refusal(422, 'source_time_missing', 'the decision needs the chain time it is made at');
        return { fields: { agreementCid: agreement.cid, sponsor, decision: 'satisfied', evidenceRef: `decided-by:${lensKey}`, sourceObservedAt: decidedAtSeconds } };
    }

    return { countDecisions, countedDecision, ownDecision, refusal };
});
