// Shared Node signer adapters for terminal proposal/support/market actions. Browser wallets, MCP
// agents and deterministic runners use the same instruction codecs; these functions add only
// read-before-write idempotence and transaction submission.
import { createRequire } from 'node:module';
import { instructionDiscriminator } from './minter.js';
import { donationIdBytes } from './donor.js';
import { STATUS_CANCELLED, STATUS_EXECUTED } from '../oracle/proposal-lifecycle.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const supportClient = require('../../frontend/js/solana/pledge-client.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
supportClient.configure({ web3 });
marketClient.configure({ web3 });

const PROPOSAL_PROGRAM_ID = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const PARCEL_PROGRAM_ID = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';

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
    return { owner, parcelIds, isConditional, imageUri, acceptancePossible, status, acceptedParcels };
}

export function decodeParcelOwner(data) {
    const bytes = Buffer.from(data || []);
    const state = { offset: 8 };
    readString(bytes, state);
    readString(bytes, state);
    if (state.offset + 32 > bytes.length) throw new Error('parcel account has no owner');
    return new web3.PublicKey(bytes.subarray(state.offset, state.offset + 32));
}

async function sendInstruction(connection, instruction, signer, sendAndConfirm) {
    const transaction = new web3.Transaction().add(instruction);
    transaction.feePayer = signer.publicKey;
    return sendAndConfirm(connection, transaction, [signer], { commitment: 'confirmed' });
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

export function buildAcceptProposalIx({
    proposalAccount, parcelId, accepter,
    programId = PROPOSAL_PROGRAM_ID, parcelProgramId = PARCEL_PROGRAM_ID
} = {}) {
    const parcelProgram = new web3.PublicKey(parcelProgramId);
    const [parcel] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from('parcel'), Buffer.from(String(parcelId))], parcelProgram
    );
    return new web3.TransactionInstruction({
        programId: new web3.PublicKey(programId),
        keys: [
            { pubkey: new web3.PublicKey(proposalAccount), isSigner: false, isWritable: true },
            { pubkey: parcel, isSigner: false, isWritable: false },
            { pubkey: parcelProgram, isSigner: false, isWritable: false },
            { pubkey: new web3.PublicKey(accepter), isSigner: true, isWritable: false }
        ],
        data: Buffer.concat([Buffer.from(instructionDiscriminator('accept_proposal')), borshString(parcelId)])
    });
}

export async function acceptProposal({
    connection, accepterKeypair, proposalAccount, parcelId,
    programId = PROPOSAL_PROGRAM_ID, parcelProgramId = PARCEL_PROGRAM_ID,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!accepterKeypair?.publicKey) throw new Error('accepterKeypair is required');
    if (!parcelId) throw new Error('parcelId is required');
    const proposalInfo = await connection.getAccountInfo(new web3.PublicKey(proposalAccount), 'confirmed');
    if (!proposalInfo?.data) throw new Error('proposal account does not exist');
    const proposal = decodeProposalState(proposalInfo.data);
    if (proposal.acceptedParcels.includes(String(parcelId))) {
        return { replayed: true, signature: null, accepted: true, executed: proposal.status === STATUS_EXECUTED };
    }
    if (proposal.status !== 0 || !proposal.acceptancePossible) throw new Error('proposal is not accepting parcels');
    if (!proposal.parcelIds.includes(String(parcelId))) throw new Error('parcel is not part of this proposal');
    const parcelProgram = new web3.PublicKey(parcelProgramId);
    const [parcel] = web3.PublicKey.findProgramAddressSync([Buffer.from('parcel'), Buffer.from(String(parcelId))], parcelProgram);
    const parcelInfo = await connection.getAccountInfo(parcel, 'confirmed');
    if (!parcelInfo?.data) throw new Error('parcel ownership certificate does not exist');
    const parcelOwner = decodeParcelOwner(parcelInfo.data);
    if (!parcelOwner.equals(accepterKeypair.publicKey)) throw new Error('signer is not the on-chain parcel owner');
    const signature = await sendInstruction(connection, buildAcceptProposalIx({
        proposalAccount, parcelId, accepter: accepterKeypair.publicKey, programId, parcelProgramId
    }), accepterKeypair, sendAndConfirm);
    return { replayed: false, signature, accepted: true };
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

export { PARCEL_PROGRAM_ID, PROPOSAL_PROGRAM_ID };
