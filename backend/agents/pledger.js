// Node signer adapter for proposal_pledge. The shared codec builds the bytes; this module adds a
// keypair, a stable logical operation id and read-before-write retry semantics.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const pledgeClient = require('../../frontend/js/solana/pledge-client.js');
pledgeClient.configure({ web3 });

export function pledgeIdBytes(operationId) {
    if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('operationId is required');
    return new Uint8Array(createHash('sha256').update(operationId).digest());
}

/** Create an escrow when absent and deposit one idempotent logical pledge in a single transaction. */
export async function ensureEscrowAndPledge({
    connection,
    pledgerKeypair,
    proposalPda,
    amountAtomic,
    operationId,
    pledgeMint = pledgeClient.constants.USDC_DEVNET_MINT,
    programId,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!pledgerKeypair?.publicKey) throw new Error('pledgerKeypair is required');
    if (!proposalPda) throw new Error('proposalPda is required');
    if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n) throw new Error('amountAtomic must be a positive bigint');

    const pledgeId = pledgeIdBytes(operationId);
    const owner = pledgerKeypair.publicKey;
    const [escrowPda] = pledgeClient.getEscrowPda(proposalPda, programId);
    const [positionPda] = pledgeClient.getPositionPda(escrowPda, owner, pledgeId, programId);
    const existingPosition = await pledgeClient.readPosition(connection, proposalPda, owner, pledgeId, programId);
    if (existingPosition) {
        if (existingPosition.amount !== amountAtomic) {
            throw new Error('operationId already exists with a different pledge amount');
        }
        return {
            escrowPda: escrowPda.toBase58(), positionPda: positionPda.toBase58(),
            created: false, replayed: true, signature: null
        };
    }

    const escrow = await pledgeClient.readEscrow(connection, proposalPda, programId);
    const transaction = new web3.Transaction();
    if (!escrow) {
        transaction.add(pledgeClient.buildCreateEscrowIx({
            proposal: proposalPda, pledgeMint, creator: owner, programId
        }));
    }
    transaction.add(pledgeClient.buildPledgeIx({
        proposal: proposalPda, pledgeMint, pledger: owner, pledgeId, amount: amountAtomic, programId
    }));
    transaction.feePayer = owner;
    const signature = await sendAndConfirm(connection, transaction, [pledgerKeypair], { commitment: 'confirmed' });
    return {
        escrowPda: escrowPda.toBase58(), positionPda: positionPda.toBase58(),
        created: !escrow, replayed: false, signature
    };
}
