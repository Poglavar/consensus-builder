// Agent side of the owner-consent flow: the challenge signature verifies exactly as the lens member
// verifies it, the full challenge → sign → POST /lens/ownership round trip works against a dry-run
// reference member over real HTTP, and a priced member is paid only through a live, confirmed call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import {
    fetchLensStatus, findOwnershipAttestation, paymentIdForOwnership, requestOwnershipAttestation, requestVerdictAttestation,
    signChallengeMessage
} from '../agents/lens-ownership-client.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { verifyWalletSignature } from '../lens/identity/devnet-registry.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';

const NOW = 1790000000;
const clock = { nowSeconds: () => NOW };
const AUTHORITY = Keypair.generate().publicKey.toBase58();
const agent = Keypair.generate();
const PARCEL = 'HR-335550-1813/6';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let server;
let serviceUrl;
let keyFile;

beforeAll(async () => {
    const identity = createDevnetRegistryIdentity({
        rows: [{ parcelUid: PARCEL, owner: agent.publicKey.toBase58(), ownerCount: 1, establishedAt: '2026-06-01T00:00:00Z' }],
        clock, authority: AUTHORITY
    });
    const member = createLensMember({
        authority: AUTHORITY, issuer: createFakeIssuer({ authority: AUTHORITY, clock }), store: createMemoryStore(),
        identity, clock, dryRun: true
    });
    const app = createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }) });
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    serviceUrl = `http://127.0.0.1:${server.address().port}`;
    keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ugt-lens-')), 'agent.json');
    fs.writeFileSync(keyFile, JSON.stringify(Array.from(agent.secretKey)));
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(path.dirname(keyFile), { recursive: true, force: true });
});

describe('challenge signing', () => {
    it('produces an ed25519 signature node:crypto verifies against the wallet key, like the member does', () => {
        const message = 'Urban Game Theory lens member X\nWallet Y asks to be attested as an owner of parcel Z.';
        const { owner, signature } = signChallengeMessage({ secretKey: agent.secretKey, message });
        expect(owner).toBe(agent.publicKey.toBase58());
        const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(owner).toBuffer()]), format: 'der', type: 'spki' });
        expect(verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'))).toBe(true);
        expect(verifyWalletSignature({ owner, message, signature })).toBe(true);
        expect(verifyWalletSignature({ owner, message: `${message}!`, signature })).toBe(false);
        expect(verifyWalletSignature({ owner: Keypair.generate().publicKey.toBase58(), message, signature })).toBe(false);
    });
});

describe('requestOwnershipAttestation against a dry-run reference member', () => {
    it('gets an attestation address and account hash, and a retry returns the same one', async () => {
        const first = await requestOwnershipAttestation({ serviceUrl, parcelUid: PARCEL, secretKey: agent.secretKey });
        expect(first).toMatchObject({ owner: agent.publicKey.toBase58(), parcelUid: PARCEL, paid: false, reused: false });
        expect(first.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
        expect(first.accountHash).toMatch(/^[0-9a-f]{64}$/);
        expect(first.payload).toMatchObject({ parcelUid: PARCEL, owner: agent.publicKey.toBase58(), ownerCount: 1 });
        const again = await requestOwnershipAttestation({ serviceUrl: `${serviceUrl}/`, parcelUid: PARCEL, secretKey: agent.secretKey });
        expect(again).toMatchObject({ address: first.address, accountHash: first.accountHash, reused: true });
    });

    it('passes the member refusal through for an unrecorded wallet', async () => {
        await expect(requestOwnershipAttestation({ serviceUrl, parcelUid: PARCEL, secretKey: Keypair.generate().secretKey }))
            .rejects.toThrow(/HTTP 403: .*not a recorded owner/);
    });
});

// A member that answers the first ownership POST with an x402 challenge.
function pricedMemberFetch(amount = '10000') {
    const challenge = { x402Version: 2, resource: { url: 'http://member/lens/ownership' }, accepts: [{ scheme: 'exact', network: 'solana:devnet', amount, asset: 'USDC', payTo: AUTHORITY, maxTimeoutSeconds: 60, extra: {} }] };
    return vi.fn(async (url, init) => {
        if (url.endsWith('/lens/challenge')) {
            return new Response(JSON.stringify({ challenge: 'nonce', message: 'sign me', expiresAt: '2026-10-01T00:00:00Z' }), { status: 201 });
        }
        return new Response(JSON.stringify({ error: 'Payment required' }), { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(challenge) } });
    });
}

describe('ugt tools: attesters, ownership and mint', () => {
    it('lists attesters from the directory, optionally by kind', async () => {
        const members = [{ key: AUTHORITY, kind: 'owner-consent' }, { key: agent.publicKey.toBase58(), kind: 'court' }];
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ members }), { status: 200 }));
        const tools = createUrbanGameTheoryTools({ env: { UGT_API_BASE: 'https://api.example.test' }, fetchImpl });
        expect(await tools.listAttesters({ kind: 'court' })).toEqual({ members: [members[1]] });
        expect(fetchImpl).toHaveBeenCalledWith('https://api.example.test/agent/lenses/members', expect.anything());
    });

    it('requests ownership without the live gate when the member is free', async () => {
        const tools = createUrbanGameTheoryTools({ env: { UGT_AGENT_KEYPAIR: keyFile }, fetchImpl: globalThis.fetch });
        const result = await tools.requestOwnership({ serviceUrl, parcelUid: PARCEL });
        expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
        expect(result.paid).toBe(false);
    });

    it('pays a priced member only with UGT_MCP_LIVE=1, confirm=true and a price under the cap', async () => {
        const createPaidClient = vi.fn(async () => ({
            payerAddress: agent.publicKey.toBase58(),
            paidFetch: async () => new Response(JSON.stringify({ address: AUTHORITY, accountHash: 'a'.repeat(64), payload: {} }), { status: 201 })
        }));
        const notLive = createUrbanGameTheoryTools({ env: { UGT_AGENT_KEYPAIR: keyFile }, fetchImpl: pricedMemberFetch(), dependencies: { createPaidClient } });
        await expect(notLive.requestOwnership({ serviceUrl: 'http://member', parcelUid: PARCEL, confirm: true })).rejects.toThrow(/UGT_MCP_LIVE=1/);
        const live = { UGT_AGENT_KEYPAIR: keyFile, UGT_MCP_LIVE: '1' };
        const unconfirmed = createUrbanGameTheoryTools({ env: live, fetchImpl: pricedMemberFetch(), dependencies: { createPaidClient } });
        await expect(unconfirmed.requestOwnership({ serviceUrl: 'http://member', parcelUid: PARCEL })).rejects.toThrow(/confirm must be true/);
        const tooDear = createUrbanGameTheoryTools({ env: { ...live, UGT_MCP_MAX_USDC_PER_ACTION: '0.005' }, fetchImpl: pricedMemberFetch('10000'), dependencies: { createPaidClient } });
        await expect(tooDear.requestOwnership({ serviceUrl: 'http://member', parcelUid: PARCEL, confirm: true })).rejects.toThrow(/exceeds UGT_MCP_MAX_USDC_PER_ACTION/);
        expect(createPaidClient).not.toHaveBeenCalled();

        const ok = createUrbanGameTheoryTools({ env: live, fetchImpl: pricedMemberFetch(), dependencies: { createPaidClient } });
        const result = await ok.requestOwnership({ serviceUrl: 'http://member', parcelUid: PARCEL, confirm: true });
        expect(result).toMatchObject({ address: AUTHORITY, paid: true });
        expect(createPaidClient).toHaveBeenCalledWith(expect.objectContaining({
            paymentId: paymentIdForOwnership({ serviceUrl: 'http://member', parcelUid: PARCEL, owner: agent.publicKey.toBase58() })
        }));
    });

    it('mints with the chosen lens behind the live gate and refuses a self-only lens', async () => {
        const mintProposal = vi.fn(async args => ({ signature: 'mint-tx', proposalPda: 'pda', lens: args.lens }));
        const env = { UGT_AGENT_KEYPAIR: keyFile, UGT_MCP_LIVE: '1' };
        const tools = createUrbanGameTheoryTools({ env, fetchImpl: vi.fn(), createConnection: () => ({}), dependencies: { mintProposal, sendAndConfirmPolling: vi.fn() } });
        await expect(createUrbanGameTheoryTools({ env: { UGT_AGENT_KEYPAIR: keyFile }, fetchImpl: vi.fn(), dependencies: { mintProposal } })
            .mintProposal({ parcelIds: [PARCEL], lens: [AUTHORITY], confirm: true })).rejects.toThrow(/UGT_MCP_LIVE/);
        await expect(tools.mintProposal({ parcelIds: [PARCEL], lens: [agent.publicKey.toBase58()], confirm: true })).rejects.toThrow(/self-lens/);
        await expect(tools.mintProposal({ parcelIds: [PARCEL], lens: [], confirm: true })).rejects.toThrow(/at least one lens member/);
        expect(mintProposal).not.toHaveBeenCalled();
        const result = await tools.mintProposal({ parcelIds: [PARCEL], lens: [AUTHORITY], imageUri: 'https://x/img', isConditional: false, confirm: true });
        expect(result.lens).toEqual([AUTHORITY]);
        expect(mintProposal).toHaveBeenCalledWith(expect.objectContaining({
            parcelIds: [PARCEL], lens: [AUTHORITY], imageUri: 'https://x/img', isConditional: false, lamports: 0n
        }));
    });
});

describe('member lookups and operator verdicts against a dry-run reference member', () => {
    let operatorServer;
    let url;
    const OPERATOR = 'operator-secret';
    const proposal = Keypair.generate().publicKey.toBase58();

    beforeAll(async () => {
        const identity = createDevnetRegistryIdentity({
            rows: [{ parcelUid: PARCEL, owner: agent.publicKey.toBase58(), ownerCount: 1, establishedAt: '2026-06-01T00:00:00Z' }],
            clock, authority: AUTHORITY
        });
        const member = createLensMember({
            authority: AUTHORITY, issuer: createFakeIssuer({ authority: AUTHORITY, clock }), store: createMemoryStore(),
            identity, clock, dryRun: true
        });
        const app = createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }), operatorToken: OPERATOR });
        await new Promise(resolve => { operatorServer = app.listen(0, '127.0.0.1', resolve); });
        url = `http://127.0.0.1:${operatorServer.address().port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => operatorServer.close(resolve));
    });

    it('reads the member key and credential name from GET /lens/status', async () => {
        expect(await fetchLensStatus({ serviceUrl: url })).toMatchObject({ key: AUTHORITY, credentialName: 'LensMember' });
    });

    it('finds the issued ownership attestation for (parcel, owner, member) and says to request one when none exists', async () => {
        await expect(findOwnershipAttestation({ serviceUrl: url, parcelUid: PARCEL, owner: agent.publicKey.toBase58(), member: AUTHORITY }))
            .rejects.toThrow(/request one first/);
        const issued = await requestOwnershipAttestation({ serviceUrl: url, parcelUid: PARCEL, secretKey: agent.secretKey });
        const found = await findOwnershipAttestation({ serviceUrl: url, parcelUid: PARCEL, owner: agent.publicKey.toBase58(), member: AUTHORITY });
        expect(found).toMatchObject({ address: issued.address, authority: AUTHORITY, kind: 'ownership' });
        await expect(findOwnershipAttestation({ serviceUrl: url, parcelUid: PARCEL, owner: agent.publicKey.toBase58(), member: Keypair.generate().publicKey.toBase58() }))
            .rejects.toThrow(/no ownership attestation/);
    });

    it('asks for an expired verdict with the operator token; a retry at the same source time returns the same attestation', async () => {
        await expect(requestVerdictAttestation({ serviceUrl: url, operatorToken: 'wrong', proposalAccount: proposal, verdict: 'expired', sourceObservedAt: NOW - 10 }))
            .rejects.toThrow(/HTTP 401/);
        const first = await requestVerdictAttestation({ serviceUrl: url, operatorToken: OPERATOR, proposalAccount: proposal, verdict: 'expired', evidenceRef: 'agent-retire', sourceObservedAt: NOW - 10 });
        expect(first).toMatchObject({ kind: 'verdict', authority: AUTHORITY, proposalAccount: proposal, reused: false });
        const again = await requestVerdictAttestation({ serviceUrl: url, operatorToken: OPERATOR, proposalAccount: proposal, verdict: 'expired', evidenceRef: 'agent-retire', sourceObservedAt: NOW - 10 });
        expect(again).toMatchObject({ address: first.address, reused: true });
        await expect(requestVerdictAttestation({ serviceUrl: url, operatorToken: OPERATOR, proposalAccount: proposal, verdict: 'expired', sourceObservedAt: 0 }))
            .rejects.toThrow(/positive Unix timestamp/);
    });
});
