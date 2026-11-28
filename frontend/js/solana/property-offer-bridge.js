// Wallet/RPC boundary for property offers v2 and lens members' property statements: each action is
// one wallet approval. The maker mints (a buyer pays into escrow at once), the counterparty commits
// (a buyer pays then), each lens member confirms from its own wallet, and the last confirmation also
// pays the schedule. Chain state is always re-read before it is shown or indexed.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = { browser: factory };
    if (root?.document) root.PropertyOfferSolanaBridge = factory(root);
})(typeof window === 'undefined' ? null : window, function (win) {
    'use strict';
    const api = () => win.PropertyOfferClient;
    const statements = () => win.PropertyStatements;
    const text = (key, fallback, vars) => win.getProposalI18nHelper?.()(`propertyOffer.${key}`, fallback, vars) || fallback;
    const fail = (key, fallback, code, vars) => Object.assign(new Error(text(key, fallback, vars)), { code });
    const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    const hash = content => win.__consentSha256.sha256Bytes(win.Cid.canonicalBytes(content));
    const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    function connectedWallet() {
        const provider = win.solanaWalletManager?.getProvider();
        return provider?.publicKey?.toBase58?.() || null;
    }
    async function network(signing = false, cluster = win.solanaWalletManager?.getCluster() || 'devnet') {
        if (win.ensureWalletVendors && !await win.ensureWalletVendors('solana')) throw new Error('The Solana library could not be loaded.');
        api().configure({ web3: win.solanaWeb3, sha256Hex: win.__consentSha256.sha256Hex, sha256Bytes: win.__consentSha256.sha256Bytes });
        statements().configure({ web3: win.solanaWeb3 });
        if (!['devnet', 'localnet'].includes(cluster)) throw fail('devnetRequired', 'Property offers work on Solana devnet for now.', 'devnet-required');
        if (cluster === 'localnet' && !win.SOLANA_RPC_URLS?.localnet) throw new Error('A localnet RPC endpoint must be configured explicitly.');
        if (signing && win.solanaWalletManager?.getCluster() !== cluster) throw fail('wrongNetwork', 'Switch the wallet to Solana {{cluster}}.', 'wrong-network', { cluster });
        const provider = win.solanaWalletManager?.getProvider(), wallet = connectedWallet();
        if (signing && (!wallet || typeof provider?.signTransaction !== 'function')) throw fail('errors.wallet', 'Connect a Solana wallet first.', 'wallet-required');
        const connection = win.SolanaChainDataLoader.getConnection(cluster);
        if (cluster === 'devnet' && await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('The RPC network does not match Solana devnet.');
        return { connection, provider, wallet, cluster };
    }
    async function context(record, signing = false) {
        const ctx = await network(signing, record.onchain?.cluster || win.solanaWalletManager?.getCluster() || 'devnet');
        const program = await ctx.connection.getAccountInfo(new win.solanaWeb3.PublicKey(api().constants.PROPERTY_OFFER_PROGRAM_ID));
        if (!program?.executable) throw fail('notDeployed', 'The property offer program is not on this Solana network yet.', 'program-not-deployed');
        if (!record.published?.cid || win.PropertyOfferRecord.cid(record.content) !== record.published.cid) throw fail('publishFirst', 'Publish the exact offer terms before using Solana.', 'unpublished');
        const address = api().getOfferPda(record.published.cid, record.content.proposer)[0].toBase58();
        if (record.onchain?.account && record.onchain.account !== address) throw new Error('The chain address does not match the published offer.');
        return { ...ctx, address };
    }
    const sameLens = (chainLens, lens) => chainLens.members.length === lens.members.length && chainLens.members.every((k, i) => k === lens.members[i]) && chainLens.threshold === lens.threshold;
    async function readWith(record, ctx) {
        const chain = await api().fetchPropertyOffer(ctx.connection, { address: ctx.address });
        if (!chain) return null;
        const c = record.content;
        const makerLens = c.direction === 'buy' ? chain.buyerLens : chain.sellerLens;
        if (chain.cid !== record.published.cid || chain.maker !== c.proposer || chain.termsHash !== hex(hash(c)) || chain.price !== BigInt(c.price) || chain.currency !== c.currency
            || chain.deadline !== BigInt(Math.floor(Date.parse(c.expiresAt) / 1000)) || chain.side.toLowerCase() !== c.direction || !sameLens(makerLens, c.lens)) {
            throw fail('chainMismatch', 'The Solana account does not match the published offer terms.', 'chain-mismatch');
        }
        if (c.direction === 'sell' && chain.payoutsHash !== hex(api().payoutScheduleHash(c.payouts))) throw fail('chainMismatch', 'The Solana account does not match the published offer terms.', 'chain-mismatch');
        return chain;
    }
    async function read(record) { return readWith(record, await context(record)); }
    async function send(ctx, instructions, options = {}) {
        const status = (state, extra = {}) => options.onStatus?.({ state, ...extra });
        status('preparing');
        const latest = await ctx.connection.getLatestBlockhash('confirmed');
        const transaction = new win.solanaWeb3.Transaction({ feePayer: new win.solanaWeb3.PublicKey(ctx.wallet), recentBlockhash: latest.blockhash });
        instructions.forEach(ix => transaction.add(ix));
        const simulated = await ctx.connection.simulateTransaction(transaction);
        if (simulated.value?.err) throw simulationError(simulated.value);
        status('awaiting_signature');
        const signed = await ctx.provider.signTransaction(transaction);
        const signature = await ctx.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        status('submitted', { signature });
        const confirmed = await ctx.connection.confirmTransaction({ ...latest, signature }, 'confirmed');
        if (confirmed.value.err) throw new Error(`Solana transaction failed: ${JSON.stringify(confirmed.value.err)}`);
        status('confirmed', { signature }); return signature;
    }
    // A failed simulation in words a person can act on; the program's own message when it gave one.
    function simulationError(value) {
        const logs = (value.logs || []).join('\n');
        if (/insufficient (lamports|funds)/i.test(logs) || /InsufficientFunds/.test(JSON.stringify(value.err))) return fail('insufficientFunds', 'The wallet does not hold enough SOL or USDC for this, fees included.', 'insufficient-funds');
        const anchorMessage = logs.match(/Error Message: ([^.\n]+)/);
        if (anchorMessage) return Object.assign(new Error(anchorMessage[1]), { code: 'program-refused', logs });
        if (/already in use/.test(logs)) return fail('alreadyStated', 'This lens member has already made this statement.', 'already-stated');
        return Object.assign(new Error(`Solana simulation failed: ${JSON.stringify(value.err)}`), { logs });
    }
    // Ordered instruction groups in as few transactions as fit (property-offer-client packParts), each
    // confirmed before the next is sent: a payout that does not fit beside its confirmation asks a
    // second approval. → the last signature.
    async function sendParts(ctx, parts, options) {
        let signature = null;
        for (const group of api().packParts(parts, instructions => api().fitsTransaction(instructions, ctx.wallet))) signature = await send(ctx, group, options);
        return signature;
    }
    async function persist(record, ctx, signature) {
        const chain = await readWith(record, ctx);
        const ref = { chain: 'solana', cluster: ctx.cluster, account: ctx.address, signature, status: chain?.status?.toLowerCase() };
        const saved = win.PropertyOfferStore.save({ ...record, onchain: ref });
        try { return await win.PropertyOfferSync.recordOnchain(saved, ref); }
        catch (cause) { throw Object.assign(new Error(text('indexFailed', 'Solana confirmed it, but the server could not refresh the offer. Refresh it to retry.')), { cause, signature, record: saved }); }
    }
    async function mutate(record, build, options) {
        const ctx = await context(record, true), chain = await readWith(record, ctx);
        if (!chain) throw fail('mintFirst', 'Create this offer on Solana first.', 'not-minted');
        return persist(record, ctx, await send(ctx, await build(ctx, chain), options));
    }
    const deadlineOf = content => Math.floor(Date.parse(content.expiresAt) / 1000);

    /** The maker creates the offer; a buy offer's price goes into escrow in the same approval. */
    async function mint(record, options) {
        const ctx = await context(record, true);
        if (ctx.wallet !== record.content.proposer) throw fail('makerOnly', 'Only the proposer can create this offer on Solana.', 'maker-only');
        if (await readWith(record, ctx)) return persist(record, ctx, record.onchain?.signature || null);
        const c = record.content;
        const { instructions } = api().buildCreateIxs({ maker: ctx.wallet, currency: c.currency, cid: record.published.cid, side: c.direction, termsHash: hash(c),
            price: c.price, deadline: deadlineOf(c), payouts: c.payouts || [], lens: c.lens.members, lensThreshold: c.lens.threshold });
        return persist(record, ctx, await send(ctx, instructions, options));
    }
    /**
     * The counterparty takes the offer and names its side's lens: a buyer taking a listing names the
     * lens whose members must confirm the seller holds it, and pays; a seller taking a bid names the
     * payouts and, optionally, a lens that must qualify the buyer.
     */
    async function commit(record, { lens, payouts = [], ...options } = {}) {
        return mutate(record, (ctx, chain) => {
            if (chain.status !== 'Open') throw fail('notOpen', 'This offer is no longer open.', 'not-open');
            if (ctx.wallet === chain.maker) throw fail('selfDeal', 'Use another wallet than the one that made the offer.', 'self-deal');
            return api().buildCommitIxs({ offer: ctx.address, counterparty: ctx.wallet, currency: chain.currency, side: record.content.direction,
                payouts: record.content.direction === 'buy' ? payouts : [], lens: lens.members, lensThreshold: lens.threshold });
        }, options);
    }

    /** One lens member's view of the asset: who holds it according to its own statements. */
    async function memberView(ctx, member, assetHash) {
        const getAccount = async address => (await ctx.connection.getAccountInfo(new win.solanaWeb3.PublicKey(address), 'confirmed'))?.data || null;
        return win.PropertyHolders.viewOf({ member, assetHash, getAccount, statements: statements(), offers: api() });
    }
    async function lensView(members, asset) {
        const ctx = await network(false);
        const getAccount = async address => (await ctx.connection.getAccountInfo(new win.solanaWeb3.PublicKey(address), 'confirmed'))?.data || null;
        return win.PropertyHolders.lensView({ members, assetHash: win.PropertyOfferRecord.assetHash(asset), getAccount, statements: statements(), offers: api() });
    }
    /** What the connected wallet may do as a lens member of this committed offer, and why not. */
    async function memberActions(record) {
        const ctx = await context(record), chain = await readWith(record, ctx), wallet = connectedWallet();
        if (!chain || !wallet) return { chain, roles: [] };
        const roles = [];
        for (const [role, lens] of [[0, chain.buyerLens], [1, chain.sellerLens]]) {
            if (!lens.members.includes(wallet)) continue;
            const entry = { role, confirmed: lens.confirmed.includes(wallet) };
            if (role === 0) entry.view = await memberView(ctx, wallet, win.PropertyOfferRecord.assetHash(record.content.asset));
            roles.push(entry);
        }
        return { chain, roles };
    }
    /**
     * Confirm as a lens member. Role 0 (buyer's lens): the member's own statements must name the
     * seller as holder; the confirmation lands at the address of that holding, so the same member
     * cannot confirm a second sale of it. When this completes both lenses the payout follows in the
     * same approval.
     */
    async function confirmOffer(record, { role, ...options } = {}) {
        const ctx = await context(record, true);
        const chain = await readWith(record, ctx);
        if (!chain || chain.status !== 'Committed') throw fail('notCommitted', 'Both sides must commit before lens members confirm.', 'not-committed');
        const lens = role === 0 ? chain.buyerLens : chain.sellerLens;
        if (!lens.members.includes(ctx.wallet)) throw fail('notMember', 'This wallet is not a lens member of this offer.', 'not-lens-member');
        if (lens.confirmed.includes(ctx.wallet)) throw fail('alreadyConfirmed', 'You have already confirmed this offer.', 'already-confirmed');
        const assetHash = win.PropertyOfferRecord.assetHash(record.content.asset);
        let holding = '';
        if (role === 0) {
            const view = await memberView(ctx, ctx.wallet, assetHash);
            if (!view.holder) throw fail('noHolderStated', 'You have not stated who holds this. State the first holder before confirming a sale.', 'no-holder-stated');
            if (view.holder !== chain.seller) throw fail('sellerNotHolder', 'Your statements say {{holder}} holds this, not the seller.', 'seller-not-holder', { holder: view.holder });
            if (view.pending && view.pending.offer !== ctx.address) throw fail('otherSalePending', 'You have confirmed another sale of this holding that is still open.', 'other-sale-pending');
            if (view.stale) throw fail('staleConfirmation', 'Withdraw your confirmation of the earlier sale that did not complete first.', 'stale-confirmation');
            holding = view.holding;
        }
        const now = await ctx.connection.getBlockTime(await ctx.connection.getSlot('confirmed'));
        const payload = api().encodeDecisionPayload({ cid: chain.cid, offer: ctx.address, termsHash: chain.termsHash, payoutsHash: chain.payoutsHash, buyer: chain.buyer, seller: chain.seller,
            role, assetHash, holding, observedAt: now });
        const nonce = api().decisionNonce({ role, assetHash, holding, offer: ctx.address });
        const issued = statements().buildCreateAttestationIx({ payer: ctx.wallet, authority: ctx.wallet, kind: 'confirmation', nonce, payload, expiry: now + statements().constants.STATEMENT_EXPIRY_SECONDS });
        const setup = await statements().setupIxs(ctx.connection, { payer: ctx.wallet, authority: ctx.wallet, kinds: ['confirmation'] });
        const instructions = [issued.instruction, api().buildConfirmIx({ offer: ctx.address, attestation: issued.attestation, credential: issued.credential })];
        const other = role === 0 ? chain.sellerLens : chain.buyerLens;
        const completes = lens.confirmed.length + 1 >= lens.threshold && other.met;
        const payout = completes ? api().buildExecuteIxs({ offer: ctx.address, currency: chain.currency, recipients: chain.payouts.map(p => p.recipient), payer: ctx.wallet }) : [];
        const signature = await sendParts(ctx, [setup, instructions, payout], options);
        return { ...(await persist(record, ctx, signature)), executed: completes, attestation: issued.attestation };
    }
    async function execute(record, options) {
        return mutate(record, (ctx, chain) => api().buildExecuteIxs({ offer: ctx.address, currency: chain.currency, recipients: chain.payouts.map(p => p.recipient), payer: ctx.wallet }), options);
    }
    async function cancel(record, options) { return mutate(record, (ctx, chain) => [api().buildCancelIx({ offer: ctx.address, maker: ctx.wallet, currency: chain.currency })], options); }
    async function expire(record, options) {
        return mutate(record, (ctx, chain) => [api().buildExpireIx({ offer: ctx.address, currency: chain.currency, buyer: chain.buyer || chain.maker })], options);
    }
    async function refresh(record) { const ctx = await context(record); if (!await readWith(record, ctx)) return record; return persist(record, ctx, record.onchain?.signature || null); }

    /** A lens member states who first holds an asset (the developer's lens for new builds, or a confirmed self-declaration). */
    async function stateHolding({ asset, holder, basis, evidence = '', ...options }) {
        const ctx = await network(true);
        const assetHash = win.PropertyOfferRecord.assetHash(asset);
        if (await ctx.connection.getAccountInfo(statements().holdingAddress(ctx.wallet, assetHash), 'confirmed')) throw fail('holdingExists', 'You have already stated who first holds this. Withdraw that statement to state another.', 'holding-exists');
        const now = await ctx.connection.getBlockTime(await ctx.connection.getSlot('confirmed'));
        const issued = statements().buildHoldingIx({ payer: ctx.wallet, authority: ctx.wallet, assetHash, asset: win.PropertyOfferRecord.assetKey(asset), holder, basis, evidence, observedAt: now });
        const setup = await statements().setupIxs(ctx.connection, { payer: ctx.wallet, authority: ctx.wallet, kinds: ['holding'] });
        const signature = await sendParts(ctx, [setup, [issued.instruction]], options);
        return { signature, attestation: issued.attestation };
    }
    /** A lens member withdraws one of its own statements (a first holder, or a confirmation of a sale that did not complete). */
    async function withdraw({ attestation, ...options }) {
        const ctx = await network(true);
        return { signature: await send(ctx, [statements().buildCloseAttestationIx({ payer: ctx.wallet, authority: ctx.wallet, attestation })], options) };
    }
    /** The connected wallet signs a self-declaration request for lens members to confirm. */
    async function signMessage(message) {
        const provider = win.solanaWalletManager?.getProvider();
        if (typeof provider?.signMessage !== 'function') throw fail('signMessageRequired', 'Connect a Solana wallet that can sign messages.', 'sign-message-required');
        const signed = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
        const signature = signed?.signature || signed;
        if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('The wallet did not return a valid message signature.');
        return win.LensCore.base58Encode(signature);
    }
    return Object.freeze({ connectedWallet, mint, commit, confirm: confirmOffer, execute, cancel, expire, read, refresh, memberActions, lensView, stateHolding, withdraw, signMessage });
});
