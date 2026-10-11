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

export function createRetryingRpcFetch({ fetchImpl = globalThis.fetch, attempts = 4,
    firstDelayMs = 1000, maxDelayMs = 10000, timeoutMs = 15000, wait,
    log = message => console.warn(`[${new Date().toISOString()}] [solana-rpc] ${message}`) } = {}) {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) throw new Error('RPC attempts must be between 1 and 6');
    return createRetryingFetch({ fetchImpl, attempts, firstDelayMs, maxDelayMs, timeoutMs, wait, log,
        shouldRetryRequest: ({ init }) => {
            const methods = requestMethods(init.body);
            return methods.length > 0 && methods.every(retryableMethod);
        },
        inspectResponse: transientJsonRpcResponse,
        requestLabel: ({ init }) => [...new Set(requestMethods(init.body))].join(',') || 'request'
    });
}

export function createRpcConnection(endpoint, commitment = 'confirmed', retryOptions = {}) {
    return new Connection(endpoint, {
        commitment,
        // Use one bounded retry policy rather than multiplying it by web3's rate-limit retries.
        disableRetryOnRateLimit: true,
        fetch: createRetryingRpcFetch(retryOptions)
    });
}
