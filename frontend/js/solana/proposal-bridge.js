/**
 * Solana Proposal Chain Bridge
 * Mint, contribute, accept, withdraw proposals on Solana
 * Mirrors ProposalChainBridge API for EVM
 */
(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) return;

    function haveSolanaWeb3() {
        return Boolean(globalScope.solanaWeb3 && globalScope.solanaWeb3.Connection && globalScope.solanaWeb3.PublicKey);
    }

    function getCluster() {
        const wm = globalScope.solanaWalletManager;
        return wm && wm.getCluster ? wm.getCluster() : 'devnet';
    }

    function getWallet() {
        const wm = globalScope.solanaWalletManager;
        if (!wm || !wm.getProvider) return null;
        const provider = wm.getProvider();
        if (!provider || !provider.publicKey) return null;
        return provider.publicKey;
    }

    async function sha256Discriminator(instructionName) {
        const str = `global:${instructionName}`;
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return new Uint8Array(hashBuffer).slice(0, 8);
    }

    function concatBuffers(buffers) {
        const total = buffers.reduce((s, b) => s + b.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const b of buffers) {
            out.set(b, offset);
            offset += b.length;
        }
        return out;
    }

    function encodeBorshString(s) {
        const utf8 = new TextEncoder().encode(s);
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, utf8.length, true);
        return concatBuffers([len, utf8]);
    }

    function encodeBorshVecString(arr) {
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, arr.length, true);
        const parts = [len];
        for (const s of arr) {
            parts.push(encodeBorshString(s));
        }
        return concatBuffers(parts);
    }

    function encodeBorshVecPubkey(pubkeys) {
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, pubkeys.length, true);
        const parts = [len];
        for (const pk of pubkeys) {
            const key = new globalScope.solanaWeb3.PublicKey(pk);
            parts.push(new Uint8Array(key.toBytes()));
        }
        return concatBuffers(parts);
    }

    async function resolveProposalProgramId() {
        const loader = globalScope.SolanaChainDataLoader;
        if (loader && loader.resolveProgramAddress) {
            const cluster = getCluster();
            return await loader.resolveProgramAddress(`solana-${cluster}`, 'ProposalNFT')
                || await loader.resolveProgramAddress('solana', 'ProposalNFT');
        }
        return null;
    }

    async function resolveParcelProgramId() {
        const loader = globalScope.SolanaChainDataLoader;
        if (loader && loader.resolveProgramAddress) {
            const cluster = getCluster();
            return await loader.resolveProgramAddress(`solana-${cluster}`, 'ParcelNFT')
                || await loader.resolveProgramAddress('solana', 'ParcelNFT');
        }
        return null;
    }

    async function mintProposal(options = {}) {
        if (!haveSolanaWeb3()) throw new Error('Solana web3.js not available');
        const wallet = getWallet();
        if (!wallet) throw new Error('Connect a Solana wallet to mint proposals');

        const parcelIds = Array.isArray(options.parcelIds) ? options.parcelIds : [];
        const uniqueParcelIds = [...new Set(parcelIds.map(String).filter(Boolean))];
        if (uniqueParcelIds.length === 0) throw new Error('No parcel identifiers provided');

        const programId = options.programId || await resolveProposalProgramId();
        if (!programId) throw new Error('ProposalNFT program not configured');

        const cluster = getCluster();
        const connection = globalScope.SolanaChainDataLoader.getConnection(cluster);
        const programKey = new globalScope.solanaWeb3.PublicKey(programId);

        const [proposalCounterPda] = globalScope.solanaWeb3.PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('proposal_counter')],
            programKey
        );

        const counterAccount = await connection.getAccountInfo(proposalCounterPda);
        if (!counterAccount || !counterAccount.data) {
            throw new Error('Proposal counter not initialized. Deploy and initialize the program first.');
        }
        const count = new DataView(counterAccount.data.buffer, counterAccount.data.byteOffset + 8, 8).getBigUint64(0, true);

        const countBuf = new Uint8Array(8);
        new DataView(countBuf.buffer).setBigUint64(0, count, true);
        const [proposalPda] = globalScope.solanaWeb3.PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('proposal'), countBuf],
            programKey
        );

        const discriminator = await sha256Discriminator('mint_and_fund');
        const solAmount = BigInt(options.solAmount || options.ethAmountWei || 0);
        const solAmountBuf = new Uint8Array(8);
        new DataView(solAmountBuf.buffer).setBigUint64(0, solAmount, true);

        const lensAddresses = (options.lens || []).map(l => typeof l === 'string' ? l : (l?.address || l?.toString?.()));
        const args = concatBuffers([
            encodeBorshVecString(uniqueParcelIds),
            new Uint8Array([options.isConditional ? 1 : 0]),
            encodeBorshString(options.imageURI || ''),
            solAmountBuf,
            encodeBorshVecPubkey(lensAddresses.filter(Boolean))
        ]);

        const ixData = concatBuffers([discriminator, args]);

        const provider = globalScope.solanaWalletManager.getProvider();
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new globalScope.solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.add(
            new globalScope.solanaWeb3.TransactionInstruction({
                programId: programKey,
                keys: [
                    { pubkey: proposalPda, isSigner: false, isWritable: true },
                    { pubkey: proposalCounterPda, isSigner: false, isWritable: true },
                    { pubkey: wallet, isSigner: true, isWritable: true },
                    { pubkey: globalScope.solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false }
                ],
                data: ixData
            })
        );

        const signed = await provider.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

        return {
            transactionHash: signature,
            proposalId: proposalPda.toString(),
            chainId: `solana-${cluster}`,
            cluster,
            contractAddress: programId,
            account: wallet.toString()
        };
    }

    async function contributeToProposal(options = {}) {
        if (!haveSolanaWeb3()) throw new Error('Solana web3.js not available');
        const wallet = getWallet();
        if (!wallet) throw new Error('Connect a Solana wallet to boost proposals');

        const programId = options.programId || options.contractAddress || await resolveProposalProgramId();
        if (!programId) throw new Error('ProposalNFT program not configured');
        if (!options.proposalId) throw new Error('Proposal id required');
        const amount = options.amount || options.solAmount;
        if (!amount || Number(amount) <= 0) throw new Error('Amount required');

        const discriminator = await sha256Discriminator('contribute_funds');
        const amountLamports = BigInt(Math.floor(Number(amount) * 1e9));
        const amountBuf = new Uint8Array(8);
        new DataView(amountBuf.buffer).setBigUint64(0, amountLamports, true);
        const ixData = concatBuffers([discriminator, amountBuf]);

        const proposalKey = new globalScope.solanaWeb3.PublicKey(options.proposalId);
        const programKey = new globalScope.solanaWeb3.PublicKey(programId);
        const cluster = getCluster();
        const connection = globalScope.SolanaChainDataLoader.getConnection(cluster);
        const provider = globalScope.solanaWalletManager.getProvider();

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new globalScope.solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.add(
            new globalScope.solanaWeb3.TransactionInstruction({
                programId: programKey,
                keys: [
                    { pubkey: proposalKey, isSigner: false, isWritable: true },
                    { pubkey: wallet, isSigner: true, isWritable: true }
                ],
                data: ixData
            })
        );

        const signed = await provider.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

        const clusterSuffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
        return {
            transactionHash: signature,
            chainId: `solana-${cluster}`,
            cluster,
            contractAddress: programId,
            explorerUrl: `https://explorer.solana.com/tx/${signature}${clusterSuffix}`
        };
    }

    async function acceptProposal(options = {}) {
        if (!haveSolanaWeb3()) throw new Error('Solana web3.js not available');
        const wallet = getWallet();
        if (!wallet) throw new Error('Connect a Solana wallet to accept proposals');

        const programId = options.programId || options.contractAddress || await resolveProposalProgramId();
        if (!programId) throw new Error('ProposalNFT program not configured');
        if (!options.proposalId) throw new Error('Proposal id required');
        if (!options.parcelId) throw new Error('Parcel id required');
        console.log('[SolanaProposalBridge.acceptProposal] programId:', programId, 'proposalId:', options.proposalId, 'parcelId:', options.parcelId);

        const discriminator = await sha256Discriminator('accept_proposal');
        const args = encodeBorshString(options.parcelId);
        const ixData = concatBuffers([discriminator, args]);

        const proposalKey = new globalScope.solanaWeb3.PublicKey(options.proposalId);
        const programKey = new globalScope.solanaWeb3.PublicKey(programId);
        const cluster = getCluster();
        const connection = globalScope.SolanaChainDataLoader.getConnection(cluster);
        const provider = globalScope.solanaWalletManager.getProvider();

        // Debug: fetch and inspect proposal account before sending tx
        try {
            const acctInfo = await connection.getAccountInfo(proposalKey);
            if (acctInfo && acctInfo.data) {
                const parsed = globalScope.SolanaChainDataLoader && typeof globalScope.SolanaChainDataLoader.parseProposalAccount === 'function'
                    ? globalScope.SolanaChainDataLoader.parseProposalAccount(acctInfo.data, options.proposalId)
                    : null;
                console.log('[SolanaProposalBridge.acceptProposal] Pre-tx proposal state:', {
                    proposalId: options.proposalId,
                    parcelId: options.parcelId,
                    dataLength: acctInfo.data.length,
                    owner: acctInfo.owner?.toString(),
                    parsed
                });
                if (parsed) {
                    console.log('[SolanaProposalBridge.acceptProposal] acceptance_possible:', parsed.acceptancePossible,
                        'status:', parsed.status, 'parcelIds:', parsed.parentParcelIds,
                        'acceptedParcels:', parsed.acceptedParcels);
                }
            } else {
                console.warn('[SolanaProposalBridge.acceptProposal] No account data for', options.proposalId);
            }
        } catch (dbgErr) {
            console.warn('[SolanaProposalBridge.acceptProposal] Debug fetch failed:', dbgErr);
        }

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new globalScope.solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.add(
            new globalScope.solanaWeb3.TransactionInstruction({
                programId: programKey,
                keys: [
                    { pubkey: proposalKey, isSigner: false, isWritable: true },
                    { pubkey: wallet, isSigner: true, isWritable: false }
                ],
                data: ixData
            })
        );

        const signed = await provider.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

        const clusterSuffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
        return {
            transactionHash: signature,
            chainId: `solana-${cluster}`,
            cluster,
            contractAddress: programId,
            explorerUrl: `https://explorer.solana.com/tx/${signature}${clusterSuffix}`
        };
    }

    async function withdrawAcceptance(options = {}) {
        if (!haveSolanaWeb3()) throw new Error('Solana web3.js not available');
        const wallet = getWallet();
        if (!wallet) throw new Error('Connect a Solana wallet to withdraw acceptance');

        const programId = options.programId || options.contractAddress || await resolveProposalProgramId();
        if (!programId) throw new Error('ProposalNFT program not configured');
        if (!options.proposalId) throw new Error('Proposal id required');
        if (!options.parcelId) throw new Error('Parcel id required');

        const discriminator = await sha256Discriminator('withdraw_acceptance');
        const args = encodeBorshString(options.parcelId);
        const ixData = concatBuffers([discriminator, args]);

        const proposalKey = new globalScope.solanaWeb3.PublicKey(options.proposalId);
        const programKey = new globalScope.solanaWeb3.PublicKey(programId);
        const cluster = getCluster();
        const connection = globalScope.SolanaChainDataLoader.getConnection(cluster);
        const provider = globalScope.solanaWalletManager.getProvider();

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new globalScope.solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.add(
            new globalScope.solanaWeb3.TransactionInstruction({
                programId: programKey,
                keys: [
                    { pubkey: proposalKey, isSigner: false, isWritable: true },
                    { pubkey: wallet, isSigner: true, isWritable: false }
                ],
                data: ixData
            })
        );

        const signed = await provider.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

        const clusterSuffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
        return {
            transactionHash: signature,
            chainId: `solana-${cluster}`,
            cluster,
            contractAddress: programId,
            explorerUrl: `https://explorer.solana.com/tx/${signature}${clusterSuffix}`
        };
    }

    globalScope.SolanaProposalChainBridge = {
        isSupported: () => haveSolanaWeb3(),
        mintProposal,
        contributeToProposal,
        acceptProposal,
        withdrawAcceptance,
        resolveProposalProgramId,
        resolveParcelProgramId
    };
})();
