// x402 paying client for agents: turns a persona keypair into a fetch that pays a 402 challenge in
// devnet USDC with a stable payment id, so a retry of the same request is never charged twice. Its
// caller is the MCP tool surface (ugt-agent-tools.js), which pays a priced lens member for an ownership
// attestation. No CLI and no logging of its own.

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import {
    PAYMENT_IDENTIFIER,
    appendPaymentIdentifierToExtensions,
    isValidPaymentId
} from '@x402/extensions/payment-identifier';
import { ExactSvmScheme } from '@x402/svm';

function resolveFetch(fetchImpl) {
    const impl = fetchImpl || globalThis.fetch;
    if (typeof impl !== 'function') throw new Error('no fetch implementation available (pass fetchImpl)');
    return impl;
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
