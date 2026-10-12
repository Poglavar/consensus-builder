// Route only getProgramAccounts to a method-capable Solana RPC. Browser runtime configuration is
// supplied by the generated rpc-config.js; ordinary reads and writes stay on the primary endpoint.
// Confirmations listen on a separate websocket endpoint: the configured primary (Alchemy devnet) has
// no signatureSubscribe, which web3.js confirmTransaction relies on.
(function attachSolanaRpcRouting(root) {
    if (!root) return;

    const DEFAULT_RPC_URLS = Object.freeze({
        'mainnet-beta': 'https://api.mainnet-beta.solana.com',
        devnet: 'https://api.devnet.solana.com',
        testnet: 'https://api.testnet.solana.com'
    });
    // Public cluster websockets carry signature subscriptions; SOLANA_WS_URLS may name another.
    const DEFAULT_WS_URLS = Object.freeze({
        'mainnet-beta': 'wss://api.mainnet-beta.solana.com',
        devnet: 'wss://api.devnet.solana.com',
        testnet: 'wss://api.testnet.solana.com'
    });
    const verifiedNetworks = new Map();

    function normalizeCluster(cluster) {
        const value = typeof cluster === 'string' && cluster.trim() ? cluster.trim() : 'devnet';
        return value === 'mainnet' || value === 'solana-mainnet' ? 'mainnet-beta' : value;
    }

    function configuredUrl(map, key) {
        if (!map || typeof map !== 'object') return null;
        const value = map[key];
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    function resolveEndpoints(cluster) {
        const key = normalizeCluster(cluster);
        const primary = configuredUrl(root.SOLANA_RPC_URLS, key) || DEFAULT_RPC_URLS[key] || DEFAULT_RPC_URLS.devnet;
        const programAccounts = configuredUrl(root.SOLANA_PROGRAM_ACCOUNTS_RPC_URLS, key);
        const ws = configuredUrl(root.SOLANA_WS_URLS, key) || DEFAULT_WS_URLS[key] || DEFAULT_WS_URLS.devnet;
        return { cluster: key, primary, programAccounts, ws };
    }

    async function fetchGenesisHash(endpoint, fetchImpl) {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] })
        });
        if (!response.ok) throw new Error(`could not verify program-accounts RPC network (HTTP ${response.status})`);
        let payload;
        try { payload = await response.json(); } catch { throw new Error('program-accounts RPC network check returned invalid JSON'); }
        if (payload?.error || typeof payload?.result !== 'string' || !payload.result) {
            throw new Error('program-accounts RPC network check did not return a genesis hash');
        }
        return payload.result;
    }

    function ensureSameNetwork(primary, secondary, fetchImpl) {
        if (!secondary || secondary === primary) return Promise.resolve();
        const key = `${primary}\u0000${secondary}`;
        if (!verifiedNetworks.has(key)) {
            const check = Promise.all([
                fetchGenesisHash(primary, fetchImpl),
                fetchGenesisHash(secondary, fetchImpl)
            ]).then(([primaryHash, secondaryHash]) => {
                if (primaryHash !== secondaryHash) throw new Error('program-accounts RPC endpoint is on a different Solana network');
            });
            const retryableCheck = check.catch(error => {
                verifiedNetworks.delete(key);
                throw error;
            });
            verifiedNetworks.set(key, retryableCheck);
        }
        return verifiedNetworks.get(key);
    }

    function parseBody(body) {
        try { return typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
    }

    function createFetch(primary, programAccounts, fetchImpl = root.fetch.bind(root)) {
        if (typeof fetchImpl !== 'function') throw new Error('browser fetch is unavailable');
        return async (input, init = {}) => {
            const parsed = parseBody(init.body);
            const requests = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
            const special = requests.filter(request => request?.method === 'getProgramAccounts');
            if (!special.length || !programAccounts) return fetchImpl(input, init);

            await ensureSameNetwork(primary, programAccounts, fetchImpl);
            const ordinary = requests.filter(request => request?.method !== 'getProgramAccounts');
            if (!ordinary.length) return fetchImpl(programAccounts, init);

            // A batched Connection call can contain several methods. Keep all non-list methods on
            // primary and reassemble responses by JSON-RPC id before returning to web3.js.
            const [ordinaryResponse, specialResponse] = await Promise.all([
                fetchImpl(primary, { ...init, body: JSON.stringify(ordinary) }),
                fetchImpl(programAccounts, { ...init, body: JSON.stringify(special) })
            ]);
            if (!ordinaryResponse.ok) return ordinaryResponse;
            if (!specialResponse.ok) return specialResponse;
            const [ordinaryRows, specialRows] = await Promise.all([ordinaryResponse.json(), specialResponse.json()]);
            if (!Array.isArray(ordinaryRows) || !Array.isArray(specialRows)) {
                throw new Error('split Solana RPC batch returned an invalid response');
            }
            const byId = new Map([...ordinaryRows, ...specialRows].map(row => [row.id, row]));
            const ordered = requests.map(request => byId.get(request.id));
            if (ordered.some(row => !row)) throw new Error('split Solana RPC batch omitted a response');
            return new Response(JSON.stringify(ordered), { status: 200, headers: { 'content-type': 'application/json' } });
        };
    }

    root.SolanaRpcRouting = Object.freeze({ createFetch, resolveEndpoints });
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
