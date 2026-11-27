// Homebuyer policy (homebuyer-01…): a household agent in a developer's crowdfunding rounds. Pure:
// input = `homes` (homebuyer-chain.js gatherHomes: open rounds with their apartment inventory, its own
// deposits in rounds that ended unexecuted), the persona, seed, wallet and invocation budget; output =
// one action or none. society-run.mjs gathers and signs.
//
// Obligations first: take back a deposit from a round that expired or was cancelled. Then one choice,
// by a seed-stable draw among what is possible: reserve an available apartment (its lens qualifies it
// first), or contribute to a plain contribution round.
import { agreementName, firstFitting, positiveDecimal, stableNumber } from './common.js';

export const ROLE = 'homebuyer';
export const NEEDS = { records: false, noPositions: false, yesPositions: false, pledges: false, homes: true };

const usdc = atomic => Number(atomic) / 1e6;
const HOUR_MS = 3_600_000;

export function policyConfig(persona = {}) {
    const policy = persona.policy || {};
    return {
        maxReservations: Math.max(0, Number(policy.maxReservations ?? 2)),
        maxDepositUsdc: Number(positiveDecimal(policy.maxDepositUsdc, '4', `${persona.name} policy.maxDepositUsdc`)),
        donationUsdc: positiveDecimal(policy.donationUsdc, '0.5', `${persona.name} policy.donationUsdc`),
        // Relative weights of the free choices (0 turns one off).
        weights: { reserve: 4, donate: 2, ...(policy.weights || {}) }
    };
}

/**
 * @param {{ persona, seed, now?, wallet, homes: { rounds, refunds }, budget? }} input
 */
export function decide({ persona, seed, now = Date.now(), wallet = null, homes = null, budget = null } = {}) {
    if (!persona?.name) throw new Error('persona.name is required');
    if (!seed) throw new Error('seed is required');
    const config = policyConfig(persona);
    if (!homes || !wallet) return { action: null, options: [], capped: false, reason: 'No rounds were read.' };
    const rounds = homes.rounds || [];
    const mine = rounds.flatMap(round => round.units.filter(unit => unit.status === 'reserved' && unit.buyer === wallet).map(unit => ({ round, unit })));

    const obligations = [];
    for (const refund of homes.refunds || []) {
        obligations.push({ agreementCid: refund.cid, action: { type: 'refundMyDonations', agreementCid: refund.cid, account: refund.account, agreementName: refund.title,
            amount: String(usdc(refund.amount)), usdc: 0, signedActions: 1,
            rationale: `Take back the ${usdc(refund.amount)} USDC deposit from ${refund.title}: the round ${refund.chainStatus} without executing.` } });
    }
    if (obligations.length) {
        obligations.sort((a, b) => stableNumber(`${seed}:${persona.name}:${a.agreementCid}`) - stableNumber(`${seed}:${persona.name}:${b.agreementCid}`));
        const { chosen, capped } = firstFitting(obligations, budget);
        if (chosen) return { action: chosen.action, options: obligations, capped: false, reason: chosen.action.rationale };
        if (capped) return { action: null, options: obligations, capped: true, reason: 'Cap reached before an outstanding step.' };
    }

    const choices = [];
    const openRounds = rounds.filter(round => round.chainStatus === 'active' && Date.parse(round.deadline) > now + HOUR_MS && round.sponsor !== wallet);
    if (config.weights.reserve > 0 && mine.filter(({ round }) => round.chainStatus === 'active').length < config.maxReservations) {
        for (const round of openRounds) {
            if (round.units.some(unit => unit.buyer === wallet)) continue;
            for (const unit of round.units.filter(item => item.status === 'available' && usdc(item.depositUsdcAtomic) <= config.maxDepositUsdc)) {
                choices.push({ kind: 'reserve', agreementCid: round.cid, action: { type: 'reserve-apartment', agreementCid: round.cid, account: round.account, agreementName: round.title,
                    unitId: unit.unitId, label: unit.label, amount: String(usdc(unit.depositUsdcAtomic)), usdc: usdc(unit.depositUsdcAtomic), signedActions: 1,
                    rationale: `Reserve ${unit.label} in ${round.title}: deposit ${usdc(unit.depositUsdcAtomic)} USDC of its ${usdc(unit.priceUsdcAtomic)} USDC price.` } });
            }
        }
    }
    if (config.weights.donate > 0) {
        for (const round of openRounds.filter(item => item.plain && !item.donatedByMe)) {
            choices.push({ kind: 'donate', agreementCid: round.cid, action: { type: 'donate', agreementCid: round.cid, account: round.account, agreementName: round.title,
                amount: config.donationUsdc, usdc: Number(config.donationUsdc), signedActions: 1,
                rationale: `Contribute ${config.donationUsdc} USDC to ${round.title} (target ${usdc(round.targetUsdcAtomic)} USDC).` } });
        }
    }
    if (!choices.length) return { action: null, options: [], capped: false, reason: 'No apartment to reserve or round to contribute to.' };
    // One kind by weight among the kinds that have options, then one option of it, both seed-stable.
    const kinds = [...new Set(choices.map(choice => choice.kind))];
    const total = kinds.reduce((sum, kind) => sum + config.weights[kind], 0);
    let draw = stableNumber(`${seed}:${persona.name}:kind`) % total;
    const kind = kinds.find(item => (draw -= config.weights[item]) < 0) || kinds[0];
    const ofKind = choices.filter(choice => choice.kind === kind)
        .sort((a, b) => stableNumber(`${seed}:${persona.name}:${a.agreementCid}:${a.action.unitId || ''}`)
            - stableNumber(`${seed}:${persona.name}:${b.agreementCid}:${b.action.unitId || ''}`));
    const ordered = [...ofKind, ...choices.filter(choice => choice.kind !== kind)];
    const { chosen, capped } = firstFitting(ordered, budget);
    return {
        action: chosen?.action || null, options: ordered, capped,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${ordered.length} option(s), none within the invocation budget.`
    };
}

export { agreementName };
