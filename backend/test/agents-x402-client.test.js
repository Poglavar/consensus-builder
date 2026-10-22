// Unit tests for agents/x402-client.js — the paying client the MCP tool surface uses to pay a priced
// lens member for an ownership attestation (POST /lens/ownership). fetch is always a stub: the 402
// challenge is built with the protocol's own encoder. The only real things here are the keypair (the
// payer address is derived from it) and the wrapped fetch, which must pass a non-402 response straight
// through and match the scheme to whatever Solana network the challenge names.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { declarePaymentIdentifierExtension } from '@x402/extensions/payment-identifier';
import { createPaidClient } from '../agents/x402-client.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const OWNERSHIP_URL = 'http://lens.test:3095/lens/ownership';
const TREASURY = web3.Keypair.generate().publicKey.toBase58();
const PAYMENT_ID = 'ownership_1234567890abcdef';

function challengeResponse() {
    const header = encodePaymentRequiredHeader({
        x402Version: 2,
        error: 'payment required',
        resource: { url: OWNERSHIP_URL, description: 'A parcel-ownership attestation' },
        accepts: [{
            scheme: 'exact', network: NETWORK, asset: USDC_DEVNET, amount: '10000', payTo: TREASURY,
            maxTimeoutSeconds: 60, extra: { paymentFlow: 'upfront' }
        }],
        extensions: { 'payment-identifier': declarePaymentIdentifierExtension(true) }
    });
    return new Response(JSON.stringify({ error: 'payment required' }), {
        status: 402, headers: { 'payment-required': header, 'content-type': 'application/json' }
    });
}

describe('createPaidClient', () => {
    it('derives the payer address from the 64-byte secret key and passes a non-402 answer straight through', async () => {
        const keypair = web3.Keypair.generate();
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, init });
            return new Response(JSON.stringify({ address: 'attestation' }), { status: 201, headers: { 'content-type': 'application/json' } });
        };

        const { payerAddress, paidFetch } = await createPaidClient({
            secretKey: keypair.secretKey, paymentId: PAYMENT_ID, rpcUrl: 'http://localhost:1', fetchImpl
        });

        expect(payerAddress).toBe(keypair.publicKey.toBase58());
        // Nothing to pay for on a 201: the wrapper hands the response straight back, one call only.
        const response = await paidFetch(OWNERSHIP_URL, { method: 'POST', body: '{}' });
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ address: 'attestation' });
        expect(calls).toHaveLength(1);
        // The wrapper normalises its arguments into a Request before calling the underlying fetch.
        expect(calls[0].url.url ?? calls[0].url).toBe(OWNERSHIP_URL);
    });

    // The member's network is only known from the challenge, so the scheme is registered under the
    // wildcard `solana:*`. This is the test that the wildcard actually matches: with a non-matching
    // registration the wrapper fails with "No network/scheme registered" BEFORE any RPC; matched, it
    // gets as far as building the payment and dies on the unreachable RPC instead.
    it('registers the scheme for whatever solana network the challenge names', async () => {
        const { paidFetch } = await createPaidClient({
            secretKey: web3.Keypair.generate().secretKey,
            paymentId: PAYMENT_ID,
            rpcUrl: 'http://localhost:1', // refused locally: proves no network is reached
            fetchImpl: async () => challengeResponse()
        });

        await expect(paidFetch(OWNERSHIP_URL, { method: 'POST', body: '{}' }))
            .rejects.toThrow(/Failed to create payment payload: fetch failed/);
        await expect(paidFetch(OWNERSHIP_URL, { method: 'POST', body: '{}' }))
            .rejects.not.toThrow(/No network\/scheme registered/);
    });

    it('refuses a key that is not 64 bytes', async () => {
        await expect(createPaidClient({ secretKey: new Uint8Array(32), paymentId: PAYMENT_ID })).rejects.toThrow(/64 bytes/);
        await expect(createPaidClient({ secretKey: [1, 2, 3], paymentId: PAYMENT_ID })).rejects.toThrow(/Uint8Array/);
    });

    it('requires a protocol-valid stable payment id', async () => {
        const secretKey = web3.Keypair.generate().secretKey;
        await expect(createPaidClient({ secretKey })).rejects.toThrow(/paymentId/);
        await expect(createPaidClient({ secretKey, paymentId: 'too-short' })).rejects.toThrow(/paymentId/);
        await expect(createPaidClient({ secretKey, paymentId: 'has spaces in it, sixteen+' })).rejects.toThrow(/paymentId/);
    });
});
