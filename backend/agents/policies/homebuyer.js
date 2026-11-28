// Homebuyer policy (homebuyer-01…): a household agent in a developer's crowdfunding rounds and in the
// USDC property-offer market for the flats of executed rounds and the plots of its cities' plot markets
// (plot-market.json; held as their lens member states from its devnet owner registry; a plot has no
// round, roundCid null). Pure: input = `homes`
// (homebuyer-chain.js gatherHomes: open rounds with their apartment inventory, its own deposits in
// rounds that ended unexecuted, the flats of executed rounds with who holds each according to the
// round's lens member, and the flats' USDC offers with their chain state), the persona, seed, wallet
// and invocation budget; output = one action or none. society-run.mjs gathers and signs.
//
// Obligations first, in this order: take back a deposit from a round that expired or was cancelled;
// end an own offer past its deadline (its escrow returns to the buyer); create on chain an own offer
// published but not yet minted; accept a bid on a flat it holds; take a listing of a flat its seller
// holds. Then one choice, by a seed-stable draw among what is possible: reserve an available apartment
// (its lens qualifies it first), put a held flat up for sale, bid for a flat another wallet holds, or
// contribute to a plain contribution round. "Holds" is always the round's lens member's word
// (property-holders.js viewOf): the member confirms a sale only then, so nothing else is traded.
import { agreementName, firstFitting, positiveDecimal, stableNumber } from './common.js';

export const ROLE = 'homebuyer';
export const NEEDS = { records: false, noPositions: false, yesPositions: false, pledges: false, homes: true };

const usdc = atomic => Number(atomic) / 1e6;
const HOUR_MS = 3_600_000;

const ATOMIC = 1_000_000n;
const atomicOf = text => { const [whole, fraction = ''] = text.split('.'); return BigInt(whole) * ATOMIC + BigInt(fraction.padEnd(6, '0')); };

export function policyConfig(persona = {}) {
    const policy = persona.policy || {};
    const offerMinAtomic = atomicOf(positiveDecimal(policy.offerMinUsdc, '1', `${persona.name} policy.offerMinUsdc`));
    const offerMaxAtomic = atomicOf(positiveDecimal(policy.offerMaxUsdc, '3', `${persona.name} policy.offerMaxUsdc`));
    if (offerMinAtomic > offerMaxAtomic) throw new Error(`${persona.name} policy.offerMinUsdc exceeds policy.offerMaxUsdc`);
    return {
        maxReservations: Math.max(0, Number(policy.maxReservations ?? 2)),
        maxDepositUsdc: Number(positiveDecimal(policy.maxDepositUsdc, '4', `${persona.name} policy.maxDepositUsdc`)),
        donationUsdc: positiveDecimal(policy.donationUsdc, '0.5', `${persona.name} policy.donationUsdc`),
        // Flat offers in USDC: the price of a listing or bid it makes, the most it pays for a listing and
        // the least it takes for a bid; how long its offers run; how many it has open or taken at once;
        // and how many of the newest executed rounds' flats it reads (gatherHomes).
        offerMinAtomic, offerMaxAtomic,
        offerDays: Math.max(1, Number(policy.offerDays ?? 2)),
        maxOpenOffers: Math.max(0, Number(policy.maxOpenOffers ?? 2)),
        tradeRounds: Math.max(0, Number(policy.tradeRounds ?? 3)),
        // Relative weights of the free choices (0 turns one off).
        weights: { reserve: 4, offerSell: 2, offerBuy: 2, donate: 2, ...(policy.weights || {}) }
    };
}

// A price in atomic USDC between the configured bounds, stable for one seed, on 0.01 USDC steps.
export function offerPrice(seed, { offerMinAtomic, offerMaxAtomic }) {
    const steps = Number((offerMaxAtomic - offerMinAtomic) / 10_000n);
    return offerMinAtomic + BigInt(steps > 0 ? stableNumber(seed) % (steps + 1) : 0) * 10_000n;
}

// The offer content's creation instant, whole seconds, fixed in the action so a resumed turn
// publishes the same CID.
const createdAtOf = now => new Date(Math.floor(now / 1000) * 1000).toISOString();
const usdcText = atomic => String(Number(atomic) / 1e6);

/**
 * @param {{ persona, seed, now?, wallet, homes: { rounds, refunds, flats?, offers? }, budget? }} input
 *   flats: [{ roundCid, roundTitle, title, city, label, asset, assetHash, lens, holder, holding, pending, stale }]
 *   offers: [{ cid, assetHash, content, chain: null | { status, maker, buyer, seller, price, escrow, deadline } }]
 */
export function decide({ persona, seed, now = Date.now(), wallet = null, homes = null, budget = null } = {}) {
    if (!persona?.name) throw new Error('persona.name is required');
    if (!seed) throw new Error('seed is required');
    const config = policyConfig(persona);
    if (!homes || !wallet) return { action: null, options: [], capped: false, reason: 'No rounds were read.' };
    const rounds = homes.rounds || [];
    const mine = rounds.flatMap(round => round.units.filter(unit => unit.status === 'reserved' && unit.buyer === wallet).map(unit => ({ round, unit })));
    const market = offerMarket({ homes, wallet, now });

    const obligations = [];
    for (const refund of homes.refunds || []) {
        obligations.push({ agreementCid: refund.cid, action: { type: 'refundMyDonations', agreementCid: refund.cid, account: refund.account, agreementName: refund.title,
            amount: String(usdc(refund.amount)), usdc: 0, signedActions: 1,
            rationale: `Take back the ${usdc(refund.amount)} USDC deposit from ${refund.title}: the round ${refund.chainStatus} without executing.` } });
    }
    obligations.push(...offerObligations({ market, config, wallet, now }));
    if (obligations.length) {
        obligations.sort((a, b) => stableNumber(`${seed}:${persona.name}:${a.agreementCid}`) - stableNumber(`${seed}:${persona.name}:${b.agreementCid}`));
        const order = ['refundMyDonations', 'expire-offer', 'mint-offer', 'accept-bid', 'take-listing'];
        obligations.sort((a, b) => order.indexOf(a.action.step || a.action.type) - order.indexOf(b.action.step || b.action.type));
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
                    unitId: unit.unitId, label: unit.label, asset: { kind: 'flat', xrayBuilding: unit.xrayBuilding, unit: unit.unit, at: unit.at }, amount: String(usdc(unit.depositUsdcAtomic)), usdc: usdc(unit.depositUsdcAtomic), signedActions: 1,
                    rationale: `Reserve ${unit.label} in ${round.title}: deposit ${usdc(unit.depositUsdcAtomic)} USDC of its ${usdc(unit.priceUsdcAtomic)} USDC price.` } });
            }
        }
    }
    choices.push(...offerChoices({ market, config, wallet, now, seed: `${seed}:${persona.name}` }));
    if (config.weights.donate > 0) {
        for (const round of openRounds.filter(item => item.plain && !item.donatedByMe)) {
            choices.push({ kind: 'donate', agreementCid: round.cid, action: { type: 'donate', agreementCid: round.cid, account: round.account, agreementName: round.title,
                amount: config.donationUsdc, usdc: Number(config.donationUsdc), signedActions: 1,
                rationale: `Contribute ${config.donationUsdc} USDC to ${round.title} (target ${usdc(round.targetUsdcAtomic)} USDC).` } });
        }
    }
    if (!choices.length) return { action: null, options: [], capped: false, reason: 'No apartment to reserve, flat offer to make or round to contribute to.' };
    // One kind by weight among the kinds that have options, then one option of it, both seed-stable.
    const kinds = [...new Set(choices.map(choice => choice.kind))];
    const total = kinds.reduce((sum, kind) => sum + config.weights[kind], 0);
    let draw = stableNumber(`${seed}:${persona.name}:kind`) % total;
    const kind = kinds.find(item => (draw -= config.weights[item]) < 0) || kinds[0];
    const ofKind = choices.filter(choice => choice.kind === kind)
        .sort((a, b) => stableNumber(`${seed}:${persona.name}:${a.agreementCid}:${a.action.unitId || a.action.asset?.unit || a.action.asset?.id || ''}`)
            - stableNumber(`${seed}:${persona.name}:${b.agreementCid}:${b.action.unitId || b.action.asset?.unit || b.action.asset?.id || ''}`));
    const ordered = [...ofKind, ...choices.filter(choice => choice.kind !== kind)];
    const { chosen, capped } = firstFitting(ordered, budget);
    return {
        action: chosen?.action || null, options: ordered, capped,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${ordered.length} option(s), none within the invocation budget.`
    };
}

// ---- flat offers ---------------------------------------------------------------------------------

/**
 * The flats and their USDC offers as this wallet sees them: offers on a known flat only (the policy
 * trades nothing its lens member does not state a holder for), which of them are its own and still
 * running, how many it has open or taken, and which flats have a sale in progress.
 */
function offerMarket({ homes, wallet, now }) {
    const flats = homes.flats || [];
    const byHash = new Map(flats.map(flat => [flat.assetHash, flat]));
    const nowSeconds = BigInt(Math.floor(now / 1000));
    const offers = (homes.offers || []).filter(offer => offer.content?.currency === 'USDC' && byHash.has(offer.assetHash))
        .map(offer => {
            const chain = offer.chain;
            const pastDeadline = Boolean(chain) && BigInt(chain.deadline) < nowSeconds;
            const running = chain ? ['Open', 'Committed'].includes(chain.status) && !pastDeadline : Date.parse(offer.content.expiresAt) > now;
            return { ...offer, flat: byHash.get(offer.assetHash), pastDeadline, running, mine: offer.content.proposer === wallet,
                takeable: chain?.status === 'Open' && Date.parse(offer.content.expiresAt) > now + HOUR_MS };
        });
    const open = offers.filter(offer => (offer.mine && offer.running) || (!offer.mine && offer.running && offer.chain?.status === 'Committed' && offer.chain.buyer === wallet)).length;
    // A committed offer or a confirmed sale not yet settled: the lens member confirms one sale of a holding at a time.
    const busy = new Set([...offers.filter(offer => offer.running && offer.chain?.status === 'Committed').map(offer => offer.assetHash),
        ...flats.filter(flat => flat.pending || flat.stale).map(flat => flat.assetHash)]);
    return { flats, offers, open, busy };
}

function offerObligations({ market, config, wallet, now }) {
    const out = [];
    const name = offer => offer.content.title || offer.flat.title || offer.cid;
    const base = (offer, step, extra) => ({ agreementCid: offer.cid, action: { type: step, offerCid: offer.cid, agreementCid: offer.cid, agreementName: name(offer), city: offer.content.city, asset: offer.content.asset, signedActions: 1, ...extra } });
    for (const offer of market.offers) {
        const chain = offer.chain, price = BigInt(offer.content.price);
        // Its own offer, or one whose escrow it paid, past the deadline: anyone may end it; the escrow returns to the buyer.
        if (chain && offer.pastDeadline && ['Open', 'Committed'].includes(chain.status) && (chain.maker === wallet || (chain.buyer === wallet && BigInt(chain.escrow) > 0n))) {
            out.push(base(offer, 'expire-offer', { amount: usdcText(chain.escrow), usdc: 0,
                rationale: `End the offer for ${name(offer)}: its deadline passed with the offer ${chain.status.toLowerCase()}${BigInt(chain.escrow) > 0n ? `; ${usdcText(chain.escrow)} USDC returns to the buyer` : ''}.` }));
            continue;
        }
        // Published but never created on Solana (a turn stopped between the two): create it now.
        if (offer.mine && !chain && Date.parse(offer.content.expiresAt) > now + HOUR_MS) {
            const pays = offer.content.direction === 'buy';
            out.push(base(offer, 'mint-offer', { direction: offer.content.direction, amount: usdcText(price), usdc: pays ? Number(price) / 1e6 : 0,
                rationale: `Create the published ${offer.content.direction} offer for ${name(offer)} on Solana${pays ? `, paying ${usdcText(price)} USDC into escrow` : ''}.` }));
            continue;
        }
        if (offer.mine || !offer.takeable || market.busy.has(offer.assetHash)) continue;
        const flat = offer.flat;
        // A bid on a flat it holds whose buyer's lens is the round's lens member alone suffices.
        if (offer.content.direction === 'buy' && flat.holder === wallet && offer.content.lens.threshold === 1 && offer.content.lens.members.includes(flat.lens)
            && price >= config.offerMinAtomic) {
            out.push(base(offer, 'take-offer', { step: 'accept-bid', role: 'seller', price: String(price), amount: usdcText(price), usdc: 0,
                rationale: `Accept the ${usdcText(price)} USDC bid for ${name(offer)}, which it holds; the payout comes when the round's lens member confirms.` }));
        }
        // A listing whose seller holds the flat according to the round's lens member, with no seller's lens to satisfy.
        if (offer.content.direction === 'sell' && flat.holder === offer.content.proposer && flat.holder !== wallet && !offer.content.lens.members.length
            && price <= config.offerMaxAtomic && market.open < config.maxOpenOffers) {
            out.push(base(offer, 'take-offer', { step: 'take-listing', role: 'buyer', lens: flat.lens, price: String(price), amount: usdcText(price), usdc: Number(price) / 1e6,
                rationale: `Buy ${name(offer)} at ${usdcText(price)} USDC into escrow; the round's lens member, which states the seller holds it, confirms.` }));
        }
    }
    return out;
}

function offerChoices({ market, config, wallet, now, seed }) {
    if (market.open >= config.maxOpenOffers) return [];
    const out = [];
    const ownRunning = (flat, direction) => market.offers.some(offer => offer.mine && offer.running && offer.assetHash === flat.assetHash && offer.content.direction === direction);
    for (const flat of market.flats) {
        if (!flat.holder || market.busy.has(flat.assetHash)) continue;
        const direction = flat.holder === wallet ? 'sell' : 'buy';
        const kind = direction === 'sell' ? 'offerSell' : 'offerBuy';
        if (!(config.weights[kind] > 0) || ownRunning(flat, direction)) continue;
        const price = offerPrice(`${seed}:${flat.assetHash}:${direction}`, config);
        out.push({ kind, agreementCid: flat.roundCid, action: { type: 'make-offer', direction, agreementCid: flat.roundCid, agreementName: flat.roundTitle,
            offerTitle: flat.title, city: flat.city, asset: flat.asset, price: String(price), amount: usdcText(price), lens: direction === 'buy' ? flat.lens : null,
            days: config.offerDays, createdAt: createdAtOf(now), usdc: direction === 'buy' ? Number(price) / 1e6 : 0, signedActions: 1,
            rationale: direction === 'sell'
                ? `Put ${flat.title}, which it holds, up for sale at ${usdcText(price)} USDC.`
                : `Bid ${usdcText(price)} USDC for ${flat.title}, which ${flat.holder} holds; the price goes into escrow and the round's lens member confirms the sale.` } });
    }
    return out;
}

export { agreementName };
