// Pure helpers for the x402 pay-to-post gate on /agent/* routes: config reading, atomic-to-decimal
// amount formatting, and the `agent` stamp written onto a paid proposal. No express, no network,
// so every branch is unit-testable; routes/agent-proposals.js does the wiring.

import { createHash } from 'node:crypto';

export const AGENT_ROUTE_PREFIX = '/agent/';
export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

// Every value is config: which network, which facilitator, who gets paid and how much. Nothing is
// defaulted, because a defaulted network would let a deploy silently take devnet money on a host
// that was meant to be mainnet (or the reverse). Missing names are reported so the 503 says what
// to set.
export const X402_ENV_NAMES = ['X402_NETWORK', 'X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_PRICE_PROPOSAL'];
export const CDP_CREDENTIAL_ENV_NAMES = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET'];

export function isCdpFacilitatorUrl(value) {
    try {
        const url = new URL(value);
        return url.hostname === 'api.cdp.coinbase.com'
            && url.pathname.replace(/\/+$/, '') === '/platform/v2/x402';
    } catch {
        return false;
    }
}

export function readX402Config(env = process.env) {
    const values = {};
    const missing = [];
    for (const name of X402_ENV_NAMES) {
        const raw = env[name];
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (!value) missing.push(name);
        values[name] = value || null;
    }
    const usesCdp = isCdpFacilitatorUrl(values.X402_FACILITATOR_URL);
    if (usesCdp) {
        for (const name of CDP_CREDENTIAL_ENV_NAMES) {
            const raw = env[name];
            if (typeof raw !== 'string' || !raw.trim()) missing.push(name);
        }
    }
    return {
        enabled: missing.length === 0,
        missing,
        network: values.X402_NETWORK,
        facilitatorUrl: values.X402_FACILITATOR_URL,
        usesCdp,
        payTo: values.X402_PAY_TO,
        priceProposal: values.X402_PRICE_PROPOSAL
    };
}

// Requests under /agent/ are authenticated by payment, so the browser-origin gate and the per-IP
// write limiter (both built for the human frontend) do not apply to them.
export function isAgentPath(path) {
    return typeof path === 'string' && path.startsWith(AGENT_ROUTE_PREFIX);
}

// "50000" with 6 decimals → "0.05". Exact string arithmetic: a token amount must never pass
// through a float. Returns null for anything that is not a non-negative integer.
export function formatAtomicAmount(atomic, decimals) {
    if (typeof atomic === 'number' && Number.isSafeInteger(atomic) && atomic >= 0) atomic = String(atomic);
    if (typeof atomic !== 'string' || !/^\d+$/.test(atomic)) return null;
    if (!Number.isInteger(decimals) || decimals < 0) return null;
    if (decimals === 0) return atomic.replace(/^0+(?=\d)/, '');
    const padded = atomic.padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '');
    const frac = padded.slice(-decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
}

// Hash the already-validated parsed request rather than its raw JSON text: object key order is
// irrelevant, while array order remains significant. The hash is stored beside the payment id so
// that an id can only replay the exact operation it originally paid for.
export function hashAgentProposalRequest(body) {
    return createHash('sha256').update(stableJson(body)).digest('hex');
}

// The `agent` object stored on a paid proposal (design §5.1). Whatever the agent sent under
// `agent` (persona, rationale, run_id) is kept; `wallet` and the payment receipt are always
// overwritten from the verified settlement, so the client never gets to claim either.
export function buildAgentStamp(sentAgent, payment) {
    const stamp = isPlainObject(sentAgent) ? { ...sentAgent } : {};
    stamp.wallet = payment.payer;
    stamp.paid = {
        id: payment.id,
        network: payment.network,
        asset: payment.asset ?? null,
        amount: payment.amount ?? null,
        amountAtomic: payment.amountAtomic ?? null,
        tx: payment.transaction
    };
    return stamp;
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (isPlainObject(value)) {
        const entries = Object.keys(value)
            .sort()
            .filter(key => value[key] !== undefined)
            .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`);
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
