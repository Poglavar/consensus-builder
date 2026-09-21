#!/usr/bin/env node
// Repeatable devnet proof for both proposal-support outcomes:
//   Cancelled -> donation refunded, pledge voided
//   Executed  -> donation released, pledge fulfilled
// The script uses a temporary supporter wallet so the token movement is observable. It refuses to
// write unless --live is present and prints one JSON proof object containing every transaction.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mintProposal } from '../../../backend/agents/minter.js';
import { ensureDonationEscrowAndDonate } from '../../../backend/agents/donor.js';
import { ensurePledgeBookAndSet } from '../../../backend/agents/pledger.js';
import { sendAndConfirmPolling } from '../../../backend/agents/solana-send.js';

const solanaRequire = createRequire(new URL('../package.json', import.meta.url));
const localRequire = createRequire(import.meta.url);
const {
    Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction
} = solanaRequire('@solana/web3.js');
const {
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
    getAssociatedTokenAddressSync
} = solanaRequire('@solana/spl-token');
const support = localRequire('../../../frontend/js/solana/pledge-client.js');
support.configure({ web3: { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } });

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROPOSAL_PROGRAM = new PublicKey('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg');
const PARCEL_PROGRAM = new PublicKey('4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1');
const SUPPORT_PROGRAM = new PublicKey(support.constants.PROGRAM_ID);
const USDC_MINT = new PublicKey(support.constants.USDC_DEVNET_MINT);
const EXECUTION_PARCEL = process.env.SUPPORT_DEMO_PARCEL || 'TEST-PARCEL-001';
const AMOUNT = 10_000n; // 0.01 USDC per action

function expandHome(value) {
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function loadKeypair(file) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(file), 'utf8'))));
}

function discriminator(name) {
    return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function borshString(value) {
    const text = Buffer.from(String(value), 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32LE(text.length);
    return Buffer.concat([size, text]);
}

function explorer(signature) {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function cancelInstruction(proposal, owner) {
    return new TransactionInstruction({
        programId: PROPOSAL_PROGRAM,
        keys: [
            { pubkey: new PublicKey(proposal), isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: true, isWritable: true }
        ],
        data: discriminator('cancel_and_refund')
    });
}

function acceptInstruction(proposal, parcelId, accepter) {
    const [parcel] = PublicKey.findProgramAddressSync(
        [Buffer.from('parcel'), Buffer.from(parcelId)], PARCEL_PROGRAM
    );
    return new TransactionInstruction({
        programId: PROPOSAL_PROGRAM,
        keys: [
            { pubkey: new PublicKey(proposal), isSigner: false, isWritable: true },
            { pubkey: parcel, isSigner: false, isWritable: false },
            { pubkey: PARCEL_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: accepter, isSigner: true, isWritable: false }
        ],
        data: Buffer.concat([discriminator('accept_proposal'), borshString(parcelId)])
    });
}

function readProposalStatus(data) {
    let offset = 8 + 8 + 32;
    const parcelCount = data.readUInt32LE(offset); offset += 4;
    for (let index = 0; index < parcelCount; index += 1) {
        const length = data.readUInt32LE(offset); offset += 4 + length;
    }
    offset += 1;
    const uriLength = data.readUInt32LE(offset); offset += 4 + uriLength;
    offset += 1;
    return data[offset];
}

async function tokenBalance(connection, account) {
    const response = await connection.getTokenAccountBalance(account, 'confirmed');
    return BigInt(response.value.amount);
}

async function send(connection, transaction, signers) {
    return sendAndConfirmPolling(connection, transaction, signers, { commitment: 'confirmed' });
}

async function createSupport(connection, supporter, proposal, label) {
    const operationId = `lifecycle:${label}:${proposal}:${randomUUID()}`;
    const donation = await ensureDonationEscrowAndDonate({
        connection, donorKeypair: supporter, proposalPda: proposal, amountAtomic: AMOUNT,
        operationId, programId: SUPPORT_PROGRAM, sendAndConfirm: sendAndConfirmPolling
    });
    const pledge = await ensurePledgeBookAndSet({
        connection, pledgerKeypair: supporter, proposalPda: proposal, amountAtomic: AMOUNT,
        programId: SUPPORT_PROGRAM, sendAndConfirm: sendAndConfirmPolling
    });
    return { operationId, donation, pledge };
}

async function main() {
    if (!process.argv.includes('--live')) {
        throw new Error('Refusing to submit devnet transactions without --live');
    }
    const owner = loadKeypair(process.env.SOLANA_KEYPAIR || '~/.config/solana/id.json');
    const supporter = Keypair.generate();
    const connection = new Connection(RPC_URL, 'confirmed');
    const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey);
    const supporterAta = getAssociatedTokenAddressSync(USDC_MINT, supporter.publicKey);

    const setup = new Transaction()
        .add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: supporter.publicKey, lamports: 150_000_000 }))
        .add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, supporterAta, supporter.publicKey, USDC_MINT))
        .add(createTransferCheckedInstruction(ownerAta, USDC_MINT, supporterAta, owner.publicKey, Number(AMOUNT * 4n), 6));
    const setupSignature = await send(connection, setup, [owner]);
    const supporterInitial = await tokenBalance(connection, supporterAta);

    const cancelledMint = await mintProposal({
        connection, programId: PROPOSAL_PROGRAM, ownerKeypair: owner,
        parcelIds: [`SUPPORT-CANCEL-${Date.now()}`], imageUri: 'https://urbangametheory.xyz/#support-cancelled',
        lens: [owner.publicKey], sendAndConfirm: sendAndConfirmPolling
    });
    const cancelledSupport = await createSupport(connection, supporter, cancelledMint.proposalPda, 'cancelled');
    const cancelSignature = await send(connection, new Transaction().add(
        cancelInstruction(cancelledMint.proposalPda, owner.publicKey)
    ), [owner]);
    const cancelDonationId = createHash('sha256').update(cancelledSupport.operationId).digest();
    const refundSignature = await send(connection, new Transaction().add(support.buildRefundDonationIx({
        proposal: cancelledMint.proposalPda, donor: supporter.publicKey,
        donationId: cancelDonationId, programId: SUPPORT_PROGRAM
    })), [supporter]);
    const voidSignature = await send(connection, new Transaction().add(support.buildVoidPledgeIx({
        proposal: cancelledMint.proposalPda, pledger: supporter.publicKey, programId: SUPPORT_PROGRAM
    })), [owner]);

    const executedMint = await mintProposal({
        connection, programId: PROPOSAL_PROGRAM, ownerKeypair: owner,
        parcelIds: [EXECUTION_PARCEL], imageUri: 'https://urbangametheory.xyz/#support-executed',
        lens: [owner.publicKey], sendAndConfirm: sendAndConfirmPolling
    });
    const executedSupport = await createSupport(connection, supporter, executedMint.proposalPda, 'executed');
    const acceptSignature = await send(connection, new Transaction().add(
        acceptInstruction(executedMint.proposalPda, EXECUTION_PARCEL, owner.publicKey)
    ), [owner]);
    const executedEscrow = await support.readDonationEscrow(connection, executedMint.proposalPda, SUPPORT_PROGRAM);
    const releaseSignature = await send(connection, new Transaction().add(support.buildReleaseDonationsIx({
        proposal: executedMint.proposalPda, releaser: owner.publicKey,
        beneficiary: executedEscrow.beneficiary, programId: SUPPORT_PROGRAM
    })), [owner]);
    const executedBook = await support.readPledgeBook(connection, executedMint.proposalPda, SUPPORT_PROGRAM);
    const fulfillSignature = await send(connection, new Transaction().add(support.buildFulfillPledgeIx({
        proposal: executedMint.proposalPda, pledger: supporter.publicKey,
        beneficiary: executedBook.beneficiary, programId: SUPPORT_PROGRAM
    })), [supporter]);

    const [cancelledProposalInfo, executedProposalInfo] = await Promise.all([
        connection.getAccountInfo(new PublicKey(cancelledMint.proposalPda), 'confirmed'),
        connection.getAccountInfo(new PublicKey(executedMint.proposalPda), 'confirmed')
    ]);
    const [cancelledEscrow, cancelledPosition, cancelledCommitment, finalExecutedEscrow, executedCommitment] = await Promise.all([
        support.readDonationEscrow(connection, cancelledMint.proposalPda, SUPPORT_PROGRAM),
        support.readDonationPosition(connection, cancelledMint.proposalPda, supporter.publicKey, cancelDonationId, SUPPORT_PROGRAM),
        support.readPledgeCommitment(connection, cancelledMint.proposalPda, supporter.publicKey, SUPPORT_PROGRAM),
        support.readDonationEscrow(connection, executedMint.proposalPda, SUPPORT_PROGRAM),
        support.readPledgeCommitment(connection, executedMint.proposalPda, supporter.publicKey, SUPPORT_PROGRAM)
    ]);
    const supporterFinal = await tokenBalance(connection, supporterAta);

    const proof = {
        generatedAt: new Date().toISOString(), cluster: 'devnet', rpcUrl: RPC_URL,
        programs: { proposal: PROPOSAL_PROGRAM.toBase58(), support: SUPPORT_PROGRAM.toBase58() },
        owner: owner.publicKey.toBase58(), supporter: supporter.publicKey.toBase58(), amountAtomic: AMOUNT.toString(),
        balances: { supporterInitialAtomic: supporterInitial.toString(), supporterFinalAtomic: supporterFinal.toString() },
        setup: { signature: setupSignature, explorer: explorer(setupSignature) },
        cancelled: {
            proposal: cancelledMint.proposalPda, status: readProposalStatus(cancelledProposalInfo.data),
            totals: {
                donatedAtomic: cancelledEscrow.totalDonated.toString(), refundedAtomic: cancelledEscrow.totalRefunded.toString(),
                donationRefunded: cancelledPosition.refunded, pledgeStatus: cancelledCommitment.status
            },
            transactions: {
                mint: cancelledMint.signature, donate: cancelledSupport.donation.signature,
                pledge: cancelledSupport.pledge.signature, cancel: cancelSignature,
                refund: refundSignature, voidPledge: voidSignature
            }
        },
        executed: {
            proposal: executedMint.proposalPda, status: readProposalStatus(executedProposalInfo.data),
            totals: {
                donatedAtomic: finalExecutedEscrow.totalDonated.toString(), releasedAtomic: finalExecutedEscrow.totalReleased.toString(),
                donationsReleased: finalExecutedEscrow.released, pledgeStatus: executedCommitment.status
            },
            transactions: {
                mint: executedMint.signature, donate: executedSupport.donation.signature,
                pledge: executedSupport.pledge.signature, accept: acceptSignature,
                release: releaseSignature, fulfillPledge: fulfillSignature
            }
        }
    };

    if (proof.cancelled.status !== 2 || !proof.cancelled.totals.donationRefunded
        || proof.cancelled.totals.pledgeStatus !== support.constants.PLEDGE_VOIDED) {
        throw new Error(`cancelled lifecycle did not settle: ${JSON.stringify(proof.cancelled)}`);
    }
    if (proof.executed.status !== 1 || !proof.executed.totals.donationsReleased
        || proof.executed.totals.pledgeStatus !== support.constants.PLEDGE_FULFILLED) {
        throw new Error(`executed lifecycle did not settle: ${JSON.stringify(proof.executed)}`);
    }
    console.log(JSON.stringify(proof, null, 2));
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
});
