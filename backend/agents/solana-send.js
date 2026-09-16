// Send a Solana transaction and confirm it by POLLING getSignatureStatuses over plain HTTP.
// web3's sendAndConfirmTransaction confirms through a signatureSubscribe WebSocket; RPC providers
// without that method (Alchemy devnet, 2026-09-16) make it wait until the blockhash expires and then
// report "expired" for a transaction that had long since finalized. The runner's minter and bettor
// take this function through their sendAndConfirm seam instead.

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').Transaction} transaction
 * @param {import('@solana/web3.js').Signer[]} signers first signer pays the fee
 * @param {{ commitment?: 'confirmed'|'finalized', pollMs?: number, maxMs?: number }} [options]
 * @returns {Promise<string>} the signature, once it has reached `commitment`
 */
export async function sendAndConfirmPolling(connection, transaction, signers, { commitment = 'confirmed', pollMs = 1500, maxMs = 120000 } = {}) {
    if (!signers?.length) throw new Error('sendAndConfirmPolling: at least one signer is required');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = signers[0].publicKey;
    transaction.sign(...signers);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: commitment
    });

    const started = Date.now();
    const reached = (status) => status && (status.confirmationStatus === 'finalized' || status.confirmationStatus === commitment
        || (commitment === 'confirmed' && status.confirmationStatus === 'confirmed'));
    for (;;) {
        const { value } = await connection.getSignatureStatuses([signature]);
        const status = value?.[0] ?? null;
        if (status?.err) throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`);
        if (reached(status)) return signature;

        const height = await connection.getBlockHeight(commitment);
        if (height > lastValidBlockHeight) {
            // The blockhash is dead; one last look so a confirmation that arrived while we asked for
            // the height is not misreported as expiry.
            const { value: again } = await connection.getSignatureStatuses([signature]);
            if (reached(again?.[0])) return signature;
            throw new Error(`transaction ${signature} expired: block height ${height} > ${lastValidBlockHeight} without confirmation`);
        }
        if (Date.now() - started > maxMs) {
            throw new Error(`transaction ${signature} not confirmed after ${maxMs} ms (status ${status?.confirmationStatus ?? 'none'}) — check the explorer before retrying`);
        }
        await sleep(pollMs);
    }
}
