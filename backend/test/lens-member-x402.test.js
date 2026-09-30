// Reference lens member over x402: a live-mode ownership request gets a PAYMENT-REQUIRED challenge
// at the configured price only after its free prechecks pass, and a settled payment issues the
// attestation with the receipt stored beside it.

import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PublicKey } from '@solana/web3.js';
import {
    AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction,
    createTransactionMessage, generateKeyPairSigner, getBase58Decoder, getBase64EncodedWireTransaction,
    partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash
} from '@solana/kit';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { createLensPricing, readLensPricingConfig } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const AUTHORITY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const NOW = 1790000000;
const clock = { nowSeconds: () => NOW };
const TX = '5igNaTuReOfTheSettledLensFee';

let payer, feePayer, treasury, sourceAta, env;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const owner = new PublicKey(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')).toBase58();
const signText = text => getBase58Decoder().decode(sign(null, Buffer.from(text, 'utf8'), privateKey));

beforeAll(async () => {
    [payer, feePayer, treasury, sourceAta] = await Promise.all([
        generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()
    ]);
    env = { X402_NETWORK: NETWORK, X402_FACILITATOR_URL: 'https://facilitator.test', X402_PAY_TO: treasury.address };
});

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

function setup(routeEnv = env) {
    const fake = facilitator();
    const issuer = createFakeIssuer({ authority: AUTHORITY, clock });
    const identity = createDevnetRegistryIdentity({
        rows: [{ parcelUid: 'HR-335550-1/1', owner, ownerCount: 1, establishedAt: '2026-06-01T00:00:00Z' }],
        clock, authority: AUTHORITY
    });
    const member = createLensMember({ authority: AUTHORITY, issuer, store: createMemoryStore(), identity, clock });
    const app = createLensMemberApp({ member, pricing: createLensPricing({ dryRun: false, env: routeEnv, facilitatorClient: fake }) });
    return { app, fake, issuer };
}

async function signedBody(app) {
    const res = await request(app).post('/lens/challenge').send({ parcelUid: 'HR-335550-1/1', owner });
    return { parcelUid: 'HR-335550-1/1', owner, challenge: res.body.challenge, signature: signText(res.body.message) };
}

async function signedTransfer(amount) {
    const data = new Uint8Array(10);
    data[0] = 12;
    new DataView(data.buffer).setBigUint64(1, amount, true);
    data[9] = 6;
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        value => setTransactionMessageFeePayer(feePayer.address, value),
        value => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n }, value),
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
    return getBase64EncodedWireTransaction(await partiallySignTransaction([payer.keyPair], compileTransaction(message)));
}

describe('lens member x402 pricing', () => {
    it('defaults the ownership price to 0.01 USDC and validates overrides', () => {
        expect(readLensPricingConfig(env)).toMatchObject({ enabled: true, price: '$0.01' });
        expect(readLensPricingConfig({ ...env, LENS_OWNERSHIP_PRICE_USDC: '0.25' }).price).toBe('$0.25');
        expect(() => readLensPricingConfig({ ...env, LENS_OWNERSHIP_PRICE_USDC: '0' })).toThrow(/positive/);
    });

    it('refuses a bad signature for free, before any payment challenge', async () => {
        const { app, fake } = setup();
        const body = await signedBody(app);
        const res = await request(app).post('/lens/ownership').send({ ...body, signature: signText('something else') });
        expect(res.status).toBe(401);
        expect(res.headers['payment-required']).toBeUndefined();
        expect(fake.settle).not.toHaveBeenCalled();
    });

    it('challenges at the configured price, then issues once the payment settles', async () => {
        const { app, fake, issuer } = setup({ ...env, LENS_OWNERSHIP_PRICE_USDC: '0.02' });
        const body = await signedBody(app);
        const challenge = await request(app).post('/lens/ownership').send(body);
        expect(challenge.status).toBe(402);
        const required = decodePaymentRequiredHeader(challenge.headers['payment-required']);
        expect(required.accepts[0]).toMatchObject({ network: NETWORK, payTo: treasury.address, amount: '20000' });
        expect(issuer.accounts.size).toBe(0);

        const header = encodePaymentSignatureHeader({
            x402Version: 2,
            resource: required.resource,
            accepted: required.accepts[0],
            payload: { transaction: await signedTransfer(20000n) },
            extensions: structuredClone(required.extensions)
        });
        const paid = await request(app).post('/lens/ownership').set('PAYMENT-SIGNATURE', header).send(body);
        expect(paid.status).toBe(201);
        expect(fake.settle).toHaveBeenCalledOnce();
        expect(paid.body).toMatchObject({
            kind: 'ownership',
            owner,
            payment: { transaction: TX, payer: payer.address, network: NETWORK },
            pricing: { mode: 'x402', enabled: true, price: '$0.02' }
        });
        expect(issuer.accounts.has(paid.body.address)).toBe(true);
    });
});
