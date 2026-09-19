// Node signer adapter for funded proposal donations. A stable operation id produces an immutable
// receipt PDA, making agent retries read-before-write idempotent without taking backend custody.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const supportClient = require('../../frontend/js/solana/pledge-client.js');
supportClient.configure({ web3 });

export function donationIdBytes(operationId) {
    if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('operationId is required');
    return new Uint8Array(createHash('sha256').update(operationId).digest());
}

export async function ensureDonationEscrowAndDonate({
    connection,
    donorKeypair,
    proposalPda,
    amountAtomic,
    operationId,
    programId,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!donorKeypair?.publicKey) throw new Error('donorKeypair is required');
    if (!proposalPda) throw new Error('proposalPda is required');
    if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n) throw new Error('amountAtomic must be a positive bigint');

    const donationId = donationIdBytes(operationId);
    const owner = donorKeypair.publicKey;
    const [escrowPda] = supportClient.getDonationEscrowPda(proposalPda, programId);
    const [positionPda] = supportClient.getDonationPositionPda(escrowPda, owner, donationId, programId);
    const existing = await supportClient.readDonationPosition(connection, proposalPda, owner, donationId, programId);
    if (existing) {
        if (existing.amount !== amountAtomic) throw new Error('operationId already exists with a different donation amount');
        return { escrowPda: escrowPda.toBase58(), positionPda: positionPda.toBase58(), created: false, replayed: true, signature: null };
    }

    const escrow = await supportClient.readDonationEscrow(connection, proposalPda, programId);
    const transaction = new web3.Transaction();
    if (!escrow) transaction.add(supportClient.buildCreateDonationEscrowIx({ proposal: proposalPda, creator: owner, programId }));
    transaction.add(supportClient.buildDonateIx({ proposal: proposalPda, donor: owner, donationId, amount: amountAtomic, programId }));
    transaction.feePayer = owner;
    const signature = await sendAndConfirm(connection, transaction, [donorKeypair], { commitment: 'confirmed' });
    return { escrowPda: escrowPda.toBase58(), positionPda: positionPda.toBase58(), created: !escrow, replayed: false, signature };
}
