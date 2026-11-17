// Wallet/RPC boundary for standalone Solana purchase and sale offers.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = { browser: factory };
    if (root?.document) root.PropertyOfferSolanaBridge = factory(root);
})(typeof window === 'undefined' ? null : window, function (win) {
    'use strict';
    const api = () => win.PropertyOfferClient;
    const text = (key, fallback) => win.getProposalI18nHelper?.()(`propertyOffer.${key}`, fallback) || fallback;
    const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    const hash = content => win.__consentSha256.sha256Bytes(win.Cid.canonicalBytes(content));
    function connectedWallet() {
        const provider = win.solanaWalletManager?.getProvider();
        return provider?.publicKey?.toBase58?.() || null;
    }
    async function context(record, signing = false) {
        if (!win.solanaWeb3) await win.ensureWalletVendors();
        api().configure({ web3: win.solanaWeb3, sha256Hex: win.__consentSha256.sha256Hex, sha256Bytes: win.__consentSha256.sha256Bytes });
        const cluster = record.onchain?.cluster || win.solanaWalletManager?.getCluster() || 'devnet';
        if (!['devnet', 'localnet'].includes(cluster)) throw new Error(text('devnetRequired', 'Property offers currently support Solana devnet and localnet.'));
        if (cluster === 'localnet' && !win.SOLANA_RPC_URLS?.localnet) throw new Error('A localnet RPC endpoint must be configured explicitly.');
        if (signing && win.solanaWalletManager?.getCluster() !== cluster) throw new Error(text('wrongNetwork', 'Switch the wallet to the offer’s Solana network.'));
        const provider = win.solanaWalletManager?.getProvider(), wallet = connectedWallet();
        if (signing && (!wallet || typeof provider.signTransaction !== 'function')) throw new Error(text('walletRequired', 'Connect a Solana wallet first.'));
        const connection = win.SolanaChainDataLoader.getConnection(cluster);
        if (cluster === 'devnet' && await connection.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('The RPC network does not match Solana devnet.');
        const program = await connection.getAccountInfo(new win.solanaWeb3.PublicKey(api().constants.PROPERTY_OFFER_PROGRAM_ID));
        if (!program?.executable) throw Object.assign(new Error(text('notDeployed', 'The property offer program is not deployed on the selected Solana network yet.')), { code: 'program-not-deployed' });
        if (!record.published?.cid || win.PropertyOfferRecord.cid(record.content) !== record.published.cid) throw new Error('Publish the exact offer terms before using Solana.');
        const address = api().getOfferPda(record.published.cid, record.content.proposer)[0].toBase58();
        if (record.onchain?.account && record.onchain.account !== address) throw new Error('The chain address does not match the published offer.');
        return { connection, provider, wallet, cluster, address };
    }
    async function readWith(record, ctx) {
        const chain = await api().fetchPropertyOffer(ctx.connection, { address: ctx.address });
        if (!chain) return null;
        const content = record.content;
        if (chain.cid !== record.published.cid || chain.maker !== content.proposer || chain.lens !== content.lens
            || chain.termsHash !== hex(hash(content)) || chain.priceLamports !== BigInt(content.priceLamports)
            || chain.deadline !== BigInt(Math.floor(Date.parse(content.expiresAt) / 1000)) || chain.side.toLowerCase() !== content.direction) {
            throw new Error('The chain account does not match the published offer terms.');
        }
        if (content.direction === 'sell' && chain.payoutsHash !== hex(api().payoutScheduleHash(content.payouts))) throw new Error('The sale payout schedule differs from the published offer.');
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
        if (simulated.value?.err) throw new Error(`Solana simulation failed: ${JSON.stringify(simulated.value.err)}`);
        status('awaiting_signature');
        const signed = await ctx.provider.signTransaction(transaction);
        const signature = await ctx.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        status('submitted', { signature });
        const confirmed = await ctx.connection.confirmTransaction({ ...latest, signature }, 'confirmed');
        if (confirmed.value.err) throw new Error(`Solana transaction failed: ${JSON.stringify(confirmed.value.err)}`);
        status('confirmed', { signature }); return signature;
    }
    async function persist(record, ctx, signature) {
        const chain = await readWith(record, ctx);
        const ref = { chain: 'solana', cluster: ctx.cluster, account: ctx.address, signature, status: chain?.status?.toLowerCase() };
        // Keep the confirmed reference locally even if the index is temporarily unreachable.
        const saved = win.PropertyOfferStore.save({ ...record, onchain: ref });
        try { return await win.PropertyOfferSync.recordOnchain(saved, ref); }
        catch (cause) { throw Object.assign(new Error(text('indexFailed', 'The Solana transaction confirmed, but the server could not refresh it. Refresh the offer to retry.')), { cause, signature, record: saved }); }
    }
    async function mint(record, options) {
        const ctx = await context(record, true);
        if (ctx.wallet !== record.content.proposer) throw new Error(text('makerOnly', 'Only the proposer can create this offer on Solana.'));
        if (await readWith(record, ctx)) return persist(record, ctx, record.onchain?.signature || null);
        const content = record.content;
        const { instruction } = api().buildCreateIx({ maker: ctx.wallet, cid: record.published.cid, lens: content.lens,
            side: content.direction, termsHash: hash(content), priceLamports: content.priceLamports,
            deadline: Math.floor(Date.parse(content.expiresAt) / 1000), payouts: content.payouts || [] });
        return persist(record, ctx, await send(ctx, [instruction], options));
    }
    async function mutate(record, build, options) {
        const ctx = await context(record, true), chain = await readWith(record, ctx);
        if (!chain) throw new Error(text('mintFirst', 'Create this offer on Solana first.'));
        return persist(record, ctx, await send(ctx, await build(ctx, chain), options));
    }
    async function prepareAcceptance(record, candidate = {}) {
        const ctx = await context(record), c = record.content;
        const buyer = c.direction === 'buy' ? c.proposer : candidate.buyer;
        const seller = c.direction === 'sell' ? c.proposer : candidate.seller;
        if (![buyer, seller].every(key => win.LensCore.isBase58Pubkey(key)) || buyer === seller) throw new Error('Choose distinct buyer and seller wallets.');
        const normalized = win.PropertyOfferRecord.published({ ...c, direction: 'sell', buyer: null, seller: c.proposer,
            payouts: c.direction === 'sell' ? c.payouts : candidate.payouts });
        const prepared = { cid: record.published.cid, offer: ctx.address, termsHash: hex(hash(c)),
            payoutsHash: hex(api().payoutScheduleHash(normalized.payouts)), buyer, seller, payouts: normalized.payouts, consents: [] };
        const unchanged = ['cid', 'offer', 'termsHash', 'payoutsHash', 'buyer', 'seller'].every(name => candidate[name] === prepared[name]);
        if (unchanged && Array.isArray(candidate.consents)) prepared.consents = candidate.consents.map(row => ({ owner: row.owner, signature: row.signature }));
        return prepared;
    }
    async function signMessage(message) {
        const provider = win.solanaWalletManager?.getProvider();
        if (typeof provider?.signMessage !== 'function') throw new Error(text('signMessageRequired', 'Connect a Solana wallet that supports message signing.'));
        const signed = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
        const signature = signed?.signature || signed;
        if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('The wallet did not return a valid message signature.');
        return win.LensCore.base58Encode(signature);
    }
    async function signAcceptance(record, candidate) {
        const prepared = await prepareAcceptance(record, candidate), owner = connectedWallet();
        if (!prepared.payouts.some(row => row.recipient === owner)) throw new Error('The connected wallet is not a seller in this payout schedule.');
        const signature = await signMessage(win.PropertyOfferConsent.sellerConsentMessage({ ...prepared, seller: owner }));
        return { ...prepared, consents: [...prepared.consents.filter(row => row.owner !== owner), { owner, signature }] };
    }
    async function accept(record, { candidate, ...options } = {}) {
        const prepared = await prepareAcceptance(record, candidate);
        const requester = record.content.direction === 'buy' ? prepared.seller : prepared.buyer;
        if (connectedWallet() !== requester) throw new Error('Connect the accepting counterparty’s wallet.');
        if (prepared.payouts.some(row => !prepared.consents.some(consent => consent.owner === row.recipient))) throw new Error('Every seller must sign the exact payment schedule before acceptance.');
        const signature = await signMessage(win.PropertyOfferConsent.requestMessage(prepared));
        const directory = await win.LensServiceClient.fetchDirectory({ base: win.resolveBackendBaseUrl(), fetchImpl: win.fetch.bind(win) });
        const member = directory.members.find(member => member.key === record.content.lens);
        if (!member?.serviceUrl) throw new Error('This lens has no registered decision service.');
        const response = await win.fetch(`${member.serviceUrl}/lens/property-offers/${encodeURIComponent(record.published.cid)}/decision`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
            body: JSON.stringify({ ...prepared, requester, signature })
        });
        const decision = await response.json();
        if (!response.ok) throw new Error(decision.message || decision.error || `Lens HTTP ${response.status}`);
        return mutate(record, ctx => [api().buildAcceptIx({ offer: ctx.address, counterparty: ctx.wallet,
            payouts: record.content.direction === 'buy' ? prepared.payouts : [], attestation: decision.address, credential: decision.credential })], options);
    }
    async function fund(record, options) { return mutate(record, (ctx) => [api().buildFundIx({ offer: ctx.address, buyer: ctx.wallet })], options); }
    async function release(record, options) {
        return mutate(record, (ctx, chain) => [api().buildExecuteIx({ offer: ctx.address, recipients: chain.payouts.map(payout => payout.recipient) })], options);
    }
    async function cancel(record, options) { return mutate(record, ctx => [api().buildCancelIx({ offer: ctx.address, authority: ctx.wallet })], options); }
    async function expire(record, options) { return mutate(record, (ctx, chain) => [api().buildExpireIx({ offer: ctx.address, buyer: chain.buyer === api().constants.DEFAULT_PUBKEY ? chain.maker : chain.buyer })], options); }
    async function refresh(record) { const ctx = await context(record); return persist(record, ctx, record.onchain?.signature || null); }
    return Object.freeze({ connectedWallet, mint, read, prepareAcceptance, signAcceptance, accept, fund, release, cancel, expire, refresh });
});
