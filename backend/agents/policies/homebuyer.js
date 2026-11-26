// Homebuyer policy (homebuyer-01…): a household agent in a developer's crowdfunding rounds and the
// standalone apartment-offer market of its cities. Pure: input = `homes` (homebuyer-chain.js
// gatherHomes: open rounds with their apartment inventory, its own deposits in rounds that ended
// unexecuted, apartment offers with their chain state), the persona, seed, wallet and invocation
// budget; output = one action or none. society-run.mjs gathers and signs.
//
// Obligations first, in this order: take back a deposit from a round that expired or was cancelled;
// fund and settle an accepted offer it is the buyer of; accept another agent's open offer it can
// take (buy a listed apartment it does not hold, or sell an apartment it holds to a bid). Then one
// choice, by a seed-stable draw among what is possible: reserve an available apartment (its lens
// qualifies it first), list an apartment it holds for resale, bid on an apartment another agent
// holds, or contribute to a plain contribution round.
import { agreementName, firstFitting, positiveDecimal, stableNumber } from './common.js';

export const ROLE = 'homebuyer';
export const NEEDS = { records: false, noPositions: false, yesPositions: false, pledges: false, homes: true };

const usdc = atomic => Number(atomic) / 1e6;
const HOUR_MS = 3_600_000;

export function policyConfig(persona = {}) {
    const policy = persona.policy || {};
    const lamports = (value, fallback, label) => {
        const text = String(value ?? fallback);
        if (!/^\d+(\.\d{1,9})?$/.test(text) || Number(text) <= 0) throw new Error(`${persona.name} policy.${label} must be a positive SOL decimal`);
        return BigInt(Math.round(Number(text) * 1e9));
    };
    return {
        maxReservations: Math.max(0, Number(policy.maxReservations ?? 2)),
        maxDepositUsdc: Number(positiveDecimal(policy.maxDepositUsdc, '4', `${persona.name} policy.maxDepositUsdc`)),
        donationUsdc: positiveDecimal(policy.donationUsdc, '0.5', `${persona.name} policy.donationUsdc`),
        offerMinLamports: lamports(policy.offerMinSol, '0.01', 'offerMinSol'),
        offerMaxLamports: lamports(policy.offerMaxSol, '0.03', 'offerMaxSol'),
        offerDays: Math.max(1, Number(policy.offerDays ?? 3)),
        offerLens: policy.offerLens ? String(policy.offerLens) : null,
        // Relative weights of the free choices (0 turns one off).
        weights: { reserve: 4, offerSell: 2, offerBuy: 2, donate: 2, ...(policy.weights || {}) }
    };
}

// A price in whole lamports between the configured bounds, stable for one seed, on 0.001 SOL steps.
export function offerPrice(seed, { offerMinLamports, offerMaxLamports }) {
    const steps = Number((offerMaxLamports - offerMinLamports) / 1_000_000n);
    return offerMinLamports + BigInt(steps > 0 ? stableNumber(seed) % (steps + 1) : 0) * 1_000_000n;
}

const apartmentRef = unit => ({ xrayBuilding: unit.xrayBuilding, unit: unit.unit, at: unit.at });
const sameApartment = (a, b) => a.xrayBuilding === b.xrayBuilding && a.unit === b.unit;

/**
 * @param {{ persona, seed, now?, wallet, homes: { rounds, refunds, offers }, budget? }} input
 */
export function decide({ persona, seed, now = Date.now(), wallet = null, homes = null, budget = null } = {}) {
    if (!persona?.name) throw new Error('persona.name is required');
    if (!seed) throw new Error('seed is required');
    const config = policyConfig(persona);
    if (!homes || !wallet) return { action: null, options: [], capped: false, reason: 'No rounds or offers were read.' };
    const rounds = homes.rounds || [];
    const offers = homes.offers || [];
    const nowSeconds = Math.floor(now / 1000);
    const mine = rounds.flatMap(round => round.units.filter(unit => unit.status === 'reserved' && unit.buyer === wallet).map(unit => ({ round, unit })));
    const liveOffer = offer => offer.chain && Date.parse(offer.content.expiresAt) > now + HOUR_MS;

    const obligations = [];
    for (const refund of homes.refunds || []) {
        obligations.push({ agreementCid: refund.cid, action: { type: 'refundMyDonations', agreementCid: refund.cid, account: refund.account, agreementName: refund.title,
            amount: String(usdc(refund.amount)), usdc: 0, signedActions: 1,
            rationale: `Take back the ${usdc(refund.amount)} USDC deposit from ${refund.title}: the round ${refund.chainStatus} without executing.` } });
    }
    for (const offer of offers) {
        const chain = offer.chain;
        if (chain?.status !== 'Accepted' || chain.buyer !== wallet || Number(chain.deadline) <= nowSeconds) continue;
        obligations.push({ agreementCid: offer.cid, action: { type: 'settle-offer', offerCid: offer.cid, agreementCid: offer.cid, agreementName: offer.content.title || offer.cid,
            funded: BigInt(chain.escrowLamports) >= BigInt(chain.priceLamports), usdc: 0, signedActions: 2,
            rationale: `Pay ${Number(chain.priceLamports) / 1e9} SOL into the accepted offer for ${offer.content.title || 'the apartment'} and release it to the seller.` } });
    }
    for (const offer of offers) {
        if (offer.chain?.status !== 'Open' || offer.content.proposer === wallet || !liveOffer(offer)) continue;
        const held = mine.some(({ unit }) => sameApartment(unit, offer.content.apartment));
        if (offer.content.direction === 'sell' && !held) {
            obligations.push({ agreementCid: offer.cid, action: { type: 'accept-offer', offerCid: offer.cid, agreementCid: offer.cid, agreementName: offer.content.title || offer.cid,
                role: 'buyer', usdc: 0, signedActions: 1, rationale: `Buy ${offer.content.title || 'the listed apartment'} at ${Number(offer.content.priceLamports) / 1e9} SOL; the offer's lens qualifies this wallet first.` } });
        } else if (offer.content.direction === 'buy' && held) {
            obligations.push({ agreementCid: offer.cid, action: { type: 'accept-offer', offerCid: offer.cid, agreementCid: offer.cid, agreementName: offer.content.title || offer.cid,
                role: 'seller', usdc: 0, signedActions: 1, rationale: `Sell the reservation of ${offer.content.title || 'the apartment'} to the bid of ${Number(offer.content.priceLamports) / 1e9} SOL.` } });
        }
    }
    if (obligations.length) {
        obligations.sort((a, b) => stableNumber(`${seed}:${persona.name}:${a.agreementCid}`) - stableNumber(`${seed}:${persona.name}:${b.agreementCid}`));
        const order = ['refundMyDonations', 'settle-offer', 'accept-offer'];
        obligations.sort((a, b) => order.indexOf(a.action.type) - order.indexOf(b.action.type));
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
    if (config.weights.offerSell > 0 && config.offerLens) {
        for (const { round, unit } of mine) {
            if (offers.some(offer => offer.content.proposer === wallet && offer.content.direction === 'sell' && liveOffer(offer) && offer.chain.status === 'Open' && sameApartment(offer.content.apartment, unit))) continue;
            const price = offerPrice(`${seed}:${persona.name}:${unit.unit}:sell`, config);
            choices.push({ kind: 'offerSell', agreementCid: round.cid, action: { type: 'make-offer', direction: 'sell', agreementCid: round.cid, agreementName: round.title,
                apartment: apartmentRef(unit), city: round.city, title: `${unit.label} · ${round.planTitle || round.title}`, priceLamports: String(price), days: config.offerDays,
                lens: config.offerLens, usdc: 0, signedActions: 1,
                rationale: `List ${unit.label} (reserved in ${round.title}) for resale at ${Number(price) / 1e9} SOL.` } });
        }
    }
    if (config.weights.offerBuy > 0 && config.offerLens) {
        for (const round of rounds) {
            for (const unit of round.units.filter(item => item.status === 'reserved' && item.buyer && item.buyer !== wallet)) {
                if (offers.some(offer => offer.content.proposer === wallet && offer.content.direction === 'buy' && liveOffer(offer) && offer.chain.status === 'Open' && sameApartment(offer.content.apartment, unit))) continue;
                const price = offerPrice(`${seed}:${persona.name}:${unit.unit}:buy`, config);
                choices.push({ kind: 'offerBuy', agreementCid: round.cid, action: { type: 'make-offer', direction: 'buy', agreementCid: round.cid, agreementName: round.title,
                    apartment: apartmentRef(unit), city: round.city, title: `${unit.label} · ${round.planTitle || round.title}`, priceLamports: String(price), days: config.offerDays,
                    lens: config.offerLens, usdc: 0, signedActions: 1,
                    rationale: `Bid ${Number(price) / 1e9} SOL for ${unit.label}, reserved by another wallet in ${round.title}.` } });
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
    if (!choices.length) return { action: null, options: [], capped: false, reason: 'No apartment to reserve, offer to make or round to contribute to.' };
    // One kind by weight among the kinds that have options, then one option of it, both seed-stable.
    const kinds = [...new Set(choices.map(choice => choice.kind))];
    const total = kinds.reduce((sum, kind) => sum + config.weights[kind], 0);
    let draw = stableNumber(`${seed}:${persona.name}:kind`) % total;
    const kind = kinds.find(item => (draw -= config.weights[item]) < 0) || kinds[0];
    const ofKind = choices.filter(choice => choice.kind === kind)
        .sort((a, b) => stableNumber(`${seed}:${persona.name}:${a.agreementCid}:${a.action.unitId || a.action.apartment?.unit || ''}`)
            - stableNumber(`${seed}:${persona.name}:${b.agreementCid}:${b.action.unitId || b.action.apartment?.unit || ''}`));
    const ordered = [...ofKind, ...choices.filter(choice => choice.kind !== kind)];
    const { chosen, capped } = firstFitting(ordered, budget);
    return {
        action: chosen?.action || null, options: ordered, capped,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${ordered.length} option(s), none within the invocation budget.`
    };
}

export { agreementName };
