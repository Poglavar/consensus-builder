// Bounded retries for server-side Solana RPC. Repeating sendTransaction is safe only because
// this transport reuses the exact signed request bytes; it never rebuilds or re-signs a transfer.
import { Connection } from '@solana/web3.js';
import { createRetryingFetch } from '../utils/retrying-fetch.js';

const TRANSIENT_RPC_CODES = new Set([-32603, -32004, -32005, -32016]);
const retryableMethod = method => typeof method === 'string'
    && (/^get[A-Z]/.test(method) || ['isBlockhashValid', 'simulateTransaction', 'sendTransaction'].includes(method));

function requestMethods(body) {
    try {
        const requests = JSON.parse(body);
        return (Array.isArray(requests) ? requests : [requests]).map(item => item.method);
    } catch { return []; }
}

async function transientJsonRpcResponse(response) {
    try {
        const body = await response.clone().json();
        const rows = Array.isArray(body) ? body : [body];
        const transient = rows.find(row => TRANSIENT_RPC_CODES.has(row?.error?.code));
        return transient ? `RPC ${transient.error.code}` : null;
    } catch { return 'invalid RPC response'; }
}

export function createRetryingRpcFetch({ fetchImpl = globalThis.fetch, onRpcRequest = null, attempts = 4,
    firstDelayMs = 1000, maxDelayMs = 10000, timeoutMs = 15000, wait,
    programAccountsEndpoint = null, primaryEndpoint = null,
    log = message => console.warn(`[${new Date().toISOString()}] [solana-rpc] ${message}`) } = {}) {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) throw new Error('RPC attempts must be between 1 and 6');
    const retryFetch = createRetryingFetch({ fetchImpl, attempts, firstDelayMs, maxDelayMs, timeoutMs, wait, log,
        shouldRetryRequest: ({ init }) => {
            const methods = requestMethods(init.body);
            return methods.length > 0 && methods.every(retryableMethod);
        },
        inspectResponse: transientJsonRpcResponse,
        requestLabel: ({ init }) => [...new Set(requestMethods(init.body))].join(',') || 'request',
        onAttempt: ({ init }) => onRpcRequest?.(requestMethods(init.body))
    });

    const secondaryEndpoint = programAccountsEndpoint || null;
    let networkCheck;
    async function genesisHash(endpoint) {
        const response = await retryFetch(endpoint, {
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
    function verifySecondaryNetwork(primary) {
        if (!secondaryEndpoint || secondaryEndpoint === primary) return Promise.resolve();
        if (!networkCheck) {
            const check = Promise.all([genesisHash(primary), genesisHash(secondaryEndpoint)]).then(([primaryHash, secondaryHash]) => {
                if (primaryHash !== secondaryHash) throw new Error('program-accounts RPC endpoint is on a different Solana network');
            });
            networkCheck = check.catch(error => {
                networkCheck = null;
                throw error;
            });
        }
        return networkCheck;
    }
    async function dispatch(input, init = {}) {
        const requests = parseJsonRequests(init.body);
        const rows = Array.isArray(requests) ? requests : (requests ? [requests] : []);
        const secondary = rows.filter(row => row?.method === 'getProgramAccounts');
        if (!secondary.length || !secondaryEndpoint) return retryFetch(input, init);

        const primary = rows.filter(row => row?.method !== 'getProgramAccounts');
        const mainEndpoint = primaryEndpoint || input;
        await verifySecondaryNetwork(mainEndpoint);
        if (!primary.length) return retryFetch(secondaryEndpoint, init);

        // A web3 batch may mix methods. Split it so only getProgramAccounts reaches the secondary,
        // then restore the original response order for the SDK.
        const [mainResponse, secondaryResponse] = await Promise.all([
            retryFetch(mainEndpoint, { ...init, body: JSON.stringify(primary) }),
            retryFetch(secondaryEndpoint, { ...init, body: JSON.stringify(secondary) })
        ]);
        if (!mainResponse.ok) return mainResponse;
        if (!secondaryResponse.ok) return secondaryResponse;
        const [mainRows, secondaryRows] = await Promise.all([mainResponse.json(), secondaryResponse.json()]);
        if (!Array.isArray(mainRows) || !Array.isArray(secondaryRows)) {
            throw new Error('split Solana RPC batch returned an invalid response');
        }
        const byId = new Map([...mainRows, ...secondaryRows].map(row => [row.id, row]));
        const ordered = rows.map(row => byId.get(row.id));
        if (ordered.some(row => !row)) throw new Error('split Solana RPC batch omitted a response');
        return new Response(JSON.stringify(ordered), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return dispatch;
}

function parseJsonRequests(body) {
    try { return typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
}

export function createRpcConnection(endpoint, commitment = 'confirmed', retryOptions = {}) {
    const programAccountsEndpoint = Object.hasOwn(retryOptions, 'programAccountsEndpoint')
        ? retryOptions.programAccountsEndpoint
        : process.env.SOLANA_PROGRAM_ACCOUNTS_RPC_URL;
    return new Connection(endpoint, {
        commitment,
        // Use one bounded retry policy rather than multiplying it by web3's rate-limit retries.
        disableRetryOnRateLimit: true,
        fetch: createRetryingRpcFetch({ ...retryOptions, primaryEndpoint: endpoint, programAccountsEndpoint })
    });
}
