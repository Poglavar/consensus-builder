// Thin browser-wallet bridge for proposal support. Donations transfer USDC into refundable escrow;
// pledges only publish a revocable commitment and transfer USDC when fulfilled after execution.
(function attachPledgeBridge(root) {
    'use strict';
    if (!root) return;

    async function dependencies() {
        if (!root.solanaWeb3?.Transaction && typeof root.ensureWalletVendors === 'function') {
            await root.ensureWalletVendors();
        }
        if (!root.solanaWeb3?.Transaction) throw new Error('Solana web3.js is unavailable');
        if (!root.SolanaPledgeClient) throw new Error('Proposal support client is unavailable');
        if (!root.SolanaChainDataLoader?.getConnection) throw new Error('Solana connection is unavailable');
        return root.SolanaPledgeClient;
    }
    function walletContext() {
        const manager = root.solanaWalletManager;
        const provider = manager?.getProvider?.();
        if (!provider?.publicKey || typeof provider.signTransaction !== 'function') {
            const error = new Error('Connect a Solana wallet to support this proposal');
            error.code = 'WALLET_NOT_CONNECTED';
            throw error;
        }
        const cluster = manager?.getCluster?.() || 'devnet';
        if (cluster !== 'devnet') {
            const error = new Error('Proposal donations and pledges currently run on Solana devnet');
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
        for (const instruction of instructions) transaction.add(instruction);
        const simulation = await connection.simulateTransaction(transaction, { sigVerify: false });
        if (simulation?.value?.err) {
            const error = transactionError('Proposal support transaction simulation failed', 'SIMULATION_FAILED');
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
        if (confirmation?.value?.err) throw transactionError('Proposal support transaction failed during confirmation', 'CONFIRMATION_FAILED', signature);
        emitStatus(options, 'confirmed', { signature, explorerUrl });
        return signature;
    }
    function result(signature, extra) {
        return { transactionHash: signature, explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`, ...(extra || {}) };
    }

    async function walletBalances(options = {}) {
        const client = await dependencies();
        const { wallet, cluster } = walletContext();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const tokenAccount = client.getAssociatedTokenAddress(wallet, client.constants.USDC_DEVNET_MINT);
        const [solLamports, tokenBalance] = await Promise.all([
            connection.getBalance(wallet, 'confirmed'),
            connection.getTokenAccountBalance(tokenAccount, 'confirmed').catch(() => null)
        ]);
        const usdcAtomic = tokenBalance?.value?.amount ? BigInt(tokenBalance.value.amount) : 0n;
        return {
            wallet: wallet.toBase58(), cluster, solLamports,
            sol: solLamports / 1_000_000_000,
            usdcAtomic,
            usdc: client.formatUsdc(usdcAtomic),
            hasUsdcAccount: Boolean(tokenBalance),
            tokenAccount: tokenAccount.toBase58()
        };
    }

    async function requireSpendableBalance(options, amount, requireUsdc) {
        const balances = await walletBalances(options);
        if (balances.solLamports <= 0) throw transactionError('This wallet needs devnet SOL for transaction fees', 'INSUFFICIENT_SOL');
        if (requireUsdc && balances.usdcAtomic < amount) {
            const error = transactionError(`Insufficient devnet USDC: ${balances.usdc} available`, 'INSUFFICIENT_USDC');
            error.balances = balances;
            throw error;
        }
        return balances;
    }

    async function donate(options) {
        const client = await dependencies(); const { provider, wallet, cluster } = walletContext();
        if (!options?.proposal) throw new Error('proposal account is required');
        if (!options.operationId) throw new Error('operationId is required for idempotent donations');
        const amount = client.parseUsdc(String(options.amount));
        if (amount <= 0n) throw new Error('donation amount must be positive');
        const donationId = await client.hashOperationId(String(options.operationId));
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const existing = await client.readDonationPosition(connection, options.proposal, wallet, donationId, options.programId);
        if (existing) {
            if (existing.amount !== amount) throw new Error('operationId already exists with a different donation amount');
            return { replayed: true, position: existing, transactionHash: null };
        }
        await requireSpendableBalance(options, amount, true);
        const instructions = [];
        if (!await client.readDonationEscrow(connection, options.proposal, options.programId)) {
            instructions.push(client.buildCreateDonationEscrowIx({ proposal: options.proposal, creator: wallet, programId: options.programId }));
        }
        instructions.push(client.buildDonateIx({ proposal: options.proposal, donor: wallet, donationId, amount, programId: options.programId }));
        const signature = await send(connection, provider, wallet, instructions, options);
        return result(signature, { replayed: false });
    }

    async function pledge(options) {
        const client = await dependencies(); const { provider, wallet, cluster } = walletContext();
        if (!options?.proposal) throw new Error('proposal account is required');
        const amount = client.parseUsdc(String(options.amount));
        if (amount <= 0n) throw new Error('pledge amount must be positive');
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const existing = await client.readPledgeCommitment(connection, options.proposal, wallet, options.programId);
        if (existing?.status === client.constants.PLEDGE_FULFILLED) throw new Error('This pledge was already fulfilled');
        if (existing?.status === client.constants.PLEDGE_ACTIVE && existing.amount === amount) {
            return { replayed: true, commitment: existing, transactionHash: null };
        }
        await requireSpendableBalance(options, amount, false);
        const instructions = [];
        if (!await client.readPledgeBook(connection, options.proposal, options.programId)) {
            instructions.push(client.buildCreatePledgeBookIx({ proposal: options.proposal, creator: wallet, programId: options.programId }));
        }
        instructions.push(client.buildSetPledgeIx({ proposal: options.proposal, pledger: wallet, amount, programId: options.programId }));
        return result(await send(connection, provider, wallet, instructions, options), { replayed: false });
    }

    async function releaseDonations(options) {
        const client = await dependencies(); const { provider, wallet, cluster } = walletContext();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const escrow = await client.readDonationEscrow(connection, options?.proposal, options?.programId);
        if (!escrow) throw new Error('This proposal has no donation escrow');
        const instruction = client.buildReleaseDonationsIx({ proposal: options.proposal, beneficiary: escrow.beneficiary, releaser: wallet, programId: options.programId });
        return result(await send(connection, provider, wallet, [instruction], options));
    }

    async function refundMyDonations(options) {
        const client = await dependencies(); const { provider, wallet, cluster } = walletContext();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const positions = (await client.listDonationPositions(connection, options?.proposal, wallet, options?.programId)).filter(position => !position.refunded);
        if (!positions.length) throw new Error('You have no refundable donations on this proposal');
        const instructions = positions.map(position => client.buildRefundDonationIx({
            proposal: options.proposal, donor: wallet, donationId: position.donationId, programId: options.programId
        }));
        const signatures = [];
        const chunkSize = 4;
        for (let index = 0; index < instructions.length; index += chunkSize) {
            signatures.push(await send(connection, provider, wallet, instructions.slice(index, index + chunkSize), {
                ...options, onStatus: status => emitStatus(options, status.state, {
                    ...status, batch: Math.floor(index / chunkSize) + 1, batches: Math.ceil(instructions.length / chunkSize)
                })
            }));
        }
        return result(signatures[0], {
            refunded: positions.length,
            transactionHashes: signatures,
            explorerUrls: signatures.map(signature => `https://explorer.solana.com/tx/${signature}?cluster=devnet`)
        });
    }

    async function commitmentAction(options, builderName) {
        const client = await dependencies(); const { provider, wallet, cluster } = walletContext();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const commitment = await client.readPledgeCommitment(connection, options?.proposal, wallet, options?.programId);
        if (!commitment || commitment.status !== client.constants.PLEDGE_ACTIVE) throw new Error('You have no active pledge on this proposal');
        const book = await client.readPledgeBook(connection, options.proposal, options.programId);
        if (builderName === 'buildFulfillPledgeIx') await requireSpendableBalance(options, commitment.amount, true);
        const instruction = client[builderName]({ proposal: options.proposal, pledger: wallet, beneficiary: book?.beneficiary, programId: options.programId });
        return result(await send(connection, provider, wallet, [instruction], options));
    }
    function revokePledge(options) { return commitmentAction(options, 'buildRevokePledgeIx'); }
    function fulfillPledge(options) { return commitmentAction(options, 'buildFulfillPledgeIx'); }
    function voidPledge(options) { return commitmentAction(options, 'buildVoidPledgeIx'); }

    async function readSummary(proposal, programId) {
        const client = await dependencies();
        const cluster = root.solanaWalletManager?.getCluster?.() || 'devnet';
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const wallet = root.solanaWalletManager?.getProvider?.()?.publicKey || null;
        const [donations, pledges, myPledge, myDonations] = await Promise.all([
            client.readDonationEscrow(connection, proposal, programId),
            client.readPledgeBook(connection, proposal, programId),
            wallet ? client.readPledgeCommitment(connection, proposal, wallet, programId) : null,
            wallet ? client.listDonationPositions(connection, proposal, wallet, programId) : []
        ]);
        return { donations, pledges, myPledge, myDonations, wallet: wallet?.toBase58?.() || null };
    }

    root.SolanaPledgeBridge = { donate, pledge, releaseDonations, refundMyDonations, revokePledge, fulfillPledge, voidPledge, readSummary, walletBalances };
})(typeof window !== 'undefined' ? window : null);
