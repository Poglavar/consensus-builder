// Shared browser/agent adapter for AgreementMarkets + Gnosis CTF/LMSR. Amounts are atomic USDC.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.EvmMarkets = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const ZERO = '0x0000000000000000000000000000000000000000';
    const HASH_ZERO = `0x${'0'.repeat(64)}`;
    const MAX = (1n << 255n) - 1n;
    const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const ABIS = Object.freeze({
        markets: ['function agreement() view returns(address)', 'function reporter() view returns(address)',
            'function conditionalTokens() view returns(address)', 'function collateral() view returns(address)',
            'function marketOf(bytes32) view returns(address)', 'function conditionIdOf(bytes32) view returns(bytes32)',
            'function reclaimed(bytes32) view returns(bool)', 'function fundingFor(uint256) view returns(uint256)',
            'function open(bytes32,uint256) returns(address)', 'function reclaim(bytes32) returns(uint256)'],
        token: ['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
            'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'],
        ctf: ['function getCollectionId(bytes32,bytes32,uint256) view returns(bytes32)',
            'function getPositionId(address,bytes32) pure returns(uint256)', 'function balanceOf(address,uint256) view returns(uint256)',
            'function payoutDenominator(bytes32) view returns(uint256)', 'function payoutNumerators(bytes32,uint256) view returns(uint256)',
            'function isApprovedForAll(address,address) view returns(bool)', 'function setApprovalForAll(address,bool)',
            'function redeemPositions(address,bytes32,bytes32,uint256[])'],
        maker: ['function calcNetCost(int256[]) view returns(int256)', 'function calcMarginalPrice(uint8) view returns(uint256)',
            'function trade(int256[],int256) returns(int256)'],
        reporter: ['function report(bytes32)'],
        agreement: ['function get(bytes32) view returns(tuple(address sponsor,address lens,address payout,uint64 deadline,uint64 createdAt,uint256 requiredWei,uint256 escrowWei,uint8 status,bool openGround,uint8 decision,uint64 decisionAttestedAt,uint64 decisionObservedAt,bytes32 decisionAttestation,bytes32 decisionHash,uint64 executedAt,string cid))', 'function expire(bytes32)']
    });
    function atomic(value, allowZero = false) {
        if (typeof value !== 'bigint' && !(typeof value === 'string' && /^\d+$/.test(value))) fail('invalid-amount', 'Use whole atomic units as a decimal string.');
        const n = BigInt(value);
        if (n < (allowZero ? 0n : 1n) || n > MAX) fail('invalid-amount', 'Amount is outside the supported range.');
        return n;
    }
    function sideIndex(side) {
        if (side === 'no' || side === 0) return 0;
        if (side === 'yes' || side === 1) return 1;
        return fail('invalid-side', 'Choose YES or NO.');
    }
    function amounts(side, shares, action) {
        if (!['buy', 'sell'].includes(action)) fail('invalid-action', 'Choose buy or sell.');
        const result = [0n, 0n]; result[sideIndex(side)] = atomic(shares) * (action === 'buy' ? 1n : -1n); return result;
    }
    function create({ ethers, provider, signer = null, chainId, addresses, contract = (address, abi, runner) => new ethers.Contract(address, abi, runner) }) {
        const id = String(Number(chainId));
        if (!['31337', '84532', '11155111'].includes(id)) fail('unknown-chain', 'EVM markets support local and Sepolia test networks only.');
        for (const name of ['Agreement', 'AgreementMarkets', 'ConditionalTokens', 'AgreementOutcomeReporter', 'MarketCollateral']) {
            if (!ethers.isAddress(addresses?.[name]) || same(addresses[name], ZERO)) fail('markets-not-deployed', `Agreement markets are not configured on chain ${id}.`);
        }
        const runner = signer || provider;
        const registry = contract(addresses.AgreementMarkets, ABIS.markets, runner);
        const agreement = contract(addresses.Agreement, ABIS.agreement, runner);
        const token = contract(addresses.MarketCollateral, ABIS.token, runner);
        const ctf = contract(addresses.ConditionalTokens, ABIS.ctf, runner);
        const reporter = contract(addresses.AgreementOutcomeReporter, ABIS.reporter, runner);
        async function check() {
            const actualChain = provider.send ? BigInt(await provider.send('eth_chainId', [])) : (await provider.getNetwork()).chainId;
            if (String(actualChain) !== id) fail('wrong-chain', `Connect to chain ${id}.`);
            const linked = await Promise.all([registry.agreement(), registry.reporter(), registry.conditionalTokens(), registry.collateral(), token.decimals()]);
            if (!linked.slice(0, 4).every((a, i) => same(a, addresses[['Agreement', 'AgreementOutcomeReporter', 'ConditionalTokens', 'MarketCollateral'][i]])) || Number(linked[4]) !== 6) {
                fail('market-config-mismatch', 'Market contracts or collateral do not match the configured deployment.');
            }
        }
        function keyOf(key) {
            if (!/^0x[0-9a-fA-F]{64}$/.test(key || '')) fail('invalid-agreement', 'An EVM agreement key is required.');
            return key;
        }
        const owner = async () => signer ? signer.getAddress() : null;
        async function context(key, requireMarket = true) {
            keyOf(key); await check();
            const [record, marketAddress, conditionId, block] = await Promise.all([agreement.get(key), registry.marketOf(key), registry.conditionIdOf(key), provider.getBlock('latest')]);
            if (!block) fail('chain-unavailable', 'Could not read chain time.');
            const exists = !same(marketAddress, ZERO);
            if (requireMarket && !exists) fail('market-not-open', 'The sponsor has not opened this market.');
            const status = Number(record.status);
            return { key, record, status, marketAddress: exists ? marketAddress : null, conditionId,
                tradable: status === 0 && (!record.deadline || BigInt(block.timestamp) < BigInt(record.deadline)),
                maker: exists ? contract(marketAddress, ABIS.maker, runner) : null, now: block.timestamp };
        }
        async function positionId(conditionId, side) {
            const collection = await ctf.getCollectionId(HASH_ZERO, conditionId, 1 << sideIndex(side));
            return ctf.getPositionId(addresses.MarketCollateral, collection);
        }
        async function read(key, wallet = null) {
            const ctx = await context(key, false), who = wallet || await owner();
            const denominator = ctx.maker ? BigInt(await ctf.payoutDenominator(ctx.conditionId)) : 0n;
            const positions = { no: 0n, yes: 0n };
            if (who && ctx.maker) for (const side of ['no', 'yes']) positions[side] = BigInt(await ctf.balanceOf(who, await positionId(ctx.conditionId, side)));
            return { chainId: id, agreementAccount: key, sponsor: ctx.record.sponsor, lens: ctx.record.lens,
                agreementStatus: ['active', 'executed', 'cancelled', 'expired'][ctx.status], deadline: Number(ctx.record.deadline),
                marketAddress: ctx.marketAddress, conditionId: ctx.conditionId, tradable: !!ctx.maker && ctx.tradable,
                canResolve: !!ctx.maker && !denominator && (ctx.status !== 0 || !!ctx.record.deadline && BigInt(ctx.now) > BigInt(ctx.record.deadline)),
                resolved: denominator > 0n, outcome: denominator ? (BigInt(await ctf.payoutNumerators(ctx.conditionId, 1)) > 0n ? 'yes' : 'no') : null,
                chanceYes: ctx.maker && !denominator ? Number(await ctx.maker.calcMarginalPrice(1)) / 2 ** 64 : null,
                reclaimed: ctx.maker ? await registry.reclaimed(key) : false, positions,
                wallet: who, balanceAtomic: who ? BigInt(await token.balanceOf(who)) : null };
        }
        async function quote({ key, side, shares, action = 'buy' }) {
            const ctx = await context(key);
            if (!ctx.tradable) fail('market-closed', 'Trading has closed.');
            const net = BigInt(await ctx.maker.calcNetCost(amounts(side, shares, action)));
            if (action === 'buy' ? net <= 0n : net >= 0n) fail('invalid-quote', 'The amount is too small to trade.');
            return { key, chainId: id, side: sideIndex(side) === 1 ? 'yes' : 'no', shares: atomic(shares), action, amountAtomic: action === 'buy' ? net : -net };
        }
        // Quote against the actual maker. Bounded integer binary search never rounds a budget upward.
        async function quoteBudget({ key, side, budget }) {
            const limit = atomic(budget), ctx = await context(key);
            if (!ctx.tradable) fail('market-closed', 'Trading has closed.');
            // The agent's bounded test-money budget also bounds quote RPC work.
            if (limit > 1_000_000_000n) fail('budget-too-large', 'A quote budget cannot exceed 1000 test USDC.');
            let low = 0n, high = limit;
            const cost = n => ctx.maker.calcNetCost(amounts(side, n, 'buy')).then(BigInt);
            for (let i = 0; i < 32 && await cost(high) <= limit; i++) { low = high; high *= 2n; }
            if (await cost(high) <= limit) fail('quote-range', 'Could not bound the share quote.');
            while (high - low > 1n) { const mid = (low + high) / 2n; if (await cost(mid) <= limit) low = mid; else high = mid; }
            if (!low) fail('invalid-quote', 'The budget is too small to buy a share.');
            const net = await cost(low);
            if (net <= 0n || net > limit) fail('invalid-quote', 'Could not quote within the budget.');
            return { key, chainId: id, side: sideIndex(side) === 1 ? 'yes' : 'no', action: 'buy', shares: low, amountAtomic: net };
        }
        async function send(target, method, args, onStatus = () => {}) {
            if (!signer) fail('wallet-not-connected', 'Connect an EVM wallet.');
            await check();
            onStatus({ state: 'preparing', operation: method });
            await target[method].staticCall(...args);
            onStatus({ state: 'awaiting_signature', operation: method });
            const tx = await target[method](...args);
            onStatus({ state: 'submitted', operation: method, signature: tx.hash });
            const receipt = await tx.wait();
            if (!receipt || Number(receipt.status) !== 1) fail('transaction-failed', 'The transaction did not succeed.');
            onStatus({ state: 'confirmed', operation: method, signature: receipt.hash || tx.hash });
            return receipt.hash || tx.hash;
        }
        async function approve(spender, amount, onStatus) {
            const allowance = BigInt(await token.allowance(await owner(), spender));
            if (allowance >= amount) return;
            if (allowance > 0n) await send(token, 'approve', [spender, 0n], onStatus);
            await send(token, 'approve', [spender, amount], onStatus);
        }
        async function trade({ key, side, shares, action = 'buy', limit, onStatus }) {
            const bound = atomic(limit), ctx = await context(key);
            if (!signer) fail('wallet-not-connected', 'Connect an EVM wallet.');
            const quoted = await quote({ key, side, shares, action });
            if (action === 'buy' ? quoted.amountAtomic > bound : quoted.amountAtomic < bound) fail('slippage', 'The quote moved beyond your limit. Quote again.');
            if (action === 'buy') await approve(ctx.marketAddress, bound, onStatus);
            else {
                const who = await owner();
                if (BigInt(await ctf.balanceOf(who, await positionId(ctx.conditionId, side))) < atomic(shares)) fail('insufficient-shares', 'Not enough shares to sell.');
                if (!await ctf.isApprovedForAll(who, ctx.marketAddress)) await send(ctf, 'setApprovalForAll', [ctx.marketAddress, true], onStatus);
            }
            const signature = await send(ctx.maker, 'trade', [amounts(side, shares, action), action === 'buy' ? bound : -bound], onStatus);
            return { signature, ...await read(key) };
        }
        async function open({ key, liquidity, maxFunding, onStatus }) {
            const b = atomic(liquidity), cap = atomic(maxFunding), ctx = await context(key, false);
            if (!signer || !same(await owner(), ctx.record.sponsor)) fail('not-sponsor', 'Only the sponsor can open this market.');
            if (ctx.maker) return { signature: null, ...await read(key) };
            if (!ctx.tradable) fail('market-closed', 'The agreement is not active before its deadline.');
            const funding = BigInt(await registry.fundingFor(b));
            if (funding > cap) fail('funding-cap', 'Market funding exceeds the authorized cap.');
            await approve(addresses.AgreementMarkets, funding, onStatus);
            const signature = await send(registry, 'open', [key, b], onStatus);
            const state = await read(key);
            if (!state.marketAddress) fail('market-not-open', 'Market creation could not be verified.');
            return { signature, funding, ...state };
        }
        async function resolve({ key, onStatus }) {
            const ctx = await context(key);
            if (BigInt(await ctf.payoutDenominator(ctx.conditionId))) return { signature: null, ...await read(key) };
            if (ctx.status === 0) {
                if (!ctx.record.deadline || BigInt(ctx.now) <= BigInt(ctx.record.deadline)) fail('agreement-active', 'The agreement has not ended.');
                await send(agreement, 'expire', [key], onStatus);
            }
            const signature = await send(reporter, 'report', [key], onStatus);
            return { signature, ...await read(key) };
        }
        async function claim({ key, side, onStatus }) {
            const ctx = await context(key);
            if (!BigInt(await ctf.payoutDenominator(ctx.conditionId))) fail('market-unresolved', 'Resolve the market before claiming.');
            const indexSets = side === undefined ? [1, 2] : [1 << sideIndex(side)];
            const signature = await send(ctf, 'redeemPositions', [addresses.MarketCollateral, HASH_ZERO, ctx.conditionId, indexSets], onStatus);
            return { signature, ...await read(key) };
        }
        async function reclaim({ key, onStatus }) {
            const ctx = await context(key);
            if (!signer || !same(await owner(), ctx.record.sponsor)) fail('not-sponsor', 'Only the sponsor can reclaim funding.');
            if (await registry.reclaimed(key)) return { signature: null, ...await read(key) };
            const signature = await send(registry, 'reclaim', [key], onStatus);
            return { signature, ...await read(key) };
        }
        return { chainId: id, read, quote, quoteBudget, trade, open, resolve, claim, reclaim };
    }
    async function browser(win, chainId, signing = false) {
        const ethers = await win.EvmAdapter.ensureEthers();
        const addresses = await win.EvmAdapter.contractAddresses(chainId);
        let provider, signer;
        if (signing) {
            if (win.EvmAdapter.walletChainId() !== String(Number(chainId))) fail('wrong-chain', `Connect your wallet to chain ${chainId}.`);
            provider = new ethers.BrowserProvider(win.walletManager.getProvider()); signer = await provider.getSigner();
        } else provider = await win.ChainDataLoader.getProviderForChain(chainId);
        return create({ ethers, provider, signer, chainId, addresses });
    }
    return { ABIS, atomic, sideIndex, amounts, create, browser };
});
