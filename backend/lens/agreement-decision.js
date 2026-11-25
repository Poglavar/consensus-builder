// Whether a lens member may issue AgreementDecision-v1 `satisfied` for an indexed agreement
// (plan-design-agreement.md M3, programs/agreement/README.md), decided from the agreement and its
// relayed owner decisions, never from the caller. The approval engine counts owner decisions
// exactly as the relay admits them (agreements/decisions.js decisionSubject; approval-relay.js fold
// verifies every receipt; approval.js tally): `satisfied` once the rule passes, before the deadline.
// There is no refusal: an agreement whose rule is not met by its deadline expires on chain. Pure: no
// database or wall clock. A crowdfunding agreement gets no automatic decision: the program checks its
// contribution target itself (confirm_funding); its finalized funding accounts are read here only to
// qualify apartment buyers (apartment-reservation-qualification.js).

import { createRequire } from 'node:module';
import { decisionSubject } from '../agreements/decisions.js';
import { isPublicKey } from '../agreements/onchain.js';
import { LensError } from './errors.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');
const pledgeClient = require('../../frontend/js/solana/pledge-client.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const cidApi = require('../../frontend/js/cid.js');

const seconds = instant => Math.floor(Date.parse(instant) / 1000);

/**
 * The decisions that count: the relayed receipts folded (each verified) into every party's current
 * approval, `counted` in signing order, the engine's tally over them, and when the last applied
 * decision (an approval or a withdrawal) was signed: the moment the counted state came to be.
 */
export function countAgreementDecisions(agreement, receipts) {
    const subject = decisionSubject(agreement);
    const folded = relay.fold(subject, receipts || []);
    const counted = relay.countedApprovals(folded);
    const last = folded.applied.at(-1) ?? null;
    return { subject, counted, tally: approval.tally(subject, Object.keys(folded.ownerApprovals)), lastDecidedAt: last?.decidedAt ?? null };
}

/**
 * The attestation's evidenceRef: sha256 over approval.stableStringify of the counted receipts in
 * signing order. Anyone re-derives it from GET /agreements/:cid/decisions: fold the receipts, keep
 * each party's current approval in signing order, stringify, hash.
 */
export const decisionEvidenceRef = approval.decisionEvidenceRef;

// Investor-funded agreements use the same Agreement program and proposal_pledge donation escrow as
// ordinary support donations.  This is deliberately separate from owner tallying: a soft pledge,
// an owner ballot, a market position, or a naked transfer to the vault is not crowdfunding. The
// observation checks that this member is one of the agreement's lens members and that the account
// carries the published contribution target; the target itself is the program's to confirm.
const refusal = (status, code, message, details = {}) => { throw new LensError(status, code, message, details); };
export async function observeInvestorFunding({ agreement, lensKey, nowSeconds, chain }) {
    const content = agreement.content || {};
    const rule = content.rule || {};
    const funding = content.funding;
    if (content.schema !== agreementRecord.PUBLISHED_SCHEMA || !cidApi.isCid(agreement.cid) || cidApi.cidOfObject(content) !== agreement.cid)
        refusal(422, 'invalid_funding_content', 'the indexed agreement content does not match its CID');
    const fundingIssue = agreementRecord.crowdfundingError(content, { requireSponsor: true });
    if (fundingIssue) refusal(422, 'invalid_funding_content', fundingIssue);
    if (rule.electorate !== 'investors' || rule.binding !== true || !Array.isArray(rule.lens) || !rule.lens.includes(lensKey))
        refusal(422, 'invalid_funding_rule', 'investor funding requires a binding investors rule whose lens includes this member');
    if (!chain?.observe)
        refusal(503, 'funding_chain_not_configured', 'investor funding requires trusted devnet chain readers');
    if (agreement.status === 'executed' || agreement.status === 'cancelled') refusal(409, 'agreement_closed', `the agreement is ${agreement.status}`);
    // Agreement::deadline_passed is strictly later than its deadline, so execution is allowed in
    // the deadline second itself.  The lens uses that same boundary.
    if (seconds(content.deadline) < nowSeconds) refusal(409, 'deadline_passed', 'the funding deadline has passed');
    const onchain = agreement.onchain;
    if (!onchain || onchain.chain !== 'solana' || onchain.cluster !== 'devnet' || !isPublicKey(onchain.account) || onchain.sponsor !== content.sponsor)
        refusal(422, 'invalid_agreement_account', 'the agreement does not name its canonical devnet account and sponsor');
    if (!onchain.lenses.includes(lensKey)) refusal(409, 'not_agreement_lens', 'the agreement account does not name this lens member');
    if (onchain.decision && onchain.decision !== 'pending') refusal(409, 'decision_recorded', `the agreement account already records ${onchain.decision}`);
    let observed;
    try {
        observed = await chain.observe({ cid: agreement.cid, sponsor: content.sponsor, account: onchain.account,
            ...(funding.apartments ? { funding } : {}) });
    } catch (error) {
        refusal(422, 'funding_chain_invalid', error.message || 'the finalized funding accounts cannot be verified');
    }
    const account = observed.agreement;
    const deadline = seconds(content.deadline);
    if (!account || account.address !== onchain.account || account.cid !== agreement.cid || account.authority !== content.sponsor
        || account.payout !== content.sponsor || account.deadline !== deadline || account.openGround !== false
        || !account.lenses.includes(lensKey) || account.status !== 'Active' || account.decision !== 'Pending' || account.requiredLamports !== 0n
        || account.fundingMint !== pledgeClient.constants.USDC_DEVNET_MINT || account.requiredFunding !== BigInt(funding.targetUsdcAtomic))
        refusal(422, 'invalid_agreement_account', 'the chain account is not the active canonical agreement');
    const escrow = observed.donation;
    if (!escrow || escrow.proposal !== onchain.account || escrow.beneficiary !== content.sponsor
        || escrow.mint !== pledgeClient.constants.USDC_DEVNET_MINT || escrow.vault !== observed.vault
        || escrow.released || escrow.totalReleased !== 0n) {
        refusal(422, 'invalid_donation_vault', 'the canonical devnet USDC donation vault is missing or closed');
    }
    const netDeposits = escrow.totalDonated - escrow.totalRefunded;
    if (netDeposits < 0n || observed.vaultUsdcAtomic < netDeposits) {
        refusal(422, 'invalid_donation_vault', 'the canonical devnet USDC donation vault does not hold its recorded active contributions');
    }
    if (!Number.isSafeInteger(observed.slot) || !Number.isSafeInteger(observed.blockTime)) refusal(422, 'chain_observation_missing', 'funding evidence requires a finalized slot and block time');
    if (observed.blockTime > nowSeconds || (agreement.deadline && observed.blockTime > seconds(agreement.deadline)) || (account.deadline && observed.blockTime > account.deadline))
        refusal(409, 'funding_observation_after_deadline', 'the finalized funding observation is not before the agreement deadline');
    return { observed, account, escrow, onchain, netDeposits, funding, content };
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
    // The program confirms a crowdfunding target itself (confirm_funding, permissionless), and the rule
    // names no other condition this member could count, so it issues no automatic decision here.
    if (content.rule?.electorate === 'investors') {
        throw new LensError(409, 'funding_checked_on_chain', 'the program checks this agreement\'s funding target: anyone confirms it on chain with confirm_funding once contributions reach it; this lens issues no automatic decision for a crowdfunding agreement');
    }
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
    if (onchain && !onchain.lenses.includes(lensKey)) {
        throw refusal(409, 'not_agreement_lens', `the agreement's account names lens members ${onchain.lenses.join(', ') || '(none)'}; only their attestations settle it`);
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
