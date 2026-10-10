// Collecting winnings, shared by every society role: before the role's own policy runs, a turn claims
// one market position the persona is owed money from (the winning side, or any side when nobody backed
// the winner, which refunds everyone). Pure: input = proposals, markets and own positions keyed by
// proposal account, the on-chain status of proposals whose market is still open, and the history.
//
// Owed = the rule the Bets sheet uses (frontend/js/bets/bets-model.js claimSides) on the market's real
// outcome, or, for an unresolved market whose proposal is already terminal on-chain, on the outcome
// `resolve` will set (Executed → YES, Cancelled/Expired → NO); such a claim resolves first, which
// anyone may do, and costs a second signature. Already-resolved claims go first, then the largest payout.
import { createRequire } from 'node:module';
import { firstFitting, proposalAccount, proposalKey, proposalName } from './common.js';
import { positionKey } from './history.js';

const require = createRequire(import.meta.url);
const { claimSides } = require('../../../frontend/js/bets/bets-model.js');
// Only the pure payoutAmount / formatAtomic / constants are used, so no web3 has to be injected.
const marketClient = require('../../../frontend/js/solana/market-client.js');

const { SIDE_YES, SIDE_NO } = marketClient.constants;
const SIDE_NUMBER = { yes: SIDE_YES, no: SIDE_NO };
// The outcome `resolve` sets for each terminal on-chain proposal status (proposal_market::resolve).
const TERMINAL_OUTCOME = { executed: 'yes', cancelled: 'no', expired: 'no' };

/**
 * The outcome a market pays on, and whether it still has to be resolved first; null when the market
 * is missing or open on a proposal that is not terminal on-chain (nothing is owed yet).
 */
export function settlement(market, proposalStatus) {
    if (!market) return null;
    if (market.resolved) return { outcome: market.outcome === SIDE_YES ? 'yes' : 'no', resolveFirst: false };
    const outcome = TERMINAL_OUTCOME[String(proposalStatus || '').toLowerCase()];
    return outcome ? { outcome, resolveFirst: true } : null;
}

/**
 * @param {{ proposals, markets?: Object<string, object>, positions?: Object<string, { yes?, no? }>,
 *           proposalStatuses?: Object<string, string>, history?: { claimedPositions?: string[] },
 *           budget?: { actionsLeft, usdcLeft } }} input
 * @returns {{ action, options, capped, reason }}
 */
export function decideCollect({ proposals = [], markets = {}, positions = {}, proposalStatuses = {}, history = {}, budget = null } = {}) {
    const claimed = new Set(history.claimedPositions || []);
    const seen = new Set();
    const owed = [];
    for (const proposal of proposals || []) {
        const account = proposalAccount(proposal);
        if (!account || seen.has(account)) continue;
        seen.add(account);
        const market = markets?.[account];
        const held = positions?.[account];
        const settled = held && settlement(market, proposalStatuses?.[account]);
        if (!settled) continue;
        const row = { outcome: settled.outcome, yesPoolAtomic: market.yesPool, noPoolAtomic: market.noPool };
        for (const side of claimSides(row, held)) {
            if (claimed.has(positionKey(proposalKey(proposal), side))) continue;
            const payout = marketClient.payoutAmount(SIDE_NUMBER[side], held[side].amount, market.yesPool, market.noPool, SIDE_NUMBER[settled.outcome]);
            owed.push({ proposal, account, side, payout, refund: side !== settled.outcome, ...settled });
        }
    }
    owed.sort((a, b) => Number(a.resolveFirst) - Number(b.resolveFirst)
        || (b.payout > a.payout ? 1 : b.payout < a.payout ? -1 : 0)
        || proposalKey(a.proposal).localeCompare(proposalKey(b.proposal)) || a.side.localeCompare(b.side));
    const options = owed.map(item => {
        const payout = marketClient.formatAtomic(item.payout, 6);
        const name = proposalName(item.proposal);
        return {
            proposalId: proposalKey(item.proposal),
            action: {
                type: 'claim', side: item.side, outcome: item.outcome, resolveFirst: item.resolveFirst,
                // Claims move USDC to the persona, so they spend nothing against the USDC cap.
                amount: null, usdc: 0, payout, signedActions: item.resolveFirst ? 2 : 1,
                proposalId: proposalKey(item.proposal), proposalAccount: item.account, proposalName: name,
                rationale: `Collect ${payout} USDC from the ${item.side.toUpperCase()} position on ${name}: `
                    + (item.refund ? `the market ${item.resolveFirst ? 'will resolve' : 'resolved'} ${item.outcome.toUpperCase()} and nobody backed that side, so every stake is refunded`
                        : `the market ${item.resolveFirst ? 'will resolve' : 'resolved'} ${item.outcome.toUpperCase()}, the side this persona backed`)
                    + (item.resolveFirst ? ' (the proposal is terminal on-chain; resolve the market first).' : '.')
            }
        };
    });
    if (!options.length) return { action: null, options, capped: false, reason: 'No settled market owes this persona anything.' };
    const { chosen, capped } = firstFitting(options, budget);
    return {
        action: chosen?.action || null, options, capped,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${options.length} claim(s) owed but the invocation budget (${budget.actionsLeft} action(s) left) covers none.`
    };
}

/**
 * One society turn: a claim the persona is owed comes before anything its role would do; otherwise the
 * role's own decision. `step` says which ran. A turn whose role found nothing while a claim did not fit
 * the caps reports `capped`, so the runner stops instead of calling it "nothing to do".
 */
export function decideTurn(roleDecide, input) {
    const collect = decideCollect(input);
    if (collect.action) return { ...collect, step: 'collect', eligibleProposalIds: collect.options.map(option => option.proposalId) };
    const decision = roleDecide(input);
    return { ...decision, step: 'role', capped: Boolean(decision.capped || (!decision.action && collect.capped)), owedClaims: collect.options.length };
}
