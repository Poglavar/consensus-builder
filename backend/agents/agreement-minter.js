// Mints, funds, records the lens's decision on, executes and expires agreements on Solana with a node
// keypair: the node twin of the browser's chain flow on the agreement panel, on the same codec
// (frontend/js/solana/agreement-client.js). The account is PDA(sponsor, CID), so only the sponsor that
// publishes an agreement can create its account (blockchain/solana/programs/agreement/README.md). Only a
// binding owners' agreement is minted; a community vote is a poll in the index. Every step reads the chain
// first, so a rerun after a crash creates nothing twice and funds only what the escrow still lacks.
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
// The UMD codec resolves @solana/web3.js relative to frontend/js/solana, where it is not installed.
agreementClient.configure({ web3 });

export const AGREEMENT_PROGRAM_ID = agreementClient.constants.AGREEMENT_PROGRAM_ID;
export const AGREEMENT_STATUS = Object.freeze({ active: 'Active', executed: 'Executed', cancelled: 'Cancelled', expired: 'Expired' });
const SIGNATURE_PAGE = 1000;
const ATTESTATION_READ_ATTEMPTS = 4;
const ATTESTATION_READ_PAUSE_MS = 3000;
const MAX_SIGNATURE_PAGES = 20;

function toLamports(value, label = 'lamports') {
    if (value === undefined || value === null || value === '') return 0n;
    if (typeof value === 'bigint') {
        if (value < 0n) throw new Error(`${label} cannot be negative`);
        return value;
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative whole number of lamports, got ${JSON.stringify(value)}`);
    return BigInt(text);
}

const keyText = value => new web3.PublicKey(value).toBase58();

async function send(connection, instructions, signer, sendAndConfirm) {
    const transaction = new web3.Transaction().add(...instructions);
    transaction.feePayer = signer.publicKey;
    return sendAndConfirm(connection, transaction, [signer], { commitment: 'confirmed' });
}

/** The agreement account of a CID minted by this sponsor (PDA ["agreement", sponsor, sha256(cid)]). */
export function agreementAccountOf(cid, sponsor, programId = AGREEMENT_PROGRAM_ID) {
    return agreementClient.getAgreementPda(cid, sponsor, programId)[0].toBase58();
}

/** The Agreement account (agreement-client readAgreement) or null when it is not created yet. */
export function readAgreementAccount(connection, { cid, sponsor, account, programId = AGREEMENT_PROGRAM_ID } = {}) {
    return agreementClient.fetchAgreement(connection, account ? { address: account, programId } : { cid, authority: sponsor, programId });
}

/**
 * The oldest transaction that touched the account: its create, the signature the index records for a
 * mint found on chain after the run that sent it lost its checkpoint.
 */
export async function creationSignature(connection, account) {
    const address = new web3.PublicKey(account);
    let before;
    let oldest = null;
    for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
        const batch = await connection.getSignaturesForAddress(address, { limit: SIGNATURE_PAGE, ...(before ? { before } : {}) }, 'confirmed');
        if (!batch.length) break;
        oldest = batch[batch.length - 1].signature;
        if (batch.length < SIGNATURE_PAGE) return oldest;
        before = oldest;
    }
    if (!oldest) throw new Error(`no transaction touched agreement account ${account}`);
    throw new Error(`agreement account ${account} has more than ${SIGNATURE_PAGE * MAX_SIGNATURE_PAGES} transactions; its create is not read back`);
}

/**
 * Create the agreement account (if missing) and fund its escrow up to `lamports`, in one transaction.
 * `create(cid, lens, deadline, open_ground, required_lamports = lamports, payout)`; `fund` brings the
 * escrow to `lamports` (nothing when it already holds that much, nothing at all for 0). An existing
 * account must carry the same lens, deadline and required lamports, or nothing is signed.
 * @param {{ connection, sponsorKeypair, cid: string, lens: string, deadline: string|null, lamports?: bigint|string|number,
 *           payout?: string|null, openGround?: boolean, programId?: string, sendAndConfirm?: Function }} options
 *   payout defaults to the sponsor (the escrow returns to it at execution)
 * @returns {Promise<{ account, programId, signature: string|null, createSignature: string, created: boolean,
 *   fundedLamports: string, requiredLamports: string, escrowLamports: string, status: string }>}
 */
export async function mintAgreement({
    connection, sponsorKeypair, cid, lens, deadline = null, lamports = 0n, payout = null, openGround = false,
    programId = AGREEMENT_PROGRAM_ID, sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!sponsorKeypair?.publicKey) throw new Error('sponsorKeypair is required');
    agreementClient.requireCid(cid);
    const sponsor = sponsorKeypair.publicKey;
    const lensKey = keyText(lens);
    if (lensKey === sponsor.toBase58()) throw new Error(`the lens is the sponsor's own key ${lensKey}: a sponsor cannot attest its own agreement`);
    const required = toLamports(lamports);
    const deadlineSeconds = agreementClient.toDeadlineSeconds(deadline);
    const account = agreementAccountOf(cid, sponsor, programId);

    const existing = await readAgreementAccount(connection, { cid, sponsor: sponsor.toBase58(), programId });
    if (existing) {
        const differs = [
            existing.lens !== lensKey ? `lens ${existing.lens}` : null,
            existing.deadline !== deadlineSeconds ? `deadline ${existing.deadline}` : null,
            existing.requiredLamports !== required ? `required lamports ${existing.requiredLamports}` : null
        ].filter(Boolean);
        if (differs.length) throw new Error(`agreement account ${account} exists with other terms (${differs.join(', ')}); nothing signed`);
    }
    const instructions = [];
    if (!existing) {
        instructions.push(agreementClient.buildCreateIx({
            authority: sponsor, programId, cid, lens: lensKey, deadline: deadlineSeconds, openGround: Boolean(openGround),
            requiredLamports: required, payout: payout ? keyText(payout) : sponsor
        }).instruction);
    }
    const escrow = existing ? existing.escrowLamports : 0n;
    const shortfall = required > escrow ? required - escrow : 0n;
    if (shortfall > 0n) {
        if (existing && existing.status !== AGREEMENT_STATUS.active) {
            throw new Error(`agreement ${account} is ${existing.status}; its escrow can no longer be funded`);
        }
        instructions.push(agreementClient.buildFundIx({ agreement: account, authority: sponsor, lamports: shortfall, programId }));
    }
    const signature = instructions.length ? await send(connection, instructions, sponsorKeypair, sendAndConfirm) : null;
    const after = await readAgreementAccount(connection, { cid, sponsor: sponsor.toBase58(), programId });
    if (!after) throw new Error(`agreement account ${account} is missing after ${signature || 'no transaction'}`);
    if (after.escrowLamports < required) throw new Error(`agreement ${account} holds ${after.escrowLamports} of ${required} lamports after ${signature}`);
    return {
        account, programId: keyText(programId), signature,
        createSignature: existing ? await creationSignature(connection, account) : signature,
        created: !existing, fundedLamports: String(shortfall), requiredLamports: String(required),
        escrowLamports: String(after.escrowLamports), status: after.status
    };
}

/**
 * Bring an Active agreement's escrow up to `targetLamports` (only its sponsor may fund it). A target the
 * escrow already holds signs nothing, so a retry never funds twice.
 */
export async function fundAgreement({
    connection, sponsorKeypair, cid, targetLamports, programId = AGREEMENT_PROGRAM_ID,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!sponsorKeypair?.publicKey) throw new Error('sponsorKeypair is required');
    const sponsor = sponsorKeypair.publicKey.toBase58();
    const target = toLamports(targetLamports, 'targetLamports');
    const state = await readAgreementAccount(connection, { cid, sponsor, programId });
    if (!state) throw new Error(`agreement ${cid} has no account of sponsor ${sponsor}; mint it first`);
    if (state.status !== AGREEMENT_STATUS.active) throw new Error(`agreement ${state.address} is ${state.status}; it can no longer be funded`);
    if (state.escrowLamports >= target) {
        return { account: state.address, replayed: true, signature: null, fundedLamports: '0', escrowLamports: String(state.escrowLamports) };
    }
    const lamports = target - state.escrowLamports;
    const signature = await send(connection, [agreementClient.buildFundIx({ agreement: state.address, authority: sponsor, lamports, programId })],
        sponsorKeypair, sendAndConfirm);
    const after = await readAgreementAccount(connection, { cid, sponsor, programId });
    return { account: state.address, replayed: false, signature, fundedLamports: String(lamports), escrowLamports: String(after?.escrowLamports ?? '') };
}

/**
 * Record the lens's AgreementDecision-v1 attestation on the agreement (`attest`, permissionless; the
 * signer only pays the fee). The program's own checks run first on the two accounts
 * (agreement-client.js checkDecisionForAttest), so nothing is signed that the program would refuse; an
 * agreement whose decision is already recorded is a replay.
 */
export async function recordAgreementDecision({
    connection, payerKeypair, account, attestation, nowSeconds = Math.floor(Date.now() / 1000), programId = AGREEMENT_PROGRAM_ID,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!payerKeypair?.publicKey) throw new Error('payerKeypair is required');
    const state = await readAgreementAccount(connection, { account, programId });
    if (!state) throw new Error(`agreement account ${account} does not exist`);
    if (state.decisionCode !== agreementClient.constants.DECISION_PENDING) {
        return { replayed: true, signature: null, decision: state.decision, attestation: state.decisionAttestation };
    }
    // The lens member's own transaction created the attestation; this RPC may not show it yet.
    let fact = null;
    for (let attempt = 1; attempt <= ATTESTATION_READ_ATTEMPTS; attempt += 1) {
        fact = await agreementClient.fetchDecisionAttestation(connection, attestation);
        if (fact || attempt === ATTESTATION_READ_ATTEMPTS) break;
        await delay(ATTESTATION_READ_PAUSE_MS * attempt);
    }
    const reason = agreementClient.checkDecisionForAttest({ agreement: state, attestation: fact, nowSeconds });
    if (reason) throw new Error(`the decision attestation ${attestation} cannot be recorded on ${account}: ${reason}`);
    const signature = await send(connection, [agreementClient.buildAttestIx({ agreement: account, attestation, credential: fact.credential, programId })],
        payerKeypair, sendAndConfirm);
    return { replayed: false, signature, decision: 'Satisfied', attestation };
}

/**
 * Execute an Active agreement whose satisfied decision is recorded and whose escrow holds what it
 * requires (`execute`, permissionless; the signer only pays the fee): the whole escrow goes to its payout.
 * An agreement already executed is a replay; any other terminal state is reported, not signed.
 */
export async function executeAgreement({
    connection, payerKeypair, account, nowSeconds = Math.floor(Date.now() / 1000), programId = AGREEMENT_PROGRAM_ID,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!payerKeypair?.publicKey) throw new Error('payerKeypair is required');
    const state = await readAgreementAccount(connection, { account, programId });
    if (!state) throw new Error(`agreement account ${account} does not exist`);
    if (state.status === AGREEMENT_STATUS.executed) return { replayed: true, signature: null, status: state.status, payout: state.payout };
    if (state.status !== AGREEMENT_STATUS.active) return { replayed: true, signature: null, status: state.status, skipped: 'terminal' };
    if (state.decisionCode !== agreementClient.constants.DECISION_SATISFIED) throw new Error(`agreement ${account} has no satisfied decision recorded`);
    if (agreementClient.deadlinePassed(state, nowSeconds)) throw new Error(`agreement ${account} is past its deadline; it can only expire`);
    if (state.escrowLamports < state.requiredLamports) {
        throw new Error(`agreement ${account} holds ${state.escrowLamports} of the ${state.requiredLamports} lamports execution requires`);
    }
    const signature = await send(connection, [agreementClient.buildExecuteIx({ agreement: account, payout: state.payout, programId })],
        payerKeypair, sendAndConfirm);
    return { replayed: false, signature, status: AGREEMENT_STATUS.executed, payout: state.payout, paidLamports: String(state.escrowLamports) };
}

/**
 * Expire an Active agreement whose deadline has passed: permissionless; the escrow returns to its
 * sponsor. An agreement already expired is a replay; any other terminal state is reported, not signed.
 */
export async function expireAgreement({
    connection, signerKeypair, account, nowSeconds = Math.floor(Date.now() / 1000), programId = AGREEMENT_PROGRAM_ID,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!signerKeypair?.publicKey) throw new Error('signerKeypair is required');
    const state = await readAgreementAccount(connection, { account, programId });
    if (!state) throw new Error(`agreement account ${account} does not exist`);
    if (state.status === AGREEMENT_STATUS.expired) return { replayed: true, signature: null, status: state.status };
    if (state.status !== AGREEMENT_STATUS.active) return { replayed: true, signature: null, status: state.status, skipped: 'terminal' };
    if (!state.deadline || state.deadline > nowSeconds) throw new Error(`agreement ${account} has not reached its deadline (${state.deadline || 'none'})`);
    const signature = await send(connection, [agreementClient.buildExpireIx({ agreement: account, authority: state.authority, programId })],
        signerKeypair, sendAndConfirm);
    return { replayed: false, signature, status: AGREEMENT_STATUS.expired, refundedLamports: String(state.escrowLamports) };
}
