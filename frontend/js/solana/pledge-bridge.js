// Thin browser-wallet bridge for the pure proposal_pledge codec. One transaction creates the
// escrow when necessary and deposits the pledge. A stable operationId makes retries read-before-
// write idempotent rather than charging the wallet twice.
(function attachPledgeBridge(root) {
    'use strict';
    if (!root) return;

    function dependencies() {
        if (!root.solanaWeb3?.Transaction) throw new Error('Solana web3.js is unavailable');
        if (!root.SolanaPledgeClient) throw new Error('Pledge client is unavailable');
        if (!root.SolanaChainDataLoader?.getConnection) throw new Error('Solana connection is unavailable');
        return root.SolanaPledgeClient;
    }
    function walletContext() {
        const manager = root.solanaWalletManager;
        const provider = manager?.getProvider?.();
        if (!provider?.publicKey || typeof provider.signTransaction !== 'function') {
            const error = new Error('Connect a Solana wallet to pledge USDC');
            error.code = 'WALLET_NOT_CONNECTED';
            throw error;
        }
        const cluster = manager?.getCluster?.() || 'devnet';
        if (cluster !== 'devnet') {
            const error = new Error('USDC pledges currently run on Solana devnet');
            error.code = 'WRONG_NETWORK';
            throw error;
        }
        return { provider, wallet: provider.publicKey, cluster };
    }
    async function send(connection, provider, wallet, instructions) {
        const latest = await connection.getLatestBlockhash('confirmed');
        const transaction = new root.solanaWeb3.Transaction({
            feePayer: wallet,
            recentBlockhash: latest.blockhash
        });
        for (const instruction of instructions) transaction.add(instruction);
        const simulation = await connection.simulateTransaction(transaction, { sigVerify: false });
        if (simulation?.value?.err) {
            const error = new Error('Pledge transaction simulation failed');
            error.code = 'SIMULATION_FAILED';
            error.logs = simulation.value.logs || [];
            throw error;
        }
        const signed = await provider.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        const confirmation = await connection.confirmTransaction({ ...latest, signature }, 'confirmed');
        if (confirmation?.value?.err) throw new Error('Pledge transaction failed during confirmation');
        return signature;
    }

    async function pledge(options) {
        const client = dependencies();
        const { provider, wallet, cluster } = walletContext();
        if (!options?.proposal) throw new Error('proposal account is required');
        if (!options.operationId) throw new Error('operationId is required for idempotent pledging');
        const amount = client.parseUsdc(String(options.amount));
        if (amount <= 0n) throw new Error('pledge amount must be positive');
        const pledgeId = await client.hashPledgeId(String(options.operationId));
        const connection = root.SolanaChainDataLoader.getConnection(cluster);

        const existingPosition = await client.readPosition(connection, options.proposal, wallet, pledgeId, options.programId);
        if (existingPosition) {
            if (existingPosition.amount !== amount) throw new Error('operationId already exists with a different amount');
            return { replayed: true, position: existingPosition, transactionHash: null };
        }

        const escrow = await client.readEscrow(connection, options.proposal, options.programId);
        const instructions = [];
        if (!escrow) {
            instructions.push(client.buildCreateEscrowIx({
                proposal: options.proposal,
                pledgeMint: client.constants.USDC_DEVNET_MINT,
                creator: wallet,
                programId: options.programId
            }));
        }
        instructions.push(client.buildPledgeIx({
            proposal: options.proposal,
            pledgeMint: client.constants.USDC_DEVNET_MINT,
            pledger: wallet,
            pledgeId,
            amount,
            programId: options.programId
        }));
        const signature = await send(connection, provider, wallet, instructions);
        const [escrowPda] = client.getEscrowPda(options.proposal, options.programId);
        const [positionPda] = client.getPositionPda(escrowPda, wallet, pledgeId, options.programId);
        return {
            replayed: false,
            transactionHash: signature,
            escrowPda: escrowPda.toBase58(),
            positionPda: positionPda.toBase58(),
            explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
        };
    }

    async function readSummary(proposal, programId) {
        const client = dependencies();
        const cluster = root.solanaWalletManager?.getCluster?.() || 'devnet';
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        return client.readEscrow(connection, proposal, programId);
    }

    root.SolanaPledgeBridge = { pledge, readSummary };
})(typeof window !== 'undefined' ? window : null);
