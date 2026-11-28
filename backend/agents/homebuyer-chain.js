// The chain-reading and signing half of the homebuyer policy (policies/homebuyer.js), called by
// society-run.mjs: gatherHomes reads the developer crowdfunding rounds of the persona's cities with
// their apartment inventory, its own deposits in rounds that ended unexecuted, the flats of the newest
// executed rounds with who holds each according to the round's lens member, and those flats' USDC
// property offers (property-offer/v2) with their chain accounts; executeHomeAction signs the one
// action the policy chose. The round's lens member qualifies a reserving buyer through its operator
// token (the persona of that lens member names the variable, service.operatorTokenEnv), as the lens
// operator does for a buyer's qualification request. Offer steps go through property-offer-signer.js,
// the same steps the browser's offer sheet takes; the lens member's own confirmations are the proposer
// runner's (property-lens-duties.js).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { discoverAgreements, readAgreementStatuses } from './discovery.js';
import { qualifyApartmentBuyer, readRoundInventory, readRoundsInventory, reserveApartment } from './apartment-actions.js';
import { apartmentQualification, refundContributions } from './chain-actions.js';
import { donationIdBytes, ensureDonationEscrowAndDonate } from './donor.js';
import { ensureBotUsdcFunding } from './funding.js';
import { usdcToAtomic } from './bettor.js';
import { policyConfig } from './policies/homebuyer.js';
import { createPropertyOfferTools } from './mcp-property-offers.js';
import { commitOffer, createOfferOnChain, createOnchainRecorder, expireOffer } from './property-offer-signer.js';
import { client as offerClient, validateOfferAccount } from '../property-offers/onchain.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { loadPlotMarkets, plotAssets } from './plot-market.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const Statements = require('../../frontend/js/solana/property-statements.js').configure({ web3 });
const Holders = require('../../frontend/js/property-holders.js');
pledge.configure({ web3 });

const DEFAULT_APP_ORIGIN = 'https://urbangametheory.xyz';
// Offers read per city and of its own, newest first; a cut is logged.
const MAX_OFFERS = 100;

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
 *   refunds: [{ cid, account, title, chainStatus, amount }],
 *   flats: [{ roundCid, roundTitle, title, city, label, asset, assetHash, lens, holder, holding, pending, stale }]: the flats
 *     of executed rounds and the plots of its cities' plot markets (roundCid null, roundTitle the plot's label),
 *   offers: [{ cid, assetHash, content, chain: null | { status, maker, buyer, seller, price, escrow, deadline } }] }
 * `offerTools` (mcp-property-offers.js createPropertyOfferTools) reads the offer index.
 */
export async function gatherHomes({ index, persona, connection, wallet, apiBase, appOrigin = DEFAULT_APP_ORIGIN,
    offerTools = apiBase ? createPropertyOfferTools({ apiBase, appOrigin }) : null, personas = loadPersonas(), markets = loadPlotMarkets(), log = () => {} }) {
    const cities = persona.policy?.cities?.length ? persona.policy.cities.filter(city => city !== '*') : [];
    if (!cities.length) throw new Error(`${persona.name}: a homebuyer names its cities (policy.cities)`);
    const { tradeRounds } = policyConfig(persona);
    const found = await readAgreementStatuses(await discoverAgreements({ index, cities, log }), connection);
    const owner = wallet ? new web3.PublicKey(wallet) : null;
    const rounds = [];
    const refunds = [];
    const executed = [];
    const activeEntries = [];
    for (const summary of found.filter(row => row.rule?.electorate === 'investors' && row.chainStatus)) {
        const row = await index.getAgreement(summary.cid);
        const content = row?.content;
        if (!content?.funding) continue;
        const apartments = content.funding.apartments;
        const plain = !apartments;
        // A round the app's record check now refuses (built before a contract change) can take no
        // reservation or offer: only deposits on it are taken back, and the other rounds are still served.
        const recordError = agreementRecord.crowdfundingError(content);
        if (recordError && ['active', 'executed'].includes(summary.chainStatus)) log(`${persona.name}: round ${summary.cid} skipped: ${recordError}`);
        // The newest executed apartment rounds (discovery is newest first): their flats are traded.
        if (!recordError && summary.chainStatus === 'executed' && apartments && executed.length < tradeRounds) executed.push({ summary, row, content });
        if (owner && ['expired', 'cancelled'].includes(summary.chainStatus)) {
            const positions = plain ? await pledge.listDonationPositions(connection, summary.account, owner)
                : await pledge.apartmentPositions(connection, summary.account, owner, content.funding, agreementRecord);
            // refundContributions takes back all of them in one transaction.
            const owed = positions.filter(item => !item.refunded && item.amount > 0n).reduce((sum, item) => sum + item.amount, 0n);
            if (owed > 0n) refunds.push({ cid: summary.cid, account: summary.account, title: summary.name, chainStatus: summary.chainStatus, amount: String(owed) });
        }
        if (summary.chainStatus !== 'active' || recordError) continue;
        activeEntries.push({ summary, row, content, apartments, plain });
    }
    // Batch apartment inventory across all active AND executed rounds in one pass (2 RPCs total instead of 2 per round).
    const inventoryTargets = [
        ...activeEntries.filter(entry => !entry.plain).map(entry => ({ account: entry.summary.account, content: entry.content })),
        ...executed.map(entry => ({ account: entry.summary.account, content: entry.content }))
    ];
    let inventoriesByAccount;
    if (typeof readRoundsInventory === 'function' && typeof connection?.getMultipleAccountsInfo === 'function') {
        inventoriesByAccount = await readRoundsInventory(connection, inventoryTargets);
    } else {
        inventoriesByAccount = new Map(await Promise.all(inventoryTargets.map(async target => [target.account, await readRoundInventory(connection, target)])));
    }
    // Batch plain-round own-donation checks into a single getMultipleAccounts call.
    const plainActive = owner ? activeEntries.filter(entry => entry.plain) : [];
    const plainDonationByAccount = new Map();
    if (plainActive.length) {
        const donationPdas = plainActive.map(entry => pledge.getDonationPositionPda(
            pledge.getDonationEscrowPda(entry.summary.account)[0], owner, donationIdBytes(donationOperation(persona, entry.summary.cid))
        )[0]);
        const donationInfos = await getMultipleAccountsBatched(connection, donationPdas, { batchSize: accountsPerRequest() });
        plainActive.forEach((entry, i) => { plainDonationByAccount.set(entry.summary.account, Boolean(donationInfos[i])); });
    }
    for (const { summary, row, content, apartments, plain } of activeEntries) {
        const inventory = plain ? [] : (inventoriesByAccount.get(summary.account) || []);
        const byId = new Map((apartments?.units || []).map(unit => [unit.unitId, unit]));
        const donatedByMe = plain ? Boolean(plainDonationByAccount.get(summary.account)) : false;
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
    // The plots of its cities' plot markets (plot-market.json) trade beside the flats, held as their lens member states.
    const plots = plotAssets({ cities, personas, markets });
    const flats = await readFlats({
        connection, executed, plots,
        readInventory: async (_conn, target) => inventoriesByAccount.get(target.account) ?? readRoundInventory(connection, target),
        log: message => log(`${persona.name}: ${message}`)
    });
    const offers = offerTools && flats.length ? await readFlatOffers({ connection, offerTools, cities, wallet, flats, log: message => log(`${persona.name}: ${message}`) }) : [];
    log(`${persona.name}: ${rounds.length} open round(s) (${rounds.reduce((sum, round) => sum + round.units.filter(unit => unit.status === 'available').length, 0)} apartment(s) available), ${refunds.length} deposit(s) to take back, `
        + `${flats.filter(flat => flat.asset.kind === 'flat').length} flat(s) of ${executed.length} executed round(s) and ${flats.filter(flat => flat.asset.kind === 'parcel').length} plot(s) `
        + `(${flats.filter(flat => flat.holder).length} with a stated holder, ${flats.filter(flat => flat.holder === wallet).length} held by this wallet), ${offers.length} USDC offer(s)`);
    return { rounds, refunds, flats, offers };
}

/**
 * The reserved flats of executed rounds, each with who holds it according to the round's lens member
 * (property-holders.js viewOf over its statements). The first-holder statements are read in one batch;
 * the sales each lens member confirmed are followed per flat. A flat that cannot be read is logged and left out.
 */
export async function readFlats({ connection, executed, plots = [], env = process.env, readInventory = readRoundInventory, log = () => {} }) {
    const flats = [];
    for (const { summary, row, content } of executed) {
        const lens = content.rule?.lens?.[0];
        if (!lens) continue;
        const byId = new Map(content.funding.apartments.units.map(unit => [unit.unitId, unit]));
        const inventory = await readInventory(connection, { account: summary.account, content });
        for (const item of inventory.filter(entry => entry.status === 'reserved' && entry.buyer)) {
            const unit = byId.get(item.unitId);
            const asset = { kind: 'flat', xrayBuilding: unit.xrayBuilding, unit: unit.unit, at: unit.at };
            flats.push({ roundCid: summary.cid, roundTitle: summary.name, title: `${unit.label} · ${row.planTitle || summary.name}`, city: content.city ?? summary.city,
                label: unit.label, asset, assetHash: Offer.assetHash(asset), lens, buyer: item.buyer });
        }
    }
    // Plots (plot-market.js plotAssets) have no round: their key and label stand in for it.
    for (const plot of plots) flats.push({ roundCid: null, roundTitle: plot.label, title: plot.title, city: plot.city, label: plot.label, asset: plot.asset, assetHash: plot.assetHash, lens: plot.lens });
    if (!flats.length) return [];
    const batchSize = accountsPerRequest(env);
    const getAccounts = async addresses => {
        if (!addresses.length) return new Map();
        const infos = await getMultipleAccountsBatched(connection, addresses.map(address => new web3.PublicKey(address)), { batchSize });
        return new Map(addresses.map((address, i) => [address, infos[i]?.data ? new Uint8Array(infos[i].data) : null]));
    };
    const views = await Holders.viewsOf({
        items: flats.map(flat => ({ member: flat.lens, assetHash: flat.assetHash })),
        getAccounts, statements: Statements, offers: offerClient
    });
    const out = [];
    for (const [i, flat] of flats.entries()) {
        const view = views[i];
        out.push({ ...flat, holder: view.holder, holding: view.holding, pending: view.pending?.offer ?? null, stale: Boolean(view.stale || view.invalid) });
    }
    return out;
}

/**
 * The USDC offers on these flats: the cities' open and committed ones (past their deadline too, so
 * they can be ended) and this wallet's own, each read from its chain account and checked against its
 * published terms (property-offers/onchain.js). An unminted offer has chain null.
 */
export async function readFlatOffers({ connection, offerTools, cities, wallet, flats, env = process.env, log = () => {} }) {
    const hashes = new Set(flats.map(flat => flat.assetHash));
    const rows = new Map();
    const pages = [...cities.map(city => ({ city, currency: 'USDC', status: 'open,committed', limit: MAX_OFFERS })),
        ...(wallet ? [{ maker: wallet, currency: 'USDC', status: 'unminted,open,committed', limit: MAX_OFFERS }] : [])];
    for (const query of pages) {
        const page = await offerTools.list(query);
        if (page.hasMore) log(`read the newest ${MAX_OFFERS} offers for ${query.city || 'this wallet'} (more exist)`);
        for (const row of page.propertyOffers || []) {
            if (rows.has(row.cid) || !['flat', 'parcel'].includes(row.content?.asset?.kind)) continue;
            const assetHash = Offer.assetHash(row.content.asset);
            if (!hashes.has(assetHash)) continue;
            if (Offer.cid(row.content) !== row.cid) { log(`offer ${row.cid} does not match its CID; left out`); continue; }
            rows.set(row.cid, { ...row, assetHash });
        }
    }
    const list = [...rows.values()];
    const infos = await getMultipleAccountsBatched(connection, list.map(row => offerClient.getOfferPda(row.cid, row.content.proposer)[0]), { batchSize: accountsPerRequest(env) });
    const offers = [];
    list.forEach((row, i) => {
        let chain = null;
        try {
            if (infos[i]) {
                if (!new web3.PublicKey(infos[i].owner).equals(new web3.PublicKey(offerClient.constants.PROPERTY_OFFER_PROGRAM_ID))) throw new Error('account belongs to another program');
                const account = validateOfferAccount(row, offerClient.readPropertyOffer(new Uint8Array(infos[i].data), offerClient.getOfferPda(row.cid, row.content.proposer)[0].toBase58()));
                chain = { status: account.status, maker: account.maker, buyer: account.buyer, seller: account.seller,
                    price: String(account.price), escrow: String(account.escrow), deadline: String(account.deadline) };
            }
        } catch (error) {
            log(`offer ${row.cid} chain account unreadable (${error.message}); left out`);
            return;
        }
        offers.push({ cid: row.cid, assetHash: row.assetHash, content: row.content, chain });
    });
    return offers;
}

export const HOME_ACTIONS = new Set(['reserve-apartment', 'donate', 'refundMyDonations', 'make-offer', 'mint-offer', 'take-offer', 'expire-offer']);

// A homebuyer's flat offer in USDC, its own wallet the maker: a sale pays everything to itself and names
// no seller's lens; a bid names the round's lens member (threshold 1) to confirm the seller holds it.
export function homeOffer({ direction, proposer, lens, asset, city, price, offerTitle, createdAt, days }) {
    const raw = { schema: Offer.PUBLISHED_SCHEMA, title: offerTitle, city, createdAt, expiresAt: new Date(Date.parse(createdAt) + days * 86_400_000).toISOString(),
        direction, proposer, currency: 'USDC', price: String(price), asset,
        lens: direction === 'buy' ? { members: [lens], threshold: 1 } : { members: [], threshold: 0 },
        ...(direction === 'sell' ? { payouts: [{ recipient: proposer, amount: String(price) }] } : {}) };
    const content = Offer.published(raw, { now: Date.parse(createdAt) });
    return { cid: Offer.cid(content, { now: Date.parse(createdAt) }), content };
}

/**
 * Sign the homebuyer's one action. `personas` resolves lens members; `env` carries their operator tokens.
 * Chain steps go through the shared signers: apartment-actions.js (reserve), chain-actions.js (refunds,
 * the buyer's qualification read); what is the bots' own is which persona acts when, and the lens
 * operator's qualification of the bot buyer.
 */
export async function executeHomeAction({ action, connection, keypair, pool, persona, index, apiBase, appOrigin = DEFAULT_APP_ORIGIN,
    offerTools = apiBase ? createPropertyOfferTools({ apiBase, appOrigin }) : null, recordOnchain = apiBase ? createOnchainRecorder({ apiBase, appOrigin }) : null,
    signer = { createOfferOnChain, commitOffer, expireOffer },
    personas = loadPersonas(), env = process.env, sendAndConfirm = web3.sendAndConfirmTransaction, maxUsdcAtomic }) {
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
    if (!offerTools || !recordOnchain) throw new Error(`${action.type} needs the offer index (apiBase)`);
    // The steps the browser's offer sheet takes; each reads the chain account first and replays without signing.
    const signing = { connection, keypair, cluster: 'devnet', recordOnchain, sendAndConfirm };
    if (action.type === 'make-offer') {
        const { cid, content } = homeOffer({ ...action, proposer: wallet });
        await offerTools.publish({ offer: content, expectedCid: cid, confirm: true });
        if (action.direction === 'buy') await fund(BigInt(content.price));
        return { ...(await signer.createOfferOnChain({ ...signing, row: { cid, content } })), offerCid: cid };
    }
    const row = await offerTools.get({ cid: action.offerCid });
    const offerRow = { cid: row.cid, content: row.content, onchain: row.onchain ?? null };
    if (action.type === 'mint-offer') {
        if (row.content.direction === 'buy') await fund(BigInt(row.content.price));
        return signer.createOfferOnChain({ ...signing, row: offerRow });
    }
    if (action.type === 'take-offer') {
        if (action.role === 'buyer') {
            if (row.content.direction !== 'sell') throw new Error(`offer ${row.cid} is not a listing`);
            await fund(BigInt(row.content.price));
            return signer.commitOffer({ ...signing, row: offerRow, lens: { members: [action.lens], threshold: 1 } });
        }
        if (row.content.direction !== 'buy') throw new Error(`offer ${row.cid} is not a bid`);
        // The whole price is paid to this wallet; no seller's lens.
        return signer.commitOffer({ ...signing, row: offerRow });
    }
    if (action.type === 'expire-offer') return signer.expireOffer({ ...signing, row: offerRow });
    throw new Error(`homebuyer cannot execute ${action.type}`);
}

export function homeActivityMessage(persona, action) {
    switch (action.type) {
    case 'reserve-apartment': return `${persona.name} reserved ${action.label} in ${action.agreementName} with a ${action.amount} USDC deposit.`;
    case 'donate': return `${persona.name} contributed ${action.amount} USDC to ${action.agreementName}.`;
    case 'refundMyDonations': return `${persona.name} took back its ${action.amount} USDC deposit from ${action.agreementName}.`;
    case 'make-offer': return action.direction === 'sell'
        ? `${persona.name} put ${action.offerTitle} up for sale for ${action.amount} USDC.`
        : `${persona.name} bid ${action.amount} USDC for ${action.offerTitle}.`;
    case 'mint-offer': return `${persona.name} created its offer for ${action.agreementName} on Solana.`;
    case 'take-offer': return action.role === 'buyer'
        ? `${persona.name} took the listing of ${action.agreementName} at ${action.amount} USDC; the lens member confirms.`
        : `${persona.name} accepted the ${action.amount} USDC bid for ${action.agreementName}; the lens member confirms.`;
    case 'expire-offer': return `${persona.name} ended its expired offer for ${action.agreementName}.`;
    default: return `${persona.name} ${action.type} ${action.agreementName}.`;
    }
}

/**
 * What an action's activity names: its entity, the property offer (a new one by the CID its execution
 * published) or else the round; the plot or flat it trades (asset); and, for an offer, its city.
 */
export function homeActivity(action, result = {}) {
    const entity = ['mint-offer', 'take-offer', 'expire-offer'].includes(action.type) ? { type: 'property-offer', id: action.offerCid }
        : action.type === 'make-offer' ? { type: 'property-offer', id: result.offerCid }
            : { type: 'agreement', id: action.agreementCid };
    return { entity, ...(action.asset ? { asset: action.asset } : {}), ...(action.city ? { cityId: action.city } : {}) };
}
