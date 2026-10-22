// Contract test for the paid oracle read (routes/agent-oracle-facts.js): an agreement account's terminal
// agreement_lifecycle fact (?subject=<agreement account>, or the latest one) is found and verified before
// the x402 gate, so missing facts are free; available facts advertise through Bazaar; and a real x402
// payment envelope reaches the agreement-execution-v1 bundle without a network.

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
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { AGREEMENT_PROGRAM_ID, agreementAccountOf } from '../agreements/onchain.js';
import { agreementAccountBytes } from './fixtures/agreement-account.js';
import { cidOf } from './helpers/content-fixtures.js';
import { AGENT_ORACLE_FACTS_PATH, setupAgentOracleFactsRoute } from '../routes/agent-oracle-facts.js';

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// The subject the Bazaar listing shows as its example query.
const EXAMPLE_SUBJECT = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const TX = '5igNaTuReOfTheSettledOracleFact';
const SPONSOR = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey.toBase58();
const CID = cidOf({ schema: 'agreement/v1', title: 'Cancelled deal' });
const AGREEMENT = agreementAccountOf(CID, SPONSOR);
// The cancelled agreement account the stored event hashed.
const ACCOUNT = agreementAccountBytes({ cid: CID, authority: SPONSOR, lens: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ', status: 2 });

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
        event_id: `solana:devnet:agreement_lifecycle:${AGREEMENT}:cancelled`,
        event_type: 'agreement_lifecycle',
        subject_type: 'agreement',
        subject_id: AGREEMENT,
        outcome: 'cancelled',
        source_url: `https://explorer.solana.com/address/${AGREEMENT}?cluster=devnet`,
        source_hash: `sha256:${createHash('sha256').update(ACCOUNT).digest('hex')}`,
        source_observed_at: '2026-09-21T16:24:07.000Z',
        attester: AGREEMENT_PROGRAM_ID,
        transaction_signature: 'tx-cancel',
        evidence: { agreementCid: CID, account: AGREEMENT, statusByte: 2, accountDataBase64: ACCOUNT.toString('base64') },
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
        const missing = await request(app).get(AGENT_ORACLE_FACTS_PATH).query({ subject: AGREEMENT });
        expect(missing.status).toBe(404);
        expect(missing.headers['payment-required']).toBeUndefined();

        // A stored fact that does not verify (its account bytes are not the hashed ones) is never sold.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        pool.query.mockResolvedValueOnce({ rows: [{ ...eventRow(), evidence: { ...eventRow().evidence, accountDataBase64: Buffer.from('forged').toString('base64') } }] });
        const unverified = await request(app).get(AGENT_ORACLE_FACTS_PATH).query({ subject: AGREEMENT });
        expect(unverified.status).toBe(503);
        expect(unverified.headers['payment-required']).toBeUndefined();
        expect(fakeFacilitator.settle).not.toHaveBeenCalled();
    });

    it('advertises the exact paid fact query through the x402 Bazaar extension', async () => {
        const { app } = appFor(pool);
        const res = await request(app).get(AGENT_ORACLE_FACTS_PATH);
        expect(res.status).toBe(402);
        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('($2::text IS NULL OR subject_id = $2)'), [
            'agreement_lifecycle', null
        ]);
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
            type: 'http', method: 'GET', queryParams: { subject: EXAMPLE_SUBJECT }
        });
        expect(required.extensions.bazaar.schema.properties.input.properties.queryParams.required)
            .toBeUndefined();
    });

    it('returns the latest verified fact when no subject is supplied', async () => {
        const { app } = appFor(pool);
        const challenge = await request(app).get(AGENT_ORACLE_FACTS_PATH);
        const paid = await request(app)
            .get(AGENT_ORACLE_FACTS_PATH)
            .set('PAYMENT-SIGNATURE', await paymentHeader(challenge));

        expect(paid.status).toBe(200);
        expect(paid.body).toMatchObject({
            fact: { subject: { type: 'agreement', id: AGREEMENT } },
            recipe: { id: 'agreement-execution-v1', subject: { agreementAccount: AGREEMENT, agreementCid: CID, marketAccount: null } },
            verification: { status: 'verified' }
        });
    });

    it('settles before returning the verified recipe-bound bundle', async () => {
        const { app, fakeFacilitator } = appFor(pool);
        const query = { subject: AGREEMENT, market: EXAMPLE_SUBJECT };
        const challenge = await request(app).get(AGENT_ORACLE_FACTS_PATH).query(query);
        const paid = await request(app)
            .get(AGENT_ORACLE_FACTS_PATH)
            .query(query)
            .set('PAYMENT-SIGNATURE', await paymentHeader(challenge));

        expect(paid.status).toBe(200);
        expect(paid.headers['payment-response']).toBeTruthy();
        expect(fakeFacilitator.settle).toHaveBeenCalledOnce();
        expect(paid.body).toMatchObject({
            fact: { outcome: 'cancelled', subject: { id: AGREEMENT } },
            recipe: { id: 'agreement-execution-v1', subject: { agreementAccount: AGREEMENT, marketAccount: EXAMPLE_SUBJECT } },
            verification: { status: 'verified', recipeId: 'agreement-execution-v1', lens: { decision: 'NO' }, checks: { subjectMatches: true } }
        });
        expect(pool.query.mock.calls.at(-1)[1]).toEqual(['agreement_lifecycle', AGREEMENT]);
    });

    it('fails closed when the oracle price is not configured', async () => {
        const { app } = appFor(pool, facilitator(), {});
        const res = await request(app).get(AGENT_ORACLE_FACTS_PATH).query({ subject: AGREEMENT });
        expect(res.status).toBe(503);
        expect(res.body.missing).toContain('X402_PRICE_ORACLE_FACT');
        expect(pool.query).not.toHaveBeenCalled();
    });
});
