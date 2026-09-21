// Contract test for the paid oracle read: missing facts are free, available facts advertise through
// Bazaar, and a real x402 payment envelope reaches the recipe-bound response without a network.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    AccountRole,
    address,
    appendTransactionMessageInstruction,
    blockhash,
    compileTransaction,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    partiallySignTransaction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash
} from '@solana/kit';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { PROPOSAL_PROGRAM_ID, STATUS_CANCELLED } from '../oracle/proposal-lifecycle.js';
import { AGENT_ORACLE_FACTS_PATH, setupAgentOracleFactsRoute } from '../routes/agent-oracle-facts.js';

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const TX = '5igNaTuReOfTheSettledOracleFact';

let payer;
let feePayer;
let treasury;
let sourceAta;
let env;

beforeAll(async () => {
    [payer, feePayer, treasury, sourceAta] = await Promise.all([
        generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()
    ]);
    env = {
        PUBLIC_API_BASE_URL: 'https://api.example.test',
        X402_NETWORK: NETWORK,
        X402_FACILITATOR_URL: 'https://facilitator.test',
        X402_PAY_TO: treasury.address,
        X402_PRICE_ORACLE_FACT: '$0.01'
    };
});

function eventRow() {
    return {
        event_id: `solana:devnet:proposal_lifecycle:${PROPOSAL}:cancelled`,
        event_type: 'proposal_lifecycle',
        subject_type: 'proposal',
        subject_id: PROPOSAL,
        outcome: 'cancelled',
        source_url: `https://explorer.solana.com/address/${PROPOSAL}?cluster=devnet`,
        source_hash: `sha256:${'a'.repeat(64)}`,
        source_observed_at: '2026-09-21T16:24:07.000Z',
        attester: PROPOSAL_PROGRAM_ID,
        transaction_signature: 'tx-cancel',
        evidence: { proposalStatusByte: STATUS_CANCELLED },
        created_at: '2026-09-21T16:27:35.059Z'
    };
}

function facilitator() {
    return {
        getSupported: vi.fn(async () => ({
            kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK, extra: { feePayer: feePayer.address } }],
            extensions: [],
            signers: { 'solana:*': [feePayer.address] }
        })),
        verify: vi.fn(async () => ({ isValid: true, payer: payer.address })),
        settle: vi.fn(async () => ({ success: true, transaction: TX, network: NETWORK, payer: payer.address }))
    };
}

function appFor(pool, fakeFacilitator = facilitator(), routeEnv = env) {
    const app = express();
    setupAgentOracleFactsRoute(app, pool, { env: routeEnv, facilitatorClient: fakeFacilitator });
    return { app, fakeFacilitator };
}

async function signedTransfer() {
    const data = new Uint8Array(10);
    data[0] = 12;
    new DataView(data.buffer).setBigUint64(1, 10000n, true);
    data[9] = 6;
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        value => setTransactionMessageFeePayer(feePayer.address, value),
        value => setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n }, value),
        value => appendTransactionMessageInstruction({
            programAddress: address(TOKEN_PROGRAM),
            accounts: [
                { address: sourceAta.address, role: AccountRole.WRITABLE },
                { address: address(USDC_DEVNET), role: AccountRole.READONLY },
                { address: treasury.address, role: AccountRole.WRITABLE },
                { address: payer.address, role: AccountRole.READONLY_SIGNER }
            ],
            data
        }, value)
    );
    const signed = await partiallySignTransaction([payer.keyPair], compileTransaction(message));
    return getBase64EncodedWireTransaction(signed);
}

async function paymentHeader(challenge) {
    const required = decodePaymentRequiredHeader(challenge.headers['payment-required']);
    return encodePaymentSignatureHeader({
        x402Version: 2,
        resource: required.resource,
        accepted: required.accepts[0],
        payload: { transaction: await signedTransfer() },
        extensions: structuredClone(required.extensions)
    });
}

describe(`GET ${AGENT_ORACLE_FACTS_PATH}`, () => {
    let pool;

    beforeEach(() => {
        pool = { query: vi.fn().mockResolvedValue({ rows: [eventRow()] }) };
    });

    it('validates and finds a fact before asking the agent to pay', async () => {
        const { app, fakeFacilitator } = appFor(pool);
        const malformed = await request(app).get(AGENT_ORACLE_FACTS_PATH).query({ subject: 'not-a-key' });
        expect(malformed.status).toBe(400);
        expect(malformed.headers['payment-required']).toBeUndefined();
        expect(pool.query).not.toHaveBeenCalled();

        pool.query.mockResolvedValueOnce({ rows: [] });
        const missing = await request(app).get(AGENT_ORACLE_FACTS_PATH).query({ subject: PROPOSAL });
        expect(missing.status).toBe(404);
        expect(missing.headers['payment-required']).toBeUndefined();
        expect(fakeFacilitator.settle).not.toHaveBeenCalled();
    });

    it('advertises the exact paid fact query through the x402 Bazaar extension', async () => {
        const { app } = appFor(pool);
        const res = await request(app).get(AGENT_ORACLE_FACTS_PATH).query({ subject: PROPOSAL });
        expect(res.status).toBe(402);
        const required = decodePaymentRequiredHeader(res.headers['payment-required']);
        expect(required.accepts[0]).toMatchObject({
            network: NETWORK,
            payTo: treasury.address,
            amount: '10000',
            extra: expect.objectContaining({ paymentFlow: 'upfront' })
        });
        expect(required.resource.tags).toEqual(['urban-planning', 'land', 'oracle', 'agents']);
        expect(required.resource.url).toBe('https://api.example.test/agent/oracle/facts');
        expect(required.extensions.bazaar.info.input).toMatchObject({
            type: 'http', method: 'GET', queryParams: { subject: PROPOSAL }
        });
        expect(required.extensions.bazaar.schema.properties.input.properties.queryParams.required)
            .toContain('subject');
    });

    it('settles before returning the verified recipe-bound bundle', async () => {
        const { app, fakeFacilitator } = appFor(pool);
        const query = { subject: PROPOSAL };
        const challenge = await request(app).get(AGENT_ORACLE_FACTS_PATH).query(query);
        const paid = await request(app)
            .get(AGENT_ORACLE_FACTS_PATH)
            .query(query)
            .set('PAYMENT-SIGNATURE', await paymentHeader(challenge));

        expect(paid.status).toBe(200);
        expect(paid.headers['payment-response']).toBeTruthy();
        expect(fakeFacilitator.settle).toHaveBeenCalledOnce();
        expect(paid.body).toMatchObject({
            fact: { outcome: 'cancelled', subject: { id: PROPOSAL } },
            recipe: { id: 'proposal-lifecycle-v1', subject: { proposalAccount: PROPOSAL } },
            verification: { status: 'verified', checks: { subjectMatches: true } }
        });
    });

    it('fails closed when the oracle price is not configured', async () => {
        const { app } = appFor(pool, facilitator(), {});
        const res = await request(app).get(AGENT_ORACLE_FACTS_PATH).query({ subject: PROPOSAL });
        expect(res.status).toBe(503);
        expect(res.body.missing).toContain('X402_PRICE_ORACLE_FACT');
        expect(pool.query).not.toHaveBeenCalled();
    });
});
