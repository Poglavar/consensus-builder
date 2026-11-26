// The chain-reading and signing half of the homebuyer policy (policies/homebuyer.js), called by
// society-run.mjs: gatherHomes reads the developer crowdfunding rounds of the persona's cities with
// their apartment inventory, its own deposits in rounds that ended unexecuted, and the cities'
// apartment offers with their accounts; executeHomeAction signs the one action the policy chose.
// The round's or offer's lens member qualifies the buyer through its operator token (the persona of
// that lens member names the variable, service.operatorTokenEnv), as the lens operator does for a
// buyer's qualification request.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { discoverAgreements, readAgreementStatuses } from './discovery.js';
import { qualifyApartmentBuyer, qualifyOfferCounterparty, readRoundInventory, reserveApartment } from './apartment-actions.js';
import { apartmentQualification, refundContributions } from './chain-actions.js';
import { donationIdBytes, ensureDonationEscrowAndDonate } from './donor.js';
import { ensureBotUsdcFunding } from './funding.js';
import { usdcToAtomic } from './bettor.js';
import { createPropertyOfferTools } from './mcp-property-offers.js';
import { acceptOffer, createOfferOnChain, createOnchainRecorder, fundOffer, releaseOffer } from './property-offer-signer.js';
import { client as offerClient } from '../property-offers/onchain.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
pledge.configure({ web3 });

const MAX_OFFERS = 60;
const DEFAULT_APP_ORIGIN = 'https://urbangametheory.xyz';

const donationOperation = (persona, cid) => `${persona.name}:donate:${cid}`;

/** The lens-member persona of a key or name, with its service URL and operator token from `env`. */
export function lensService(personas, keyOrName, env = process.env) {
    const member = personas.find(p => p.role === 'lens-member' && (p.wallet === keyOrName || p.name === keyOrName));
    if (!member?.service?.url) throw new Error(`no lens-member persona with a service for ${keyOrName}`);
    const token = member.service.operatorTokenEnv ? String(env[member.service.operatorTokenEnv] || '').trim() : '';
    return { name: member.name, key: member.wallet, serviceUrl: String(env.AGENT_LENS_SERVICE_URL || member.service.url), operatorToken: token || null };
}

export function loadPersonas(file = new URL('./personas.json', import.meta.url)) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).personas || [];
}

/**
 * { rounds: [{ cid, account, sponsor, title, planTitle, city, deadline, chainStatus, plain, targetUsdcAtomic, donatedByMe,
 *   units: [{ unitId, label, xrayBuilding, unit, at, priceUsdcAtomic, depositUsdcAtomic, status, buyer }] }],
 *   refunds: [{ cid, account, title, chainStatus, amount }], offers: [{ cid, content, chain }] }
 */
export async function gatherHomes({ index, persona, connection, wallet, apiBase, appOrigin = DEFAULT_APP_ORIGIN, log = () => {} }) {
    const cities = persona.policy?.cities?.length ? persona.policy.cities.filter(city => city !== '*') : [];
    if (!cities.length) throw new Error(`${persona.name}: a homebuyer names its cities (policy.cities)`);
    const found = await readAgreementStatuses(await discoverAgreements({ index, cities, log }), connection);
    const rounds = [];
    const refunds = [];
    for (const summary of found.filter(row => row.rule?.electorate === 'investors' && row.chainStatus)) {
        const row = await index.getAgreement(summary.cid);
        const content = row?.content;
        if (!content?.funding) continue;
        const apartments = content.funding.apartments;
        const plain = !apartments;
        const owner = wallet ? new web3.PublicKey(wallet) : null;
        if (owner && ['expired', 'cancelled'].includes(summary.chainStatus)) {
            const positions = plain ? await pledge.listDonationPositions(connection, summary.account, owner)
                : await pledge.apartmentPositions(connection, summary.account, owner, content.funding, agreementRecord);
            // refundContributions takes back all of them in one transaction.
            const owed = positions.filter(item => !item.refunded && item.amount > 0n).reduce((sum, item) => sum + item.amount, 0n);
            if (owed > 0n) refunds.push({ cid: summary.cid, account: summary.account, title: summary.name, chainStatus: summary.chainStatus, amount: String(owed) });
        }
        if (summary.chainStatus !== 'active') continue;
        const inventory = plain ? [] : await readRoundInventory(connection, { account: summary.account, content });
        const byId = new Map((apartments?.units || []).map(unit => [unit.unitId, unit]));
        let donatedByMe = false;
        if (plain && owner) {
            const id = pledge.getDonationPositionPda(pledge.getDonationEscrowPda(summary.account)[0], owner, donationIdBytes(donationOperation(persona, summary.cid)))[0];
            donatedByMe = Boolean(await connection.getAccountInfo(id, 'confirmed'));
        }
        rounds.push({
            cid: summary.cid, account: summary.account, sponsor: content.sponsor, title: summary.name, planTitle: row.planTitle ?? null,
            city: content.city ?? summary.city, deadline: content.deadline, chainStatus: summary.chainStatus, plain,
            targetUsdcAtomic: content.funding.targetUsdcAtomic, donatedByMe,
            units: inventory.map(item => {
                const unit = byId.get(item.unitId);
                return { unitId: item.unitId, label: unit.label, xrayBuilding: unit.xrayBuilding, unit: unit.unit, at: unit.at,
                    priceUsdcAtomic: unit.priceUsdcAtomic, depositUsdcAtomic: unit.depositUsdcAtomic, status: item.status, buyer: item.buyer };
            })
        });
    }
    const offerTools = createPropertyOfferTools({ apiBase, appOrigin });
    const offers = [];
    for (const city of cities) {
        const listed = await offerTools.list({ city, limit: MAX_OFFERS });
        for (const row of listed.propertyOffers || []) {
            if (!row.content?.apartment) continue;
            const chain = await offerClient.fetchPropertyOffer(connection, { cid: row.cid, maker: row.content.proposer }).catch(error => {
                log(`${persona.name}: offer ${row.cid} unreadable (${error.message}); skipped`);
                return null;
            });
            if (chain) offers.push({ cid: row.cid, content: row.content, chain: {
                status: chain.status, buyer: chain.buyer, seller: chain.seller, escrowLamports: String(chain.escrowLamports),
                priceLamports: String(chain.priceLamports), deadline: String(chain.deadline) } });
        }
    }
    log(`${persona.name}: ${rounds.length} open round(s) (${rounds.reduce((sum, round) => sum + round.units.filter(unit => unit.status === 'available').length, 0)} apartment(s) available), ${refunds.length} deposit(s) to take back, ${offers.length} apartment offer(s)`);
    return { rounds, refunds, offers };
}

export const HOME_ACTIONS = new Set(['reserve-apartment', 'donate', 'refundMyDonations', 'make-offer', 'accept-offer', 'settle-offer']);

// A homebuyer's apartment offer: whole-lamport price, its own wallet as proposer (and sole payee of a sale).
export function homeOffer({ direction, proposer, lens, apartment, city, priceLamports, title, createdAt, days }) {
    const expiresAt = new Date(Date.parse(createdAt) + days * 86_400_000).toISOString();
    const raw = { schema: Offer.PUBLISHED_SCHEMA, title, city, createdAt, expiresAt, direction, proposer, lens,
        buyer: direction === 'buy' ? proposer : null, seller: direction === 'sell' ? proposer : null, apartment, priceLamports: String(priceLamports),
        ...(direction === 'sell' ? { payouts: [{ recipient: proposer, lamports: String(priceLamports) }] } : {}) };
    const content = Offer.published(raw, { now: Date.parse(createdAt) });
    return { cid: Offer.cid(content, { now: Date.parse(createdAt) }), content };
}

/**
 * Sign the homebuyer's one action. `personas` resolves lens members; `env` carries their operator tokens.
 * Chain steps go through the shared signers: apartment-actions.js (reserve), chain-actions.js (refunds,
 * the buyer's qualification read), property-offer-signer.js (offers); what is the bots' own is which
 * persona acts when, and the lens operator's qualification of the bot counterparty.
 */
export async function executeHomeAction({ action, connection, keypair, pool, persona, index, apiBase, appOrigin = DEFAULT_APP_ORIGIN,
    personas = loadPersonas(), env = process.env, sendAndConfirm = web3.sendAndConfirmTransaction, maxUsdcAtomic, now = () => new Date() }) {
    const wallet = keypair.publicKey.toBase58();
    const fund = async amountAtomic => ensureBotUsdcFunding({ connection, persona, pool, requiredAtomic: amountAtomic, maxActionAtomic: maxUsdcAtomic, sendAndConfirm });
    if (action.type === 'reserve-apartment') {
        const content = (await index.getAgreement(action.agreementCid)).content;
        const lens = lensService(personas, content.rule.lens[0], env);
        const offer = (await readRoundInventory(connection, { account: action.account, content })).find(row => row.unitId === action.unitId);
        if (!offer) throw new Error(`unit ${action.unitId} is not offered by ${action.agreementCid}`);
        // The lens operator qualifies this bot buyer; the buyer then reads and checks it as the browser does.
        await qualifyApartmentBuyer({ serviceUrl: lens.serviceUrl, operatorToken: lens.operatorToken, cid: action.agreementCid, unitId: action.unitId, buyer: wallet });
        const qualification = await apartmentQualification({ cid: action.agreementCid, sponsor: content.sponsor, lenses: content.rule.lens,
            members: [{ key: lens.key, serviceUrl: lens.serviceUrl }], offer, buyer: wallet });
        await fund(usdcToAtomic(action.amount));
        const reserved = await reserveApartment({ connection, buyerKeypair: keypair, account: action.account, content, unitId: action.unitId, qualification, sendAndConfirm });
        return { ...reserved, qualification: qualification.address };
    }
    if (action.type === 'donate') {
        const amountAtomic = usdcToAtomic(action.amount);
        await fund(amountAtomic);
        return ensureDonationEscrowAndDonate({ connection, donorKeypair: keypair, subject: action.account, amountAtomic,
            operationId: donationOperation(persona, action.agreementCid), sendAndConfirm });
    }
    if (action.type === 'refundMyDonations') {
        const row = await index.getAgreement(action.agreementCid);
        return refundContributions({ connection, donorKeypair: keypair, agreement: { cid: row.cid, content: row.content }, sendAndConfirm });
    }
    const tools = createPropertyOfferTools({ apiBase, appOrigin });
    const signing = { connection, keypair, cluster: 'devnet', recordOnchain: createOnchainRecorder({ apiBase, appOrigin }), sendAndConfirm };
    if (action.type === 'make-offer') {
        const lens = lensService(personas, action.lens, env);
        const createdAt = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
        const { cid, content } = homeOffer({ ...action, proposer: wallet, lens: lens.key, createdAt });
        await tools.publish({ offer: content, expectedCid: cid, confirm: true });
        const minted = await createOfferOnChain({ ...signing, row: { cid, content }, lensServiceUrl: lens.serviceUrl });
        return { ...minted, offerCid: cid };
    }
    const row = await tools.get({ cid: action.offerCid });
    if (action.type === 'accept-offer') {
        const lens = lensService(personas, row.content.lens, env);
        const buy = row.content.direction === 'buy';
        const { candidate } = tools.prepare({ offer: row.content, expectedCid: row.cid, buyer: buy ? undefined : wallet, seller: buy ? wallet : undefined,
            payouts: buy ? [{ recipient: wallet, lamports: row.content.priceLamports }] : undefined });
        await qualifyOfferCounterparty({ serviceUrl: lens.serviceUrl, operatorToken: lens.operatorToken, cid: row.cid,
            buyer: candidate.buyer, seller: candidate.seller, payouts: candidate.payouts });
        return acceptOffer({ ...signing, row, candidate, lensServiceUrl: lens.serviceUrl });
    }
    if (action.type === 'settle-offer') {
        const funded = await fundOffer({ ...signing, row });
        const released = await releaseOffer({ ...signing, row });
        return { createSignature: funded.signature, signature: released.signature, replayed: funded.replayed && released.replayed };
    }
    throw new Error(`homebuyer cannot execute ${action.type}`);
}

export function homeActivityMessage(persona, action) {
    switch (action.type) {
    case 'reserve-apartment': return `${persona.name} reserved ${action.label} in ${action.agreementName} with a ${action.amount} USDC deposit.`;
    case 'donate': return `${persona.name} contributed ${action.amount} USDC to ${action.agreementName}.`;
    case 'refundMyDonations': return `${persona.name} took back its ${action.amount} USDC deposit from ${action.agreementName}.`;
    case 'make-offer': return `${persona.name} offered to ${action.direction} ${action.title} for ${Number(action.priceLamports) / 1e9} SOL.`;
    case 'accept-offer': return `${persona.name} accepted the offer for ${action.agreementName} as its ${action.role}.`;
    case 'settle-offer': return `${persona.name} paid for ${action.agreementName} and released the payment to the seller.`;
    default: return `${persona.name} ${action.type} ${action.agreementName}.`;
    }
}

/** The entity an action's activity names: the round, or the property offer. */
export function homeActivityEntity(action) {
    return ['accept-offer', 'settle-offer'].includes(action.type) ? { type: 'property-offer', id: action.offerCid } : { type: 'agreement', id: action.agreementCid };
}
