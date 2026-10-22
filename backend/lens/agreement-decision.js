// Whether a lens member may issue AgreementDecision-v1 `satisfied` for an indexed agreement
// (plan-design-agreement.md M3, programs/agreement/README.md), decided from the agreement and its
// relayed owner decisions alone, never from the caller. The approval engine counts the decisions
// exactly as the relay admits them (agreements/decisions.js decisionSubject; approval-relay.js fold
// verifies every receipt; approval.js tally): `satisfied` once the rule passes, before the deadline.
// There is no refusal: an agreement whose rule is not met by its deadline expires on chain. Pure: no
// database, chain or clock.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { decisionSubject } from '../agreements/decisions.js';
import { isPublicKey } from '../agreements/onchain.js';
import { LensError } from './errors.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');

const seconds = instant => Math.floor(Date.parse(instant) / 1000);

/**
 * The decisions that count: the relayed receipts folded (each verified) into every party's current
 * approval, `counted` in signing order, the engine's tally over them, and when the last applied
 * decision (an approval or a withdrawal) was signed: the moment the counted state came to be.
 */
export function countAgreementDecisions(agreement, receipts) {
    const subject = decisionSubject(agreement);
    const folded = relay.fold(subject, receipts || []);
    const counted = folded.applied.filter(receipt => folded.ownerApprovals[receipt.ownerId] === receipt);
    const last = folded.applied.at(-1) ?? null;
    return { subject, counted, tally: approval.tally(subject, Object.keys(folded.ownerApprovals)), lastDecidedAt: last?.decidedAt ?? null };
}

/**
 * The attestation's evidenceRef: sha256 over approval.stableStringify of the counted receipts in
 * signing order. Anyone re-derives it from GET /agreements/:cid/decisions: fold the receipts, keep
 * each party's current approval in signing order, stringify, hash.
 */
export function decisionEvidenceRef(counted) {
    return `sha256:${createHash('sha256').update(approval.stableStringify(counted), 'utf8').digest('hex')}`;
}

/**
 * The AgreementDecision fields this member may issue now, or a LensError (with the tally) saying why not.
 * @param {{ agreement: object, count: ReturnType<typeof countAgreementDecisions>, lensKey: string,
 *   nowSeconds: number }} input
 *   agreement as GET /agreements/:cid serves it (status from the chain once minted), lensKey the member's key
 * @returns {{ fields: { agreementCid, sponsor, decision: 'satisfied', evidenceRef, sourceObservedAt }, tally: object, counted: number }}
 */
export function planAgreementDecision({ agreement, count, lensKey, nowSeconds }) {
    const content = agreement.content || {};
    const { tally } = count;
    const refusal = (status, code, message) => new LensError(status, code, message, { tally });

    const sponsor = content.sponsor;
    if (!isPublicKey(sponsor)) {
        throw refusal(422, 'no_sponsor', 'the agreement names no sponsor wallet, so no chain account can carry its decision');
    }
    if (!approval.lensKeys({ lens: content.rule?.lens }).includes(lensKey)) {
        throw refusal(409, 'not_in_lens', 'this lens member is not in the agreement\'s lens');
    }
    const onchain = agreement.onchain;
    if (onchain && onchain.lens !== lensKey) {
        throw refusal(409, 'not_agreement_lens', `the agreement's account names lens ${onchain.lens}; only its attestation settles it`);
    }
    if (agreement.status === 'executed' || agreement.status === 'cancelled') {
        throw refusal(409, 'agreement_closed', `the agreement is ${agreement.status}`);
    }
    if (onchain && onchain.decision !== 'pending') {
        throw refusal(409, 'decision_recorded', `the agreement's account already records the decision ${onchain.decision}`);
    }

    // The program records a decision only before the deadline (attest: DeadlinePassed), so one issued
    // later would spend rent on an attestation no account can take: the account can only expire.
    if (agreement.deadline && seconds(agreement.deadline) <= nowSeconds) {
        throw refusal(409, 'deadline_passed', `the deadline ${agreement.deadline} has passed; the account can only expire`);
    }
    if (!tally.passed) {
        throw refusal(409, 'rule_not_met', tally.ready ? 'the decision rule is not met' : `the decision rule cannot be counted: ${tally.reason}`);
    }
    if (!count.lastDecidedAt) throw refusal(422, 'source_time_missing', 'no counted decision gives the outcome a source time');
    const sourceObservedAt = seconds(count.lastDecidedAt);
    if (sourceObservedAt > nowSeconds) {
        throw refusal(409, 'source_time_in_future', 'the last counted decision is signed later than this member\'s clock; ask again shortly');
    }
    return {
        fields: { agreementCid: agreement.cid, sponsor, decision: 'satisfied', evidenceRef: decisionEvidenceRef(count.counted), sourceObservedAt },
        tally,
        counted: count.counted.length
    };
}
