/**
 * Solana Proposal Chain Bridge
 * Mint, contribute, distribute and cancel proposals on Solana (proposal_nft v3: a proposal may
 * have an empty parcel list when it carries a site; see frontend/js/proposals/site-hash.js).
 * Owner consent is not here: see acceptance-bridge.js (accept_with_attestations).
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
        // A legacy Transaction goes to web3.js 1.x's (transaction, signers?) overload: a config object there
        // throws "Invalid arguments" before anything is signed. No signers means an unsigned simulation.
        const simulation = await connection.simulateTransaction(tx);
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
        // v3: the site (options.site, a GeoJSON (Multi)Polygon) and its binding decide site_hash and
        // open_ground; an empty parcel list is allowed only with a site. An explicit
        // options.siteHash/openGround pair (already computed) is used as given.
        const siteArgs = options.siteHash !== undefined
            ? { siteHash: options.siteHash, openGround: options.openGround === true }
            : await globalScope.__siteHash.chainSiteArgs({ site: options.site || null, binding: options.binding || null, parcelIds: uniqueParcelIds });

        const programId = options.programId || await resolveProposalProgramId();
        if (!programId) throw new Error('ProposalNFT program not configured');

        const cluster = getCluster();
        const connection = globalScope.SolanaChainDataLoader.getConnection(cluster);
        const [proposalCounterPda] = globalScope.SolanaAcceptanceClient.getProposalCounterPda(programId);
        const counterAccount = await connection.getAccountInfo(proposalCounterPda);
        if (!counterAccount || !counterAccount.data) {
            throw new Error('Proposal counter not initialized. Deploy and initialize the program first.');
        }
        const count = new DataView(counterAccount.data.buffer, counterAccount.data.byteOffset + 8, 8).getBigUint64(0, true);

        const solAmount = options.solLamports !== undefined
            ? parseIntegerBigInt(options.solLamports, 'SOL lamports')
            : (options.solAmount !== undefined
                ? parseSolToLamports(options.solAmount, 'SOL amount')
                : (options.ethAmount !== undefined
                    ? parseSolToLamports(options.ethAmount, 'SOL amount')
                    : parseIntegerBigInt(options.ethAmountWei || 0, 'SOL lamports')));

        const lensAddresses = (options.lens || []).map(l => typeof l === 'string' ? l : (l?.address || l?.toString?.())).filter(Boolean);
        // `verdict_may_execute`: only an explicit `true` sets it. A lens member's `executed` verdict
        // may then execute a proposal without per-parcel consent, or clear its open ground; without
        // it a proposal with open ground (or no parcels) can never execute.
        const { proposal: proposalPda, instruction } = globalScope.SolanaAcceptanceClient.buildMintAndFundIx({
            owner: wallet,
            proposalCount: count,
            programId,
            parcelIds: uniqueParcelIds,
            isConditional: Boolean(options.isConditional),
            imageUri: options.imageURI || '',
            solLamports: solAmount,
            lens: lensAddresses,
            verdictMayExecute: options.verdictMayExecute === true,
            siteHash: siteArgs.siteHash,
            openGround: siteArgs.openGround
        });

        const provider = globalScope.solanaWalletManager.getProvider();
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new globalScope.solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.add(instruction);

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

    // v1 accept_proposal / withdraw_acceptance no longer exist in proposal_nft v2: an attested
    // owner says yes through SolanaAcceptanceBridge.sayYes (accept_with_attestations), and an
    // acceptance cannot be withdrawn. distribute_funds v2 pays acceptance records.
    async function distributeFunds(options = {}) {
        if (!haveSolanaWeb3()) throw new Error('Solana web3.js not available');
        if (!globalScope.SolanaAcceptanceBridge) throw new Error('Acceptance bridge is unavailable');
        if (!options.proposalId) throw new Error('Proposal id required');
        return globalScope.SolanaAcceptanceBridge.distributeFunds({ ...options, proposal: options.proposalId });
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
        distributeFunds,
        cancelAndRefund,
        resolveProposalProgramId,
        resolveParcelProgramId
    };
})();
