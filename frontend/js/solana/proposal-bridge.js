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

    const LAMPORTS_PER_SOL = 1000000000n;

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

    function parseIntegerBigInt(value, label) {
        if (value === undefined || value === null || value === '') return 0n;
        if (typeof value === 'bigint') {
            if (value < 0n) throw new Error(`${label} cannot be negative`);
            return value;
        }
        if (typeof value === 'number') {
            if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
                throw new Error(`${label} must be a non-negative integer`);
            }
            return BigInt(value);
        }
        const text = String(value).trim();
        if (!/^\d+$/.test(text)) {
            throw new Error(`${label} must be a non-negative integer`);
        }
        return BigInt(text);
    }

    function parseSolToLamports(value, label = 'SOL amount') {
        if (value === undefined || value === null || value === '') return 0n;
        if (typeof value === 'bigint') {
            if (value < 0n) throw new Error(`${label} cannot be negative`);
            return value * LAMPORTS_PER_SOL;
        }
        const text = String(value).trim();
        const normalized = text.startsWith('.') ? `0${text}` : text;
        const match = normalized.match(/^(\d+)(?:\.(\d*))?$/);
        if (!match) {
            throw new Error(`${label} must be a non-negative decimal value`);
        }
        const whole = BigInt(match[1]);
        const fraction = match[2] || '';
        if (fraction.length > 9 && /[1-9]/.test(fraction.slice(9))) {
            throw new Error(`${label} has more precision than lamports support`);
        }
        const fractionLamports = BigInt((fraction.slice(0, 9)).padEnd(9, '0') || '0');
        return whole * LAMPORTS_PER_SOL + fractionLamports;
    }

    async function simulateTransactionOrThrow(connection, tx) {
        if (!connection || typeof connection.simulateTransaction !== 'function') return null;
        const simulation = await connection.simulateTransaction(tx, {
            sigVerify: false,
            replaceRecentBlockhash: false
        });
        const value = simulation && simulation.value ? simulation.value : simulation;
        if (value && value.err) {
            const err = new Error('Solana transaction simulation failed.');
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
            const err = new Error('Solana transaction failed during confirmation.');
            err.code = 'CONFIRMATION_FAILED';
            err.confirmationError = confirmation.value.err;
            throw err;
        }
        return signature;
    }

    function getParcelPda(programId, parcelId) {
        if (globalScope.SolanaChainDataLoader && typeof globalScope.SolanaChainDataLoader.getParcelPda === 'function') {
            return globalScope.SolanaChainDataLoader.getParcelPda(programId, parcelId);
        }
        const enc = new TextEncoder();
        const [pda] = globalScope.solanaWeb3.PublicKey.findProgramAddressSync(
            [enc.encode('parcel'), enc.encode(parcelId)],
            new globalScope.solanaWeb3.PublicKey(programId)
        );
        return pda;
    }

    function readRecipientFromOptions(options, parcelId) {
        const recipients = options.recipients || options.recipientAccounts || {};
        if (Array.isArray(recipients)) {
            const match = recipients.find(entry => entry && String(entry.parcelId) === String(parcelId));
            return match && (match.recipient || match.owner || match.address || match.publicKey);
        }
        return recipients[parcelId] || recipients[String(parcelId)];
    }

    async function resolveProposalProgramId() {
        const loader = globalScope.SolanaChainDataLoader;
        if (loader && loader.resolveProgramAddress) {
            const cluster = getCluster();
            const exact = await loader.resolveProgramAddress(`solana-${cluster}`, 'ProposalNFT');
            if (exact) return exact;
            if (cluster === 'devnet') {
                return await loader.resolveProgramAddress('solana', 'ProposalNFT');
            }
        }
        return null;
    }

    async function resolveParcelProgramId() {
        const loader = globalScope.SolanaChainDataLoader;
        if (loader && loader.resolveProgramAddress) {
            const cluster = getCluster();
            const exact = await loader.resolveProgramAddress(`solana-${cluster}`, 'ParcelNFT');
            if (exact) return exact;
            if (cluster === 'devnet') {
                return await loader.resolveProgramAddress('solana', 'ParcelNFT');
            }
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
        const solAmount = options.solLamports !== undefined
            ? parseIntegerBigInt(options.solLamports, 'SOL lamports')
            : (options.solAmount !== undefined
                ? parseSolToLamports(options.solAmount, 'SOL amount')
                : (options.ethAmount !== undefined
                    ? parseSolToLamports(options.ethAmount, 'SOL amount')
                    : parseIntegerBigInt(options.ethAmountWei || 0, 'SOL lamports')));
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

        const signature = await signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight);

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
        const amount = options.solLamports !== undefined
            ? parseIntegerBigInt(options.solLamports, 'SOL lamports')
            : parseSolToLamports(options.amount || options.solAmount, 'SOL amount');
        if (amount <= 0n) throw new Error('Amount required');

        const discriminator = await sha256Discriminator('contribute_funds');
        const amountLamports = amount;
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

        const signature = await signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight);

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
        const parcelProgramId = options.parcelProgramId || await resolveParcelProgramId();
        if (!parcelProgramId) throw new Error('ParcelNFT program not configured');
        if (!options.proposalId) throw new Error('Proposal id required');
        if (!options.parcelId) throw new Error('Parcel id required');

        const discriminator = await sha256Discriminator('accept_proposal');
        const args = encodeBorshString(options.parcelId);
        const ixData = concatBuffers([discriminator, args]);

        const proposalKey = new globalScope.solanaWeb3.PublicKey(options.proposalId);
        const programKey = new globalScope.solanaWeb3.PublicKey(programId);
        const parcelProgramKey = new globalScope.solanaWeb3.PublicKey(parcelProgramId);
        const parcelKey = getParcelPda(parcelProgramId, options.parcelId);
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
                    { pubkey: parcelKey, isSigner: false, isWritable: false },
                    { pubkey: parcelProgramKey, isSigner: false, isWritable: false },
                    { pubkey: wallet, isSigner: true, isWritable: false }
                ],
                data: ixData
            })
        );

        const signature = await signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight);

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
        const parcelProgramId = options.parcelProgramId || await resolveParcelProgramId();
        if (!parcelProgramId) throw new Error('ParcelNFT program not configured');
        if (!options.proposalId) throw new Error('Proposal id required');
        if (!options.parcelId) throw new Error('Parcel id required');

        const discriminator = await sha256Discriminator('withdraw_acceptance');
        const args = encodeBorshString(options.parcelId);
        const ixData = concatBuffers([discriminator, args]);

        const proposalKey = new globalScope.solanaWeb3.PublicKey(options.proposalId);
        const programKey = new globalScope.solanaWeb3.PublicKey(programId);
        const parcelProgramKey = new globalScope.solanaWeb3.PublicKey(parcelProgramId);
        const parcelKey = getParcelPda(parcelProgramId, options.parcelId);
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
                    { pubkey: parcelKey, isSigner: false, isWritable: false },
                    { pubkey: parcelProgramKey, isSigner: false, isWritable: false },
                    { pubkey: wallet, isSigner: true, isWritable: false }
                ],
                data: ixData
            })
        );

        const signature = await signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight);

        const clusterSuffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
        return {
            transactionHash: signature,
            chainId: `solana-${cluster}`,
            cluster,
            contractAddress: programId,
            explorerUrl: `https://explorer.solana.com/tx/${signature}${clusterSuffix}`
        };
    }

    async function distributeFunds(options = {}) {
        if (!haveSolanaWeb3()) throw new Error('Solana web3.js not available');
        const wallet = getWallet();
        if (!wallet) throw new Error('Connect a Solana wallet to distribute proposal funds');

        const programId = options.programId || options.contractAddress || await resolveProposalProgramId();
        if (!programId) throw new Error('ProposalNFT program not configured');
        const parcelProgramId = options.parcelProgramId || await resolveParcelProgramId();
        if (!parcelProgramId) throw new Error('ParcelNFT program not configured');
        if (!options.proposalId) throw new Error('Proposal id required');

        const proposalKey = new globalScope.solanaWeb3.PublicKey(options.proposalId);
        const programKey = new globalScope.solanaWeb3.PublicKey(programId);
        const parcelProgramKey = new globalScope.solanaWeb3.PublicKey(parcelProgramId);
        const cluster = getCluster();
        const connection = globalScope.SolanaChainDataLoader.getConnection(cluster);
        const provider = globalScope.solanaWalletManager.getProvider();

        let acceptedParcels = Array.isArray(options.acceptedParcels) ? options.acceptedParcels.map(String).filter(Boolean) : [];
        if (acceptedParcels.length === 0) {
            const proposalInfo = await connection.getAccountInfo(proposalKey);
            const parsedProposal = proposalInfo && proposalInfo.data && globalScope.SolanaChainDataLoader.parseProposalAccount
                ? globalScope.SolanaChainDataLoader.parseProposalAccount(proposalInfo.data, proposalKey.toString())
                : null;
            acceptedParcels = Array.isArray(parsedProposal && parsedProposal.acceptedParcels)
                ? parsedProposal.acceptedParcels.map(String).filter(Boolean)
                : [];
        }
        if (acceptedParcels.length === 0) throw new Error('No accepted parcels to distribute funds to');

        const remainingAccounts = [];
        for (const parcelId of acceptedParcels) {
            const parcelKey = getParcelPda(parcelProgramId, parcelId);
            let recipient = readRecipientFromOptions(options, parcelId);
            if (!recipient) {
                const parcelInfo = await connection.getAccountInfo(parcelKey);
                const parsedParcel = parcelInfo && parcelInfo.data && globalScope.SolanaChainDataLoader.parseParcelAccount
                    ? globalScope.SolanaChainDataLoader.parseParcelAccount(parcelInfo.data)
                    : null;
                recipient = parsedParcel && parsedParcel.owner;
            }
            if (!recipient) throw new Error(`Recipient owner not found for parcel ${parcelId}`);
            remainingAccounts.push(
                { pubkey: parcelKey, isSigner: false, isWritable: false },
                { pubkey: new globalScope.solanaWeb3.PublicKey(recipient), isSigner: false, isWritable: true }
            );
        }

        const discriminator = await sha256Discriminator('distribute_funds');
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new globalScope.solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.add(
            new globalScope.solanaWeb3.TransactionInstruction({
                programId: programKey,
                keys: [
                    { pubkey: proposalKey, isSigner: false, isWritable: true },
                    { pubkey: parcelProgramKey, isSigner: false, isWritable: false },
                    ...remainingAccounts
                ],
                data: discriminator
            })
        );

        const signature = await signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight);
        const clusterSuffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
        return {
            transactionHash: signature,
            chainId: `solana-${cluster}`,
            cluster,
            contractAddress: programId,
            explorerUrl: `https://explorer.solana.com/tx/${signature}${clusterSuffix}`
        };
    }

    async function cancelAndRefund(options = {}) {
        if (!haveSolanaWeb3()) throw new Error('Solana web3.js not available');
        const wallet = getWallet();
        if (!wallet) throw new Error('Connect a Solana wallet to cancel proposals');

        const programId = options.programId || options.contractAddress || await resolveProposalProgramId();
        if (!programId) throw new Error('ProposalNFT program not configured');
        if (!options.proposalId) throw new Error('Proposal id required');

        const discriminator = await sha256Discriminator('cancel_and_refund');
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
                data: discriminator
            })
        );

        const signature = await signSendAndConfirm(provider, connection, tx, blockhash, lastValidBlockHeight);
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
        distributeFunds,
        cancelAndRefund,
        resolveProposalProgramId,
        resolveParcelProgramId
    };
})();
