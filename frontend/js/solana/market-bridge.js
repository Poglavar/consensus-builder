// Browser-wallet bridge for the proposal_market program. It deliberately reuses
// SolanaMarketClient for every PDA and instruction byte; this file only owns wallet signing,
// preflight and explicit transaction lifecycle state.
(function attachSolanaMarketBridge(root) {
    'use strict';
    if (!root) return;

    const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

    async function dependencies() {
        if (!root.solanaWeb3?.Transaction && typeof root.ensureWalletVendors === 'function') await root.ensureWalletVendors();
        if (!root.solanaWeb3?.Transaction) throw new Error('Solana web3.js is unavailable');
        if (!root.SolanaMarketClient) throw new Error('Proposal market client is unavailable');
        if (!root.SolanaChainDataLoader?.getConnection) throw new Error('Solana connection is unavailable');
        return root.SolanaMarketClient;
    }

    function walletContext() {
        const manager = root.solanaWalletManager;
        const provider = manager?.getProvider?.();
        if (!provider?.publicKey || typeof provider.signTransaction !== 'function') {
            const error = new Error('Connect a Solana wallet to trade this market');
            error.code = 'WALLET_NOT_CONNECTED';
            throw error;
        }
        const cluster = manager?.getCluster?.() || 'devnet';
        if (cluster !== 'devnet') {
            const error = new Error('Proposal markets currently run on Solana devnet');
            error.code = 'WRONG_NETWORK';
            throw error;
        }
        return { provider, wallet: provider.publicKey, cluster };
    }

    function emitStatus(options, state, extra = {}) {
        if (typeof options?.onStatus === 'function') options.onStatus({ state, ...extra });
    }

    function transactionError(message, code, signature = null) {
        const error = new Error(message);
        error.code = code;
        error.transactionHash = signature;
        error.explorerUrl = signature ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : null;
        return error;
    }

    async function send(connection, provider, wallet, instructions, options = {}) {
        emitStatus(options, 'preparing');
        const latest = await connection.getLatestBlockhash('confirmed');
        const transaction = new root.solanaWeb3.Transaction({ feePayer: wallet, recentBlockhash: latest.blockhash });
        instructions.forEach(instruction => transaction.add(instruction));
        const simulation = await connection.simulateTransaction(transaction, { sigVerify: false });
        if (simulation?.value?.err) {
            const error = transactionError('Market transaction simulation failed', 'SIMULATION_FAILED');
            error.logs = simulation.value.logs || [];
            throw error;
        }
        emitStatus(options, 'awaiting_signature');
        const signed = await provider.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        const explorerUrl = `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
        emitStatus(options, 'submitted', { signature, explorerUrl });
        let confirmation;
        try {
            confirmation = await connection.confirmTransaction({ ...latest, signature }, 'confirmed');
        } catch (cause) {
            const error = transactionError('Transaction was submitted but confirmation timed out', 'CONFIRMATION_UNKNOWN', signature);
            error.cause = cause;
            throw error;
        }
        if (confirmation?.value?.err) throw transactionError('Market transaction failed during confirmation', 'CONFIRMATION_FAILED', signature);
        emitStatus(options, 'confirmed', { signature, explorerUrl });
        return { transactionHash: signature, explorerUrl };
    }

    async function readSummary(proposal) {
        const client = await dependencies();
        const { cluster } = walletContextOrGuest();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const wallet = root.solanaWalletManager?.getProvider?.()?.publicKey || null;
        const market = await client.readMarket(connection, proposal);
        if (!market) return { market: null, wallet: wallet?.toBase58?.() || null };
        const [yes, no] = wallet ? await Promise.all([
            client.readPosition(connection, proposal, wallet, client.constants.SIDE_YES),
            client.readPosition(connection, proposal, wallet, client.constants.SIDE_NO)
        ]) : [null, null];
        return { market, yes, no, wallet: wallet?.toBase58?.() || null };
    }

    function walletContextOrGuest() {
        const manager = root.solanaWalletManager;
        return { cluster: manager?.getCluster?.() || 'devnet' };
    }

    async function createMarket(options = {}) {
        const client = await dependencies();
        const { provider, wallet, cluster } = walletContext();
        if (!options.proposal) throw new Error('proposal account is required');
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const existing = await client.readMarket(connection, options.proposal, options.programId);
        if (existing) return { replayed: true, market: existing, transactionHash: null, explorerUrl: null };
        const solLamports = await connection.getBalance(wallet, 'confirmed');
        if (solLamports <= 0) throw transactionError('This wallet needs devnet SOL for transaction fees', 'INSUFFICIENT_SOL');
        return send(connection, provider, wallet, [client.buildCreateMarketIx({
            proposal: options.proposal,
            stakeMint: options.stakeMint || DEVNET_USDC_MINT,
            creator: wallet,
            programId: options.programId
        })], options);
    }

    async function stake(options = {}) {
        const client = await dependencies();
        const { provider, wallet, cluster } = walletContext();
        if (!options.proposal) throw new Error('proposal account is required');
        const amount = typeof options.amount === 'bigint' ? options.amount : BigInt(options.amount);
        if (amount <= 0n) throw new Error('stake amount must be positive');
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const market = await client.readMarket(connection, options.proposal, options.programId);
        if (!market) throw new Error('This proposal does not have an open market yet.');
        if (market.resolved) throw new Error('This market is already resolved.');
        const tokenAccount = client.getAssociatedTokenAddress(wallet, market.stakeMint);
        const [solLamports, balance] = await Promise.all([
            connection.getBalance(wallet, 'confirmed'),
            connection.getTokenAccountBalance(tokenAccount, 'confirmed').catch(() => null)
        ]);
        if (solLamports <= 0) throw transactionError('This wallet needs devnet SOL for transaction fees', 'INSUFFICIENT_SOL');
        const available = balance?.value?.amount ? BigInt(balance.value.amount) : 0n;
        if (available < amount) throw transactionError(`Insufficient market token balance: ${available} atomic units available`, 'INSUFFICIENT_USDC');
        return send(connection, provider, wallet, [client.buildStakeIx({
            proposal: options.proposal, stakeMint: market.stakeMint, staker: wallet, side: options.side, amount, programId: options.programId
        })], options);
    }

    async function resolve(options = {}) {
        const client = await dependencies();
        const { provider, wallet, cluster } = walletContext();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        return send(connection, provider, wallet, [client.buildResolveIx({ proposal: options.proposal, programId: options.programId })], options);
    }

    async function claim(options = {}) {
        const client = await dependencies();
        const { provider, wallet, cluster } = walletContext();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const market = await client.readMarket(connection, options.proposal, options.programId);
        if (!market?.resolved) throw new Error('This market has not been resolved yet.');
        const position = await client.readPosition(connection, options.proposal, wallet, options.side, options.programId);
        if (!position || position.claimed || position.amount <= 0n) throw new Error('There is no claimable position on this side.');
        return send(connection, provider, wallet, [client.buildClaimIx({
            proposal: options.proposal, stakeMint: market.stakeMint, claimer: wallet, side: options.side, programId: options.programId
        })], options);
    }

    root.SolanaMarketBridge = { DEVNET_USDC_MINT, readSummary, createMarket, stake, resolve, claim };
})(typeof window !== 'undefined' ? window : null);
