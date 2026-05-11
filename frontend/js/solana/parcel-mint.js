/**
 * Solana Parcel Mint
 * Mints parcels on Solana ParcelNFT program (one at a time)
 */
(function () {
    const g = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!g) return;

    async function sha256Discriminator(instructionName) {
        const str = `global:${instructionName}`;
        const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return new Uint8Array(hashBuffer).slice(0, 8);
    }

    function encodeBorshString(s) {
        const utf8 = new TextEncoder().encode(s);
        const lenBuf = new ArrayBuffer(4);
        new DataView(lenBuf).setUint32(0, utf8.length, true);
        const out = new Uint8Array(4 + utf8.length);
        out.set(new Uint8Array(lenBuf), 0);
        out.set(utf8, 4);
        return out;
    }

    async function simulateTransactionOrThrow(connection, tx) {
        if (!connection || typeof connection.simulateTransaction !== 'function') return null;
        const simulation = await connection.simulateTransaction(tx, {
            sigVerify: false,
            replaceRecentBlockhash: false
        });
        const value = simulation && simulation.value ? simulation.value : simulation;
        if (value && value.err) {
            const err = new Error('Solana parcel mint simulation failed.');
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
            const err = new Error('Solana parcel mint failed during confirmation.');
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
        const programKey = new g.solanaWeb3.PublicKey(programId);
        const [parcelPda] = g.solanaWeb3.PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('parcel'), new TextEncoder().encode(parcelId)],
            programKey
        );

        if (typeof loader.getParcelMintStatus === 'function') {
            const existing = await loader.getParcelMintStatus(parcelId, programId, cluster, { forceRefresh: true });
            if (existing && existing.minted) {
                if (typeof loader.setParcelMintStatusCache === 'function') {
                    loader.setParcelMintStatusCache(parcelId, programId, cluster, existing);
                }
                return { txHash: null, tokenId: parcelPda.toString(), alreadyMinted: true };
            }
        }

        const discriminator = await sha256Discriminator('mint_parcel');
        const pIdEnc = encodeBorshString(parcelId);
        const metaEnc = encodeBorshString(metadataUri);
        const ixData = new Uint8Array(8 + pIdEnc.length + metaEnc.length);
        ixData.set(discriminator, 0);
        ixData.set(pIdEnc, 8);
        ixData.set(metaEnc, 8 + pIdEnc.length);

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new g.solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.add(
            new g.solanaWeb3.TransactionInstruction({
                programId: programKey,
                keys: [
                    { pubkey: parcelPda, isSigner: false, isWritable: true },
                    { pubkey: wallet, isSigner: true, isWritable: true },
                    { pubkey: g.solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false }
                ],
                data: ixData
            })
        );

        const signature = await signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight);
        if (typeof loader.setParcelMintStatusCache === 'function') {
            loader.setParcelMintStatusCache(parcelId, programId, cluster, {
                minted: true,
                tokenId: parcelPda.toString(),
                owner: wallet.toString(),
                metadataURI: metadataUri
            });
        }
        return { txHash: signature, tokenId: parcelPda.toString() };
    }

    g.mintParcelSolana = mintParcelSolana;
})();
