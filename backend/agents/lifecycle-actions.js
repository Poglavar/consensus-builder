// Shared Node signer adapters for terminal proposal/support/market actions. Browser wallets, MCP
// agents and deterministic runners use the same instruction codecs; these functions add only
// read-before-write idempotence and transaction submission.
import { createRequire } from 'node:module';
import { instructionDiscriminator } from './minter.js';
import { donationIdBytes } from './donor.js';
import { STATUS_CANCELLED, STATUS_EXECUTED } from '../oracle/proposal-lifecycle.js';
import { decodeLensAttestation, deriveCredentialPda, SAS_PROGRAM_ID } from '../oracle/lens-schemas.js';
import { requestVerdictAttestation } from './lens-ownership-client.js';
import { expiryObservedAt } from './run-policy.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const supportClient = require('../../frontend/js/solana/pledge-client.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
supportClient.configure({ web3 });
marketClient.configure({ web3 });

const PROPOSAL_PROGRAM_ID = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const PARCEL_PROGRAM_ID = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
// The reference lens member's default SAS credential name (backend/lens, personas.json service.credentialName).
export const DEFAULT_CREDENTIAL_NAME = 'LensMember';

function borshString(value) {
    const text = Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(text.length);
    return Buffer.concat([length, text]);
}

function readString(bytes, state) {
    if (state.offset + 4 > bytes.length) throw new Error('account ended before a string length');
    const length = bytes.readUInt32LE(state.offset); state.offset += 4;
    if (state.offset + length > bytes.length) throw new Error('account ended inside a string');
    const value = bytes.subarray(state.offset, state.offset + length).toString('utf8');
    state.offset += length;
    return value;
}

function readStringVector(bytes, state) {
    if (state.offset + 4 > bytes.length) throw new Error('account ended before a vector length');
    const count = bytes.readUInt32LE(state.offset); state.offset += 4;
    const values = [];
    for (let index = 0; index < count; index += 1) values.push(readString(bytes, state));
    return values;
}

// Proposal account (proposal_nft v2, lens-model.md): prefix unchanged from v1, then `lens`, `bump`
// and the v2 `verdict_may_execute` flag. v1 zero-initialised the fixed 4096-byte account, so every
// existing proposal carries a real 0 byte there; a buffer that ends before it is not a proposal account.
export function decodeProposalState(data) {
    const bytes = Buffer.from(data || []);
    const state = { offset: 8 };
    if (bytes.length < 48) throw new Error('proposal account is too short');
    state.offset += 8;
    const owner = new web3.PublicKey(bytes.subarray(state.offset, state.offset + 32)); state.offset += 32;
    const parcelIds = readStringVector(bytes, state);
    const isConditional = bytes[state.offset++] === 1;
    const imageUri = readString(bytes, state);
    const acceptancePossible = bytes[state.offset++] === 1;
    const status = bytes[state.offset++];
    state.offset += 8 + 8 + 8;
    const acceptedParcels = readStringVector(bytes, state);
    if (state.offset + 4 > bytes.length) throw new Error('proposal account ended before the lens');
    const lensCount = bytes.readUInt32LE(state.offset); state.offset += 4;
    if (state.offset + lensCount * 32 + 2 > bytes.length) throw new Error('proposal account ended inside the lens, bump or verdict_may_execute');
    const lens = [];
    for (let index = 0; index < lensCount; index += 1) {
        lens.push(new web3.PublicKey(bytes.subarray(state.offset, state.offset + 32)).toBase58());
        state.offset += 32;
    }
    const bump = bytes[state.offset++];
    const verdictMayExecute = bytes[state.offset++] === 1;
    return { owner, parcelIds, isConditional, imageUri, acceptancePossible, status, acceptedParcels, lens, bump, verdictMayExecute };
}

// v1 anchors carry the first minter as `owner`; v2 anchors carry the default key. Nothing reads it for
// authority any more; it is reported for information only.
export function decodeParcelOwner(data) {
    const bytes = Buffer.from(data || []);
    const state = { offset: 8 };
    readString(bytes, state);
    readString(bytes, state);
    if (state.offset + 32 > bytes.length) throw new Error('parcel account has no owner');
    return new web3.PublicKey(bytes.subarray(state.offset, state.offset + 32));
}

// Signers are de-duplicated by key (owner and payer are often the same wallet); the first pays fees.
async function sendInstruction(connection, instruction, signerOrSigners, sendAndConfirm) {
    const signers = [];
    for (const signer of [signerOrSigners].flat()) {
        if (signer && !signers.some(existing => existing.publicKey.equals(signer.publicKey))) signers.push(signer);
    }
    const transaction = new web3.Transaction().add(instruction);
    transaction.feePayer = signers[0].publicKey;
    return sendAndConfirm(connection, transaction, signers, { commitment: 'confirmed' });
}

export function buildCancelProposalIx({ proposalAccount, owner, programId = PROPOSAL_PROGRAM_ID } = {}) {
    return new web3.TransactionInstruction({
        programId: new web3.PublicKey(programId),
        keys: [
            { pubkey: new web3.PublicKey(proposalAccount), isSigner: false, isWritable: true },
            { pubkey: new web3.PublicKey(owner), isSigner: true, isWritable: true }
        ],
        data: Buffer.from(instructionDiscriminator('cancel_and_refund'))
    });
}

// ---- lens model v2: attested acceptance and verdict settlement ----------------------------------
// PDAs (blockchain/solana/README.md §PDAs): parcel anchor ["parcel", parcel_id] under parcel_nft;
// tally ["consent", proposal, parcel_id] and record ["acceptance", proposal, parcel_id, owner] under
// proposal_nft; the member's SAS credential ["credential", member, credentialName] under SAS.

export const STATUS_ACTIVE = 0;
export const STATUS_EXPIRED = 3;
const ACCOUNT_DISCRIMINATORS = {
    ConsentTally: [200, 21, 66, 56, 62, 148, 43, 226],
    AcceptanceRecord: [8, 191, 82, 210, 167, 58, 12, 34]
};

function key(value, label) {
    if (value === null || value === undefined || value === '') throw new Error(`${label} is required`);
    try {
        return value instanceof web3.PublicKey ? value : new web3.PublicKey(value.toBase58 ? value.toBase58() : value);
    } catch {
        throw new Error(`${label} "${value}" is not a base58 public key`);
    }
}

export function deriveParcelAnchorPda(parcelId, parcelProgramId = PARCEL_PROGRAM_ID) {
    return web3.PublicKey.findProgramAddressSync(
        [Buffer.from('parcel'), Buffer.from(String(parcelId))], new web3.PublicKey(parcelProgramId)
    )[0];
}

export function deriveConsentTallyPda({ proposalAccount, parcelId, programId = PROPOSAL_PROGRAM_ID }) {
    return web3.PublicKey.findProgramAddressSync(
        [Buffer.from('consent'), key(proposalAccount, 'proposalAccount').toBuffer(), Buffer.from(String(parcelId))],
        new web3.PublicKey(programId)
    )[0];
}

export function deriveAcceptanceRecordPda({ proposalAccount, parcelId, owner, programId = PROPOSAL_PROGRAM_ID }) {
    return web3.PublicKey.findProgramAddressSync(
        [Buffer.from('acceptance'), key(proposalAccount, 'proposalAccount').toBuffer(), Buffer.from(String(parcelId)), key(owner, 'owner').toBuffer()],
        new web3.PublicKey(programId)
    )[0];
}

export function deriveMemberCredential({ member, credentialName = DEFAULT_CREDENTIAL_NAME }) {
    return new web3.PublicKey(deriveCredentialPda({ authority: key(member, 'member').toBase58(), name: credentialName }));
}

function checkDiscriminator(bytes, name) {
    const expected = ACCOUNT_DISCRIMINATORS[name];
    if (bytes.length < 8 || !expected.every((byte, index) => bytes[index] === byte)) throw new Error(`account is not a ${name}`);
}

function readKey(bytes, state) {
    if (state.offset + 32 > bytes.length) throw new Error('account ended inside a public key');
    const value = new web3.PublicKey(bytes.subarray(state.offset, state.offset + 32)).toBase58();
    state.offset += 32;
    return value;
}

export function decodeConsentTally(data) {
    const bytes = Buffer.from(data || []);
    checkDiscriminator(bytes, 'ConsentTally');
    const state = { offset: 8 };
    const proposal = readKey(bytes, state);
    const parcelId = readString(bytes, state);
    const member = readKey(bytes, state);
    if (state.offset + 3 > bytes.length) throw new Error('consent tally ended before its counters');
    return { proposal, parcelId, member, required: bytes[state.offset], accepted: bytes[state.offset + 1], bump: bytes[state.offset + 2] };
}

export function decodeAcceptanceRecord(data) {
    const bytes = Buffer.from(data || []);
    checkDiscriminator(bytes, 'AcceptanceRecord');
    const state = { offset: 8 };
    const proposal = readKey(bytes, state);
    const parcelId = readString(bytes, state);
    const owner = readKey(bytes, state);
    const member = readKey(bytes, state);
    const ownershipAttestation = readKey(bytes, state);
    if (state.offset + 32 > bytes.length) throw new Error('acceptance record ended inside ownership_hash');
    const ownershipHash = bytes.subarray(state.offset, state.offset + 32).toString('hex'); state.offset += 32;
    const payoutKey = readKey(bytes, state);
    if (state.offset + 9 > bytes.length) throw new Error('acceptance record ended before accepted_at');
    const acceptedAt = Number(bytes.readBigInt64LE(state.offset)); state.offset += 8;
    const bump = bytes[state.offset];
    const payout = payoutKey === web3.PublicKey.default.toBase58() ? null : payoutKey;
    return { proposal, parcelId, owner, member, ownershipAttestation, ownershipHash, payout, acceptedAt, bump };
}

async function readProposal(connection, proposalAccount) {
    const info = await connection.getAccountInfo(key(proposalAccount, 'proposalAccount'), 'confirmed');
    if (!info?.data) throw new Error('proposal account does not exist');
    return decodeProposalState(info.data);
}

/** The per-parcel consent tally, or null when no owner of this parcel has accepted yet. */
export async function readConsentTally({ connection, proposalAccount, parcelId, programId = PROPOSAL_PROGRAM_ID } = {}) {
    const address = deriveConsentTallyPda({ proposalAccount, parcelId, programId });
    const info = await connection.getAccountInfo(address, 'confirmed');
    return info?.data ? { address: address.toBase58(), ...decodeConsentTally(info.data) } : null;
}

/** One owner's acceptance record, or null when that owner has not accepted this parcel. */
export async function readAcceptanceRecord({ connection, proposalAccount, parcelId, owner, programId = PROPOSAL_PROGRAM_ID } = {}) {
    const address = deriveAcceptanceRecordPda({ proposalAccount, parcelId, owner, programId });
    const info = await connection.getAccountInfo(address, 'confirmed');
    return info?.data ? { address: address.toBase58(), ...decodeAcceptanceRecord(info.data) } : null;
}

// Borsh Option<Pubkey>: 0, or 1 followed by the 32 key bytes.
function encodeOptionalKey(value) {
    if (value === null || value === undefined || value === '') return Buffer.from([0]);
    return Buffer.concat([Buffer.from([1]), key(value, 'payout').toBuffer()]);
}

/**
 * accept_with_attestations(parcel_id: String, payout: Option<Pubkey>). Account order (IDL):
 * proposal (w), parcel anchor, ownership attestation, ownership credential, tally (w), record (w),
 * owner (signer), payer (signer, w), system program.
 */
export function buildAcceptWithAttestationsIx({
    proposalAccount, parcelId, ownershipAttestation, ownershipCredential, owner, payer, payout = null,
    programId = PROPOSAL_PROGRAM_ID, parcelProgramId = PARCEL_PROGRAM_ID
} = {}) {
    if (!parcelId) throw new Error('parcelId is required');
    const proposal = key(proposalAccount, 'proposalAccount');
    const ownerKey = key(owner, 'owner');
    return new web3.TransactionInstruction({
        programId: new web3.PublicKey(programId),
        keys: [
            { pubkey: proposal, isSigner: false, isWritable: true },
            { pubkey: deriveParcelAnchorPda(parcelId, parcelProgramId), isSigner: false, isWritable: false },
            { pubkey: key(ownershipAttestation, 'ownershipAttestation'), isSigner: false, isWritable: false },
            { pubkey: key(ownershipCredential, 'ownershipCredential'), isSigner: false, isWritable: false },
            { pubkey: deriveConsentTallyPda({ proposalAccount: proposal, parcelId, programId }), isSigner: false, isWritable: true },
            { pubkey: deriveAcceptanceRecordPda({ proposalAccount: proposal, parcelId, owner: ownerKey, programId }), isSigner: false, isWritable: true },
            { pubkey: ownerKey, isSigner: true, isWritable: false },
            { pubkey: key(payer || owner, 'payer'), isSigner: true, isWritable: true },
            { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false }
        ],
        data: Buffer.concat([
            Buffer.from(instructionDiscriminator('accept_with_attestations')), borshString(parcelId), encodeOptionalKey(payout)
        ])
    });
}

/**
 * settle_with_verdict(). Account order (IDL): proposal (w), verdict attestation, verdict credential,
 * submitter (signer). Permissionless: anyone may submit a lens member's verdict.
 */
export function buildSettleWithVerdictIx({ proposalAccount, verdictAttestation, verdictCredential, submitter, programId = PROPOSAL_PROGRAM_ID } = {}) {
    return new web3.TransactionInstruction({
        programId: new web3.PublicKey(programId),
        keys: [
            { pubkey: key(proposalAccount, 'proposalAccount'), isSigner: false, isWritable: true },
            { pubkey: key(verdictAttestation, 'verdictAttestation'), isSigner: false, isWritable: false },
            { pubkey: key(verdictCredential, 'verdictCredential'), isSigner: false, isWritable: false },
            { pubkey: key(submitter, 'submitter'), isSigner: true, isWritable: false }
        ],
        data: Buffer.from(instructionDiscriminator('settle_with_verdict'))
    });
}

// Reads a lens attestation account and checks what the program will check, so a mismatch fails here
// with a message instead of as an opaque program error. Expiry is left to the program (chain clock).
async function readMemberAttestation(connection, kind, address, { member, credential }) {
    const info = await connection.getAccountInfo(key(address, `${kind} attestation`), 'confirmed');
    if (!info?.data) throw new Error(`${kind} attestation ${address} does not exist`);
    if (info.owner && !key(info.owner, 'attestation owner').equals(new web3.PublicKey(SAS_PROGRAM_ID))) {
        throw new Error(`${kind} attestation ${address} is not owned by the SAS program`);
    }
    const attestation = decodeLensAttestation(kind, info.data);
    if (attestation.authority !== member.toBase58()) {
        throw new Error(`${kind} attestation ${address} was signed by ${attestation.authority}, not lens member ${member.toBase58()}`);
    }
    if (attestation.credential !== credential.toBase58()) {
        throw new Error(`${kind} attestation ${address} is under credential ${attestation.credential}, not ${credential.toBase58()} (check credentialName)`);
    }
    return attestation;
}

/**
 * An attested owner says yes to one parcel of a proposal. Read-before-write: an existing acceptance
 * record for (proposal, parcel, owner) is replayed, never re-sent. The ownership attestation must be
 * issued by `member` (a key in the proposal's lens) under PDA(["credential", member, credentialName]).
 *
 * @returns {Promise<{ replayed: boolean, signature: string|null, record: string, tally: string, executed: boolean, acceptance?: object }>}
 */
export async function acceptWithAttestations({
    connection, ownerKeypair, payerKeypair = null, proposalAccount, parcelId, ownershipAttestation, member,
    credentialName = DEFAULT_CREDENTIAL_NAME, payout = null,
    programId = PROPOSAL_PROGRAM_ID, parcelProgramId = PARCEL_PROGRAM_ID,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair is required');
    if (!parcelId) throw new Error('parcelId is required');
    const memberKey = key(member, 'member');
    const ownerKey = ownerKeypair.publicKey;
    const proposalKey = key(proposalAccount, 'proposalAccount');
    const recordPda = deriveAcceptanceRecordPda({ proposalAccount: proposalKey, parcelId, owner: ownerKey, programId });
    const tallyPda = deriveConsentTallyPda({ proposalAccount: proposalKey, parcelId, programId });
    const proposal = await readProposal(connection, proposalKey);
    const existing = await readAcceptanceRecord({ connection, proposalAccount: proposalKey, parcelId, owner: ownerKey, programId });
    if (existing) {
        return {
            replayed: true, signature: null, record: recordPda.toBase58(), tally: tallyPda.toBase58(),
            executed: proposal.status === STATUS_EXECUTED, acceptance: existing
        };
    }
    if (proposal.status !== STATUS_ACTIVE || !proposal.acceptancePossible) throw new Error(`proposal is not accepting parcels (status ${proposal.status})`);
    if (!proposal.parcelIds.includes(String(parcelId))) throw new Error(`parcel ${parcelId} is not part of this proposal`);
    if (proposal.acceptedParcels.includes(String(parcelId))) throw new Error(`parcel ${parcelId} is already accepted by its attested owner set`);
    if (!proposal.lens.includes(memberKey.toBase58())) throw new Error(`lens member ${memberKey.toBase58()} is not in this proposal's lens [${proposal.lens.join(', ')}]`);
    const credential = deriveMemberCredential({ member: memberKey, credentialName });
    const attestation = await readMemberAttestation(connection, 'ownership', ownershipAttestation, { member: memberKey, credential });
    if (attestation.fields.parcelUid !== String(parcelId)) throw new Error(`ownership attestation is for parcel ${attestation.fields.parcelUid}, not ${parcelId}`);
    if (attestation.fields.owner !== ownerKey.toBase58()) throw new Error(`ownership attestation names owner ${attestation.fields.owner}, not the signer ${ownerKey.toBase58()}`);
    const tally = await readConsentTally({ connection, proposalAccount: proposalKey, parcelId, programId });
    if (tally && (tally.member !== memberKey.toBase58() || tally.required !== attestation.fields.ownerCount)) {
        throw new Error(`parcel ${parcelId} consent is already counted by member ${tally.member} for ${tally.required} owner(s); this attestation (member ${memberKey.toBase58()}, ${attestation.fields.ownerCount} owner(s)) cannot join it`);
    }
    const anchor = await connection.getAccountInfo(deriveParcelAnchorPda(parcelId, parcelProgramId), 'confirmed');
    if (!anchor?.data) throw new Error(`parcel anchor for ${parcelId} does not exist; mint it first (ensureParcelAnchor)`);
    const payer = payerKeypair || ownerKeypair;
    const signature = await sendInstruction(connection, buildAcceptWithAttestationsIx({
        proposalAccount: proposalKey, parcelId, ownershipAttestation, ownershipCredential: credential,
        owner: ownerKey, payer: payer.publicKey, payout, programId, parcelProgramId
    }), [payer, ownerKeypair], sendAndConfirm);
    const after = await readProposal(connection, proposalKey);
    return {
        replayed: false, signature, record: recordPda.toBase58(), tally: tallyPda.toBase58(),
        executed: after.status === STATUS_EXECUTED, ownershipHash: attestation.accountHash
    };
}

const VERDICT_STATUS = { executed: STATUS_EXECUTED, expired: STATUS_EXPIRED };

/**
 * Submit a lens member's ProposalVerdict-v1 attestation (permissionless). Replays when the proposal
 * already has the status the verdict names; refuses a verdict on any other terminal state, an
 * `executed` verdict on a proposal minted without verdict_may_execute, and a member outside the lens.
 * `member` defaults to the attestation's signer, which must still be in the lens.
 */
export async function settleWithVerdict({
    connection, submitterKeypair, proposalAccount, verdictAttestation, member = null,
    credentialName = DEFAULT_CREDENTIAL_NAME, programId = PROPOSAL_PROGRAM_ID,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!submitterKeypair?.publicKey) throw new Error('submitterKeypair is required');
    const proposalKey = key(proposalAccount, 'proposalAccount');
    const info = await connection.getAccountInfo(key(verdictAttestation, 'verdictAttestation'), 'confirmed');
    if (!info?.data) throw new Error(`verdict attestation ${verdictAttestation} does not exist`);
    const signerOf = decodeLensAttestation('verdict', info.data).authority;
    const memberKey = key(member || signerOf, 'member');
    const credential = deriveMemberCredential({ member: memberKey, credentialName });
    const attestation = await readMemberAttestation(connection, 'verdict', verdictAttestation, { member: memberKey, credential });
    const { verdict, proposalAccount: named } = attestation.fields;
    if (named !== proposalKey.toBase58()) throw new Error(`verdict attestation is about proposal ${named}, not ${proposalKey.toBase58()}`);
    const wanted = VERDICT_STATUS[verdict];
    const proposal = await readProposal(connection, proposalKey);
    if (proposal.status === wanted) return { replayed: true, signature: null, status: verdict, verdict, member: memberKey.toBase58() };
    if (proposal.status !== STATUS_ACTIVE) throw new Error(`proposal is not active (status ${proposal.status}); a ${verdict} verdict cannot settle it`);
    if (!proposal.lens.includes(memberKey.toBase58())) throw new Error(`lens member ${memberKey.toBase58()} is not in this proposal's lens [${proposal.lens.join(', ')}]`);
    if (verdict === 'executed' && !proposal.verdictMayExecute) {
        throw new Error('an executed verdict cannot skip per-parcel consent: this proposal was minted without verdict_may_execute');
    }
    const signature = await sendInstruction(connection, buildSettleWithVerdictIx({
        proposalAccount: proposalKey, verdictAttestation, verdictCredential: credential, submitter: submitterKeypair.publicKey, programId
    }), submitterKeypair, sendAndConfirm);
    return { replayed: false, signature, status: verdict, verdict, member: memberKey.toBase58(), verdictHash: attestation.accountHash };
}

export async function cancelProposal({
    connection, ownerKeypair, proposalAccount, programId = PROPOSAL_PROGRAM_ID,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair is required');
    const info = await connection.getAccountInfo(new web3.PublicKey(proposalAccount), 'confirmed');
    if (!info?.data) throw new Error('proposal account does not exist');
    const proposal = decodeProposalState(info.data);
    const status = proposal.status;
    if (status === STATUS_CANCELLED) return { replayed: true, signature: null, status: 'cancelled' };
    if (status !== 0) throw new Error(`proposal is not active (status ${status})`);
    if (!proposal.owner.equals(ownerKeypair.publicKey)) throw new Error('signer is not the proposal owner');
    const signature = await sendInstruction(connection, buildCancelProposalIx({
        proposalAccount, owner: ownerKeypair.publicKey, programId
    }), ownerKeypair, sendAndConfirm);
    return { replayed: false, signature, status: 'cancelled' };
}

export async function refundDonation({
    connection, donorKeypair, proposalAccount, operationId,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!donorKeypair?.publicKey) throw new Error('donorKeypair is required');
    const donationId = donationIdBytes(operationId);
    const position = await supportClient.readDonationPosition(connection, proposalAccount, donorKeypair.publicKey, donationId);
    if (!position) throw new Error('donation position does not exist');
    if (position.owner !== donorKeypair.publicKey.toBase58()) throw new Error('signer is not the donation owner');
    if (position.refunded) return { replayed: true, signature: null, refunded: true };
    const signature = await sendInstruction(connection, supportClient.buildRefundDonationIx({
        proposal: proposalAccount, donor: donorKeypair.publicKey, donationId
    }), donorKeypair, sendAndConfirm);
    return { replayed: false, signature, refunded: true };
}

export async function revokePledge({
    connection, pledgerKeypair, proposalAccount,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!pledgerKeypair?.publicKey) throw new Error('pledgerKeypair is required');
    const commitment = await supportClient.readPledgeCommitment(connection, proposalAccount, pledgerKeypair.publicKey);
    if (!commitment) throw new Error('pledge commitment does not exist');
    if (commitment.owner !== pledgerKeypair.publicKey.toBase58()) throw new Error('signer is not the pledge owner');
    if (commitment.status === supportClient.constants.PLEDGE_REVOKED) return { replayed: true, signature: null, revoked: true };
    if (commitment.status !== supportClient.constants.PLEDGE_ACTIVE) throw new Error(`pledge is not active (status ${commitment.status})`);
    const signature = await sendInstruction(connection, supportClient.buildRevokePledgeIx({
        proposal: proposalAccount, pledger: pledgerKeypair.publicKey
    }), pledgerKeypair, sendAndConfirm);
    return { replayed: false, signature, revoked: true };
}

export async function releaseDonations({
    connection, releaserKeypair, proposalAccount,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!releaserKeypair?.publicKey) throw new Error('releaserKeypair is required');
    const escrow = await supportClient.readDonationEscrow(connection, proposalAccount);
    if (!escrow) throw new Error('donation escrow does not exist');
    if (escrow.released) return { replayed: true, signature: null, released: true };
    const proposalInfo = await connection.getAccountInfo(new web3.PublicKey(proposalAccount), 'confirmed');
    if (!proposalInfo?.data || decodeProposalState(proposalInfo.data).status !== STATUS_EXECUTED) {
        throw new Error('proposal is not executed');
    }
    const signature = await sendInstruction(connection, supportClient.buildReleaseDonationsIx({
        proposal: proposalAccount, releaser: releaserKeypair.publicKey, beneficiary: escrow.beneficiary
    }), releaserKeypair, sendAndConfirm);
    return { replayed: false, signature, released: true };
}

export async function fulfillPledge({
    connection, pledgerKeypair, proposalAccount,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!pledgerKeypair?.publicKey) throw new Error('pledgerKeypair is required');
    const [book, commitment, proposalInfo] = await Promise.all([
        supportClient.readPledgeBook(connection, proposalAccount),
        supportClient.readPledgeCommitment(connection, proposalAccount, pledgerKeypair.publicKey),
        connection.getAccountInfo(new web3.PublicKey(proposalAccount), 'confirmed')
    ]);
    if (!book) throw new Error('pledge book does not exist');
    if (!commitment) throw new Error('pledge commitment does not exist');
    if (commitment.owner !== pledgerKeypair.publicKey.toBase58()) throw new Error('signer is not the pledge owner');
    if (commitment.status === supportClient.constants.PLEDGE_FULFILLED) return { replayed: true, signature: null, fulfilled: true };
    if (commitment.status !== supportClient.constants.PLEDGE_ACTIVE) throw new Error(`pledge is not active (status ${commitment.status})`);
    if (!proposalInfo?.data || decodeProposalState(proposalInfo.data).status !== STATUS_EXECUTED) {
        throw new Error('proposal is not executed');
    }
    const signature = await sendInstruction(connection, supportClient.buildFulfillPledgeIx({
        proposal: proposalAccount, pledger: pledgerKeypair.publicKey, beneficiary: book.beneficiary
    }), pledgerKeypair, sendAndConfirm);
    return { replayed: false, signature, fulfilled: true };
}

export async function voidPledge({
    connection, feePayerKeypair, proposalAccount, pledger,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!feePayerKeypair?.publicKey) throw new Error('feePayerKeypair is required');
    const pledgerKey = new web3.PublicKey(pledger || feePayerKeypair.publicKey);
    const commitment = await supportClient.readPledgeCommitment(connection, proposalAccount, pledgerKey);
    if (!commitment) throw new Error('pledge commitment does not exist');
    if (commitment.status === supportClient.constants.PLEDGE_VOIDED) return { replayed: true, signature: null, voided: true };
    if (commitment.status !== supportClient.constants.PLEDGE_ACTIVE) throw new Error(`pledge is not active (status ${commitment.status})`);
    const signature = await sendInstruction(connection, supportClient.buildVoidPledgeIx({
        proposal: proposalAccount, pledger: pledgerKey
    }), feePayerKeypair, sendAndConfirm);
    return { replayed: false, signature, voided: true };
}

export async function resolveProposalMarket({
    connection, resolverKeypair, proposalAccount,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!resolverKeypair?.publicKey) throw new Error('resolverKeypair is required');
    const market = await marketClient.readMarket(connection, proposalAccount);
    if (!market) throw new Error('proposal market does not exist');
    if (market.resolved) {
        return { replayed: true, signature: null, outcome: market.outcome === marketClient.constants.SIDE_YES ? 'YES' : 'NO' };
    }
    const signature = await sendInstruction(connection, marketClient.buildResolveIx({ proposal: proposalAccount }), resolverKeypair, sendAndConfirm);
    const resolved = await marketClient.readMarket(connection, proposalAccount);
    return {
        replayed: false, signature,
        outcome: resolved?.outcome === marketClient.constants.SIDE_YES ? 'YES' : 'NO'
    };
}

export async function claimProposalMarket({
    connection, claimerKeypair, proposalAccount, side,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!claimerKeypair?.publicKey) throw new Error('claimerKeypair is required');
    const sideText = typeof side === 'string' ? String(side).toLowerCase() : null;
    if (sideText && !['yes', 'no'].includes(sideText)) throw new Error('side must be yes or no');
    const normalizedSide = sideText
        ? sideText === 'yes' ? marketClient.constants.SIDE_YES : marketClient.constants.SIDE_NO
        : side;
    const market = await marketClient.readMarket(connection, proposalAccount);
    if (!market?.resolved) throw new Error('proposal market is not resolved');
    const position = await marketClient.readPosition(connection, proposalAccount, claimerKeypair.publicKey, normalizedSide);
    if (!position) throw new Error('market position does not exist');
    if (position.claimed) return { replayed: true, signature: null, claimed: true };
    const signature = await sendInstruction(connection, marketClient.buildClaimIx({
        proposal: proposalAccount, stakeMint: market.stakeMint,
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

// parcel_nft v2 mint_parcel(parcel_id, metadata_uri): accounts parcel (w), payer (signer, w), system
// program. The anchor is written with owner = default key; the payer only pays rent.
export function buildMintParcelIx({ parcelId, payer, metadataUri, parcelProgramId = PARCEL_PROGRAM_ID } = {}) {
    if (!parcelId) throw new Error('parcelId is required');
    return new web3.TransactionInstruction({
        programId: new web3.PublicKey(parcelProgramId),
        keys: [
            { pubkey: deriveParcelAnchorPda(parcelId, parcelProgramId), isSigner: false, isWritable: true },
            { pubkey: key(payer, 'payer'), isSigner: true, isWritable: true },
            { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false }
        ],
        data: Buffer.concat([
            Buffer.from(instructionDiscriminator('mint_parcel')), borshString(parcelId), borshString(metadataUri)
        ])
    });
}

// Parcel anchors are identities, owned by nobody (lens-model.md §parcel_nft v2). An existing anchor
// is replayed whoever minted it (v1 anchors still carry their first minter as `owner`, reported
// only as `legacyOwner`); a missing one is minted ownerless, the payer paying rent.
export async function ensureParcelAnchor({
    connection, payerKeypair, parcelId, metadataUri,
    parcelProgramId = PARCEL_PROGRAM_ID, sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!payerKeypair?.publicKey) throw new Error('payerKeypair is required');
    if (!parcelId) throw new Error('parcelId is required');
    if (!metadataUri) throw new Error('metadataUri is required');
    const parcel = deriveParcelAnchorPda(parcelId, parcelProgramId);
    const existing = await connection.getAccountInfo(parcel, 'confirmed');
    if (existing?.data) {
        const owner = decodeParcelOwner(existing.data);
        return {
            replayed: true, signature: null, parcelAccount: parcel.toBase58(),
            legacyOwner: owner.equals(web3.PublicKey.default) ? null : owner.toBase58()
        };
    }
    const signature = await sendInstruction(connection, buildMintParcelIx({
        parcelId, payer: payerKeypair.publicKey, metadataUri, parcelProgramId
    }), payerKeypair, sendAndConfirm);
    return { replayed: false, signature, parcelAccount: parcel.toBase58(), legacyOwner: null };
}

export { PARCEL_PROGRAM_ID, PROPOSAL_PROGRAM_ID };

// ---- retire: the proposer closing its own stale proposal ----------------------------------------
// Chain-read half and signing half of the daily proposer's retire phase (selection is pure, in
// run-policy.js planRetirements). Idempotence comes from the chain: every step is derived from the
// proposal, market and position accounts as they are now, never from a checkpoint flag.
// With a lifecycle lens member configured AND in the proposal's lens, the first step is `expire`
// (the member attests ProposalVerdict-v1 "expired", the proposer submits settle_with_verdict) instead
// of the author's `cancel`; both end in a NO market (Expired and Cancelled both resolve NO).

const RETIRE_READERS = {
    async readProposal(connection, proposalAccount) {
        const info = await connection.getAccountInfo(new web3.PublicKey(proposalAccount), 'confirmed');
        return info?.data ? decodeProposalState(info.data) : null;
    },
    readMarket: (connection, proposalAccount) => marketClient.readMarket(connection, proposalAccount),
    readPosition: (connection, proposalAccount, owner) => marketClient.readPosition(
        connection, proposalAccount, owner, marketClient.constants.SIDE_YES
    )
};

// What the owner's YES position pays once the market settles. A cancelled or expired proposal always
// resolves NO; with an empty NO pool the program refunds every position in full (payout_amount), and with
// NO stakers present the YES stake is simply lost — claiming would fail with NothingToClaim.
function yesPayoutAfterNo(market, position) {
    if (!market || !position || position.claimed) return 0n;
    const outcome = market.resolved ? market.outcome : marketClient.constants.SIDE_NO;
    return marketClient.payoutAmount(marketClient.constants.SIDE_YES, position.amount, market.yesPool, market.noPool, outcome);
}

/**
 * Read-only: which retire steps (cancel or expire, resolve, claim) this proposal still needs, in order.
 * `lifecycleMember` ({ key }) switches `cancel` to `expire` for proposals whose lens includes that key.
 * state: active | cancelled | expired | executed | retired | missing | foreign | status-N.
 */
export async function inspectRetirement({ connection, owner, proposal, readers = {}, lifecycleMember = null } = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!owner) throw new Error('owner is required');
    const read = { ...RETIRE_READERS, ...readers };
    const ownerKey = new web3.PublicKey(owner);
    const state = await read.readProposal(connection, proposal.proposalPda);
    if (!state) return { ...proposal, state: 'missing', steps: [], acceptedParcels: [] };
    const base = { ...proposal, acceptedParcels: state.acceptedParcels, lens: state.lens };
    if (!state.owner.equals(ownerKey)) return { ...base, state: 'foreign', steps: [] };
    if (state.status === STATUS_EXECUTED) return { ...base, state: 'executed', steps: [] };
    const terminalNo = state.status === STATUS_CANCELLED || state.status === STATUS_EXPIRED;
    if (state.status !== STATUS_ACTIVE && !terminalNo) return { ...base, state: `status-${state.status}`, steps: [] };
    const [market, position] = await Promise.all([
        read.readMarket(connection, proposal.proposalPda),
        read.readPosition(connection, proposal.proposalPda, ownerKey)
    ]);
    const payout = yesPayoutAfterNo(market, position);
    const expireByVerdict = Boolean(lifecycleMember?.key) && (state.lens || []).includes(lifecycleMember.key);
    const steps = [];
    if (state.status === STATUS_ACTIVE) steps.push(expireByVerdict ? 'expire' : 'cancel');
    if (market && !market.resolved) steps.push('resolve');
    if (payout > 0n) steps.push('claim');
    const marketView = market ? {
        resolved: market.resolved, yesPool: String(market.yesPool), noPool: String(market.noPool)
    } : null;
    const positionView = position ? { amount: String(position.amount), claimed: position.claimed } : null;
    const terminalState = state.status === STATUS_EXPIRED ? 'expired' : 'cancelled';
    return {
        ...base,
        state: state.status === STATUS_ACTIVE ? 'active' : (steps.length ? terminalState : 'retired'),
        steps,
        market: marketView,
        position: positionView,
        expectedRefund: String(payout),
        ...(position && !position.claimed && payout === 0n ? { note: 'YES stake lost: the NO pool is not empty' } : {})
    };
}

/**
 * The `expire` step: ask the lifecycle lens member for an "expired" ProposalVerdict-v1 (operator
 * route, idempotent per source time) and submit it with settle_with_verdict. `sourceObservedAt` is
 * the instant the retire policy made the proposal expire (its run day + afterDays), not a fetch time.
 */
export async function expireWithVerdict({
    connection, submitterKeypair, proposalAccount, lifecycle, sourceObservedAt,
    fetchImpl = globalThis.fetch, requestVerdict = requestVerdictAttestation, settle = settleWithVerdict,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!lifecycle?.serviceUrl || !lifecycle?.key) throw new Error('lifecycle lens member (serviceUrl, key) is required');
    const verdict = await requestVerdict({
        serviceUrl: lifecycle.serviceUrl, operatorToken: lifecycle.operatorToken, proposalAccount: String(proposalAccount),
        verdict: 'expired', evidenceRef: lifecycle.evidenceRef ?? '', sourceObservedAt, fetchImpl
    });
    if (verdict.authority && verdict.authority !== lifecycle.key) {
        throw new Error(`lifecycle member service signed as ${verdict.authority}, expected ${lifecycle.key}`);
    }
    const settled = await settle({
        connection, submitterKeypair, proposalAccount, verdictAttestation: verdict.address,
        member: lifecycle.key, credentialName: lifecycle.credentialName || DEFAULT_CREDENTIAL_NAME, sendAndConfirm
    });
    return { ...settled, verdictAttestation: verdict.address, verdictReused: Boolean(verdict.reused), sourceObservedAt };
}

/**
 * Sign the outstanding steps in order — cancel or expire → resolve → claim — each through `perform`
 * (the action engine, so it lands in the activity feed as 'cancel' | 'verdict' / 'resolve' / 'claim') and each
 * followed by `checkpoint(record)`. The claim is re-derived from the market after resolution.
 */
export async function executeRetirement({
    connection, ownerKeypair, item, perform, checkpoint, record = {}, readers = {}, adapters = {},
    lifecycle = null, sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair is required');
    if (typeof perform !== 'function' || typeof checkpoint !== 'function') throw new Error('perform and checkpoint are required');
    const read = { ...RETIRE_READERS, ...readers };
    const act = { cancelProposal, expireWithVerdict, resolveProposalMarket, claimProposalMarket, ...adapters };
    const proposalAccount = item.proposalPda;
    const current = {
        ...record, proposalId: item.proposalId, proposalPda: proposalAccount,
        sourceRunId: item.sourceRunId ?? null, sourceDay: item.sourceDay, ageDays: item.ageDays ?? null
    };
    if (item.steps.includes('expire')) {
        if (!lifecycle) throw new Error('expire step needs the lifecycle lens member config');
        const sourceObservedAt = expiryObservedAt(item.sourceDay, lifecycle.afterDays);
        current.expiry = await perform({ type: 'verdict', verdict: 'expired', proposalId: item.proposalId }, () => act.expireWithVerdict({
            connection, submitterKeypair: ownerKeypair, proposalAccount, lifecycle, sourceObservedAt, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    if (item.steps.includes('cancel')) {
        current.cancel = await perform({ type: 'cancel', proposalId: item.proposalId }, () => act.cancelProposal({
            connection, ownerKeypair, proposalAccount, sendAndConfirm
        }));
        await checkpoint({ ...current });
    }
    if (item.steps.includes('resolve')) {
        current.resolution = await perform({ type: 'resolve', proposalId: item.proposalId }, () => act.resolveProposalMarket({
            connection, resolverKeypair: ownerKeypair, proposalAccount, sendAndConfirm
        }));
        await checkpoint({ ...current });
        if (current.resolution?.outcome !== 'NO') throw new Error(`market resolved ${current.resolution?.outcome}; expected NO after cancel or expiry`);
    }
    if (item.steps.includes('claim')) {
        const [market, position] = await Promise.all([
            read.readMarket(connection, proposalAccount),
            read.readPosition(connection, proposalAccount, ownerKeypair.publicKey)
        ]);
        if (yesPayoutAfterNo(market, position) > 0n) {
            current.claim = await perform({ type: 'claim', proposalId: item.proposalId, side: 'yes' }, () => act.claimProposalMarket({
                connection, claimerKeypair: ownerKeypair, proposalAccount, side: 'yes', sendAndConfirm
            }));
        } else {
            current.claim = { skipped: true, reason: position?.claimed ? 'already-claimed' : 'nothing-to-claim', signature: null };
        }
        await checkpoint({ ...current });
    }
    return current;
}
