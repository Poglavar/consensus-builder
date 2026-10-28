// One asset choice for the betting UI. Points authenticate with a browser-held random credential;
// devnet trades use the wallet bridge. A pending points request keeps its ID across retries/reloads.
(function attach(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root?.document) return;
    root.BetsTrading = api.create({
        storage: root.localStorage, crypto: root.crypto,
        initialAsset: new URLSearchParams(root.location.search).get('asset'),
        fetch: (...args) => root.fetch(...args),
        baseUrl: () => root.getBackendBase().replace(/\/$/, ''),
        profile: async () => {
            if (root.whenAppBooted) await root.whenAppBooted();
            const id = root.getCurrentUserAgent?.()?.id;
            if (!id) throw new Error('Your local profile is not ready yet.');
            return String(id);
        },
        simulationRun: () => root.BetsTelemetry?.simulationRun || '',
        chain: () => root.SolanaMarketBridge,
        onAsset: asset => {
            const url = new URL(root.location.href); url.searchParams.set('asset', asset);
            root.history.replaceState(root.history.state, '', url);
            root.document.dispatchEvent(new root.CustomEvent('bets:asset', { detail: { asset } }));
        }
    });
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function create({ storage, crypto, fetch, baseUrl, profile, simulationRun = () => '', chain, onAsset = () => {}, initialAsset }) {
        let selected = ['points', 'devnet-usdc'].includes(initialAsset) ? initialAsset : storage.getItem('bets-asset-v1') || 'points';
        if (!['points', 'devnet-usdc'].includes(selected)) selected = 'points';
        const identities = new Map();
        const asset = () => selected;
        const needsWallet = () => selected === 'devnet-usdc';
        function setAsset(value) {
            if (!['points', 'devnet-usdc'].includes(value)) throw new Error('Unknown betting asset');
            if (selected === value) return;
            storage.setItem('bets-asset-v1', value); selected = value; onAsset(value);
        }
        const error = (message, code, status) => Object.assign(new Error(message), { code, status });
        const params = (values = {}) => new URLSearchParams({ ...values, ...(simulationRun() ? { simulationRun: simulationRun() } : {}) });
        const body = values => ({ ...values, ...(simulationRun() ? { simulationRun: simulationRun() } : {}) });
        async function request(path, { method = 'GET', data, token } = {}) {
            const response = await fetch(`${baseUrl()}/bets/points/${path}`, {
                method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                ...(data ? { body: JSON.stringify(body(data)) } : {}), cache: 'no-store'
            });
            const result = await response.json();
            if (!response.ok) throw error(result.message || 'Points request failed', String(result.error || 'points_unavailable').toUpperCase(), response.status);
            return result;
        }
        async function identity() {
            const agentId = await profile();
            // The backend is part of the credential's storage key: changing a preview's API cannot
            // send the credential for another service or consume that service's starting grant.
            const key = `bets-points-v1:${baseUrl()}:${simulationRun()}:${agentId}`;
            if (!identities.has(key)) {
                const loading = (async () => {
                    let token = storage.getItem(`${key}:token`);
                    if (!token) {
                        token = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
                        storage.setItem(`${key}:token`, token);
                    }
                    if (!/^[a-f0-9]{64}$/.test(token)) throw error('The saved points credential is invalid.', 'POINTS_CREDENTIAL_INVALID');
                    const account = await request('account', { method: 'POST', token, data: { agentId } });
                    return { key, token, account };
                })().catch(cause => { identities.delete(key); throw cause; });
                identities.set(key, loading);
            }
            return identities.get(key);
        }
        async function readAccount() {
            const { token } = await identity();
            return request(`account?${params()}`, { token });
        }
        async function pending() {
            const { key } = await identity();
            const value = storage.getItem(`${key}:pending`);
            return value ? JSON.parse(value) : null;
        }
        async function submitPending(saved, credentials, options = {}) {
            options.onStatus?.({ state: 'preparing' });
            try {
                options.onStatus?.({ state: 'submitted' });
                const result = await request(saved.path, { method: 'POST', token: credentials.token, data: saved.data });
                if (result.receipt?.requestId !== saved.data.requestId) throw error('The receipt did not identify this request.', 'POINTS_RECEIPT_MISMATCH');
                storage.removeItem(`${credentials.key}:pending`);
                options.onStatus?.({ state: 'confirmed', receiptId: result.receipt.id });
                return { ...result, transactionHash: null, explorerUrl: null };
            } catch (cause) {
                if (cause.status >= 400 && cause.status < 500) {
                    storage.removeItem(`${credentials.key}:pending`);
                    throw cause;
                }
                // An interrupted HTTP response is not proof that the ledger rejected the action.
                // Keep the request ID and reconcile through the same idempotent endpoint.
                throw Object.assign(error('Your points request needs confirmation. Check the pending receipt before trying another trade.', 'CONFIRMATION_UNKNOWN'), { cause });
            }
        }
        async function mutate(path, data, options = {}) {
            const credentials = await identity();
            const previous = storage.getItem(`${credentials.key}:pending`);
            let saved = previous ? JSON.parse(previous) : null;
            if (saved && (saved.path !== path || JSON.stringify(saved.intent) !== JSON.stringify(data))) {
                throw error('Check your pending points receipt before starting another action.', 'POINTS_PENDING');
            }
            if (!saved) {
                saved = { path, intent: data, data: { ...data, requestId: crypto.randomUUID() } };
                storage.setItem(`${credentials.key}:pending`, JSON.stringify(saved));
            }
            return submitPending(saved, credentials, options);
        }
        async function retryPending(options = {}) {
            const credentials = await identity();
            const saved = await pending();
            if (!saved) return null;
            return submitPending(saved, credentials, options);
        }
        async function pointsMarkets(accounts) {
            const markets = {}, subjects = {};
            const unique = [...new Set(accounts.filter(Boolean))];
            for (let start = 0; start < unique.length; start += 100) {
                const result = await request(`markets?${params({ accounts: unique.slice(start, start + 100).join(',') })}`);
                Object.assign(markets, result.markets); Object.assign(subjects, result.subjects);
            }
            return { markets, subjects };
        }
        function entryFor(entry, market, subject) {
            const chainStatus = subject?.chainStatus || entry.chainStatus;
            const now = Math.floor(Date.now() / 1000);
            return { ...entry, ...(subject ? { chainStatus, deadline: subject.deadline, sponsor: subject.sponsor } : {}), market,
                canOpenMarket: false,
                bettable: Boolean(market && !market.resolved && chainStatus === 'active' && now < market.closesAt),
                canSettle: Boolean(market && !market.resolved && (['executed', 'cancelled', 'expired'].includes(chainStatus) || chainStatus === 'active' && now >= market.closesAt + market.graceSeconds)) };
        }
        // scope 'other': every city but `city`, each contest naming its own city.
        async function loadCity(city, { fresh = false, scope = null } = {}) {
            const chosen = selected;
            const response = await fetch(`${baseUrl()}/markets?${new URLSearchParams({ city, ...(scope === 'other' ? { scope } : {}), ...(fresh ? { fresh: '1' } : {}) })}`, { cache: 'no-store' });
            if (!response.ok) throw error('Markets are unavailable.', 'MARKETS_UNAVAILABLE', response.status);
            const payload = await response.json();
            if (chosen === 'devnet-usdc') return { ...payload, asset: chosen };
            const accounts = payload.contests.flatMap(contest => contest.agreements).filter(entry => entry.account && entry.deadline).map(entry => entry.account);
            const { markets, subjects } = await pointsMarkets(accounts);
            return { ...payload, asset: chosen, contests: payload.contests.map(contest => {
                const agreements = contest.agreements.map(entry => entryFor(entry, markets[entry.account] || null, subjects[entry.account]));
                return { ...contest, agreements,
                    sharesAtomic: agreements.reduce((sum, entry) => sum + BigInt(entry.market?.qYes || 0) + BigInt(entry.market?.qNo || 0), 0n).toString() };
            }) };
        }
        async function readPositions(rows = []) {
            if (selected === 'devnet-usdc') return chain().readPositions(rows);
            return (await readAccount()).positions;
        }
        async function readSummary(account) {
            if (selected === 'devnet-usdc') return chain().readSummary(account);
            const [catalog, owner] = await Promise.all([pointsMarkets([account]), readAccount()]);
            const subject = catalog.subjects[account];
            if (!subject) throw error('Agreement source is unavailable.', 'AGREEMENT_UNAVAILABLE');
            const positions = owner.positions[account] || {};
            return { ...subject, market: catalog.markets[account] || null, marketAddress: catalog.markets[account]?.address || null,
                yes: positions.yes || null, no: positions.no || null, accountId: owner.id, wallet: owner.wallet || null };
        }
        async function readStakeBalance() {
            return selected === 'devnet-usdc' ? chain().readStakeBalance() : BigInt((await readAccount()).balance);
        }
        function trade(action, options) {
            if (selected === 'devnet-usdc') return chain()[action](options);
            return mutate('trade', { agreementAccount: options.proposal, action, side: Number(options.side) === 1 || options.side === 'yes' ? 'yes' : 'no',
                shares: String(options.shares), ...(action === 'buy' ? { maxCost: String(options.maxCost) } : { minReturn: String(options.minReturn) }) }, options);
        }
        function lifecycle(action, options) {
            if (selected === 'devnet-usdc') return chain()[action](options);
            return mutate(action, { agreementAccount: options.proposal,
                ...(action === 'claim' ? { side: Number(options.side) === 1 || options.side === 'yes' ? 'yes' : 'no' } : {}) }, options);
        }
        async function linkWallet(provider) {
            if (!provider?.publicKey || !provider.signMessage) throw error('Connect a wallet that can sign messages.', 'WALLET_NOT_CONNECTED');
            const { token } = await identity();
            const wallet = provider.publicKey.toBase58();
            const challenge = await request('wallet-challenge', { method: 'POST', token, data: { wallet } });
            const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
            const bytes = signed.signature || signed;
            const signature = btoa(String.fromCharCode(...bytes));
            return request('wallet-link', { method: 'POST', token, data: { wallet, nonce: challenge.nonce, signature } });
        }
        return { asset, setAsset, needsWallet, readAccount, pending, retryPending, loadCity, readPositions, readSummary, readStakeBalance,
            buy: options => trade('buy', options), sell: options => trade('sell', options),
            resolve: options => lifecycle('resolve', options), claim: options => lifecycle('claim', options),
            createMarket: options => chain().createMarket(options), linkWallet,
            leaderboard: () => request(`leaderboard?${params()}`),
            publicPositions: account => request(`positions?${params({ account })}`), simulationRun };
    }
    return { create };
});
