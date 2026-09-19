// Node signer adapter for a soft proposal pledge. It records or updates one public commitment per
// agent/proposal without moving USDC; fulfilment remains a separate agent-signed transaction.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const supportClient = require('../../frontend/js/solana/pledge-client.js');
supportClient.configure({ web3 });

export async function ensurePledgeBookAndSet({
    connection,
    pledgerKeypair,
    proposalPda,
    amountAtomic,
    programId,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!pledgerKeypair?.publicKey) throw new Error('pledgerKeypair is required');
    if (!proposalPda) throw new Error('proposalPda is required');
    if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n) throw new Error('amountAtomic must be a positive bigint');

    const owner = pledgerKeypair.publicKey;
    const [bookPda] = supportClient.getPledgeBookPda(proposalPda, programId);
    const [commitmentPda] = supportClient.getPledgeCommitmentPda(bookPda, owner, programId);
    const existing = await supportClient.readPledgeCommitment(connection, proposalPda, owner, programId);
    if (existing?.status === supportClient.constants.PLEDGE_ACTIVE && existing.amount === amountAtomic) {
        return { bookPda: bookPda.toBase58(), commitmentPda: commitmentPda.toBase58(), created: false, replayed: true, signature: null };
    }
    if (existing?.status === supportClient.constants.PLEDGE_FULFILLED) throw new Error('fulfilled pledge cannot be changed');

    const book = await supportClient.readPledgeBook(connection, proposalPda, programId);
    const transaction = new web3.Transaction();
    if (!book) transaction.add(supportClient.buildCreatePledgeBookIx({ proposal: proposalPda, creator: owner, programId }));
    transaction.add(supportClient.buildSetPledgeIx({ proposal: proposalPda, pledger: owner, amount: amountAtomic, programId }));
    transaction.feePayer = owner;
    const signature = await sendAndConfirm(connection, transaction, [pledgerKeypair], { commitment: 'confirmed' });
    return { bookPda: bookPda.toBase58(), commitmentPda: commitmentPda.toBase58(), created: !book, replayed: false, signature };
}

export async function fulfillPledge({
    connection, pledgerKeypair, proposalPda, programId,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!pledgerKeypair?.publicKey) throw new Error('pledgerKeypair is required');
    const book = await supportClient.readPledgeBook(connection, proposalPda, programId);
    if (!book) throw new Error('pledge book does not exist');
    const transaction = new web3.Transaction().add(supportClient.buildFulfillPledgeIx({
        proposal: proposalPda, pledger: pledgerKeypair.publicKey, beneficiary: book.beneficiary, programId
    }));
    transaction.feePayer = pledgerKeypair.publicKey;
    return sendAndConfirm(connection, transaction, [pledgerKeypair], { commitment: 'confirmed' });
}
