// Shared Node signer adapters for what follows an agreement's mint: its market (resolve, claim),
// donations and soft pledges (refund, revoke, release, fulfil, void), the recipe-bound external
// markets, and the proposer's settlement of its own agreements (a reached contribution target, its owner
// approval, the lens decision, attest and execute, or expire after the deadline; then resolve and claim). The subject of every
// market, pledge book and donation escrow is the agreement's chain account (PDA(sponsor, CID),
// agreement-minter.js). Browser wallets, MCP agents and deterministic runners use the same instruction
// codecs; these functions add only read-before-write idempotence and transaction submission.
import { createRequire } from 'node:module';
import { donationIdBytes } from './donor.js';
import { AGREEMENT_STATUS, confirmAgreementFunding, executeAgreement, expireAgreement, readAgreementAccount, recordAgreementDecision } from './agreement-minter.js';
import { readAgreementMarket, readAgreementMarkets } from './bettor.js';
import { confirmAsLensMember } from './chain-actions.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const supportClient = require('../../frontend/js/solana/pledge-client.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
const lmsrClient = require('../../frontend/js/solana/lmsr-client.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
const bettingContract = require('../../frontend/js/bets/betting-contract.js');
supportClient.configure({ web3 });
marketClient.configure({ web3 });
lmsrClient.configure({ web3 });
agreementClient.configure({ web3 });

// Signers are de-duplicated by key; the first pays fees.
async function sendInstruction(connection, instruction, signerOrSigners, sendAndConfirm) {
    const signers = [];
    for (const signer of [signerOrSigners].flat()) {
        if (signer && !signers.some(existing => existing.publicKey.equals(signer.publicKey))) signers.push(signer);
    }
    const transaction = new web3.Transaction().add(...(Array.isArray(instruction) ? instruction : [instruction]));
    transaction.feePayer = signers[0].publicKey;
    return sendAndConfirm(connection, transaction, signers, { commitment: 'confirmed' });
}

/**
 * The status word of an agreement account's data ('Active' | 'Executed' | 'Cancelled' | 'Expired'),
 * for batched reads; null when the data is not an Agreement account.
 */
export function agreementStatusOf(data) {
    const state = agreementClient.readAgreement(data instanceof Uint8Array ? data : Uint8Array.from(data || []));
    return state ? state.status : null;
}

async function requireExecuted(connection, subject) {
    const state = await readAgreementAccount(connection, { account: subject });
    if (!state) throw new Error(`agreement account ${subject} does not exist`);
    if (state.status !== AGREEMENT_STATUS.executed) throw new Error(`agreement ${subject} is ${state.status}, not Executed`);
}

export async function refundDonation({
    connection, donorKeypair, subject, operationId,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!donorKeypair?.publicKey) throw new Error('donorKeypair is required');
    const donationId = donationIdBytes(operationId);
    const position = await supportClient.readDonationPosition(connection, subject, donorKeypair.publicKey, donationId);
    if (!position) throw new Error('donation position does not exist');
    if (position.owner !== donorKeypair.publicKey.toBase58()) throw new Error('signer is not the donation owner');
    if (position.refunded) return { replayed: true, signature: null, refunded: true };
    const signature = await sendInstruction(connection, supportClient.buildRefundDonationIx({
        proposal: subject, donor: donorKeypair.publicKey, donationId
    }), donorKeypair, sendAndConfirm);
    return { replayed: false, signature, refunded: true };
}

export async function revokePledge({
    connection, pledgerKeypair, subject,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!pledgerKeypair?.publicKey) throw new Error('pledgerKeypair is required');
    const commitment = await supportClient.readPledgeCommitment(connection, subject, pledgerKeypair.publicKey);
    if (!commitment) throw new Error('pledge commitment does not exist');
    if (commitment.owner !== pledgerKeypair.publicKey.toBase58()) throw new Error('signer is not the pledge owner');
    if (commitment.status === supportClient.constants.PLEDGE_REVOKED) return { replayed: true, signature: null, revoked: true };
    if (commitment.status !== supportClient.constants.PLEDGE_ACTIVE) throw new Error(`pledge is not active (status ${commitment.status})`);
    const signature = await sendInstruction(connection, supportClient.buildRevokePledgeIx({
        proposal: subject, pledger: pledgerKeypair.publicKey
    }), pledgerKeypair, sendAndConfirm);
    return { replayed: false, signature, revoked: true };
}

export async function releaseDonations({
    connection, releaserKeypair, subject,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!releaserKeypair?.publicKey) throw new Error('releaserKeypair is required');
    const escrow = await supportClient.readDonationEscrow(connection, subject);
    if (!escrow) throw new Error('donation escrow does not exist');
    if (escrow.released) return { replayed: true, signature: null, released: true };
    await requireExecuted(connection, subject);
    const signature = await sendInstruction(connection, supportClient.buildReleaseDonationsIx({
        proposal: subject, releaser: releaserKeypair.publicKey, beneficiary: escrow.beneficiary
    }), releaserKeypair, sendAndConfirm);
    return { replayed: false, signature, released: true };
}

/**
 * Record that the agreement's contribution target is met (`confirm_funding`, permissionless): the
 * program reads the agreement's donation escrow and vault itself, so no lens is involved. An agreement
 * without a target, or with it confirmed, is a replay.
 */
export async function confirmFunding({
    connection, payerKeypair, subject,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    const escrowAddress = supportClient.getDonationEscrowPda(subject)[0].toBase58();
    const escrow = await supportClient.readDonationEscrow(connection, subject);
    return confirmAgreementFunding({ connection, payerKeypair, account: subject, escrowAddress, escrow, sendAndConfirm });
}

// Contributions a donation escrow credits toward a target: donated less refunded (0n without one).
const creditedOf = escrow => (escrow ? BigInt(escrow.totalDonated) - BigInt(escrow.totalRefunded) : 0n);

export async function fulfillPledge({
    connection, pledgerKeypair, subject,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!pledgerKeypair?.publicKey) throw new Error('pledgerKeypair is required');
    const [book, commitment] = await Promise.all([
        supportClient.readPledgeBook(connection, subject),
        supportClient.readPledgeCommitment(connection, subject, pledgerKeypair.publicKey)
    ]);
    if (!book) throw new Error('pledge book does not exist');
    if (!commitment) throw new Error('pledge commitment does not exist');
    if (commitment.owner !== pledgerKeypair.publicKey.toBase58()) throw new Error('signer is not the pledge owner');
    if (commitment.status === supportClient.constants.PLEDGE_FULFILLED) return { replayed: true, signature: null, fulfilled: true };
    if (commitment.status !== supportClient.constants.PLEDGE_ACTIVE) throw new Error(`pledge is not active (status ${commitment.status})`);
    await requireExecuted(connection, subject);
    const signature = await sendInstruction(connection, supportClient.buildFulfillPledgeIx({
        proposal: subject, pledger: pledgerKeypair.publicKey, beneficiary: book.beneficiary
    }), pledgerKeypair, sendAndConfirm);
    return { replayed: false, signature, fulfilled: true };
}

export async function voidPledge({
    connection, feePayerKeypair, subject, pledger,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!feePayerKeypair?.publicKey) throw new Error('feePayerKeypair is required');
    const pledgerKey = new web3.PublicKey(pledger || feePayerKeypair.publicKey);
    const commitment = await supportClient.readPledgeCommitment(connection, subject, pledgerKey);
    if (!commitment) throw new Error('pledge commitment does not exist');
    if (commitment.status === supportClient.constants.PLEDGE_VOIDED) return { replayed: true, signature: null, voided: true };
    if (commitment.status !== supportClient.constants.PLEDGE_ACTIVE) throw new Error(`pledge is not active (status ${commitment.status})`);
    const signature = await sendInstruction(connection, supportClient.buildVoidPledgeIx({
        proposal: subject, pledger: pledgerKey
    }), feePayerKeypair, sendAndConfirm);
    return { replayed: false, signature, voided: true };
}

export async function resolveAgreementMarket({
    connection, resolverKeypair, subject, marketAddress, evidence = [],
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!resolverKeypair?.publicKey) throw new Error('resolverKeypair is required');
    const context = await readAgreementMarket(connection, subject, { marketAddress });
    const market = context.market;
    if (!market) throw Object.assign(new Error('Selected market was not found.'), { code: 'MARKET_NOT_OPEN' });
    const outcomeName = value => ['NO', 'YES', 'VOID'][Number(value)];
    if (market.resolved) return { replayed: true, signature: null, outcome: outcomeName(market.outcome) };
    if (!Array.isArray(evidence) || evidence.length > 2 || (market.kind === 0 && evidence.length)) throw new Error('Invalid evidence accounts for this market.');
    const args = { market: context.address, proposal: subject, schema: market.schema, evidence };
    let instruction;
    if (!market.proposed) instruction = lmsrClient.buildResolveLmsrIx(args);
    else {
        const slot = await context.connection.getSlot('confirmed');
        const time = await context.connection.getBlockTime(slot);
        if (!Number.isSafeInteger(time)) throw new Error('Devnet block time is unavailable.');
        if (time > Number(market.challengeEndsAt)) instruction = lmsrClient.buildFinalizeLmsrIx(args);
        else {
            if (evidence.length !== 1) throw new Error('Challenging an outcome requires one qualifying attestation.');
            instruction = lmsrClient.buildChallengeLmsrIx({ ...args, evidence: evidence[0] });
        }
    }
    const signature = await sendInstruction(context.connection, instruction, resolverKeypair, sendAndConfirm);
    const updated = (await readAgreementMarket(context.connection, subject, { marketAddress: context.address })).market;
    return { replayed: false, signature, outcome: updated?.resolved ? outcomeName(updated.outcome) : null,
        ...(updated?.proposed ? { proposedOutcome: outcomeName(updated.outcome), challengeEndsAt: Number(updated.challengeEndsAt) } : {}) };
}

export async function claimAgreementMarket({
    connection, claimerKeypair, subject, marketAddress, side,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!claimerKeypair?.publicKey) throw new Error('claimerKeypair is required');
    const sideText = String(side || '').toLowerCase();
    if (!['yes', 'no'].includes(sideText)) throw new Error('side must be yes or no');
    const normalizedSide = sideText === 'yes' ? lmsrClient.constants.SIDE_YES : lmsrClient.constants.SIDE_NO;
    const context = await readAgreementMarket(connection, subject, { marketAddress });
    const market = context.market;
    if (!market?.resolved) throw new Error('agreement market is not resolved');
    const position = await lmsrClient.readPosition(context.connection, context.address, claimerKeypair.publicKey, normalizedSide);
    if (!position) throw new Error('market position does not exist');
    if (position.claimed) return { replayed: true, signature: null, claimed: true };
    const outcome = ['no', 'yes', 'void'][Number(market.outcome)];
    if (bettingContract.payout(sideText, position.amount, outcome) <= 0n) throw new Error('This position has no claimable payout.');
    const ata = lmsrClient.getAssociatedTokenAddress(claimerKeypair.publicKey, market.stakeMint);
    const instructions = [];
    if (!await context.connection.getAccountInfo(ata, 'confirmed')) {
        instructions.push(splToken.createAssociatedTokenAccountIdempotentInstruction(
            claimerKeypair.publicKey, ata, claimerKeypair.publicKey, new web3.PublicKey(market.stakeMint)));
    }
    instructions.push(lmsrClient.buildClaimLmsrIx({ market: context.address, stakeMint: market.stakeMint,
        owner: claimerKeypair.publicKey, side: normalizedSide }));
    const signature = await sendInstruction(context.connection, instructions, claimerKeypair, sendAndConfirm);
    return { replayed: false, signature, claimed: true };
}

// What reclaim_seed would pay the creator now (lmsr_market.rs handle_reclaim_seed): the vault less what
// the unclaimed winning positions are still owed. 0n for an open market.
export function reclaimableSeed(market, vaultAtomic) {
    if (!market?.resolved || typeof vaultAtomic !== 'bigint') return 0n;
    const qYes = BigInt(market.qYes), qNo = BigInt(market.qNo), paidOut = BigInt(market.paidOut ?? 0n);
    const outcome = Number(market.outcome);
    const obligation = outcome === lmsrClient.constants.SIDE_YES ? qYes
        : outcome === lmsrClient.constants.SIDE_NO ? qNo : qYes / 2n + qNo / 2n;
    const owed = obligation > paidOut ? obligation - paidOut : 0n;
    return vaultAtomic > owed ? vaultAtomic - owed : 0n;
}

async function vaultAtomic(connection, market) {
    const balance = await connection.getTokenAccountBalance(new web3.PublicKey(market.vault), 'confirmed');
    return BigInt(balance.value.amount);
}

/** The market's creator takes back what its resolved market's payouts leave of the LMSR seed. */
export async function reclaimAgreementMarketSeed({
    connection, creatorKeypair, subject, marketAddress,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!creatorKeypair?.publicKey) throw new Error('creatorKeypair is required');
    const context = await readAgreementMarket(connection, subject, { marketAddress });
    const market = context.market;
    if (!market?.resolved) throw new Error('agreement market is not resolved');
    if (market.creator !== creatorKeypair.publicKey.toBase58()) throw new Error('signer is not the market creator');
    const amount = reclaimableSeed(market, await vaultAtomic(context.connection, market));
    if (amount <= 0n) return { replayed: true, signature: null, amount: '0' };
    const ata = lmsrClient.getAssociatedTokenAddress(creatorKeypair.publicKey, market.stakeMint);
    const instructions = [];
    if (!await context.connection.getAccountInfo(ata, 'confirmed')) {
        instructions.push(splToken.createAssociatedTokenAccountIdempotentInstruction(
            creatorKeypair.publicKey, ata, creatorKeypair.publicKey, new web3.PublicKey(market.stakeMint)));
    }
    instructions.push(lmsrClient.buildReclaimSeedIx({ market: context.address, creator: creatorKeypair.publicKey, stakeMint: market.stakeMint }));
    const signature = await sendInstruction(context.connection, instructions, creatorKeypair, sendAndConfirm);
    return { replayed: false, signature, amount: String(amount) };
}

export async function resolveExternalMarket({
    connection, resolverKeypair, recipeHash, attestation,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!resolverKeypair?.publicKey) throw new Error('resolverKeypair is required');
    if (!recipeHash || !attestation) throw new Error('recipeHash and attestation are required');
    const market = await marketClient.readExternalMarket(connection, recipeHash);
    if (!market) throw new Error('external market does not exist');
    if (market.resolved) {
        return { replayed: true, signature: null, outcome: market.outcome === marketClient.constants.SIDE_YES ? 'YES' : 'NO' };
    }
    const signature = await sendInstruction(connection, marketClient.buildResolveExternalIx({
        recipeHash, attestation, schema: market.schema
    }), resolverKeypair, sendAndConfirm);
    const resolved = await marketClient.readExternalMarket(connection, recipeHash);
    return {
        replayed: false, signature,
        outcome: resolved?.outcome === marketClient.constants.SIDE_YES ? 'YES' : 'NO',
        evidence: resolved?.evidence || null,
        evidenceHash: resolved?.evidenceHash ? `sha256:${resolved.evidenceHash}` : null
    };
}

export async function claimExternalMarket({
    connection, claimerKeypair, recipeHash, side,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!claimerKeypair?.publicKey) throw new Error('claimerKeypair is required');
    const sideText = String(side || '').toLowerCase();
    if (!['yes', 'no'].includes(sideText)) throw new Error('side must be yes or no');
    const normalizedSide = sideText === 'yes' ? marketClient.constants.SIDE_YES : marketClient.constants.SIDE_NO;
    const market = await marketClient.readExternalMarket(connection, recipeHash);
    if (!market?.resolved) throw new Error('external market is not resolved');
    const [marketAccount] = marketClient.getExternalMarketPda(recipeHash);
    const [positionAccount] = marketClient.getPositionPda(marketAccount, claimerKeypair.publicKey, normalizedSide);
    const positionInfo = await connection.getAccountInfo(positionAccount, 'confirmed');
    if (!positionInfo?.data) throw new Error('external market position does not exist');
    const position = marketClient.decodePosition(positionInfo.data);
    if (position.owner !== claimerKeypair.publicKey.toBase58()) throw new Error('signer is not the position owner');
    if (position.claimed) return { replayed: true, signature: null, claimed: true };
    const signature = await sendInstruction(connection, marketClient.buildClaimExternalIx({
        recipeHash, stakeMint: market.stakeMint, claimer: claimerKeypair.publicKey, side: normalizedSide
    }), claimerKeypair, sendAndConfirm);
    return { replayed: false, signature, claimed: true };
}

// ---- settlement: the proposer finishing its own agreements ------------------------------------------
// Chain-read half and signing half of the proposer's settlement phase (selection is pure, in
// run-policy.js planSettlements). Every step is derived from the agreement, market and position accounts
// as they are now, never from a checkpoint flag, so a rerun repeats nothing. A contribution target its
// donation escrow has reached is confirmed by anyone (confirm-funding). A binding owners' agreement whose
// sole owner is the proposer is decided by the proposer itself: its approval receipt (decide), the
// AgreementDecision-v1 of the lens member this runner operates (lens), recorded on the account (attest);
// other members' confirmations are theirs to record. Once the lens threshold and any target are met,
// `execute` releases the escrow to the payout and the market resolves YES. One that never got there
// expires after its deadline (the escrow returns to the sponsor) and the market resolves NO.

// Steps that sign a chain transaction; decide (a signed message, relayed) and lens (the member's own
// transaction) cost the proposer none. confirm-member is signed by a lens member's own wallet.
export const SIGNED_SETTLEMENT_STEPS = Object.freeze(['confirm-funding', 'confirm-member', 'attest', 'execute', 'release-donations', 'expire', 'resolve', 'claim', 'reclaim']);

const SETTLEMENT_READERS = {
    readAgreement: (connection, account) => readAgreementAccount(connection, { account }),
    readMarket: async (connection, account) => (await readAgreementMarket(connection, account)).market,
    readPosition: async (connection, account, owner) => {
        const context = await readAgreementMarket(connection, account);
        return context.market ? lmsrClient.readPosition(context.connection, context.address, owner, lmsrClient.constants.SIDE_YES) : null;
    },
    readDonation: (connection, account) => supportClient.readDonationEscrow(connection, account),
    readVault: (connection, market) => vaultAtomic(connection, market)
};

const OUTCOME_OF = Object.freeze({ 0: 'no', 1: 'yes', 2: 'void' });

// Each winning share pays one unit; a VOID market pays half per share on either side.
function yesPayout(market, position, outcome) {
    if (!market || !position || position.claimed) return 0n;
    const result = market.resolved ? OUTCOME_OF[market.outcome] : String(outcome || '').toLowerCase();
    if (!['yes', 'no', 'void'].includes(result)) return 0n;
    return bettingContract.payout('yes', position.amount, result);
}

/**
 * Read-only: which settlement steps one of the proposer's own minted agreements still needs, in order.
 * @param agreement { cid, account, deadline, soleOwner (the proposer is the only owner of every input
 *   parcel), content?, pickId?, sourceRunId?, sourceDay? }
 * @param lensKey the lens member this runner operates (asks for decisions), or null
 * @returns {Promise<object>} the agreement with `state` (decidable | decided | awaiting-owners |
 *   lens-not-operated | awaiting-lens | awaiting-contributions | awaiting-funds | due | executed |
 *   cancelled | expired | closed | missing | foreign | retired), `outcome` (YES | NO | null) and `steps`
 */
export async function inspectSettlement({ connection, owner, agreement, lensKey = null, memberKeys = [], nowSeconds = Math.floor(Date.now() / 1000), readers = {} } = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!owner) throw new Error('owner is required');
    // Retired experimental content cannot be decided by the current contract. Keep its chain
    // state untouched; the runner records a terminal automation skip, not an execution.
    if (agreement.retired) return { ...agreement, state: 'retired', outcome: null, steps: [] };
    const read = { ...SETTLEMENT_READERS, ...readers };
    const ownerKey = new web3.PublicKey(owner);
    let state;
    try {
        state = await read.readAgreement(connection, agreement.account);
    } catch (err) {
        // Minted under an agreement program the app no longer reads (the 2026-11-25 redeploy moved it
        // to new addresses): the current contract treats it as unminted, so automation records it as
        // retired and stops reading it, instead of failing every run on it.
        if (err?.code === 'agreement-wrong-program') return { ...agreement, state: 'retired', outcome: null, steps: [] };
        throw err;
    }
    if (!state) return { ...agreement, state: 'missing', outcome: null, steps: [] };
    if (state.authority !== ownerKey.toBase58()) return { ...agreement, state: 'foreign', outcome: null, steps: [] };
    const active = state.status === AGREEMENT_STATUS.active;
    const due = active && agreementClient.deadlinePassed(state, nowSeconds);
    const pending = state.decisionCode === agreementClient.constants.DECISION_PENDING;
    const funded = state.escrowLamports >= state.requiredLamports;
    const base = { ...agreement, escrowLamports: String(state.escrowLamports), requiredLamports: String(state.requiredLamports), decision: state.decision };
    let label;
    let outcome;
    const steps = [];
    const investorFunding = agreement.content?.rule?.electorate === 'investors';
    if (active && !due && pending) {
        const lensOpen = state.lensConfirmed.length < state.lensThreshold;
        const fundingOpen = state.requiredFunding > 0n && !state.fundingMet;
        const credited = fundingOpen ? creditedOf(await read.readDonation(connection, agreement.account)) : null;
        const fundingReady = !fundingOpen || credited >= state.requiredFunding;
        const lensState = { lenses: state.lenses, lensThreshold: state.lensThreshold, lensConfirmed: state.lensConfirmed };
        // This runner can add its own lens member's confirmation; the lens decides an owners' agreement,
        // and on a crowdfunding round the lens attests only conditions it is asked to, never on its own.
        const operated = lensOpen && !investorFunding && !!lensKey && state.lenses.includes(lensKey) && !state.lensConfirmed.includes(lensKey);
        // A round's lens member whose wallet this runner holds and that confirms funded rounds
        // (personas.json service.confirmsFundedRounds) states its own decision once the target is reached.
        const member = lensOpen && investorFunding && fundingReady
            ? (memberKeys || []).find(key => state.lenses.includes(key) && !state.lensConfirmed.includes(key)) ?? null : null;
        if (lensOpen && !investorFunding && !agreement.soleOwner) return { ...base, ...lensState, state: 'awaiting-owners', outcome: null, steps: [] };
        if (lensOpen && !investorFunding && !operated) return { ...base, ...lensState, state: 'lens-not-operated', outcome: null, steps: [] };
        // The member's confirmation (chain-actions.js confirmAsLensMember) also confirms the target and,
        // when it completes the lens, executes and releases, all in its one transaction.
        if (member) { steps.push('confirm-member'); base.member = member; }
        else if (fundingOpen && fundingReady) steps.push('confirm-funding');
        if (operated) steps.push('decide', 'lens', 'attest');
        const lensWillMeet = !lensOpen || ((operated || Boolean(member)) && state.lensConfirmed.length + 1 >= state.lensThreshold);
        if (!fundingReady) {
            return { ...base, ...lensState, state: 'awaiting-contributions', outcome: null, steps,
                note: `contributions credit ${credited} of the ${state.requiredFunding} target` };
        }
        if (!lensWillMeet) return { ...base, ...lensState, state: 'awaiting-lens', outcome: null, steps, note: 'other lens members have yet to confirm' };
    }
    if (active && !due) {
        if (!funded) return { ...base, state: pending ? 'decidable' : 'awaiting-funds', outcome: null, steps, note: 'the escrow lacks what execution requires' };
        if (!steps.includes('confirm-member')) steps.push('execute');
        label = pending ? 'decidable' : 'decided';
        outcome = 'YES';
    } else if (due) {
        steps.push('expire');
        label = 'due';
        outcome = 'NO';
    } else {
        label = state.status.toLowerCase();
        if (state.status === AGREEMENT_STATUS.executed) outcome = state.executedAt <= state.deadline ? 'YES' : 'NO';
        else outcome = 'NO';
    }
    // Once an investor agreement executes, the existing permissionless release instruction moves
    // the exact donation-vault balance to the sponsor.  No owner approval is involved.
    if (investorFunding && !steps.includes('confirm-member') && (state.status === AGREEMENT_STATUS.executed || (active && !due && funded))) {
        const donation = await read.readDonation(connection, agreement.account);
        if (donation && !donation.released) steps.push('release-donations');
    }
    let market;
    let position;
    if (!readers.readMarket && !readers.readPosition) {
        // Reuse the already-decoded agreement account and read the market once (instead of 3 agreement + 2 market RPCs).
        const context = (await readAgreementMarkets(connection, [agreement.account], { preloadedAgreements: new Map([[state.address, state]]) })).get(agreement.account);
        market = context?.market ?? null;
        position = market ? await lmsrClient.readPosition(context.connection, context.address, ownerKey, lmsrClient.constants.SIDE_YES) : null;
    } else {
        [market, position] = await Promise.all([
            read.readMarket(connection, agreement.account),
            read.readPosition(connection, agreement.account, ownerKey)
        ]);
    }
    const payout = yesPayout(market, position, outcome);
    if (market && !market.resolved) steps.push('resolve');
    if (payout > 0n) steps.push('claim');
    // The proposer opened this market (it is the agreement's authority): once resolved, it takes back
    // what the payouts leave of its seed, so a market costs cents rather than b·ln2 (2026-11-12).
    if (market && market.creator === ownerKey.toBase58()
        && (!market.resolved || reclaimableSeed(market, await read.readVault(connection, market)) > 0n)) steps.push('reclaim');
    return {
        ...base,
        state: steps.length ? label : 'closed',
        outcome,
        steps,
        market: market ? { resolved: market.resolved, qYes: String(market.qYes), qNo: String(market.qNo), b: String(market.b), outcome: OUTCOME_OF[market.outcome] ?? null } : null,
        position: position ? { amount: String(position.amount), claimed: position.claimed } : null,
        expectedPayout: String(payout),
        ...(position && !position.claimed && payout === 0n ? { note: 'The YES shares have no payout for this outcome.' } : {})
    };
}

/**
 * Take the outstanding steps in order — confirm-funding → decide → lens → attest → execute, or expire — then resolve →
 * claim, each through `perform` (the action engine, so it lands in the activity feed) and each followed by
 * `checkpoint(record)`. `decide()` and `askLens()` are the off-chain steps the caller provides (the owner's
 * relayed approval, lens-approval-client.js); the claim is re-derived from the market after resolution.
 */
export async function executeSettlement({
    connection, ownerKeypair, item, perform, checkpoint, decide, askLens, memberSigner = null, record = {}, readers = {}, adapters = {},
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair is required');
    if (typeof perform !== 'function' || typeof checkpoint !== 'function') throw new Error('perform and checkpoint are required');
    const read = { ...SETTLEMENT_READERS, ...readers };
    const act = { confirmFunding, recordAgreementDecision, executeAgreement, expireAgreement, releaseDonations, resolveAgreementMarket, claimAgreementMarket, reclaimAgreementMarketSeed, confirmAsLensMember, ...adapters };
    const subject = item.account;
    const current = { ...record, cid: item.cid, account: subject, pickId: item.pickId ?? null, sourceRunId: item.sourceRunId ?? null, sourceDay: item.sourceDay ?? null };
    const has = step => item.steps.includes(step);
    if (has('confirm-funding')) {
        current.fundingConfirmation = await perform({ type: 'confirm-funding', agreementCid: item.cid }, () => act.confirmFunding({
            connection, payerKeypair: ownerKeypair, subject, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    if (has('decide')) {
        if (typeof decide !== 'function') throw new Error('a decide step needs decide()');
        current.approval = await perform({ type: 'decide', agreementCid: item.cid }, () => decide(item));
        await checkpoint({ ...current });
    }
    if (has('lens')) {
        if (typeof askLens !== 'function') throw new Error('a lens step needs askLens()');
        const issued = await perform({ type: 'lens-decision', agreementCid: item.cid }, () => askLens(item));
        current.lensDecision = { address: issued.address, credential: issued.credential, reused: issued.reused === true, issuedAt: issued.issuedAt ?? null, transactionSignature: issued.transactionSignature ?? null };
        await checkpoint({ ...current });
    }
    if (has('confirm-member')) {
        const memberKeypair = typeof memberSigner === 'function' ? memberSigner(item.member) : null;
        if (!memberKeypair) throw new Error(`a confirm-member step needs lens member ${item.member}'s wallet`);
        current.memberConfirmation = await perform({ type: 'lens-decision', agreementCid: item.cid, member: item.member }, () => act.confirmAsLensMember({
            connection, memberKeypair, agreement: { cid: item.cid, content: item.content }, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    if (has('attest')) {
        if (!current.lensDecision?.address) throw new Error(`no lens decision to record on ${subject}`);
        current.attest = await perform({ type: 'attest', agreementCid: item.cid }, () => act.recordAgreementDecision({
            connection, payerKeypair: ownerKeypair, account: subject, attestation: current.lensDecision.address, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    if (has('execute')) {
        current.execution = await perform({ type: 'execute', agreementCid: item.cid }, () => act.executeAgreement({
            connection, payerKeypair: ownerKeypair, account: subject, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    if (has('release-donations')) {
        current.donationRelease = await perform({ type: 'release-donations', agreementCid: item.cid }, () => act.releaseDonations({
            connection, releaserKeypair: ownerKeypair, subject, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    if (has('expire')) {
        current.expiry = await perform({ type: 'expire', agreementCid: item.cid }, () => act.expireAgreement({
            connection, signerKeypair: ownerKeypair, account: subject, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    if (has('resolve')) {
        current.resolution = await perform({ type: 'resolve', agreementCid: item.cid }, () => act.resolveAgreementMarket({
            connection, resolverKeypair: ownerKeypair, subject, sendAndConfirm
        }));
        await checkpoint({ ...current });
        if (item.outcome && current.resolution?.outcome !== item.outcome) {
            throw new Error(`market resolved ${current.resolution?.outcome}; expected ${item.outcome}`);
        }
    }
    if (has('claim')) {
        let market;
        let position;
        if (!readers.readMarket && !readers.readPosition) {
            const context = await readAgreementMarket(connection, subject);
            market = context?.market ?? null;
            position = market ? await lmsrClient.readPosition(context.connection, context.address, ownerKeypair.publicKey, lmsrClient.constants.SIDE_YES) : null;
        } else {
            [market, position] = await Promise.all([
                read.readMarket(connection, subject),
                read.readPosition(connection, subject, ownerKeypair.publicKey)
            ]);
        }
        if (yesPayout(market, position, item.outcome) > 0n) {
            current.claim = await perform({ type: 'claim', agreementCid: item.cid, side: 'yes' }, () => act.claimAgreementMarket({
                connection, claimerKeypair: ownerKeypair, subject, side: 'yes', sendAndConfirm
            }));
        } else {
            current.claim = { skipped: true, reason: position?.claimed ? 'already-claimed' : 'nothing-to-claim', signature: null };
        }
        await checkpoint({ ...current });
    }
    if (has('reclaim')) {
        current.reclaim = await perform({ type: 'reclaim-seed', agreementCid: item.cid }, () => act.reclaimAgreementMarketSeed({
            connection, creatorKeypair: ownerKeypair, subject, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    return current;
}
