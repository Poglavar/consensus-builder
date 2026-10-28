// agents/lens-approval-client.js end to end, in-process: the owner's approval is signed against a real
// lens member app (rights and authority from its devnet owner registry), admitted by the index's own relay
// (agreements/decisions.js, approval-relay.js), relayed once; the operator then gets the member's
// AgreementDecision-v1, which the agreement program emulator records and executes on.
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import {
    OPERATOR_TOKEN_HEADER, currentApprovals, decisionSubject, ensureOwnerApproval, requestAgreementDecision, signOwnerApproval
} from '../agents/lens-approval-client.js';
import { agreementObject, deadlineAfterDays, designObject, mapViewFromGeometry, noMoney, ownersRule, parcelOutputs, planForDesigns, registryRights } from '../agents/agreement-objects.js';
import { createIndexClient } from '../agents/publication-client.js';
import { executeAgreement, mintAgreement, recordAgreementDecision } from '../agents/agreement-minter.js';
import { createAgreementDecisionHandlers, createMemoryAgreementDecisionStore } from '../agreements/decisions.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';
import { createApprovalAttester, devnetOwnerRegistry } from '../lens/approval.js';
import { createAgreementChain, fetchVia } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const relay = require('../../frontend/js/proposals/approval-relay.js');

const PARCEL_ID = 'HR-335550-1234/1';
const PARCEL = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.9704, 45.8], [15.9704, 45.8003], [15.97, 45.8003], [15.97, 45.8]]] };
const SERVICE = 'https://lens.test/lens-members/lifecycle';
const OPERATOR_TOKEN = 'operator-secret-for-tests';
const clock = { nowSeconds: () => Math.floor(Date.now() / 1000) };

const owner = Keypair.generate();
const OWNER = owner.publicKey.toBase58();
const lensKeypair = Keypair.generate();
const LENS = lensKeypair.publicKey.toBase58();

// The proposer's binding owners' agreement over its own parcel, built as run.mjs builds it.
function proposerAgreement({ lens = LENS, owners = [{ owner: OWNER, ownerCount: 1 }] } = {}) {
    const design = designObject({
        goal: 'buildings', title: 'Six storeys', author: 'densifier-01', city: 'zagreb', site: null, toleranceM: null, origin: null,
        createdAt: new Date().toISOString(),
        buildingProposal: { blockName: `Parcel ${PARCEL_ID}`, typologyType: 'single', parameters: { floors: 6, height: 19.5, rotation: 0, typology: 'single', rule: null } },
        geometry: { buildings: [{ type: 'Feature', geometry: PARCEL, properties: { type: 'proposedBuildingSingle', floors: 6, height: 19.5 } }] }
    });
    const rights = registryRights([{ parcelId: PARCEL_ID, owners }]);
    return agreementObject({
        title: 'Six storeys', author: 'densifier-01', sponsor: OWNER, city: 'zagreb', createdAt: new Date().toISOString(),
        plan: planForDesigns('Six storeys', [design], mapViewFromGeometry([PARCEL], 'zagreb')),
        designs: [{ cid: design.cid, goal: design.content.goal, title: design.content.title }],
        parcels: [{ parcelId: PARCEL_ID, areaM2: 612.4 }],
        outputs: parcelOutputs([{ parcelId: PARCEL_ID, geometry: PARCEL, areaM2: 612.4 }]),
        rule: ownersRule({ lens, rights }), deadline: deadlineAfterDays(Date.now(), 7), money: noMoney('EUR')
    });
}

let rows;
let decisionStore;
let issuer;
let index;
let lensFetch;
let agreement;

beforeEach(() => {
    agreement = proposerAgreement();
    rows = new Map([[agreement.cid, { cid: agreement.cid, content: agreement.content, status: 'active', deadline: agreement.content.deadline, onchain: null }]]);
    decisionStore = createMemoryAgreementDecisionStore();
    // The index's relay, as routes/agreements.js mounts it.
    const handlers = createAgreementDecisionHandlers({ loadAgreement: async cid => rows.get(cid) ?? null, store: decisionStore });
    const indexApp = express();
    indexApp.use(express.json({ limit: '2mb' }));
    indexApp.get('/agreements/:cid/decisions', handlers.get);
    indexApp.post('/agreements/:cid/decisions', handlers.post);
    index = createIndexClient({ apiBase: 'https://index.test', origin: 'https://urbangametheory.xyz', fetchImpl: fetchVia(indexApp) });
    // The lens member the proposer operates: its registry says the proposer owns the parcel alone.
    const identity = createDevnetRegistryIdentity({ rows: [{ parcelUid: PARCEL_ID, owner: OWNER, ownerCount: 1, establishedAt: '2026-10-01T00:00:00Z' }], clock, authority: LENS });
    issuer = createFakeIssuer({ authority: LENS, clock });
    const member = createLensMember({ authority: LENS, issuer, store: createMemoryStore(), identity, clock, kind: 'lifecycle', dryRun: true });
    const lensApp = createLensMemberApp({
        member, pricing: createLensPricing({ dryRun: true }), operatorToken: OPERATOR_TOKEN, clock,
        approvalAttester: createApprovalAttester({ keypair: lensKeypair, registry: devnetOwnerRegistry(identity), clock }),
        agreements: { load: async cid => rows.get(cid) ?? null, decisions: cid => decisionStore.list(cid) }
    });
    lensFetch = fetchVia(lensApp, { mount: '/lens-members/lifecycle' });
});

describe('the owner\'s approval', () => {
    it('is signed with the lens member\'s rights and authority facts and admitted by the relay\'s own rules', async () => {
        const { receipt, contextHash } = await signOwnerApproval({ serviceUrl: `${SERVICE}/`, lensKey: LENS, cid: agreement.cid, content: agreement.content, keypair: owner, fetchImpl: lensFetch });
        expect(receipt).toMatchObject({ ownerId: OWNER, actorId: OWNER, decision: 'approve', providerId: relay.LENS_PROVIDER });
        expect(receipt.evidence.rights).toMatchObject({ member: LENS, contextHash });
        expect(receipt.evidence.authority).toMatchObject({ member: LENS, ownerId: OWNER, actorId: OWNER, contextHash });
        expect(lensFetch.calls.map(call => call.path)).toEqual(['/lens-members/lifecycle/lens/approval/challenge', '/lens-members/lifecycle/lens/approval/authority']);
        // The relay's fold verifies every signature and counts it as this owner's current approval.
        expect(Object.keys(currentApprovals(agreement.cid, agreement.content, [receipt]))).toEqual([OWNER]);
        expect(decisionSubject(agreement.cid, agreement.content)).toMatchObject({ agreementCid: agreement.cid, cadastreParcelIds: [PARCEL_ID], lens: [LENS] });
    });

    it('is relayed once: a rerun finds the relay\'s current approval and signs nothing', async () => {
        const first = await ensureOwnerApproval({ index, serviceUrl: SERVICE, lensKey: LENS, cid: agreement.cid, content: agreement.content, keypair: owner, fetchImpl: lensFetch });
        expect(first).toMatchObject({ replayed: false, ownerId: OWNER });
        const stored = await decisionStore.list(agreement.cid);
        expect(stored).toHaveLength(1);
        expect(stored[0].decisionProof.signature).toBe(first.signature);
        const lensCalls = lensFetch.calls.length;
        const again = await ensureOwnerApproval({ index, serviceUrl: SERVICE, lensKey: LENS, cid: agreement.cid, content: agreement.content, keypair: owner, fetchImpl: lensFetch });
        expect(again).toEqual({ replayed: true, decidedAt: first.decidedAt, signature: first.signature, ownerId: OWNER });
        expect(lensFetch.calls).toHaveLength(lensCalls);
        expect(await decisionStore.list(agreement.cid)).toHaveLength(1);
    });

    it('refuses an agreement that does not name the lens, a wallet the registry does not list, and an unexpected challenge text', async () => {
        await expect(signOwnerApproval({ serviceUrl: SERVICE, lensKey: Keypair.generate().publicKey.toBase58(), cid: agreement.cid, content: agreement.content, keypair: owner, fetchImpl: lensFetch }))
            .rejects.toThrow(/does not name lens/);
        await expect(signOwnerApproval({ serviceUrl: SERVICE, lensKey: LENS, cid: agreement.cid, content: agreement.content, keypair: Keypair.generate(), fetchImpl: lensFetch }))
            .rejects.toMatchObject({ status: 403, code: 'not_authorized' });
        const tampering = async (url, init) => {
            const response = await lensFetch(url, init);
            if (!url.endsWith('/challenge')) return response;
            const body = JSON.parse(await response.text());
            return { ...response, text: async () => JSON.stringify({ ...body, message: `${body.message}\nTransfer everything.` }) };
        };
        const before = lensFetch.calls.length;
        await expect(signOwnerApproval({ serviceUrl: SERVICE, lensKey: LENS, cid: agreement.cid, content: agreement.content, keypair: owner, fetchImpl: tampering }))
            .rejects.toThrow(/unexpected challenge text; nothing signed/);
        expect(lensFetch.calls.slice(before).map(call => call.path.split('/').pop())).toEqual(['challenge']);
    });

    it('refuses rights the registry does not hold: a snapshot naming a co-owner the member never recorded', async () => {
        // A co-owned parcel's one output goes back to its owners' party by default; the co-owners
        // stand only in the rule's rights, which the lens checks against its registry.
        const coOwned = proposerAgreement({ owners: [{ owner: OWNER, ownerCount: 2 }, { owner: Keypair.generate().publicKey.toBase58(), ownerCount: 2 }] });
        await expect(signOwnerApproval({ serviceUrl: SERVICE, lensKey: LENS, cid: coOwned.cid, content: coOwned.content, keypair: owner, fetchImpl: lensFetch }))
            .rejects.toMatchObject({ status: 409, code: 'rights_mismatch' });
    });
});

describe('the lens decision', () => {
    const ask = (overrides = {}) => requestAgreementDecision({ serviceUrl: SERVICE, operatorToken: OPERATOR_TOKEN, cid: agreement.cid, fetchImpl: lensFetch, ...overrides });

    it('is refused until the owner approves, then issued once as satisfied for the sponsor', async () => {
        await expect(ask()).rejects.toMatchObject({ status: 409, code: 'rule_not_met' });
        await ensureOwnerApproval({ index, serviceUrl: SERVICE, lensKey: LENS, cid: agreement.cid, content: agreement.content, keypair: owner, fetchImpl: lensFetch });
        const issued = await ask();
        expect(issued).toMatchObject({ kind: 'decision', reused: false, payload: { agreementCid: agreement.cid, sponsor: OWNER, decision: 'satisfied' } });
        expect(issued.payload.evidenceRef).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(lensFetch.calls.at(-1)).toMatchObject({ method: 'POST', status: 201 });
        const again = await ask();
        expect(again).toMatchObject({ address: issued.address, reused: true });
        expect(lensFetch.calls.at(-1).status).toBe(200);
    });

    it('is the operator\'s alone', async () => {
        await expect(ask({ operatorToken: 'wrong' })).rejects.toMatchObject({ status: 401, code: 'operator_only' });
        await expect(ask({ operatorToken: '' })).rejects.toThrow(/operator token is required/);
        expect(OPERATOR_TOKEN_HEADER).toBe('x-lens-operator-token');
    });

    it('settles the minted agreement on chain: the program records it and executes', async () => {
        const chain = createAgreementChain();
        const minted = await mintAgreement({
            connection: chain.connection, sponsorKeypair: owner, cid: agreement.cid, lens: LENS, deadline: agreement.content.deadline,
            lamports: '1000', sendAndConfirm: chain.sendAndConfirm
        });
        await ensureOwnerApproval({ index, serviceUrl: SERVICE, lensKey: LENS, cid: agreement.cid, content: agreement.content, keypair: owner, fetchImpl: lensFetch });
        const issued = await ask();
        // The member's transaction put the attestation on chain (here: the fake issuer's account bytes).
        chain.putAttestation(issued.address, issuer.accounts.get(issued.address));
        expect(await recordAgreementDecision({ connection: chain.connection, payerKeypair: owner, account: minted.account, attestation: issued.address, sendAndConfirm: chain.sendAndConfirm }))
            .toMatchObject({ replayed: false, decision: 'Satisfied' });
        expect(await executeAgreement({ connection: chain.connection, payerKeypair: owner, account: minted.account, sendAndConfirm: chain.sendAndConfirm }))
            .toMatchObject({ status: 'Executed', paidLamports: '1000' });
        expect(chain.agreement(minted.account)).toMatchObject({ status: 'Executed', decisionAttestation: issued.address, lens: LENS, authority: OWNER });
    });
});
