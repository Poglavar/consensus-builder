// Speculator policy (speculator-01): pledge early behind the proposal the market likes most, and
// pull the pledge (revoke_pledge) when the market turns or the proposal goes stale. One action per
// run; a due revoke always comes before a new pledge. Pure: input = proposals, markets (keyed by
// proposal account), own pledges and the invocation budget; output = one action or none.
//
// Implied YES probability = yesPool / (yesPool + noPool) of the proposal's market; no market, an
// empty market or a resolved one is "no signal" (never pledged on). Age = now − the proposal's own
// createdAt.
//   revoke: an ACTIVE own pledge on a still-Active proposal whose probability < revokeBelowProbability,
//           or whose age > maxAgeDays. Lowest probability first, then oldest.
//   pledge: a minted Active proposal by another actor with no own pledge of any status (a revoked
//           pledge is never re-made, so the persona cannot flap), probability ≥ minPledgeProbability
//           and age ≤ pledgeWithinDays. Highest probability first, then the larger market, then the seed.
import {
    firstFitting, fraction, impliedYesProbability, isOthersActiveMinted, nonNegative, positiveDecimal,
    proposalAccount, proposalAgeDays, proposalKey, proposalName, stableNumber, totalPool
} from './common.js';

export const ROLE = 'speculator';
// What society-run.mjs must gather: the persona's pledge commitments (markets are always read).
export const NEEDS = { records: false, noPositions: false, pledges: true };

export function policyConfig(persona = {}) {
    const policy = persona.policy || {};
    const label = persona.name || 'speculator';
    const config = {
        amountUsdc: positiveDecimal(policy.amountUsdc, '0.05', `${label} policy.amountUsdc`),
        minPledgeProbability: fraction(policy.minPledgeProbability, 0.6, `${label} policy.minPledgeProbability`),
        revokeBelowProbability: fraction(policy.revokeBelowProbability, 0.5, `${label} policy.revokeBelowProbability`),
        pledgeWithinDays: nonNegative(policy.pledgeWithinDays, 3, `${label} policy.pledgeWithinDays`),
        maxAgeDays: nonNegative(policy.maxAgeDays, 7, `${label} policy.maxAgeDays`)
    };
    // A pledge threshold below the revoke threshold would pledge today and revoke tomorrow.
    if (config.minPledgeProbability < config.revokeBelowProbability) throw new Error(`${label}: minPledgeProbability must be ≥ revokeBelowProbability`);
    if (config.pledgeWithinDays > config.maxAgeDays) throw new Error(`${label}: pledgeWithinDays must be ≤ maxAgeDays`);
    return config;
}

const percent = value => `${(value * 100).toFixed(0)}%`;

/** Why an own active pledge on this proposal should be revoked now, or null. */
export function revokeReason({ probability, ageDays }, config) {
    if (probability !== null && probability < config.revokeBelowProbability) {
        return `implied YES probability fell to ${percent(probability)} (< ${percent(config.revokeBelowProbability)})`;
    }
    if (ageDays !== null && ageDays > config.maxAgeDays) {
        return `the proposal is ${ageDays.toFixed(1)} days old (> ${config.maxAgeDays})`;
    }
    return null;
}

/**
 * @param {{ persona, seed, now: number, wallet?, proposals, markets?, history?: { pledges?: Object<string, {status}> },
 *           budget?: { actionsLeft, usdcLeft } }} input
 */
export function decide({ persona, seed, now, wallet = null, proposals = [], markets = {}, history = {}, budget = null } = {}) {
    if (!persona?.name) throw new Error('persona.name is required');
    if (!seed) throw new Error('seed is required');
    if (typeof now !== 'number' || !Number.isFinite(now)) throw new Error('now (ms) is required');
    const config = policyConfig(persona);
    const pledges = history.pledges || {};
    const view = proposal => {
        const account = proposalAccount(proposal);
        return { proposal, account, probability: impliedYesProbability(markets?.[account]), ageDays: proposalAgeDays(proposal, now) };
    };
    const active = (proposals || []).filter(proposal => String(proposal?.lifecycleStatus || '').toLowerCase() === 'active' && proposalAccount(proposal));

    const revokes = active.filter(proposal => pledges[proposalKey(proposal)]?.status === 'active')
        .map(view)
        .map(item => ({ ...item, why: revokeReason(item, config) }))
        .filter(item => item.why)
        .sort((a, b) => (a.probability ?? 1) - (b.probability ?? 1) || (b.ageDays ?? 0) - (a.ageDays ?? 0) || proposalKey(a.proposal).localeCompare(proposalKey(b.proposal)))
        .map(item => ({
            proposalId: proposalKey(item.proposal), probability: item.probability, ageDays: item.ageDays,
            action: {
                type: 'revokePledge', amount: null, usdc: 0, signedActions: 1,
                proposalId: proposalKey(item.proposal), proposalAccount: item.account, proposalName: proposalName(item.proposal),
                rationale: `Revoke the pledge to ${proposalName(item.proposal)}: ${item.why}.`
            }
        }));

    const candidates = active.filter(proposal => isOthersActiveMinted(proposal, { wallet, personaName: persona.name }) && !pledges[proposalKey(proposal)])
        .map(view)
        .filter(item => item.probability !== null && item.probability >= config.minPledgeProbability
            && item.ageDays !== null && item.ageDays <= config.pledgeWithinDays)
        .map(item => ({ ...item, pool: totalPool(markets?.[item.account]), rank: stableNumber(`${seed}:${persona.name}:${proposalKey(item.proposal)}`) }))
        .sort((a, b) => b.probability - a.probability || b.pool - a.pool || a.rank - b.rank);
    const pledgeOptions = candidates.map((item, index) => ({
        proposalId: proposalKey(item.proposal), probability: item.probability, ageDays: item.ageDays,
        action: {
            type: 'pledge', amount: config.amountUsdc, usdc: Number(config.amountUsdc), signedActions: 1,
            proposalId: proposalKey(item.proposal), proposalAccount: item.account, proposalName: proposalName(item.proposal),
            rationale: `Pledge ${config.amountUsdc} USDC early to ${proposalName(item.proposal)}: the market implies ${percent(item.probability)} YES${index === 0 ? ', the highest' : ''} among ${candidates.length} proposal${candidates.length === 1 ? '' : 's'} ≤ ${config.pledgeWithinDays} days old at ≥ ${percent(config.minPledgeProbability)}.`
        }
    }));

    const options = [...revokes, ...pledgeOptions];
    const eligibleProposalIds = options.map(option => option.proposalId);
    if (!options.length) {
        const held = Object.values(pledges).filter(pledge => pledge?.status === 'active').length;
        return {
            action: null, options, eligibleProposalIds, capped: false,
            reason: `No pledge is due for revocation${held ? ` (${held} held)` : ''} and no proposal ≤ ${config.pledgeWithinDays} days old has a market at ≥ ${percent(config.minPledgeProbability)} YES without an existing pledge.`
        };
    }
    const { chosen, capped } = firstFitting(options, budget);
    return {
        action: chosen?.action || null, options, eligibleProposalIds, capped,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${options.length} option(s) but the invocation budget (${budget.actionsLeft} action(s), ${budget.usdcLeft.toFixed(2)} USDC left) covers none.`
    };
}
