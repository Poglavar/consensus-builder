// Unit tests for agents/x402-client.js — the paying client shared by scripts/agent-submit.mjs and
// the agent runner. fetch is always a stub: the 402 challenge and the settlement receipt are built
// with the protocol's own encoders and must come back out through our decode path unchanged. The
// only thing that is real here is the keypair (the payer address is derived from it) and the
// wrapped fetch, which must pass a non-402 response straight through.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { declarePaymentIdentifierExtension } from '@x402/extensions/payment-identifier';
import {
    AGENT_PROPOSALS_PATH,
    agentProposalsUrl,
    createPaidClient,
    fetchChallenge,
    paymentIdForProposal,
    postAgentProposal
} from '../agents/x402-client.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BASE = 'http://backend.test:3999';
const TREASURY = web3.Keypair.generate().publicKey.toBase58();
const PAYER = web3.Keypair.generate().publicKey.toBase58();
const BODY = { city: 'zagreb', cadastreParcelIds: ['HR-1'], type: 'parcel', name: 'test' };
const PAYMENT_ID = 'proposal_1234567890abcdef';

function challengeHeader() {
    return encodePaymentRequiredHeader({
        x402Version: 2,
        error: 'payment required',
        resource: { url: `${BASE}${AGENT_PROPOSALS_PATH}`, description: 'Post one agent proposal' },
        accepts: [{
            scheme: 'exact',
            network: NETWORK,
            asset: USDC_DEVNET,
            amount: '50000',
            payTo: TREASURY,
            maxTimeoutSeconds: 60,
            extra: { paymentFlow: 'upfront' }
        }],
        extensions: { 'payment-identifier': declarePaymentIdentifierExtension(true) }
    });
}

function receiptHeader() {
    return encodePaymentResponseHeader({
        success: true,
        transaction: '5ThisIsTheSettlementSignature',
        network: NETWORK,
        payer: PAYER
    });
}

function challengeResponse() {
    return new Response(JSON.stringify({ error: 'payment required' }), {
        status: 402,
        headers: { 'payment-required': challengeHeader(), 'content-type': 'application/json' }
    });
}

function createdResponse(body = { id: 41, proposalId: 'agent-densifier-01-2026-09-17-1' }) {
    return new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'payment-response': receiptHeader(), 'content-type': 'application/json' }
    });
}

describe('agentProposalsUrl', () => {
    it('puts the paid route on the given backend base', () => {
        expect(agentProposalsUrl(BASE)).toBe(`${BASE}/agent/proposals`);
        expect(agentProposalsUrl('http://localhost:3000/')).toBe('http://localhost:3000/agent/proposals');
        expect(() => agentProposalsUrl('')).toThrow(/baseUrl/);
    });
});

describe('createPaidClient', () => {
    it('derives the payer address from the 64-byte secret key and wraps the given fetch', async () => {
        const keypair = web3.Keypair.generate();
        const calls = [];
        const fetchImpl = async (url, init) => { calls.push({ url, init }); return createdResponse(); };

        const { payerAddress, paidFetch } = await createPaidClient({
            secretKey: keypair.secretKey,
            paymentId: PAYMENT_ID,
            rpcUrl: 'http://127.0.0.1:1',
            fetchImpl
        });

        expect(payerAddress).toBe(keypair.publicKey.toBase58());
        expect(typeof paidFetch).toBe('function');
        // Nothing to pay for on a 201: the wrapper hands the response straight back, one call only.
        const response = await paidFetch(`${BASE}${AGENT_PROPOSALS_PATH}`, { method: 'POST' });
        expect(response.status).toBe(201);
        expect(calls).toHaveLength(1);
        // The wrapper normalises its arguments into a Request before calling the underlying fetch.
        expect(calls[0].url.url ?? calls[0].url).toBe(`${BASE}${AGENT_PROPOSALS_PATH}`);
    });

    // The paid route's network is only known from the challenge, so the scheme is registered under
    // the wildcard `solana:*`. This is the test that the wildcard actually matches: with a
    // non-matching registration the wrapper fails with "No network/scheme registered" BEFORE any
    // RPC; matched, it gets as far as building the payment and dies on the unreachable RPC instead.
    it('registers the scheme for whatever solana network the challenge names', async () => {
        const fetchImpl = async () => challengeResponse();
        const { paidFetch } = await createPaidClient({
            secretKey: web3.Keypair.generate().secretKey,
            paymentId: PAYMENT_ID,
            rpcUrl: 'http://127.0.0.1:1', // refused locally: proves no network is reached
            fetchImpl
        });

        await expect(paidFetch(`${BASE}${AGENT_PROPOSALS_PATH}`, { method: 'POST', body: '{}' }))
            .rejects.toThrow(/Failed to create payment payload: fetch failed/);
        await expect(paidFetch(`${BASE}${AGENT_PROPOSALS_PATH}`, { method: 'POST', body: '{}' }))
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
    });
});

describe('paymentIdForProposal', () => {
    it('derives the same valid id for the same proposal id', () => {
        const id = paymentIdForProposal('agent-densifier-01-2026-09-17-1');
        expect(id).toBe(paymentIdForProposal('agent-densifier-01-2026-09-17-1'));
        expect(id).toMatch(/^proposal_[a-f0-9]{64}$/);
        expect(id).not.toBe(paymentIdForProposal('agent-densifier-01-2026-09-17-2'));
    });

    it('requires a proposal id', () => {
        expect(() => paymentIdForProposal('')).toThrow(/proposalId/);
    });
});

describe('fetchChallenge', () => {
    it('decodes the PAYMENT-REQUIRED header of the 402', async () => {
        const seen = [];
        const fetchImpl = async (url, init) => { seen.push({ url, init }); return challengeResponse(); };

        const required = await fetchChallenge({ baseUrl: BASE, body: BODY, fetchImpl });

        expect(seen[0].url).toBe(`${BASE}/agent/proposals`);
        expect(seen[0].init.method).toBe('POST');
        expect(JSON.parse(seen[0].init.body)).toEqual(BODY);
        expect(required.accepts[0]).toMatchObject({
            scheme: 'exact',
            network: NETWORK,
            asset: USDC_DEVNET,
            amount: '50000',
            payTo: TREASURY
        });
        expect(required.accepts[0].extra.paymentFlow).toBe('upfront');
    });

    it('throws with the status and the body when the route does not challenge', async () => {
        const fetchImpl = async () => new Response('{"error":"city is required"}', { status: 400 });
        await expect(fetchChallenge({ baseUrl: BASE, body: BODY, fetchImpl })).rejects.toThrow(/got 400: \{"error":"city is required"\}/);
    });

    it('throws when the 402 carries no challenge header', async () => {
        const fetchImpl = async () => new Response('', { status: 402 });
        await expect(fetchChallenge({ baseUrl: BASE, body: BODY, fetchImpl })).rejects.toThrow(/no payment-required header/);
    });
});

describe('postAgentProposal', () => {
    // The stub stands in for the wrapped fetch: 402 first, then the paid retry that gets the 201 —
    // the same two-phase exchange wrapFetchWithPaymentFromConfig performs, without a network or a
    // facilitator. What is asserted is our contract: status, parsed body, decoded receipt.
    function twoPhasePaidFetch() {
        const calls = [];
        const paidFetch = async (url, init) => {
            calls.push({ url, init });
            if (calls.length === 1) {
                const challenge = challengeResponse();
                expect(challenge.headers.get('payment-required')).toBe(challengeHeader());
                return paidFetch(url, { ...init, headers: { ...init.headers, 'payment-signature': 'paid' } });
            }
            return createdResponse();
        };
        return { paidFetch, calls };
    }

    it('posts the body, returns the parsed JSON and decodes the settlement receipt', async () => {
        const { paidFetch, calls } = twoPhasePaidFetch();

        const result = await postAgentProposal({ baseUrl: BASE, paidFetch, body: BODY });

        expect(calls).toHaveLength(2);
        expect(calls[0].url).toBe(`${BASE}/agent/proposals`);
        expect(JSON.parse(calls[0].init.body)).toEqual(BODY);
        expect(calls[1].init.headers['payment-signature']).toBe('paid');
        expect(result.status).toBe(201);
        expect(result.body).toEqual({ id: 41, proposalId: 'agent-densifier-01-2026-09-17-1' });
        expect(result.receipt).toMatchObject({ success: true, transaction: '5ThisIsTheSettlementSignature', network: NETWORK, payer: PAYER });
    });

    it('keeps a non-JSON body as text and reports no receipt when the header is absent', async () => {
        const paidFetch = async () => new Response('<html>502 from the proxy</html>', { status: 502 });
        const result = await postAgentProposal({ baseUrl: BASE, paidFetch, body: BODY });
        expect(result).toEqual({ status: 502, body: '<html>502 from the proxy</html>', receipt: null });
    });

    it('refuses to run without a paying fetch', async () => {
        await expect(postAgentProposal({ baseUrl: BASE, body: BODY })).rejects.toThrow(/paidFetch is required/);
    });
});
