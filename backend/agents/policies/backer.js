// Backer policy (backer-01), the contrarian's mirror: bet YES on the most modest active proposal by
// another actor that this persona has not already backed, preferring the underdog. Pure: input =
// proposals (optionally enriched with the full `record`), markets, own history and the invocation
// budget; output = one action or none.
//
// Ranking, strongest preference first:
//   1. evidence tier: a record-measured massing (lowest proposed gross floor area first, from the
//      contrarian's densityEvidence), then proposals with no density signal at all (parks, squares,
//      unmeasured summaries), then proposals only the text heuristic calls dense (lowest score first).
//   2. within a tier, the underdog: a market with fewer YES than NO atomic units goes first.
//   3. the smaller floor area / score, then a `seed`-stable hash.
import {
    atomic, firstFitting, isOthersActiveMinted, positiveDecimal, proposalAccount, proposalKey, proposalName, stableNumber
} from './common.js';
import { densityEvidence } from './contrarian.js';

export const ROLE = 'backer';
// What society-run.mjs must gather: full records for density, and the persona's own YES positions.
export const NEEDS = { records: true, noPositions: false, yesPositions: true, pledges: false };

const TIER_LABEL = ['measured massing', 'no density signal', 'text calls it dense'];

export function policyConfig(persona = {}) {
    const policy = persona.policy || {};
    return { amountUsdc: positiveDecimal(policy.amountUsdc, '0.02', `${persona.name || 'backer'} policy.amountUsdc`) };
}

const usdc = value => (Number(value) / 1e6).toFixed(2);

/** { yes, no } atomic pools when the market's YES pool is strictly smaller than its NO pool, else null. */
export function underdogPools(market) {
    if (!market || market.resolved) return null;
    const yes = atomic(market.yesPool);
    const no = atomic(market.noPool);
    if (yes === null || no === null || yes >= no) return null;
    return { yes, no };
}

function tierOf(evidence) {
    if (evidence.source === 'record') return 0;
    if (evidence.source === 'none') return 1;
    return 2;
}

/**
 * @param {{ persona, seed, wallet?, proposals, markets?, history?: { forProposalIds?: string[] },
 *           budget?: { actionsLeft, usdcLeft } }} input
 */
export function decide({ persona, seed, wallet = null, proposals = [], markets = {}, history = {}, budget = null } = {}) {
    if (!persona?.name) throw new Error('persona.name is required');
    if (!seed) throw new Error('seed is required');
    const config = policyConfig(persona);
    const backed = new Set((history.forProposalIds || []).map(String));
    const others = (proposals || []).filter(proposal => isOthersActiveMinted(proposal, { wallet, personaName: persona.name }));
    const alreadyBacked = others.filter(proposal => backed.has(proposalKey(proposal))).map(proposalKey);
    const open = others.filter(proposal => !backed.has(proposalKey(proposal)) && !markets?.[proposalAccount(proposal)]?.resolved);
    const scored = open.map(proposal => {
        const evidence = densityEvidence(proposal);
        return {
            proposal, evidence, tier: tierOf(evidence),
            underdog: underdogPools(markets?.[proposalAccount(proposal)]),
            rank: stableNumber(`${seed}:${persona.name}:${proposalKey(proposal)}`)
        };
    }).sort((a, b) => a.tier - b.tier || Number(Boolean(b.underdog)) - Number(Boolean(a.underdog))
        || a.evidence.score - b.evidence.score || a.rank - b.rank);
    const options = scored.map(({ proposal, evidence, tier, underdog }, index) => {
        const account = proposalAccount(proposal);
        const hasMarket = Boolean(markets?.[account]);
        const why = [
            tier === 1 ? 'no density signal in the record or its text' : evidence.detail,
            underdog ? `backs the underdog (YES ${usdc(underdog.yes)} < NO ${usdc(underdog.no)} USDC)` : null
        ].filter(Boolean).join('; ');
        return {
            proposalId: proposalKey(proposal),
            evidence: { ...evidence, tier: TIER_LABEL[tier], underdog: Boolean(underdog) },
            action: {
                type: 'stake', side: 'yes', amount: config.amountUsdc, usdc: Number(config.amountUsdc),
                // Creating a missing market is a second signature.
                signedActions: hasMarket ? 1 : 2,
                proposalId: proposalKey(proposal), proposalAccount: account, proposalName: proposalName(proposal),
                rationale: `Bet YES on ${proposalName(proposal)}: ${why}; ranked ${index + 1} of ${scored.length} active proposal${scored.length === 1 ? '' : 's'} by other actors this persona has not yet backed (modest massing first, the underdog first within it)${alreadyBacked.length ? `; ${alreadyBacked.length} already backed` : ''}.`
            }
        };
    });
    const eligibleProposalIds = options.map(option => option.proposalId);
    if (!options.length) {
        return {
            action: null, options, eligibleProposalIds, capped: false, alreadyBacked,
            reason: alreadyBacked.length && !open.length
                ? `Every active proposal by another actor is already backed (${alreadyBacked.length}).`
                : others.length ? 'Every active proposal by another actor has a resolved market.' : 'No active minted proposal by another actor was available.'
        };
    }
    const { chosen, capped } = firstFitting(options, budget);
    return {
        action: chosen?.action || null, options, eligibleProposalIds, capped, alreadyBacked,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${options.length} proposal(s) to back but the invocation budget (${budget.actionsLeft} action(s), ${budget.usdcLeft.toFixed(2)} USDC left) covers none.`
    };
}
