// Backer policy (backer-01), the contrarian's mirror: bet YES on the most modest open agreement by
// another actor that this persona has not already backed, preferring the underdog. Pure: input =
// agreements (optionally enriched with their designs' content, `designContents`), markets keyed by
// agreement account, own history and the invocation budget; output = one action or none.
//
// Ranking, strongest preference first:
//   1. evidence tier: a design-measured massing (lowest proposed gross floor area first, from the
//      contrarian's densityEvidence), then agreements with no density signal at all (parks, squares,
//      unmeasured designs), then agreements only the text heuristic calls dense (lowest score first).
//   2. within a tier, the underdog: a market with fewer YES than NO atomic units goes first.
//   3. the smaller floor area / score, then a `seed`-stable hash.
import { agreementName, atomic, firstFitting, isOthersOpen, positiveDecimal, stableNumber } from './common.js';
import { densityEvidence } from './contrarian.js';

export const ROLE = 'backer';
// What society-run.mjs must gather: the designs' content for density, and the persona's own YES positions.
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
    if (evidence.source === 'designs') return 0;
    if (evidence.source === 'none') return 1;
    return 2;
}

/**
 * @param {{ persona, seed, now?, wallet?, agreements, markets?, history?: { forCids?: string[] },
 *           budget?: { actionsLeft, usdcLeft } }} input
 */
export function decide({ persona, seed, now = Date.now(), wallet = null, agreements = [], markets = {}, history = {}, budget = null } = {}) {
    if (!persona?.name) throw new Error('persona.name is required');
    if (!seed) throw new Error('seed is required');
    const config = policyConfig(persona);
    const backed = new Set((history.forCids || []).map(String));
    const others = (agreements || []).filter(agreement => isOthersOpen(agreement, { wallet, personaName: persona.name, now }));
    const alreadyBacked = others.filter(agreement => backed.has(agreement.cid)).map(agreement => agreement.cid);
    const open = others.filter(agreement => !backed.has(agreement.cid) && !markets?.[agreement.account]?.resolved);
    const scored = open.map(agreement => {
        const evidence = densityEvidence(agreement);
        return {
            agreement, evidence, tier: tierOf(evidence),
            underdog: underdogPools(markets?.[agreement.account]),
            rank: stableNumber(`${seed}:${persona.name}:${agreement.cid}`)
        };
    }).sort((a, b) => a.tier - b.tier || Number(Boolean(b.underdog)) - Number(Boolean(a.underdog))
        || a.evidence.score - b.evidence.score || a.rank - b.rank);
    const options = scored.map(({ agreement, evidence, tier, underdog }, index) => {
        const hasMarket = Boolean(markets?.[agreement.account]);
        const why = [
            tier === 1 ? 'no density signal in its designs or their text' : evidence.detail,
            underdog ? `backs the underdog (YES ${usdc(underdog.yes)} < NO ${usdc(underdog.no)} USDC)` : null
        ].filter(Boolean).join('; ');
        return {
            agreementCid: agreement.cid,
            evidence: { ...evidence, tier: TIER_LABEL[tier], underdog: Boolean(underdog) },
            action: {
                type: 'stake', side: 'yes', amount: config.amountUsdc, usdc: Number(config.amountUsdc),
                // Creating a missing market is a second signature.
                signedActions: hasMarket ? 1 : 2,
                agreementCid: agreement.cid, account: agreement.account, agreementName: agreementName(agreement),
                rationale: `Bet YES on ${agreementName(agreement)}: ${why}; ranked ${index + 1} of ${scored.length} open agreement${scored.length === 1 ? '' : 's'} by other actors this persona has not yet backed (modest massing first, the underdog first within it)${alreadyBacked.length ? `; ${alreadyBacked.length} already backed` : ''}.`
            }
        };
    });
    const eligibleCids = options.map(option => option.agreementCid);
    if (!options.length) {
        return {
            action: null, options, eligibleCids, capped: false, alreadyBacked,
            reason: alreadyBacked.length && !open.length
                ? `Every open agreement by another actor is already backed (${alreadyBacked.length}).`
                : others.length ? 'Every open agreement by another actor has a resolved market.' : 'No open minted agreement by another actor was available.'
        };
    }
    const { chosen, capped } = firstFitting(options, budget);
    return {
        action: chosen?.action || null, options, eligibleCids, capped, alreadyBacked,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${options.length} agreement(s) to back but the invocation budget (${budget.actionsLeft} action(s), ${budget.usdcLeft.toFixed(2)} USDC left) covers none.`
    };
}
