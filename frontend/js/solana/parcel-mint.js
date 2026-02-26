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

    async function mintParcelSolana(parcelId, metadataUri, programId, cluster) {
        if (!g.solanaWeb3 || !g.solanaWalletManager) throw new Error('Solana not available');
        const provider = g.solanaWalletManager.getProvider();
        const wallet = provider?.publicKey;
        if (!wallet) throw new Error('Connect Solana wallet');

        const connection = g.SolanaChainDataLoader.getConnection(cluster);
        const programKey = new g.solanaWeb3.PublicKey(programId);
        const [parcelPda] = g.solanaWeb3.PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('parcel'), new TextEncoder().encode(parcelId)],
            programKey
        );

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

        const signed = await provider.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
        return { txHash: signature, tokenId: parcelPda.toString() };
    }

    g.mintParcelSolana = mintParcelSolana;
})();
