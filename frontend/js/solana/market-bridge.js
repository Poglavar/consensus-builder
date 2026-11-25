// Browser-wallet operations always use the selected market account. Creation binds the signing
// wallet and the chosen terms to a new market address.
(function attachSolanaMarketBridge(root) {
    'use strict';
    if (!root) return;

    const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const MODEL = 'lmsr';
    const ASSET = 'devnet-usdc';
    const DEFAULT_B = 5_000_000n;
    const GRACE_SECONDS = 0;
    const MAX_POSITION = 0n;

    async function dependencies() {
        if (!root.solanaWeb3?.Transaction && typeof root.ensureWalletVendors === 'function') await root.ensureWalletVendors();
        if (!root.solanaWeb3?.Transaction) throw new Error('Solana web3.js is unavailable');
        if (!root.SolanaLmsrClient) throw new Error('Solana LMSR client is unavailable');
        if (!root.SolanaChainDataLoader?.getVerifiedConnection) throw new Error('Verified Solana connection is unavailable');
        if (!root.AgreementClient?.fetchAgreement) throw new Error('Agreement client is unavailable');
        if (!root.Lmsr?.maxLoss) throw new Error('LMSR quote math is unavailable');
        return root.SolanaLmsrClient;
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
            const error = new Error('LMSR markets currently run on Solana devnet');
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
        // web3.js 1.x treats the second legacy-Transaction argument as signers, never a config object.
        const simulation = await connection.simulateTransaction(transaction);
        if (simulation?.value?.err) {
            const anchorCode = (simulation.value.logs || []).join('\n').match(/Error Code: (\w+)\./)?.[1];
            const code = { CostExceedsMax: 'STALE_QUOTE', ReturnBelowMin: 'STALE_QUOTE', MarketClosed: 'MARKET_CLOSED', InsiderTrade: 'INSIDER_TRADE' }[anchorCode] || 'SIMULATION_FAILED';
            const error = transactionError('Market transaction simulation failed', code);
            error.logs = simulation.value.logs || [];
            throw error;
        }
        emitStatus(options, 'awaiting_signature');
        const signed = await provider.signTransaction(transaction);
        let signature;
        try { signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false }); }
        catch (cause) {
            // A transport failure can lose the RPC acknowledgement after broadcast. Recheck the
            // wallet's transaction history before signing a new trade with a different blockhash.
            const error = transactionError('Submission acknowledgement is unavailable; check your wallet history before retrying', 'CONFIRMATION_UNKNOWN');
            error.cause = cause; throw error;
        }
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

    function publicKey(value) {
        return value?.toBase58?.() || String(value || '');
    }

    async function verifiedConnection() {
        return root.SolanaChainDataLoader.getVerifiedConnection('devnet');
    }

    async function readAgreement(connection, proposal) {
        const agreement = await root.AgreementClient.fetchAgreement(connection, { address: proposal });
        if (!agreement || !agreement.authority || !Array.isArray(agreement.lenses) || !Number.isSafeInteger(agreement.deadline)) {
            throw new Error('Agreement account identity, status, or deadline is unavailable.');
        }
        if (!['Active', 'Executed', 'Cancelled', 'Expired'].includes(agreement.status)) {
            throw new Error('Agreement account status is unavailable.');
        }
        return agreement;
    }

    function chainStatus(agreement) {
        return agreement.status.toLowerCase();
    }

    function normalizedOutcome(client, raw) {
        if (!raw.resolved) return null;
        if (raw.outcome === client.constants.SIDE_YES) return 'yes';
        if (raw.outcome === client.constants.SIDE_NO) return 'no';
        if (raw.outcome === client.constants.OUTCOME_VOID) return 'void';
        throw new Error('Resolved market has an unknown outcome.');
    }

    function normalizedMarket(client, address, raw) {
        return {
            address: publicKey(address),
            model: MODEL,
            asset: ASSET,
            kind: raw.kind,
            proposed: Boolean(raw.proposed),
            challengeEndsAt: raw.challengeEndsAt == null ? null : Number(raw.challengeEndsAt),
            proposedOutcome: raw.proposed ? ['no', 'yes', 'void'][raw.outcome] : null,
            b: raw.b.toString(),
            qYes: raw.qYes.toString(),
            qNo: raw.qNo.toString(),
            seed: raw.seed.toString(),
            maxPosition: raw.maxPosition.toString(),
            paidOut: raw.paidOut.toString(),
            closesAt: Number(raw.closesAt),
            graceSeconds: raw.graceSeconds,
            resolved: raw.resolved,
            outcome: normalizedOutcome(client, raw),
            creator: raw.creator
        };
    }

    async function liveMarket(connection, client, proposal, agreement, marketAddress, programId) {
        if (!marketAddress) throw new Error('Select a market address for this agreement.');
        const address = new root.solanaWeb3.PublicKey(marketAddress);
        const raw = await client.readMarket(connection, address, programId);
        // The codec verifies the account owner, its term-derived address and its token vault.
        if (raw && (raw.proposal !== publicKey(proposal) || raw.stakeMint !== DEVNET_USDC_MINT
            || raw.seed !== root.Lmsr.maxLoss(raw.b) || (raw.kind === 1 && !agreement.lenses.includes(raw.trustedAttester)))) {
            throw new Error('Selected market does not match the agreement, verifier or funded USDC terms.');
        }
        return { address, raw, sponsor: agreement.authority };
    }

    async function chainNow(connection) {
        const slot = await connection.getSlot('confirmed');
        const seconds = await connection.getBlockTime(slot);
        if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('Devnet block time is unavailable.');
        return seconds;
    }

    async function preflightSol(connection, wallet) {
        const lamports = await connection.getBalance(wallet, 'confirmed');
        if (lamports <= 0) throw transactionError('This wallet needs devnet SOL for transaction fees', 'INSUFFICIENT_SOL');
        return lamports;
    }

    async function tokenBalance(connection, client, wallet, mint) {
        const address = client.getAssociatedTokenAddress(wallet, mint);
        const info = await connection.getAccountInfo(address, 'confirmed');
        if (!info) return { address, amount: 0n, exists: false };
        const balance = await connection.getTokenAccountBalance(address, 'confirmed');
        if (!balance?.value || !/^\d+$/.test(balance.value.amount)) throw new Error('Token account balance response is invalid.');
        return { address, amount: BigInt(balance.value.amount), exists: true };
    }

    async function readSummary(proposal, { marketAddress = null, programId } = {}) {
        const client = await dependencies();
        const connection = await verifiedConnection();
        const wallet = root.solanaWalletManager?.getProvider?.()?.publicKey || null;
        const agreement = await readAgreement(connection, proposal);
        const sponsor = agreement.authority;
        const summary = { market: null, marketAddress: marketAddress ? publicKey(marketAddress) : null,
            sponsor, lenses: agreement.lenses, chainStatus: chainStatus(agreement),
            deadline: agreement.deadline === 0 ? null : new Date(agreement.deadline * 1000).toISOString(),
            wallet: wallet ? publicKey(wallet) : null, yes: null, no: null };
        if (!marketAddress) return summary;
        const { raw } = await liveMarket(connection, client, proposal, agreement, marketAddress, programId);
        if (!raw) throw new Error('Selected market was not found.');
        const market = normalizedMarket(client, marketAddress, raw);
        market.creatorRole = raw.creator === sponsor ? 'sponsor' : agreement.lenses.includes(raw.creator) ? 'verifier' : null;
        if (raw.kind === 1) {
            const cid = root.Cid.rawCidOfDigest(raw.recipeHash);
            market.recipeCid = cid;
            market.trustedAttester = raw.trustedAttester;
            market.schema = raw.schema;
            market.credential = raw.credential;
            try {
                const response = await root.fetch(root.getBackendBase().replace(/\/$/, '') + '/markets/recipes/' + cid);
                if (response.ok) {
                    market.recipeBody = root.ExternalMarketRecipe.verify(await response.json(), raw);
                    market.question = market.recipeBody.question;
                }
            } catch { /* A missing question preimage does not erase positions or the on-chain settlement terms. */ }
        }
        const [yes, no] = wallet ? await Promise.all([
            client.readPosition(connection, marketAddress, wallet, client.constants.SIDE_YES, programId),
            client.readPosition(connection, marketAddress, wallet, client.constants.SIDE_NO, programId)
        ]) : [null, null];
        return { ...summary, market, yes, no };
    }

    async function readAgreementState(proposal) {
        await dependencies();
        const connection = await verifiedConnection();
        const agreement = await readAgreement(connection, proposal);
        return {
            sponsor: agreement.authority,
            lenses: agreement.lenses,
            chainStatus: chainStatus(agreement),
            deadline: agreement.deadline === 0 ? null : new Date(agreement.deadline * 1000).toISOString(),
            cid: agreement.cid,
            executedAt: agreement.executedAt ?? null
        };
    }

    // Position identities and the returned map are keyed by market, even for sibling questions.
    async function readPositions(rows = [], options = {}) {
        const client = await dependencies();
        const wallet = root.solanaWalletManager?.getProvider?.()?.publicKey || null;
        const input = Array.from(rows || []);
        if (!wallet || !input.length) return {};
        const connection = await verifiedConnection();
        const keys = [];
        const result = {};
        for (const row of input) {
            if (!row?.marketAddress) throw new Error('Each market position row needs a marketAddress.');
            const market = new root.solanaWeb3.PublicKey(row.marketAddress);
            const account = publicKey(market);
            if (result[account]) continue;
            result[account] = { yes: null, no: null };
            for (const [name, side] of [['yes', client.constants.SIDE_YES], ['no', client.constants.SIDE_NO]]) {
                keys.push({ account, market, name, side, address: client.getPositionPda(market, wallet, side, options.programId)[0] });
            }
        }
        for (let start = 0; start < keys.length; start += 100) {
            const chunk = keys.slice(start, start + 100);
            const infos = await connection.getMultipleAccountsInfo(chunk.map(item => item.address), 'confirmed');
            if (!Array.isArray(infos) || infos.length !== chunk.length) throw new Error('Market position response is incomplete.');
            infos.forEach((info, offset) => {
                if (!info?.data) return;
                const item = chunk[offset];
                result[item.account][item.name] = client.readPositionAccount(info, item.market, wallet, item.side, options.programId);
            });
        }
        return result;
    }

    async function readStakeBalance(options = {}) {
        const client = await dependencies();
        const wallet = root.solanaWalletManager?.getProvider?.()?.publicKey || null;
        if (!wallet) return null;
        const connection = await verifiedConnection();
        const mint = options.stakeMint || new root.solanaWeb3.PublicKey(DEVNET_USDC_MINT);
        const account = await tokenBalance(connection, client, wallet, mint);
        return account.amount;
    }

    async function requireTradingMarket(client, connection, proposal, marketAddress, programId, wallet) {
        const agreement = await readAgreement(connection, proposal);
        const { raw, address, sponsor } = await liveMarket(connection, client, proposal, agreement, marketAddress, programId);
        if (!raw) throw new Error('This agreement does not have an LMSR market yet.');
        if (raw.kind === 0 && agreement.status !== 'Active') throw new Error('Execution markets require an Active agreement.');
        const now = await chainNow(connection);
        if (raw.proposed || raw.closesAt <= BigInt(now)) {
            const error = new Error('Trading has closed for this agreement market.');
            error.code = 'MARKET_CLOSED';
            throw error;
        }
        if (raw.resolved) throw new Error('This market is already resolved.');
        if (publicKey(wallet) === sponsor || agreement.lenses.includes(publicKey(wallet))) {
            const error = new Error('The agreement sponsor and its lens members cannot trade this market.');
            error.code = 'INSIDER_TRADE';
            throw error;
        }
        return { agreement, raw, address, sponsor, now };
    }

    async function createMarket(options = {}) {
        const client = await dependencies();
        const { provider, wallet } = walletContext();
        if (!options.proposal) throw new Error('proposal account is required');
        const connection = await verifiedConnection();
        const agreement = await readAgreement(connection, options.proposal);
        // A public-record market's verifier is one of the agreement's lens members: the chosen one, or the first.
        const attester = options.trustedAttester ? publicKey(options.trustedAttester) : agreement.lenses[0];
        if (options.external && !agreement.lenses.includes(attester)) throw new Error('The verifier must be one of the agreement\'s lens members.');
        const publication = options.external ? { proposal: publicKey(options.proposal), trustedAttester: attester, external: options.external } : null;
        const recipe = publication ? root.ExternalMarketRecipe.build(publication) : null;
        const b = toPositiveBigInt(options.b ?? DEFAULT_B, 'b');
        const closesAt = options.closesAt ?? recipe?.closesAt ?? agreement.deadline;
        if (!Number.isSafeInteger(closesAt) || (recipe && recipe.closesAt !== closesAt)) {
            throw transactionError('The market and its question must have the same closing time.', 'INVALID_DEADLINE');
        }
        const terms = { proposal: options.proposal, creator: publicKey(wallet), stakeMint: DEVNET_USDC_MINT,
            b, closesAt, graceSeconds: options.graceSeconds ?? GRACE_SECONDS, maxPosition: options.maxPosition ?? MAX_POSITION,
            ...recipe?.commitments, programId: options.programId };
        const instruction = recipe ? client.buildCreateLmsrExternalMarketIx(terms) : client.buildCreateLmsrMarketIx(terms);
        const address = instruction.keys[0].pubkey;
        const existing = await liveMarket(connection, client, options.proposal, agreement, address, options.programId);
        if (existing.raw) return { replayed: true, marketAddress: publicKey(address), market: normalizedMarket(client, address, existing.raw), transactionHash: null, explorerUrl: null };
        if (!recipe && agreement.status !== 'Active') throw new Error('Execution markets require an Active agreement.');
        const now = await chainNow(connection);
        if (closesAt <= now) {
            throw transactionError('Choose a future market deadline.', 'INVALID_DEADLINE');
        }
        const seed = root.Lmsr.maxLoss(b);
        await preflightSol(connection, wallet);
        const creatorTokens = await tokenBalance(connection, client, wallet, DEVNET_USDC_MINT);
        if (!creatorTokens.exists || creatorTokens.amount < seed) {
            throw transactionError(`Market seed requires ${seed} atomic USDC units; ${creatorTokens.amount} available`, 'INSUFFICIENT_USDC');
        }
        if (recipe) {
            const response = await root.fetch(root.getBackendBase().replace(/\/$/, '') + '/markets/recipes', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(publication)
            });
            if (!response.ok || (await response.json()).cid !== recipe.cid) throw new Error('Could not publish the exact question and settlement terms.');
        }
        const receipt = await send(connection, provider, wallet, [instruction], options);
        return { ...receipt, marketAddress: publicKey(address) };
    }

    async function buy(options = {}) {
        const client = await dependencies();
        const { provider, wallet } = walletContext();
        if (!options.proposal) throw new Error('proposal account is required');
        const shares = toPositiveBigInt(options.shares, 'shares');
        const maxCost = toPositiveBigInt(options.maxCost, 'maxCost');
        const connection = await verifiedConnection();
        const context = await requireTradingMarket(client, connection, options.proposal, options.marketAddress, options.programId, wallet);
        await preflightSol(connection, wallet);
        const balance = await tokenBalance(connection, client, wallet, context.raw.stakeMint);
        if (!balance.exists || balance.amount < maxCost) {
            throw transactionError(`Insufficient market token balance: ${balance.amount} atomic units available`, 'INSUFFICIENT_USDC');
        }
        return send(connection, provider, wallet, [client.buildBuyIx({
            market: context.address, proposal: options.proposal, owner: wallet, stakeMint: context.raw.stakeMint,
            side: options.side, shares, maxCost, programId: options.programId
        })], options);
    }

    async function sell(options = {}) {
        const client = await dependencies();
        const { provider, wallet } = walletContext();
        if (!options.proposal) throw new Error('proposal account is required');
        const shares = toPositiveBigInt(options.shares, 'shares');
        const minReturn = toPositiveBigInt(options.minReturn, 'minReturn');
        const connection = await verifiedConnection();
        const context = await requireTradingMarket(client, connection, options.proposal, options.marketAddress, options.programId, wallet);
        const position = await client.readPosition(connection, context.address, wallet, options.side, options.programId);
        if (!position || position.amount < shares) throw new Error('Position does not hold enough shares to sell.');
        await preflightSol(connection, wallet);
        return send(connection, provider, wallet, [client.buildSellIx({
            market: context.address, proposal: options.proposal, owner: wallet, stakeMint: context.raw.stakeMint,
            side: options.side, shares, minReturn, programId: options.programId
        })], options);
    }

    function toPositiveBigInt(value, label) {
        let amount;
        if (typeof value === 'bigint') amount = value;
        else if (typeof value === 'string' && /^\d+$/.test(value.trim())) amount = BigInt(value.trim());
        else if (typeof value === 'number' && Number.isSafeInteger(value)) amount = BigInt(value);
        else throw new Error(`${label} must be a positive atomic integer`);
        if (amount <= 0n || amount > (1n << 64n) - 1n) throw new Error(`${label} must be a positive u64`);
        return amount;
    }

    async function resolve(options = {}) {
        const client = await dependencies();
        const { provider, wallet } = walletContext();
        if (!options.proposal) throw new Error('proposal account is required');
        const connection = await verifiedConnection();
        const agreement = await readAgreement(connection, options.proposal);
        const { raw, address } = await liveMarket(connection, client, options.proposal, agreement, options.marketAddress, options.programId);
        if (!raw) throw new Error('This agreement does not have an LMSR market yet.');
        if (raw.resolved) throw new Error('This market is already resolved.');
        const evidence = options.evidence || [];
        if (!Array.isArray(evidence) || evidence.length > 2 || (raw.kind === 0 && evidence.length)) throw new Error('Invalid evidence for this market.');
        const args = { market: address, proposal: options.proposal, schema: raw.kind === 1 ? raw.schema : root.solanaWeb3.SystemProgram.programId,
            programId: options.programId, evidence };
        let instruction;
        if (!raw.proposed) instruction = client.buildResolveLmsrIx(args);
        else if (await chainNow(connection) > Number(raw.challengeEndsAt)) instruction = client.buildFinalizeLmsrIx(args);
        else {
            if (evidence.length !== 1) throw new Error('Challenging this proposed outcome requires one qualifying attestation.');
            instruction = client.buildChallengeLmsrIx({ ...args, evidence: evidence[0] });
        }
        return send(connection, provider, wallet, [instruction], options);
    }

    function createAtaIdempotentlyInstruction(client, owner, mint, payer) {
        const web3 = root.solanaWeb3;
        const address = client.getAssociatedTokenAddress(owner, mint);
        return new web3.TransactionInstruction({
            programId: new web3.PublicKey(client.constants.ASSOCIATED_TOKEN_PROGRAM_ID),
            keys: [
                { pubkey: payer, isSigner: true, isWritable: true },
                { pubkey: address, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: new web3.PublicKey(client.constants.TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }
            ],
            data: Uint8Array.of(1)
        });
    }

    async function claim(options = {}) {
        const client = await dependencies();
        const { provider, wallet } = walletContext();
        if (!options.proposal) throw new Error('proposal account is required');
        const connection = await verifiedConnection();
        const agreement = await readAgreement(connection, options.proposal);
        const { raw, address } = await liveMarket(connection, client, options.proposal, agreement, options.marketAddress, options.programId);
        if (!raw?.resolved) throw new Error('This market has not been resolved yet.');
        const position = await client.readPosition(connection, address, wallet, options.side, options.programId);
        if (!position || position.claimed || position.amount <= 0n) throw new Error('There is no claimable position on this side.');
        const outcome = normalizedOutcome(client, raw);
        const entitledShares = outcome === 'void' ? position.amount / 2n : outcome === (options.side === client.constants.SIDE_YES ? 'yes' : 'no') ? position.amount : 0n;
        if (entitledShares <= 0n) throw new Error('This position has no payable claim.');
        await preflightSol(connection, wallet);
        const ata = client.getAssociatedTokenAddress(wallet, raw.stakeMint);
        const ataInfo = await connection.getAccountInfo(ata, 'confirmed');
        const instructions = [];
        if (!ataInfo) instructions.push(createAtaIdempotentlyInstruction(client, wallet, new root.solanaWeb3.PublicKey(raw.stakeMint), wallet));
        instructions.push(client.buildClaimLmsrIx({ market: address, owner: wallet, stakeMint: raw.stakeMint, side: options.side, programId: options.programId }));
        return send(connection, provider, wallet, instructions, options);
    }

    root.SolanaMarketBridge = { DEVNET_USDC_MINT, DEFAULT_B, GRACE_SECONDS, MAX_POSITION,
        readSummary, readAgreementState, readPositions, readStakeBalance, createMarket, buy, sell, resolve, claim };
})(typeof window !== 'undefined' ? window : null);
