// Node signer adapters for what a person does with a wallet in the app and the bots' adapters do not
// cover (lifecycle-actions.js, agreement-minter.js): the sponsor's cancel, a lens member's own
// confirmation as the agreement panel's "Confirm as lens member" sends it (decision attestation, attest,
// and execute or release when it completes the lens), taking back a wallet's contributions (with an
// apartment's reservation cleared), an apartment buyer's qualification read from the round's lens, and
// parcel anchors as the parcel panel's Mint creates them. Same codecs and rules as the browser
// (agreement-bridge.js chainActions, AgreementDecisionPlan, SolanaPledgeClient, SolanaParcelClient);
// every step reads the chain first, so a rerun signs nothing twice.
import { createRequire } from 'node:module';
import { decisionSubject } from '../agreements/decisions.js';
import { AGREEMENT_STATUS, readAgreementAccount } from './agreement-minter.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
const bridgeRules = require('../../frontend/js/solana/agreement-bridge.js');
const decisionPlan = require('../../frontend/js/agreement-decision-plan.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
const parcelClient = require('../../frontend/js/solana/parcel-client.js');
agreementClient.configure({ web3 });
pledge.configure({ web3 });
parcelClient.configure({ web3 });

// One legacy transaction holds 1232 bytes.
const MAX_TRANSACTION_BYTES = 1232;

const coded = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

async function send(connection, instructions, signer, sendAndConfirm) {
    const transaction = new web3.Transaction().add(...instructions);
    transaction.feePayer = signer.publicKey;
    return sendAndConfirm(connection, transaction, [signer], { commitment: 'confirmed' });
}

function fits(instructions, feePayer) {
    const probe = new web3.Transaction({ feePayer, recentBlockhash: web3.PublicKey.default.toBase58() }).add(...instructions);
    try { return probe.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= MAX_TRANSACTION_BYTES; } catch { return false; }
}

async function minted(connection, cid, sponsor) {
    const value = await readAgreementAccount(connection, { cid, sponsor });
    if (!value) throw coded(`agreement ${cid} is not minted by ${sponsor}`, 'not-minted');
    return value;
}

/**
 * The sponsor withdraws its agreement before the lens's decision is recorded (`cancel`); the escrow
 * returns to it, and contributors can take theirs back. An agreement already cancelled is a replay.
 */
export async function cancelAgreement({ connection, sponsorKeypair, cid, sendAndConfirm = web3.sendAndConfirmTransaction } = {}) {
    const sponsor = sponsorKeypair.publicKey.toBase58();
    const value = await minted(connection, cid, sponsor);
    if (value.status === AGREEMENT_STATUS.cancelled) return { replayed: true, signature: null, account: value.address, status: value.status };
    if (!bridgeRules.chainActions(value, { wallet: sponsor }).cancel) {
        throw coded(`agreement ${value.address} cannot be cancelled: it is ${value.status}${value.decisionCode === agreementClient.constants.DECISION_SATISFIED ? ' with its decision recorded' : ''}`, 'cannot-cancel');
    }
    const signature = await send(connection, [agreementClient.buildCancelIx({ agreement: value.address, authority: sponsorKeypair.publicKey })], sponsorKeypair, sendAndConfirm);
    return { replayed: false, signature, account: value.address, status: AGREEMENT_STATUS.cancelled, refundedLamports: String(value.escrowLamports) };
}

/**
 * The signer, one of the agreement's lens members, states its decision and the agreement settles as far
 * as it can, as agreement-bridge.js confirmAsMember does: its SAS credential and decision schema when it
 * has none yet, its AgreementDecision-v1 `satisfied` attestation, attest; for a crowdfunding round first
 * confirm_funding once contributions reach the target; then execute, and for a round the USDC release,
 * when this confirmation completes the lens. A counted agreement (owners) is confirmed only once its
 * relayed signed decisions (`receipts`, GET /agreements/:cid/decisions) pass the rule; when the member's
 * key is also a required authority of the rule, this confirmation is that authority's decision.
 * @param agreement the indexed agreement { cid, content, onchain }
 */
export async function confirmAsLensMember({ connection, memberKeypair, agreement, receipts = null, sendAndConfirm = web3.sendAndConfirmTransaction } = {}) {
    const member = memberKeypair.publicKey.toBase58();
    const { cid, content } = agreement;
    const value = await minted(connection, cid, content.sponsor);
    const allowed = bridgeRules.chainActions(value, { wallet: member });
    if (!allowed.member) throw coded(`this key ${member} is not one of the agreement's lens members (${value.lenses.join(', ')})`, 'not-lens-member');
    if (value.lensConfirmed.includes(member)) return { replayed: true, signature: null, account: value.address, decision: value.decision };
    if (!allowed.confirmAsMember) throw coded('This lens member cannot confirm now: the decision is recorded, the lens is complete, or the deadline has passed.', 'member-cannot-confirm');
    // The chain's clock: the program refuses a decision observed after its own time.
    const chainNow = await connection.getBlockTime(await connection.getSlot('confirmed'));
    if (!Number.isSafeInteger(chainNow)) throw coded('The chain\'s time could not be read; try again.', 'chain-time');
    const investors = content.rule?.electorate === 'investors';
    const decided = {
        cid, status: String(value.status).toLowerCase(), deadline: content.deadline || null,
        content: { sponsor: content.sponsor, rule: content.rule },
        onchain: { lenses: value.lenses, decision: value.decisionCode === agreementClient.constants.DECISION_PENDING ? 'pending' : 'satisfied' }
    };
    let fields;
    try {
        if (investors) {
            fields = decisionPlan.ownDecision({ agreement: decided, lensKey: member, decidedAtSeconds: chainNow }).fields;
        } else {
            if (!Array.isArray(receipts)) throw coded('The signed decisions could not be read; try again.', 'decisions-unavailable');
            const subject = decisionSubject({ cid, content, status: decided.status, onchain: agreement.onchain ?? null });
            fields = decisionPlan.countedDecision({ agreement: decided, count: decisionPlan.countDecisions(subject, receipts), lensKey: member, nowSeconds: chainNow, asAuthority: true }).fields;
        }
    } catch (error) {
        if (error?.status && error?.code) throw coded(`You cannot confirm this agreement yet: ${error.message}`, 'member-refused', { reason: error.code, details: error.details });
        throw error;
    }

    const wallet = memberKeypair.publicKey;
    const setup = [];
    const credential = agreementClient.getLensCredentialPda(member);
    if (!(await connection.getAccountInfo(credential, 'confirmed'))) setup.push(agreementClient.buildCreateLensCredentialIx({ payer: wallet, authority: wallet }));
    const schema = agreementClient.getDecisionSchemaPda(credential)[0];
    if (!(await connection.getAccountInfo(schema, 'confirmed'))) setup.push(agreementClient.buildCreateDecisionSchemaIx({ payer: wallet, authority: wallet, credential }));
    const issued = agreementClient.buildCreateDecisionAttestationIx({ payer: wallet, authority: wallet, fields, expiry: chainNow + agreementClient.constants.DECISION_EXPIRY_SECONDS });
    const decisionIxs = [];
    // A retry after an issued but unrecorded decision finds it at its deterministic address.
    if (!(await connection.getAccountInfo(new web3.PublicKey(issued.attestation), 'confirmed'))) decisionIxs.push(issued.instruction);
    let fundingMet = !(value.requiredFunding > 0n) || value.fundingMet;
    let escrow = null;
    if (investors) {
        escrow = await pledge.readDonationEscrow(connection, value.address);
        if (!fundingMet && escrow && bridgeRules.fundingCredited(escrow) >= value.requiredFunding) {
            decisionIxs.unshift(agreementClient.buildConfirmFundingIx({ agreement: value.address, escrow: pledge.getDonationEscrowPda(value.address)[0], vault: escrow.vault }));
            fundingMet = true;
        }
    }
    decisionIxs.push(agreementClient.buildAttestIx({ agreement: value.address, attestation: issued.attestation, credential: issued.credential }));
    const executes = value.lensConfirmed.length + 1 >= value.lensThreshold && fundingMet && value.escrowLamports >= value.requiredLamports;
    if (executes) decisionIxs.push(agreementClient.buildExecuteIx({ agreement: value.address, payout: value.payout }));
    const releases = executes && investors && !!escrow && !escrow.released;
    if (releases) decisionIxs.push(pledge.buildReleaseDonationsIx({ proposal: value.address, releaser: wallet, beneficiary: escrow.beneficiary }));
    const signatures = [];
    if (setup.length && !fits([...setup, ...decisionIxs], wallet)) signatures.push(await send(connection, setup, memberKeypair, sendAndConfirm));
    else decisionIxs.unshift(...setup);
    signatures.push(await send(connection, decisionIxs, memberKeypair, sendAndConfirm));
    return { replayed: false, signature: signatures.at(-1), signatures, account: value.address, attestation: issued.attestation, executed: executes, released: releases };
}

/**
 * Take back every contribution this wallet still has in a cancelled or expired agreement's escrow, as the
 * agreement panel's refund does: a reserved apartment's listing is cleared in the same transaction. A
 * crowdfunding round refunds at most AgreementBridge.MAX_REFUNDS_PER_TX positions per call.
 */
export async function refundContributions({ connection, donorKeypair, agreement, sendAndConfirm = web3.sendAndConfirmTransaction } = {}) {
    const { cid, content } = agreement;
    const value = await minted(connection, cid, content.sponsor);
    if (![AGREEMENT_STATUS.cancelled, AGREEMENT_STATUS.expired].includes(value.status)) {
        throw coded(`agreement ${value.address} is ${value.status}; contributions come back only once it is cancelled or expired`, 'not-refundable');
    }
    const owner = donorKeypair.publicKey.toBase58();
    const apartments = content.funding?.apartments;
    const positions = apartments
        ? await pledge.apartmentPositions(connection, value.address, owner, content.funding, agreementRecord)
        : await pledge.listDonationPositions(connection, value.address, owner);
    const open = positions.filter(row => !row.refunded);
    if (!open.length) return { replayed: true, signature: null, account: value.address, refunded: 0, remaining: 0 };
    const batch = content.rule?.electorate === 'investors' ? open.slice(0, bridgeRules.MAX_REFUNDS_PER_TX) : open;
    const inventory = apartments ? await pledge.readApartmentInventory(connection, value.address, content.sponsor, content.funding, agreementRecord) : [];
    const instructions = [];
    for (const row of batch) {
        instructions.push(pledge.buildRefundDonationIx({ proposal: value.address, donor: donorKeypair.publicKey, donationId: row.donationId }));
        const unit = inventory.find(item => item.status === 'reserved' && item.position === row.address);
        if (unit) instructions.push(pledge.buildClearApartmentRefundIx({ unitAccount: unit.account, position: row.address }));
    }
    const signature = await send(connection, instructions, donorKeypair, sendAndConfirm);
    return { replayed: false, signature, account: value.address, refunded: batch.length, remaining: open.length - batch.length };
}

/**
 * A buyer's qualification for one apartment of a round, from the members of the round's lens in lens
 * order (GET <service>/lens/agreements/:cid/apartments/:unitId/qualification?buyer=), checked as the
 * agreement bridge checks it. `members` are the directory rows { key, serviceUrl }.
 * → { address, credential, payload, ... } or throws code qualification-pending
 */
export async function apartmentQualification({ cid, sponsor, lenses, members, offer, buyer, fetchImpl = fetch, nowSeconds = Math.floor(Date.now() / 1000) }) {
    const services = lenses.map(key => ({ key, service: members.find(member => member.key === key)?.serviceUrl })).filter(member => member.service);
    if (!services.length) throw coded('The round\'s lens has no qualification service.', 'lens-unavailable');
    let pending = null;
    let last = null;
    for (const { key, service } of services) {
        const url = new URL(`${service.replace(/\/$/, '')}/lens/agreements/${encodeURIComponent(cid)}/apartments/${encodeURIComponent(offer.unitId)}/qualification`);
        url.searchParams.set('buyer', buyer);
        try {
            const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(15000) });
            const proof = await response.json();
            if (!response.ok) {
                if (proof.error === 'qualification_pending') { pending = coded('The developer\'s lens has yet to qualify this wallet for this apartment.', 'qualification-pending'); continue; }
                throw coded(proof.message || `Lens HTTP ${response.status}`, 'lens-unavailable');
            }
            const fields = proof.payload;
            if (proof.authority !== key || fields?.counterpartyQualified !== 1 || fields.cid !== cid || fields.offer !== offer.account || fields.buyer !== buyer
                || fields.seller !== sponsor || fields.termsHash !== offer.termsHash || !proof.address || !proof.credential
                || !Number.isSafeInteger(proof.expiry) || proof.expiry <= nowSeconds) {
                throw coded('The lens qualification does not match this buyer and apartment.', 'invalid-qualification');
            }
            return proof;
        } catch (error) {
            last = error;
        }
    }
    throw pending || last;
}

/**
 * Anchor parcels on parcel_nft as the parcel panel's Mint does, one transaction each: an ownerless PDA
 * ["parcel", anchorId] holding the metadata URI; the signer only pays rent. An existing anchor is
 * reported, not minted again, and its metadata is never stored. `parcels` are [{ anchorId, metadataUri }],
 * metadataUri a string or an async function giving one (called only for an anchor about to be minted).
 */
export async function anchorParcels({ connection, payerKeypair, parcels, programId = parcelClient.constants.PARCEL_NFT_PROGRAM_ID, sendAndConfirm = web3.sendAndConfirmTransaction } = {}) {
    const results = [];
    for (const { anchorId, metadataUri: source } of parcels) {
        const [anchor] = parcelClient.getParcelPda(anchorId, programId);
        if (await connection.getAccountInfo(anchor, 'confirmed')) {
            results.push({ anchorId, anchor: anchor.toBase58(), alreadyAnchored: true, signature: null });
            continue;
        }
        const metadataUri = typeof source === 'function' ? await source() : source;
        if (typeof metadataUri !== 'string' || !metadataUri.trim()) throw coded(`parcel ${anchorId} has no metadata URI; nothing signed`, 'metadata-required');
        const { instruction } = parcelClient.buildMintParcelIx({ parcelId: anchorId, metadataUri, payer: payerKeypair.publicKey, programId });
        const signature = await send(connection, [instruction], payerKeypair, sendAndConfirm);
        results.push({ anchorId, anchor: anchor.toBase58(), alreadyAnchored: false, signature });
    }
    return { parcels: results };
}
