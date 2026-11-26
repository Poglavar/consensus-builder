/**
 * Solana Parcel Anchors
 * Creates parcel anchors on the Solana parcel_nft program (v2): ownerless PDAs seeded by the parcel id
 * whose URI is the parcel's page (ParcelAnchor.anchorUri; nothing is pinned). The connected wallet only
 * pays rent; nobody owns an anchor. Parcels already anchored are skipped, the rest go several to a
 * transaction (SolanaParcelClient.packMintParcelInstructions), all signed with one wallet approval when
 * the wallet signs several at once (signAllTransactions). window.SolanaParcelAnchors: the parcel
 * panel's "Anchor on chain" (parcels/ui/claim.js) calls anchorParcels; the agreement mint
 * (agreement-bridge.js) takes instructionGroups for its input parcels.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SolanaParcelAnchors = api;
})(typeof window !== 'undefined' ? window : globalThis, function (g) {
    'use strict';

    const parcelAnchor = () => g.ParcelAnchor || require('../parcels/parcel-anchor.js');
    const parcelClient = () => g.SolanaParcelClient || require('./parcel-client.js');
    const coded = (message, code, extra = {}) => Object.assign(new Error(message), { code }, extra);

    /**
     * The anchors `parcelIds` still need, as mint_parcel instruction groups that each fit one
     * transaction: { groups: [{ parcelIds, instructions }], alreadyAnchored: [ids], skipped: [{ parcelId, reason }] }.
     * An id that cannot seed an anchor (over 32 bytes) is in `skipped`, never fatal.
     */
    async function instructionGroups({ connection, wallet, parcelIds, programId }) {
        const { parcels, skipped } = parcelAnchor().anchorTargets(parcelIds);
        const client = parcelClient();
        const missing = new Set(await client.missingParcelAnchors(connection, parcels.map(row => row.anchorId), { programId }));
        const batches = client.packMintParcelInstructions(parcels.filter(row => missing.has(row.anchorId))
            .map(row => ({ parcelId: row.anchorId, metadataUri: row.metadataUri })), { payer: wallet, programId });
        return {
            groups: batches.map(batch => ({ parcelIds: batch.map(row => row.parcelId), instructions: batch.map(row => row.instruction) })),
            alreadyAnchored: parcels.filter(row => !missing.has(row.anchorId)).map(row => row.anchorId),
            skipped
        };
    }

    async function simulateOrThrow(connection, transaction) {
        // A legacy Transaction goes to web3.js 1.x's (transaction, signers?) overload: a config object
        // there throws "Invalid arguments" before anything is signed. No signers: an unsigned simulation.
        const simulation = await connection.simulateTransaction(transaction);
        const value = simulation && simulation.value ? simulation.value : simulation;
        if (value && value.err) throw coded('Solana parcel anchor simulation failed.', 'SIMULATION_FAILED', { simulationError: value.err, logs: value.logs || [] });
    }

    /**
     * Simulates, signs, sends and confirms one transaction per instruction group, in order. With a
     * wallet that signs several at once, every transaction is signed with one approval first; otherwise
     * each is signed (with a fresh blockhash) just before it is sent. `onSent(index, signature)` reports
     * each confirmed one. Resolves the signatures.
     */
    async function sendInstructionGroups({ connection, provider, wallet, groups, onSent = null }) {
        const web3 = g.solanaWeb3;
        const build = (instructions, latest) => {
            const transaction = new web3.Transaction({ feePayer: wallet, recentBlockhash: latest.blockhash });
            instructions.forEach(instruction => transaction.add(instruction));
            return transaction;
        };
        const signsAll = groups.length > 1 && typeof provider.signAllTransactions === 'function';
        let latest = await connection.getLatestBlockhash('confirmed');
        const transactions = groups.map(instructions => build(instructions, latest));
        for (const transaction of transactions) await simulateOrThrow(connection, transaction);
        const presigned = signsAll ? await provider.signAllTransactions(transactions) : null;
        const signatures = [];
        for (let index = 0; index < transactions.length; index += 1) {
            let signed = presigned && presigned[index];
            if (!signed) {
                if (index > 0) latest = await connection.getLatestBlockhash('confirmed');
                signed = await provider.signTransaction(index > 0 ? build(groups[index], latest) : transactions[index]);
            }
            const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
            const confirmation = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
            if (confirmation && confirmation.value && confirmation.value.err) {
                throw coded('Solana parcel anchor failed during confirmation.', 'CONFIRMATION_FAILED', { confirmationError: confirmation.value.err, signature, signatures });
            }
            signatures.push(signature);
            if (onSent) onSent(index, signature);
        }
        return signatures;
    }

    /**
     * Anchors `parcelIds` with the connected Solana wallet as the parcel panel's "Anchor on chain" does.
     * `onProgress({ done, total })` follows the confirmed transactions. Resolves { anchoredParcelIds
     * (newly anchored and already anchored), transactions: [{ parcelIds, txHash }], alreadyAnchored, skipped }.
     */
    async function anchorParcels(parcelIds, { programId, cluster, onProgress = null } = {}) {
        if (!g.solanaWeb3 || !g.solanaWalletManager) throw new Error('Solana not available');
        const provider = g.solanaWalletManager.getProvider();
        const wallet = provider?.publicKey;
        if (!wallet) throw new Error('Connect Solana wallet');
        const loader = g.SolanaChainDataLoader;
        if (!loader || typeof loader.getConnection !== 'function') throw new Error('Solana chain data loader not available');
        const connection = loader.getConnection(cluster);
        const payer = new g.solanaWeb3.PublicKey(wallet.toBase58 ? wallet.toBase58() : String(wallet));
        const { groups, alreadyAnchored, skipped } = await instructionGroups({ connection, wallet: payer, parcelIds, programId });
        const total = groups.reduce((sum, group) => sum + group.parcelIds.length, 0);
        const transactions = [];
        let done = 0;
        const cache = (parcelId, minted) => {
            if (typeof loader.setParcelMintStatusCache !== 'function') return;
            loader.setParcelMintStatusCache(parcelId, programId, cluster, minted
                ? { minted: true, tokenId: parcelClient().getParcelPda(parcelId, programId)[0].toString(), owner: parcelClient().constants.DEFAULT_PUBKEY, metadataURI: parcelAnchor().anchorUri(parcelId) }
                : { minted: false });
        };
        alreadyAnchored.forEach(parcelId => cache(parcelId, true));
        if (groups.length) {
            if (onProgress) onProgress({ done, total });
            try {
                await sendInstructionGroups({ connection, provider, wallet: payer, groups: groups.map(group => group.instructions),
                    onSent: (index, signature) => {
                        const group = groups[index];
                        transactions.push({ parcelIds: group.parcelIds, txHash: signature });
                        group.parcelIds.forEach(parcelId => cache(parcelId, true));
                        done += group.parcelIds.length;
                        if (onProgress) onProgress({ done, total });
                    } });
            } catch (error) {
                // What was anchored before the failure stays anchored; a retry skips it.
                throw Object.assign(error, { anchoredParcelIds: [...alreadyAnchored, ...transactions.flatMap(row => row.parcelIds)], transactions, skipped });
            }
        }
        return {
            anchoredParcelIds: [...alreadyAnchored, ...transactions.flatMap(row => row.parcelIds)],
            transactions,
            alreadyAnchored,
            skipped
        };
    }

    return { instructionGroups, sendInstructionGroups, anchorParcels };
});
