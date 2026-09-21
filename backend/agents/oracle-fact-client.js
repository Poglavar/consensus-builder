// Minimal outside-agent client for the paid verified-fact endpoint. Unlike proposal creation this
// is a read, so retries need no payment identifier: the x402 client creates a fresh payment only
// when it receives a fresh 402 challenge.

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { ExactSvmScheme } from '@x402/svm';

export function oracleFactUrl(baseUrl, proposalAccount, marketAccount = null) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!proposalAccount) throw new Error('proposalAccount is required');
    const url = new URL('/agent/oracle/facts', baseUrl);
    url.searchParams.set('subject', proposalAccount);
    if (marketAccount) url.searchParams.set('market', marketAccount);
    return url.toString();
}
function fetchOf(fetchImpl) {
    const value = fetchImpl || globalThis.fetch;
    if (typeof value !== 'function') throw new Error('no fetch implementation available');
    return value;
}

async function parsedResponse(response) {
    const text = await response.text();
    let body = text;
    if (text) {
        try { body = JSON.parse(text); } catch { /* keep proxy or facilitator text */ }
    }
    const receiptHeader = response.headers.get('payment-response');
    return {
        status: response.status,
        body,
        receipt: receiptHeader ? decodePaymentResponseHeader(receiptHeader) : null
    };
}

export async function fetchOracleFactChallenge({ baseUrl, proposalAccount, marketAccount, fetchImpl } = {}) {
    const target = oracleFactUrl(baseUrl, proposalAccount, marketAccount);
    const response = await fetchOf(fetchImpl)(target, { headers: { accept: 'application/json' } });
    if (response.status !== 402) {
        const text = await response.text().catch(() => '<unreadable body>');
        throw new Error(`expected a 402 challenge from ${target}, got ${response.status}: ${text}`);
    }
    const header = response.headers.get('payment-required');
    if (!header) throw new Error(`402 from ${target} carried no payment-required header`);
    return decodePaymentRequiredHeader(header);
}

export async function createOracleFactClient({ secretKey, rpcUrl, fetchImpl } = {}) {
    if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
        throw new Error('secretKey must be the 64-byte array in a Solana keypair JSON file');
    }
    const signer = await createKeyPairSignerFromBytes(secretKey);
    const client = new x402Client().register(
        'solana:*',
        new ExactSvmScheme(signer, rpcUrl ? { rpcUrl } : undefined)
    );
    return {
        payerAddress: signer.address,
        paidFetch: wrapFetchWithPayment(fetchOf(fetchImpl), client)
    };
}

export async function buyOracleFact({ baseUrl, proposalAccount, marketAccount, paidFetch } = {}) {
    if (typeof paidFetch !== 'function') throw new Error('paidFetch is required');
    const response = await paidFetch(oracleFactUrl(baseUrl, proposalAccount, marketAccount), {
        headers: { accept: 'application/json' }
    });
    return parsedResponse(response);
}
