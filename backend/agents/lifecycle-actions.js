// Shared Node signer adapters for what follows an agreement's mint: its market (resolve, claim),
// donations and soft pledges (refund, revoke, release, fulfil, void), the recipe-bound external
// markets, and the proposer's settlement of its own agreements (its owner approval, the lens decision,
// attest and execute, or expire after the deadline; then resolve and claim). The subject of every
// market, pledge book and donation escrow is the agreement's chain account (PDA(sponsor, CID),
// agreement-minter.js). Browser wallets, MCP agents and deterministic runners use the same instruction
// codecs; these functions add only read-before-write idempotence and transaction submission.
import { createRequire } from 'node:module';
import { donationIdBytes } from './donor.js';
import { AGREEMENT_STATUS, executeAgreement, expireAgreement, readAgreementAccount, recordAgreementDecision } from './agreement-minter.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const supportClient = require('../../frontend/js/solana/pledge-client.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
supportClient.configure({ web3 });
marketClient.configure({ web3 });
agreementClient.configure({ web3 });

// Signers are de-duplicated by key; the first pays fees.
async function sendInstruction(connection, instruction, signerOrSigners, sendAndConfirm) {
    const signers = [];
    for (const signer of [signerOrSigners].flat()) {
        if (signer && !signers.some(existing => existing.publicKey.equals(signer.publicKey))) signers.push(signer);
    }
    const transaction = new web3.Transaction().add(instruction);
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
    connection, resolverKeypair, subject,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!resolverKeypair?.publicKey) throw new Error('resolverKeypair is required');
    const market = await marketClient.readMarket(connection, subject);
    if (!market) throw new Error('agreement market does not exist');
    if (market.resolved) {
        return { replayed: true, signature: null, outcome: market.outcome === marketClient.constants.SIDE_YES ? 'YES' : 'NO' };
    }
    const signature = await sendInstruction(connection, marketClient.buildResolveIx({ proposal: subject }), resolverKeypair, sendAndConfirm);
    const resolved = await marketClient.readMarket(connection, subject);
    return {
        replayed: false, signature,
        outcome: resolved?.outcome === marketClient.constants.SIDE_YES ? 'YES' : 'NO'
    };
}

export async function claimAgreementMarket({
    connection, claimerKeypair, subject, side,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!claimerKeypair?.publicKey) throw new Error('claimerKeypair is required');
    const sideText = typeof side === 'string' ? String(side).toLowerCase() : null;
    if (sideText && !['yes', 'no'].includes(sideText)) throw new Error('side must be yes or no');
    const normalizedSide = sideText
        ? sideText === 'yes' ? marketClient.constants.SIDE_YES : marketClient.constants.SIDE_NO
        : side;
    const market = await marketClient.readMarket(connection, subject);
    if (!market?.resolved) throw new Error('agreement market is not resolved');
    const position = await marketClient.readPosition(connection, subject, claimerKeypair.publicKey, normalizedSide);
    if (!position) throw new Error('market position does not exist');
    if (position.claimed) return { replayed: true, signature: null, claimed: true };
    const signature = await sendInstruction(connection, marketClient.buildClaimIx({
        proposal: subject, stakeMint: market.stakeMint,
        claimer: claimerKeypair.publicKey, side: normalizedSide
    }), claimerKeypair, sendAndConfirm);
    return { replayed: false, signature, claimed: true };
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
// as they are now, never from a checkpoint flag, so a rerun repeats nothing. A binding owners'
// agreement whose sole owner is the proposer is decided by the proposer itself: its approval receipt
// (decide), its lens member's AgreementDecision-v1 (lens), recorded on the account (attest), then
// `execute` releases the escrow to the payout and the market resolves YES. One that never got there
// expires after its deadline (the escrow returns to the sponsor) and the market resolves NO.

// Steps that sign a chain transaction; decide (a signed message, relayed) and lens (the member's own
// transaction) cost the proposer none.
export const SIGNED_SETTLEMENT_STEPS = Object.freeze(['attest', 'execute', 'expire', 'resolve', 'claim']);

const SETTLEMENT_READERS = {
    readAgreement: (connection, account) => readAgreementAccount(connection, { account }),
    readMarket: (connection, account) => marketClient.readMarket(connection, account),
    readPosition: (connection, account, owner) => marketClient.readPosition(connection, account, owner, marketClient.constants.SIDE_YES)
};

const SIDE_OF = Object.freeze({ YES: marketClient.constants.SIDE_YES, NO: marketClient.constants.SIDE_NO });

// What the owner's YES position pays once the market settles `outcome` (a resolved market's own outcome
// wins): YES returns the stake and a share of the NO pool; NO refunds it in full only when nobody staked NO.
function yesPayout(market, position, outcome) {
    if (!market || !position || position.claimed) return 0n;
    const side = market.resolved ? market.outcome : SIDE_OF[outcome];
    return marketClient.payoutAmount(marketClient.constants.SIDE_YES, position.amount, market.yesPool, market.noPool, side);
}

/**
 * Read-only: which settlement steps one of the proposer's own minted agreements still needs, in order.
 * @param agreement { cid, account, deadline, soleOwner (the proposer is the only owner of every input
 *   parcel), lens, pickId?, sourceRunId?, sourceDay? }
 * @param lensKey the lens member this runner operates (asks for decisions), or null
 * @returns {Promise<object>} the agreement with `state` (decidable | decided | awaiting-owners |
 *   lens-not-operated | awaiting-funds | due | executed | cancelled | expired | closed | missing | foreign),
 *   `outcome` (YES | NO | null) and `steps`
 */
export async function inspectSettlement({ connection, owner, agreement, lensKey = null, nowSeconds = Math.floor(Date.now() / 1000), readers = {} } = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!owner) throw new Error('owner is required');
    const read = { ...SETTLEMENT_READERS, ...readers };
    const ownerKey = new web3.PublicKey(owner);
    const state = await read.readAgreement(connection, agreement.account);
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
    if (active && !due) {
        if (pending && !agreement.soleOwner) return { ...base, state: 'awaiting-owners', outcome: null, steps: [] };
        if (pending && (!lensKey || state.lens !== lensKey)) return { ...base, state: 'lens-not-operated', outcome: null, steps: [], lens: state.lens };
        if (pending) steps.push('decide', 'lens', 'attest');
        if (!funded) return { ...base, state: pending ? 'decidable' : 'awaiting-funds', outcome: null, steps, note: 'the escrow lacks what execution requires' };
        steps.push('execute');
        label = pending ? 'decidable' : 'decided';
        outcome = 'YES';
    } else if (due) {
        steps.push('expire');
        label = 'due';
        outcome = 'NO';
    } else {
        label = state.status.toLowerCase();
        outcome = state.status === AGREEMENT_STATUS.executed ? 'YES' : 'NO';
    }
    const [market, position] = await Promise.all([
        read.readMarket(connection, agreement.account),
        read.readPosition(connection, agreement.account, ownerKey)
    ]);
    const payout = yesPayout(market, position, outcome);
    if (market && !market.resolved) steps.push('resolve');
    if (payout > 0n) steps.push('claim');
    return {
        ...base,
        state: steps.length ? label : 'closed',
        outcome,
        steps,
        market: market ? { resolved: market.resolved, yesPool: String(market.yesPool), noPool: String(market.noPool) } : null,
        position: position ? { amount: String(position.amount), claimed: position.claimed } : null,
        expectedPayout: String(payout),
        ...(position && !position.claimed && payout === 0n ? { note: 'YES stake lost: the NO pool is not empty' } : {})
    };
}

/**
 * Take the outstanding steps in order — decide → lens → attest → execute, or expire — then resolve →
 * claim, each through `perform` (the action engine, so it lands in the activity feed) and each followed by
 * `checkpoint(record)`. `decide()` and `askLens()` are the off-chain steps the caller provides (the owner's
 * relayed approval, lens-approval-client.js); the claim is re-derived from the market after resolution.
 */
export async function executeSettlement({
    connection, ownerKeypair, item, perform, checkpoint, decide, askLens, record = {}, readers = {}, adapters = {},
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair is required');
    if (typeof perform !== 'function' || typeof checkpoint !== 'function') throw new Error('perform and checkpoint are required');
    const read = { ...SETTLEMENT_READERS, ...readers };
    const act = { recordAgreementDecision, executeAgreement, expireAgreement, resolveAgreementMarket, claimAgreementMarket, ...adapters };
    const subject = item.account;
    const current = { ...record, cid: item.cid, account: subject, pickId: item.pickId ?? null, sourceRunId: item.sourceRunId ?? null, sourceDay: item.sourceDay ?? null };
    const has = step => item.steps.includes(step);
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
        const [market, position] = await Promise.all([
            read.readMarket(connection, subject),
            read.readPosition(connection, subject, ownerKeypair.publicKey)
        ]);
        if (yesPayout(market, position, item.outcome) > 0n) {
            current.claim = await perform({ type: 'claim', agreementCid: item.cid, side: 'yes' }, () => act.claimAgreementMarket({
                connection, claimerKeypair: ownerKeypair, subject, side: 'yes', sendAndConfirm
            }));
        } else {
            current.claim = { skipped: true, reason: position?.claimed ? 'already-claimed' : 'nothing-to-claim', signature: null };
        }
        await checkpoint({ ...current });
    }
    return current;
}
