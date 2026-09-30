/**
 * Solana Parcel Anchor
 * Creates parcel anchors on the Solana ParcelNFT program (v2, one at a time): an ownerless PDA
 * seeded by the parcel id. The connected wallet only pays rent; it does not become an owner.
 */
(function () {
    const g = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!g) return;

    async function simulateTransactionOrThrow(connection, tx) {
        if (!connection || typeof connection.simulateTransaction !== 'function') return null;
        const simulation = await connection.simulateTransaction(tx, {
            sigVerify: false,
            replaceRecentBlockhash: false
        });
        const value = simulation && simulation.value ? simulation.value : simulation;
        if (value && value.err) {
            const err = new Error('Solana parcel anchor simulation failed.');
            err.code = 'SIMULATION_FAILED';
            err.simulationError = value.err;
            err.logs = value.logs || [];
            throw err;
        }
        return simulation;
    }

    async function signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight) {
        await simulateTransactionOrThrow(connection, tx);
        const signed = await provider.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (confirmation && confirmation.value && confirmation.value.err) {
            const err = new Error('Solana parcel anchor failed during confirmation.');
            err.code = 'CONFIRMATION_FAILED';
            err.confirmationError = confirmation.value.err;
            throw err;
        }
        return signature;
    }

    async function mintParcelSolana(parcelId, metadataUri, programId, cluster) {
        if (!g.solanaWeb3 || !g.solanaWalletManager) throw new Error('Solana not available');
        const provider = g.solanaWalletManager.getProvider();
        const wallet = provider?.publicKey;
        if (!wallet) throw new Error('Connect Solana wallet');

        const loader = g.SolanaChainDataLoader;
        if (!loader || typeof loader.getConnection !== 'function') {
            throw new Error('Solana chain data loader not available');
        }

        const connection = loader.getConnection(cluster);
        // v2 MintParcel accounts: parcel (PDA, mut), payer (signer, mut), system_program.
        const { parcel: parcelPda, instruction } = g.SolanaAcceptanceClient.buildMintParcelIx({
            parcelId, metadataUri, payer: wallet, programId
        });

        if (typeof loader.getParcelMintStatus === 'function') {
            const existing = await loader.getParcelMintStatus(parcelId, programId, cluster, { forceRefresh: true });
            if (existing && existing.minted) {
                if (typeof loader.setParcelMintStatusCache === 'function') {
                    loader.setParcelMintStatusCache(parcelId, programId, cluster, existing);
                }
                return { txHash: null, tokenId: parcelPda.toString(), alreadyMinted: true };
            }
        }

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new g.solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.add(instruction);

        const signature = await signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight);
        if (typeof loader.setParcelMintStatusCache === 'function') {
            loader.setParcelMintStatusCache(parcelId, programId, cluster, {
                minted: true,
                tokenId: parcelPda.toString(),
                owner: g.SolanaAcceptanceClient.constants.DEFAULT_PUBKEY, // anchors are ownerless
                metadataURI: metadataUri
            });
        }
        return { txHash: signature, tokenId: parcelPda.toString() };
    }

    g.mintParcelSolana = mintParcelSolana;
})();
