// The chain-reading and signing half of the homebuyer policy (policies/homebuyer.js), called by
// society-run.mjs: gatherHomes reads the developer crowdfunding rounds of the persona's cities with
// their apartment inventory and its own deposits in rounds that ended unexecuted; executeHomeAction
// signs the one action the policy chose. The round's lens member qualifies the buyer through its
// operator token (the persona of that lens member names the variable, service.operatorTokenEnv), as
// the lens operator does for a buyer's qualification request.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { discoverAgreements, readAgreementStatuses } from './discovery.js';
import { qualifyApartmentBuyer, readRoundInventory, reserveApartment } from './apartment-actions.js';
import { apartmentQualification, refundContributions } from './chain-actions.js';
import { donationIdBytes, ensureDonationEscrowAndDonate } from './donor.js';
import { ensureBotUsdcFunding } from './funding.js';
import { usdcToAtomic } from './bettor.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
pledge.configure({ web3 });

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
 *   refunds: [{ cid, account, title, chainStatus, amount }] }
 */
export async function gatherHomes({ index, persona, connection, wallet, log = () => {} }) {
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
    log(`${persona.name}: ${rounds.length} open round(s) (${rounds.reduce((sum, round) => sum + round.units.filter(unit => unit.status === 'available').length, 0)} apartment(s) available), ${refunds.length} deposit(s) to take back`);
    return { rounds, refunds };
}

export const HOME_ACTIONS = new Set(['reserve-apartment', 'donate', 'refundMyDonations']);

/**
 * Sign the homebuyer's one action. `personas` resolves lens members; `env` carries their operator tokens.
 * Chain steps go through the shared signers: apartment-actions.js (reserve), chain-actions.js (refunds,
 * the buyer's qualification read); what is the bots' own is which persona acts when, and the lens
 * operator's qualification of the bot buyer.
 */
export async function executeHomeAction({ action, connection, keypair, pool, persona, index,
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
    throw new Error(`homebuyer cannot execute ${action.type}`);
}

export function homeActivityMessage(persona, action) {
    switch (action.type) {
    case 'reserve-apartment': return `${persona.name} reserved ${action.label} in ${action.agreementName} with a ${action.amount} USDC deposit.`;
    case 'donate': return `${persona.name} contributed ${action.amount} USDC to ${action.agreementName}.`;
    case 'refundMyDonations': return `${persona.name} took back its ${action.amount} USDC deposit from ${action.agreementName}.`;
    default: return `${persona.name} ${action.type} ${action.agreementName}.`;
    }
}

/** The entity an action's activity names: the round. */
export function homeActivityEntity(action) {
    return { type: 'agreement', id: action.agreementCid };
}
