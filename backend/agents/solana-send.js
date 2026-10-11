// Send a Solana transaction and confirm it by POLLING getSignatureStatuses over plain HTTP.
// web3's sendAndConfirmTransaction confirms through a signatureSubscribe WebSocket; RPC providers
// without that method (Alchemy devnet, 2026-09-16) make it wait until the blockhash expires and then
// report "expired" for a transaction that had long since finalized. The runner's minter and bettor
// take this function through their sendAndConfirm seam instead. A retry always sends the SAME
// signed bytes/signature. Never refresh the blockhash after an ambiguous send: that could pay twice.

import { getBase58Decoder } from '@solana/kit';
import { setTimeout as delay } from 'node:timers/promises';

function sleep(ms) {
    return delay(ms);
}

function transientSendError(error) {
    return [-32603, -32004, -32005, -32016].includes(error?.code)
        || /\b(?:408|429|50[0-9]|52[0-9])\b|fetch failed|failed to fetch|timeout|timed out|socket|ECONN|EAI_AGAIN|ENETUNREACH/i.test(error?.message || '');
}

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').Transaction} transaction
 * @param {import('@solana/web3.js').Signer[]} signers first signer pays the fee
 * @param {{ commitment?: 'confirmed'|'finalized', pollMs?: number, maxMs?: number,
 *           broadcastAttempts?: number, rebroadcastMs?: number }} [options]
 * @returns {Promise<string>} the signature, once it has reached `commitment`
 */
export async function sendAndConfirmPolling(connection, transaction, signers, {
    commitment = 'confirmed', pollMs = 1500, maxMs = 120000,
    broadcastAttempts = 3, rebroadcastMs = 5000, now = Date.now, wait = sleep
} = {}) {
    if (!signers?.length) throw new Error('sendAndConfirmPolling: at least one signer is required');
    if (!Number.isInteger(broadcastAttempts) || broadcastAttempts < 1 || broadcastAttempts > 5) throw new Error('broadcastAttempts must be between 1 and 5');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = signers[0].publicKey;
    transaction.sign(...signers);
    const raw = transaction.serialize();
    const signature = getBase58Decoder().decode(transaction.signature);
    const started = now();
    let broadcasts = 0;
    let lastBroadcast = started;
    let sendError = null;
    const broadcast = async () => {
        broadcasts += 1;
        lastBroadcast = now();
        try {
            const receivedSignature = await connection.sendRawTransaction(raw, {
                skipPreflight: false,
                preflightCommitment: commitment,
                maxRetries: 3
            });
            if (receivedSignature !== signature) throw new Error('RPC returned a different transaction signature');
            sendError = null;
        } catch (error) {
            // The response may have been lost after the node accepted the transaction. Check its
            // locally known signature before interpreting any RPC error as a failed operation.
            sendError = error;
        }
    };
    await broadcast();
    const reached = (status) => status && (status.confirmationStatus === 'finalized' || status.confirmationStatus === commitment
        || (commitment === 'confirmed' && status.confirmationStatus === 'confirmed'));
    const readStatus = async () => {
        const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const status = value?.[0] ?? null;
        if (status?.err) throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`);
        return status;
    };
    for (;;) {
        const status = await readStatus();
        if (reached(status)) return signature;
        if (sendError && !status && !transientSendError(sendError)) throw sendError;

        const height = await connection.getBlockHeight(commitment);
        if (height > lastValidBlockHeight) {
            // The blockhash is dead; one last look so a confirmation that arrived while we asked for
            // the height is not misreported as expiry.
            if (reached(await readStatus())) return signature;
            throw new Error(`transaction ${signature} expired: block height ${height} > ${lastValidBlockHeight} without confirmation`);
        }
        if (now() - started > maxMs) {
            throw new Error(`transaction ${signature} not confirmed after ${maxMs} ms (status ${status?.confirmationStatus ?? 'none'}) — check the explorer before retrying`);
        }
        if (!status && broadcasts < broadcastAttempts && now() - lastBroadcast >= rebroadcastMs) {
            await broadcast();
        }
        await wait(pollMs);
    }
}
