// x402 client for the paid agent route (POST /agent/proposals): turns a persona keypair into a
// fetch that pays the 402 challenge in devnet USDC, and decodes the two protocol headers
// (PAYMENT-REQUIRED on the challenge, PAYMENT-RESPONSE on the settled reply). No CLI and no logging
// of its own — scripts/agent-submit.mjs and agents/run.mjs are the callers.

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import {
    PAYMENT_IDENTIFIER,
    appendPaymentIdentifierToExtensions,
    isValidPaymentId
} from '@x402/extensions/payment-identifier';
import { ExactSvmScheme } from '@x402/svm';
import { createHash } from 'node:crypto';

export const AGENT_PROPOSALS_PATH = '/agent/proposals';

/** Absolute URL of the paid route on a backend base ("http://localhost:3999" → ".../agent/proposals"). */
export function agentProposalsUrl(baseUrl) {
    if (!baseUrl) throw new Error('baseUrl is required');
    return new URL(AGENT_PROPOSALS_PATH, baseUrl).toString();
}

function resolveFetch(fetchImpl) {
    const impl = fetchImpl || globalThis.fetch;
    if (typeof impl !== 'function') throw new Error('no fetch implementation available (pass fetchImpl)');
    return impl;
}

/** A stable, protocol-valid payment id for every attempt to create the same proposal id. */
export function paymentIdForProposal(proposalId) {
    const value = typeof proposalId === 'string' ? proposalId.trim() : '';
    if (!value) throw new Error('proposalId is required to derive a stable payment id');
    return `proposal_${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Build the paying client for one persona keypair.
 *
 * The scheme is registered for the wildcard network `solana:*` on purpose: the paid route's network
 * only becomes known when the 402 challenge arrives, and @x402/fetch matches a wildcard family
 * entry against whatever network the challenge names (see node_modules/@x402/fetch/README.md).
 *
 * @param {{ secretKey: Uint8Array, paymentId: string, rpcUrl?: string, fetchImpl?: Function }} options
 * @returns {Promise<{ payerAddress: string, paidFetch: Function }>}
 */
export async function createPaidClient({ secretKey, paymentId, rpcUrl, fetchImpl } = {}) {
    if (!(secretKey instanceof Uint8Array)) throw new Error('secretKey must be a Uint8Array (the 64-byte array in a Solana keypair JSON file)');
    if (secretKey.length !== 64) throw new Error(`secretKey must be 64 bytes, got ${secretKey.length}`);
    if (!isValidPaymentId(paymentId)) throw new Error('paymentId must be 16–128 characters using only letters, numbers, hyphens and underscores');
    const signer = await createKeyPairSignerFromBytes(secretKey);
    const client = new x402Client()
        .register('solana:*', new ExactSvmScheme(signer, rpcUrl ? { rpcUrl } : undefined))
        .registerExtension({
            key: PAYMENT_IDENTIFIER,
            async enrichPaymentPayload(payload, paymentRequired) {
                const extensions = structuredClone(payload.extensions ?? paymentRequired.extensions ?? {});
                appendPaymentIdentifierToExtensions(extensions, paymentId);
                return { ...payload, extensions };
            }
        });
    const paidFetch = wrapFetchWithPayment(resolveFetch(fetchImpl), client);
    return { payerAddress: signer.address, paidFetch };
}

/**
 * Fetch the 402 challenge without paying — what a dry run prints.
 *
 * @param {{ baseUrl: string, body: object, fetchImpl?: Function }} options
 * @returns {Promise<object>} the decoded PAYMENT-REQUIRED (x402Version, resource, accepts[])
 */
export async function fetchChallenge({ baseUrl, body, fetchImpl } = {}) {
    const target = agentProposalsUrl(baseUrl);
    const response = await resolveFetch(fetchImpl)(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (response.status !== 402) {
        const text = await response.text().catch(() => '<unreadable body>');
        throw new Error(`expected a 402 challenge from ${target}, got ${response.status}: ${text}`);
    }
    const header = response.headers.get('payment-required');
    if (!header) throw new Error(`402 from ${target} carried no payment-required header`);
    return decodePaymentRequiredHeader(header);
}

/**
 * POST one proposal through the paying fetch. The 402 → pay → retry dance happens inside paidFetch,
 * so what comes back here is the final response.
 *
 * @param {{ baseUrl: string, paidFetch: Function, body: object }} options
 * @returns {Promise<{ status: number, body: object|string, receipt: object|null }>}
 */
export async function postAgentProposal({ baseUrl, paidFetch, body } = {}) {
    if (typeof paidFetch !== 'function') throw new Error('paidFetch is required — build one with createPaidClient()');
    const target = agentProposalsUrl(baseUrl);
    const response = await paidFetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    // The route answers JSON, but an error from a proxy in front of it may not: keep the raw text
    // rather than failing on it, so the caller can log what actually came back.
    let parsed = text;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }
    }
    const receiptHeader = response.headers.get('payment-response');
    const receipt = receiptHeader ? decodePaymentResponseHeader(receiptHeader) : null;
    return { status: response.status, body: parsed, receipt };
}
