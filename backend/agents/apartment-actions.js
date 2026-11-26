// Node signer adapters for apartment reservations in a developer crowdfunding round
// (docs/developer-crowdfunding.md "Apartment reservations"), the same instructions the browser's
// agreement bridge sends: the developer lists the round's units (list_apartment, the first listing
// opening the round's USDC escrow), a member of the round's lens qualifies a buyer for one unit
// (POST /lens/agreements/:cid/apartments/:unitId/qualify, operator-only), and the buyer deposits and
// reserves it in one transaction (donate + reserve_apartment). Every step reads the chain first, so a
// rerun signs nothing twice. roundStats reads a round's states and counts with the browser's own model
// (frontend/js/apartment-round.js), for the MCP's ugt_inspect_agreement.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
const apartmentRound = require('../../frontend/js/apartment-round.js').model;
pledge.configure({ web3 });
agreementClient.configure({ web3 });

// list_apartment instructions per transaction; the first may also carry the escrow's creation.
const LISTINGS_PER_TRANSACTION = 4;

async function send(connection, instructions, signer, sendAndConfirm) {
    const transaction = new web3.Transaction().add(...instructions);
    transaction.feePayer = signer.publicKey;
    return sendAndConfirm(connection, transaction, [signer], { commitment: 'confirmed' });
}

/** The round's units as Solana holds them: [{ unitId, unitKey, termsHash, deposit, account, status, buyer, position, qualification }]. */
export function readRoundInventory(connection, { account, content }) {
    if (!content?.funding?.apartments) return Promise.resolve([]);
    return pledge.readApartmentInventory(connection, account, content.sponsor, content.funding, agreementRecord);
}

/**
 * Whether a round takes listings and reservations, as the agreement panel decides it: its account is
 * Active on chain and its deadline has not passed. `chainAccount` is the decoded Agreement account
 * (agreement-minter.js readAgreementAccount), null when it is not on chain.
 */
export function roundAccepting(chainAccount, nowSeconds = Math.floor(Date.now() / 1000)) {
    return !!chainAccount && chainAccount.status === 'Active' && !agreementClient.deadlinePassed(chainAccount, nowSeconds);
}

/**
 * A round's apartment states and counts by the browser's model (ApartmentRound roundView): `units` the
 * chain inventory (readRoundInventory, or the API's apartmentAvailability.units), `chainAccount` the
 * decoded Agreement account the accepting state comes from. Amounts are USDC atomic decimal strings.
 */
export function roundStats({ funding, units, chainAccount, nowSeconds = Math.floor(Date.now() / 1000) }) {
    const accepting = roundAccepting(chainAccount, nowSeconds);
    const view = apartmentRound.roundView({ funding, inventory: units, accepting });
    return {
        accepting, chainStatus: chainAccount?.status ?? null,
        counts: view.counts, reservedDeposits: String(view.reservedDeposits), target: String(view.target), percent: view.percent,
        floors: view.floors,
        units: view.units.map(unit => ({ unitId: unit.unitId, label: unit.label, building: unit.building, level: unit.level,
            depositUsdcAtomic: unit.depositUsdcAtomic, state: unit.state, reason: unit.reason, buyer: unit.buyer }))
    };
}

/** The developer lists every unlisted unit of its round. → { listed, alreadyListed, signatures } */
export async function listApartments({ connection, developerKeypair, account, content, sendAndConfirm = web3.sendAndConfirmTransaction }) {
    const developer = developerKeypair?.publicKey?.toBase58();
    if (!developer || developer !== content?.sponsor) throw new Error('Only the round\'s developer (its sponsor) lists its apartments.');
    const rows = await readRoundInventory(connection, { account, content });
    const unlisted = rows.filter(row => row.status === 'unlisted');
    const held = rows.filter(row => row.status === 'unavailable');
    if (held.length) throw new Error(`apartment(s) ${held.map(row => row.unitId).join(', ')} are held by another round of this developer`);
    const signatures = [];
    let needsEscrow = !(await pledge.readDonationEscrow(connection, account));
    for (let start = 0; start < unlisted.length; start += LISTINGS_PER_TRANSACTION) {
        const instructions = [];
        if (needsEscrow) instructions.push(pledge.buildCreateDonationEscrowIx({ proposal: account, creator: developerKeypair.publicKey }));
        for (const row of unlisted.slice(start, start + LISTINGS_PER_TRANSACTION)) {
            if (row.clearedPosition) instructions.push(pledge.buildClearApartmentRefundIx({ unitAccount: row.account, position: row.clearedPosition }));
            instructions.push(pledge.buildListApartmentIx({ developer: developerKeypair.publicKey, proposal: account, unitKey: row.unitKey, termsHash: row.termsHash, deposit: row.deposit }));
        }
        signatures.push(await send(connection, instructions, developerKeypair, sendAndConfirm));
        needsEscrow = false;
    }
    return { listed: unlisted.length, alreadyListed: rows.length - unlisted.length, signatures };
}

/**
 * The round's lens member qualifies `buyer` for one unit (its PropertyOfferDecision-v2 attestation on
 * Solana), as that member's operator. A repeated request returns the existing attestation.
 * → { address, credential, authority, expiry, payload, reused }
 */
export async function qualifyApartmentBuyer({ serviceUrl, operatorToken, cid, unitId, buyer, fetchImpl = fetch }) {
    if (!operatorToken) throw new Error('qualifying an apartment buyer needs the lens member\'s operator token');
    const url = `${String(serviceUrl).replace(/\/$/, '')}/lens/agreements/${encodeURIComponent(cid)}/apartments/${encodeURIComponent(unitId)}/qualify`;
    const response = await fetchImpl(url, {
        method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', 'x-lens-operator-token': operatorToken },
        body: JSON.stringify({ buyer })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`lens qualification of ${unitId} refused (HTTP ${response.status}): ${body.message || body.error || 'no reason'}`), { status: response.status, code: body.error });
    if (body.payload?.buyer !== buyer || body.payload?.counterpartyQualified !== 1 || !body.address || !body.credential) {
        throw new Error(`the lens qualification for ${unitId} does not name this buyer`);
    }
    return body;
}

/**
 * A standalone apartment offer's lens qualifies the accepting counterparty for these exact parties and
 * payouts (POST /lens/property-offers/:cid/qualify, operator-only); the counterparty then asks for the
 * decision with its signed request (property-offer-signer.js acceptOffer). A repeat returns the existing one.
 */
export async function qualifyOfferCounterparty({ serviceUrl, operatorToken, cid, buyer, seller, payouts, fetchImpl = fetch }) {
    if (!operatorToken) throw new Error('qualifying an offer counterparty needs the lens member\'s operator token');
    const response = await fetchImpl(`${String(serviceUrl).replace(/\/$/, '')}/lens/property-offers/${encodeURIComponent(cid)}/qualify`, {
        method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', 'x-lens-operator-token': operatorToken },
        body: JSON.stringify({ buyer, seller, payouts })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`lens qualification of offer ${cid} refused (HTTP ${response.status}): ${body.message || body.error || 'no reason'}`), { status: response.status, code: body.error });
    if (body.payload?.buyer !== buyer || body.payload?.seller !== seller || body.payload?.counterpartyQualified !== 1) throw new Error(`the lens qualification for offer ${cid} names other parties`);
    return body;
}

/**
 * The qualified buyer pays the unit's deposit into the round's escrow and reserves it, in one
 * transaction. A unit this buyer already holds is a replay. → { signature, position, deposit, replayed }
 */
export async function reserveApartment({ connection, buyerKeypair, account, content, unitId, qualification, sendAndConfirm = web3.sendAndConfirmTransaction }) {
    const buyer = buyerKeypair.publicKey;
    const row = (await readRoundInventory(connection, { account, content })).find(item => item.unitId === unitId);
    if (!row) throw new Error(`unit ${unitId} is not offered by this round`);
    const donationId = pledge.hashBytes(row.unitKey);
    const position = pledge.getDonationPositionPda(pledge.getDonationEscrowPda(account)[0], buyer, donationId)[0].toBase58();
    if (row.status === 'reserved' && row.buyer === buyer.toBase58()) return { signature: null, position, deposit: String(row.deposit), replayed: true };
    if (row.status !== 'available') throw Object.assign(new Error(`unit ${unitId} is ${row.status}, not available`), { code: 'UNIT_UNAVAILABLE' });
    if (qualification?.payload?.offer !== row.account || qualification?.payload?.termsHash !== row.termsHash) {
        throw new Error(`the qualification for ${unitId} names other terms than its listing`);
    }
    const [escrow, previous] = await Promise.all([pledge.readDonationEscrow(connection, account), pledge.readDonationPosition(connection, account, buyer, donationId)]);
    if (previous && (previous.refunded || previous.amount !== BigInt(row.deposit))) throw new Error(`an existing deposit on ${unitId} does not match the unit`);
    const instructions = [];
    if (!escrow) instructions.push(pledge.buildCreateDonationEscrowIx({ proposal: account, creator: buyer }));
    if (!previous) instructions.push(pledge.buildDonateIx({ proposal: account, donor: buyer, amount: row.deposit, donationId }));
    instructions.push(pledge.buildReserveApartmentIx({ developer: content.sponsor, proposal: account, buyer, unitKey: row.unitKey, termsHash: row.termsHash,
        attestation: qualification.address, credential: qualification.credential }));
    const signature = await send(connection, instructions, buyerKeypair, sendAndConfirm);
    return { signature, position, deposit: String(row.deposit), replayed: false };
}
